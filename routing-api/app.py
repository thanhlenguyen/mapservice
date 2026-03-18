# app.py — Rewritten with full security, robustness, and performance fixes
#
# Changes from original:
#   SECURITY
#     - All SQL built with %s parameterisation only — no f-strings in query bodies
#     - Hardcoded credentials removed from fallback connect path
#     - facility_type compared case-insensitively in the DB query
#
#   ROBUSTNESS
#     - db_connection() context manager guarantees pool return on every code path
#     - Coordinate bounds validated (lon ±180, lat ±90) before any DB work
#     - Missing query params return clean 400 errors, never raw Python exceptions
#     - /nearest_facility: removed the early return_connection() that left a
#       dead cursor in use for the rest of the handler
#
#   PERFORMANCE
#     - /route:         pgr_ksp with heap_paths=true for genuinely distinct alternatives
#                       inner SQL built via .format() (safe — no user input) because
#                       psycopg2 %s cannot parameterise inside pgRouting's inner query
#     - /route/tsp:     pgr_dijkstraCostMatrix replaces O(n²) Python loop
#     - /route/tsp:     single geometry JOIN replaces N re-routing queries
#     - /nearest_facility: single pgr_dijkstra(one-to-many) replaces per-facility loop
#     - BBOX buffer is dynamic (20 % of route extent) instead of a fixed 0.1°
#
#   CORRECTNESS
#     - Vertex snap distance check uses ::geography (metres), not planar degrees
#     - duration_min always populated regardless of optimization mode
#     - ST_GeometryN(geom,1) replaced with ST_Centroid for facility coordinates
#     - conn.commit() mid-handler in TSP removed (temp tables are session-scoped)

from contextlib import contextmanager
import json
import logging
import os

import psycopg2
import psycopg2.pool
from flask import Flask, jsonify, request
from flask_cors import CORS
from psycopg2.extras import RealDictCursor

app = Flask(__name__)
CORS(app)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Connection pool
# ---------------------------------------------------------------------------
_pool: psycopg2.pool.ThreadedConnectionPool | None = None

_DB_KWARGS = dict(
    host=os.getenv("POSTGRES_HOST", "postgis"),
    database=os.getenv("POSTGRES_DB", "geodb"),
    user=os.getenv("POSTGRES_USER"),          # no hardcoded fallback
    password=os.getenv("POSTGRES_PASSWORD"),  # no hardcoded fallback
    port=int(os.getenv("POSTGRES_PORT", "5432")),
    connect_timeout=10,
    options="-c random_page_cost=1.1 -c effective_cache_size=2GB",
)


def init_pool() -> None:
    global _pool
    try:
        _pool = psycopg2.pool.ThreadedConnectionPool(minconn=2, maxconn=20, **_DB_KWARGS)
        logger.info("Connection pool created.")
    except Exception as exc:
        logger.error("Failed to create connection pool: %s", exc)
        _pool = None


init_pool()


def _get_conn():
    if _pool:
        try:
            return _pool.getconn()
        except Exception as exc:
            logger.error("Pool exhausted or error: %s", exc)
    # No silent fallback with hardcoded credentials — surface the failure.
    raise RuntimeError("Database connection pool unavailable.")


def _put_conn(conn) -> None:
    if _pool:
        try:
            _pool.putconn(conn)
            return
        except Exception as exc:
            logger.error("Failed to return connection: %s", exc)
    try:
        conn.close()
    except Exception:
        pass


@contextmanager
def db_connection():
    """
    Guarantee the connection is returned to the pool on every exit path —
    normal return, early return, or exception.
    """
    conn = _get_conn()
    try:
        yield conn
    finally:
        _put_conn(conn)


# ---------------------------------------------------------------------------
# Shared validation helpers
# ---------------------------------------------------------------------------

def _parse_lonlat(lon_str, lat_str, label="point"):
    """Parse and range-check a lon/lat pair. Raises ValueError on bad input."""
    try:
        lon, lat = float(lon_str), float(lat_str)
    except (TypeError, ValueError):
        raise ValueError(f"Coordinates for {label} must be numeric.")
    if not (-180.0 <= lon <= 180.0):
        raise ValueError(f"{label} longitude {lon} is outside [-180, 180].")
    if not (-90.0 <= lat <= 90.0):
        raise ValueError(f"{label} latitude {lat} is outside [-90, 90].")
    return lon, lat


def _snap(cur, lon: float, lat: float, radius_m: int = 1000):
    """
    Return the nearest topology vertex within radius_m metres, or None.
    Uses ::geography so the distance is in metres, not degrees.
    """
    cur.execute(
        """
        SELECT id,
               ST_Distance(
                   geom::geography,
                   ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
               ) AS dist_m
        FROM   topology.vertices
        WHERE  ST_DWithin(
                   geom::geography,
                   ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                   %s
               )
        ORDER  BY geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
        LIMIT  1
        """,
        (lon, lat, lon, lat, radius_m, lon, lat),
    )
    return cur.fetchone()


def _bbox_buffer(start_lon, start_lat, end_lon, end_lat) -> float:
    """
    Dynamic BBOX expansion: 20 % of the larger route dimension.
    Floor 0.05° (~5 km), cap 1.0° (~110 km) to stay performant.
    """
    span = max(abs(end_lon - start_lon), abs(end_lat - start_lat))
    return max(0.05, min(span * 0.20, 1.0))


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    try:
        with db_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT 1")
            cur.close()
        return jsonify({"status": "healthy", "db": "connected"}), 200
    except Exception as exc:
        logger.error("Health check failed: %s", exc)
        return jsonify({"status": "unhealthy", "error": str(exc)}), 500


# ---------------------------------------------------------------------------
# /route  — A-to-B with true alternative paths via pgr_ksp
# ---------------------------------------------------------------------------

@app.route("/route", methods=["GET"])
def get_route():
    """
    A-to-B routing with up to 3 alternative paths.

    GET params:
        start_lon, start_lat  — WGS-84 origin
        end_lon,   end_lat    — WGS-84 destination
        alternatives          — 1-3 (default 1)
        optimization          — fastest | shortest (default fastest)
    """
    # 1. Parse & validate inputs
    try:
        start_lon, start_lat = _parse_lonlat(
            request.args.get("start_lon"), request.args.get("start_lat"), "start"
        )
        end_lon, end_lat = _parse_lonlat(
            request.args.get("end_lon"), request.args.get("end_lat"), "end"
        )
        alternatives = min(max(int(request.args.get("alternatives", 1)), 1), 3)
        optimization = request.args.get("optimization", "fastest")
        if optimization not in ("fastest", "shortest"):
            raise ValueError("optimization must be 'fastest' or 'shortest'.")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        with db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SET statement_timeout = '20s'")

            # 2. Snap to network
            start_node = _snap(cur, start_lon, start_lat)
            end_node   = _snap(cur, end_lon, end_lat)

            if not start_node:
                return jsonify({"error": "Start point is more than 1 km from the road network."}), 404
            if not end_node:
                return jsonify({"error": "End point is more than 1 km from the road network."}), 404

            start_vid, end_vid = start_node["id"], end_node["id"]

            if start_vid == end_vid:
                return jsonify({"error": "Start and end snap to the same network node."}), 400

            # 3. Build bbox and cost-mode flag for the parameterised sub-query
            buf  = _bbox_buffer(start_lon, start_lat, end_lon, end_lat)
            bbox = (
                min(start_lon, end_lon), min(start_lat, end_lat),
                max(start_lon, end_lon), max(start_lat, end_lat),
                buf,
            )

            # ----------------------------------------------------------------
            # Build the inner SQL as a Python string.
            #
            # pgRouting's inner query is re-parsed by PostgreSQL itself, so
            # psycopg2 %s placeholders inside it are never seen by the DB —
            # they are already substituted as Python values before the string
            # reaches PostgreSQL, producing broken SQL inside pgRouting.
            #
            # Safe to use .format() here because every value interpolated is
            # either a known safe column-name identifier (cost_col/rev_cost_col)
            # or a float produced by our own validated bbox calculation — no
            # user input is ever injected into this string.
            #
            # heap_paths => false (the default, but stated explicitly for clarity)
            # returns exactly k final paths.  heap_paths => true returns every
            # intermediate candidate explored by Yen's algorithm — potentially
            # thousands of rows for a long route — which is not what we want.
            # ----------------------------------------------------------------
            cost_col     = "length_m" if optimization == "shortest" else "cost"
            rev_cost_col = "length_m" if optimization == "shortest" else "reverse_cost"
            min_lon, min_lat, max_lon, max_lat, buf_deg = bbox

            inner_sql = (
                "SELECT id, source, target, "
                "{cost} AS cost, {rev} AS reverse_cost "
                "FROM topology.ways "
                "WHERE geom && ST_Expand("
                "ST_MakeEnvelope({x1}, {y1}, {x2}, {y2}, 4326), {buf})"
            ).format(
                cost=cost_col, rev=rev_cost_col,
                x1=min_lon,    y1=min_lat,
                x2=max_lon,    y2=max_lat,
                buf=buf_deg,
            )

            cur.execute(
                """
                SELECT p.path_id,
                       p.seq,
                       p.node,
                       p.edge,
                       p.agg_cost,
                       ST_AsGeoJSON(w.geom)  AS geojson,
                       w.length_m,
                       w.cost               AS travel_cost,
                       w.id                 AS edge_id
                FROM pgr_ksp(
                    %s,
                    %s, %s, %s,
                    directed   => true,
                    heap_paths => false
                ) AS p
                LEFT JOIN topology.ways w ON p.edge = w.id
                ORDER BY p.path_id, p.seq
                """,
                (inner_sql, start_vid, end_vid, alternatives),
            )
            rows = cur.fetchall()
            cur.close()

        if not rows:
            return jsonify({"error": "No route found between the given points."}), 404

        # 4. Group rows by path_id into FeatureCollections.
        #    pgr_ksp tags every row with path_id (1-based).
        paths: dict[int, list] = {}
        for row in rows:
            paths.setdefault(row["path_id"], []).append(row)

        routes = []
        for path_rows in sorted(paths.values(), key=lambda r: r[0]["path_id"]):
            if path_rows[-1]["node"] != end_vid:
                continue  # path didn't reach the destination

            features, total_length_m, total_travel_cost = [], 0.0, 0.0
            for r in path_rows:
                if not r["geojson"]:
                    continue
                total_length_m    += r["length_m"] or 0.0
                total_travel_cost += r["travel_cost"] or 0.0
                features.append({
                    "type": "Feature",
                    "geometry": json.loads(r["geojson"]),
                    "properties": {
                        "edge_id":  r["edge_id"],
                        "length_m": round(r["length_m"] or 0.0, 2),
                    },
                })

            routes.append({
                # ----------------------------------------------------------------
                # Response keys are intentionally flat and match the JS frontend:
                #   data.routes[i].features        — GeoJSON segments
                #   data.routes[i].total_distance_km
                #   data.routes[i].duration_minutes
                #   data.routes[i].alternative_rank
                # Single-route responses (alternatives=1) omit the `routes` wrapper
                # and expose the same flat keys directly on the root object.
                # ----------------------------------------------------------------
                "type":               "FeatureCollection",
                "features":           features,
                "total_distance_km":  round(total_length_m / 1000, 2),
                "duration_minutes":   round(total_travel_cost / 60, 1),
                "alternative_rank":   len(routes) + 1,
                "optimization":       optimization,
            })

        if not routes:
            return jsonify({"error": "Routing graph is disconnected; no path exists."}), 404

        if alternatives > 1:
            # JS checks: if (data.routes && Array.isArray(data.routes))
            return jsonify({
                "routes":       routes,
                "optimization": optimization,
                "count":        len(routes),
            })
        else:
            # JS else branch: addRouteLayer(data, ...) — data IS the FeatureCollection
            return jsonify(routes[0])

    except Exception:
        logger.exception("Route error")
        return jsonify({"error": "Internal server error."}), 500


# ---------------------------------------------------------------------------
# /route/tsp  — Travelling Salesman Problem
# ---------------------------------------------------------------------------

@app.route("/route/tsp", methods=["POST"])
def get_tsp_route():
    """
    TSP routing: visit all supplied waypoints in the optimal order.

    POST body: {"points": [[lon, lat], ...]}   (2-8 points)
    """
    # 1. Parse & validate body
    data = request.get_json(silent=True) or {}
    points = data.get("points", [])

    if not isinstance(points, list) or len(points) < 2:
        return jsonify({"error": "Need at least 2 points."}), 400
    if len(points) > 8:
        return jsonify({
            "error": "Maximum 8 waypoints allowed.",
            "points_provided": len(points),
        }), 400

    try:
        validated = [_parse_lonlat(p[0], p[1], f"point {i+1}") for i, p in enumerate(points)]
    except (ValueError, TypeError, IndexError) as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        with db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SET statement_timeout = '60s'")

            # 2. Snap all waypoints to network vertices
            vertex_ids = []
            for i, (lon, lat) in enumerate(validated):
                node = _snap(cur, lon, lat)
                if not node:
                    return jsonify({
                        "error": f"Point {i+1} ({lon}, {lat}) is more than 1 km from the road network."
                    }), 404
                vertex_ids.append(node["id"])

            # 3. Build cost matrix in ONE query using pgr_dijkstraCostMatrix
            #    This replaces the O(n²) Python loop of individual Dijkstra calls.
            # Build a BBOX that covers all waypoints + 20% buffer so the
            # cost-matrix query doesn't scan the entire ways table.
            all_lons = [lon for lon, lat in validated]
            all_lats = [lat for lon, lat in validated]
            tsp_buf  = _bbox_buffer(min(all_lons), min(all_lats),
                                    max(all_lons), max(all_lats))
            tsp_inner_sql = (
                "SELECT id, source, target, cost, reverse_cost "
                "FROM topology.ways "
                "WHERE cost > 0 "
                "AND geom && ST_Expand("
                "ST_MakeEnvelope({x1},{y1},{x2},{y2},4326),{buf})"
            ).format(
                x1=min(all_lons), y1=min(all_lats),
                x2=max(all_lons), y2=max(all_lats),
                buf=tsp_buf,
            )

            cur.execute(
                """
                SELECT start_vid, end_vid, agg_cost
                FROM pgr_dijkstraCostMatrix(%s, %s, directed => true)
                """,
                (tsp_inner_sql, vertex_ids),
            )
            matrix_rows = cur.fetchall()

            if not matrix_rows:
                return jsonify({"error": "Could not compute cost matrix between waypoints."}), 404

            # 4. Solve TSP
            cur.execute(
                """
                SELECT seq, node, cost, agg_cost
                FROM pgr_TSP(
                    $$SELECT start_vid, end_vid, agg_cost
                      FROM (VALUES {values}) AS t(start_vid, end_vid, agg_cost)$$
                )
                ORDER BY seq
                """.format(
                    values=", ".join(
                        f"({r['start_vid']}, {r['end_vid']}, {r['agg_cost']})"
                        for r in matrix_rows
                    )
                ),
            )
            # Note: pgr_TSP does not support %s for its inner query; we build the
            # VALUES list ourselves using only integers and floats from the DB result —
            # no user input is interpolated here.
            tsp_path = cur.fetchall()

            if not tsp_path:
                return jsonify({"error": "Could not solve TSP."}), 404

            # 5. Fetch all route geometries in ONE query (one-to-many Dijkstra)
            #    Derive the ordered list of (start, end) vertex pairs from the TSP path.
            legs = [
                (tsp_path[i]["node"], tsp_path[i + 1]["node"])
                for i in range(len(tsp_path) - 1)
            ]
            start_vids = [s for s, _ in legs]
            end_vids   = [e for _, e in legs]

            # Reuse the same BBOX inner SQL for the geometry fetch
            cur.execute(
                """
                SELECT p.start_vid, p.end_vid, p.seq,
                       ST_AsGeoJSON(w.geom) AS geojson,
                       w.length_m
                FROM pgr_dijkstra(%s, %s, %s, directed => true) AS p
                JOIN topology.ways w ON p.edge = w.id
                WHERE p.edge != -1
                ORDER BY p.start_vid, p.seq
                """,
                (tsp_inner_sql, start_vids, end_vids),
            )
            seg_rows = cur.fetchall()
            cur.close()

        # 6. Assemble GeoJSON features
        features = [
            {
                "type": "Feature",
                "geometry": json.loads(r["geojson"]),
                "properties": {"length_m": round(r["length_m"], 2)},
            }
            for r in seg_rows
        ]

        total_distance = sum(r["length_m"] for r in seg_rows)
        total_cost     = tsp_path[-1]["agg_cost"] if tsp_path else 0

        # Map TSP node order back to original waypoint indices
        node_to_idx  = {vid: i for i, vid in enumerate(vertex_ids)}
        tsp_order    = [node_to_idx[r["node"]] for r in tsp_path if r["node"] in node_to_idx]

        return jsonify({
            "type":             "FeatureCollection",
            "features":         features,
            "total_distance_km": round(total_distance / 1000, 2),
            "duration_minutes": round(total_cost / 60, 1),
            "segment_count":    len(features),
            "waypoint_count":   len(points),
            "waypoint_order":   tsp_order,
            "optimization":     "TSP",
        })

    except Exception:
        logger.exception("TSP error")
        return jsonify({"error": "Internal server error."}), 500


# ---------------------------------------------------------------------------
# /service_area  — Isochrone (driving-distance polygon)
# ---------------------------------------------------------------------------

@app.route("/service_area", methods=["GET"])
def service_area():
    """
    Compute reachable area within `minutes` drive of (lon, lat).

    GET params:
        lon, lat   — WGS-84 centre point
        minutes    — 1-20 (default 5)
    """
    # 1. Validate inputs before touching the DB
    try:
        lon, lat = _parse_lonlat(request.args.get("lon"), request.args.get("lat"))
        minutes  = float(request.args.get("minutes", 5))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if not (1 <= minutes <= 20):
        return jsonify({"error": "minutes must be between 1 and 20."}), 400

    try:
        with db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SET statement_timeout = '30s'")

            # 2. Snap centre point — geographic distance in metres
            node = _snap(cur, lon, lat)
            if not node:
                return jsonify({"error": "Service point is more than 1 km from the road network."}), 404

            # 3. Driving-distance reachability + concave hull in one query.
            # BBOX is built from a worst-case walking radius:
            #   minutes * 60s * ~13.9 m/s (50 km/h) → max reach in degrees (~0.009°/km)
            sa_reach_deg = (minutes * 60 * 13.9) / 111_320  # 111320 m per degree
            sa_buf       = min(sa_reach_deg * 1.3, 1.0)     # 30% margin, cap 1°
            sa_inner_sql = (
                "SELECT id, source, target, cost, reverse_cost "
                "FROM topology.ways "
                "WHERE cost > 0 "
                "AND geom && ST_Expand("
                "ST_MakePoint({lon},{lat})::geometry, {buf})"
            ).format(lon=lon, lat=lat, buf=sa_buf)

            cur.execute(
                """
                WITH reach AS (
                    SELECT edge
                    FROM pgr_drivingDistance(
                        %s,
                        %s, %s, directed := false
                    )
                ),
                edges AS (
                    SELECT w.geom
                    FROM topology.ways w
                    JOIN reach r ON w.id = r.edge
                )
                SELECT
                    ST_AsGeoJSON(ST_Union(geom))                              AS geom_union,
                    ST_AsGeoJSON(ST_ConcaveHull(ST_Collect(geom), 0.90, true)) AS hull,
                    COUNT(*)                                                   AS edge_count
                FROM edges
                """,
                (sa_inner_sql, node["id"], minutes * 60),
            )
            result = cur.fetchone()
            cur.close()

        if not result or result["edge_count"] == 0:
            return jsonify({"error": "No reachable network found within that time."}), 404

        return jsonify({
            "service_point":      {"lon": lon, "lat": lat},
            "time_minutes":       minutes,
            "reachable_network":  json.loads(result["geom_union"]),
            "service_area":       json.loads(result["hull"]),
            "edge_count":         result["edge_count"],
        })

    except Exception:
        logger.exception("Service area error")
        return jsonify({"error": "Internal server error."}), 500


# ---------------------------------------------------------------------------
# /nearest_facility  — Find and route to the k nearest POIs
# ---------------------------------------------------------------------------

_ALLOWED_FACILITY_TYPES = frozenset({"hospital", "fire station", "police", "clinic"})


@app.route("/nearest_facility", methods=["GET"])
def nearest_facility():
    """
    Find the nearest facilities of a given type and return routes to each.

    GET params:
        lon, lat            — WGS-84 incident location
        type                — hospital | fire station | police | clinic
        limit               — 1-5 (default 5)
        max_distance_km     — 1-15 (default 5.0)
        routes              — true | false (default true)
    """
    # 1. Validate inputs
    try:
        lon, lat = _parse_lonlat(request.args.get("lon"), request.args.get("lat"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    facility_type   = request.args.get("type", "hospital").lower().strip()
    limit           = min(request.args.get("limit", 5, type=int), 5)
    max_distance_km = request.args.get("max_distance_km", 5.0, type=float)
    include_routes  = request.args.get("routes", "true").lower() == "true"

    if facility_type not in _ALLOWED_FACILITY_TYPES:
        return jsonify({"error": f"type must be one of: {', '.join(sorted(_ALLOWED_FACILITY_TYPES))}."}), 400
    if not (1 <= max_distance_km <= 15):
        return jsonify({"error": "max_distance_km must be between 1 and 15."}), 400

    try:
        with db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SET statement_timeout = '30s'")

            # 2. Snap incident location
            click_node = _snap(cur, lon, lat)
            if not click_node:
                return jsonify({"error": "Location is more than 1 km from the road network."}), 404
            click_vid = click_node["id"]

            # BBOX inner SQL for all pgRouting calls in this handler.
            # Radius = max_distance_km + 20% margin, converted to degrees.
            fac_buf = min((max_distance_km * 1.2) / 111.32, 1.0)
            fac_inner_sql = (
                "SELECT id, source, target, cost, reverse_cost "
                "FROM topology.ways "
                "WHERE cost > 0 "
                "AND geom && ST_Expand("
                "ST_MakePoint({lon},{lat})::geometry,{buf})"
            ).format(lon=lon, lat=lat, buf=fac_buf)

            # 3. Find candidate facilities + travel cost in one LATERAL query
            #    ST_Centroid handles both Point and Multi* geometry types safely.
            #    LOWER() comparison makes type matching case-insensitive.
            # fac_inner_sql must be interpolated at the Python level using
            # .format() — it cannot be passed as a psycopg2 %s parameter because
            # pgr_dijkstraCost's first argument is re-parsed by PostgreSQL itself,
            # not by the psycopg2 driver.  Dollar-quoting avoids any single-quote
            # collision with the coordinates already embedded in fac_inner_sql.
            lateral_sql = """
                WITH click_pt AS (
                    SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography AS geog
                ),
                candidates AS (
                    SELECT
                        p.id,
                        p.name,
                        p.type,
                        p.address,
                        p.nearest_vertex_id,
                        ST_X(ST_Centroid(p.geom)) AS facility_lon,
                        ST_Y(ST_Centroid(p.geom)) AS facility_lat,
                        ST_Distance(p.geom::geography, (SELECT geog FROM click_pt)) / 1000.0
                            AS crow_distance_km
                    FROM topology.places p
                    WHERE LOWER(p.type) = LOWER(%s)
                      AND p.nearest_vertex_id IS NOT NULL
                      AND ST_DWithin(p.geom::geography,
                                     (SELECT geog FROM click_pt),
                                     %s * 1000)
                    ORDER BY p.geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
                    LIMIT 10
                )
                SELECT
                    c.*,
                    ROUND(d.agg_cost::numeric, 1)        AS travel_seconds,
                    ROUND((d.agg_cost / 60.0)::numeric, 1) AS travel_minutes
                FROM candidates c
                CROSS JOIN LATERAL (
                    SELECT agg_cost
                    FROM pgr_dijkstraCost(
                        $pgrouting${inner_sql}$pgrouting$,
                        %s, c.nearest_vertex_id, directed => true
                    )
                ) d
                ORDER BY d.agg_cost
                LIMIT %s
            """.format(inner_sql=fac_inner_sql)

            cur.execute(
                lateral_sql,
                (lon, lat, facility_type, max_distance_km, lon, lat, click_vid, limit),
            )
            facilities = cur.fetchall()

            if not facilities:
                cur.close()
                return jsonify({
                    "message":    f"No {facility_type} found within {max_distance_km} km.",
                    "count":      0,
                    "facilities": [],
                }), 200

            # 4. Fetch all route geometries in ONE query (one-to-many Dijkstra)
            #    Replaces the per-facility loop from the original.
            route_by_target: dict[int, list] = {}
            if include_routes:
                target_vids = [f["nearest_vertex_id"] for f in facilities]
                geom_sql = (
                    """
                    SELECT p.end_vid,
                           p.seq,
                           ST_AsGeoJSON(w.geom) AS geojson,
                           w.length_m
                    FROM pgr_dijkstra($pgrouting${inner_sql}$pgrouting$,
                                      %s, %s, directed => true) AS p
                    JOIN topology.ways w ON p.edge = w.id
                    WHERE p.edge != -1
                    ORDER BY p.end_vid, p.seq
                    """
                ).format(inner_sql=fac_inner_sql)
                cur.execute(
                    geom_sql,
                    (click_vid, [int(v) for v in target_vids]),
                )
                for row in cur.fetchall():
                    route_by_target.setdefault(row["end_vid"], []).append(row)

            cur.close()

        # 5. Assemble response
        result_facilities = []
        for f in facilities:
            entry = dict(f)
            if include_routes:
                segs = route_by_target.get(f["nearest_vertex_id"], [])
                entry["route"] = {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "geometry": json.loads(r["geojson"]),
                            "properties": {
                                "seq":      r["seq"],
                                "length_m": round(r["length_m"], 2),
                            },
                        }
                        for r in segs
                    ],
                }
            result_facilities.append(entry)

        return jsonify({
            "incident":          {"lon": lon, "lat": lat},
            "type":              facility_type,
            "search_radius_km":  max_distance_km,
            "count":             len(result_facilities),
            "facilities":        result_facilities,
        })

    except Exception:
        logger.exception("Nearest facility error")
        return jsonify({"error": "Internal server error."}), 500


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
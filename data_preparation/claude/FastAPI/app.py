# =============================================================================
# app.py — Geo-Routing API (FastAPI + PostGIS + pgRouting)
#
# WHY FASTAPI OVER FLASK?
#   1. Pydantic models replace all the manual _parse_lonlat() / bounds-check
#      code — invalid inputs are rejected automatically with clear error messages.
#   2. async def handlers mean the event loop is free while the DB query runs,
#      so the server can handle many concurrent requests without extra threads.
#   3. /docs (Swagger UI) and /redoc are generated for free from the type hints.
#   4. Response models enforce the exact JSON shape the frontend expects.
#
# MIGRATION SUMMARY FROM FLASK:
#   @app.route("/x", methods=["GET"])  →  @app.get("/x")
#   request.args.get("foo")            →  foo: type = Query(...)  (function param)
#   jsonify({...})                     →  return {...}  (FastAPI auto-serialises)
#   abort(400, "msg")                  →  raise HTTPException(400, "msg")
#   Manual try/except for validation   →  Pydantic does it automatically
# =============================================================================

from contextlib import asynccontextmanager, contextmanager
from collections import defaultdict
import json
import logging
import os
from typing import Annotated

import psycopg2
import psycopg2.pool
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from psycopg2.extras import RealDictCursor
from pydantic import BaseModel, field_validator, model_validator

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# DATABASE CONNECTION POOL
# (Same logic as Flask version — psycopg2 is synchronous, so we keep the
#  ThreadedConnectionPool.  For a fully async setup you would swap in asyncpg,
#  but that requires rewriting every query.  This hybrid is the safe migration.)
# ---------------------------------------------------------------------------

_pool: psycopg2.pool.ThreadedConnectionPool | None = None

_DB_KWARGS = dict(
    host=os.getenv("POSTGRES_HOST", "postgis"),
    database=os.getenv("POSTGRES_DB", "geodb"),
    user=os.getenv("POSTGRES_USER"),
    password=os.getenv("POSTGRES_PASSWORD"),
    port=int(os.getenv("POSTGRES_PORT", "5432")),
    connect_timeout=10,
    options="-c random_page_cost=1.1 -c effective_cache_size=2GB",
)


def _init_pool() -> None:
    global _pool
    try:
        _pool = psycopg2.pool.ThreadedConnectionPool(minconn=2, maxconn=20, **_DB_KWARGS)
        logger.info("Connection pool created.")
    except Exception as exc:
        logger.error("Failed to create pool: %s", exc)
        _pool = None


# ---------------------------------------------------------------------------
# FastAPI lifespan — replaces Flask's module-level init_pool() call.
# The pool is created on startup and cleanly closed on shutdown.
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    _init_pool()          # ← startup
    yield
    if _pool:
        _pool.closeall()  # ← shutdown (close every pooled connection)


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Geo-Routing API",
    description="Point-to-point routing, TSP, nearest facility, and service area using pgRouting.",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # Tighten in production (list your frontend origins)
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# DB helpers (identical to Flask version)
# ---------------------------------------------------------------------------

def _get_conn():
    if _pool:
        try:
            return _pool.getconn()
        except Exception as exc:
            logger.error("Pool exhausted: %s", exc)
    raise RuntimeError("Database connection pool unavailable.")


def _put_conn(conn) -> None:
    if _pool:
        try:
            _pool.putconn(conn)
            return
        except Exception as exc:
            logger.error("Failed to return conn: %s", exc)
    try:
        conn.close()
    except Exception:
        pass


@contextmanager
def db_connection():
    """Guarantee the connection is always returned to the pool."""
    conn = _get_conn()
    try:
        yield conn
    finally:
        _put_conn(conn)


# ---------------------------------------------------------------------------
# Shared DB helpers (unchanged from Flask version)
# ---------------------------------------------------------------------------

def _snap(cur, lon: float, lat: float, radius_m: int = 1000):
    """
    Find the nearest road-network vertex within radius_m metres.
    Uses ::geography so the distance check is in real metres, not degrees.
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
    Dynamic BBOX expansion: 20% of the larger route dimension.
    Floor 0.05° (~5 km), cap 1.0° (~110 km).
    """
    span = max(abs(end_lon - start_lon), abs(end_lat - start_lat))
    return max(0.05, min(span * 0.20, 1.0))


# ---------------------------------------------------------------------------
# PYDANTIC REQUEST / RESPONSE MODELS
#
# WHY THIS IS BETTER THAN MANUAL VALIDATION:
#   In Flask we wrote _parse_lonlat() and scattered if/raise blocks.
#   With Pydantic, we declare the schema once and FastAPI automatically:
#     - Parses and coerces types (string "1.23" → float 1.23)
#     - Returns a structured 422 error if any value is invalid
#     - Documents every field in /docs
#
# The @field_validator decorators replace the old bounds-check if-blocks.
# ---------------------------------------------------------------------------

class LonLat(BaseModel):
    """
    Reusable mixin for any model that carries a lon/lat pair.
    Inherit from this instead of duplicating the validators.
    """
    lon: float
    lat: float

    @field_validator("lon")
    @classmethod
    def check_lon(cls, v):
        if not (-180.0 <= v <= 180.0):
            raise ValueError(f"Longitude {v} is outside [-180, 180].")
        return v

    @field_validator("lat")
    @classmethod
    def check_lat(cls, v):
        if not (-90.0 <= v <= 90.0):
            raise ValueError(f"Latitude {v} is outside [-90, 90].")
        return v


class TSPRequest(BaseModel):
    """
    POST body for /route/tsp.

    points: list of [lon, lat] pairs — at least 3, at most 10.

    The @model_validator (runs after all field validators) checks the
    per-item coordinate bounds and the list length constraint.
    """
    points: list[list[float]]

    @model_validator(mode="after")
    def check_points(self):
        if len(self.points) < 3:
            raise ValueError("Need at least 3 points for TSP.")
        if len(self.points) > 10:
            raise ValueError(f"Maximum 10 waypoints allowed (got {len(self.points)}).")
        for i, p in enumerate(self.points):
            if len(p) != 2:
                raise ValueError(f"Point {i+1} must be [lon, lat].")
            lon, lat = p
            if not (-180.0 <= lon <= 180.0):
                raise ValueError(f"Point {i+1} longitude {lon} is outside [-180, 180].")
            if not (-90.0 <= lat <= 90.0):
                raise ValueError(f"Point {i+1} latitude {lat} is outside [-90, 90].")
        return self


# Allowed facility types (whitelist prevents SQL injection via the `type` param)
_ALLOWED_FACILITY_TYPES = frozenset({"hospital", "fire station", "police", "clinic"})

# ---------------------------------------------------------------------------
# HELPER: map HTTP 404/400 returns from business logic to HTTPException
# ---------------------------------------------------------------------------

def _not_found(msg: str):
    raise HTTPException(status_code=404, detail=msg)

def _bad_request(msg: str):
    raise HTTPException(status_code=400, detail=msg)


# ===========================================================================
# ENDPOINT: GET /health
# ===========================================================================

@app.get("/health", summary="Liveness check")
def health():
    """Returns 200 if the DB is reachable, 500 otherwise."""
    try:
        with db_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT 1")
            cur.close()
        return {"status": "healthy", "db": "connected"}
    except Exception as exc:
        logger.error("Health check failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ===========================================================================
# ENDPOINT: GET /route
#
# CHANGES FROM FLASK VERSION:
#   - Query params are now typed function arguments — no request.args.get()
#   - Pydantic rejects bad types automatically (e.g. start_lon="abc" → 422)
#   - Bounds checks moved to inline Annotated[float, Query(ge=..., le=...)]
#   - Response shape is always { routes: [...], count, optimization, requested }
#     (the Flask version returned a bare FeatureCollection for alternatives=1)
# ===========================================================================

@app.get("/route", summary="A-to-B routing with alternative paths")
def get_route(
    # Annotated + Query(ge=..., le=...) replaces _parse_lonlat() entirely.
    # FastAPI rejects out-of-range values with a clear 422 before our code runs.
    start_lon: Annotated[float, Query(ge=-180, le=180, description="Start longitude")],
    start_lat: Annotated[float, Query(ge=-90,  le=90,  description="Start latitude")],
    end_lon:   Annotated[float, Query(ge=-180, le=180, description="End longitude")],
    end_lat:   Annotated[float, Query(ge=-90,  le=90,  description="End latitude")],
    alternatives: Annotated[int,  Query(ge=1, le=3, description="Number of routes (1-3)")] = 1,
    optimization: Annotated[str,  Query(description="fastest | shortest")] = "fastest",
):
    if optimization not in ("fastest", "shortest"):
        _bad_request("optimization must be 'fastest' or 'shortest'.")

    try:
        with db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SET statement_timeout = '20s'")

            # Snap to road network
            start_node = _snap(cur, start_lon, start_lat)
            end_node   = _snap(cur, end_lon,   end_lat)

            if not start_node:
                _not_found("Start point is more than 1 km from the road network.")
            if not end_node:
                _not_found("End point is more than 1 km from the road network.")

            start_vid, end_vid = start_node["id"], end_node["id"]
            if start_vid == end_vid:
                _bad_request("Start and end snap to the same network node.")

            # Build BBOX and inner SQL
            buf = _bbox_buffer(start_lon, start_lat, end_lon, end_lat)
            cost_col     = "length_m" if optimization == "shortest" else "cost"
            rev_cost_col = "length_m" if optimization == "shortest" else "reverse_cost"

            inner_sql = (
                "SELECT id, source, target, "
                "{cost} AS cost, {rev} AS reverse_cost "
                "FROM topology.ways "
                "WHERE geom && ST_Expand("
                "ST_MakeEnvelope({x1},{y1},{x2},{y2},4326), {buf})"
            ).format(
                cost=cost_col, rev=rev_cost_col,
                x1=min(start_lon, end_lon), y1=min(start_lat, end_lat),
                x2=max(start_lon, end_lon), y2=max(start_lat, end_lat),
                buf=buf,
            )

            cur.execute(
                """
                SELECT p.path_id, p.seq, p.node, p.edge, p.agg_cost,
                       ST_AsGeoJSON(w.geom) AS geojson,
                       w.length_m, w.cost AS travel_cost, w.id AS edge_id
                FROM pgr_ksp(
                    %s, %s, %s, %s,
                    directed => true, heap_paths => false
                ) AS p
                LEFT JOIN topology.ways w ON p.edge = w.id
                ORDER BY p.path_id, p.seq
                """,
                (inner_sql, start_vid, end_vid, alternatives),
            )
            rows = cur.fetchall()
            cur.close()

        if not rows:
            _not_found("No route found between the given points.")

        # Group by path_id and build FeatureCollections
        paths: dict[int, list] = {}
        for row in rows:
            paths.setdefault(row["path_id"], []).append(row)

        routes = []
        for path_rows in sorted(paths.values(), key=lambda r: r[0]["path_id"]):
            if path_rows[-1]["node"] != end_vid:
                continue

            features, total_length_m, total_cost = [], 0.0, 0.0
            for r in path_rows:
                if not r["geojson"]:
                    continue
                total_length_m += r["length_m"]    or 0.0
                total_cost     += r["travel_cost"] or 0.0
                features.append({
                    "type": "Feature",
                    "geometry": json.loads(r["geojson"]),
                    "properties": {
                        "edge_id":  r["edge_id"],
                        "length_m": round(r["length_m"] or 0.0, 2),
                    },
                })

            routes.append({
                "type":              "FeatureCollection",
                "features":          features,
                "total_distance_km": round(total_length_m / 1000, 2),
                "duration_minutes":  round(total_cost / 60, 1),
                "alternative_rank":  len(routes) + 1,
                "optimization":      optimization,
            })

        if not routes:
            _not_found("Routing graph is disconnected; no path exists.")

        # ALWAYS return the same shape regardless of alternatives count.
        # Frontend only needs to handle one response format.
        return {
            "routes":       routes,
            "count":        len(routes),
            "optimization": optimization,
            "requested":    alternatives,
        }

    except HTTPException:
        raise  # Let FastAPI handle our intentional errors
    except Exception:
        logger.exception("Route error")
        raise HTTPException(status_code=500, detail="Internal server error.")


# ===========================================================================
# ENDPOINT: POST /route/tsp
#
# CHANGES FROM FLASK VERSION:
#   - request.get_json() replaced by TSPRequest Pydantic model
#   - All coordinate validation in the model (no manual loop in the handler)
#   - 400 errors raised with HTTPException, not returned as dicts
# ===========================================================================

@app.post("/route/tsp", summary="Travelling Salesman Problem routing")
def get_tsp_route(body: TSPRequest):
    """
    Find the most efficient visit order for a set of waypoints.

    POST body: { "points": [[lon1, lat1], [lon2, lat2], ..., [lonN, latN]] }
    Minimum 3 points, maximum 10.
    """
    validated = body.points  # Already validated by Pydantic

    try:
        with db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SET statement_timeout = '60s'")

            # Snap all waypoints
            vertex_ids = []
            for i, (lon, lat) in enumerate(validated):
                node = _snap(cur, lon, lat)
                if not node:
                    _not_found(f"Point {i+1} ({lon:.6f}, {lat:.6f}) is more than 1 km from the road network.")
                vertex_ids.append(node["id"])

            # Build BBOX inner SQL
            all_lons = [p[0] for p in validated]
            all_lats = [p[1] for p in validated]
            tsp_buf  = _bbox_buffer(min(all_lons), min(all_lats), max(all_lons), max(all_lats))

            tsp_inner_sql = (
                "SELECT id, source, target, cost, reverse_cost "
                "FROM topology.ways WHERE cost > 0 "
                "AND geom && ST_Expand("
                "ST_MakeEnvelope({x1},{y1},{x2},{y2},4326),{buf})"
            ).format(
                x1=min(all_lons), y1=min(all_lats),
                x2=max(all_lons), y2=max(all_lats),
                buf=tsp_buf,
            )

            # Cost matrix — one query for all N*(N-1) pairwise costs
            cur.execute(
                "SELECT start_vid, end_vid, agg_cost "
                "FROM pgr_dijkstraCostMatrix(%s, %s, directed => true)",
                (tsp_inner_sql, vertex_ids),
            )
            matrix_rows = cur.fetchall()

            expected = len(vertex_ids) * (len(vertex_ids) - 1)
            if not matrix_rows or len(matrix_rows) < expected:
                _not_found("Could not compute cost matrix between all waypoints.")

            # Solve TSP
            cur.execute(
                """
                SELECT seq, node, cost, agg_cost
                FROM pgr_TSP(
                    $$SELECT start_vid, end_vid, agg_cost
                      FROM (VALUES {values}) AS t(start_vid, end_vid, agg_cost)$$
                ) ORDER BY seq
                """.format(
                    values=", ".join(
                        f"({r['start_vid']},{r['end_vid']},{r['agg_cost']})"
                        for r in matrix_rows
                    )
                )
            )
            tsp_path = cur.fetchall()
            if not tsp_path or len(tsp_path) < 2:
                _not_found("Could not solve TSP.")

            # Build legs (consecutive vertex pairs)
            legs = [
                (int(tsp_path[i]["node"]), int(tsp_path[i + 1]["node"]))
                for i in range(len(tsp_path) - 1)
            ]

            # Fetch all leg geometries in ONE UNION ALL query
            leg_selects = []
            for leg_idx, (start_v, end_v) in enumerate(legs):
                leg_selects.append(
                    """
                    SELECT {idx} AS leg_index, p.seq,
                           ST_AsGeoJSON(w.geom) AS geojson, w.length_m
                    FROM pgr_dijkstra($pgrouting${inner}$pgrouting$,
                                      {start},{end}, directed => true) AS p
                    JOIN topology.ways w ON p.edge = w.id
                    WHERE p.edge != -1
                    """.format(idx=leg_idx, inner=tsp_inner_sql, start=start_v, end=end_v)
                )
            cur.execute(" UNION ALL ".join(leg_selects) + " ORDER BY leg_index, seq")
            seg_rows = cur.fetchall()
            cur.close()

        # Group by leg_index
        legs_features: dict[int, list] = defaultdict(list)
        for row in seg_rows:
            legs_features[row["leg_index"]].append({
                "type": "Feature",
                "geometry": json.loads(row["geojson"]),
                "properties": {"length_m": round(row["length_m"], 2), "leg_index": row["leg_index"]},
            })

        segments = [
            {"type": "FeatureCollection", "features": legs_features[i]}
            for i in range(len(legs))
        ]

        total_distance_m = sum(r["length_m"] for r in seg_rows)
        total_cost       = float(tsp_path[-1]["agg_cost"]) if tsp_path else 0.0

        node_to_idx    = {vid: i for i, vid in enumerate(vertex_ids)}
        waypoint_order = [node_to_idx[int(r["node"])] for r in tsp_path if int(r["node"]) in node_to_idx]
        if len(waypoint_order) > len(validated):
            waypoint_order = waypoint_order[:len(validated)]

        return {
            "type":              "FeatureCollection",
            "segments":          segments,
            "features":          [],
            "total_distance_km": round(total_distance_m / 1000, 2),
            "duration_minutes":  round(total_cost / 60, 1),
            "segment_count":     len(segments),
            "waypoint_count":    len(validated),
            "waypoint_order":    waypoint_order,
            "optimization":      "tsp",
        }

    except HTTPException:
        raise
    except Exception:
        logger.exception("TSP error")
        raise HTTPException(status_code=500, detail="Internal server error while solving TSP.")


# ===========================================================================
# ENDPOINT: GET /nearest_facility
#
# CHANGES FROM FLASK VERSION:
#   - Coordinate validation via Query(ge=..., le=...) annotations
#   - facility_type validated inline with a simple `in` check + HTTPException
#   - max_distance_km validated with Query(ge=1, le=15)
#   - No more manual try/except around input parsing
# ===========================================================================

_ALLOWED_FACILITY_TYPES = frozenset({"hospital", "fire station", "police", "clinic"})


@app.get("/nearest_facility", summary="Find and route to nearest POIs")
def nearest_facility(
    lon:            Annotated[float, Query(ge=-180, le=180)],
    lat:            Annotated[float, Query(ge=-90,  le=90)],
    type:           str   = "hospital",
    limit:          Annotated[int,   Query(ge=1, le=5)]   = 5,
    max_distance_km: Annotated[float, Query(ge=1, le=15)] = 5.0,
    routes:         bool  = True,
):
    facility_type = type.lower().strip()
    if facility_type not in _ALLOWED_FACILITY_TYPES:
        _bad_request(f"type must be one of: {', '.join(sorted(_ALLOWED_FACILITY_TYPES))}.")

    try:
        with db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SET statement_timeout = '30s'")

            click_node = _snap(cur, lon, lat)
            if not click_node:
                _not_found("Location is more than 1 km from the road network.")
            click_vid = click_node["id"]

            fac_buf = min((max_distance_km * 1.2) / 111.32, 1.0)
            fac_inner_sql = (
                "SELECT id, source, target, cost, reverse_cost "
                "FROM topology.ways WHERE cost > 0 "
                "AND geom && ST_Expand(ST_MakePoint({lon},{lat})::geometry,{buf})"
            ).format(lon=lon, lat=lat, buf=fac_buf)

            lateral_sql = """
                WITH click_pt AS (
                    SELECT ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography AS geog
                ),
                candidates AS (
                    SELECT p.id, p.name, p.type, p.address, p.nearest_vertex_id,
                           ST_X(ST_Centroid(p.geom)) AS facility_lon,
                           ST_Y(ST_Centroid(p.geom)) AS facility_lat,
                           ST_Distance(p.geom::geography,(SELECT geog FROM click_pt))/1000.0
                               AS crow_distance_km
                    FROM topology.places p
                    WHERE LOWER(p.type) = LOWER(%s)
                      AND p.nearest_vertex_id IS NOT NULL
                      AND ST_DWithin(p.geom::geography,(SELECT geog FROM click_pt),%s*1000)
                    ORDER BY p.geom <-> ST_SetSRID(ST_MakePoint(%s,%s),4326)
                    LIMIT 10
                )
                SELECT c.*,
                    ROUND(d.agg_cost::numeric,1) AS travel_seconds,
                    ROUND((d.agg_cost/60.0)::numeric,1) AS travel_minutes
                FROM candidates c
                CROSS JOIN LATERAL (
                    SELECT agg_cost FROM pgr_dijkstraCost(
                        $pgrouting${inner}$pgrouting$,
                        %s, c.nearest_vertex_id, directed => true)
                ) d
                ORDER BY d.agg_cost LIMIT %s
            """.format(inner=fac_inner_sql)

            cur.execute(lateral_sql, (lon, lat, facility_type, max_distance_km, lon, lat, click_vid, limit))
            facilities = cur.fetchall()

            if not facilities:
                cur.close()
                return {"message": f"No {facility_type} found within {max_distance_km} km.", "count": 0, "facilities": []}

            route_by_target: dict[int, list] = {}
            if routes:
                target_vids = [f["nearest_vertex_id"] for f in facilities]
                geom_sql = (
                    "SELECT p.end_vid, p.seq, ST_AsGeoJSON(w.geom) AS geojson, w.length_m "
                    "FROM pgr_dijkstra($pgrouting${inner}$pgrouting$, %s, %s, directed => true) AS p "
                    "JOIN topology.ways w ON p.edge = w.id "
                    "WHERE p.edge != -1 ORDER BY p.end_vid, p.seq"
                ).format(inner=fac_inner_sql)
                cur.execute(geom_sql, (click_vid, [int(v) for v in target_vids]))
                for row in cur.fetchall():
                    route_by_target.setdefault(row["end_vid"], []).append(row)

            cur.close()

        result_facilities = []
        for f in facilities:
            entry = dict(f)
            if routes:
                segs = route_by_target.get(f["nearest_vertex_id"], [])
                entry["route"] = {
                    "type": "FeatureCollection",
                    "features": [
                        {"type": "Feature",
                         "geometry": json.loads(r["geojson"]),
                         "properties": {"seq": r["seq"], "length_m": round(r["length_m"], 2)}}
                        for r in segs
                    ],
                }
            result_facilities.append(entry)

        return {
            "incident":         {"lon": lon, "lat": lat},
            "type":             facility_type,
            "search_radius_km": max_distance_km,
            "count":            len(result_facilities),
            "facilities":       result_facilities,
        }

    except HTTPException:
        raise
    except Exception:
        logger.exception("Nearest facility error")
        raise HTTPException(status_code=500, detail="Internal server error.")


# ===========================================================================
# ENDPOINT: GET /service_area
# ===========================================================================

@app.get("/service_area", summary="Compute reachable area (isochrone)")
def service_area(
    lon:     Annotated[float, Query(ge=-180, le=180)],
    lat:     Annotated[float, Query(ge=-90,  le=90)],
    minutes: Annotated[float, Query(ge=1, le=20)] = 5,
):
    try:
        with db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SET statement_timeout = '30s'")

            node = _snap(cur, lon, lat)
            if not node:
                _not_found("Service point is more than 1 km from the road network.")

            sa_reach_deg = (minutes * 60 * 13.9) / 111_320
            sa_buf       = min(sa_reach_deg * 1.3, 1.0)

            sa_inner_sql = (
                "SELECT id, source, target, cost, reverse_cost "
                "FROM topology.ways WHERE cost > 0 "
                "AND geom && ST_Expand(ST_MakePoint({lon},{lat})::geometry,{buf})"
            ).format(lon=lon, lat=lat, buf=sa_buf)

            cur.execute(
                """
                WITH reach AS (
                    SELECT edge FROM pgr_drivingDistance(%s, %s, %s, directed := false)
                ),
                edges AS (SELECT w.geom FROM topology.ways w JOIN reach r ON w.id = r.edge)
                SELECT
                    ST_AsGeoJSON(ST_Union(geom))                               AS geom_union,
                    ST_AsGeoJSON(ST_ConcaveHull(ST_Collect(geom), 0.90, true)) AS hull,
                    COUNT(*) AS edge_count
                FROM edges
                """,
                (sa_inner_sql, node["id"], minutes * 60),
            )
            result = cur.fetchone()
            cur.close()

        if not result or result["edge_count"] == 0:
            _not_found("No reachable network found within that time.")

        return {
            "service_point":     {"lon": lon, "lat": lat},
            "time_minutes":      minutes,
            "reachable_network": json.loads(result["geom_union"]),
            "service_area":      json.loads(result["hull"]),
            "edge_count":        result["edge_count"],
        }

    except HTTPException:
        raise
    except Exception:
        logger.exception("Service area error")
        raise HTTPException(status_code=500, detail="Internal server error.")


# ---------------------------------------------------------------------------
# Entry point (uvicorn replaces flask dev server)
#
# Run with:
#   uvicorn app:app --host 0.0.0.0 --port 5000 --workers 4
#
# Or in development (auto-reload):
#   uvicorn app:app --host 0.0.0.0 --port 5000 --reload
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=5000, reload=False)

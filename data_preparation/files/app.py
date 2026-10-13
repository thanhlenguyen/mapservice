# app.py — IMPROVED VERSION with Distance Limitation
from flask import Flask, request, jsonify
import psycopg2
from psycopg2.extras import RealDictCursor
import os
import json
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Database connection
def get_db_connection():
    return psycopg2.connect(
        host=os.getenv("POSTGRES_HOST", "postgis"),
        database=os.getenv("POSTGRES_DB", "geodb"),
        user=os.getenv("POSTGRES_USER", "le"),
        password=os.getenv("POSTGRES_PASSWORD", "123456"),
        port=5432
    )

@app.route('/health', methods=['GET'])
def health():
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT 1")
        cur.close()
        conn.close()
        return jsonify({"status": "healthy", "db": "connected"}), 200
    except Exception as e:
        return jsonify({"status": "unhealthy", "error": str(e)}), 500

@app.route('/route', methods=['GET', 'POST'])
def get_route():
    """
    Multi-point routing with Traveling Salesman Problem (TSP) optimization
    
    GET: Simple A-to-B routing
        ?start_lon=&start_lat=&end_lon=&end_lat=
    
    POST: TSP with multiple waypoints
        Body: {"points": [[lon, lat], [lon, lat], ...]}
    """
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Determine if simple or TSP routing
        if request.method == 'POST':
            data = request.get_json()
            points = data.get('points', [])
            
            if not points or len(points) < 2:
                return jsonify({"error": "Need at least 2 points for TSP"}), 400
            
            return solve_tsp(cur, conn, points)
        
        else:  # GET - simple A to B
            start_lon = float(request.args.get('start_lon'))
            start_lat = float(request.args.get('start_lat'))
            end_lon = float(request.args.get('end_lon'))
            end_lat = float(request.args.get('end_lat'))

            if None in (start_lon, start_lat, end_lon, end_lat):
                return jsonify({"error": "Missing coordinates"}), 400

            # Find nearest vertices
            cur.execute("""
                WITH start_pt AS (SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geometry AS geom),
                     end_pt   AS (SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geometry AS geom)
                SELECT 
                    (SELECT id FROM topology.vertices 
                     ORDER BY geom <-> (SELECT geom FROM start_pt) LIMIT 1) AS start_vid,
                    (SELECT id FROM topology.vertices 
                     ORDER BY geom <-> (SELECT geom FROM end_pt) LIMIT 1) AS end_vid,
                    (SELECT ST_Distance(geom, (SELECT geom FROM start_pt)) 
                     FROM topology.vertices 
                     ORDER BY geom <-> (SELECT geom FROM start_pt) LIMIT 1) AS start_distance,
                    (SELECT ST_Distance(geom, (SELECT geom FROM end_pt)) 
                     FROM topology.vertices 
                     ORDER BY geom <-> (SELECT geom FROM end_pt) LIMIT 1) AS end_distance;
            """, (start_lon, start_lat, end_lon, end_lat))
            
            nodes = cur.fetchone()
            start_vid = nodes['start_vid']
            end_vid = nodes['end_vid']

            if nodes['start_distance'] > 0.1 or nodes['end_distance'] > 0.1:
                return jsonify({
                    "error": "Points too far from road network",
                    "hint": "Click within the mapped area"
                }), 404

            if not start_vid or not end_vid:
                return jsonify({"error": "Could not snap to network"}), 404

            # Run simple routing
            cur.execute("""
                SELECT seq, node, edge, cost, agg_cost
                FROM pgr_dijkstra(
                    'SELECT id, source, target, cost, reverse_cost 
                     FROM topology.ways 
                     WHERE cost > 0',
                    %s, %s, directed => true
                )
                ORDER BY seq;
            """, (start_vid, end_vid))

            path = cur.fetchall()

            if not path or path[-1]['node'] != end_vid:
                return jsonify({"error": "No route found"}), 404

            edge_ids = [row['edge'] for row in path if row['edge'] != -1]

            if edge_ids:
                cur.execute("""
                    SELECT id, ST_AsGeoJSON(geom) AS geojson, length_m
                    FROM topology.ways
                    WHERE id = ANY(%s)
                    ORDER BY ARRAY_POSITION(%s, id);
                """, (edge_ids, edge_ids))
                segments = cur.fetchall()
            else:
                segments = []

            features = []
            for seg in segments:
                features.append({
                    "type": "Feature",
                    "geometry": json.loads(seg['geojson']),
                    "properties": {
                        "id": seg['id'],
                        "length_m": round(seg['length_m'], 2)
                    }
                })

            total_cost = path[-1]['agg_cost'] if path else 0
            total_distance = sum(seg['length_m'] for seg in segments) if segments else 0

            cur.close()
            conn.close()

            return jsonify({
                "type": "FeatureCollection",
                "features": features,
                "total_distance_km": round(total_distance / 1000, 2),
                "duration_minutes": round(total_cost / 60, 1),
                "segment_count": len(features),
                "start_vertex": int(start_vid),
                "end_vertex": int(end_vid)
            })

    except Exception as e:
        return jsonify({"error": str(e)}), 500

def solve_tsp(cur, conn, points):
    """
    Solve Traveling Salesman Problem using pgr_TSP
    """
    try:
        # 1. Snap all points to nearest vertices
        vertex_ids = []
        for i, (lon, lat) in enumerate(points):
            cur.execute("""
                SELECT id, ST_Distance(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326)) AS dist
                FROM topology.vertices
                ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
                LIMIT 1;
            """, (lon, lat, lon, lat))
            
            v = cur.fetchone()
            if not v or v['dist'] > 0.1:
                return jsonify({
                    "error": f"Point {i+1} too far from road network",
                    "point": [lon, lat]
                }), 404
            vertex_ids.append(v['id'])

        if len(vertex_ids) < 2:
            return jsonify({"error": "Need at least 2 valid points"}), 400

        # 2. Build cost matrix between all points
        vertex_pairs = []
        for i, start_v in enumerate(vertex_ids):
            for j, end_v in enumerate(vertex_ids):
                if i != j:
                    vertex_pairs.append((i, j, start_v, end_v))

        # Create temporary table for cost matrix
        cur.execute("DROP TABLE IF EXISTS temp_cost_matrix;")
        cur.execute("""
            CREATE TEMP TABLE temp_cost_matrix (
                start_vid INTEGER,
                end_vid INTEGER,
                agg_cost FLOAT
            );
        """)

        # Calculate costs between all pairs
        for i, j, start_v, end_v in vertex_pairs:
            cur.execute("""
                INSERT INTO temp_cost_matrix (start_vid, end_vid, agg_cost)
                SELECT %s, %s, 
                    COALESCE(
                        (SELECT agg_cost 
                         FROM pgr_dijkstra(
                             'SELECT id, source, target, cost, reverse_cost 
                              FROM topology.ways WHERE cost > 0',
                             %s, %s, directed => true
                         )
                         ORDER BY seq DESC LIMIT 1
                        ), 999999
                    );
            """, (start_v, end_v, start_v, end_v))

        conn.commit()

        # 3. Solve TSP
        cur.execute("""
            SELECT seq, node, cost, agg_cost
            FROM pgr_TSP(
                'SELECT start_vid, end_vid, agg_cost FROM temp_cost_matrix'
            )
            ORDER BY seq;
        """, (vertex_ids[0],))

        tsp_path = cur.fetchall()

        if not tsp_path:
            return jsonify({"error": "Could not solve TSP"}), 404

        # 4. Get detailed route for each segment
        all_edges = []
        waypoint_order = []
        segment_info = []

        for i in range(len(tsp_path) - 1):
            start_v = tsp_path[i]['node']
            end_v = tsp_path[i + 1]['node']
            
            waypoint_order.append(vertex_ids.index(start_v))

            # Get edges for this segment
            cur.execute("""
                SELECT edge, cost
                FROM pgr_dijkstra(
                    'SELECT id, source, target, cost, reverse_cost 
                     FROM topology.ways WHERE cost > 0',
                    %s, %s, directed => true
                )
                WHERE edge != -1
                ORDER BY seq;
            """, (start_v, end_v))

            segment_edges = cur.fetchall()
            edge_ids = [e['edge'] for e in segment_edges]
            segment_cost = sum(e['cost'] for e in segment_edges)
            
            all_edges.extend(edge_ids)
            segment_info.append({
                "from_point": vertex_ids.index(start_v),
                "to_point": vertex_ids.index(end_v),
                "cost_seconds": round(segment_cost, 1)
            })

        # Add final point
        waypoint_order.append(vertex_ids.index(tsp_path[-1]['node']))

        # 5. Fetch geometries
        if all_edges:
            cur.execute("""
                SELECT id, ST_AsGeoJSON(geom) AS geojson, length_m
                FROM topology.ways
                WHERE id = ANY(%s);
            """, (all_edges,))
            segments = cur.fetchall()
        else:
            segments = []

        features = []
        for seg in segments:
            features.append({
                "type": "Feature",
                "geometry": json.loads(seg['geojson']),
                "properties": {
                    "id": seg['id'],
                    "length_m": round(seg['length_m'], 2)
                }
            })

        total_cost = tsp_path[-1]['agg_cost'] if tsp_path else 0
        total_distance = sum(seg['length_m'] for seg in segments) if segments else 0

        cur.close()
        conn.close()

        return jsonify({
            "type": "FeatureCollection",
            "features": features,
            "total_distance_km": round(total_distance / 1000, 2),
            "duration_minutes": round(total_cost / 60, 1),
            "segment_count": len(features),
            "waypoint_count": len(points),
            "waypoint_order": waypoint_order,
            "segment_info": segment_info,
            "optimization": "TSP"
        })

    except Exception as e:
        conn.rollback()
        cur.close()
        conn.close()
        return jsonify({"error": str(e)}), 500

@app.route('/route_hull', methods=['GET'])
def get_route_with_concave_hull():
    """
    Returns route + concave hull (area of interest) around the route
    """
    try:
        start_lon = float(request.args.get('start_lon'))
        start_lat = float(request.args.get('start_lat'))
        end_lon   = float(request.args.get('end_lon'))
        end_lat   = float(request.args.get('end_lat'))

        if None in (start_lon, start_lat, end_lon, end_lat):
            return jsonify({"error": "Missing coordinates"}), 400

        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)

        # 1. Find nearest vertices with distance check
        cur.execute("""
            WITH start_pt AS (SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geometry AS geom),
                 end_pt   AS (SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geometry AS geom)
            SELECT
                (SELECT id FROM topology.vertices ORDER BY geom <-> start_pt.geom LIMIT 1) AS start_vid,
                (SELECT id FROM topology.vertices ORDER BY geom <-> end_pt.geom   LIMIT 1) AS end_vid,
                (SELECT ST_Distance(geom, start_pt.geom) FROM topology.vertices ORDER BY geom <-> start_pt.geom LIMIT 1) AS start_dist,
                (SELECT ST_Distance(geom, end_pt.geom) FROM topology.vertices ORDER BY geom <-> end_pt.geom LIMIT 1) AS end_dist
            FROM start_pt, end_pt;
        """, (start_lon, start_lat, end_lon, end_lat))

        nodes = cur.fetchone()
        start_vid = nodes['start_vid']
        end_vid = nodes['end_vid']

        if nodes['start_dist'] > 0.1 or nodes['end_dist'] > 0.1:
            return jsonify({
                "error": "Points too far from road network",
                "hint": "Click within the mapped area"
            }), 404

        if not start_vid or not end_vid:
            return jsonify({"error": "Cannot snap to network"}), 404

        # 2. Single optimized query for route + concave hull
        cur.execute("""
            WITH route_edges AS (
                SELECT 
                    d.seq,
                    d.edge,
                    d.cost,
                    d.agg_cost,
                    w.geom,
                    w.length_m
                FROM pgr_dijkstra(
                    'SELECT id, source, target, cost, reverse_cost 
                     FROM topology.ways 
                     WHERE cost > 0',
                    %s, %s, directed => true
                ) d
                JOIN topology.ways w ON d.edge = w.id
                WHERE d.edge != -1
            ),
            route_features AS (
                SELECT json_agg(
                    json_build_object(
                        'type', 'Feature',
                        'geometry', ST_AsGeoJSON(geom)::json,
                        'properties', json_build_object(
                            'segment_id', seq,
                            'length_m', round(length_m::numeric, 2)
                        )
                    )
                    ORDER BY seq
                ) AS features
                FROM route_edges
            ),
            route_stats AS (
                SELECT
                    SUM(length_m) / 1000.0 AS total_distance_km,
                    MAX(agg_cost) / 60.0 AS duration_minutes,
                    COUNT(*) AS segment_count
                FROM route_edges
            ),
            concave_hull AS (
                SELECT ST_AsGeoJSON(
                    ST_ConcaveHull(ST_Collect(geom), 0.95, true)
                ) AS hull_geojson
                FROM route_edges
            )
            SELECT 
                rf.features,
                ch.hull_geojson,
                rs.total_distance_km,
                rs.duration_minutes,
                rs.segment_count
            FROM route_features rf, route_stats rs, concave_hull ch;
        """, (start_vid, end_vid))

        result = cur.fetchone()
        cur.close()
        conn.close()

        if not result or not result['features']:
            return jsonify({"error": "No route found"}), 404

        return jsonify({
            "route": {
                "type": "FeatureCollection",
                "features": result['features']
            },
            "area_of_interest": json.loads(result['hull_geojson']),
            "total_distance_km": round(float(result['total_distance_km']), 2),
            "duration_minutes": round(float(result['duration_minutes']), 1),
            "segment_count": int(result['segment_count']),
            "start_vertex": int(start_vid),
            "end_vertex": int(end_vid)
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/service_area', methods=['GET'])
def service_area():
    """
    Service area analysis - reachable road network from a service location
    Input:
        lon, lat  → service point
        minutes   → time budget (defaults to 5)
    """
    try:
        lon = float(request.args.get("lon"))
        lat = float(request.args.get("lat"))
        minutes = float(request.args.get("minutes", 5))

        if minutes < 1 or minutes > 30:
            return jsonify({"error": "Minutes must be between 1 and 30"}), 400

        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)

        # Snap service location to nearest vertex
        cur.execute("""
            WITH p AS (
                SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geometry AS geom
            )
            SELECT id,
                   ST_Distance(geom, (SELECT geom FROM p)) AS dist
            FROM topology.vertices
            ORDER BY geom <-> (SELECT geom FROM p)
            LIMIT 1;
        """, (lon, lat))

        v = cur.fetchone()
        if not v:
            return jsonify({"error": "Could not find nearby road network"}), 404
            
        start_vid = v["id"]
        
        if v["dist"] > 0.1:
            return jsonify({
                "error": "Service point too far from road network",
                "distance_deg": round(v["dist"], 4)
            }), 404

        # Run driving-distance (time-based reachability)
        cur.execute("""
            WITH reach AS (
                SELECT node, edge, cost, agg_cost
                FROM pgr_drivingDistance(
                    'SELECT id, source, target, cost, reverse_cost 
                     FROM topology.ways 
                     WHERE cost > 0',
                    %s,
                    %s * 60,    -- minutes → seconds
                    directed := false
                )
            ),
            edges AS (
                SELECT w.id, w.geom
                FROM topology.ways w
                JOIN reach r ON w.id = r.edge
            )
            SELECT
                ST_AsGeoJSON(ST_Union(geom)) AS geom_union,
                ST_AsGeoJSON(
                    ST_ConcaveHull(ST_Collect(geom), 0.90, true)
                ) AS hull,
                COUNT(*) as edge_count
            FROM edges;
        """, (start_vid, minutes))

        result = cur.fetchone()
        cur.close()
        conn.close()

        if not result or result['edge_count'] == 0:
            return jsonify({"error": "No reachable network found"}), 404

        return jsonify({
            "service_point": {"lon": lon, "lat": lat},
            "time_minutes": minutes,
            "reachable_network": json.loads(result["geom_union"]),
            "service_area": json.loads(result["hull"]),
            "edge_count": result["edge_count"]
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/nearest_facility', methods=['GET'])
def nearest_facility():
    """
    Find nearest facilities using pgRouting with actual route geometries
    IMPROVED: Added distance limitation for faster searches
    """
    try:
        # Parse and validate input
        lon = request.args.get('lon')
        lat = request.args.get('lat')
        facility_type = request.args.get('type', 'hospital').lower()
        limit = request.args.get('limit', 5, type=int)
        max_minutes = request.args.get('max_minutes', type=float)
        max_distance_km = request.args.get('max_distance_km', 10.0, type=float)  # NEW: Default 10km radius
        include_routes = request.args.get('routes', 'true').lower() == 'true'

        # Validate required params
        if not lon or not lat:
            return jsonify({"error": "Missing lon or lat parameter"}), 400

        try:
            lon = float(lon)
            lat = float(lat)
        except ValueError:
            return jsonify({"error": "Invalid lon/lat values"}), 400

        # Validate distance limit (between 1 and 50 km)
        if max_distance_km < 1 or max_distance_km > 50:
            return jsonify({"error": "max_distance_km must be between 1 and 50"}), 400

        # Security: only allow supported types
        allowed_types = ['hospital', 'fire station', 'police', 'clinic']
        if facility_type not in allowed_types:
            return jsonify({
                "error": f"Unsupported facility type. Allowed: {', '.join(allowed_types)}"
            }), 400

        # Get database connection
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)

        # Set query timeout to prevent hanging
        cur.execute("SET statement_timeout = '60s'")

        # First, get the click point vertex
        cur.execute("""
            SELECT id 
            FROM topology.vertices 
            ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
            LIMIT 1
        """, (lon, lat))
        
        click_vertex = cur.fetchone()
        if not click_vertex:
            return jsonify({"error": "Could not snap to road network"}), 404
        
        click_vertex_id = click_vertex['id']

        # IMPROVED: Find nearby facilities with DISTANCE LIMITATION
        query = """
            WITH click_point AS (
                SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326) AS geom
            ),
            nearby_places AS (
                SELECT 
                    p.id,
                    p.name,
                    p.type,
                    p.address,
                    p.nearest_vertex_id,
                    ST_X(ST_GeometryN(p.geom, 1)) AS lon,
                    ST_Y(ST_GeometryN(p.geom, 1)) AS lat,
                    ST_Distance(
                        p.geom::geography, 
                        (SELECT geom FROM click_point)::geography
                    ) / 1000.0 AS crow_distance_km
                FROM topology.places p, click_point cp
                WHERE p.type = %s
                  AND p.nearest_vertex_id IS NOT NULL
                  AND ST_DWithin(
                      p.geom::geography,
                      cp.geom::geography,
                      %s * 1000  -- Convert km to meters for ST_DWithin
                  )
                ORDER BY p.geom <-> cp.geom
                LIMIT %s  -- Limit initial candidates to 2x the requested limit
            )
            SELECT 
                np.id,
                np.name,
                np.type,
                np.address,
                np.crow_distance_km,
                np.nearest_vertex_id,
                round(d.agg_cost::numeric, 1) AS travel_seconds,
                round((d.agg_cost / 60.0)::numeric, 1) AS travel_minutes,
                np.lon AS facility_lon,
                np.lat AS facility_lat
            FROM nearby_places np
            CROSS JOIN LATERAL (
                SELECT agg_cost
                FROM pgr_dijkstraCost(
                    'SELECT id, source, target, cost, reverse_cost 
                     FROM topology.ways 
                     WHERE cost > 0',
                    %s,
                    np.nearest_vertex_id,
                    directed => true
                )
            ) d
            WHERE d.agg_cost IS NOT NULL
        """

        params = [lon, lat, facility_type, max_distance_km, limit * 2, click_vertex_id]

        if max_minutes:
            max_seconds = max_minutes * 60
            query += " AND d.agg_cost <= %s"
            params.append(max_seconds)

        query += " ORDER BY d.agg_cost LIMIT %s"
        params.append(limit)

        # Execute query
        cur.execute(query, params)
        results = cur.fetchall()

        if not results:
            cur.close()
            conn.close()
            return jsonify({
                "message": f"No {facility_type} found within {max_distance_km}km radius",
                "incident": {"lon": lon, "lat": lat},
                "type": facility_type,
                "search_radius_km": max_distance_km,
                "count": 0,
                "facilities": []
            }), 200

        # Get route geometries if requested
        facilities_with_routes = []
        for facility in results:
            facility_dict = dict(facility)
            
            if include_routes:
                # Get actual route geometry
                cur.execute("""
                    WITH route_path AS (
                        SELECT seq, edge
                        FROM pgr_dijkstra(
                            'SELECT id, source, target, cost, reverse_cost 
                             FROM topology.ways 
                             WHERE cost > 0',
                            %s, %s, directed => true
                        )
                        WHERE edge != -1
                        ORDER BY seq
                    )
                    SELECT json_agg(
                        json_build_object(
                            'type', 'Feature',
                            'geometry', ST_AsGeoJSON(w.geom)::json,
                            'properties', json_build_object('segment', rp.seq)
                        )
                        ORDER BY rp.seq
                    ) AS route_geojson
                    FROM route_path rp
                    JOIN topology.ways w ON rp.edge = w.id
                """, (click_vertex_id, facility['nearest_vertex_id']))
                
                route_result = cur.fetchone()
                if route_result and route_result['route_geojson']:
                    facility_dict['route'] = {
                        "type": "FeatureCollection",
                        "features": route_result['route_geojson']
                    }
            
            facilities_with_routes.append(facility_dict)

        cur.close()
        conn.close()

        return jsonify({
            "incident": {"lon": lon, "lat": lat},
            "type": facility_type,
            "search_radius_km": max_distance_km,
            "count": len(facilities_with_routes),
            "facilities": facilities_with_routes
        })

    except Exception as e:
        # Log the full error for debugging
        import traceback
        print("=" * 80)
        print("NEAREST FACILITY ERROR:")
        print(traceback.format_exc())
        print("=" * 80)
        
        return jsonify({
            "error": str(e),
            "type": type(e).__name__
        }), 500
    
@app.route('/api/test_facility', methods=['GET'])
def test_facility():
    """Test endpoint to verify database connection and data"""
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Test 1: Check if places table exists and has data
        cur.execute("""
            SELECT 
                type, 
                COUNT(*) as count,
                COUNT(nearest_vertex_id) as with_vertex
            FROM topology.places 
            GROUP BY type
        """)
        place_stats = cur.fetchall()
        
        # Test 2: Check vertices table
        cur.execute("SELECT COUNT(*) as count FROM topology.vertices")
        vertex_count = cur.fetchone()
        
        # Test 3: Check ways table
        cur.execute("SELECT COUNT(*) as count FROM topology.ways WHERE cost > 0")
        ways_count = cur.fetchone()
        
        cur.close()
        conn.close()
        
        return jsonify({
            "status": "ok",
            "places_by_type": place_stats,
            "vertices_count": vertex_count['count'],
            "ways_count": ways_count['count']
        })
        
    except Exception as e:
        import traceback
        return jsonify({
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)

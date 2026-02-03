# app.py — IMPROVED VERSION with Distance Limitation, separate A-B and TSP endpoints
from flask import Flask, request, jsonify
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2 import pool
import os
import json
from flask_cors import CORS
import logging

app = Flask(__name__)
CORS(app)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Database connection pool
connection_pool = None

def init_connection_pool():
    global connection_pool
    try:
        connection_pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=2,
            maxconn=20,
            host=os.getenv("POSTGRES_HOST", "postgis"),
            database=os.getenv("POSTGRES_DB", "geodb"),
            user=os.getenv("POSTGRES_USER", "le"),
            password=os.getenv("POSTGRES_PASSWORD", "123456"),
            port=5432,
            connect_timeout=10,
            # IMPORTANT: PostgreSQL options to force index usage
            options="-c random_page_cost=1.1 -c effective_cache_size=2GB"
        )
        logger.info("Database connection pool created successfully")
    except Exception as e:
        logger.error(f"Failed to create connection pool: {e}")
        connection_pool = None

# Initialize pool on startup
init_connection_pool()

# Database connection with connection pooling
def get_db_connection():
    if connection_pool:
        try:
            return connection_pool.getconn()
        except Exception as e:
            logger.error(f"Failed to get connection from pool: {e}")
            # Fallback to direct connection
            pass
    
    # Direct connection fallback
    return psycopg2.connect(
        host=os.getenv("POSTGRES_HOST", "postgis"),
        database=os.getenv("POSTGRES_DB", "geodb"),
        user=os.getenv("POSTGRES_USER", "le"),
        password=os.getenv("POSTGRES_PASSWORD", "123456"),
        port=5432,
        connect_timeout=10,
        # IMPORTANT: PostgreSQL options to force index usage
        options="-c random_page_cost=1.1 -c effective_cache_size=2GB"
    )

def return_connection(conn):
    """Return connection to pool"""
    if connection_pool:
        try:
            connection_pool.putconn(conn)
        except Exception as e:
            logger.error(f"Failed to return connection to pool: {e}")
            try:
                conn.close()
            except:
                pass
    else:
        try:
            conn.close()
        except:
            pass

@app.route('/health', methods=['GET'])
def health():
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT 1")
        cur.close()
        return_connection(conn)
        return jsonify({"status": "healthy", "db": "connected"}), 200
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return jsonify({"status": "unhealthy", "error": str(e)}), 500

@app.route('/route', methods=['GET'])
def get_route():
    """
    Simple A-to-B routing with optional alternative routes
    
    GET: ?start_lon=&start_lat=&end_lon=&end_lat=
         &alternatives=3 (optional, default 1)
         &optimization=fastest|shortest (optional, default fastest)
    """
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)       

        # Set aggressive timeout for Kubernetes (20 seconds max)
        cur.execute("SET statement_timeout = '20s'")
        
        start_lon = float(request.args.get('start_lon'))
        start_lat = float(request.args.get('start_lat'))
        end_lon = float(request.args.get('end_lon'))
        end_lat = float(request.args.get('end_lat'))
        alternatives = int(request.args.get('alternatives', 1))
        optimization = request.args.get('optimization', 'fastest')

        if None in (start_lon, start_lat, end_lon, end_lat):
            return jsonify({"error": "Missing coordinates"}), 400

        # Limit alternatives to reasonable number
        alternatives = min(max(alternatives, 1), 3)
        logger.info(f"Route request: alternatives={alternatives}, optimization={optimization}")

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

        # Determine cost column based on optimization
        if optimization == 'shortest':
            cost_column = 'length_m'
            reverse_cost_column = 'length_m'
        else:  # fastest (default)
            cost_column = 'cost'
            reverse_cost_column = 'reverse_cost'

        # Calculate multiple alternative routes
        routes = []
        used_edges_set = set()
        
        for attempt in range(alternatives):
            # Build exclusion clause for previously used edges
            if used_edges_set and attempt > 0:
                exclusion_list = ','.join(map(str, used_edges_set))
                # Limit excluded edges to prevent query from being too complex
                if len(used_edges_set) > 100:
                    # Take only the most recent 100 edges
                    recent_edges = list(used_edges_set)[-100:]
                    exclusion_list = ','.join(map(str, recent_edges))
                edge_filter = f"AND id NOT IN ({exclusion_list})"
            else:
                edge_filter = ""
            
            # Run routing with edge exclusions for alternatives
            cur.execute(f"""
                SELECT seq, node, edge, cost, agg_cost
                FROM pgr_dijkstra(
                    'SELECT id, source, target, 
                            {cost_column} as cost, 
                            {reverse_cost_column} as reverse_cost 
                     FROM topology.ways 
                     WHERE cost > 0 {edge_filter}',
                    %s, %s, directed => true
                )
                ORDER BY seq;
            """, (start_vid, end_vid))

            path = cur.fetchall()

            if not path or path[-1]['node'] != end_vid:
                logger.warning(f"No alternative route found at attempt {attempt}")
                break

            edge_ids = [row['edge'] for row in path if row['edge'] != -1]
            
            # Add edges to exclusion set
            if edge_ids:
                edges_to_exclude = set(edge_ids[::3])  # Exclude every 3rd edge for more variation
                used_edges_set.update(edges_to_exclude)

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

            total_distance = sum(seg['length_m'] for seg in segments) if segments else 0
            
            # Always use actual travel time from ways table
            if edge_ids:
                cur.execute("""
                    SELECT SUM(cost) as total_time_seconds
                    FROM topology.ways
                    WHERE id = ANY(%s);
                """, (edge_ids,))
                time_result = cur.fetchone()
                total_time_seconds = time_result['total_time_seconds'] if time_result else 0
            else:
                total_time_seconds = 0

            routes.append({
                "type": "FeatureCollection",
                "features": features,
                "total_distance_km": round(total_distance / 1000, 2),
                "duration_minutes": round(total_time_seconds / 60, 1),
                "segment_count": len(features),
                "start_vertex": int(start_vid),
                "end_vertex": int(end_vid),
                "optimization": optimization,
                "alternative_rank": attempt + 1
            })

        cur.close()
        return_connection(conn)

        if not routes:
            return jsonify({"error": "No route found"}), 404

        if alternatives > 1:
            return jsonify({
                "routes": routes,
                "optimization": optimization,
                "count": len(routes)
            })
        else:
            return jsonify(routes[0])

    except Exception as e:
        if conn:
            return_connection(conn)
        logger.error(f"Route error: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@app.route('/route/tsp', methods=['POST'])
def get_tsp_route():
    """
    TSP routing - separate endpoint
    POST: Body: {"points": [[lon, lat], [lon, lat], ...]}
    """
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)

        # Set aggressive timeout for TSP (40 seconds max)
        cur.execute("SET statement_timeout = '40s'")
        
        data = request.get_json()
        points = data.get('points', [])
        
        if not points or len(points) < 2:
            return jsonify({"error": "Need at least 2 points for TSP"}), 400

        #  Limit TSP points
        if len(points) > 8:
            return jsonify({
                "error": "Too many points for TSP. Maximum 8 points allowed in current environment.",
                "points_provided": len(points)
            }), 400
        
        logger.info(f"TSP request with {len(points)} points")
         
        # Snap all points to vertices
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

        # Build cost matrix
        cur.execute("DROP TABLE IF EXISTS temp_cost_matrix;")
        cur.execute("""
            CREATE TEMP TABLE temp_cost_matrix (
                start_vid INTEGER,
                end_vid INTEGER,
                agg_cost FLOAT
            );
        """)

        for i, start_v in enumerate(vertex_ids):
            for j, end_v in enumerate(vertex_ids):
                if i != j:
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

        # Solve TSP
        cur.execute("""
            SELECT seq, node, cost, agg_cost
            FROM pgr_TSP(
                'SELECT start_vid, end_vid, agg_cost FROM temp_cost_matrix'
            )
            ORDER BY seq;
        """)

        tsp_path = cur.fetchall()
        if not tsp_path:
            return jsonify({"error": "Could not solve TSP"}), 404

        # Get route segments
        all_edges = []
        waypoint_order = []
        
        for i in range(len(tsp_path) - 1):
            start_v = tsp_path[i]['node']
            end_v = tsp_path[i + 1]['node']
            waypoint_order.append(vertex_ids.index(start_v))

            cur.execute("""
                SELECT edge FROM pgr_dijkstra(
                    'SELECT id, source, target, cost, reverse_cost 
                     FROM topology.ways WHERE cost > 0',
                    %s, %s, directed => true
                )
                WHERE edge != -1
                ORDER BY seq;
            """, (start_v, end_v))

            all_edges.extend([e['edge'] for e in cur.fetchall()])

        waypoint_order.append(vertex_ids.index(tsp_path[-1]['node']))

        # Get geometries
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
                "properties": {"id": seg['id'], "length_m": round(seg['length_m'], 2)}
            })

        total_cost = tsp_path[-1]['agg_cost'] if tsp_path else 0
        total_distance = sum(seg['length_m'] for seg in segments) if segments else 0

        cur.close()
        return_connection(conn)

        return jsonify({
            "type": "FeatureCollection",
            "features": features,
            "total_distance_km": round(total_distance / 1000, 2),
            "duration_minutes": round(total_cost / 60, 1),
            "segment_count": len(features),
            "waypoint_count": len(points),
            "waypoint_order": waypoint_order,
            "optimization": "TSP"
        })

    except Exception as e:
        if conn:
            return_connection(conn)
        logger.error(f"TSP error: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@app.route('/service_area', methods=['GET'])
def service_area():
    """Service area analysis"""
    conn = None
    try:
        lon = float(request.args.get("lon"))
        lat = float(request.args.get("lat"))
        minutes = float(request.args.get("minutes", 5))

        if minutes < 1 or minutes > 20:  # Reduced from 30 to 20
            return jsonify({"error": "Minutes must be between 1 and 20"}), 400

        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
                
        # Set timeout
        cur.execute("SET statement_timeout = '30s'")
        
        logger.info(f"Service area request: {minutes} minutes")

        cur.execute("""
            WITH p AS (
                SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geometry AS geom
            )
            SELECT id, ST_Distance(geom, (SELECT geom FROM p)) AS dist
            FROM topology.vertices
            ORDER BY geom <-> (SELECT geom FROM p)
            LIMIT 1;
        """, (lon, lat))

        v = cur.fetchone()
        if not v or v["dist"] > 0.1:
            return_connection(conn)
            return jsonify({"error": "Service point too far from road network"}), 404

        cur.execute("""
            WITH reach AS (
                SELECT node, edge, cost, agg_cost
                FROM pgr_drivingDistance(
                    'SELECT id, source, target, cost, reverse_cost 
                     FROM topology.ways WHERE cost > 0',
                    %s, %s * 60, directed := false
                )
            ),
            edges AS (
                SELECT w.id, w.geom
                FROM topology.ways w
                JOIN reach r ON w.id = r.edge
            )
            SELECT
                ST_AsGeoJSON(ST_Union(geom)) AS geom_union,
                ST_AsGeoJSON(ST_ConcaveHull(ST_Collect(geom), 0.90, true)) AS hull,
                COUNT(*) as edge_count
            FROM edges;
        """, (v["id"], minutes))

        result = cur.fetchone()
        cur.close()
        return_connection(conn)

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
        if conn:
            return_connection(conn)
        logger.error(f"Service area error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/nearest_facility', methods=['GET'])
def nearest_facility():
    """Find nearest facilities with distance limitation"""
    conn = None
    try:
        lon = request.args.get('lon')
        lat = request.args.get('lat')
        facility_type = request.args.get('type', 'hospital').lower()
        limit = request.args.get('limit', 5, type=int)
        max_distance_km = request.args.get('max_distance_km', 5.0, type=float)
        include_routes = request.args.get('routes', 'true').lower() == 'true'

        if not lon or not lat:
            return jsonify({"error": "Missing lon or lat parameter"}), 400

        lon = float(lon)
        lat = float(lat)

        # OPTIMIZATION: Stricter limits
        if max_distance_km < 1 or max_distance_km > 15:  # Reduced from 50 to 15
            return jsonify({"error": "max_distance_km must be between 1 and 15"}), 400
        
        if limit > 5:  # Enforce max 5 facilities
            limit = 5

        allowed_types = ['hospital', 'fire station', 'police', 'clinic']
        if facility_type not in allowed_types:
            return jsonify({"error": f"Unsupported facility type"}), 400

        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Set aggressive timeout (30 seconds)
        cur.execute("SET statement_timeout = '30s'")
        
        logger.info(f"Facility search: type={facility_type}, limit={limit}, radius={max_distance_km}km")

        cur.execute("""
            SELECT id FROM topology.vertices 
            ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
            LIMIT 1
        """, (lon, lat))
        
        click_vertex = cur.fetchone()
        if not click_vertex:
            return_connection(conn)
            return jsonify({"error": "Could not snap to road network"}), 404
        
        click_vertex_id = click_vertex['id']

        return_connection(conn)
        query = """
            WITH click_point AS (
                SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326) AS geom
            ),
            nearby_places AS (
                SELECT 
                    p.id, p.name, p.type, p.address, p.nearest_vertex_id,
                    ST_X(ST_GeometryN(p.geom, 1)) AS lon,
                    ST_Y(ST_GeometryN(p.geom, 1)) AS lat,
                    ST_Distance(p.geom::geography, (SELECT geom FROM click_point)::geography) / 1000.0 AS crow_distance_km
                FROM topology.places p, click_point cp
                WHERE p.type = %s
                  AND p.nearest_vertex_id IS NOT NULL
                  AND ST_DWithin(p.geom::geography, cp.geom::geography, %s * 1000)
                ORDER BY p.geom <-> cp.geom
                LIMIT 10
            )
            SELECT 
                np.id, np.name, np.type, np.address, np.crow_distance_km, np.nearest_vertex_id,
                round(d.agg_cost::numeric, 1) AS travel_seconds,
                round((d.agg_cost / 60.0)::numeric, 1) AS travel_minutes,
                np.lon AS facility_lon, np.lat AS facility_lat
            FROM nearby_places np
            CROSS JOIN LATERAL (
                SELECT agg_cost
                FROM pgr_dijkstraCost(
                    'SELECT id, source, target, cost, reverse_cost FROM topology.ways WHERE cost > 0',
                    %s, np.nearest_vertex_id, directed => true
                )
            ) d
            WHERE d.agg_cost IS NOT NULL
            ORDER BY d.agg_cost LIMIT %s
        """

        cur.execute(query, [lon, lat, facility_type, max_distance_km, click_vertex_id, limit])
        results = cur.fetchall()

        if not results:
            return_connection(conn)
            return jsonify({
                "message": f"No {facility_type} found within {max_distance_km}km radius",
                "count": 0,
                "facilities": []
            }), 200

        facilities_with_routes = []
        for facility in results:
            facility_dict = dict(facility)
            
            if include_routes:
                cur.execute("""
                    WITH route_path AS (
                        SELECT seq, edge FROM pgr_dijkstra(
                            'SELECT id, source, target, cost, reverse_cost FROM topology.ways WHERE cost > 0',
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
        return_connection(conn)

        return jsonify({
            "incident": {"lon": lon, "lat": lat},
            "type": facility_type,
            "search_radius_km": max_distance_km,
            "count": len(facilities_with_routes),
            "facilities": facilities_with_routes
        })

    except Exception as e:
        if conn:
            return_connection(conn)
        logger.error(f"Nearest facility error: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
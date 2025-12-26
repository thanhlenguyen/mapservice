# app.py — Complete Route + TSP + Crime Escape Analysis
from flask import Flask, request, jsonify
import psycopg2
from psycopg2.extras import RealDictCursor
import os
import json
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

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
        # POST method - TSP routing
        if request.method == 'POST':
            data = request.get_json()
            points = data.get('points', [])
            
            if not points or len(points) < 2:
                return jsonify({"error": "Need at least 2 points for TSP"}), 400
            
            return solve_tsp(points)
        
        # GET method - simple A to B routing
        start_lon = float(request.args.get('start_lon'))
        start_lat = float(request.args.get('start_lat'))
        end_lon = float(request.args.get('end_lon'))
        end_lat = float(request.args.get('end_lat'))

        if None in (start_lon, start_lat, end_lon, end_lat):
            return jsonify({"error": "Missing coordinates"}), 400

        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)

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

def solve_tsp(points):
    """
    Solve Traveling Salesman Problem using pgr_TSP
    """
    conn = None
    cur = None
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
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
        cur.execute("DROP TABLE IF EXISTS temp_cost_matrix;")
        cur.execute("""
            CREATE TEMP TABLE temp_cost_matrix (
                source BIGINT,
                target BIGINT,
                cost FLOAT
            );
        """)

        # Calculate costs between all pairs
        for start_v in vertex_ids:
            for end_v in vertex_ids:
                if start_v != end_v:
                    cur.execute("""
                        INSERT INTO temp_cost_matrix (source, target, cost)
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

        # 3. Solve TSP - Open tour (no return to start)
        # We'll use pgr_dijkstraCost to build matrix and solve manually
        # Or use pgr_TSP with end_id specified
        
        # Build distance matrix
        cur.execute("""
            SELECT start_vid AS source, end_vid AS target, agg_cost AS cost
            FROM pgr_dijkstraCostMatrix(
                'SELECT id, source, target, cost, reverse_cost 
                 FROM topology.ways WHERE cost > 0',
                ARRAY[%s],
                directed := true
            );
        """, (vertex_ids,))
        
        cost_matrix = cur.fetchall()
        
        if not cost_matrix:
            return jsonify({"error": "Could not build cost matrix"}), 404

        # Use greedy nearest neighbor for open TSP
        visited = [0]  # Start with first point
        current = vertex_ids[0]
        
        while len(visited) < len(vertex_ids):
            # Find nearest unvisited point
            min_cost = float('inf')
            next_idx = None
            
            for i, vid in enumerate(vertex_ids):
                if i not in visited:
                    # Get cost from current to this point
                    cur.execute("""
                        SELECT agg_cost FROM temp_cost_matrix
                        WHERE source = %s AND target = %s;
                    """, (current, vid))
                    result = cur.fetchone()
                    if result and result['agg_cost'] < min_cost:
                        min_cost = result['agg_cost']
                        next_idx = i
            
            if next_idx is not None:
                visited.append(next_idx)
                current = vertex_ids[next_idx]
            else:
                break

        waypoint_order = visited

        # 4. Get detailed route for each segment following the optimal order
        all_edges = []
        segment_info = []

        for i in range(len(waypoint_order) - 1):
            start_idx = waypoint_order[i]
            end_idx = waypoint_order[i + 1]
            start_v = vertex_ids[start_idx]
            end_v = vertex_ids[end_idx]

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
                "from_point": start_idx + 1,
                "to_point": end_idx + 1,
                "cost_seconds": round(segment_cost, 1)
            })

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

        # Calculate totals
        total_cost = sum(info['cost_seconds'] for info in segment_info)
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
            "waypoint_order": [x + 1 for x in waypoint_order],
            "segment_info": segment_info,
            "optimization": "TSP (Open Tour - No Return)"
        })

    except Exception as e:
if conn:
            conn.rollback()
        if cur:
            cur.close()
        if conn:
            conn.close()
        return jsonify({"error": str(e)}), 500

@app.route('/route_hull', methods=['GET'])
def get_route_with_concave_hull():
    """
    Route with concave hull (area of interest)
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

        # Find nearest vertices
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
            return jsonify({"error": "Points too far from road network"}), 404

        if not start_vid or not end_vid:
            return jsonify({"error": "Cannot snap to network"}), 404

        # Single query for route + hull
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

@app.route('/escape_area', methods=['GET'])
def escape_area():
    """
    Crime escape analysis - reachable road network from a crime location
    """
    try:
        lon = float(request.args.get("lon"))
        lat = float(request.args.get("lat"))
        minutes = float(request.args.get("minutes", 5))

        if minutes < 1 or minutes > 30:
            return jsonify({"error": "Minutes must be between 1 and 30"}), 400

        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)

        # Snap crime location to nearest vertex
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
                "error": "Crime point too far from road network",
                "distance_deg": round(v["dist"], 4)
            }), 404

        # Run driving-distance
        cur.execute("""
            WITH reach AS (
                SELECT node, edge, cost, agg_cost
                FROM pgr_drivingDistance(
                    'SELECT id, source, target, cost, reverse_cost 
                     FROM topology.ways 
                     WHERE cost > 0',
                    %s,
                    %s * 60,
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
            "crime_point": {"lon": lon, "lat": lat},
            "time_minutes": minutes,
            "reachable_network": json.loads(result["geom_union"]),
            "escape_area": json.loads(result["hull"]),
            "edge_count": result["edge_count"]
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
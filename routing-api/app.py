# app.py — FIXED VERSION
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

@app.route('/route', methods=['GET'])
def get_route():
    try:
        start_lon = float(request.args.get('start_lon'))
        start_lat = float(request.args.get('start_lat'))
        end_lon = float(request.args.get('end_lon'))
        end_lat = float(request.args.get('end_lat'))

        if None in (start_lon, start_lat, end_lon, end_lat):
            return jsonify({"error": "Missing coordinates"}), 400

        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)

        # 1. Find nearest start and end vertices
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
        start_distance = nodes['start_distance']
        end_distance = nodes['end_distance']

        # Check if points are too far from network (>0.1 degrees ≈ 11km)
        if start_distance > 0.1 or end_distance > 0.1:
            return jsonify({
                "error": "Points too far from road network",
                "start_distance_deg": round(start_distance, 4),
                "end_distance_deg": round(end_distance, 4),
                "hint": "Your coordinates may be outside the loaded map area"
            }), 404

        if not start_vid or not end_vid:
            return jsonify({"error": "Could not snap to network"}), 404

        # 2. Run pgr_dijkstra
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

        # 3. Extract edge IDs
        edge_ids = [row['edge'] for row in path if row['edge'] != -1]

        # 4. Fetch geometry
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

        # 5. Build response - FIX: Parse GeoJSON string
        features = []
        for seg in segments:
            features.append({
                "type": "Feature",
                "geometry": json.loads(seg['geojson']),  # ← FIXED: Parse JSON string
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
            "total_distance_km": round(total_distance / 1000, 3),
            "duration_minutes": round(total_cost / 60, 1),
            "segment_count": len(features),
            "start_vertex": int(start_vid),
            "end_vertex": int(end_vid)
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
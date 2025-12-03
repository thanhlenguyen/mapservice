from flask import Flask, request, jsonify
import psycopg2
import os
import json

app = Flask(__name__)

def get_conn():
    return psycopg2.connect(
        host="postgis",
        database=os.getenv("POSTGRES_DB"),
        user=os.getenv("POSTGRES_USER"),
        password=os.getenv("POSTGRES_PASSWORD")
    )

@app.route('/route')
def route():
    try:
        slon = float(request.args['start_lon'])
        slat = float(request.args['start_lat'])
        elon = float(request.args['end_lon'])
        elat = float(request.args['end_lat'])

        conn = get_conn()
        cur = conn.cursor()

        # First, find nearest nodes with detailed logging
        cur.execute("""
            WITH pts AS (
                SELECT ST_SetSRID(ST_MakePoint(%s,%s),4326) AS start_pt,
                       ST_SetSRID(ST_MakePoint(%s,%s),4326) AS end_pt
            ),
            start_edge AS (
                SELECT source as node, 
                       ST_Distance(geom, (SELECT start_pt FROM pts)) as dist
                FROM topology.ways
                WHERE source IS NOT NULL
                ORDER BY geom <-> (SELECT start_pt FROM pts)
                LIMIT 1
            ),
            end_edge AS (
                SELECT target as node,
                       ST_Distance(geom, (SELECT end_pt FROM pts)) as dist
                FROM topology.ways
                WHERE target IS NOT NULL
                ORDER BY geom <-> (SELECT end_pt FROM pts)
                LIMIT 1
            )
            SELECT 
                (SELECT node FROM start_edge) as start_node,
                (SELECT node FROM end_edge) as end_node,
                (SELECT dist FROM start_edge) as start_dist,
                (SELECT dist FROM end_edge) as end_dist
        """, (slon, slat, elon, elat))
        
        node_info = cur.fetchone()
        if not node_info or node_info[0] is None or node_info[1] is None:
            return jsonify({
                "error": "Could not find nearby roads. Check if coordinates are within map bounds.",
                "type": "FeatureCollection",
                "features": [],
                "duration_minutes": 0
            }), 404

        start_node, end_node, start_dist, end_dist = node_info
        
        print(f"DEBUG: Start node: {start_node}, End node: {end_node}")
        print(f"DEBUG: Start distance: {start_dist:.6f}, End distance: {end_dist:.6f}")

        if start_node == end_node:
            return jsonify({
                "error": "Start and end points are on the same road segment",
                "type": "FeatureCollection",
                "features": [],
                "duration_minutes": 0
            })

        # Try pgr_dijkstra first (more reliable than A*)
        cur.execute("""
            SELECT 
                seq,
                node,
                edge,
                cost,
                agg_cost
            FROM pgr_dijkstra(
                'SELECT gid AS id,
                        source,
                        target,
                        cost_sec AS cost,
                        reverse_cost_sec AS reverse_cost
                 FROM topology.ways
                 WHERE cost_sec > 0',
                %s,
                %s,
                directed => true
            )
            WHERE edge > 0
            ORDER BY seq
        """, (start_node, end_node))

        route_segments = cur.fetchall()
        
        if not route_segments:
            return jsonify({
                "error": f"No route found between nodes {start_node} and {end_node}. Roads may not be connected.",
                "type": "FeatureCollection",
                "features": [],
                "duration_minutes": 0,
                "debug": {
                    "start_node": start_node,
                    "end_node": end_node,
                    "start_dist_deg": float(start_dist),
                    "end_dist_deg": float(end_dist)
                }
            })

        # Get geometries for the route
        edge_ids = [seg[2] for seg in route_segments]
        total_cost = route_segments[-1][4] if route_segments else 0  # agg_cost from last segment

        cur.execute("""
            SELECT 
                gid,
                ST_AsGeoJSON(geom) AS geojson,
                length_m
            FROM topology.ways
            WHERE gid = ANY(%s)
            ORDER BY array_position(%s, gid)
        """, (edge_ids, edge_ids))

        features = []
        total_distance = 0
        
        for gid, geojson, length_m in cur.fetchall():
            if geojson:
                features.append({
                    "type": "Feature",
                    "geometry": json.loads(geojson),
                    "properties": {
                        "gid": gid,
                        "distance": length_m
                    }
                })
                if length_m:
                    total_distance += length_m

        cur.close()
        conn.close()

        return jsonify({
            "type": "FeatureCollection",
            "features": features,
            "duration_minutes": round(total_cost / 60, 1) if total_cost else 0,
            "total_distance_km": round(total_distance / 1000, 1),
            "segment_count": len(features)
        })

    except Exception as e:
        import traceback
        error_detail = traceback.format_exc()
        print(f"ERROR: {error_detail}")
        return jsonify({
            "error": str(e),
            "detail": error_detail,
            "type": "FeatureCollection",
            "features": [],
            "duration_minutes": 0
        }), 500

@app.route('/health')
def health():
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM topology.ways")
        count = cur.fetchone()[0]
        cur.close()
        conn.close()
        return jsonify({"status": "ok", "roads_count": count})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
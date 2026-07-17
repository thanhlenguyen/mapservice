# Indoor Navigation
## Define workflow
```
                    Web / Android / iOS
                           │
                     MapLibre GL JS
                           │
                 Floor selector + UI
                           │
              FastAPI Indoor Navigation API
                           │
      ┌────────────────────┼───────────────────┐
      │                    │                   │
  pgRouting           Elasticsearch      Positioning
      │                    │             (BLE/UWB/Wi-Fi)
      └──────────────PostGIS─────────────┘
                           │
                  PMTiles / Vector Tiles
```

## Architecture for Indoor Navigation with PgRouting
### 1. Positioning System (input layer)

- BLE Beacons: Low-cost, ~3m accuracy.

- Wi-Fi RTT: Better accuracy on modern devices.

- UWB: Sub-meter precision, but hardware-heavy.

- Visual SLAM: Uses cameras for AR-based positioning.

  → These systems provide real-time coordinates (x, y, floor).

### 2. Mapping & Graph Modeling (PostGIS + PgRouting)

- Store building floor plans in PostGIS (rooms, corridors, stairs, elevators).

- Build a graph topology with pgr_createTopology.

- Each edge has weights (distance, accessibility, time).

### 3. Integration Layer

- Positioning system outputs user coordinates.

- Map coordinates to the nearest graph node in PgRouting.

- Run pgr_dijkstra or pgr_astar to compute path to destination.

### 4. Visualization Layer

- Use Leaflet or MapLibre to render maps.

- Overlay user position and route dynamically.

## Data Preparation
1. Import data to schema using `ogr2ogr`
```bash
apt-get update && apt-get install -y gdal-bin

ogr2ogr \
  -f PostgreSQL \  # Output format
  -overwrite \ 
  -nln topology.ways_raw \  # New Layer name
  -nlt PROMOTE_TO_MULTI \  # New layer type
  -lco GEOMETRY_NAME=geom \  # Layer create option 
  PG:"host=localhost dbname=$POSTGRES_DB user=$POSTGRES_USER password=$POSTGRES_PASSWORD" \  # Destination
  /path/to/data/file  # Source 


ogr2ogr -f PostgreSQL PG:"host=localhost dbname=$POSTGRES_DB user=$POSTGRES_USER password=$POSTGRES_PASSWORD" \ # Destination
  /data/Units.geojson \  # Source
  -nln indoor.units_raw \  # New Layer name
  -lco GEOMETRY_NAME=geom \   # Layer create option
  -lco FID=gid \              # Layer create option
  -lco LAUNDER=YES \        # Layer create option (lower case for field name)
  -t_srs EPSG:4326 \
  -nlt MULTIPOLYGON \  # New layer type
  -overwrite
'

# Specific case - Import Unit.geojson to topology.indoor_units
ogr2ogr -f PostgreSQL PG:"host=localhost user=le password=123456 dbname=geodb" -nlt PROMOTE_TO_MULTI -overwrite -lco GEOMETRY_NAME=geom -lco FID=id -lco LAUNDER=YES -t_srs EPSG:4326 -progress \
-nln indoor.units_raw  /mnt/d/Git/tiledgraph/data/Units.geojson  
```

After import, run these SQL commands (via pgAdmin or psql):
```sql
-- Populate derived columns
ALTER TABLE topology.indoor_units 
ADD COLUMN IF NOT EXISTS properties JSONB

UPDATE topology.indoor_units 
SET properties = jsonb_build_object(
    'UNIT_ID', unit_id,           -- adjust column names to match your table
    'USE_TYPE', use_type,
    'FloorID', floorid,
    'HEIGHT', height,
    'Base', base,
    'NAME', name,
    -- add more fields as needed
    'UnitAddres', unitaddres
);

ALTER TABLE topology.indoor_units 
ADD COLUMN IF NOT EXISTS floor INT,
ADD COLUMN IF NOT EXISTS centroid GEOMETRY(Point, 4326);

-- Populate floor and centroid
UPDATE topology.indoor_units 
SET floor = (properties->>'FloorID')::int,
    centroid = ST_Centroid(geom)
WHERE properties IS NOT NULL 
  AND properties->>'FloorID' IS NOT NULL;

-- Verify
SELECT UNIT_ID, floor, properties->>'USE_TYPE' as use_type, ST_AsText(centroid) 
FROM topology.indoor_units 
LIMIT 10;
```
2. Build Indoor Routing Graph (Nodes + Edges)
Indoor routing needs its own network topology (nodes = doors/staircases, edges = walkable paths inside units/corridors).
```sql

-- 1. Nodes = unit centroids
DROP TABLE IF EXISTS topology.indoor_nodes;
CREATE TABLE topology.indoor_nodes AS
SELECT 
  row_number() OVER () AS node_id,
  UNIT_ID,
  (properties->>'FloorID')::int AS floor,
  properties->>'USE_TYPE' AS use_type,
  centroid AS geom
FROM topology.indoor_units;

CREATE INDEX idx_indoor_nodes_geom ON topology.indoor_nodes USING GIST(geom);

-- 2. Horizontal edges (adjacent units on same floor)
DROP TABLE IF EXISTS topology.indoor_edges;
CREATE TABLE topology.indoor_edges AS
WITH pairs AS (
  SELECT 
    a.node_id AS source,
    b.node_id AS target,
    ST_Distance(a.geom::geography, b.geom::geography) AS cost_m,
    a.floor
  FROM topology.indoor_nodes a
  JOIN topology.indoor_nodes b ON a.floor = b.floor AND a.node_id < b.node_id
  WHERE ST_DWithin(a.geom, b.geom, 0.00015)  -- ~16 meters tolerance
)
SELECT 
  row_number() OVER () AS edge_id,
  source, 
  target, 
  cost_m AS cost,
  cost_m AS reverse_cost,
  floor,
  ST_MakeLine(
    (SELECT geom FROM indoor_nodes n WHERE n.node_id = source),
    (SELECT geom FROM indoor_nodes n WHERE n.node_id = target)
  ) AS geom
FROM pairs;

-- 3. Vertical connections (Stairs / Elevators)
INSERT INTO indoor_edges (source, target, cost, reverse_cost, floor, geom)
SELECT DISTINCT 
  s.node_id, 
  t.node_id, 
  25 AS cost,           -- ~25m penalty for changing floors
  25 AS reverse_cost,
  s.floor,
  ST_MakeLine(s.geom, t.geom)
FROM indoor_nodes s
JOIN indoor_nodes t ON s.floor != t.floor 
                   AND ST_DWithin(s.geom, t.geom, 0.001)
WHERE (s.use_type ILIKE '%stair%' OR s.use_type ILIKE '%elevator%' 
    OR t.use_type ILIKE '%stair%' OR t.use_type ILIKE '%elevator%');

-- 4. Create pgRouting topology
SELECT pgr_createTopology('indoor_edges', 0.00001, 'geom', 'edge_id', 'source', 'target', clean := true);

```
3. Extend FastAPI (app.py) with Indoor Endpoints
Add these new endpoints:
```Python
# /indoor/route
@app.get("/indoor/route")
def indoor_route(start_unit: str, end_unit: str):
    try:
        with db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            
            # Get node IDs
            cur.execute("""
                SELECT node_id FROM indoor_nodes 
                WHERE UNIT_ID IN (%s, %s) 
                ORDER BY UNIT_ID = %s
            """, (start_unit, end_unit, start_unit))
            nodes = cur.fetchall()
            if len(nodes) < 2:
                raise HTTPException(404, "One or both units not found")
            
            start_id, end_id = nodes[0]["node_id"], nodes[1]["node_id"]
            
            # Dijkstra
            cur.execute("""
                SELECT 
                    p.seq, p.node, p.edge, p.agg_cost,
                    ST_AsGeoJSON(e.geom) AS geojson,
                    e.floor
                FROM pgr_dijkstra(
                    'SELECT edge_id AS id, source, target, cost, reverse_cost FROM indoor_edges',
                    %s, %s, directed => false
                ) p
                LEFT JOIN indoor_edges e ON p.edge = e.edge_id
                ORDER BY p.seq
            """, (start_id, end_id))
            
            rows = cur.fetchall()
            
        features = []
        total_cost = 0
        for r in rows:
            if r.get("geojson"):
                features.append({
                    "type": "Feature",
                    "geometry": json.loads(r["geojson"]),
                    "properties": {
                        "seq": r["seq"],
                        "floor": r.get("floor"),
                        "cost": r["agg_cost"]
                    }
                })
                total_cost = r["agg_cost"]
        
        return {
            "type": "FeatureCollection",
            "features": features,
            "total_cost_m": round(total_cost, 1),
            "start_unit": start_unit,
            "end_unit": end_unit
        }
        
    except Exception as e:
        logger.error(e)
        raise HTTPException(500, "Indoor routing failed")

# /indoor/search (already partially there via ES, but enhance)
Seamless Indoor ↔ Outdoor:

Add building entrances as nodes in the outdoor graph.
When routing A→B crosses a building, switch graphs at the entrance node.
```
4. Update Martin Config for Indoor Tiles
In martin-config.yml:
YAMLindoor_units:
  type: table
  schema: public
  table: indoor_units
  geometry_column: geom
  # Add 3D support
  query: >
    SELECT *, 
           base_height as "base",
           unit_height as "height"
    FROM indoor_units
Update your BDF style (style_bdf.json) to include dynamic indoor layers with fill-extrusion.
5. Frontend Enhancements (scripts.js)
Your existing code already does most of this well. Key improvements:
Add Floor Selector (when in BDF mode):
JavaScript// After zoomToFeature
function showFloorSelector(floorLevels) {
  // Dynamically create buttons  L0, L1, ..., L5
}
Indoor Routing Mode:
```javascript
async function routeBetweenUnits(startId, endId) {
    clearAll(); // your existing function
    const res = await fetch(`/api/indoor/route?start_unit=${encodeURIComponent(startId)}&end_unit=${encodeURIComponent(endId)}`);
    const data = await res.json();
    
    // Reuse your existing route drawing
    addRouteLayer(data, '#8b5cf6', 0.95, 7, 'indoor-route');
    
    showInfo(`Indoor route from <strong>${startId}</strong> to <strong>${endId}</strong><br>Total cost: ${data.total_cost_m.toFixed(0)}m`);
}
```

Add a new mode button "Indoor Route".
Click two units → call /indoor/route.
Draw the path with addRouteLayer (reuse existing function).

3D Camera Controls:

Your BDF style already tilts. Add keyboard shortcuts or UI for floor navigation.

Highlight Improvements:

Use fill-extrusion with dynamic fill-extrusion-base and fill-extrusion-height based on FloorID.

6. Data Enrichment (Highly Recommended)

Doors / Corridors: Extract or manually add as separate layer.
Vertical Connectivity: Explicit stair/elevator edges.
Room Accessibility: Add attributes (is_accessible, capacity).

7. Docker & Deployment Tips

Add gdal-bin to your PostGIS Dockerfile if needed.
Increase Martin/PostGIS resources for complex indoor queries.
Use Martin function sources for on-the-fly indoor tiles.

Updated Strategy (Realistic for Your Data)

Nodes = Centroids of each unit polygon.
Edges = Connect neighboring units (using ST_Touches or buffer-based adjacency).
Special Nodes = Detect stairs/elevators via USE_TYPE and create vertical connections between floors.
Routing = Use pgRouting on this derived graph. Floor changes will have a small cost penalty.


Step 1: Import & Prepare Data (Run These SQL Commands)
SQL-- 1. Import (if not done)
-- (Use ogr2ogr as before or QGIS/pgAdmin)

-- 2. Ensure clean table
ALTER TABLE indoor_units 
  ADD COLUMN IF NOT EXISTS id SERIAL PRIMARY KEY,
  ADD COLUMN IF NOT EXISTS floor INT,
  ADD COLUMN IF NOT EXISTS base_height DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS unit_height DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS centroid GEOMETRY(Point, 4326);

UPDATE indoor_units 
SET floor = (properties->>'FloorID')::int,
    base_height = COALESCE((properties->>'Base')::float, 0),
    unit_height = COALESCE((properties->>'HEIGHT')::float, 4.25);

-- Create centroids for routing nodes
UPDATE indoor_units 
SET centroid = ST_Centroid(geom);
Step 2: Build Indoor Graph (Nodes + Edges)
Run this SQL to create the routing tables:
SQL-- === INDOOR NODES ===
CREATE TABLE indoor_nodes AS
SELECT 
  row_number() OVER () AS node_id,
  UNIT_ID,
  floor,
  USE_TYPE,
  centroid AS geom,
  ST_X(centroid) AS lon,
  ST_Y(centroid) AS lat
FROM indoor_units;

CREATE INDEX idx_indoor_nodes_geom ON indoor_nodes USING GIST(geom);

-- === INDOOR EDGES (Horizontal - same floor) ===
CREATE TABLE indoor_edges AS
WITH adjacent AS (
  SELECT 
    a.node_id AS source,
    b.node_id AS target,
    ST_Distance(a.geom::geography, b.geom::geography) AS cost_m,
    a.floor
  FROM indoor_nodes a
  JOIN indoor_nodes b ON a.floor = b.floor 
                     AND a.node_id < b.node_id
  WHERE ST_DWithin(a.geom, b.geom, 0.0001)  -- ~11 meters
     OR ST_Touches(a.geom, b.geom)          -- shared walls
)
SELECT 
  row_number() OVER () AS edge_id,
  source, target, cost_m AS cost,
  cost_m AS reverse_cost,   -- bidirectional
  floor,
  ST_MakeLine(
    (SELECT geom FROM indoor_nodes WHERE node_id = source),
    (SELECT geom FROM indoor_nodes WHERE node_id = target)
  ) AS geom
FROM adjacent;

-- Add vertical connections (Stairs / Elevators)
INSERT INTO indoor_edges (source, target, cost, reverse_cost, floor, geom)
SELECT 
  s.node_id AS source,
  t.node_id AS target,
  20 AS cost,           -- penalty for floor change (~20m equivalent)
  20 AS reverse_cost,
  s.floor,
  ST_MakeLine(s.geom, t.geom)
FROM indoor_nodes s
JOIN indoor_nodes t 
  ON s.floor != t.floor 
 AND s.USE_TYPE IN ('stairs', 'elevator', 'Stair', 'Elevator', 'SVP') -- adjust keywords
 AND ST_DWithin(s.geom, t.geom, 0.001);  -- close vertically
Create Topology for pgRouting:
SQLSELECT pgr_createTopology('indoor_edges', 0.00001, 'geom', 'edge_id', 'source', 'target');
Step 3: Add Indoor Routing Endpoint to app.py
Add this to your FastAPI:
Python@app.get("/indoor/route")
def indoor_route(
    start_unit: str,
    end_unit: str,
    max_floor_changes: int = 5
):
    with db_connection() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Find nodes
        cur.execute("""
            SELECT node_id, floor 
            FROM indoor_nodes 
            WHERE UNIT_ID = %s OR UNIT_ID = %s
        """, (start_unit, end_unit))
        nodes = cur.fetchall()
        
        if len(nodes) < 2:
            raise HTTPException(404, "Unit not found")
            
        start_id = nodes[0]["node_id"]
        end_id = nodes[1]["node_id"] if len(nodes) > 1 else nodes[0]["node_id"]
        
        cur.execute("""
            SELECT 
                p.seq, p.node, p.edge, p.agg_cost,
                ST_AsGeoJSON(e.geom) AS geojson
            FROM pgr_dijkstra(
                'SELECT edge_id AS id, source, target, cost, reverse_cost FROM indoor_edges',
                %s, %s, directed => false
            ) p
            LEFT JOIN indoor_edges e ON p.edge = e.edge_id
            ORDER BY p.seq
        """, (start_id, end_id))
        
        rows = cur.fetchall()
        
    # Build GeoJSON response similar to your outdoor /route endpoint
    features = []
    for r in rows:
        if r["geojson"]:
            features.append({
                "type": "Feature",
                "geometry": json.loads(r["geojson"]),
                "properties": {"seq": r["seq"], "agg_cost": r["agg_cost"]}
            })
    
    return {
        "type": "FeatureCollection",
        "features": features,
        "total_cost": rows[-1]["agg_cost"] if rows else 0,
        "path": [r["node"] for r in rows]
    }
Step 4: Frontend Integration (scripts.js)
Add a new mode or extend search:
JavaScript// After selecting two units in search results
async function calculateIndoorRoute(startId, endId) {
  const res = await fetch(`/api/indoor/route?start_unit=${startId}&end_unit=${endId}`);
  const data = await res.json();
  // Reuse your addRouteLayer function
  addRouteLayer(data, '#ff00ff', 0.9, 6, 'indoor-route');
}
Enhance BDF Style for better indoor feel (extrusions per floor).
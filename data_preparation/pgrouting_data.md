### 0) High-level plan (so you know where we’re going)

1. Create DB, enable PostGIS & pgRouting.

2. Prepare a working edges table (add id and topology columns).

3. Project geometry to a metric CRS for snapping/length calculations (important).

4. Clean-ish steps: snapping / small topology fixes.

5. Run pgr_extractVertices() to build vertices table and set source/target. 
Crunchy Data

6. Compute length, cost, reverse_cost (and handle one-way if/when you add it).

7. Create indexes and test with pgr_dijkstra (or other algos).

8. Minimal app: query route as GeoJSON and return to frontend.

### 1. Create DB + enable extensions
```
-- run as postgres superuser
CREATE DATABASE routing_db;
\c routing_db

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgrouting;
```

### 2. Prepare a working edges table

If you have a shapefile, import it (e.g. ogr2ogr or shp2pgsql) into ways_raw. Then create a copy we’ll work on:

- Insert data have been cleaned topology in GIS apps (QGIS), it is faster and easier to monitoring process
```
-- assume ways_raw(geom) exists in 4326
-- 1. Clean ways table
DROP TABLE IF EXISTS ways CASCADE;
CREATE TABLE ways AS
WITH cleaned AS (
    SELECT
        row_number() OVER () AS id,
        
        CASE
            WHEN "Subtype" = 2 THEN 120
            WHEN "Subtype" = 1 THEN 100
            WHEN "Subtype" = 3 THEN 90
            WHEN "Subtype" = 4 THEN 70
            WHEN "Subtype" = 5 THEN 60
            WHEN "Subtype" = 6 THEN 40
            WHEN "Subtype" = 7 THEN 5
            ELSE 30
        END AS speed_kmh,
	-- oneway logic
    CASE
        WHEN "StreetCenterlineDirectionID" =1  OR "StreetFOWID" = 1 
        THEN true
        ELSE false
    END AS is_oneway,
        ST_SetSRID(ST_GeometryN(ST_CollectionExtract(ST_LineMerge(ST_MakeValid(geom)), 2 ), 1 ), 4326
        ) AS geom
    FROM ways_raw
    WHERE geom IS NOT NULL
      AND ST_GeometryType(geom) != 'ST_Point'
)
SELECT id, speed_kmh, is_oneway, geom
		, ST_Length(ST_Transform(geom, 3857))::double precision AS length_m --Snapping tolerances and length calculations are much easier and safer in meters.
		, NULL::bigint AS source
        , NULL::bigint AS target
		, NULL::bigint AS cost
        , NULL::bigint AS reverse_cost
FROM cleaned
WHERE geom IS NOT NULL
  AND ST_GeometryType(geom) = 'ST_LineString'
  AND ST_NPoints(geom) >= 2;
```
-- Create index:
```
ALTER TABLE topology.ways ADD PRIMARY KEY (id);
CREATE INDEX ways_gix ON topology.ways USING GIST (geom);
```

### 3. Create vertices table with pgr_extractVertices()

pgr_extractVertices() will extract vertices and create a vertices_table that you can use to set source/target. Example workflow (projected geometry):
```
-- drop previous vertices table if exists
DROP TABLE IF EXISTS vertices;

-- run pgr_extractVertices on the projected geometry (use the projected table and column name)
SELECT * INTO vertices FROM pgr_extractVertices('SELECT id, geom FROM ways');
```
Creates vertices (with id, geom columns) listing unique nodes, and populates in_edges and out_edges. Then update back soure and target in ways 

### 4. Update source and target 
```
-- set the source information 
UPDATE topology.ways AS w
SET source = v.id 
FROM topology.vertices AS v
WHERE ST_StartPoint(w.geom) = v.geom;

-- set the target information 
UPDATE topology.ways AS w
SET target = v.id 
FROM topology.vertices AS v
WHERE ST_EndPoint(w.geom) = v.geom;

-- Update or Add missing indexes on source/target (very important!)
CREATE INDEX IF NOT EXISTS ways_source_idx ON topology.ways(source);
CREATE INDEX IF NOT EXISTS ways_target_idx ON topology.ways(target);
```

### 5. Calculate length, cost, reverse_cost
```
UPDATE topology.ways SET
  cost = length_m / (speed_kmh * 1000.0 / 3600.0),
  reverse_cost = CASE 
    WHEN is_oneway THEN -1 
    ELSE length_m / (speed_kmh * 1000.0 / 3600.0) 
  END;
```

### 6. Vacuum/analyze
```
ANALYZE topology.ways;
ANALYZE topology.vertices;
```

### 7.  Quick validation (connected components / debugging)

Check for isolated components (useful to find broken geometry):
```
SELECT * FROM pgr_connectedComponents('
  SELECT id, source, target, cost, reverse_cost FROM topology.ways'
  );
```

If you need to filter to a connected subgraph for routing, you can use pgr_connectedComponents to find major components and work on the largest.

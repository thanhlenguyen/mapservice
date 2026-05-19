-- assume ways_raw(geom) exists in 4326
-- 1. Clean ways table
DROP TABLE IF EXISTS topology.ways CASCADE;
CREATE TABLE topology.ways AS
WITH cleaned AS (
    SELECT
        row_number() OVER () AS id,
        regexp_replace(TRIM(regexp_replace(englishnam, E'[\u00A0\r\n\t]', ' ', 'g') ), '\s+', ' ', 'g') as name,
        CASE
            WHEN subtype = 2 THEN 120
            WHEN subtype = 1 THEN 100
            WHEN subtype = 3 THEN 90
            WHEN subtype = 4 THEN 70
            WHEN subtype = 5 THEN 60
            WHEN subtype = 6 THEN 40
            WHEN subtype = 7 THEN 5
            ELSE 30
        END AS speed_kmh,
	-- oneway logic
    CASE
        WHEN streetcent =1  OR streetfowi = 1 
        THEN true
        ELSE false
    END AS is_oneway,
        ST_SetSRID(ST_GeometryN(ST_CollectionExtract(ST_LineMerge(ST_MakeValid(geom)), 2 ), 1 ), 4326
        ) AS geom
    FROM topology.ways_raw
    WHERE geom IS NOT NULL
      AND ST_GeometryType(geom) != 'ST_Point'
)
SELECT id, name, speed_kmh, is_oneway, geom
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
```sql
ALTER TABLE topology.ways ADD PRIMARY KEY (id);
CREATE INDEX ways_gix_geom ON topology.ways USING GIST (geom);

```

-- Run pgr_extractVertices on the projected geometry (use the projected table and column name)
DROP TABLE IF EXISTS topology.vertices CASCADE;  
SELECT * INTO topology.vertices FROM pgr_extractVertices('SELECT id, geom FROM topology.ways');

-- Create index
CREATE INDEX idx_vertices_geom_gist ON topology.vertices USING gist (geom);
ALTER TABLE topology.vertices ADD PRIMARY KEY (id);
CREATE INDEX IF NOT EXISTS vertices_idx ON topology.vertices(id);

ALTER TABLE topology.vertices ALTER COLUMN id SET STATISTICS 1000;

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

UPDATE topology.ways SET
  cost = length_m / (speed_kmh * 1000.0 / 3600.0),
  reverse_cost = CASE 
    WHEN is_oneway THEN -1 
    ELSE length_m / (speed_kmh * 1000.0 / 3600.0) 
  END;
  
--Create composite indexes
CREATE INDEX IF NOT EXISTS idx_ways_cost ON topology.ways(cost) WHERE cost > 0;
CREATE INDEX IF NOT EXISTS idx_ways_reverse_cost ON topology.ways(reverse_cost) WHERE reverse_cost > 0;

CREATE INDEX IF NOT EXISTS idx_ways_active 
ON topology.ways(id) 
WHERE cost > 0 AND reverse_cost > 0;

CREATE INDEX IF NOT EXISTS idx_ways_routing_composite 
ON topology.ways(source, target, cost) 
WHERE cost > 0;

CREATE INDEX IF NOT EXISTS idx_ways_reverse_routing 
ON topology.ways(target, source, reverse_cost) 
WHERE reverse_cost > 0;

CREATE INDEX IF NOT EXISTS idx_ways_length_routing 
ON topology.ways(source, target, length_m) 
WHERE cost > 0;

ALTER TABLE topology.ways ALTER COLUMN source SET STATISTICS 1000;
ALTER TABLE topology.ways ALTER COLUMN target SET STATISTICS 1000;
ALTER TABLE topology.ways ALTER COLUMN cost SET STATISTICS 1000;
ALTER TABLE topology.ways ALTER COLUMN reverse_cost SET STATISTICS 1000;
ALTER TABLE topology.ways ALTER COLUMN length_m SET STATISTICS 1000;

VACUUM ANALYZE topology.ways;
VACUUM ANALYZE topology.vertices;

-- Rebuilding them can help

REINDEX INDEX CONCURRENTLY topology.idx_ways_routing_composite;
REINDEX INDEX CONCURRENTLY topology.idx_ways_reverse_routing;
REINDEX INDEX CONCURRENTLY topology.idx_ways_length_routing;

ANALYZE topology.ways;
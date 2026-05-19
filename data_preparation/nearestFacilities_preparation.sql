-- 0. Add column if not already present
ALTER TABLE topology.places ADD COLUMN IF NOT EXISTS nearest_vertex_id BIGINT;
-- 1. Verify Database Indexes
-- Check existing indexes if needed
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes 
WHERE schemaname = 'topology' 
  AND tablename IN ('places', 'vertices', 'ways')
ORDER BY tablename, indexname  ;

-- Check if pgrouting installed:
SELECT pgr_version();

SELECT
  version() AS postgres,
  postgis_version(),
  pgr_version();

ALTER EXTENSION pgrouting UPDATE;


-- Create missing indexes if needed
CREATE INDEX IF NOT EXISTS idx_places_type ON topology.places(type);


-- Analyze tables
ANALYZE topology.places;
ANALYZE topology.vertices;
ANALYZE topology.ways;

-- 2. Compute nearest vertex for EVERY POI (safe to run multiple times)
UPDATE topology.places p
SET nearest_vertex_id = (
    SELECT id 
    FROM topology.vertices v
    ORDER BY v.geom <-> p.geom
    LIMIT 1
)
WHERE nearest_vertex_id IS NULL;   -- only compute missing ones. Note: check if using LATERAL is faster for larger dataset

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS places_nearest_vertex_idx 
ON topology.places (nearest_vertex_id);

-- Create composite index:
-- This speeds up the "nearby_places" CTE in nearest_facility endpoint
CREATE INDEX IF NOT EXISTS idx_places_type_geom 
ON topology.places(type) 
INCLUDE (nearest_vertex_id, name, address)
WHERE nearest_vertex_id IS NOT NULL;

-- Spatial index for geography-based distance searches
CREATE INDEX IF NOT EXISTS idx_places_geog 
ON topology.places USING GIST((geom::geography));

-- Increase statistics
ALTER TABLE topology.places ALTER COLUMN type SET STATISTICS 500;
ALTER TABLE topology.places ALTER COLUMN nearest_vertex_id SET STATISTICS 500;


VACUUM ANALYZE topology.places;

-- Check how many places have nearest_vertex_id
SELECT 
    type,
    COUNT(*) as total,
    COUNT(nearest_vertex_id) as with_vertex,
    COUNT(*) - COUNT(nearest_vertex_id) as missing_vertex
FROM topology.places
GROUP BY type;
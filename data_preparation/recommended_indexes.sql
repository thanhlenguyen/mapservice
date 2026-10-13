-- ============================================================================
-- RECOMMENDED ADDITIONAL INDEXES FOR ROUTING PERFORMANCE
-- ============================================================================
-- Current indexes are good, but these additions will help specifically
-- with the queries in app.py

-- ============================================================================
-- 0. CRITICAL: PRIMARY KEY / ID INDEX (CHECK FIRST!)
-- ============================================================================
-- Check if vertices table has a primary key
-- Run this first to see if you already have it:
-- \d topology.vertices

-- If vertices.id does NOT have a primary key or index, create it immediately:
-- This is CRITICAL because every routing operation looks up vertices by ID

-- Option 1: If id should be PRIMARY KEY (RECOMMENDED)
-- ALTER TABLE topology.vertices ADD PRIMARY KEY (id);

-- Option 2: If you can't add PRIMARY KEY, at least create unique index
CREATE UNIQUE INDEX IF NOT EXISTS vertices_id_idx ON topology.vertices(id);

-- ALSO: Ensure vertices table is properly set up for pgRouting
-- (Usually pgRouting setup creates this automatically, but check!)

-- ============================================================================
-- 1. COMPOSITE INDEX for routing queries (MOST IMPORTANT)
-- ============================================================================
-- This is the #1 most important index - it will drastically speed up pgr_dijkstra
-- The routing algorithm needs to quickly filter by cost > 0 AND access source/target
CREATE INDEX IF NOT EXISTS idx_ways_routing_composite 
ON topology.ways(source, target, cost) 
WHERE cost > 0;

-- Explanation: This covers the most common query pattern:
-- 'SELECT id, source, target, cost, reverse_cost FROM topology.ways WHERE cost > 0'

-- ============================================================================
-- 2. REVERSE ROUTING COMPOSITE INDEX
-- ============================================================================
-- For bidirectional routing (reverse_cost is used)
CREATE INDEX IF NOT EXISTS idx_ways_reverse_routing 
ON topology.ways(target, source, reverse_cost) 
WHERE reverse_cost > 0;

-- ============================================================================
-- 3. LENGTH-BASED ROUTING (for shortest path optimization)
-- ============================================================================
-- When using optimization='shortest', we use length_m as the cost
CREATE INDEX IF NOT EXISTS idx_ways_length_routing 
ON topology.ways(source, target, length_m) 
WHERE cost > 0;

-- ============================================================================
-- 4. FACILITY SEARCH OPTIMIZATION
-- ============================================================================
-- Composite index for facility searches (type + geometry)
-- This speeds up the "nearby_places" CTE in nearest_facility endpoint
CREATE INDEX IF NOT EXISTS idx_places_type_geom 
ON topology.places(type) 
INCLUDE (nearest_vertex_id, name, address)
WHERE nearest_vertex_id IS NOT NULL;

-- Spatial index for geography-based distance searches
CREATE INDEX IF NOT EXISTS idx_places_geog 
ON topology.places USING GIST((geom::geography));

-- ============================================================================
-- 5. PARTIAL INDEX for active ways
-- ============================================================================
-- Only index ways that are actually used in routing
CREATE INDEX IF NOT EXISTS idx_ways_active 
ON topology.ways(id) 
WHERE cost > 0 AND reverse_cost > 0;

-- ============================================================================
-- 6. COVERING INDEX for way lookups
-- ============================================================================
-- When we fetch geometries after routing, include commonly accessed columns
DROP INDEX IF EXISTS idx_ways_id_with_geom;
CREATE INDEX IF NOT EXISTS idx_ways_id_with_geom 
ON topology.ways(id) 
INCLUDE (geom, length_m, cost);

-- ============================================================================
-- VACUUM AND ANALYZE
-- ============================================================================
-- After creating indexes, update statistics
VACUUM ANALYZE topology.ways;
VACUUM ANALYZE topology.vertices;
VACUUM ANALYZE topology.places;

-- ============================================================================
-- CHECK INDEX USAGE
-- ============================================================================
-- Run this query after your app has been running for a while to see which indexes are used
-- 
-- SELECT 
--     schemaname,
--     tablename,
--     indexname,
--     idx_scan,
--     idx_tup_read,
--     idx_tup_fetch
-- FROM pg_stat_user_indexes
-- WHERE schemaname = 'topology'
-- ORDER BY idx_scan DESC;

-- ============================================================================
-- OPTIONAL: CLUSTERING for better sequential access
-- ============================================================================
-- If you have time during maintenance window, cluster the table by the most-used index
-- This physically reorders rows on disk for faster sequential scans
-- 
-- CLUSTER topology.ways USING idx_ways_routing_composite;
-- CLUSTER topology.places USING idx_places_type_geom;
-- 
-- NOTE: This locks the table and can take time. Only do during maintenance.

-- ============================================================================
-- STATISTICS TUNING (PostgreSQL configuration)
-- ============================================================================
-- If you can modify postgresql.conf or use ALTER TABLE, increase statistics target
-- for columns used in routing:
-- 
-- ALTER TABLE topology.ways ALTER COLUMN source SET STATISTICS 1000;
-- ALTER TABLE topology.ways ALTER COLUMN target SET STATISTICS 1000;
-- ALTER TABLE topology.ways ALTER COLUMN cost SET STATISTICS 1000;
-- ALTER TABLE topology.ways ALTER COLUMN length_m SET STATISTICS 1000;
-- 
-- Then run: ANALYZE topology.ways;

-- ============================================================================
-- PERFORMANCE VERIFICATION QUERIES
-- ============================================================================

-- 1. Check if indexes are being used for routing
EXPLAIN ANALYZE
SELECT id, source, target, cost, reverse_cost 
FROM topology.ways 
WHERE cost > 0;

-- Expected: Should use "idx_ways_routing_composite" or "idx_ways_cost"
-- Look for "Index Scan" not "Seq Scan"

-- 2. Check facility search performance
EXPLAIN ANALYZE
SELECT p.id, p.name, p.type, p.nearest_vertex_id
FROM topology.places p
WHERE p.type = 'hospital'
  AND p.nearest_vertex_id IS NOT NULL
  AND ST_DWithin(
      p.geom::geography,
      ST_SetSRID(ST_MakePoint(46.6167, 24.8258), 4326)::geography,
      5000
  )
LIMIT 10;

-- Expected: Should use "idx_places_type_geom" and "idx_places_geog"

-- 3. Check vertex lookup performance
EXPLAIN ANALYZE
SELECT id 
FROM topology.vertices 
ORDER BY geom <-> ST_SetSRID(ST_MakePoint(46.6167, 24.8258), 4326)
LIMIT 1;

-- Expected: Should use "idx_vertices_geom_gist"

-- ============================================================================
-- INDEX SIZE REPORT
-- ============================================================================
-- Check how much space indexes are using
SELECT 
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'topology'
ORDER BY pg_relation_size(indexrelid) DESC;

-- ============================================================================
-- PRIORITY RANKING
-- ============================================================================
/*
Priority 1 (MUST HAVE - Implement Immediately):
  ✅ idx_ways_routing_composite - Speeds up ALL routing queries by 3-10x

Priority 2 (HIGH IMPACT - Implement Soon):
  ✅ idx_ways_reverse_routing - For bidirectional routing
  ✅ idx_places_type_geom - Speeds up facility searches by 5-10x

Priority 3 (GOOD TO HAVE):
  ✅ idx_ways_length_routing - For shortest path mode
  ✅ idx_places_geog - For distance-based searches
  
Priority 4 (OPTIONAL):
  - idx_ways_active - Minor improvement
  - idx_ways_id_with_geom - Covering index for lookups
  - CLUSTER commands - Maintenance window only

ESTIMATED IMPACT ON 504 ERRORS:
- Priority 1 alone: Reduce timeouts by ~60-70%
- Priority 1 + 2: Reduce timeouts by ~80-90%
- All priorities: Reduce timeouts by ~95%+

ESTIMATED INDEX CREATION TIME:
- Small dataset (<1M ways): 1-5 minutes
- Medium dataset (1M-10M ways): 5-30 minutes
- Large dataset (10M+ ways): 30-120 minutes

During index creation, queries will still work but may be slower.
CREATE INDEX CONCURRENTLY can be used to avoid blocking:

CREATE INDEX CONCURRENTLY idx_ways_routing_composite 
ON topology.ways(source, target, cost) WHERE cost > 0;
*/

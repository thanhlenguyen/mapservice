-- ============================================================================
-- CRITICAL INDEX CHECK SCRIPT
-- ============================================================================
-- Run this FIRST to check if you have the most critical indexes
-- This will show you what's missing

-- ============================================================================
-- 1. CHECK VERTICES TABLE STRUCTURE
-- ============================================================================
\d topology.vertices

-- Expected output should show:
-- "vertices_pkey" PRIMARY KEY (id) 
-- OR at minimum:
-- "vertices_id_idx" UNIQUE INDEX on (id)

-- ============================================================================
-- 2. CHECK WAYS TABLE STRUCTURE  
-- ============================================================================
\d topology.ways

-- Expected output should show:
-- "ways_pkey" PRIMARY KEY (id)

-- ============================================================================
-- 3. LIST ALL CURRENT INDEXES
-- ============================================================================
SELECT 
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'topology'
ORDER BY tablename, indexname;

-- ============================================================================
-- 4. CHECK FOR CRITICAL MISSING INDEXES
-- ============================================================================

-- Check #1: Does vertices have ID index?
SELECT 
    CASE 
        WHEN EXISTS (
            SELECT 1 FROM pg_indexes 
            WHERE schemaname = 'topology' 
            AND tablename = 'vertices' 
            AND (indexname LIKE '%id%' OR indexname LIKE '%pkey%')
        ) 
        THEN '✅ vertices.id has index'
        ELSE '❌ CRITICAL: vertices.id MISSING index - CREATE IMMEDIATELY!'
    END AS vertices_id_check;

-- Check #2: Does ways have composite routing index?
SELECT 
    CASE 
        WHEN EXISTS (
            SELECT 1 FROM pg_indexes 
            WHERE schemaname = 'topology' 
            AND tablename = 'ways' 
            AND indexdef LIKE '%source%target%cost%'
        ) 
        THEN '✅ ways has composite routing index'
        ELSE '❌ MISSING: composite routing index - High priority!'
    END AS ways_composite_check;

-- Check #3: Does places have type+vertex composite?
SELECT 
    CASE 
        WHEN EXISTS (
            SELECT 1 FROM pg_indexes 
            WHERE schemaname = 'topology' 
            AND tablename = 'places' 
            AND (indexdef LIKE '%type%vertex%' OR indexdef LIKE '%type%)%INCLUDE%')
        ) 
        THEN '✅ places has composite type index'
        ELSE '❌ MISSING: places composite index - High priority!'
    END AS places_composite_check;

-- ============================================================================
-- 5. CHECK INDEX USAGE STATISTICS
-- ============================================================================
-- This shows which indexes are actually being used
-- (Only works after your app has been running for a while)

SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan AS times_used,
    idx_tup_read AS rows_read,
    idx_tup_fetch AS rows_fetched,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'topology'
ORDER BY idx_scan DESC;

-- If idx_scan = 0, the index is not being used at all!

-- ============================================================================
-- 6. DETAILED VERTEX TABLE ANALYSIS
-- ============================================================================

-- Count total vertices
SELECT COUNT(*) AS total_vertices FROM topology.vertices;

-- Check if vertices.id is sequential
SELECT 
    MIN(id) AS min_id,
    MAX(id) AS max_id,
    COUNT(*) AS count,
    MAX(id) - MIN(id) + 1 AS expected_count,
    CASE 
        WHEN COUNT(*) = MAX(id) - MIN(id) + 1 THEN '✅ Sequential'
        ELSE '⚠️ Has gaps'
    END AS id_status
FROM topology.vertices;

-- Check for NULL ids (should be 0!)
SELECT COUNT(*) AS null_id_count 
FROM topology.vertices 
WHERE id IS NULL;

-- ============================================================================
-- 7. SAMPLE QUERY PERFORMANCE TEST
-- ============================================================================

-- Test 1: Vertex lookup by ID (should be instant with index)
EXPLAIN ANALYZE
SELECT * FROM topology.vertices WHERE id = 1;
-- Expected: "Index Scan" in microseconds
-- Bad: "Seq Scan" or takes milliseconds

-- Test 2: Vertex spatial lookup (used when clicking on map)
EXPLAIN ANALYZE
SELECT id 
FROM topology.vertices 
ORDER BY geom <-> ST_SetSRID(ST_MakePoint(46.6167, 24.8258), 4326)
LIMIT 1;
-- Expected: Uses "idx_vertices_geom_gist"

-- Test 3: Way lookup for routing (CRITICAL)
EXPLAIN ANALYZE
SELECT id, source, target, cost, reverse_cost 
FROM topology.ways 
WHERE cost > 0
LIMIT 100;
-- Expected: "Index Scan" using composite index or cost index
-- Bad: "Seq Scan"

-- ============================================================================
-- 8. TABLE SIZE REPORT
-- ============================================================================

SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) AS index_size
FROM pg_tables
WHERE schemaname = 'topology'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- ============================================================================
-- INTERPRETATION GUIDE
-- ============================================================================
/*
RED FLAGS (Fix Immediately):
  ❌ vertices.id has no index → CREATE UNIQUE INDEX vertices_id_idx ON topology.vertices(id);
  ❌ Seq Scan on routing queries → Missing composite index
  ❌ NULL id count > 0 → Data integrity issue

WARNINGS (High Priority):
  ⚠️ Index exists but idx_scan = 0 → Index not being used, check query patterns
  ⚠️ Table size > 10x index size → May need more indexes or better queries

GOOD SIGNS:
  ✅ All checks pass
  ✅ Index Scans on EXPLAIN ANALYZE
  ✅ High idx_scan counts on indexes
  ✅ Query times in microseconds/milliseconds
*/

-- ============================================================================
-- EMERGENCY FIX COMMANDS
-- ============================================================================
-- If vertices.id is missing index, run ONE of these immediately:

-- Option 1: Add primary key (BEST - do this if possible)
-- ALTER TABLE topology.vertices ADD CONSTRAINT vertices_pkey PRIMARY KEY (id);

-- Option 2: Add unique index (if you can't add PK)
-- CREATE UNIQUE INDEX CONCURRENTLY vertices_id_idx ON topology.vertices(id);

-- Option 3: Add non-unique index (if IDs can duplicate - unusual)
-- CREATE INDEX CONCURRENTLY vertices_id_idx ON topology.vertices(id);

-- After creating index:
-- ANALYZE topology.vertices;

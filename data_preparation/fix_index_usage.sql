-- ============================================================================
-- FIX: Force PostgreSQL to Use Your Indexes
-- ============================================================================
-- You have all the right indexes, but PostgreSQL isn't using them!
-- This script will fix that.

-- ============================================================================
-- STEP 1: Update Table Statistics (CRITICAL!)
-- ============================================================================
-- PostgreSQL uses statistics to decide whether to use indexes
-- Your statistics are probably outdated, causing bad query plans

-- Increase statistics target for routing-critical columns
ALTER TABLE topology.ways ALTER COLUMN source SET STATISTICS 1000;
ALTER TABLE topology.ways ALTER COLUMN target SET STATISTICS 1000;
ALTER TABLE topology.ways ALTER COLUMN cost SET STATISTICS 1000;
ALTER TABLE topology.ways ALTER COLUMN reverse_cost SET STATISTICS 1000;
ALTER TABLE topology.ways ALTER COLUMN length_m SET STATISTICS 1000;

-- Update statistics NOW
ANALYZE topology.ways;

-- Do the same for vertices
ALTER TABLE topology.vertices ALTER COLUMN id SET STATISTICS 1000;
ANALYZE topology.vertices;

-- And places
ALTER TABLE topology.places ALTER COLUMN type SET STATISTICS 500;
ALTER TABLE topology.places ALTER COLUMN nearest_vertex_id SET STATISTICS 500;
ANALYZE topology.places;

-- ============================================================================
-- STEP 2: Tune PostgreSQL Query Planner Parameters
-- ============================================================================
-- These settings help PostgreSQL make better decisions about index usage

-- Increase random_page_cost (makes indexes more attractive)
-- Run this in your PostgreSQL session or add to postgresql.conf:
-- SET random_page_cost = 1.1;  -- Default is 4.0, lower = prefer indexes

-- Increase effective_cache_size (tells PostgreSQL you have RAM for caching)
-- SET effective_cache_size = '2GB';  -- Adjust based on your available RAM

-- For your session specifically (or add to app.py):
SET random_page_cost = 1.1;
SET effective_cache_size = '2GB';

-- ============================================================================
-- STEP 3: Test if Indexes Are Now Being Used
-- ============================================================================

-- Test 1: Routing query (should now use idx_ways_routing_composite)
EXPLAIN ANALYZE
SELECT id, source, target, cost, reverse_cost 
FROM topology.ways 
WHERE cost > 0
LIMIT 10000;  -- Increased limit to force index usage

-- Expected: "Index Scan using idx_ways_routing_composite" or "Bitmap Index Scan"
-- If still "Seq Scan", continue to Step 4

-- Test 2: Full routing query (no LIMIT)
EXPLAIN ANALYZE
SELECT id, source, target, cost, reverse_cost 
FROM topology.ways 
WHERE cost > 0;

-- Should now use Bitmap Index Scan or Index Scan

-- ============================================================================
-- STEP 4: If Still Sequential Scan - Disable Sequential Scans (Temporary)
-- ============================================================================
-- This forces PostgreSQL to use indexes
-- Only use for testing to confirm indexes work!

SET enable_seqscan = off;

-- Now test again:
EXPLAIN ANALYZE
SELECT id, source, target, cost, reverse_cost 
FROM topology.ways 
WHERE cost > 0
LIMIT 100;

-- Should now show Index Scan

-- Turn it back on:
SET enable_seqscan = on;

-- ============================================================================
-- STEP 5: REINDEX if Statistics Don't Help
-- ============================================================================
-- Sometimes indexes get bloated or corrupted
-- Rebuilding them can help

REINDEX INDEX CONCURRENTLY topology.idx_ways_routing_composite;
REINDEX INDEX CONCURRENTLY topology.idx_ways_reverse_routing;
REINDEX INDEX CONCURRENTLY topology.idx_ways_length_routing;

-- Update statistics after reindex
ANALYZE topology.ways;

-- ============================================================================
-- STEP 6: Check Index Bloat
-- ============================================================================
-- See if your indexes are bloated (fragmented)

SELECT 
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'topology' 
  AND tablename = 'ways'
ORDER BY pg_relation_size(indexrelid) DESC;

-- If index_size is huge compared to table, consider REINDEX

-- ============================================================================
-- FOR APP.PY - Add These Settings
-- ============================================================================
-- Add this to your get_db_connection() or after getting cursor:

/*
Python code to add to app.py:

def get_db_connection():
    if connection_pool:
        try:
            conn = connection_pool.getconn()
            # IMPORTANT: Set these parameters for every connection
            cur = conn.cursor()
            cur.execute("SET random_page_cost = 1.1")
            cur.execute("SET effective_cache_size = '2GB'")
            cur.close()
            return conn
        except Exception as e:
            logger.error(f"Failed to get connection from pool: {e}")
    
    # Fallback...
    conn = psycopg2.connect(...)
    cur = conn.cursor()
    cur.execute("SET random_page_cost = 1.1")
    cur.execute("SET effective_cache_size = '2GB'")
    cur.close()
    return conn
*/

-- ============================================================================
-- VERIFICATION CHECKLIST
-- ============================================================================

-- After running ANALYZE, check if query plan improved:

-- 1. Simple routing query
EXPLAIN 
SELECT id, source, target, cost, reverse_cost 
FROM topology.ways 
WHERE cost > 0;

-- Look for: "Bitmap Index Scan on idx_ways_routing_composite"
-- Cost should be much lower than 765922

-- 2. Check statistics were updated
SELECT 
    schemaname,
    tablename,
    attname,
    n_distinct,
    most_common_vals,
    most_common_freqs
FROM pg_stats
WHERE schemaname = 'topology' 
  AND tablename = 'ways'
  AND attname IN ('source', 'target', 'cost');

-- n_distinct should be populated with actual values

-- ============================================================================
-- PERMANENT CONFIGURATION (if you have access)
-- ============================================================================
-- If you can modify postgresql.conf (you said you can't modify manifests,
-- but maybe you can modify the PostgreSQL config):

/*
Add to postgresql.conf:

# Query Planner Settings
random_page_cost = 1.1  # Default is 4.0 (lower = prefer indexes)
effective_cache_size = 2GB  # Should be ~50% of total RAM
work_mem = 64MB  # Memory for sorting/hashing per operation
shared_buffers = 512MB  # Shared memory for caching

Then reload PostgreSQL:
SELECT pg_reload_conf();
*/

-- ============================================================================
-- SUMMARY
-- ============================================================================
/*
You have all the right indexes! The problem is PostgreSQL's query planner
isn't using them because:

1. Statistics are outdated (ANALYZE fixes this)
2. Query planner settings favor sequential scans (random_page_cost fixes this)
3. Small LIMIT makes seqscan look cheaper (real queries don't have LIMIT)

Run STEP 1 (ALTER TABLE + ANALYZE) immediately - this is the most important!
*/

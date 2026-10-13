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
```sql
-- ---------------------------------------------------------------------------
-- CHECK IMPORTED DATA
-- 1.1  Inspect what ogr2ogr actually created — column names/case can vary
--      by GDAL version. Adjust the column names in step 1.3 if yours differ.
-- ---------------------------------------------------------------------------
\d indoor.units_raw

-- ✅ CHECK: row count should be 1643 (or however many features are in your file)
SELECT count(*) FROM indoor.units_raw;
SELECT DISTINCT use_type FROM indoor.units_raw ORDER BY 1;


-- ---------------------------------------------------------------------------
-- 1.2  Sanity checks on the raw import before trusting it
-- ---------------------------------------------------------------------------
-- ✅ CHECK: should be 0 — any NULL geometry or unit_id would break later steps
SELECT count(*) FROM indoor.units_raw WHERE geom IS NULL OR unit_id IS NULL;

-- ✅ CHECK: should all say ST_MultiPolygon / 4326
SELECT DISTINCT GeometryType(geom), ST_SRID(geom) FROM indoor.units_raw;

-- ℹ️ INFO (not an error): UNIT_ID legitimately repeats in this dataset — e.g.
--    multiple "MALE TOILET" rooms on the same floor share the exact same
--    string. That's exactly why indoor.units uses a surrogate `id` as its
--    primary key instead of unit_id. This query is just for awareness.
SELECT unit_id, level_id, count(*) FROM indoor.units_raw GROUP BY unit_id, level_id HAVING count(*) > 1;

-- =============================================================================
-- INDOOR NAVIGATION SCHEMA
-- Run this once against your postgis_db (same DB as topology.* used by
-- app.py). Creates a separate "indoor" schema so it never collides with
-- your existing outdoor routing tables (topology.ways, topology.vertices).
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS indoor;

-- -----------------------------------------------------------------------
-- indoor.units — one row per room/stair/elevator polygon, loaded directly
-- from Units.geojson. This is your source-of-truth floor plan data.
-- -----------------------------------------------------------------------
DROP TABLE IF EXISTS indoor.units CASCADE;
CREATE TABLE indoor.units (
    id              bigserial PRIMARY KEY,  -- surrogate key: UNIT_ID is NOT unique in the source data
                                             -- (e.g. multiple "MALE TOILET" rooms share the same
                                             -- literal UNIT_ID even on the same floor) — use `id`
                                             -- for every join/reference; unit_id is a label only.
    unit_id         text,                   -- e.g. 'SPL.HQ.L0.1481' — NOT unique, keep for display/search
    unit_address    text,
    name            text,
    name_long       text,
    use_type        text,                  -- 'EMP offices', 'Stairs', 'Elevator', ...
    level_id        text NOT NULL,         -- e.g. 'SPL.HQ.L0'
    floor_id        int,                   -- numeric floor order (0,1,2,...)
    height          double precision,
    base            double precision,
    category        text,                  -- derived: 'room' | 'stairs' | 'elevator' | 'elevator_lobby'
    vertical_group_id int,                 -- filled in step 4 (same shaft across floors)
    entry_node_id   bigint,                -- filled in step 3 (this unit's graph entry point)
    geom            geometry(MultiPolygon, 4326) NOT NULL,
    centroid        geometry(Point, 4326)
);
CREATE INDEX idx_indoor_units_geom          ON indoor.units USING GIST (geom);
CREATE INDEX idx_indoor_units_centroid      ON indoor.units USING GIST (centroid);
CREATE INDEX idx_indoor_units_level         ON indoor.units (level_id);
CREATE INDEX idx_indoor_units_vgroup        ON indoor.units (vertical_group_id);
CREATE INDEX idx_indoor_units_unit_address  ON indoor.units (unit_address);  
CREATE INDEX idx_indoor_units_unit_id       ON indoor.units (unit_id);  -- search/lookup only, not unique

-- -----------------------------------------------------------------------
-- indoor.raw_corridors — YOUR MANUALLY DIGITIZED corridor centerlines.
-- One LineString per corridor segment, tagged with the floor it belongs to.
-- Load one GeoJSON file per floor (see CORRIDOR_DIGITIZING_GUIDE.md).
-- -----------------------------------------------------------------------
DROP TABLE IF EXISTS indoor.raw_corridors CASCADE;
CREATE TABLE indoor.raw_corridors (
    id       bigserial PRIMARY KEY,
    level_id text NOT NULL,
    source   bigint,          -- filled by pgr_createTopology (per-floor local id)
    target   bigint,          -- filled by pgr_createTopology (per-floor local id)
    geom     geometry(LineString, 4326) NOT NULL
);
CREATE INDEX idx_raw_corridors_geom  ON indoor.raw_corridors USING GIST (geom);
CREATE INDEX idx_raw_corridors_level ON indoor.raw_corridors (level_id);

-- -----------------------------------------------------------------------
-- indoor.nodes — the routing graph's vertices (global IDs).
-- Populated from corridor junctions (step 2) + room entry points (step 3).
-- -----------------------------------------------------------------------
DROP TABLE IF EXISTS indoor.nodes CASCADE;
CREATE TABLE indoor.nodes (
    id        bigserial PRIMARY KEY,
    level_id  text NOT NULL,
    node_type text NOT NULL,   -- 'corridor_junction' | 'room_entry'
    unit_pk   bigint REFERENCES indoor.units(id),  -- set only for room_entry nodes (surrogate id, not UNIT_ID)
    geom      geometry(Point, 4326) NOT NULL
);
CREATE INDEX idx_indoor_nodes_geom  ON indoor.nodes USING GIST (geom);
CREATE INDEX idx_indoor_nodes_level ON indoor.nodes (level_id);

-- -----------------------------------------------------------------------
-- indoor.edges — the routing graph's edges. This is what pgr_dijkstra runs
-- against. Three kinds of edges live here together:
--   'corridor'       — a digitized corridor segment (walking along a hallway)
--   'room_connector'  — centroid-to-nearest-corridor-node link (entering a room)
--   'vertical'        — stairs/elevator link between two adjacent floors
-- -----------------------------------------------------------------------
DROP TABLE IF EXISTS indoor.edges CASCADE;
CREATE TABLE indoor.edges (
    id           bigserial PRIMARY KEY,
    source       bigint NOT NULL REFERENCES indoor.nodes(id),
    target       bigint NOT NULL REFERENCES indoor.nodes(id),
    cost         double precision NOT NULL,   -- seconds
    reverse_cost double precision NOT NULL,   -- seconds (same value = bidirectional)
    edge_type    text NOT NULL,
    level_id     text,                        -- null for vertical edges (they span 2 floors)
    from_level_id text,                       -- set for vertical edges
    to_level_id   text,                       -- set for vertical edges
    group_id     int,                         -- set for vertical edges (which shaft)
    geom         geometry(LineString, 4326)   -- null allowed for vertical edges
);
CREATE INDEX idx_indoor_edges_source ON indoor.edges (source);
CREATE INDEX idx_indoor_edges_target ON indoor.edges (target);
CREATE INDEX idx_indoor_edges_geom   ON indoor.edges USING GIST (geom);
```

## Data Processing
```sql
-- ---------------------------------------------------------------------------
-- 1.3  Populate indoor.units from the raw import, deriving computed columns
--      (category classification + centroid).
-- ---------------------------------------------------------------------------
TRUNCATE indoor.units CASCADE;

INSERT INTO indoor.units
    (unit_id, unit_address, name, use_type, name_long, level_id, floor_id, height, base, category, geom, centroid)
SELECT
    unit_id,
    unitaddres,
    name,
    use_type,
    name_long,
    level_id,
    floorid,                      -- adjust name if \d showed a different casing
    height,
    base,
    CASE use_type
        WHEN 'Stairs'          THEN 'stairs'
        WHEN 'Elevator'        THEN 'elevator'
        WHEN 'Elevator Lobby'  THEN 'elevator_lobby'
        ELSE 'room'
    END,
    ST_Multi(ST_Force2D(ST_SetSRID(geom, 4326))),
    ST_Centroid(ST_Force2D(geom))
FROM indoor.units_raw;

-- ✅ CHECK: one row per level, 6 levels expected
SELECT level_id, count(*) FROM indoor.units GROUP BY level_id ORDER BY 1;

-- ✅ CHECK: category breakdown (rooms / stairs / elevator / elevator_lobby)
SELECT category, count(*) FROM indoor.units GROUP BY category ORDER BY 1;

-- ✅ CHECK: 0 rows expected
SELECT count(*) FROM indoor.units WHERE geom IS NULL OR centroid IS NULL;


-- #############################################################################
-- PART 2 — AUTO-DERIVE CORRIDOR CENTERLINES FROM indoor.units (no digitizing)
--
-- Technique: floor "reach zone" (union of each room buffered outward a few
-- meters) minus the rooms themselves = the corridor space; then a Voronoi
-- diagram of densified boundary points, clipped to that space, approximates
-- its medial axis (centerline). This is a standard SQL-only stand-in for a
-- straight-skeleton/medial-axis function.
-- #############################################################################
 
-- ---------------------------------------------------------------------------
-- 2.1  Floor plate — the true exterior building outline per floor, used to
--      clip corridor derivation to real building space (no exterior halo,
--      no bridging across genuinely separate wings via open air).
--
--      Built as: concave hull of all rooms -> boundary -> split into
--      individual rings -> keep only the longest ring per floor -> rebuild
--      a solid polygon from just that ring. The exterior perimeter ring is
--      always far longer than a courtyard's inner ring, so this keeps the
--      true outer boundary and discards any hole rings (courtyard, etc.)
--      entirely. Dropping the hole is safe: nothing in step 2.2 reaches
--      into a courtyard's interior anyway (buffering only extends a few
--      meters from an actual room), so the final corridor space stays
--      correctly empty in the middle regardless of whether this mask has a
--      hole for it — its only real job is the exterior edge.
--
--      CAVEAT: this assumes ST_ConcaveHull returns ONE polygon per floor
--      (not a MultiPolygon of disjoint pieces) — true for this data at
--      target_percent 0.95, checked below. If a floor ever comes back with
--      multiple pieces, "keep the single longest ring" would wrongly
--      discard every piece except one; the fix in that case is keeping the
--      longest ring PER polygon part instead.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS indoor.floor_plates;
CREATE TABLE indoor.floor_plates AS
WITH hull AS (
    SELECT level_id, ST_ConcaveHull(ST_Union(geom), 0.95, true) AS geom
    FROM indoor.units
    GROUP BY level_id
),
rings AS (
    SELECT level_id, (ST_Dump(ST_Boundary(geom))).geom AS geom
    FROM hull
),
longest_ring AS (
    SELECT DISTINCT ON (level_id) level_id, geom
    FROM rings
    ORDER BY level_id, ST_Length(geom) DESC
)
SELECT level_id, ST_MakePolygon(geom) AS geom
FROM longest_ring;
 
-- ✅ CHECK: 6 rows, non-null geometry, POLYGON (not MULTIPOLYGON) with no holes
SELECT level_id, ST_GeometryType(geom), ST_NRings(geom), ST_Area(geom)
FROM indoor.floor_plates;
 
-- ✅ CHECK: confirms the "single polygon per floor" assumption above holds —
--    should be 1 for every floor
SELECT level_id, ST_NumGeometries(ST_ConcaveHull(ST_Union(geom), 0.95, true)) AS hull_parts
FROM indoor.units GROUP BY level_id ORDER BY 1;
 
 
-- ---------------------------------------------------------------------------
-- 2.2  Corridor polygon = buffer ALL units unioned together as one shape,
--      minus the rooms themselves, intersected with the floor plate.
--
--      Buffering the union once (rather than buffering each room then
--      unioning ~1600 individual buffers, as an earlier version did) gives
--      the identical result — dilation distributes over union, so
--      buffer(union(rooms)) == union(buffer(room)) for every room — but
--      is far cheaper to compute.
--
--      -0.20 / +0.20 buffer removes any corridor sliver narrower than 40cm
--      entirely (these aren't real walkable corridors, just wall-gap
--      noise).
--
--      ST_SimplifyPreserveTopology afterward removes excess vertices from
--      curved/rounded room walls. This matters a lot: a curved wall sampled
--      into many closely-spaced points creates a dense radial "fan" of tiny
--      Voronoi edges in step 2.4 (an artifact of the technique, not a real
--      skeleton), and those fans are exactly what forced a blunt short-
--      segment delete in step 2.5 that also cut real corridor connections.
--      Simplifying here fixes the problem at the source instead.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS indoor.corridor_polygons;
CREATE TABLE indoor.corridor_polygons AS
SELECT fp.level_id,
       ST_Transform(
           ST_SimplifyPreserveTopology(
               ST_Buffer(
                   ST_Buffer(
                       ST_Intersection(
                           ST_Difference(
                               ST_Buffer(ST_Union(ST_Transform(u.geom, 32638)), 3.0),  -- buffer all units as one
                               ST_Union(ST_Transform(u.geom, 32638))
                           ),
                           ST_Transform(fp.geom, 32638)
                       ),
                       -0.20   -- shrink 20cm: removes gaps narrower than 40cm entirely
                   ),
                   0.20        -- grow back 20cm: restores true corridor width
               ),
               0.10            -- simplify tolerance 10cm: thins out curved-wall vertex density
           ),
       4326) AS geom
FROM indoor.floor_plates fp
JOIN indoor.units u ON u.level_id = fp.level_id
GROUP BY fp.level_id, fp.geom;
 
-- ✅ CHECK: 6 rows, non-null geometry for every floor
SELECT level_id, ST_GeometryType(geom), ST_NumGeometries(geom) FROM indoor.corridor_polygons;
 
-- ✅ CHECK: vertex count per floor — compare against the same query run on
--    the OLD corridor_polygons (pre-simplify) if you still have it, or just
--    eyeball that this is much lower than the number of boundary points
--    generated in step 2.3 would otherwise be (thousands -> low hundreds)
SELECT level_id, ST_NPoints(geom) FROM indoor.corridor_polygons;
 
 
-- ---------------------------------------------------------------------------
-- 2.3  Densify the corridor polygon boundary into points every 1m (in metric
--      space) — these are the "seed points" for the Voronoi skeleton below.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS indoor.corridor_boundary_points_m;
CREATE TABLE indoor.corridor_boundary_points_m AS
SELECT level_id,
       (ST_DumpPoints(ST_Segmentize(ST_Transform(geom, 32638), 1.0))).geom AS geom
FROM indoor.corridor_polygons;
 
-- ✅ CHECK: should be several thousand points per floor for a building this size
SELECT level_id, count(*) FROM indoor.corridor_boundary_points_m GROUP BY level_id ORDER BY 1;
 
 
-- ---------------------------------------------------------------------------
-- 2.4  Voronoi diagram of the boundary points, clipped to the corridor
--      polygon. This approximates the medial axis (centerline) of the
--      corridor space — computed in metric CRS for correct proportions.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS indoor.corridor_skeleton_raw;
CREATE TABLE indoor.corridor_skeleton_raw AS
SELECT cp.level_id,
       ST_Intersection(
           ST_VoronoiLines(ST_Collect(bp.geom), 0.01),
           ST_Transform(cp.geom, 32638)
       ) AS geom
FROM indoor.corridor_polygons cp
JOIN indoor.corridor_boundary_points_m bp ON bp.level_id = cp.level_id
GROUP BY cp.level_id, cp.geom;
 
-- ✅ CHECK: should be a (multi)linestring / geometrycollection per floor, non-empty
SELECT level_id, ST_GeometryType(geom), ST_IsEmpty(geom) FROM indoor.corridor_skeleton_raw;
 
 
-- ---------------------------------------------------------------------------
-- 2.5  Keep only genuine line fragments (not points/tiny artifacts).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS indoor.corridor_skeleton_lines;
CREATE TABLE indoor.corridor_skeleton_lines (
    id       bigserial PRIMARY KEY,
    level_id text,
    geom     geometry(LineString, 32638)
);
INSERT INTO indoor.corridor_skeleton_lines (level_id, geom)
SELECT level_id, (ST_Dump(ST_CollectionExtract(geom, 2))).geom
FROM indoor.corridor_skeleton_raw;
 
-- Drop true zero-length degenerate fragments only (not a general short-edge
-- filter — those are handled properly below by dangle-pruning instead).
DELETE FROM indoor.corridor_skeleton_lines WHERE ST_Length(geom) < 0.01;
 
-- ✅ CHECK: line count per floor
SELECT level_id, count(*) FROM indoor.corridor_skeleton_lines GROUP BY level_id ORDER BY 1;
 
-- ---------------------------------------------------------------------------
-- 2.5b  Prune dangling spurs (dead-end whiskers), NOT short bridges.
--
--       This is the fix for the fan/whisker artifacts in the screenshot: an
--       edge only gets removed if it is BOTH short AND a dead end (one of
--       its endpoints touches no other edge). A short edge that connects two
--       parts of the network (both endpoints have degree >= 2) is never
--       touched, no matter how short — that's what the earlier blunt
--       "< 0.5m" delete got wrong, and why it broke real connections.
--
--       Runs several passes because trimming one whisker can expose a new,
--       now-shorter dangling stub behind it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    pass       int;
    removed    int;
    min_len    double precision := 0.5;  -- whiskers shorter than 0.5m get trimmed
    max_passes int := 8;
BEGIN
    FOR pass IN 1..max_passes LOOP
        WITH endpoints AS (
            SELECT id, ST_StartPoint(geom) AS pt FROM indoor.corridor_skeleton_lines
            UNION ALL
            SELECT id, ST_EndPoint(geom) AS pt FROM indoor.corridor_skeleton_lines
        ),
        degree AS (
            SELECT pt, count(*) AS deg FROM endpoints GROUP BY pt
        ),
        dangles AS (
            SELECT s.id
            FROM indoor.corridor_skeleton_lines s
            JOIN degree d1 ON d1.pt = ST_StartPoint(s.geom)
            JOIN degree d2 ON d2.pt = ST_EndPoint(s.geom)
            WHERE (d1.deg = 1 OR d2.deg = 1)   -- at least one dead end
              AND ST_Length(s.geom) < min_len   -- short whisker, not a real corridor stub
        )
        DELETE FROM indoor.corridor_skeleton_lines s USING dangles d WHERE s.id = d.id;
 
        GET DIAGNOSTICS removed = ROW_COUNT;
        RAISE NOTICE 'pass %: removed % dangling edges', pass, removed;
        EXIT WHEN removed = 0;
    END LOOP;
END $$;
 
-- ✅ CHECK: line count per floor after pruning — should have dropped
--    noticeably from the pre-prune count above, but NOT gutted the network
--    (compare visually in QGIS if possible: should look like a connected
--    corridor spine, not disconnected fragments)
SELECT level_id, count(*) FROM indoor.corridor_skeleton_lines GROUP BY level_id ORDER BY 1;
 
 
-- ---------------------------------------------------------------------------
-- 2.6  Node the skeleton — split lines at every crossing so they share exact
--      vertices at junctions (mandatory for pgr_extractVertices, which has
--      NO snapping tolerance of its own).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS indoor.corridor_noded;
CREATE TABLE indoor.corridor_noded AS
SELECT level_id, (ST_Dump(ST_Node(ST_Collect(geom)))).geom AS geom
FROM indoor.corridor_skeleton_lines
GROUP BY level_id;
 
-- ✅ CHECK: line count should be >= the pre-noded count (junctions get split)
SELECT level_id, count(*) FROM indoor.corridor_noded GROUP BY level_id ORDER BY 1;
 
 
-- ---------------------------------------------------------------------------
-- 2.7  Snap to a fine grid (kills floating-point jitter from the two CRS
--      transforms) and load into indoor.raw_corridors as the final,
--      exact-match-ready corridor centerlines.
-- ---------------------------------------------------------------------------
TRUNCATE indoor.raw_corridors CASCADE;
 
INSERT INTO indoor.raw_corridors (level_id, geom)
SELECT level_id,
       ST_SnapToGrid(ST_Transform(ST_SnapToGrid(geom, 0.001), 4326), 0.0000001)
FROM indoor.corridor_noded
WHERE ST_Length(geom) > 0.02;  -- only drops truly degenerate slivers from the
                                -- snap/transform step, NOT a real filter —
                                -- dangle-pruning in 2.5b already handled that
 
-- ✅ CHECK: should roughly match the noded count from step 2.6
SELECT level_id, count(*) FROM indoor.raw_corridors GROUP BY level_id ORDER BY 1;
 
-- ✅ CHECK: 0 zero-length or null geometries
SELECT count(*) FROM indoor.raw_corridors WHERE geom IS NULL OR ST_Length(geom) = 0;
 
 
-- ---------------------------------------------------------------------------
-- 2.8  If this is a RE-RUN after fixing the corridor derivation (rather than
--      a first run), clear the downstream tables before rebuilding topology —
--      otherwise Part 3 layers new data on top of the old, broken topology.
--      Safe to run even on a first pass (everything will just be empty).
-- ---------------------------------------------------------------------------
TRUNCATE indoor.nodes CASCADE;
TRUNCATE indoor.edges CASCADE;
UPDATE indoor.units SET entry_node_id = NULL, vertical_group_id = NULL;
UPDATE indoor.raw_corridors SET source = NULL, target = NULL;
 
-- ✅ CHECK: all three should be 0
SELECT count(*) FROM indoor.nodes;
SELECT count(*) FROM indoor.edges;
SELECT count(*) FROM indoor.units WHERE entry_node_id IS NOT NULL;
 
 
-- #############################################################################
-- PART 3 — BUILD TOPOLOGY WITH pgr_extractVertices (per floor)
--
-- pgr_extractVertices matches edge endpoints by EXACT geometry equality and
-- does not write source/target back onto the edge table itself — both
-- differences from the deprecated pgr_createTopology. It also has no concept
-- of "floor", so it MUST be run once per level_id — running it across all
-- floors at once risks merging same-shaped junctions between different
-- floors (which share the same lon/lat since the building is stacked).
--
-- Two versions of the same logic follow — RUN ONLY ONE OF THEM:
--   3.1-3.3 LOOP VERSION     — automates the 6-floor repeat, use this normally
--   3.1-3.3 MANUAL VERSION   — kept below for reference/debugging one floor
--                              at a time (e.g. if the loop reports a problem
--                              on a specific level_id and you want to step
--                              through just that one by hand)
-- #############################################################################
 
-- =============================================================================
-- 3.1-3.3  LOOP VERSION (recommended)
-- =============================================================================
DO $$
DECLARE
    lvl        text;
    levels     text[] := ARRAY['SPL.HQ.L0','SPL.HQ.L1','SPL.HQ.L2',
                                 'SPL.HQ.L3','SPL.HQ.L4','SPL.HQ.L5'];
    inner_sql  text;
    vcount     int;
BEGIN
    FOREACH lvl IN ARRAY levels LOOP
        RAISE NOTICE 'Processing level: %', lvl;
 
        -- 3.1  Extract this floor's vertices from its corridor edges.
        DROP TABLE IF EXISTS stg_vertices;
        inner_sql := format(
            'SELECT id, geom FROM indoor.raw_corridors WHERE level_id = %L ORDER BY id',
            lvl
        );
        EXECUTE format('CREATE TABLE stg_vertices AS SELECT * FROM pgr_extractVertices(%L)', inner_sql);
 
        GET DIAGNOSTICS vcount = ROW_COUNT;
        RAISE NOTICE '  extracted % vertices', vcount;
 
        -- 3.2  Insert this floor's vertices into the global nodes table.
        INSERT INTO indoor.nodes (level_id, node_type, geom)
        SELECT lvl, 'corridor_junction', geom FROM stg_vertices;
 
        -- 3.3  Set source/target on this floor's corridor edges by matching
        --      endpoint geometry to the nodes just inserted (scoped to this
        --      level_id so it can't accidentally match a node on another floor).
        UPDATE indoor.raw_corridors e
        SET source = n.id
        FROM indoor.nodes n
        WHERE e.level_id = lvl AND n.level_id = lvl
          AND n.node_type = 'corridor_junction'
          AND ST_StartPoint(e.geom) = n.geom;
 
        UPDATE indoor.raw_corridors e
        SET target = n.id
        FROM indoor.nodes n
        WHERE e.level_id = lvl AND n.level_id = lvl
          AND n.node_type = 'corridor_junction'
          AND ST_EndPoint(e.geom) = n.geom;
    END LOOP;
 
    DROP TABLE IF EXISTS stg_vertices;
END $$;
 
-- ✅ CHECK: should be 0 across ALL floors — anything left NULL means an
--    endpoint didn't exactly match a node (usually a grid-snap edge case;
--    re-run step 2.7 with a coarser snap grid if this isn't 0)
SELECT level_id, count(*) FROM indoor.raw_corridors
WHERE source IS NULL OR target IS NULL
GROUP BY level_id ORDER BY 1;
 
-- ✅ CHECK: vertex count per floor (sanity: a few dozen to a few hundred per
--    floor for a building this size, not 0 and not tens of thousands)
SELECT level_id, count(*) FROM indoor.nodes
WHERE node_type = 'corridor_junction' GROUP BY level_id ORDER BY 1;
 
 
-- =============================================================================
-- 3.1-3.3  MANUAL VERSION (reference / single-floor debugging only — skip
-- this whole section if you ran the loop above)
-- =============================================================================
 
-- ---------------------------------------------------------------------------
-- 3.1  Extract this floor's vertices from its corridor edges.
--      >>> Change 'SPL.HQ.L0' below before each run. <<<
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS stg_vertices;
SELECT * INTO stg_vertices
FROM pgr_extractVertices(
    'SELECT id, geom FROM indoor.raw_corridors WHERE level_id = ''SPL.HQ.L0'' ORDER BY id'
);
 
-- ✅ CHECK: vertex count for this floor (sanity: should be a few dozen to a
--    few hundred for a floor this size, not 0 and not tens of thousands)
SELECT count(*) FROM stg_vertices;
 
-- ---------------------------------------------------------------------------
-- 3.2  Insert this floor's vertices into the global nodes table.
-- ---------------------------------------------------------------------------
INSERT INTO indoor.nodes (level_id, node_type, geom)
SELECT 'SPL.HQ.L0', 'corridor_junction', geom FROM stg_vertices;
 
-- ---------------------------------------------------------------------------
-- 3.3  Set source/target on this floor's corridor edges by matching endpoint
--      geometry to the nodes just inserted (scoped to this level_id so it
--      can't accidentally match a node on a different floor).
-- ---------------------------------------------------------------------------
UPDATE indoor.raw_corridors e
SET source = n.id
FROM indoor.nodes n
WHERE e.level_id = 'SPL.HQ.L0' AND n.level_id = 'SPL.HQ.L0'
  AND n.node_type = 'corridor_junction'
  AND ST_StartPoint(e.geom) = n.geom;
 
UPDATE indoor.raw_corridors e
SET target = n.id
FROM indoor.nodes n
WHERE e.level_id = 'SPL.HQ.L0' AND n.level_id = 'SPL.HQ.L0'
  AND n.node_type = 'corridor_junction'
  AND ST_EndPoint(e.geom) = n.geom;
 
-- ✅ CHECK: should be 0 for this floor — anything left NULL means an
--    endpoint didn't exactly match a node (usually a grid-snap edge case;
--    re-run step 2.7 with a coarser snap grid if this isn't 0)
SELECT count(*) FROM indoor.raw_corridors
WHERE level_id = 'SPL.HQ.L0' AND (source IS NULL OR target IS NULL);
 
-- ---------------------------------------------------------------------------
-- Now repeat 3.1–3.3 five more times for:
--   SPL.HQ.L1, SPL.HQ.L2, SPL.HQ.L3, SPL.HQ.L4, SPL.HQ.L5
-- ---------------------------------------------------------------------------
 
 
-- ---------------------------------------------------------------------------
-- 3.4  Once ALL 6 floors are done: copy topologized corridor edges into the
--      global indoor.edges table, with cost = walking time in seconds
--      (1.2 m/s average indoor walking speed).
-- ---------------------------------------------------------------------------
INSERT INTO indoor.edges (source, target, cost, reverse_cost, edge_type, level_id, geom)
SELECT source, target,
       ST_Length(geom::geography) / 1.2,
       ST_Length(geom::geography) / 1.2,
       'corridor', level_id, geom
FROM indoor.raw_corridors
WHERE source IS NOT NULL AND target IS NOT NULL AND source <> target;
 
-- ✅ CHECK: should roughly match total row count of indoor.raw_corridors
SELECT count(*) FROM indoor.edges WHERE edge_type = 'corridor';
SELECT level_id, count(*) FROM indoor.edges WHERE edge_type = 'corridor' GROUP BY level_id ORDER BY 1;
 
 
-- #############################################################################
-- PART 4 — CONNECT ROOMS TO THE CORRIDOR NETWORK
-- #############################################################################
 
-- ---------------------------------------------------------------------------
-- 4.1  Create a "room_entry" node at each unit's centroid.
--      Joined via the surrogate `id`, NOT unit_id (unit_id repeats — see
--      Part 1 note — so it can never be a safe join key).
-- ---------------------------------------------------------------------------
INSERT INTO indoor.nodes (level_id, node_type, unit_pk, geom)
SELECT level_id, 'room_entry', id, centroid FROM indoor.units;
 
UPDATE indoor.units u
SET entry_node_id = n.id
FROM indoor.nodes n
WHERE n.unit_pk = u.id AND n.node_type = 'room_entry';
 
-- ✅ CHECK: should equal total unit count (1643)
SELECT count(*) FROM indoor.units WHERE entry_node_id IS NOT NULL;
 
-- ---------------------------------------------------------------------------
-- 4.2  Connect each room_entry node to the NEAREST corridor_junction node on
--      the SAME floor, within 50m. This is the "room_connector" edge.
-- ---------------------------------------------------------------------------
INSERT INTO indoor.edges (source, target, cost, reverse_cost, edge_type, level_id, geom)
SELECT re.id, cj.id,
       GREATEST(ST_Distance(re.geom::geography, cj.geom::geography), 1.0) / 1.2,
       GREATEST(ST_Distance(re.geom::geography, cj.geom::geography), 1.0) / 1.2,
       'room_connector', re.level_id,
       ST_MakeLine(re.geom, cj.geom)
FROM indoor.nodes re
CROSS JOIN LATERAL (
    SELECT id, geom
    FROM indoor.nodes cj2
    WHERE cj2.level_id = re.level_id AND cj2.node_type = 'corridor_junction'
    ORDER BY cj2.geom <-> re.geom
    LIMIT 1
) cj
WHERE re.node_type = 'room_entry'
  AND ST_Distance(re.geom::geography, cj.geom::geography) < 50;
 
-- ✅ CHECK: how many rooms got connected — compare to total unit count.
--    Anything missing likely means the corridor skeleton doesn't reach that
--    room; go back and check corridor_polygons/corridor_skeleton for that floor.
SELECT count(DISTINCT u.unit_id) AS connected
FROM indoor.units u
JOIN indoor.edges e ON e.source = u.entry_node_id AND e.edge_type = 'room_connector';
 
SELECT u.id, u.unit_id, u.level_id, u.name
FROM indoor.units u
LEFT JOIN indoor.edges e ON e.source = u.entry_node_id AND e.edge_type = 'room_connector'
WHERE e.id IS NULL;
 
 
-- #############################################################################
-- PART 5 — VERTICAL LINKS (stairs / elevators across floors)
-- #############################################################################
 
-- ---------------------------------------------------------------------------
-- 5.1  Elevators & elevator lobbies: NAME is identical across every floor
--      in this dataset (confirmed: A–F elevators, "ELEVATOR LOBBY"), so
--      match directly by (use_type, name).
-- ---------------------------------------------------------------------------
WITH grp AS (
    SELECT use_type, name, dense_rank() OVER (ORDER BY use_type, name) AS gid
    FROM (SELECT DISTINCT use_type, name FROM indoor.units
          WHERE use_type IN ('Elevator', 'Elevator Lobby')) t
)
UPDATE indoor.units u
SET vertical_group_id = g.gid + 1000   -- offset so it can't collide with stair cluster ids below
FROM grp g
WHERE u.use_type = g.use_type AND u.name = g.name;
 
-- ---------------------------------------------------------------------------
-- 5.2  Stairs: NAME differs per floor, so cluster by horizontal proximity —
--      the same physical stairwell stacks at (nearly) the same x/y on every
--      floor. eps ≈ 3m.
-- ---------------------------------------------------------------------------
WITH clustered AS (
    SELECT unit_id,
           ST_ClusterDBSCAN(centroid, eps := 0.00003, minpoints := 1) OVER () AS cid
    FROM indoor.units WHERE use_type = 'Stairs'
)
UPDATE indoor.units u SET vertical_group_id = c.cid
FROM clustered c WHERE u.unit_id = c.unit_id;
 
-- ✅ CHECK: each group should list 2+ floors (a group appearing on only 1
--    floor won't get any vertical edges — that's expected for isolated cases)
SELECT vertical_group_id, use_type, name, array_agg(level_id ORDER BY floor_id) AS floors
FROM indoor.units
WHERE vertical_group_id IS NOT NULL
GROUP BY vertical_group_id, use_type, name
ORDER BY 1;
 
-- ---------------------------------------------------------------------------
-- 5.3  Add a near-zero-cost vertical edge between each group's entry nodes
--      on ADJACENT floors only (floor_id and floor_id+1) — per your choice,
--      taking stairs/elevator isn't penalized as a time cost.
-- ---------------------------------------------------------------------------
INSERT INTO indoor.edges (source, target, cost, reverse_cost, edge_type,
                           from_level_id, to_level_id, group_id)
SELECT a.entry_node_id, b.entry_node_id, 1.0, 1.0, 'vertical', a.level_id, b.level_id,
       a.vertical_group_id
FROM indoor.units a
JOIN indoor.units b
    ON a.vertical_group_id = b.vertical_group_id
   AND b.floor_id = a.floor_id + 1
WHERE a.vertical_group_id IS NOT NULL
  AND a.entry_node_id IS NOT NULL AND b.entry_node_id IS NOT NULL;
 
-- ✅ CHECK: should be roughly (number of shafts) x (5 floor-gaps)
SELECT count(*) FROM indoor.edges WHERE edge_type = 'vertical';
 
 
-- #############################################################################
-- PART 6 — FINAL SANITY CHECK
-- #############################################################################
 
-- Overall edge breakdown
SELECT edge_type, count(*) FROM indoor.edges GROUP BY edge_type;
 
-- Try a real route between two rooms on different floors via pgr_dijkstra
-- (swap in two real surrogate `id` values from indoor.units on different floors —
-- NOT unit_id, since it's not unique)
-- SELECT * FROM pgr_dijkstra(
--   'SELECT id, source, target, cost, reverse_cost FROM indoor.edges',
--   (SELECT entry_node_id FROM indoor.units WHERE id = 123),
--   (SELECT entry_node_id FROM indoor.units WHERE id = 456),
--   directed => false
-- );
 
-- Optional cleanup of staging tables once everything checks out:
-- DROP TABLE IF EXISTS indoor.units_raw, indoor.floor_plates,
--                       indoor.corridor_polygons, indoor.corridor_boundary_points_m,
--                       indoor.corridor_skeleton_raw, indoor.corridor_skeleton_lines,
--                       indoor.corridor_noded, stg_vertices;
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
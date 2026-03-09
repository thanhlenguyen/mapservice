, for# Self-Hosted Map System using PostGIS, Martin, and TileServer-GL

This guide outlines the steps to replace Mapbox in a localhost environment using a stack of open-source tools for serving static and dynamic vector tiles, and integrating a custom geocoding/POI search and an AI-powered API layer.

## Phase 1: Foundation - Database and Environment Setup

We will use Docker Compose to manage all services (PostGIS, Martin, TileServer-GL).

- Table structure
```
mapserver/
├── docker-compose.yml          # Orchestrates PostGIS, Martin, and TileServer-GL
├── .env                        # Environment variables for security (DB creds, etc.)
├── martin-config.yml           # Martin configuration for PostGIS sources
├── tileserver/
│   ├── config.json             # TileServer-GL config for serving MBTiles
│   └── styles/
│       └── style.json          # Mapbox GL style for rendering layers (MBTiles + dynamic POIs)
└── data/
    ├── mbtiles/                # Your MBTiles files (place them here)
    │   ├── Administrative.mbtiles
    │   ├── Administrative_label.mbtiles
    │   ├── City_District_Zone.mbtiles
    │   └── address_layer.mbtiles
    └── pois.geojson         # Demo POIs CSV for Riyadh (insert into PostGIS later)
```

### Step 1: Install Docker and Docker Compose

Ensure you have Docker and Docker Compose (or Docker Desktop) installed on your system.
We have to use WSL2 to install docker 

- Remove all volume on docker:
```bash
docker compose down
docker volume ls
docker volume rm {volume name}
```

### Step 2: Create script to set up system

We need a robust PostgreSQL database with the PostGIS extension enabled. This will store your custom POI data and power the dynamic maps served by Martin.

- Create a ```docker-compose.yml``` file for your entire stack.

```bash
# dockerversion: '3.9'

services:
  postgis:
    image: postgis/postgis:16-3.4          # stable, recent version
    container_name: postgis_db
    restart: unless-stopped
    env_file:
      - .env
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    ports:
      - "5432:5432"
    volumes:
      - postgis_data:/var/lib/postgresql/data
      - ./data:/data                     # for CSV import later
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 10

  martin:
    image: ghcr.io/maplibre/martin:latest   # official image
    container_name: martin_server
    restart: unless-stopped
    env_file:
      - .env                                 # expose DB vars to Martin
    ports:
      - "3000:3000"
    volumes:
      - ./martin-config.yml:/config.yml:ro
    depends_on:
      postgis:
        condition: service_healthy
    command: --config /config.yml

  tileserver-gl:
    image: maptiler/tileserver-gl:latest
    container_name: tileserver_gl
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - ./tileserver:/tileserver:ro       # config.json + styles/
      - ./data/mbtiles:/data/mbtiles:ro  # mbtiles files
    command: --config /tileserver/config.json --verbose

  pgadmin:
    image: dpage/pgadmin4:latest
    container_name: pgadmin4
    restart: always
    env_file: 
      - .env    
    environment:
      - PGADMIN_DEFAULT_EMAIL=${PGADMIN_EMAIL:-admin@admin.com}
      - PGADMIN_DEFAULT_PASSWORD=${PGADMIN_PASSWORD:-admin}
    ports:
      - "5050:80"
    depends_on:
      - postgis

volumes:
  vsol: # name of the volume in docker

``` 
- Create a ```martin-config.yml``` file in root folder (same folder with docker-compose.yml) to connect data in postgis

```bash
# Connection keep alive timeout [default: 75]
keep_alive: 75

# The socket address to bind [default: 0.0.0.0:3000]
listen_addresses: '0.0.0.0:3000'

# Set TileJSON URL path prefix.
# This overrides the default of respecting the X-Rewrite-URL header.
# Only modifies the JSON (TileJSON) returned; Martin's API-URLs remain unchanged.
# If you need to rewrite URLs, please use a reverse proxy.
# Must begin with a `/`.
# Examples: `/`, `/tiles`
base_path: /tiles

# Number of web server workers
worker_processes: 8

# Amount of memory (in MB) to use for caching tiles [default: 512, 0 to disable]
cache_size_mb: 1024

# Which compression should be used if the
# - client accepts multiple compression formats, and
# - tile source is not pre-compressed.
#
# `gzip` is faster, but `brotli` is smaller, and may be faster with caching.
# Default could be different depending on Martin version.
preferred_encoding: gzip

# Enable or disable Martin web UI. [default: disable]
#
# At the moment, only allows `enable-for-all`, which enables the web UI for all connections.
# This may be undesirable in a production environment
web_ui: enable-for-all

# Advanced monitoring options
observability:
  # Configure metrics reported under `/_/metrics`
  metrics:
    # Add these labels to every metric
    # Example: `{ env: prod, server: martin }`
    add_labels: {}

# CORS Configuration
#
# Defaults to `cors: true`, which allows all origins.
# Sending/Acting on CORS headers can be completely disabled via `cors: false`
cors: 
  # Sets the `Access-Control-Allow-Origin` header [default: *]
  # '*' will use the requests `ORIGIN` header
  origin: 
    - "*"
  # Sets `Access-Control-Max-Age` Header. [default: null]
  # null means not setting the header for preflight requests
  max_age: 3600

# Database configuration. This can also be a list of PG configs.
postgres:
  # Database connection string.
  #
  # You can use environment variables too, for example:
  # connection_string: $DATABASE_URL
  # connection_string: ${DATABASE_URL:-postgres://postgres@localhost/db}
  connection_string: 'postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}?sslmode=disable'
  default_srid: 4326
  # Enable automatic discovery of tables and functions.
  # Enable automatic discovery of tables
  auto_publish:
    tables:
      # Limit to the topology schema
      from_schemas:
        - topology
      # Define source ID format
      source_id_format: '{schema}.{table}'
      # Assume geometry column is named 'geom'
      id_columns: id
      clip_geom: true
      buffer: 64
      extent: 4096
      bounds: [38, 20, 47, 27]-----------------------------------------------------

```
- Create ```.env``` to store secret parameters:
```bash
# PostGIS Database
POSTGRES_DB=geodb
POSTGRES_USER=le
POSTGRES_PASSWORD=123456

# Martin/PostGIS Connection (used in martin-config.yml)
POSTGRES_HOST=postgis
POSTGRES_PORT=5432

#PGAdmin Credentials
PGADMIN_EMAIL=admin@admin.com
PGADMIN_PASSWORD=admin
```
- Create ```config.json``` file to render mbtiles files in TileServer
```json
{
  "options": {
    "paths": {
      "root": "/tileserver",
      "fonts": "fonts",
      "sprites": "sprites",
      "styles": "styles",
      "mbtiles": "/data/mbtiles"
    },
    "domains": [
      "localhost:8080",
      "127.0.0.1:8080"
    ],
    "formatQuality": {
      "jpeg": 80,
      "webp": 90
    },
    "maxScaleFactor": 3,
    "maxSize": 2048,
    "pbfAlias": "pbf",
    "serveAllFonts": false,
    "serveAllStyles": false,
    "serveStaticMaps": true,
    "staticAttributionText": "© OpenMapTiles © OpenStreetMap contributors"
  },
  "styles": {
    "ksa-style": {
      "style": "style.json",
      "tilejson": {
            "type": "overlay",
            "bounds": [-180, -85.0511, 180, 85.0511]
      }
    }      
  },
  "data": {
    "Administrative": {
      "mbtiles": "Administrative.mbtiles"
    },
    "Administrative_label": {
      "mbtiles": "Administrative_label.mbtiles"
    },
    "City_District_Zone": {
      "mbtiles": "City_District_Zone.mbtiles"
    },
    "address_layer": {
      "mbtiles": "address_layer.mbtiles"
    }
  }
}
```
- Create ```style.json``` file to render data
```json
{
  "version": 8,
  "name": "Riyadh MBTiles + Dynamic POIs",
  "center": [46.6753, 24.7136],
  "zoom": 10,
  "sources": {
    "osm": {
      "type": "raster",
      "tiles": ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
      "tileSize": 256,
      "attribution": "© CARTO"
    },
    "administrative": {
      "type": "vector",
      "url": "mbtiles://Administrative"
    },
    "administrative_label": {
      "type": "vector",
      "url": "mbtiles://Administrative_label"
    },
    "city_district_zone": {
      "type": "vector",
      "url": "mbtiles://City_District_Zone"
    },
    "address_layer": {
      "type": "vector",
      "url": "mbtiles://address_layer"
    },
    "pois": {
      "type": "vector",
      "tiles": ["http://localhost:3000/topology.places/{z}/{x}/{y}"],  //very important 
      "minzoom": 10,
      "maxzoom": 22  
    }
  },
  "glyphs": "http://localhost:8080/fonts/{fontstack}/{range}.pbf",
  "sprite": "https://openmaptiles.github.io/osm-bright-gl-style/sprite",

  "layers": [
    {
      "id": "osm-base",
      "type": "raster",
      "source": "osm",
      "minzoom": 0,
      "maxzoom": 22,
      "layout": {"visibility": "visible"}
    },
    {
      "id": "emirate-line",
      "type": "line",
      "source": "administrative",
      "source-layer": "Emirate",
      "minzoom": 4,
      "maxzoom": 14,
      "layout": {"visibility": "visible"},
      "paint": {
        "line-color": "#675757",
        "line-dasharray": [3, 3, 1, 1],
        "line-width": 1.5
      }
    },
    {
      "id": "governorate-line",
      "type": "line",
      "source": "administrative",
      "source-layer": "Governorate",
      "minzoom": 6,
      "maxzoom": 14,
      "layout": {"visibility": "visible"},
      "paint": {
        "line-color": "#16161A",
        "line-width": 1,
        "line-dasharray": [2, 2, 1, 1]
      }
    },
    {
        "id": "emirate-label",
      "type": "symbol",
      "source": "administrative_label",
      "source-layer": "Emirate_Label",
      "minzoom": 3,
      "maxzoom": 16,
      "layout": {
        "text-field": ["get", "EnglishName"],
        "text-font": ["Open Sans Bold"],
        "text-size": 14,
        "text-anchor": "center",
        "visibility": "visible"
      },
      "paint": {
        "text-color": "#0B0BE6",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1,
        "text-translate-anchor": "viewport"
      }
    },
    {
       "id": "governorate-label",
      "type": "symbol",
      "source": "administrative_label",
      "source-layer": "Governorate_Label",
      "minzoom": 7,
      "maxzoom": 16,
      "layout": {
        "text-field": ["get", "EnglishName"],
        "text-font": ["Open Sans Regular"],
        "text-size": 12,
        "text-anchor": "center",
        "visibility": "visible"
      },
      "paint": {
        "text-color": "#161639",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1
      }
    },
    {
      "id": "city-line",
      "type": "line",
      "source": "city_district_zone",
      "source-layer": "CityBoundary",
      "minzoom": 6,
      "maxzoom": 18,
      "layout": {"visibility": "visible"},
      "paint": {
        "line-color": "#354635",
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 2, 10, 2],
        "line-dasharray": [3, 3, 3, 1, 1]
      }
    },
    {
      "id": "city-label",
      "type": "symbol",
      "source": "city_district_zone",
      "source-layer": "CityCenter",
      "minzoom": 10,
      "maxzoom": 19,
      "layout": {
        "text-field": ["get", "EnglishName"],
        "text-font": ["Open Sans Bold"],
        "text-size": 10,
        "text-anchor": "center",
        "visibility": "visible"
      },
      "paint": {
        "text-color": "rgba(16, 16, 214, 1)",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1
      }
    },
    {
      "id": "citycenter-point",
      "type": "symbol",
      "source": "city_district_zone",
      "source-layer": "CityCenter",
      "minzoom": 11,
      "layout": {"icon-image": "circle_stroked_11"},
      "paint": {}      
    },
    {
      "id": "district-line",
      "type": "line",
      "source": "city_district_zone",
      "source-layer": "District",
      "minzoom": 8,
      "maxzoom": 19,
      "layout": {"visibility": "visible"},
      "paint": {
        "line-color": "#9AB4F5", 
        "line-width": 1}
    },   
    {
      "id": "zone-line",
      "type": "line",
      "source": "city_district_zone",
      "source-layer": "ZipCode",
      "minzoom": 12,
      "maxzoom": 22,
      "layout": {"visibility": "visible"},
      "paint": {
        "line-color": "#461A67", 
        "line-width": 1}

    },
    {
      "id": "zone-label",
      "type": "symbol",
      "source": "city_district_zone",
      "source-layer": "ZipCode",
      "minzoom": 12,
      "maxzoom": 22,
      "layout": {
        "text-field": ["get", "SPZipCodeNo"],
        "text-font": ["Open Sans Regular"],
        "text-anchor": "center",
        "text-allow-overlap": false,
        "text-ignore-placement": false,
        "text-padding": 5,
        "visibility": "visible",
        "text-size": 9
      },
      "paint": {
        "text-color": "#1745CE",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1
    } 
  },
    
    {
      "id": "address-3d",
      "type": "fill-extrusion",
      "source": "address_layer",
      "source-layer": "Short_Address",
      "minzoom": 14,
      "layout": {"visibility": "visible"},
      "paint": {
        "fill-extrusion-height": [
          "case",
          [
            "any",
            ["==", ["get", "LandTypeID"], 5001],
            ["==", ["get", "LandTypeID"], 8001],
            ["==", ["get", "LandTypeID"], 7002]
          ],
          0,
          ["==", ["get", "NoOfFloor"], null],
          4,
          ["*", ["get", "NoOfFloor"], 3]
        ],
        "fill-extrusion-color": "#ECE5E5",
        "fill-extrusion-opacity": 0.75
      }
    },
    {
      "id": "address-label",
      "type": "symbol",
      "source": "address_layer",
      "source-layer": "Short_Address",
      "minzoom": 16,
      "layout": {
        "text-field": ["get", "ShortAddress"],
        "text-font": ["Open Sans Regular"],
        "text-anchor": "center",
        "text-offset": [0, 1],
        "visibility": "visible",
        "text-size": 9
      },
      "paint": {
        "text-color": "#000000",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1
      }
    },
    {
      "id": "poi-label",
      "type": "symbol",
      "source": "pois",
      "source-layer": "topology.places",
      "minzoom": 10,
      "layout": {
        "icon-image": ["concat", ["get", "maki"],"_11"], # very importance to render
        "icon-size": 1,
        "icon-allow-overlap": true,
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Regular"],
        "text-anchor": "top",
        "text-offset": [0, 0.6],
        "visibility": "visible",
        "text-size": 10
      },
      "paint": {
        "text-color": [
            "match",
            ["get", "class"],
            ["food_and_drink_stores", "food_and_drink"],
            "#b64f1b",
            ["education"],
            "#5c4923",
            ["store_like"],
            "#8e5a57",
            "#78553a"
          ],
        "text-halo-color": "#ffffff",
        "text-halo-width": 0.5
      }
    }
      
  ]
}
```
### Step 3: Start the Foundation

Run the following command from the directory containing your docker-compose.yml:

```bash
docker compose up -d
```
## Note:
- Check logs of container to see if we have any issue:

```bash
docker compose logs container_name
```
- martin_server is restarting because it cannot connect to PostGIS (the connection string is wrong or it is not created yet `CREATE EXTENTION IF NOT EXISTS Postgis`): please check in ```martin-config.yml``` (because of martin connects with postgis inside docker so ```POSTGRES_HOST``` is not ```localhost```), and also need to install Pos
- ```volumes: - ./tileserver:/data:ro```: defines a data storage area that exists outside the container’s temporary filesystem. (```./tileserver```: Folder on your host computer (relative to the YAML file), ```/data```: Folder inside the container)

## Phase 2: Static Maps (Basemap) with TileServer-GL

This component serves pre-rendered vector tiles from an MBTiles file for your basemap (e.g., roads, land use, boundaries).

### Step 4: Acquire MBTiles Data or do it as your own

Download an OpenStreetMap (OSM) based vector MBTiles file for your region of interest. You can:

1. Download: Use a service like OpenMapTiles (check their usage terms) to get a free sample.

2. Generate: Use an open-source tool like Planetiler or OSM2VectorTiles to generate an MBTiles file from raw OSM data.

- Example: Save your .mbtiles file into the ./data/tiles directory created in Step 2. (create  /data/tiles inside project folder) In this case, they are already created.

You can use tippicanoe to convert geojson file to mbtiles file

### Step 5: Configure TileServer-GL

tileserver-gl automatically detects MBTiles files in its /data folder.

Place your [your_region].mbtiles file in ./data/tiles/.

Access the server at http://localhost:8080. You should see your tiles being served.

Note the TileJSON URL (e.g., http://localhost:8080/data/[your_region]/tilejson.json). This is your static map source.

## Phase 3: Dynamic Maps (POI/Real-time) with Martin and PostGIS

This component generates vector tiles on-the-fly from raw data stored in PostGIS, making it ideal for dynamic, frequently updated data like POIs.

### Step 6: Load POI Data into PostGIS

You need a table in PostGIS with a geometry column.

- Get Data: Acquire a POI dataset (e.g., a GeoJSON or Shapefile of your specific points of interest).

- Load Data: Use a tool like ogr2ogr or a PostGIS management tool (like pgAdmin) to import your data into the postgis_db container.

- Example SQL (to be run inside the container):
```sql
CREATE TABLE pois (
    id SERIAL PRIMARY KEY,
    name TEXT,
    category TEXT,
    geom GEOMETRY(Point, 4326)
);
-- ... INSERT statements or use pgAdmin/ogr2ogr to import data ...
```
1. Prepare data
- Prepare GeoJSON, shapefiles, or CSV with geometry (e.g., latitude/longitude or WKT)
- Save data in your project directory, e.g., /mnt/d/Git/mapserver/data/
2. Enable PostGIS Extension
Ensure the PostGIS extension is enabled in your database for geospatial functionality.

Connect to the database:
```bash
psql -h localhost -U le -d geodb -W
```
Enable PostGIS if needed:
```sql
CREATE EXTENSION IF NOT EXISTS postgis;  
```  
3. Import GeoJSON or Other Formats Using ogr2ogr
install ogr2ogr (part of GDAL): 
```bash
sudo apt install gdal-bin
```
- Import GeoJSON (most of time we use this task, we don't neet to configure anything in postgres):

Use ogr2ogr to load into PostGIS:
```bash
ogr2ogr -f PostgreSQL PG:"host=localhost user=le password=123456 dbname=geodb" \
-nln topology.places -nlt PROMOTE_TO_MULTI -lco GEOMETRY_NAME=geom \
/mnt/d/Git/mapserver/data/pois.geojson
```
Options:
```bash
-nln topology.places: Places table in topology schema.
-nlt PROMOTE_TO_MULTI: Ensures multi-geometry support.
-lco GEOMETRY_NAME=geom: Names geometry column geom (matches Martin’s default).
```
- Import Shapefile (Similar command):
```bash
ogr2ogr -f PostgreSQL PG:"host=localhost user=le password=123456 dbname=geodb" \
-nln topology.places -nlt PROMOTE_TO_MULTI -lco GEOMETRY_NAME=geom \
/mnt/d/Git/mapserver/data/sample.shp
```
- Import CSV with Lat/Lon:
If you have a CSV (e.g., pois.csv with columns name, lat, lon):

  - Copy to PostGIS:
```bash
sql -h localhost -U le -d geodb -W -c \
"\COPY topology.places (name, lat, lon) FROM '/mnt/d/Git/mapserver/data/pois.csv' DELIMITER ',' CSV HEADER;"
```
  - Add geometry column:
```sql
ALTER TABLE topology.places ADD COLUMN geom GEOMETRY(Point, 4326);
UPDATE topology.places SET geom = ST_SetSRID(ST_MakePoint(lon, lat), 4326);
```
Run `ogr2ogr` in Host:

If GDAL isn’t installed locally:
```bash
ogr2ogr:
  image: osgeo/gdal
  command: ogr2ogr -f PostgreSQL PG:"host=localhost user=le password=123456 dbname=geodb" \
  -nln topology.places -nlt PROMOTE_TO_MULTI -lco GEOMETRY_NAME=geom \
  /data/pois.geojson
  volumes:
    - /mnt/d/Git/mapserver/data:/data
  depends_on:
    - postgis
```
Run: ```docker compose run --rm ogr2ogr.```

### Step 7: Verify Data in PostGIS

Connect to the database:
```bash
-- Connect to the database:
psql -h localhost -U le -d geodb -W
-- List schema: 
\dn
-- List tables: 
\dt topology.*
-- Describe a table:
\d topology.places
```

Check data: 
```sql
SELECT name_cr_arabic, unit_type_en, ST_AsText(geom) FROM topology.places LIMIT 5;
```
Ensure SRID is 4326: ```SELECT ST_SRID(geom) FROM topology.places LIMIT 1;```

If not 4326, transform: ```ALTER TABLE topology.places ALTER COLUMN geom TYPE GEOMETRY(Point, 4326) USING ST_SetSRID(geom, 4326);```

### Step 8: Visualize Data Using GUI Tools
For a more user-friendly experience, use a GUI tool to browse and visualize the data.

- Open pgAdmin:

  Access: ```http://localhost:5050```, log in with admin@admin.com/admin.

- Connect pgAdmin to PostGIS:

  - Add a server:

    Host: ```postgis``` (Docker service name) 

    Database: ```geodb```

    Username: ```le```

    Password: ```123456```
    
    The rest are default


Browse topology schema, view tables, and run queries.
Use the “Query Tool” to run SQL like above or visualize geometries (pgAdmin 4 supports basic geometry rendering).


Alternative GUI: QGIS: Need to check how to connect from docker to localhost

Add a PostGIS connection:


### Step 9: Test with Martin
Since Martin is configured to use the topology schema:

Restart Martin: docker-compose restart martin.
Check catalog: ```http://localhost:3000/catalog```. It should list topology.layer, topology.places, etc.

Test a tile: ```curl http://localhost:3000/topology.places/0/0/0 --output tile.pbf```

Your dynamic POI TileJSON URL will look like: ```http://localhost:3000/topology.places``` 

## Step 10: Optimize for Your Use Case

```sql
-- POI Database: If focusing on POIs, create a view for Martin:
CREATE VIEW topology.poi_view AS
SELECT osm_id, name, amenity, geom
FROM topology.planet_osm_point
WHERE amenity IS NOT NULL;

-- Indexes: Improve query performance:
CREATE INDEX ON topology.planet_osm_point USING GIST (geom);
CREATE INDEX ON topology.places USING GIST (geom);

-- Clean Up: Drop unused tables or vacuum the database:
VACUUM ANALYZE topology.planet_osm_point;
```

## Phase 4: Build the Frontend App
Integrate maps, search, and AI in a web UI.

### Step 11 Add nginx service and config

- Update `docker-compose.yml` file
```bash
  nginx:
    image: nginx:alpine
    container_name: nginx
    restart: always
    ports:
      - "3001:80"
    volumes:
      - ./frontend:/usr/share/nginx/html
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - martin
      - tileserver-gl    
```
- Create `nginx.conf` file
```json
server {
    listen 80;
    server_name localhost;
    location / { 
        root /usr/share/nginx/html; 
        try_files $uri /index.html; 
        }
    location /tiles/ { 
        proxy_pass http://tileserver-gl:80/; 
        }
    location /martin/ { 
        proxy_pass http://martin_server:3000/; 
        }
}

``` 

### Step 12 Browse the result:
-  Create ```index.html``` with Maplibre:
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dynamic and Static Tile Viewer</title>
    <!-- Load Tailwind CSS for utility styling -->
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['Inter', 'sans-serif'],
                    },
                }
            }
        }
    </script>
    <!-- Load MapLibre GL JS -->
    <script src='https://unpkg.com/maplibre-gl@4.3.2/dist/maplibre-gl.js'></script>
    <link href='https://unpkg.com/maplibre-gl@4.3.2/dist/maplibre-gl.css' rel='stylesheet' />
    
    <style>
        /* Ensure the map occupies the entire viewport */
        #map {
            position: absolute;
            top: 0;
            bottom: 0;
            width: 100%;
            height: 100%;
        }
    </style>
</head>
<body class="font-sans antialiased overflow-hidden">

    <div id="map" class="shadow-lg"></div>

    <div class="fixed top-4 left-1/2 -translate-x-1/2 z-10 bg-white p-3 rounded-xl shadow-2xl border border-blue-100">
        <h1 class="text-lg font-bold text-gray-800">Map Visualization</h1>
        <p class="text-sm text-gray-600">Loading map style from <code class="bg-gray-100 p-1 rounded">http://localhost:8080</code></p>
    </div>

    <script>
        // Get the base style URL from the TileServer GL endpoint.
        // 'ksa-style' must match the key you defined in config.json's "styles" object.
        const styleUrl = 'http://localhost:8080/styles/ksa-style/style.json';
        
        // Define the initial view properties (based on Riyadh data provided previously)
        const initialCenter = [46.6753, 24.7136];
        const initialZoom = 10;
        
        // Function to initialize the map
        function initializeMap() {
            try {
                const map = new maplibregl.Map({
                    container: 'map', // ID of the map container
                    style: styleUrl,  // Load the complete style from TileServer GL
                    center: initialCenter,
                    zoom: initialZoom,
                    pitch: 0,
                    maxPitch: 85,
                    bearing: 0,
                    // Note: 'localhost:8080' is accessible in the browser context, 
                    // and MapLibre will correctly follow the style's internal URLs (mbtiles://...)
                });

                map.on('load', () => {
                    console.log('Map style loaded successfully. Static tiles and Martin POIs should be visible.');
                    // Example: Add a simple control
                    map.addControl(new maplibregl.NavigationControl(), 'top-right');
                });

                map.on('error', (e) => {
                    console.error('MapLibre GL Error:', e.error);
                    showErrorMessage('Failed to load map or style. Ensure tileserver-gl and martin are running and accessible at localhost:8080 and localhost:3000.');
                });

            } catch (error) {
                console.error('Map Initialization Error:', error);
                showErrorMessage('A critical error occurred during map setup.');
            }
        }

        // Simple message box (instead of alert)
        function showErrorMessage(message) {
            const container = document.getElementById('map');
            const errorBox = document.createElement('div');
            errorBox.className = 'fixed inset-0 bg-red-500 bg-opacity-90 flex items-center justify-center p-6 z-50';
            errorBox.innerHTML = `
                <div class="bg-white p-8 rounded-lg shadow-xl max-w-lg text-center">
                    <h2 class="text-2xl font-bold text-red-600 mb-4">Connection Error</h2>
                    <p class="text-gray-700 mb-6">${message}</p>
                    <p class="text-sm text-gray-500">Check your Docker containers and ensure they are reachable at their ports.</p>
                </div>
            `;
            container.appendChild(errorBox);
        }

        // Initialize the map on window load
        window.onload = initializeMap;

    </script>
</body>
</html>

```
- Serve via simple HTTP: 

Test: Visit http://localhost:3001. 

## Phase 5: Optimize Route with street data

### Step 13: Data preparation
1. Custom data
- With unclean data, we need to clean in QGIS first: the workflow to clean street for route optimisation as:
```
✔ Fix geometries
✔ Snap lines
✔ Fix geometries again if needed
✔ Detect intersections
✔ Clean duplicates
✔ Split lines at intersections
✔ (Optional) Reproject / measure / clean small segments
```
- We can use Model Designer in QGIS to automate process
![alt text](image.png)

2. Or Download & Import KSA Data
- Download and extract street shapefile to your project `data` folder
Download: [Saudi Arabia Roads (OSM Export)](https://data.humdata.org/dataset/hotosm_sau_roads) – ZIP with Shapefiles (~100 MB).

3. Import to PostGIS (runs on host, connects to your container)
- Use ogr2ogr to import data
```bash
ogr2ogr -f PostgreSQL PG:"host=localhost user=le password=123456 dbname=geodb" -nln topology.ways_raw -nlt PROMOTE_TO_MULTI -overwrite -lco GEOMETRY_NAME=geom /mnt/d/Git/mapserver/data/streets_riyadh.geojson
```
- In QGIS, we can use `Database -> DB Manager` to connect with PostgreSQL to import data
  
### Step 14: Enable pgRouting Extension 
- To create extension `pgrouting` we need to config a bit in docker-compose.yml
```bash
postgis:
    image: pgrouting/pgrouting:16-3.5-4.0               # PostGIS with pgRouting       
    container_name: postgis_db
```
- Access pgAdmin at http://localhost:5050 (login with your .env creds). Connect to postgis_db, then run:
```sql
CREATE EXTENSION IF NOT EXISTS pgrouting;
```
### Step 15: Build Routing Topology (Run Once via pgAdmin/psql)
Connect to your DB and Execute these commands in order (via pgAdmin or psql): (adapts to OSM tags; handles missing width/direction with defaults):
1. Create DB + enable extensions
```sql
-- run as postgres superuser
CREATE DATABASE routing_db;
\c routing_db

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgrouting;
```

2. Prepare a working edges table

If you have a shapefile, import it (e.g. ogr2ogr or shp2pgsql) into ways_raw. Then create a copy we’ll work on:

- Insert data have been cleaned topology in GIS apps (QGIS), it is faster and easier to monitoring process
```sql
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
CREATE INDEX ways_gix ON topology.ways USING GIST (geom);
```

3. Create vertices table with pgr_extractVertices()

pgr_extractVertices() will extract vertices and create a vertices_table that you can use to set source/target. Example workflow (projected geometry):
```sql
-- Run pgr_extractVertices on the projected geometry (use the projected table and column name)
DROP TABLE IF EXISTS topology.vertices CASCADE;  
SELECT * INTO topology.vertices FROM pgr_extractVertices('SELECT id, geom FROM topology.ways');
-- Create index
CREATE INDEX idx_vertices_geom_gist ON topology.vertices USING gist (geom);
```
Creates vertices (with id, geom columns) listing unique nodes, and populates in_edges and out_edges. Then update back soure and target in ways 

4. Update source and target 
```sql
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
5. Calculate length, cost, reverse_cost
```sql
UPDATE topology.ways SET
  cost = length_m / (speed_kmh * 1000.0 / 3600.0),
  reverse_cost = CASE 
    WHEN is_oneway THEN -1 
    ELSE length_m / (speed_kmh * 1000.0 / 3600.0) 
  END;
```

6. Vacuum/analyze
```sql
VACUUM ANALYZE topology.ways;
VACUUM ANALYZE topology.vertices;
```

7.  Quick validation (connected components / debugging)

Check for isolated components (useful to find broken geometry):
```sql
SELECT * FROM pgr_connectedComponents('
  SELECT id, source, target, cost, reverse_cost FROM topology.ways'
  );
```

If you need to filter to a connected subgraph for routing, you can use pgr_connectedComponents to find major components and work on the largest.
### Step 16: Add Routing API to docker-compose.yml
- Append this service to your `services:` section (uses your `.env` for DB):
```bash
  routing-api:
    image: python:3.12-slim
    container_name: routing-api
    restart: unless-stopped
    env_file:
      - .env
    ports:
      - "5000:5000"  # Expose if direct access; else proxy via Nginx
    volumes:
      - ./routing-api:/app  # Create this folder
    working_dir: /app
    command: >
      sh -c "pip install --no-cache-dir -r requirements.txt && python app.py"
    depends_on:
      postgis:
        condition: service_healthy
```
- Create `./routing-api/requirements.txt`
```python
# In your routing-api folder
psycopg2-binary
flask
flask-cors
```
- Create `./routing-api/app.py` (same as before, with your DB vars):
```python
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
```

### Step 17: Proxy via Nginx (Optional but Recommended)
- Add to your `./nginx.conf` (inside server {}):
```json
location /api/ {
        proxy_pass http://routing-api:5000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        
        # CORS headers
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods 'GET, POST, OPTIONS' always;
        add_header Access-Control-Allow-Headers 'Content-Type' always;
        
        # Handle preflight
        if ($request_method = OPTIONS) {
            return 204;
        }
    }
```
- Restart: `docker compose up -d --build routing-api nginx`
### Step 18: Test in Your Frontend
- In your `./frontend/index.html`, add:
```java
    function initMap() {
        map = new maplibregl.Map({
            container: 'map',
            style: STYLES[0].url,
            center: currentCenter,
            zoom: currentZoom,
            pitch: currentPitch,
            bearing: currentBearing,
            maxPitch: 85
        });

        map.on('moveend', () => {
            currentCenter = map.getCenter();
            currentZoom = map.getZoom();
            currentPitch = map.getPitch();
            currentBearing = map.getBearing();
        });

        map.addControl(new maplibregl.NavigationControl(), 'top-right');
        map.addControl(createLayerSwitcher(), 'bottom-right');

        map.on('click', (e) => {
            const lngLat = e.lngLat;

            if (!startMarker) {
                // First click = Start
                startMarker = new maplibregl.Marker({ element: createMarker('S', '#10b981') })
                    .setLngLat(lngLat)
                    .addTo(map);
                showInfo("Start set. Now click destination");
            } else if (!endMarker) {
                // Second click = End
                endMarker = new maplibregl.Marker({ element: createMarker('E', '#ef4444') })
                    .setLngLat(lngLat)
                    .addTo(map);
                calculateRoute(startMarker.getLngLat(), endMarker.getLngLat());
            } else {
                // Third click = Reset
                clearRoute();
                startMarker = null;
                endMarker = null;
                currentRouteData = null;
                showInfo("Click to set start point");
            }
        });

        map.on('load', () => showInfo("Click anywhere to set start point"));
    }

    function createMarker(text, bgColor) {
        const el = document.createElement('div');
        el.className = 'marker';
        el.style.backgroundColor = bgColor;
        el.textContent = text;
        return el;
    }

    function showInfo(text) {
        document.getElementById('info-box').classList.remove('hidden');
        document.getElementById('route-info').textContent = text;
    }

    function calculateRoute(start, end) {
        showInfo("Calculating fastest route...");

        // Use relative path to go through Nginx proxy
        fetch(`/api/route?start_lon=${start.lng}&start_lat=${start.lat}&end_lon=${end.lng}&end_lat=${end.lat}`)
            .then(async r => {
                const contentType = r.headers.get('content-type');
                
                // Check if we got HTML instead of JSON
                if (contentType && contentType.includes('text/html')) {
                    const text = await r.text();
                    console.error('Received HTML instead of JSON:', text.substring(0, 200));
                    throw new Error('API returned HTML - check Nginx routing and API status');
                }
                
                if (!r.ok) {
                    const text = await r.text();
                    console.error('API error:', text);
                    throw new Error(`HTTP ${r.status}: ${r.statusText}`);
                }
                
                return r.json();
            })
            .then(data => {
                if (data.error) {
                    showInfo("Error: " + data.error);
                    console.error("Routing error:", data.error);
                    return;
                }

                // Store route data for style switching
                currentRouteData = data;

                // Remove old route if exists
                if (map.getLayer('route')) map.removeLayer('route');
                if (map.getSource('route')) map.removeSource('route');

                // Add new route
                map.addSource('route', {
                    type: 'geojson',
                    data: data
                });

                map.addLayer({
                    id: 'route',
                    type: 'line',
                    source: 'route',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: {
                        'line-color': '#3b82f6',
                        'line-width': 8,
                        'line-opacity': 0.9
                    }
                });

                // Fit map to route
                const bounds = new maplibregl.LngLatBounds();
                data.features.forEach(f => {
                    if (f.geometry && f.geometry.coordinates) {
                        f.geometry.coordinates.forEach(coord => bounds.extend(coord));
                    }
                });
                map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 1500 });

                // Calculate distance
                let totalDistance = 0;
                data.features.forEach(f => {
                    if (f.geometry && f.geometry.coordinates) {
                        const coords = f.geometry.coordinates;
                        for (let i = 0; i < coords.length - 1; i++) {
                            totalDistance += calculateDistance(coords[i], coords[i + 1]);
                        }
                    }
                });

                // Show result
                const mins = data.duration_minutes ? Math.round(data.duration_minutes) : '??';
                const km = totalDistance > 0 ? (totalDistance / 1000).toFixed(1) : '??';
                showInfo(`Route ready – ${mins} min (~${km} km)`);
            })
            .catch(err => {
                console.error("Fetch error:", err);
                showInfo("Error connecting to routing server. Check console for details.");
            });
    }

    // Haversine distance calculation
    function calculateDistance(coord1, coord2) {
        const R = 6371e3; // Earth radius in meters
        const φ1 = coord1[1] * Math.PI / 180;
        const φ2 = coord2[1] * Math.PI / 180;
        const Δφ = (coord2[1] - coord1[1]) * Math.PI / 180;
        const Δλ = (coord2[0] - coord1[0]) * Math.PI / 180;

        const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                  Math.cos(φ1) * Math.cos(φ2) *
                  Math.sin(Δλ/2) * Math.sin(Δλ/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

        return R * c;
    }

    function clearRoute() {
        if (map.getLayer('route')) map.removeLayer('route');
        if (map.getSource('route')) map.removeSource('route');
        if (startMarker) startMarker.remove();
        if (endMarker) endMarker.remove();
        showInfo("Route cleared. Click to start again");
    }
```

## Phase 6: Addition functions:
### Nearest Facilities
#### Step 1: Pre-compute nearest_vertex_id (run once in database)
Connect to your database and execute:
```SQL
-- 0. Add column if not already present
ALTER TABLE topology.places ADD COLUMN IF NOT EXISTS nearest_vertex_id BIGINT;
-- 1. Verify Database Indexes
-- Check existing indexes
SELECT schemaname, tablename, indexname 
FROM pg_indexes 
WHERE schemaname = 'topology' 
  AND tablename IN ('places', 'vertices', 'ways');

-- Create missing indexes if needed
CREATE INDEX IF NOT EXISTS idx_places_type ON topology.places(type);
CREATE INDEX IF NOT EXISTS idx_places_geom_gist ON topology.places USING gist(geom);
CREATE INDEX IF NOT EXISTS idx_vertices_geom_gist ON topology.vertices USING gist(geom);
CREATE INDEX IF NOT EXISTS idx_ways_cost ON topology.ways(cost) WHERE cost > 0;

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
```

#### Step 2: Updated /api/closest_facility endpoint in app.py
Replace the previous version (or add this one) with this adapted version that uses topology.places:
```python
@app.route('/nearest_facility', methods=['GET'])
def nearest_facility():
    """
    Find nearest facilities using pgRouting with optimized spatial pre-filtering
    """
    try:
        # Parse and validate input
        lon = request.args.get('lon')
        lat = request.args.get('lat')
        facility_type = request.args.get('type', 'hospital').lower()
        limit = request.args.get('limit', 5, type=int)
        max_minutes = request.args.get('max_minutes', type=float)

        # Validate required params
        if not lon or not lat:
            return jsonify({"error": "Missing lon or lat parameter"}), 400

        try:
            lon = float(lon)
            lat = float(lat)
        except ValueError:
            return jsonify({"error": "Invalid lon/lat values"}), 400

        # Security: only allow supported types
        allowed_types = ['hospital', 'fire station', 'police', 'clinic']
        if facility_type not in allowed_types:
            return jsonify({
                "error": f"Unsupported facility type. Allowed: {', '.join(allowed_types)}"
            }), 400

        # Get database connection
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)

        # Set query timeout to prevent hanging
        cur.execute("SET statement_timeout = '15s'")

        # FIXED QUERY: Handle geometry properly - cast to Point if needed
        query = """
            WITH click_point AS (
                SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326) AS geom
            ),
            click_vertex AS (
                SELECT v.id AS vertex_id
                FROM topology.vertices v, click_point cp
                ORDER BY v.geom <-> cp.geom
                LIMIT 1
            ),
            nearby_places AS (
                SELECT 
                    p.id,
                    p.name,
                    p.type,
                    p.address,
                    p.nearest_vertex_id,
                    ST_X(ST_GeometryN(p.geom, 1)) AS lon,
                    ST_Y(ST_GeometryN(p.geom, 1)) AS lat,
                    ST_Distance(
                        p.geom::geography, 
                        (SELECT geom FROM click_point)::geography
                    ) / 1000.0 AS crow_distance_km
                FROM topology.places p, click_point cp
                WHERE p.type = %s
                  AND p.nearest_vertex_id IS NOT NULL
                  AND ST_DWithin(
                      p.geom::geography,
                      cp.geom::geography,
                      20000  -- 20km radius
                  )
                ORDER BY p.geom <-> cp.geom
                LIMIT 20  -- Pre-filter to 20 closest by straight-line distance
            )
            SELECT 
                np.id,
                np.name,
                np.type,
                np.address,
                np.crow_distance_km,
                round(d.agg_cost::numeric, 1) AS travel_seconds,
                round((d.agg_cost / 60.0)::numeric, 1) AS travel_minutes,
                np.lon AS facility_lon,
                np.lat AS facility_lat
            FROM nearby_places np
            CROSS JOIN LATERAL (
                SELECT agg_cost
                FROM pgr_dijkstraCost(
                    'SELECT id, source, target, cost, reverse_cost 
                     FROM topology.ways 
                     WHERE cost > 0',
                    (SELECT vertex_id FROM click_vertex),
                    np.nearest_vertex_id,
                    directed => true
                )
            ) d
            WHERE d.agg_cost IS NOT NULL
        """

        params = [lon, lat, facility_type]

        if max_minutes:
            max_seconds = max_minutes * 60
            query += " AND d.agg_cost <= %s"
            params.append(max_seconds)

        query += " ORDER BY d.agg_cost LIMIT %s"
        params.append(limit)

        # Execute query
        cur.execute(query, params)
        results = cur.fetchall()

        cur.close()
        conn.close()

        if not results:
            return jsonify({
                "message": f"No {facility_type} found within network reach",
                "incident": {"lon": lon, "lat": lat},
                "type": facility_type,
                "count": 0,
                "facilities": []
            }), 200

        return jsonify({
            "incident": {"lon": lon, "lat": lat},
            "type": facility_type,
            "count": len(results),
            "facilities": results
        })

    except Exception as e:
        # Log the full error for debugging
        import traceback
        print("=" * 80)
        print("NEAREST FACILITY ERROR:")
        print(traceback.format_exc())
        print("=" * 80)
        
        return jsonify({
            "error": str(e),
            "type": type(e).__name__
        }), 500
    
```        
#### Step 3: Frontend – changes needed!
- Add `Nearest Facilities` button to html
```html
        <!-- Main floating control panel -->
        <div class="control-panel header">
            <div class="header-content">
                <h1 class="title">Routing and Services Analysis Tool</h1>
                
                <div class="mode-switcher">
                    <button id="mode-route" class="mode-btn active" type="button">
                        🗺️ A→B Route
                    </button>
                    <button id="mode-tsp" class="mode-btn" type="button">
                        🔄 TSP Multi
                    </button>
                    <button id="mode-facility" class="mode-btn" type="button">
                        🏥 Nearest Facility
                    </button>
                    <button id="mode-service" class="mode-btn" type="button">
                        🚚 Service Area
                    </button>
                </div>
                
                <!-- Facility type selector (shown only in facility mode) -->
                <div id="facility-selector" class="hidden">
                    <label for="facility-type-select">
                        Facility Type:
                    </label>
                    <select id="facility-type-select">
                        <option value="hospital">Hospital</option>
                        <option value="fire station">Fire Station</option>
                        <option value="police">Police</option>
                    </select>
                </div>
            </div>

            <p class="instruction" id="mode-instruction">
                Click: <span class="highlight start">Start</span> →
                <span class="highlight end">End</span>
            </p>
        </div>
```  
add to styles.css
```css
/* Mode-specific colors when active */
#mode-route.active   { background: #3b82f6; }  /* blue */
#mode-tsp.active     { background: #8b5cf6; }  /* purple */
#mode-facility.active { background: #059324; }  /* green */
#mode-service.active   { background: #ef4444; }  /* red */
```
And
```css
/* ==========================================================================
   FACILITY SELECTOR
   ========================================================================== */
#facility-selector {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
}

#facility-selector label {
    font-weight: 500;
    font-size: 0.85rem;
    color: #4b5563;
    margin-right: 0.5rem;
}

#facility-type-select {
    padding: 0.4rem 0.8rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85rem;
    color: #374151;
    background: white;
    transition: all 0.2s ease;
}

#facility-type-select:hover {
    border-color: #9ca3af;
}

#facility-type-select:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}
```
And
```css
/* ==========================================================================
   POINTER EVENTS (Critical for map interaction)
   ========================================================================== */
/* Let clicks pass through floating panels to the map underneath */
.control-panel.header,
.control-panel.slider-panel,
.control-panel.info-panel {
    pointer-events: none;
}

/* But keep interactive elements clickable */
.control-panel.header button,
.control-panel.header p,
.control-panel.header select,
.control-panel.header label,
#facility-selector,
#facility-selector select,
#facility-selector label,
#time-slider label,
#time-slider input,
#info-box p {
    pointer-events: auto;
}
```
And
```css
/* ==========================================================================
   RESPONSIVE ADJUSTMENTS
   ========================================================================== */
@media (max-width: 600px) {
    .title {
        font-size: 1.1rem;
    }

    .mode-switcher {
        padding: 0.4rem;
        gap: 0.35rem;
    }
    
    .mode-btn {
        padding: 0.55rem 1rem;
        font-size: 0.85rem;
        min-width: 100px;
    }
    
    .control-panel {
        padding: 0.8rem 1rem;
        min-width: 300px;
    }

    #facility-selector {
        flex-direction: column;
        gap: 0.5rem;
    }

    #facility-selector label {
        margin-right: 0;
    }

    #facility-type-select {
        width: 100%;
    }
}
```
Add javascript to routing.js
```js
const FACILITY_COLORS = {
    'hospital': '#ef4444',
    'fire station': '#f97316',
    'police': '#8b5cf6',
    'clinic': '#10b981'
};

// Backend API configuration
const BACKEND_URL = 'http://localhost:5000';

const API_ENDPOINTS = {
    route: `${BACKEND_URL}/route`,
    nearestFacility: `${BACKEND_URL}/nearest_facility`,
    serviceArea: `${BACKEND_URL}/service_area`
};

const DEFAULT_CENTER = [46.6167, 24.8258]; // Riyadh
const DEFAULT_ZOOM = 12;
const REQUEST_TIMEOUT = 20000; // 20 seconds


// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const state = {
    map: null,
    currentMode: 'route',
    currentCenter: DEFAULT_CENTER,
    currentZoom: DEFAULT_ZOOM,
    currentPitch: 0,
    currentBearing: 0,
    markers: {
        start: null,
        end: null,
        service: null,
        facility: null,
        tsp: []
    },
    currentRouteData: null,
    serviceMinutes: 5
};

// ============================================================================
// MAP INITIALIZATION
// ============================================================================

function initMap() {
    state.map = new maplibregl.Map({
        container: 'map',
        style: STYLES[0].url,
        center: state.currentCenter,
        zoom: state.currentZoom,
        pitch: state.currentPitch,
        bearing: state.currentBearing,
        maxPitch: 85
    });

    // Track viewport changes
    state.map.on('moveend', () => {
        state.currentCenter = state.map.getCenter();
        state.currentZoom = state.map.getZoom();
        state.currentPitch = state.map.getPitch();
        state.currentBearing = state.map.getBearing();
    });

    // Add controls
    state.map.addControl(new maplibregl.NavigationControl(), 'top-right');
    state.map.addControl(createLayerSwitcher(), 'bottom-right');

    // Setup event handlers
    setupEventHandlers();

    state.map.on('load', () => {
        showInfo("Click anywhere to begin");
    });
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

function setupEventHandlers() {
    // Map click handler
    state.map.on('click', handleMapClick);

    // Mode switcher buttons
    document.getElementById('mode-route')?.addEventListener('click', () => switchMode('route'));
    document.getElementById('mode-tsp')?.addEventListener('click', () => switchMode('tsp'));
    document.getElementById('mode-facility')?.addEventListener('click', () => switchMode('facility'));
    document.getElementById('mode-service')?.addEventListener('click', () => switchMode('service'));

    // Time slider for service area
    const timeInput = document.getElementById('time-input');
    if (timeInput) {
        timeInput.addEventListener('input', (e) => {
            state.serviceMinutes = parseInt(e.target.value, 10);
            document.getElementById('time-value').textContent = state.serviceMinutes;
            
            if (state.markers.service) {
                calculateServiceArea(state.markers.service.getLngLat());
            }
        });
    }
}

function handleMapClick(e) {
    const handlers = {
        'route': handleRouteClick,
        'tsp': handleTSPClick,
        'facility': handleFacilityClick,
        'service': handleServiceClick
    };

    const handler = handlers[state.currentMode];
    if (handler) {
        handler(e.lngLat);
    }
}

// ============================================================================
// MODE SWITCHING
// ============================================================================

function switchMode(mode) {
    state.currentMode = mode;
    clearAll();

    // Update UI
    updateModeButtons(mode);
    updateModeInstructions(mode);
}

function updateModeButtons(activeMode) {
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    const activeBtn = document.getElementById(`mode-${activeMode}`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }
}

function updateModeInstructions(mode) {
    const timeSlider       = document.getElementById('time-slider');
    const facilitySelector = document.getElementById('facility-selector');
    const instruction      = document.getElementById('mode-instruction');

    if (timeSlider) {
        timeSlider.classList.toggle('hidden', mode !== 'service');
    }

    if (facilitySelector) {
        facilitySelector.classList.toggle('hidden', mode !== 'facility');
    }

    const instructions = {
        'route': {
            html: 'Click: <span class="highlight start">Start</span> → <span class="highlight end">End</span>',
            info: '🗺️ A→B Route mode active'
        },
        'tsp': {
            html: 'Click to add <span style="color:#8b5cf6;font-weight:bold">waypoints</span> (min 3)',
            info: '🔄 TSP mode: Add at least 3 points'
        },
        'facility': {
            html: 'Click a <span style="color:#ef4444;font-weight:bold">location</span> to find nearest facilities',
            info: '🏥 Nearest Facility mode active'
        },
        'service': {
            html: 'Click <span style="color:#ef4444;font-weight:bold">service location</span> + adjust time',
            info: '🚚 Service Area mode active'
        }
    };

    const modeConfig = instructions[mode];
    if (modeConfig && instruction) {
        instruction.innerHTML = modeConfig.html;
        showInfo(modeConfig.info);
    }
}
```
And
```js
// ============================================================================
// NEAREST FACILITY MODE
// ============================================================================

function handleFacilityClick(lngLat) {
    // Clean up previous state
    cleanupFacilityMode();

    // Place marker at click location
    state.markers.facility = new maplibregl.Marker({
        element: createMarker('📍', '#dc2626')
    })
        .setLngLat(lngLat)
        .addTo(state.map);

    showInfo("⏳ Searching nearest facilities...");
    calculateNearestFacilities(lngLat);
}

function cleanupFacilityMode() {
    if (state.markers.facility) {
        state.markers.facility.remove();
        state.markers.facility = null;
    }

    const layersToRemove = ['facility-lines', 'facility-points', 'facility-labels', 'facility-names'];
    layersToRemove.forEach(layerId => {
        if (state.map.getLayer(layerId)) {
            state.map.removeLayer(layerId);
        }
    });

    if (state.map.getSource('facility-results')) {
        state.map.removeSource('facility-results');
    }
}

async function calculateNearestFacilities(lngLat) {
    const facilityType = document.getElementById('facility-type-select')?.value || 'hospital';
    const limit = 5;

    showInfo("⏳ Searching for nearest facilities...<br><small>This may take 10-15 seconds</small>");

    try {
        // Build URL with correct backend
        const url = `${API_ENDPOINTS.nearestFacility}?lon=${lngLat.lng}&lat=${lngLat.lat}&type=${facilityType}&limit=${limit}`;

        const data = await fetchWithTimeout(url);

        if (data.error) {
            throw new Error(data.error);
        }

        if (!data.facilities || data.facilities.length === 0) {
            showInfo(`ℹ️ No ${facilityType.replace('_', ' ')} found within network reach`);
            return;
        }

        displayFacilityResults(lngLat, data, facilityType);
    } catch (error) {
        handleError('Facility search', error);
    }
}

function displayFacilityResults(lngLat, data, facilityType) {
    // Create line features from click point to each facility
    const lineFeatures = data.facilities.map(facility => ({
        type: "Feature",
        geometry: {
            type: "LineString",
            coordinates: [
                [lngLat.lng, lngLat.lat],
                [parseFloat(facility.facility_lon), parseFloat(facility.facility_lat)]
            ]
        },
        properties: {
            name: facility.name,
            minutes: parseFloat(facility.travel_minutes),
            type: facility.type,
            address: facility.address || '',
            distance_km: facility.crow_distance_km || null,
            rank: data.facilities.indexOf(facility) + 1
        }
    }));

    // Create point features for facilities
    const pointFeatures = data.facilities.map(facility => ({
        type: "Feature",
        geometry: {
            type: "Point",
            coordinates: [parseFloat(facility.facility_lon), parseFloat(facility.facility_lat)]
        },
        properties: {
            name: facility.name,
            minutes: parseFloat(facility.travel_minutes),
            type: facility.type,
            address: facility.address || '',
            distance_km: facility.crow_distance_km || null,
            rank: data.facilities.indexOf(facility) + 1
        }
    }));

    // Add GeoJSON source
    state.map.addSource('facility-results', {
        type: 'geojson',
        data: {
            type: "FeatureCollection",
            features: [...lineFeatures, ...pointFeatures]
        }
    });

    const facilityColor = FACILITY_COLORS[facilityType] || '#6366f1';

    // Add line layer (routes to facilities)
    state.map.addLayer({
        id: 'facility-lines',
        type: 'line',
        source: 'facility-results',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
            'line-color': facilityColor,
            'line-width': [
                'interpolate', ['linear'], ['get', 'rank'],
                1, 5,    // Closest facility: thicker line
                5, 3     // Farthest: thinner line
            ],
            'line-opacity': 0.7,
            'line-dasharray': [2, 1.5]
        }
    });

    // Add facility point layer with numbered markers
    state.map.addLayer({
        id: 'facility-points',
        type: 'circle',
        source: 'facility-results',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                10, 8,
                15, 14
            ],
            'circle-color': facilityColor,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 3,
            'circle-opacity': 0.95
        }
    });

    // Add numbered labels on facilities
    state.map.addLayer({
        id: 'facility-labels',
        type: 'symbol',
        source: 'facility-results',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
            'text-field': ['to-string', ['get', 'rank']],
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-size': 14,
            'text-allow-overlap': true
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-width': 0
        }
    });

    // Add facility names below the markers
    state.map.addLayer({
        id: 'facility-names',
        type: 'symbol',
        source: 'facility-results',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
            'text-field': ['concat', ['get', 'name'], '\n', ['get', 'minutes'], ' min'],
            'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
            'text-size': 11,
            'text-offset': [0, 2],
            'text-anchor': 'top',
            'text-max-width': 12
        },
        paint: {
            'text-color': '#1f2937',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2
        }
    });

    // Setup interactions
    setupFacilityInteractions();

    // Display summary
    const closestFacility = data.facilities[0];
    const facilityLabel = facilityType.replace('_', ' ');
    
    // Build list of all facilities
    const facilityList = data.facilities.map((f, i) => 
        `${i + 1}. ${f.name} (${f.travel_minutes} min)`
    ).join('<br>');
    
    showInfo(`
        ✅ Found ${data.count} ${facilityLabel}${data.count > 1 ? 's' : ''}
        <br><strong>Closest:</strong> ${closestFacility.name}
        <br><strong>Travel time:</strong> ${closestFacility.travel_minutes} minutes
        ${closestFacility.crow_distance_km ? `<br><small>Straight-line: ${closestFacility.crow_distance_km.toFixed(1)} km</small>` : ''}
        <br><br><small style="font-size: 0.85rem;">${facilityList}</small>
    `);

    // Fit map bounds
    fitMapToFacilities(lngLat, data.facilities);
}

function setupFacilityInteractions() {
    // Change cursor on hover
    state.map.on('mouseenter', 'facility-points', () => {
        state.map.getCanvas().style.cursor = 'pointer';
    });

    state.map.on('mouseleave', 'facility-points', () => {
        state.map.getCanvas().style.cursor = '';
    });

    // Show popup on click
    state.map.on('click', 'facility-points', (e) => {
        const props = e.features[0].properties;
        
        const popupContent = `
            <div style="font-family: Inter, sans-serif; min-width: 200px;">
                <strong style="font-size: 14px; color: #1f2937;">${props.name}</strong>
                ${props.address ? `<p style="margin: 4px 0; font-size: 12px; color: #6b7280;">${props.address}</p>` : ''}
                <p style="margin: 8px 0 0 0; font-size: 13px; color: #059669;">
                    <strong>⏱️ ${props.minutes} minutes</strong> drive
                </p>
                ${props.distance_km ? `<p style="margin: 4px 0 0 0; font-size: 11px; color: #9ca3af;">Straight-line: ${parseFloat(props.distance_km).toFixed(1)} km</p>` : ''}
            </div>
        `;
        
        new maplibregl.Popup({ 
            offset: 15,
            closeButton: true,
            closeOnClick: true
        })
            .setLngLat(e.lngLat)
            .setHTML(popupContent)
            .addTo(state.map);
    });
}

function fitMapToFacilities(lngLat, facilities) {
    const bounds = new maplibregl.LngLatBounds();
    bounds.extend([lngLat.lng, lngLat.lat]);
    
    facilities.forEach(facility => {
        bounds.extend([
            parseFloat(facility.facility_lon), 
            parseFloat(facility.facility_lat)
        ]);
    });
    
    state.map.fitBounds(bounds, { 
        padding: { top: 80, bottom: 80, left: 80, right: 80 },
        maxZoom: 14,
        duration: 1000
    });
}
```
And
```js
function clearAll() {
    // Remove all layers
    const layersToRemove = [
        'route',
        'service-network',
        'service-hull',
        'service-border',
        'facility-lines',
        'facility-points',
        'facility-labels',
        'facility-names'
    ];

    layersToRemove.forEach(layerId => {
        if (state.map.getLayer(layerId)) {
            state.map.removeLayer(layerId);
        }
    });

    // Remove all sources
    const sourcesToRemove = [
        'route',
        'service-network',
        'service-hull',
        'facility-results'
    ];

    sourcesToRemove.forEach(sourceId => {
        if (state.map.getSource(sourceId)) {
            state.map.removeSource(sourceId);
        }
    });

    // Remove all markers
    Object.keys(state.markers).forEach(key => {
        if (key === 'tsp') {
            state.markers.tsp.forEach(item => {
                if (item.marker) item.marker.remove();
            });
            state.markers.tsp = [];
        } else if (state.markers[key]) {
            state.markers[key].remove();
            state.markers[key] = null;
        }
    });

    // Reset data
    state.currentRouteData = null;
    showInfo("Click to start");
}
```
## Phase 7: Add ElasticSearch
### Step 1: Add ElasticSearch to docker-compose file:
```bash
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:9.3.1
    container_name: elasticsearch
    restart: unless-stopped
    environment:
      - discovery.type=single-node                  # Required for single node
      - xpack.security.enabled=false                # Disable security for dev (no username/password)
      - ES_JAVA_OPTS=-Xms1g -Xmx1g                  # Adjust heap size (1GB each — change based on your RAM)
      - "logger.org.elasticsearch: WARN"            # Reduce log noise
      - http.cors.enabled=true
      - http.cors.allow-origin="*"
      - http.cors.allow-methods=OPTIONS,HEAD,GET,POST,PUT,DELETE
      - http.cors.allow-headers=X-Requested-With,Content-Type,Content-Length,Authorization
      - http.cors.allow-credentials=true   # optional but useful sometimes
    ports:
      - "9200:9200"                                 # HTTP API
      # - "9300:9300"                                 # Transport (optional, can remove if not needed)
    volumes:
      - esdata:/usr/share/elasticsearch/data        # Persist ES data
    healthcheck:
      test: ["CMD-SHELL", "curl -s -f http://localhost:9200/_cat/health?h=status"]
      interval: 30s
      timeout: 10s
      retries: 5
    ulimits:
      memlock: -1
      nofile: 65536

  kibana:
    image: docker.elastic.co/kibana/kibana:9.3.1
    container_name: kibana
    restart: unless-stopped
    ports:
      - "5601:5601"
    environment:
      - ELASTICSEARCH_HOSTS=http://elasticsearch:9200
      - SERVER_PUBLICBASEURL=http://localhost:5601  # optional, helps with some proxy issues
    volumes:
      - kibana-data:/usr/share/kibana/data
    depends_on:
      elasticsearch:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "curl -s -f http://localhost:5601/api/status | grep -q 'green' || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 5
```
### Step 2: Importing GeoJSON Data to Elasticsearch
#### a. Create an Index with Appropriate Mapping
Before importing, define an index with mappings for your fields. Use `geo_shape` for the `geometry` field to support spatial queries.

You can do this via `curl` from your host on the terminal (assuming ES is exposed on port 9200):
```bash
curl -X PUT "http://localhost:9200/building_units" -H 'Content-Type: application/json' -d'
{
  "mappings": {
    "dynamic": "true",              // ← change to "strict" later when stable
    "properties": {
      "UNIT_ID": { "type": "keyword" },  // Exact match for IDs
      "USE_TYPE": { "type": "keyword" },
      "NAME": { "type": "text" },        // Full-text search
      "NAME_LONG": { "type": "text" },
      "LEVEL_ID": { "type": "keyword" },
      "HEIGHT": { "type": "float" },
      "LabelNames": { "type": "text" },
      "UnitAddres": { "type": "keyword" },
      "Sequance": { "type": "keyword" },
      "Base": { "type": "float" },
      "geometry": { "type": "geo_shape" }  // For MultiPolygon spatial data
    }
  }
}'
```
Or from Kibana:
- Open your browser and go to: http://localhost:5601 
- Log in if asked (first time it might show a welcome screen — just continue).
- On the left menu, click Dev Tools (it looks like a terminal icon, or sometimes under Management > Dev Tools).You will see two panels:
  - Left side: where you write commands (like a text editor)
  - Right side: shows results
- In the left panel, delete any example text if present, then paste your full command.
building_units.geojson
```json
PUT /building_units_v2
{
  "settings": {
    "analysis": {
      "normalizer": {
        "lowercase_normalizer": {
          "type": "custom",
          "filter": ["lowercase"]
          // Optional but very useful for Vietnamese addresses: "asciifolding"  → turns "Lê" → "Le", "Đ" → "D", etc.
        }
      }
    }
  },
  "mappings": {
    "dynamic": "true",              // ← change to "strict" later when stable
    "properties": {
      "UNIT_ID": { "type": "keyword", "normalizer": "lowercase_normalizer"},           // ← this is the key, Exact match for IDs
      "USE_TYPE": { "type": "keyword", "normalizer": "lowercase_normalizer" },
      "NAME": { "type": "text" },        // Full-text search
      "NAME_LONG": { "type": "text" },
      "LEVEL_ID": { "type": "keyword", "normalizer": "lowercase_normalizer" },
      "HEIGHT": { "type": "float" },
      "LabelNames": { "type": "text" },
      "UnitAddres": { "type": "keyword", "normalizer": "lowercase_normalizer" },
      "Sequance": { "type": "keyword", "normalizer": "lowercase_normalizer" },
      "Base": { "type": "float" },
      "geometry": { "type": "geo_shape" }  // For MultiPolygon spatial data
    }
  }
}
```
Note: in version 2(v_2), we convert to all lower can in data for searching in future

Replace `building_units` with your preferred index name.

##### Mapping Strategy 
- Keep dynamic: true (default) → if you accidentally index one of the unused fields later, Elasticsearch will guess its type (not ideal, but safe during development).
- Later (production): change to dynamic: "strict" → rejects any new/unmapped fields → forces clean data.

If you want to add mapping to an existing index (update/add fields)
- Use almost the same command, but change the path:
```json
PUT /building_units/_mapping
{
  "properties": {
    "new_field": { "type": "keyword" }
  }
}
```
- Run it the same way (Kibana or curl).

Note: You can only add new fields this way — you cannot change existing field types without reindexing.

##### Make Searches Better (Small Improvements)

You can add these later (after testing):
```JSON
"UnitAddres": {
  "type": "keyword",
  "fields": {
    "text": { "type": "text" }      // ← allows full-text if you ever want partial search
  }
}
```
##### Quick Troubleshooting Tips

- Index already exists → Run `DELETE /building_units` first (in Kibana or curl), then recreate.
- JSON error → Make sure no missing commas, quotes, or wrong indentation. Kibana highlights mistakes.

#### b. Prepare and Import the Data
  - Install it on your host if needed (`pip install elasticsearch`)
```bash
# Install Python & venv
sudo apt update
sudo apt install python3 python3-venv python3-pip -y

# Create a virtual environment
python3 -m venv env

# Activate it
source env/bin/activate

# Install packages
pip install elasticsearch
```  
  - Use a Python Script: use the elasticsearch library to bulk import. Save this script as `import_geojson_to_es.py`
```python
from elasticsearch import Elasticsearch, helpers

# Connect to ES (update host if not localhost)
es = Elasticsearch(["http://localhost:9200"])

# Load GeoJSON
with open("units.geojson", "r") as f:  # Replace with your file path
    geojson_data = json.load(f)

# Prepare bulk actions (one document per feature)
actions = []
for feature in geojson_data["features"]:
    doc = {
        "_index": "building_units",  # Your index name
        "_source": {
            **feature["properties"],  # Spread properties
            "geometry": feature["geometry"]  # GeoJSON geometry
        }
    }
    actions.append(doc)

# Bulk index
helpers.bulk(es, actions)
print("Import completed!")
```
  - Run it: python3 import_geojson_to_es.py.
  
#### c. Verify Import: 
- Use Kibana's "Management > Dev Tools" 
```t
# Check if the index exists and get basic stats (including document count)
GET /building_units

# Get just the document count (clean & fast)
GET /building_units/_count

# See a sample of the actual documents (proof that data & geometry are there)
GET /building_units/_search
{
  "query": {
    "match_all": {}
  },
  "size": 5                       // show only first 5 documents (default is 10)
}

# Search for a specific known unit (e.g. "1481")
GET /building_units/_search
{
  "query": {
    "match": {
      "UNIT_ID": "SPL.HQ.L0.1481"
    }
  }
}
```
- or curl: 
```Bash 
curl "http://localhost:9200/building_units/_search?q=*&pretty"  # Search all
```

## Step 3: Building a UI to Search Units
### Build a Search Function in Your Frontend (with JS)
```js
// ============================================================================
// SEARCH (Elasticsearch – Building Units / Floors)
// ============================================================================

async function searchUnits() {
    const queryText  = document.getElementById('searchInput').value.trim();
    const resultsDiv = document.getElementById('results');

    if (!queryText) {
        resultsDiv.innerHTML = '<div class="no-results">Please enter a search term</div>';
        return;
    }

    resultsDiv.innerHTML = '<div class="loading">Searching...</div>';
    clearHighlight();

    const index   = currentDataset === 'units' ? 'building_units' : 'buildings_vertical';
    const fields  = currentDataset === 'units'
        ? ['UNIT_ID', 'NAME^2', 'NAME_LONG', 'UnitAddres', 'LabelNames']
        : ['UnitAddress^3', 'ShortAddress^1.8', 'fkFloorID^1.5', 'FloorUsage'];

    const esQuery = { query: { multi_match: { query: queryText, fields, type: 'best_fields', fuzziness: 'AUTO' } }, size: 20 };

    try {
        const response = await fetch(`${ES_URL}/${index}/_search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(esQuery)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        resultsDiv.innerHTML = '';

        if (data.hits.hits.length === 0) {
            resultsDiv.innerHTML = '<div class="no-results">No results found.</div>';
            return;
        }

        data.hits.hits.forEach(hit => {
            const doc  = hit._source;
            const item = document.createElement('div');
            item.className = 'result-item';

            if (currentDataset === 'units') {
                item.innerHTML = `
                    <strong>${doc.UNIT_ID || 'N/A'}</strong><br>
                    ${doc.LabelNames || 'Unnamed'} (${doc.UnitAddres || 'No address'})<br>
                    <small>Floor Height: ${doc.Base !== undefined ? doc.Base.toFixed(2) + 'm' : 'N/A'} | Type: ${doc.USE_TYPE || 'N/A'}</small>
                `;
            } else {
                item.innerHTML = `
                    <strong>${doc.UnitAddress || doc.fkFloorID || '—'}</strong><br>
                    Floor ${doc.FloorNumber ?? '—'} – ${doc.FloorUsage || '—'}<br>
                    <small>Address: ${doc.UnitAddress || doc.ShortAddress || 'No address'} | Building: ${doc.BuildingHeight ? doc.BuildingHeight.toFixed(1) + 'm' : '—'}</small>
                `;
            }

            item.onclick = () => zoomToFeature(doc, item);
            resultsDiv.appendChild(item);
        });

    } catch (err) {
        console.error('Search error:', err);
        resultsDiv.innerHTML = `<div class="error">Error: ${err.message}<br><small>Check console for details</small></div>`;
    }
}
```
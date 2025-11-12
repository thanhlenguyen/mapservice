# Self-Hosted Map System using PostGIS, Martin, and TileServer-GL

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
```
docker compose down
docker volume ls
docker volume rm {volume name}
```

### Step 2: Create script to set up system

We need a robust PostgreSQL database with the PostGIS extension enabled. This will store your custom POI data and power the dynamic maps served by Martin.

- Create a ```docker-compose.yml``` file for your entire stack.

``` 
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

```
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
```
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
```
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
```
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

```
docker compose up -d
```
## Note:
- Check logs of container to see if we have any issue:

``` 
docker compose logs container_name
```
- martin_server is restarting because it cannot connect to PostGIS (the connection string is wrong): please check in ```martin-config.yml``` (because of martin connects with postgis inside docker so ```POSTGRES_HOST``` is not ```localhost```)
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
```
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
```
psql -h localhost -U le -d geodb -W
```
Enable PostGIS if needed:
```
CREATE EXTENSION IF NOT EXISTS postgis;  
```  
3. Import GeoJSON or Other Formats Using ogr2ogr
install ogr2ogr (part of GDAL): 
```
sudo apt install gdal-bin
```
- Import GeoJSON (most of time we use this task, we don't neet to configure anything in postgres):

Use ogr2ogr to load into PostGIS:
```
ogr2ogr -f PostgreSQL PG:"host=localhost user=le password=123456 dbname=geodb" \
-nln topology.places -nlt PROMOTE_TO_MULTI -lco GEOMETRY_NAME=geom \
/mnt/d/Git/mapserver/data/pois.geojson
```
Options:
```
-nln topology.places: Places table in topology schema.
-nlt PROMOTE_TO_MULTI: Ensures multi-geometry support.
-lco GEOMETRY_NAME=geom: Names geometry column geom (matches Martin’s default).
```
- Import Shapefile (Similar command):
```
bashogr2ogr -f PostgreSQL PG:"host=localhost user=le password=123456 dbname=geodb" \
-nln topology.places -nlt PROMOTE_TO_MULTI -lco GEOMETRY_NAME=geom \
/mnt/d/Git/mapserver/data/sample.shp
```
- Import CSV with Lat/Lon:
If you have a CSV (e.g., pois.csv with columns name, lat, lon):

  - Copy to PostGIS:
```sql -h localhost -U le -d geodb -W -c \
"\COPY topology.places (name, lat, lon) FROM '/mnt/d/Git/mapserver/data/pois.csv' DELIMITER ',' CSV HEADER;"
```
  - Add geometry column:
```
ALTER TABLE topology.places ADD COLUMN geom GEOMETRY(Point, 4326);
UPDATE topology.places SET geom = ST_SetSRID(ST_MakePoint(lon, lat), 4326);
```
Run ogr2ogr in Docker:

If GDAL isn’t installed locally:
```
ogr2ogr:
  image: osgeo/gdal
  command: ogr2ogr -f PostgreSQL PG:"host=postgis user=le password=123456 dbname=geodb" \
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
```
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
```
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

```
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
```
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
```
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
```
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
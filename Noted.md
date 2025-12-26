# Building Multiple Tile Map System on 1 Project
Folder structure as:
```
mapservice
├── config/
│   ├── config.json
│   ├── martin-config.yml
│   └── nginx.conf
├── data/
│   ├── mbtiles/
│   │      └── roads.mbtiles
│   ├── pmtiles/
│   │      └── roads.pmtiles
│   ├── fonts/
│   │      └── Open San Regular
│   └── sprites/
│         └── sprite.json
├── styles/
│   ├── go-pmtiles/
│   │     └── style.json
│   ├── martin/
│   │     └── style.json
│   ├── pmtiles/
│   │     └── style.json
│   └── tileserver/
│         └── style.json
├── frontend/
│   ├── css/
│   ├── js/
│   └── index.html

```
## 1. TileServer, Martin (+Postgis), Nginx (focus on tileserver) 
- Tileserver manages MBTiles layers (static layers)
- Martin manages dynamic layers
- Nginx connnects with browser
TileServer GL expects a fixed internal directory layout:
```
/tileserver
  ├── config.json
  ├── styles/
  │     └── *.json
  ├── sprites/
  └── fonts/
```
So, in docker composse file, we should mount:
```
volumes:
    - ./config/config.json:/tileserver/config.json:ro       # config.json 
    - ./styles/tileserver:/tileserver/styles:ro # styles for Tileserver-GL       
    - ./data/fonts:/tileserver/fonts:ro      # Raw .ttf/.otf files for Martin to generate glyphs
    - ./data/sprites:/tileserver/sprites:ro  # Individual SVG/PNG files for Martin to generate sprites     
    - ./data/mbtiles:/data/mbtiles:ro  # mbtiles files 
```
### Pros:
- Traditional ways, user fimiliar with 
### Cons:
- Mbtiles layers need SQLite to query data, so it can be latency

## 2. Martin (+Postgis), Nginx (focus on Nginx)
- Martin manages dynamic layers
- Nginx connnects with browser to render PMTiles
Official nginx Docker image expects:
```
 Nginx (frontend)
 │  └── /usr/share/nginx/html
 │       ├── index.html
 │       ├── css/
 │       └── js/
```
In docker compose file, we should mount:
```
volumes:
    - ./frontend:/usr/share/nginx/html
    - ./data/pmtiles:/usr/share/nginx/html/pmtiles:ro # serve PMTiles files when using PMTiles directly in frontend (serverless method)
    - ./data/sprites:/usr/share/nginx/html/sprites:ro   # serve sprites
    - ./data/fonts:/usr/share/nginx/html/fonts:ro       # serve fonts  
    - ./styles:/usr/share/nginx/html/styles:ro    # serve styles
    - ./config/nginx.conf:/etc/nginx/conf.d/default.conf:ro
``` 
### Pros:
- HTML process directly to pmtiles files, so it is fast
### Cons:
- Expose layer file name

## 3. Martin (+Postgis), Nginx (focus on Martin)
This method will rely on Martin to manage both dynamic and static layers
Martin will serve pmtiles layers in specific folder, so in docker we can configure and mount:

```
volumes:
    - ./config/martin-config.yml:/config.yml:ro # Martin config file (Martin reads martin-config.yml as config.yml)
    - ./data/mbtiles:/mbtiles:ro # MBTiles files (for Martin to serve when we use Martin to render Mbtiles)
    - ./data/pmtiles:/pmtiles:ro # PMTiles files (for Martin to serve when we use Martin to render PMTiles)
    - ./styles/martin:/styles:ro  # Mapbox style JSON files (for Martin to serve when we use Martin to render Mbtiles)
    - ./data/fonts:/fonts:ro      # Raw .ttf/.otf files for Martin to generate glyphs
    - ./data/sprites:/sprites:ro  # Individual SVG/PNG files for Martin to generate sprites
```
For martin-config.yml file, if we specify "path", we may not need to list down source in the directory under path, "source" is using for separate file or link we want to include in
```
  paths:
  - /pmtiles
```
For style.json we should specify as to call directly from martin (port 3000):
```
"administrative": {
      "type": "vector",
      "tiles": ["http://localhost:3000/administrative/{z}/{x}/{y}"],
      "minzoom": 4, # should follow the zoom range when converted on tippecanou, if not, it can show error on browser network tab because martin cannot find that zoom range
      "maxzoom": 12 # if not, it can show error on browser network tab because martin cannot find that zoom range
    },
```
Or call from Nginx (port 3001):
```
"administrative": {
      "type": "vector",
      "tiles": ["http://localhost:3001/martin/administrative/{z}/{x}/{y}"], # "martin" means Nginx configured already
      "minzoom": 4,
      "maxzoom": 12
    },
```
Nginx config as below:
```
location /martin/ {
    proxy_pass http://martin_server:3000/;  # Fixed container name
```
## 4. Martin (+Postgis), Go-pmtiles, Nginx (focus on Go-pmtiles) ! Not complete yet
Go-Pmtiles will serve pmtiles layers in specific folder, so in docker we can configure and mount:
This method will rely on Nginx to browse the file path
```
volumes:
    - ./data/pmtiles:/data:ro          # mount your pmtiles folder read-only
command: serve /data --port=9000 --cache-size=512
```

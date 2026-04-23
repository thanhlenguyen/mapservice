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
## Parameter to convert to pmtiles or mbtiles
```
tippecanoe --force --no-clipping --layer Short_Address -z16 -Z14 --output address_layer.pmtiles Riyadh.geojson Makkah.geojson Group1ENN.geojson Group2ABJJ.geojson Group3HMQT.geojson

tippecanoe --force --drop-rate g  -z12 -Z4 --output administrative.pmtiles Emirate.geojson Governorate.geojson Emirate_Label.geojson Governorate_Label.geojson

tippecanoe --force --no-clipping  -z13 -Z9 --output city_district_zone.pmtiles CityBoundary.geojson CityCenter.geojson District.geojson ZipCode.geojson

tippecanoe --force --drop-densest-as-needed --layer Street -z15 -Z5 --output street.pmtiles Street.geojson

tippecanoe --force --no-clipping --layer Personalize_Address -z16 -Z12 --output personal_address.mbtiles 'PersonalizeAddress.geojson'

tippecanoe --force --drop-rate g  -z12 -Z1 --output  basemaps1.pmtiles country-boundaries.geojson international.geojson landwater.geojson land_use.geojson
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
    ......
}
```
## 4. Martin (+Postgis), Go-pmtiles, Nginx (focus on Go-pmtiles) ! Not complete yet
Go-Pmtiles will serve pmtiles layers in specific folder, so in docker we can configure and mount:
This method will rely on Nginx to browse the file path
```
volumes:
    - ./data/pmtiles:/data:ro          # mount your pmtiles folder read-only
command: serve /data --port=9000 --cache-size=512
```

## 5. With Kubenates Customize style.json
```bash
{
  "version": 8,
  "name": "Martin All-in-One",
  "sources": {
    "mbtiles-layer": {
      "type": "vector",
      "url": "http://map.172-17-65-26.nip.io/tileserver/data/Administrative.json"
    },
    "mbtiles-via-martin": {
      "type": "vector",
      "tiles": ["http://martin.172-17-65-26.nip.io/Administrative/{z}/{x}/{y}.pbf"]
    },
    "pmtiles-via-martin": {
      "type": "vector",
      "url": "pmtiles://http://martin.172-17-65-26.nip.io/pmtiles/yourfile.pmtiles"
    },
    "dynamic-postgis": {
      "type": "vector",
      "tiles": ["http://martin.172-17-65-26.nip.io/topology.your_table/{z}/{x}/{y}.pbf"]
    }
  },
  "sprite": "http://martin.172-17-65-26.nip.io/sprites/basic",
  "glyphs": "http://martin.172-17-65-26.nip.io/fonts/{fontstack}/{range}.pbf",
  "layers": [...]
}
```
## K3s DNS Fix - Image Pull Issues
Problem
K3s can't pull images because it can't resolve:

registry-1.docker.io (Docker Hub)
ghcr.io (GitHub Container Registry)

Error: dial tcp: lookup registry-1.docker.io: Try again
Root Cause
Your DNS server 10.255.255.254 is blocking or can't resolve these domains.
### Solution 1: Fix System-Wide DNS (Recommended)
#### Step 1: Configure WSL DNS
```bash
# Stop K3s first
sudo systemctl stop k3s

# Configure WSL to not auto-generate resolv.conf
sudo tee /etc/wsl.conf << EOF
[network]
generateResolvConf = false
EOF

# Remove current resolv.conf
sudo rm /etc/resolv.conf

# Create new resolv.conf with Google DNS
sudo tee /etc/resolv.conf << EOF
nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 1.1.1.1
EOF

# Make it immutable
sudo chattr +i /etc/resolv.conf
```
#### Step 2: Restart WSL
From Windows PowerShell:

powershell: `wsl --shutdown`

Then restart your WSL terminal.
#### Step 3: Verify DNS Works
```bash
# Test DNS resolution
nslookup registry-1.docker.io
nslookup ghcr.io
nslookup docker.io

# All should resolve successfully
```
#### Step 4: Start K3s and Verify
```bash 
# Start K3s
sudo systemctl start k3s
sudo systemctl status k3s

# Delete failed pods to force recreation
kubectl delete pod -n map-service --all

# Watch pods restart
kubectl get pods -n map-service -w
```

### Complete Fix Procedure
Run these commands in order:
```bash
# 1. Stop K3s
sudo systemctl stop k3s

# 2. Fix DNS
sudo tee /etc/wsl.conf << EOF
[network]
generateResolvConf = false
EOF

sudo rm /etc/resolv.conf 2>/dev/null || true

sudo tee /etc/resolv.conf << EOF
nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 1.1.1.1
EOF

sudo chattr +i /etc/resolv.conf

# 3. Test DNS
echo "Testing DNS..."
nslookup registry-1.docker.io
nslookup ghcr.io

# 4. Restart K3s
sudo systemctl start k3s
sleep 10
sudo systemctl status k3s

# 5. Delete failed pods
kubectl delete pod -n map-service --all

# 6. Watch pods come back up
kubectl get pods -n map-service -w
```
### If WSL Shutdown Doesn't Work
Some systems need a full reboot. Try this:
```bash
# From Windows PowerShell (as Administrator)
wsl --shutdown
wsl --list --verbose

# If still running, force terminate
wsl --terminate Ubuntu  # or your distro name

# Restart WSL
wsl
```

### Debug Commands
If issues persist:
``` bash
# Check K3s logs
sudo journalctl -u k3s -f

# Check containerd
sudo systemctl status containerd

# Check DNS from inside a pod
kubectl run test-dns --image=busybox --rm -it -- nslookup registry-1.docker.io

# Check K3s DNS
kubectl get pods -n kube-system

# Check CoreDNS logs
kubectl logs -n kube-system -l k8s-app=kube-dns
```
### Why This Happens in WSL
WSL typically:

- Auto-generates /etc/resolv.conf from Windows
- Uses Windows DNS settings
- Windows might be using VPN/Corporate DNS
- That DNS blocks external registries

By setting `generateResolvConf = false`, you take control and use public DNS.

## Let's force clean it and reapply manifests:
```bash
# 1. Check namespace status
kubectl get namespace map-service

# 2. Force delete the namespace (this will hang, that's expected)
kubectl delete namespace map-service --force --grace-period=0 &

# 3. Wait a few seconds
sleep 5

# 4. Remove finalizers to force cleanup
kubectl get namespace map-service -o json | \
  jq '.spec.finalizers = []' | \
  kubectl replace --raw "/api/v1/namespaces/map-service/finalize" -f -

# 5. Wait for namespace to be fully deleted
kubectl get namespace map-service
# Should show "not found"

# 6. Now apply your manifest
kubectl apply -f all-manifests.yaml

# 7. Watch pods come up
kubectl get pods -n map-service -w
```

## ElasticSearch and Kibana cannot install on VM because of limatation resources

### Use a Reverse SSH Tunnel (Secure and No Public Exposure)
This forwards a port on the VM to your local ES without exposing ES to the internet. Initiate the tunnel from your local machine (where ES runs).

1. Set Up the Tunnel:
From your local machine, run:textssh -f -N -R 9201:localhost:9200 lent@10.50.29.9
-f: Runs in background.
-N: No remote command.
-R 9201:localhost:9200: Forwards port 9201 on the VM to port 9200 on your local machine.

Full recommended version (safer & more reliable):
```bash
ssh -f -N -R 9201:localhost:9200 -o ServerAliveInterval=60 lent@10.50.29.9
```
The extra -o ServerAliveInterval=60 helps keep the tunnel alive longer if your network is flaky.

If you use an SSH key instead of password (recommended):
```Bash
ssh -f -N -R 9201:localhost:9200 -i ~/.ssh/your_key lent@10.50.29.9
```
2. Update Your App's Script on the VM:
In your app's configuration or connection script (e.g., in code or env vars), change the ES host from localhost:9200 to localhost:9201 (the forwarded port).
- Example in Python (using elasticsearch-py):textfrom elasticsearch import Elasticsearch
es = Elasticsearch(['http://localhost:9201'])  # Add auth if needed: hosts=[...], http_auth=('user', 'pass')
- Or in a config file/ENV: Set ES_URL='http://localhost:9201'

### Use ES on Non-prod environment

1. Configure Nginx of frontend
```bash
 # =========================
    # Elasticsearch Proxy (secured + CORS)
    # =========================
    location /es/ {
        # Handle preflight OPTIONS request (CORS)
        if ($request_method = 'OPTIONS') {
            add_header 'Access-Control-Allow-Origin' 'https://non-prd-elastic.address.gov.sa' always;
            add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS' always;
            add_header 'Access-Control-Allow-Headers' 'Authorization,Content-Type,Accept,Origin,X-Requested-With' always;
            add_header 'Access-Control-Max-Age' 86400 always;
            add_header 'Access-Control-Allow-Credentials' 'true' always;
            return 204;
        }

        # Forward to Elasticsearch with Basic Auth
        proxy_pass https://non-prd-elastic.address.gov.sa/;

        # Important headers for Elasticsearch
        proxy_http_version 1.1;
        proxy_set_header Host              non-prd-elastic.address.gov.sa;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection        "";

        # Inject Basic Authentication (credentials stay server-side)
        proxy_set_header Authorization "Basic bGVudDI6O11NTSQ2QkN6Q0I3NmQ4dks=";   # Base64 of "lent2:bGVudD"

        # CORS response headers for actual requests
        add_header 'Access-Control-Allow-Origin' 'https://map-tiles-frontend.address.gov.sa' always;
        add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS' always;
        add_header 'Access-Control-Allow-Headers' 'Authorization,Content-Type,Accept,Origin,X-Requested-With' always;
        add_header 'Access-Control-Allow-Credentials' 'true' always;

        # Do not cache search requests
        proxy_cache off;
        expires off;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;

        # Timeouts (adjust if needed)
        proxy_connect_timeout 10s;
        proxy_send_timeout    30s;
        proxy_read_timeout    30s;
    }

```
2. Encoding username:password Into Base64 on Ubuntu:
`echo -n 'lent2:;]MM$6BCzCB76d8vK'  | base64`
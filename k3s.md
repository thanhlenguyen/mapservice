# Set up and deploy mapservice on K3s
## Phase 1: Install k3s and kompose
### Step 1: Update your WSL2 distro
```
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget vim git
sudo apt install -y conntrack socat iproute2
```
### Step 2: Install k3s (lightweight Kubernetes)
```
curl -sfL https://get.k3s.io | sh -
```
Check k3s status
`sudo k3s kubectl get nodes`

You should see one node in Ready status.


Optional alias to simplify kubectl:
```
sudo chown $USER:$USER /etc/rancher/k3s/k3s.yaml
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml' >> ~/.bashrc
```
Then you can just use:
`kubectl get nodes`

### Step 3: Install kompose
```bash
# Download kompose
curl -L https://github.com/kubernetes/kompose/releases/download/v1.37.0/kompose-linux-amd64 -o kompose

# Make it executable
chmod +x kompose

# Move to a directory in PATH
sudo mv kompose /usr/local/bin/

# Verify installation
kompose version
```

## Phase 2: Deploy Map Service on k3s convert docker file and edit YAML files
### Step 1: Ask AI Agent to convert from docker-compose file to k3s Manifest (I used Claude)

List of files provide to AI Agent
  - docker-compose.yml
  - martin-config.yml
  - nginx.conf
  - .env

```bash
# ============================================================================
# K3s Map Service - Complete Manifest
# No Nginx - Direct Ingress Routing
# ============================================================================
# Deployment Strategy:
# 1. Scenario 1: Tileserver (MBTiles) + Martin (PostGIS Dynamic) + Frontend
# 2. Scenario 2: Martin only (MBTiles + PMTiles + PostGIS) + Frontend
# 3. Scenario 3: Frontend with PMTiles direct + Martin (PostGIS only)
# ============================================================================

# ============================================================================
# SECTION 1: NAMESPACE AND CONFIGURATION
# ============================================================================

apiVersion: v1
kind: Namespace
metadata:
  name: map-service

---
# ============================================================================
# Environment Variables ConfigMap
# ============================================================================
apiVersion: v1
kind: ConfigMap
metadata:
  name: map-env-config
  namespace: map-service
data:
  POSTGRES_DB: "geodb"
  POSTGRES_USER: "le"
  POSTGRES_HOST: "postgis-service"
  POSTGRES_PORT: "5432"
  PGADMIN_DEFAULT_EMAIL: "admin@admin.com"

---
# ============================================================================
# Secrets
# ============================================================================
apiVersion: v1
kind: Secret
metadata:
  name: map-secrets
  namespace: map-service
type: Opaque
stringData:
  POSTGRES_PASSWORD: "123456"  # Change in production
  PGADMIN_DEFAULT_PASSWORD: "admin"  # Change in production

---
# ============================================================================
# PostGIS Initialization Script
# ============================================================================
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgis-init
  namespace: map-service
data:
  01-init-extensions.sql: |
    -- Enable PostGIS extensions
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS postgis_topology;
    CREATE EXTENSION IF NOT EXISTS postgis_raster;
    CREATE EXTENSION IF NOT EXISTS pgrouting;
    CREATE EXTENSION IF NOT EXISTS hstore;
    
    -- Grant permissions
    GRANT ALL PRIVILEGES ON DATABASE geodb TO le;
    GRANT ALL ON SCHEMA public TO le;

---
# ============================================================================
# Martin Configuration
# ============================================================================
apiVersion: v1
kind: ConfigMap
metadata:
  name: martin-config
  namespace: map-service
data:
  config.yml: |
    # Martin tile server configuration
    keep_alive: 75
    listen_addresses: '0.0.0.0:3000'
    base_path: /
    worker_processes: 8
    cache_size_mb: 1024
    preferred_encoding: gzip
    web_ui: enable-for-all
    observability:
      metrics:
        add_labels: {}

    cors: 
      origin: 
        - "*"
      max_age: 3600
    
    # PostgreSQL dynamic tiles from PostGIS
    postgres:
      connection_string: "postgresql://le:123456@postgis-service:5432/geodb?sslmode=disable"
      default_srid: 4326
      auto_publish:
        tables:
          from_schemas:
            - topology
          source_id_format: '{schema}.{table}'
          id_columns: id
          clip_geom: true
          buffer: 64
          extent: 4096
    
    # PMTiles support (Scenario 2 & 3)
    pmtiles:
      directory_cache_size_mb: 128
      allow_http: true
      paths:
      - /pmtiles
    
    # MBTiles support (Scenario 2)
    mbtiles:
      paths:
        # - /mbtiles
    
    # Sprites
    sprites:
      cache_size_mb: 64
      paths:
      # - /sprites
      sources:
    
    # Fonts
    fonts:
      cache_size_mb: 64
      paths:
      # - /fonts

    # Styles
    styles:
      paths:
      - /styles

    tilejson_url_version_param: null
---
# ============================================================================
# Tileserver Configuration
# ============================================================================
apiVersion: v1
kind: ConfigMap
metadata:
  name: tileserver-config
  namespace: map-service
data:
  config.json: |
    {
      "options": {
        "paths": {
          "root": "/tileserver",
          "styles": "styles",
          "fonts": "fonts",
          "sprites": "sprites",
          "mbtiles": "/data/mbtiles"
        },
        "domains": [
          "tileserver.172-17-65-26.nip.io",
          "map.172-17-65-26.nip.io"
        ],
        "formatQuality": {
          "jpeg": 80,
          "webp": 90
        },
        "maxScaleFactor": 3,
        "maxSize": 2048,
        "pbfAlias": "pbf",
        "serveAllFonts": true,
        "serveAllStyles": false,
        "serveStaticMaps": true,
        "staticAttributionText": "© OpenMapTiles © OpenStreetMap contributors"
      },
      "styles": {
        "basic-style": {
          "style": "style.json",
          "tilejson": {
            "type": "overlay",
            "bounds": [-180, -85.0511, 180, 85.0511]
          }
        },
        "sat-style": {
          "style": "style_sat.json",
          "tilejson": {
            "type": "overlay",
            "bounds": [-180, -85.0511, 180, 85.0511]
          }
        },
        "3d-style": {
          "style": "style_3d.json",
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
        "City_District_Zone": {
          "mbtiles": "City_District_Zone.mbtiles"
        },
        "address_layer": {
          "mbtiles": "address_layer.mbtiles"
        },
        "street_centerline": {
          "mbtiles": "street_centerline.mbtiles"
        },
        "riyadh": {
          "mbtiles": "riyadh.mbtiles"
        }
      }
    }

---
# ============================================================================
# Frontend Nginx Configuration
# ============================================================================
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-nginx-config
  namespace: map-service
data:
  default.conf: |
    server {
        listen 80;
        server_name _;
        root /usr/share/nginx/html;
        index index.html;

        # Enable CORS for all requests
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods 'GET, POST, OPTIONS' always;
        add_header Access-Control-Allow-Headers 'Content-Type, Authorization' always;

        # Cache static assets
        location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
            add_header Access-Control-Allow-Origin * always;
        }

        # SPA fallback
        location / {
            try_files $uri $uri/ /index.html;
            add_header Cache-Control "no-cache";
        }
    }

---
# ============================================================================
# SECTION 2: STORAGE
# ============================================================================

apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgis-data-pvc
  namespace: map-service
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
  # storageClassName: local-path  # K3s default

---
# ============================================================================
# SECTION 3: DEPLOYMENTS
# ============================================================================

# ============================================================================
# PostGIS Deployment
# ============================================================================
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgis
  namespace: map-service
  labels:
    app: postgis
spec:
  replicas: 1
  strategy:
    type: Recreate  # For database with persistent volume
  selector:
    matchLabels:
      app: postgis
  template:
    metadata:
      labels:
        app: postgis
    spec:
      containers:
      - name: postgis
        image: pgrouting/pgrouting:16-3.5-3.8
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: POSTGRES_DB
          valueFrom:
            configMapKeyRef:
              name: map-env-config
              key: POSTGRES_DB
        - name: POSTGRES_USER
          valueFrom:
            configMapKeyRef:
              name: map-env-config
              key: POSTGRES_USER
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: map-secrets
              key: POSTGRES_PASSWORD
        volumeMounts:
        - name: postgis-data
          mountPath: /var/lib/postgresql/data
        - name: data-import
          mountPath: /data
        - name: postgis-init
          mountPath: /docker-entrypoint-initdb.d
        resources:
          requests:
            memory: "2Gi"
            cpu: "500m"
          limits:
            memory: "4Gi"
            cpu: "2000m"
        readinessProbe:
          exec:
            command: 
              - /bin/sh
              - -c
              - pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 5
          failureThreshold: 12
        livenessProbe:
          exec:
            command:
              - /bin/sh
              - -c
              - pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
      volumes:
      - name: postgis-data
        persistentVolumeClaim:
          claimName: postgis-data-pvc
      - name: data-import
        hostPath:
          path: /mnt/d/Git/mapserver/data  # UPDATE THIS PATH
          type: DirectoryOrCreate
      - name: postgis-init
        configMap:
          name: postgis-init

---
# ============================================================================
# Martin Deployment
# ============================================================================
apiVersion: apps/v1
kind: Deployment
metadata:
  name: martin
  namespace: map-service
  labels:
    app: martin
spec:
  replicas: 1
  selector:
    matchLabels:
      app: martin
  template:
    metadata:
      labels:
        app: martin
    spec:
      containers:
      - name: martin
        image: ghcr.io/maplibre/martin:latest
        ports:
        - containerPort: 3000
          name: http
        command: ["martin", "--config", "/config.yml"]
        volumeMounts:
        - name: martin-config
          mountPath: /config.yml
          subPath: config.yml
        - name: mbtiles
          mountPath: /mbtiles
          readOnly: true
        - name: pmtiles
          mountPath: /pmtiles
          readOnly: true
        - name: fonts
          mountPath: /fonts
          readOnly: true
        - name: sprites
          mountPath: /sprites
          readOnly: true
        - name: styles
          mountPath: /styles
          readOnly: true
        resources:
          requests:
            memory: "1Gi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
      volumes:
      - name: martin-config
        configMap:
          name: martin-config
      - name: mbtiles
        hostPath:
          path: /mnt/d/Git/mapserver/data/mbtiles  # UPDATE THIS PATH
          type: DirectoryOrCreate
      - name: pmtiles
        hostPath:
          path: /mnt/d/Git/mapserver/data/pmtiles  # UPDATE THIS PATH
          type: DirectoryOrCreate
      - name: fonts
        hostPath:
          path: /mnt/d/Git/mapserver/data/fonts  # UPDATE THIS PATH
          type: DirectoryOrCreate
      - name: sprites
        hostPath:
          path: /mnt/d/Git/mapserver/data/sprites  # UPDATE THIS PATH
          type: DirectoryOrCreate
      - name: styles
        hostPath:
          path: /mnt/d/Git/mapserver/styles_k3s/martin  # UPDATE THIS PATH
          type: DirectoryOrCreate

---
# ============================================================================
# Tileserver Deployment
# ============================================================================
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tileserver
  namespace: map-service
  labels:
    app: tileserver
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tileserver
  template:
    metadata:
      labels:
        app: tileserver
    spec:
      containers:
      - name: tileserver
        image: maptiler/tileserver-gl:latest
        ports:
        - containerPort: 8080
          name: http
        args:
          - --config
          - /tileserver/config.json
          - --verbose
        volumeMounts:
        - name: tileserver-config
          mountPath: /tileserver/config.json
          subPath: config.json
        - name: styles
          mountPath: /tileserver/styles
          readOnly: true
        - name: fonts
          mountPath: /tileserver/fonts
          readOnly: true
        - name: sprites
          mountPath: /tileserver/sprites
          readOnly: true
        - name: mbtiles
          mountPath: /data/mbtiles
          readOnly: true
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "2Gi"
            cpu: "1000m"
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
      volumes:
      - name: tileserver-config
        configMap:
          name: tileserver-config
      - name: styles
        hostPath:
          path: /mnt/d/Git/mapserver/styles_k3s/tileserver  # UPDATE THIS PATH
          type: DirectoryOrCreate
      - name: fonts
        hostPath:
          path: /mnt/d/Git/mapserver/data/fonts  # UPDATE THIS PATH
          type: DirectoryOrCreate
      - name: sprites
        hostPath:
          path: /mnt/d/Git/mapserver/data/sprites  # UPDATE THIS PATH
          type: DirectoryOrCreate
      - name: mbtiles
        hostPath:
          path: /mnt/d/Git/mapserver/data/mbtiles  # UPDATE THIS PATH
          type: DirectoryOrCreate

---
# ============================================================================
# Routing API Deployment
# ============================================================================
apiVersion: apps/v1
kind: Deployment
metadata:
  name: routing-api
  namespace: map-service
  labels:
    app: routing-api
spec:
  replicas: 1
  selector:
    matchLabels:
      app: routing-api
  template:
    metadata:
      labels:
        app: routing-api
    spec:
      containers:
      - name: routing-api
        image: python:3.12-slim
        ports:
        - containerPort: 5000
          name: http
        command:
        - sh
        - -c
        - "pip install --no-cache-dir -r requirements.txt && python app.py"
        workingDir: /app
        env:
        - name: POSTGRES_DB
          valueFrom:
            configMapKeyRef:
              name: map-env-config
              key: POSTGRES_DB
        - name: POSTGRES_USER
          valueFrom:
            configMapKeyRef:
              name: map-env-config
              key: POSTGRES_USER
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: map-secrets
              key: POSTGRES_PASSWORD
        - name: POSTGRES_HOST
          valueFrom:
            configMapKeyRef:
              name: map-env-config
              key: POSTGRES_HOST
        - name: POSTGRES_PORT
          valueFrom:
            configMapKeyRef:
              name: map-env-config
              key: POSTGRES_PORT
        volumeMounts:
        - name: routing-api-code
          mountPath: /app
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
      volumes:
      - name: routing-api-code
        hostPath:
          path: /mnt/d/Git/mapserver/routing-api  # UPDATE THIS PATH
          type: Directory

---
# ============================================================================
# PgAdmin Deployment
# ============================================================================
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pgadmin
  namespace: map-service
  labels:
    app: pgadmin
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pgadmin
  template:
    metadata:
      labels:
        app: pgadmin
    spec:
      containers:
      - name: pgadmin
        image: dpage/pgadmin4:latest
        ports:
        - containerPort: 80
          name: http
        env:
        - name: PGADMIN_DEFAULT_EMAIL
          valueFrom:
            configMapKeyRef:
              name: map-env-config
              key: PGADMIN_DEFAULT_EMAIL
        - name: PGADMIN_DEFAULT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: map-secrets
              key: PGADMIN_DEFAULT_PASSWORD
        - name: PGADMIN_CONFIG_ENHANCED_COOKIE_PROTECTION
          value: "False"
        - name: PGADMIN_CONFIG_WTF_CSRF_CHECK_DEFAULT
          value: "False"
        - name: PGADMIN_CONFIG_WTF_CSRF_TIME_LIMIT
          value: "None"
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
        readinessProbe:
          httpGet:
            path: /misc/ping
            port: 80
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        livenessProbe:
          httpGet:
            path: /misc/ping
            port: 80
          initialDelaySeconds: 60
          periodSeconds: 30
          timeoutSeconds: 5
          failureThreshold: 3

---
# ============================================================================
# Frontend Deployment - PROPER FIX with Init Container
# ============================================================================
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: map-service
  labels:
    app: frontend
spec:
  replicas: 1
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      initContainers:  #init container to copy your frontend files to a shared volume, then mount the data directories
      - name: copy-frontend
        image: busybox:latest
        command: ['sh', '-c', 'cp -r /source/* /target/ || true']
        volumeMounts:
        - name: frontend-source
          mountPath: /source
          readOnly: true
        - name: html-volume
          mountPath: /target
      containers:
      - name: frontend
        image: nginx:alpine
        ports:
        - containerPort: 80
          name: http
        volumeMounts:
        - name: nginx-config
          mountPath: /etc/nginx/conf.d/default.conf
          subPath: default.conf
        - name: html-volume
          mountPath: /usr/share/nginx/html
        - name: pmtiles
          mountPath: /usr/share/nginx/html/pmtiles
          readOnly: true
        - name: sprites
          mountPath: /usr/share/nginx/html/sprites
          readOnly: true
        - name: fonts
          mountPath: /usr/share/nginx/html/fonts
          readOnly: true
        - name: styles
          mountPath: /usr/share/nginx/html/styles
          readOnly: true
        resources:
          requests:
            memory: "64Mi"
            cpu: "50m"
          limits:
            memory: "256Mi"
            cpu: "250m"
        readinessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 5
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 10
          periodSeconds: 10
      volumes:
      - name: frontend-source
        hostPath:
          path: /mnt/d/Git/mapserver/frontend_k3s
          type: Directory
      - name: html-volume
        emptyDir: {}
      - name: pmtiles
        hostPath:
          path: /mnt/d/Git/mapserver/data/pmtiles
          type: DirectoryOrCreate
      - name: sprites
        hostPath:
          path: /mnt/d/Git/mapserver/data/sprites
          type: DirectoryOrCreate
      - name: fonts
        hostPath:
          path: /mnt/d/Git/mapserver/data/fonts
          type: DirectoryOrCreate
      - name: styles
        hostPath:
          path: /mnt/d/Git/mapserver/styles_k3s
          type: DirectoryOrCreate    
      - name: nginx-config
        configMap:
          name: frontend-nginx-config

---
# ============================================================================
# SECTION 4: SERVICES
# ============================================================================

apiVersion: v1
kind: Service
metadata:
  name: postgis-service
  namespace: map-service
  labels:
    app: postgis
spec:
  selector:
    app: postgis
  ports:
  - port: 5432
    targetPort: 5432
    name: postgres
  type: ClusterIP

---
apiVersion: v1
kind: Service
metadata:
  name: martin-service
  namespace: map-service
  labels:
    app: martin
spec:
  selector:
    app: martin
  ports:
  - port: 3000
    targetPort: 3000
    name: http
  type: ClusterIP

---
apiVersion: v1
kind: Service
metadata:
  name: tileserver-service
  namespace: map-service
  labels:
    app: tileserver
spec:
  selector:
    app: tileserver
  ports:
  - port: 8080
    targetPort: 8080
    name: http
  type: ClusterIP

---
apiVersion: v1
kind: Service
metadata:
  name: routing-api-service
  namespace: map-service
  labels:
    app: routing-api
spec:
  selector:
    app: routing-api
  ports:
  - port: 5000
    targetPort: 5000
    name: http
  type: ClusterIP

---
apiVersion: v1
kind: Service
metadata:
  name: pgadmin-service
  namespace: map-service
  labels:
    app: pgadmin
spec:
  selector:
    app: pgadmin
  ports:
  - port: 80
    targetPort: 80
    name: http
  type: ClusterIP

---
apiVersion: v1
kind: Service
metadata:
  name: frontend-service
  namespace: map-service
  labels:
    app: frontend
spec:
  selector:
    app: frontend
  ports:
  - port: 80
    targetPort: 80
    name: http
  type: ClusterIP

---
# ============================================================================
# SECTION 5: INGRESS
# ============================================================================

apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: map-main-ingress
  namespace: map-service
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: web
    # For HTTPS (after installing cert-manager):
    # traefik.ingress.kubernetes.io/router.entrypoints: websecure
    # cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: traefik
  # For HTTPS (uncomment after installing cert-manager):
  # tls:
  # - hosts:
  #   - map.172-17-65-26.nip.io
  #   - martin.172-17-65-26.nip.io
  #   - tileserver.172-17-65-26.nip.io
  #   - pgadmin.172-17-65-26.nip.io
  #   - api.172-17-65-26.nip.io
  #   secretName: map-tls-cert
  rules:
  # Frontend
  - host: map.172-17-65-26.nip.io  # UPDATE: Replace with your node IP
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: frontend-service
            port:
              number: 80

  # Martin - Vector tiles and dynamic PostGIS layers
  - host: martin.172-17-65-26.nip.io  # UPDATE: Replace with your node IP
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: martin-service
            port:
              number: 3000

  # Tileserver - MBTiles rendering
  - host: tileserver.172-17-65-26.nip.io  # UPDATE: Replace with your node IP
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: tileserver-service
            port:
              number: 8080

  # PgAdmin - Database administration
  - host: pgadmin.172-17-65-26.nip.io  # UPDATE: Replace with your node IP
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: pgadmin-service
            port:
              number: 80
  
  # Routing API
  - host: api.172-17-65-26.nip.io  # UPDATE: Replace with your node IP
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: routing-api-service
            port:
              number: 5000
```
What You Have Now

- Namespace and ConfigMaps - All configuration organized and ready
- PostGIS Database - With persistent storage and health checks
- Martin Server - For serving vector tiles from PostGIS
- Tileserver-GL - For serving raster tiles from MBTiles
- Routing API - Your Python routing service
- PgAdmin - Database management interface
- Nginx - Frontend proxy and static file server
- Ingress - Domain-based routing

Key Differences from Docker Compose

- Services → Kubernetes Services (ClusterIP for internal, NodePort for external)
- Volumes → PersistentVolumeClaims and hostPath mounts
- Environment Variables → ConfigMaps and Secrets
- Depends_on → Handled by readiness/liveness probes
- Container Names → Pod names (auto-generated with deployment name prefix)

### Step 2: Edit the paths: 
- Open the file in a text editor and `find/replace` `/home/user/project` or `/path/to/your/project` with the actual absolute path to your project directory on the server.
- In my case, I store on Windows `D:\Git\mapserver\`, need to change to k3s/WSL2 `/mnt/d/Git/mapserver/` then replace `/home/user/project`
- Prerequisites:
    1. K3s cluster installed and running
    2. `kubectl` configured to access your cluster
    3. All your data files and frontend code available on the K3s node(s)

### Step 3: Apply to k3s:
```bash
kubectl apply -f all-manifests.yaml
```
### Step 4: Check status and get logs:
```bash
### Check Pod Status

# View all pods
kubectl get pods -n map-service

# Check specific pod logs
kubectl logs -n map-service <pod-name>

# Describe pod (shows events and errors)
kubectl describe pod -n map-service <pod-name>
```

### Step 5: TroubleShooting

#### 1. PostGIS Won't Start

```bash
# Check logs
kubectl logs -n map-service -l app=postgis

# Common causes:
# - PVC not bound (check: kubectl get pvc -n map-service)
# - Insufficient resources
# - Data directory permission issues
```

#### 2. Martin Can't Connect to PostGIS

```bash
# Check Martin logs
kubectl logs -n map-service -l app=martin

# Verify PostGIS is ready
kubectl get pods -n map-service -l app=postgis

# Test connection from Martin pod
kubectl exec -n map-service -it <martin-pod-name> -- /bin/sh
# Then try: psql postgresql://le:123456@postgis-service:5432/geodb
```

#### 3. Tileserver Can't Find MBTiles

```bash
# Check Tileserver logs
kubectl logs -n map-service -l app=tileserver

# Verify the hostPath exists on the node
kubectl describe pod -n map-service <tileserver-pod-name>

# Check if files are mounted
kubectl exec -n map-service -it <tileserver-pod-name> -- ls -la /data/mbtiles
```

#### 4. Nginx Can't Serve Frontend

```bash
# Check Nginx logs
kubectl logs -n map-service -l app=nginx

# Verify frontend files
kubectl exec -n map-service -it <nginx-pod-name> -- ls -la /usr/share/nginx/html
```

#### 5. Routing API Fails

```bash
# Check Routing API logs
kubectl logs -n map-service -l app=routing-api

# Common causes:
# - Missing requirements.txt
# - Python dependencies not installed
# - Database connection issues
```
#### 6. updating manifests (ex: ConfigMap) → rollout restart deployment:
```bash
# Edit manifest (ConfigMap of nginx for example) and save then run:
kubectl -n map-service rollout restart deployment nginx
```

## Step 6: Verify Deployment

Check that all pods are running:

```bash
kubectl get pods -n map-service
```

Expected output should show all pods in "Running" status:
```
NAME                           READY   STATUS    RESTARTS   AGE
postgis-xxx                    1/1     Running   0          2m
martin-xxx                     1/1     Running   0          1m
tileserver-xxx                 1/1     Running   0          1m
routing-api-xxx                1/1     Running   0          1m
pgadmin-xxx                    1/1     Running   0          1m
nginx-xxx                      1/1     Running   0          1m
```
Check services:
```bash
kubectl get svc -n map-service
```

## Step 7: Access Your Services

### Using Ingress
```bash
#To get your node IP:

kubectl get nodes -o wide
```
- You should be able to access:
```
http://map.172-17-65-26.nip.io              → main frontend
http://tileserver.172-17-65-26.nip.io       → direct Tilserver
http://martin.172-17-65-26.nip.io           → direct Martin API
http://pgadmin.172-17-65-26.nip.io          → direct PgAdmin
```
### Individual Service Access (for debugging)

```bash
# Test PostGIS
kubectl exec -n map-service -it <postgis-pod-name> -- psql -U le -d geodb -c "SELECT version();"

# Test PgAdmin
kubectl port-forward -n map-service svc/pgadmin-service 5050:80
# Then visit: http://localhost:5050

# Test Martin API
kubectl port-forward -n map-service svc/martin-service 3000:3000
# Then visit: http://localhost:3000

# Test Tileserver
kubectl port-forward -n map-service svc/tileserver-service 8080:8080
# Then visit: http://localhost:8080

# Test Routing API
kubectl port-forward -n map-service svc/routing-api-service 5000:5000
# Then test: curl http://localhost:5000/health (if you have a health endpoint)
```

## Step 8: Customize style.json
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

## Step 9 Import your data into PostGIS
   ```bash
   kubectl exec -it -n map-service <postgis-pod-name> -- bash
   psql -U le -d geodb
   # Run your SQL imports
```
### 1. GeoJson → PostGIS  
Use ogr2ogr to load into PostGIS: The PostGIS container doesn't have ogr2ogr installed, so:
- Solution 1:
```bash
# On your local machine, convert GeoJSON to SQL
ogr2ogr -f "PGDUMP" \
  /tmp/places.sql \
  /mnt/d/Git/mapserver/data/pois.geojson \
  -lco GEOMETRY_NAME=geom \
  -lco FID=id \
  -lco SCHEMA=topology \
  -lco CREATE_SCHEMA=ON

# Then import the SQL file
cat /tmp/places.sql | kubectl exec -i -n map-service deployment/postgis -- \
  psql -U le -d geodb
```
Solution 2:  
```bash
# Terminal 1: Start port forwarding
kubectl port-forward -n map-service svc/postgis-service 5432:5432

# Terminal 2: Run your original command with localhost
ogr2ogr \
  -f PostgreSQL \
  "PG:host=localhost port=5432 user=le password=123456 dbname=geodb" \
  -nln topology.places \
  -overwrite \
  -progress \
  -lco GEOMETRY_NAME=geom \
  -lco FID=id \
  -lco SPATIAL_INDEX=GIST \
  -lco COLUMN_TYPES=properties=jsonb \
  --config PG_USE_COPY YES \
  /mnt/d/Git/mapserver/data/pois.geojson

-nln name               # target table name
-overwrite              # drop & recreate table if exists
-append                 # add features to existing table
-progress               # show progress bar
-lco GEOMETRY_NAME=geom # name of geometry column
-lco FID=id             # name of primary key / feature id column
-lco SPATIAL_INDEX=GIST # create spatial index (almost always wanted)
--config PG_USE_COPY YES # much faster than INSERT
-nlt PROMOTE_TO_MULTI   # convert simple geometries to MULTI*
-a_srs EPSG:4326        # force SRID if source has no CRS

# Restart Martin to pick up new tables
kubectl rollout restart deployment/martin -n map-service

# Check Martin catalog
curl http://martin.172-17-65-26.nip.io/catalog

# You should see: topology.places in the list
```
### 2: Other formats - example for solution 2:
```bash
# ─────────────────────────────────────────────────────────────
# Shapefile → PostGIS
# ─────────────────────────────────────────────────────────────
ogr2ogr \
  -f "PostgreSQL" \
  PG:"host=locahost port=5432 user=le password=123456 dbname=geodb" \
  -nln topology.places -lco GEOMETRY_NAME=geom \
  -lco SPATIAL_INDEX=YES \
  pois.shp

# ─────────────────────────────────────────────────────────────
# CSV with lon,lat columns
# ─────────────────────────────────────────────────────────────
ogr2ogr \
  -f PostgreSQL \
  PG:"host=locahost port=5432 user=le password=123456 dbname=geodb" \
  -nln topology.places \
  -oo X_POSSIBLE_NAMES=lon* \
  -oo Y_POSSIBLE_NAMES=lat* \
  -oo KEEP_GEOM_COLUMNS=NO \
  -lco GEOMETRY_NAME=geom \
  pois.csv
```

## 📊 Monitoring

### View Resource Usage

```bash
# Pod resource usage
kubectl top pods -n map-service

# Node resource usage
kubectl top nodes
```

### Check Service Endpoints

```bash
# List all services
kubectl get svc -n map-service

# Get service details
kubectl describe svc -n map-service nginx-service
```

## 🔄 Updates and Maintenance

### Update Frontend

```bash
# Update index.html on the node
# Then restart nginx pod
kubectl rollout restart deployment nginx -n map-service
```

### Update Configuration

```bash
# Edit ConfigMap
kubectl edit configmap martin-config -n map-service

# Restart affected service
kubectl rollout restart deployment martin -n map-service

# Monitor status
kubectl rollout status deployment/martin -n map-service
```

### Scale Services

```bash
# Scale nginx (stateless)
kubectl scale deployment nginx -n map-service --replicas=3

# Scale martin
kubectl scale deployment martin -n map-service --replicas=2

# Note: Don't scale postgis (needs shared storage)
```

### Backup Database

```bash
# Backup PostGIS database
kubectl exec -n map-service <postgis-pod-name> -- \
  pg_dump -U le geodb > backup-$(date +%Y%m%d).sql

# Restore
kubectl exec -i -n map-service <postgis-pod-name> -- \
  psql -U le geodb < backup-20231227.sql
```

## 🗑️ Cleanup

### Remove Everything

```bash
# Delete the entire namespace (removes all resources)
kubectl delete namespace map-service
```

### Remove Specific Components

```bash
# Delete specific deployments
kubectl delete deployment nginx -n map-service
kubectl delete deployment martin -n map-service

# Delete services
kubectl delete svc nginx-service -n map-service

# Delete specific pod
kubectl delete pod <pod-name> -n map-service

```

## 📚 Useful Commands Reference

```bash
# View all resources
kubectl get all -n map-service

# Stream logs
kubectl logs -f -n map-service <pod-name>

# Execute commands in pod
kubectl exec -it -n map-service <pod-name> -- sh

# Copy files to/from pod
kubectl cp file.txt map-service/<pod-name>:/tmp/file.txt
kubectl cp map-service/<pod-name>:/tmp/file.txt ./file.txt

# Get pod YAML
kubectl get pod <pod-name> -n map-service -o yaml

# Port forward multiple services
kubectl port-forward -n map-service svc/nginx-service 8080:80 &
kubectl port-forward -n map-service svc/pgadmin-service 5050:80 &
```

## 🆘 Getting Help

- Check logs: `kubectl logs -n map-service <pod-name>`
- Describe resources: `kubectl describe <resource-type> <name> -n map-service`
- Check events: `kubectl get events -n map-service --sort-by='.lastTimestamp'`
- Test connectivity: `kubectl run -it --rm debug --image=busybox --restart=Never -n map-service -- sh`

## 🎯 Notes
- After firsttime deployment, if you edit manifest file and restart service:
```bash
kubectl rollout restart deployment tileserver-n map-service
```
does not re-read your YAML file, only recreates the pods with current spec — it does not guarantee that the application inside the pod will re-read the configuration file (manifest / config.json) from the ConfigMap.
⚖️ Workflow Comparison
Command	Effect
kubectl apply -f file.yaml	Updates the cluster with changes from your manifest
kubectl rollout restart deployment ...	Restarts pods using the existing spec in the cluster
kubectl delete pod ...	Deletes pods; Deployment/ReplicaSet will recreate them with the current spec

- If DNS have some issues, application cannot load:
  - 
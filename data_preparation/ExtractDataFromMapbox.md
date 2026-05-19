## 1. Connect to VM
Log in to mount machine on Virtual Machine
Log in ssh to VM: ssh lent@10.50.29.9
Create new directory if needed `mkdir directory_name`
Google Cloud Storage (GCS) bucket named: `na-dev-map-tiles` to a local directory: `/home/lent/na-dev-map-tiles/` on VM (10.50.29.9):  
```bash
gcsfuse \
  --implicit-dirs \
  --file-cache-max-size-mb=4000 \
  --file-cache-cache-file-for-range-read=true \
  --metadata-cache-ttl-secs=3600 \
  --type-cache-max-size-mb=32 \
  --stat-cache-max-size-mb=64 \
  --kernel-list-cache-ttl-secs=3600 \
  --max-conns-per-host=10 \
  na-dev-map-tiles \
  /home/lent/na-dev-map-tiles/
```
## 2. Convert mbtiles to pmtiles
Download and extract zip file `https://github.com/protomaps/go-pmtiles/releases`
Run on Ubuntu:
- Make it executable: `chmod +x pmtiles `
- Move to PATH (kind of environment in Ubuntu): `sudo mv pmtiles /usr/local/bin/`
- Execute to check version: `pmtiles version`
- Convert from mbtiles to pmtiles: `pmtiles convert INPUT.mbtiles OUTPUT.pmtiles`

## 3. Convert to GeoJson
Using GDAL: 
- Install GDAL `sudo apt install -y gdal-bin python3-gdal`
- Check layer names: `ogrinfo your.mbtiles`
- Check layer names by sqlite3 and jq: `sqlite3 your_file.mbtiles "SELECT value FROM metadata WHERE name='json';" | jq -r '.vector_layers[].id'`
- One layer → GeoJSON: `ogr2ogr -f GeoJSON out.geojson your.mbtiles layername -spat minx miny maxx maxy`
- Multi layers → GeoJSON: `ogr2ogr -f GeoJSON output_dir/ yourfile.mbtiles building water landuse -spat minx miny maxx maxy`
- All layers → GeoJSON: `ogr2ogr -f GeoJSON output_dir/ yourfile.mbtiles -spat minx miny maxx maxy`
- Dissolve grid in QGIS
- Convert back to mbtiles: `tippecanoe -o clipped.mbtiles clipped.geojson`

## 4. Tippecanoe to convert vector files (GeoJson, ..) to Mbtiles, Pmtiles 
1. Install tippecanoe: 
```bash
# Install Dependencies
sudo apt update
sudo apt install build-essential libsqlite3-dev zlib1g-dev git

# Clone the repository
git clone https://github.com/felt/tippecanoe.git

# Move into the directory
cd tippecanoe

# Compile the source code (-j uses multiple cores to speed it up)
make -j

# Install it to /usr/local/bin
sudo make install

# Verify Installation
tippecanoe --version
```
2. Convert vector files:
- To Mbtiles: `tippecanoe --force --no-clipping --layer Short_Address -z15 -Z14 --output address_layer.mbtiles Riyadh.geojson Makkah.geojson Group1ENN.geojson Group2ABJJ.geojson Group3HMQT.geojson`
- To Pmtiles: `tippecanoe --force --no-clipping --layer Short_Address -z15 -Z14 --output address_layer.pmtiles Riyadh.geojson Makkah.geojson Group1ENN.geojson Group2ABJJ.geojson Group3HMQT.geojson`

## 5. Rio to convert GeoTiff to Mbtiles, Pmtiles

1. Install package in virtual environment in Ubuntu: (prefer)
```bash
cd /mnt/d/Git/mapserver
python3 -m venv env
pip install rio rio-pmtiles rio-mbtiles
```

2. Convert to pmtiles and mbtiles
```bash
rio mbtiles Riyadh.tif -o riyadh.mbtiles --format WEBP --resampling bilinear --zoom-levels 8..18 --overwrite --progress-bar 
rio pmtiles Riyadh.tif -o riyadh.pmtiles --format WEBP --resampling bilinear --zoom-levels 8..18 --overlay
```
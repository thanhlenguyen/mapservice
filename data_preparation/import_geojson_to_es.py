import json
from elasticsearch import Elasticsearch, helpers

# Connect to ES (update host if not localhost: http://localhost:9200, dev host: https://non-prd-elastic-mapservice.address.gov.sa/)
es = Elasticsearch(["http://localhost:9200"])

geojson_file = "/mnt/d/Git/mapserver/data/Units.geojson"  # Path to your GeoJSON file
# path for windows: r"D:\Git\mapserver\data\Units.geojson"
index = "building_units"  # Target ES index name

# Load GeoJSON
with open(geojson_file, "r") as f:  # Replace with your file path
    geojson_data = json.load(f)

# Prepare bulk actions (one document per feature)
actions = []
for feature in geojson_data["features"]:
    doc = {
        "_index": index,  # Your index name
        "_source": {
            "properties": feature["properties"],  # Spread properties
            "geometry": feature["geometry"]  # GeoJSON geometry
        }
    }
    actions.append(doc)

# Bulk index
helpers.bulk(es, actions)
print("Import completed!")
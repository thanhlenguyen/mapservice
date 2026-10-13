import ssl
from elasticsearch import Elasticsearch
from elasticsearch.connection import RequestsHttpConnection

context = ssl.create_default_context()
context.check_hostname = False
context.verify_mode = ssl.CERT_NONE

es = Elasticsearch(
    ["https://10.50.14.11:443"],
    basic_auth=("elastic", "290XqHXE74b5JYT673PGWo5b"),
    connection_class=RequestsHttpConnection,
    ssl_context=context,
    request_timeout=60
)

# Then same test code as above...
try:
    info = es.info()
    print("✅ Connected successfully to Elasticsearch!")
    print("Cluster name :", info.get("cluster_name"))
    print("Version      :", info["version"]["number"])
    
    # Check your index
    if es.indices.exists(index="building_units"):
        print("✅ Index 'building_units' exists")
        mapping = es.indices.get_mapping(index="building_units")
        # print(mapping)   # Uncomment if you want to see the full mapping
    else:
        print("⚠️  Index 'building_units' does NOT exist yet")
        
except Exception as e:
    print("❌ Failed to connect:")
    print(type(e).__name__ + ":", e)
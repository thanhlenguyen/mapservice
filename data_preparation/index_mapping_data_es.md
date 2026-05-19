building_units.geojson
```json
PUT /building_units
{
  "settings": {
    "analysis": {
      "normalizer": {
        "lowercase_normalizer": {
          "type": "custom",
          "filter": ["lowercase", "asciifolding"]
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

buildings_vertical
```json
PUT /buildings_vertical
{
  "settings": {
    "analysis": {
      "normalizer": {
        "lowercase_normalizer": {
          "type": "custom",
          "filter": ["lowercase", "asciifolding"]
        }
      }
    }
  },    
  "mappings": {
    "dynamic": "true",              // ← change to "strict" later when stable
    "properties": {
      "ShortAddress": { "type": "keyword", "normalizer": "lowercase_normalizer" }, // exact match, no full-text needed (codes like "12345 67890") 
      "NoofFloors": { "type": "integer" },  
      "BuildingHeight": { "type": "float" },
      "fkFloorID": { "type": "keyword", "normalizer": "lowercase_normalizer" },
      "UnitAddress": { "type": "keyword", "normalizer": "lowercase_normalizer" },
      "FloorNumber": { "type": "integer" },
      "FloorUsage": { "type": "keyword", "normalizer": "lowercase_normalizer"  },
      "geometry": { "type": "geo_shape" }
    }
  }
}
```
buildings_vertical_sample
```json
PUT /buildings_vertical
{
  "settings": {
    "analysis": {
      "normalizer": {
        "lowercase_normalizer": {
          "type": "custom",
          "filter": ["lowercase", "asciifolding"]
        }
      }
    }
  },    
  "mappings": {
    "dynamic": "true",              // ← change to "strict" later when stable
    "properties": {
      "fkShortAddress": { "type": "keyword", "normalizer": "lowercase_normalizer" }, // exact match, no full-text needed (codes like "12345 67890") 
      "UnitVerticalAddress": { "type": "keyword", "normalizer": "lowercase_normalizer" }, 
      "UseType": { "type": "keyword", "normalizer": "lowercase_normalizer" }, 
      "Occupant": { "type": "keyword", "normalizer": "lowercase_normalizer" }, 
      "BuildingID": { "type": "keyword", "normalizer": "lowercase_normalizer" },
      "FloorID": { "type": "keyword", "normalizer": "lowercase_normalizer" }, // Convert string to int when refactor
      "NoofFloors": { "type": "integer" },  
      "BuildingHeight": { "type": "float" },
      "FloorAboveGround": { "type": "integer" },
      "Unit_Type": { "type": "integer" },
      "geometry": { "type": "geo_shape" }
    }
  }
}
```
Reindex:
```json
POST _reindex
{
  "source": {
    "index": "buildings_vertical"
  },
  "dest": {
    "index": "buildings_vertical_v2"
  }
}
```
Remove old one 
```json
DELETE buildings_vertical
```

Alias new one with old name incase we don't want to change the code of app

```json
POST _aliases
{
  "actions": [
    { "add": { "index": "buildings_vertical_v2", "alias": "buildings_vertical" } }
  ]
}

Note: 
- To put data by python code
  - Use python in PowerShell to get the effect from VPN (or try to install VPN for Ubuntu - Currently Ubuntu run on PowerShell so it does not effect VPN)
  - Because of ES on K8s is lower version, so the in the environmemt to run python on K8s, we need to downgrade elasticsearch version 
```bash
 # In PowerShell
 python -m pip intall "elasticsearch>=8.0.0,<9.0.0"
```
- To query data in map, we need to config nginx
const STYLES = [
    { id: 'basic', name: 'Default', url: 'http://localhost:8080/styles/basic-style/style.json', pitch: 0, zoom: 12 },
    { id: 'sat', name: 'Satellite', url: 'http://localhost:8080/styles/sat-style/style.json', pitch: 0, zoom: 12 },
    { id: '3d', name: '3D', url: 'http://localhost:8080/styles/3d-style/style.json', pitch: 45, zoom: 14 }
];

let currentCenter = [46.6167, 24.8258]; // Riyadh
let currentZoom = 12;
let currentPitch = 0;
let currentBearing = 0;

let map;
let currentMode = 'route';
let startMarker = null;
let endMarker = null;
let crimeMarker = null;
let facilityMarker = null;
let tspMarkers = [];
let currentRouteData = null;
let escapeMinutes = 5;

const FACILITY_COLORS = {
    'hospital': '#ef4444',
    'fire_station': '#f97316',
    'police': '#8b5cf6',
    'clinic': '#10b981'
};

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
        if (currentMode === 'route') handleRouteClick(e.lngLat);
        else if (currentMode === 'tsp') handleTSPClick(e.lngLat);
        else if (currentMode === 'facility') handleFacilityClick(e.lngLat);
        else handleCrimeClick(e.lngLat);
    });

    // Mode buttons
    document.getElementById('mode-route').onclick = () => switchMode('route');
    document.getElementById('mode-tsp').onclick = () => switchMode('tsp');
    document.getElementById('mode-facility').onclick = () => switchMode('facility');
    document.getElementById('mode-crime').onclick = () => switchMode('crime');

    document.getElementById('time-input').oninput = (e) => {
        escapeMinutes = parseInt(e.target.value);
        document.getElementById('time-value').textContent = escapeMinutes;
        if (crimeMarker) calculateEscapeArea(crimeMarker.getLngLat());
    };

    map.on('load', () => showInfo("Click anywhere to begin"));
}

function switchMode(mode) {
    currentMode = mode;
    clearAll();

    // Reset all buttons
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    // Activate current button
    const activeBtn = document.getElementById(`mode-${mode}`);
    if (activeBtn) activeBtn.classList.add('active');

    const timeSlider = document.getElementById('time-slider');
    const instruction = document.getElementById('mode-instruction');

    timeSlider.classList.toggle('hidden', mode !== 'crime');

    if (mode === 'route') {
        instruction.innerHTML = 'Click: <span class="highlight start">Start</span> → <span class="highlight end">End</span>';
        showInfo("🗺️ A→B Route mode active");
    } else if (mode === 'tsp') {
        instruction.innerHTML = 'Click to add <span style="color:#8b5cf6;font-weight:bold">waypoints</span> (min 3)';
        showInfo("🔄 TSP mode: Add at least 3 points");
    } else if (mode === 'facility') {
        instruction.innerHTML = 'Click a <span style="color:#ef4444;font-weight:bold">location</span> to find nearest facilities';
        showInfo("🏥 Nearest Facility mode active");
    } else { // crime
        instruction.innerHTML = 'Click <span style="color:#ef4444;font-weight:bold">incident location</span> + adjust time';
        showInfo("🚚 Service Area mode active");
    }
}

function handleRouteClick(lngLat) {
    if (!startMarker) {
        startMarker = new maplibregl.Marker({ element: createMarker('S', '#10b981') })
            .setLngLat(lngLat)
            .addTo(map);
        showInfo("✅ Start set. Click destination");
    } else if (!endMarker) {
        endMarker = new maplibregl.Marker({ element: createMarker('E', '#ef4444') })
            .setLngLat(lngLat)
            .addTo(map);
        calculateRoute(startMarker.getLngLat(), endMarker.getLngLat());
    } else {
        clearAll();
        showInfo("🔄 Cleared. Click new start point");
    }
}

function handleTSPClick(lngLat) {
    const markerNum = tspMarkers.length + 1;
    const marker = new maplibregl.Marker({
        element: createMarker(markerNum.toString(), '#9333ea')
    })
        .setLngLat(lngLat)
        .addTo(map);

    tspMarkers.push({ marker, lngLat });

    if (tspMarkers.length < 3) {
        showInfo(`✅ Point ${markerNum} added. Need ${3 - tspMarkers.length} more (min 3 points)`);
    } else {
        showInfo(`✅ Point ${markerNum} added. Auto-calculating TSP in 2 seconds...`);
        setTimeout(() => {
            if (tspMarkers.length >= 3) calculateTSP();
        }, 2000);
    }
}

// Called when user clicks on map in 'facility' mode
function handleFacilityClick(lngLat) {
    // Clean up previous state
    if (facilityMarker) {
        facilityMarker.remove();
        facilityMarker = null;
    }

    // Remove old results
    ['facility-lines', 'facility-points'].forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource('facility-results')) map.removeSource('facility-results');

    // Place temporary marker at click location
    facilityMarker = new maplibregl.Marker({
        element: createMarker('📍', '#dc2626')
    })
        .setLngLat(lngLat)
        .addTo(map);

    showInfo("⏳ Searching nearest facilities...");

    // Delegate the actual search to separate function
    calculateNearestFacilities(lngLat);
}

function handleCrimeClick(lngLat) {
    if (crimeMarker) crimeMarker.remove();
    crimeMarker = new maplibregl.Marker({ element: createMarker('🚚', '#1c2ae1ff') })
        .setLngLat(lngLat)
        .addTo(map);
    calculateEscapeArea(lngLat);
}

function createMarker(text, bgColor = null) {
    const el = document.createElement('div');
    el.className = 'marker';
    if (text === '🚚') el.classList.add('marker-crime');
    if (text === 'E') el.classList.add('marker-end');
    if (bgColor) el.style.backgroundColor = bgColor;
    el.textContent = text;
    return el;
}

function showInfo(text) {
    const infoBox = document.getElementById('info-box');
    const routeInfo = document.getElementById('route-info');
    infoBox.classList.remove('hidden');
    routeInfo.innerHTML = text;
}

function calculateRoute(start, end) {
    showInfo("⏳ Calculating route...");

    fetch(`/api/route?start_lon=${start.lng}&start_lat=${start.lat}&end_lon=${end.lng}&end_lat=${end.lat}`)
        .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
        .then(data => {
            if (data.error) throw new Error(data.error);
            currentRouteData = data;
            addRouteLayer(data, '#3b82f6');
            fitToFeatures(data);
            showInfo(`✅ Route: ${data.duration_minutes} min • ${data.total_distance_km} km`);
        })
        .catch(err => {
            showInfo("❌ Error: " + err.message);
            console.error(err);
        });
}

function calculateTSP() {
    if (tspMarkers.length < 2) return showInfo("❌ Need at least 2 points for TSP");

    showInfo(`⏳ Solving TSP for ${tspMarkers.length} points...`);

    const points = tspMarkers.map(m => [m.lngLat.lng, m.lngLat.lat]);

    fetch('/api/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points })
    })
        .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
        .then(data => {
            if (data.error) throw new Error(data.error);
            currentRouteData = data;
            addRouteLayer(data, '#9333ea');
            fitToFeatures(data);

            const orderStr = data.waypoint_order.map(i => i + 1).join(' → ');
            showInfo(`
                ✅ <strong>TSP Optimized!</strong><br>
                Order: ${orderStr}<br>
                ${data.duration_minutes} min • ${data.total_distance_km} km
            `);
        })
        .catch(err => {
            showInfo("❌ " + err.message);
            console.error(err);
        });
}

// Separate function - handles API call and visualization
function calculateNearestFacilities(lngLat) {
    // For now fixed to hospital - later can be made dynamic
    const facilityType = document.getElementById('facility-type-select')?.value || 'hospital';

    showInfo("⏳ Searching nearest facilities... (this may take 10-15 seconds)");
    // Add timeout on client side
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout
    fetch(`/api/nearest_facility?lon=${lngLat.lng}&lat=${lngLat.lat}&type=${facilityType}&limit=5`, {
        signal: controller.signal
    })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Server error ${response.status} - ${response.statusText}`);
            }
            return response.json();
        })
        .then(data => {
            // Handle different response shapes
            if (data.error) {
                throw new Error(data.error);
            }

            if (!data.facilities || data.facilities.length === 0) {
                showInfo(`No ${facilityType} found in network reach`);
                return;
            }

            // Build LineString features from click point → each facility
            const features = data.facilities.map(f => ({
                type: "Feature",
                geometry: {
                    type: "LineString",
                    coordinates: [
                        [lngLat.lng, lngLat.lat],
                        [parseFloat(f.facility_lon), parseFloat(f.facility_lat)]
                    ]
                },
                properties: {
                    name: f.name,
                    minutes: f.travel_minutes,
                    type: f.type,
                    address: f.address || ''
                }
            }));

            // Add source
            map.addSource('facility-results', {
                type: 'geojson',
                data: {
                    type: "FeatureCollection",
                    features: features
                }
            });

            // Lines
            map.addLayer({
                id: 'facility-lines',
                type: 'line',
                source: 'facility-results',
                paint: {
                    'line-color': FACILITY_COLORS[facilityType] || '#6366f1',
                    'line-width': 5,
                    'line-opacity': 0.65,
                    'line-dasharray': [2, 1.5]
                }
            });

            // Facility points
            map.addLayer({
                id: 'facility-points',
                type: 'circle',
                source: 'facility-results',
                paint: {
                    'circle-radius': 8,
                    'circle-color': FACILITY_COLORS[facilityType] || '#6366f1',
                    'circle-stroke-color': 'white',
                    'circle-stroke-width': 2.5
                }
            });

            // Hover & click interaction
            map.on('mouseenter', 'facility-points', () => {
                map.getCanvas().style.cursor = 'pointer';
            });
            map.on('mouseleave', 'facility-points', () => {
                map.getCanvas().style.cursor = '';
            });

            map.on('click', 'facility-points', (e) => {
                const props = e.features[0].properties;
                new maplibregl.Popup({ offset: 15 })
                    .setLngLat(e.lngLat)
                    .setHTML(`
                        <strong>${props.name}</strong><br>
                        ${props.address ? `<small>${props.address}</small><br>` : ''}
                        <em>≈ ${props.minutes.toFixed(1)} minutes drive</em>
                    `)
                    .addTo(map);
            });

            // Final feedback
            showInfo(`Found ${data.count} ${facilityType}(s)<br>Closest: ${data.facilities[0].name} (${data.facilities[0].travel_minutes.toFixed(1)} min)`);

            // Fit view
            const bounds = new maplibregl.LngLatBounds();
            bounds.extend([lngLat.lng, lngLat.lat]);
            data.facilities.forEach(f => {
                bounds.extend([parseFloat(f.facility_lon), parseFloat(f.facility_lat)]);
            });
            map.fitBounds(bounds, { padding: 100, maxZoom: 15 });
        })
        .catch(error => {
            console.error('Facility search failed:', error);
            showInfo(`❌ ${error.message}`);
        });
}

function calculateEscapeArea(lngLat) {
    showInfo(`⏳ Calculating ${escapeMinutes}-min escape area...`);

    fetch(`/api/escape_area?lon=${lngLat.lng}&lat=${lngLat.lat}&minutes=${escapeMinutes}`)
        .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
        .then(data => {
            if (data.error) throw new Error(data.error);

            // Remove old escape layers
            ['escape-network', 'escape-hull', 'escape-border'].forEach(id => {
                if (map.getLayer(id)) map.removeLayer(id);
                if (map.getSource(id)) map.removeSource(id);
            });

            // Reachable network
            map.addSource('escape-network', { type: 'geojson', data: data.reachable_network });
            map.addLayer({
                id: 'escape-network',
                type: 'line',
                source: 'escape-network',
                paint: { 'line-color': '#f59e0b', 'line-width': 3, 'line-opacity': 0.6 }
            });

            // Escape hull
            map.addSource('escape-hull', { type: 'geojson', data: data.escape_area });
            map.addLayer({
                id: 'escape-hull',
                type: 'fill',
                source: 'escape-hull',
                paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.15 }
            });
            map.addLayer({
                id: 'escape-border',
                type: 'line',
                source: 'escape-hull',
                paint: { 'line-color': '#dc2626', 'line-width': 4, 'line-dasharray': [3, 2], 'line-opacity': 0.8 }
            });

            // Fit bounds
            const bounds = new maplibregl.LngLatBounds();
            if (data.escape_area.coordinates?.[0]) {
                data.escape_area.coordinates[0].forEach(coord => bounds.extend(coord));
                map.fitBounds(bounds, { padding: 100, maxZoom: 14, duration: 1500 });
            }

            showInfo(`🚚 ${escapeMinutes}-min service area calculated<br><small>Red zone = reachable area from service point</small>`);
        })
        .catch(err => {
            showInfo("❌ Error: " + err.message);
            console.error(err);
        });
}

function addRouteLayer(data, color) {
    if (map.getLayer('route')) map.removeLayer('route');
    if (map.getSource('route')) map.removeSource('route');

    map.addSource('route', { type: 'geojson', data });
    map.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': color, 'line-width': 7, 'line-opacity': 0.9 }
    });
}

function fitToFeatures(data) {
    const bounds = new maplibregl.LngLatBounds();
    data.features.forEach(f => {
        if (f.geometry?.coordinates) {
            f.geometry.coordinates.forEach(coord => bounds.extend(coord));
        }
    });
    map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 1500 });
}

function clearAll() {
    // 1. Remove all custom layers (routes, escape area, facility results)
    const layersToRemove = [
        'route',
        'escape-network',
        'escape-hull',
        'escape-border',
        'facility-lines',
        'facility-points'
    ];

    layersToRemove.forEach(layerId => {
        if (map.getLayer(layerId)) {
            map.removeLayer(layerId);
        }
    });

    // 2. Remove all related sources
    const sourcesToRemove = [
        'route',
        'escape-network',
        'escape-hull',
        'facility-results'
    ];

    sourcesToRemove.forEach(sourceId => {
        if (map.getSource(sourceId)) {
            map.removeSource(sourceId);
        }
    });

    // 3. Remove all markers
    // A→B Route markers
    if (startMarker) {
        startMarker.remove();
        startMarker = null;
    }
    if (endMarker) {
        endMarker.remove();
        endMarker = null;
    }

    // Crime / Service Area marker
    if (crimeMarker) {
        crimeMarker.remove();
        crimeMarker = null;
    }

    // Nearest Facility incident marker
    if (facilityMarker) {
        facilityMarker.remove();
        facilityMarker = null;
    }

    // TSP waypoints markers
    tspMarkers.forEach(item => {
        if (item.marker) {
            item.marker.remove();
        }
    });
    tspMarkers = [];

    // 4. Reset data
    currentRouteData = null;

    // 5. Optional: reset info panel to default state
    showInfo("Click to start");

    // 6. Optional: reset map view (uncomment if desired)
    // map.easeTo({
    //     center: currentCenter,
    //     zoom: currentZoom,
    //     pitch: currentPitch,
    //     bearing: currentBearing,
    //     duration: 1000
    // });
}

function createLayerSwitcher() {
    class LayerSwitcher {
        onAdd(map) {
            this.map = map;
            this.container = document.createElement('div');
            this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group flex flex-col bg-white';

            STYLES.forEach(style => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'px-4 py-3 text-sm font-medium hover:bg-blue-50 border-b border-gray-200 transition';
                btn.textContent = style.name;
                btn.onclick = () => {
                    map.setStyle(style.url);
                    map.once('styledata', () => {
                        if (currentMode === 'route' && currentRouteData) {
                            addRouteLayer(currentRouteData, '#3b82f6');
                        }
                        map.easeTo({ pitch: style.pitch, zoom: style.zoom || currentZoom, duration: 1000 });
                    });
                };
                this.container.appendChild(btn);
            });
            return this.container;
        }
        onRemove() {
            this.container.parentNode.removeChild(this.container);
        }
    }
    return new LayerSwitcher();
}

// Initialize map when page loads
window.addEventListener('load', initMap);
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
let currentMode = 'route'; // 'route', 'tsp', or 'service'
let startMarker = null;
let endMarker = null;
let crimeMarker = null;
let tspMarkers = []; // Array of waypoint markers for TSP
let currentRouteData = null;
let escapeMinutes = 5;

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

    // Map click handler
    map.on('click', (e) => {
        if (currentMode === 'route') {
            handleRouteClick(e.lngLat);
        } else if (currentMode === 'tsp') {
            handleTSPClick(e.lngLat);
        } else {
            handleCrimeClick(e.lngLat);
        }
    });

    // Mode switcher buttons
    document.getElementById('mode-route').onclick = () => switchMode('route');
    document.getElementById('mode-tsp').onclick = () => switchMode('tsp');
    document.getElementById('mode-crime').onclick = () => switchMode('crime');

    // Time slider
    document.getElementById('time-input').oninput = (e) => {
        escapeMinutes = parseInt(e.target.value);
        document.getElementById('time-value').textContent = escapeMinutes;
        if (crimeMarker) {
            calculateEscapeArea(crimeMarker.getLngLat());
        }
    };

    map.on('load', () => showInfo("Click anywhere to set start point"));
}

function switchMode(mode) {
    currentMode = mode;
    clearAll();

    const routeBtn = document.getElementById('mode-route');
    const tspBtn = document.getElementById('mode-tsp');
    const crimeBtn = document.getElementById('mode-crime');
    const timeSlider = document.getElementById('time-slider');
    const instruction = document.getElementById('mode-instruction');

    // Reset buttons
    [routeBtn, tspBtn, crimeBtn].forEach(btn => {
        btn.className = 'px-3 py-2 text-xs font-medium rounded-md hover:bg-gray-200 transition';
    });

    if (mode === 'route') {
        routeBtn.classList.add('bg-blue-600', 'text-white');
        timeSlider.classList.add('hidden');
        instruction.innerHTML = 'Click: <span class="text-green-600 font-bold">Start</span> → <span class="text-red-600 font-bold">End</span>';
        showInfo("🗺️ A→B Route: Click start point");
    } else if (mode === 'tsp') {
        tspBtn.classList.add('bg-purple-600', 'text-white');
        timeSlider.classList.add('hidden');
        instruction.innerHTML = 'Click: <span class="text-purple-600 font-bold">Add waypoints</span> (min 3 points, then wait)';
        showInfo("🔄 TSP Mode: Click to add waypoints (3+ points)");
    } else {
        crimeBtn.classList.add('bg-red-600', 'text-white');
        timeSlider.classList.remove('hidden');
        instruction.innerHTML = 'Click: <span class="text-red-600 font-bold">Service Location</span> (adjust time slider)';
        showInfo("🚚 Service Area: Click Service location");
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
    ['route', 'escape-network', 'escape-hull', 'escape-border'].forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
    });

    [startMarker, endMarker, crimeMarker].forEach(m => m?.remove());
    startMarker = endMarker = crimeMarker = null;

    tspMarkers.forEach(m => m.marker.remove());
    tspMarkers = [];

    currentRouteData = null;
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
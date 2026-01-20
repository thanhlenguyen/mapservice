// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const STYLES = [
    { id: 'basic', name: 'Default', url: 'http://localhost:8080/styles/basic-style/style.json', pitch: 0, zoom: 12 },
    { id: 'sat', name: 'Satellite', url: 'http://localhost:8080/styles/sat-style/style.json', pitch: 0, zoom: 12 },
    { id: '3d', name: '3D', url: 'http://localhost:8080/styles/3d-style/style.json', pitch: 45, zoom: 14 }
];

const FACILITY_COLORS = {
    'hospital': '#ef4444',
    'fire station': '#f97316',
    'police': '#8b5cf6',
    'clinic': '#10b981'
};

// Backend API configuration
const BACKEND_URL = 'http://localhost:5000';

const API_ENDPOINTS = {
    route: `${BACKEND_URL}/route`,
    nearestFacility: `${BACKEND_URL}/nearest_facility`,
    serviceArea: `${BACKEND_URL}/service_area`
};

const DEFAULT_CENTER = [46.6167, 24.8258]; // Riyadh
const DEFAULT_ZOOM = 12;
const REQUEST_TIMEOUT = 20000; // 20 seconds


// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const state = {
    map: null,
    currentMode: 'route',
    currentCenter: DEFAULT_CENTER,
    currentZoom: DEFAULT_ZOOM,
    currentPitch: 0,
    currentBearing: 0,
    markers: {
        start: null,
        end: null,
        service: null,
        facility: null,
        tsp: []
    },
    currentRouteData: null,
    serviceMinutes: 5
};

// ============================================================================
// MAP INITIALIZATION
// ============================================================================

function initMap() {
    state.map = new maplibregl.Map({
        container: 'map',
        style: STYLES[0].url,
        center: state.currentCenter,
        zoom: state.currentZoom,
        pitch: state.currentPitch,
        bearing: state.currentBearing,
        maxPitch: 85
    });

    // Track viewport changes
    state.map.on('moveend', () => {
        state.currentCenter = state.map.getCenter();
        state.currentZoom = state.map.getZoom();
        state.currentPitch = state.map.getPitch();
        state.currentBearing = state.map.getBearing();
    });

    // Add controls
    state.map.addControl(new maplibregl.NavigationControl(), 'top-right');
    state.map.addControl(createLayerSwitcher(), 'bottom-right');

    // Setup event handlers
    setupEventHandlers();

    state.map.on('load', () => {
        showInfo("Click anywhere to begin");
    });
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

function setupEventHandlers() {
    // Map click handler
    state.map.on('click', handleMapClick);

    // Mode switcher buttons
    document.getElementById('mode-route')?.addEventListener('click', () => switchMode('route'));
    document.getElementById('mode-tsp')?.addEventListener('click', () => switchMode('tsp'));
    document.getElementById('mode-facility')?.addEventListener('click', () => switchMode('facility'));
    document.getElementById('mode-service')?.addEventListener('click', () => switchMode('service'));

    // Time slider for service area
    const timeInput = document.getElementById('time-input');
    if (timeInput) {
        timeInput.addEventListener('input', (e) => {
            state.serviceMinutes = parseInt(e.target.value, 10);
            document.getElementById('time-value').textContent = state.serviceMinutes;
            
            if (state.markers.service) {
                calculateServiceArea(state.markers.service.getLngLat());
            }
        });
    }
}

function handleMapClick(e) {
    const handlers = {
        'route': handleRouteClick,
        'tsp': handleTSPClick,
        'facility': handleFacilityClick,
        'service': handleServiceClick
    };

    const handler = handlers[state.currentMode];
    if (handler) {
        handler(e.lngLat);
    }
}

// ============================================================================
// MODE SWITCHING
// ============================================================================

function switchMode(mode) {
    state.currentMode = mode;
    clearAll();

    // Update UI
    updateModeButtons(mode);
    updateModeInstructions(mode);
}

function updateModeButtons(activeMode) {
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    const activeBtn = document.getElementById(`mode-${activeMode}`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }
}

function updateModeInstructions(mode) {
    const timeSlider       = document.getElementById('time-slider');
    const facilitySelector = document.getElementById('facility-selector');
    const instruction      = document.getElementById('mode-instruction');

    if (timeSlider) {
        timeSlider.classList.toggle('hidden', mode !== 'service');
    }

    if (facilitySelector) {
        facilitySelector.classList.toggle('hidden', mode !== 'facility');
    }

    const instructions = {
        'route': {
            html: 'Click: <span class="highlight start">Start</span> → <span class="highlight end">End</span>',
            info: '🗺️ A→B Route mode active'
        },
        'tsp': {
            html: 'Click to add <span style="color:#8b5cf6;font-weight:bold">waypoints</span> (min 3)',
            info: '🔄 TSP mode: Add at least 3 points'
        },
        'facility': {
            html: 'Click a <span style="color:#ef4444;font-weight:bold">location</span> to find nearest facilities',
            info: '🏥 Nearest Facility mode active'
        },
        'service': {
            html: 'Click <span style="color:#ef4444;font-weight:bold">service location</span> + adjust time',
            info: '🚚 Service Area mode active'
        }
    };

    const modeConfig = instructions[mode];
    if (modeConfig && instruction) {
        instruction.innerHTML = modeConfig.html;
        showInfo(modeConfig.info);
    }
}

// ============================================================================
// ROUTE MODE (A→B)
// ============================================================================

function handleRouteClick(lngLat) {
    if (!state.markers.start) {
        state.markers.start = new maplibregl.Marker({ 
            element: createMarker('S', '#10b981') 
        })
            .setLngLat(lngLat)
            .addTo(state.map);
        showInfo("✅ Start set. Click destination");
    } else if (!state.markers.end) {
        state.markers.end = new maplibregl.Marker({ 
            element: createMarker('E', '#ef4444') 
        })
            .setLngLat(lngLat)
            .addTo(state.map);
        calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
    } else {
        clearAll();
        showInfo("🔄 Cleared. Click new start point");
    }
}

async function calculateRoute(start, end) {
    showInfo("⏳ Calculating route...");

    try {
        const url = `${API_ENDPOINTS.route}?start_lon=${start.lng}&start_lat=${start.lat}&end_lon=${end.lng}&end_lat=${end.lat}`;
        const data = await fetchWithTimeout(url);

        if (data.error) {
            throw new Error(data.error);
        }

        state.currentRouteData = data;
        addRouteLayer(data, '#3b82f6');
        fitToFeatures(data);
        showInfo(`✅ Route: ${data.duration_minutes} min • ${data.total_distance_km} km`);
    } catch (error) {
        handleError('Route calculation', error);
    }
}

// ============================================================================
// TSP MODE (Multi-point optimization)
// ============================================================================

function handleTSPClick(lngLat) {
    const markerNum = state.markers.tsp.length + 1;
    const marker = new maplibregl.Marker({
        element: createMarker(markerNum.toString(), '#9333ea')
    })
        .setLngLat(lngLat)
        .addTo(state.map);

    state.markers.tsp.push({ marker, lngLat });

    if (state.markers.tsp.length < 3) {
        showInfo(`✅ Point ${markerNum} added. Need ${3 - state.markers.tsp.length} more (min 3 points)`);
    } else {
        showInfo(`✅ Point ${markerNum} added. Auto-calculating TSP in 2 seconds...`);
        setTimeout(() => {
            if (state.markers.tsp.length >= 3) {
                calculateTSP();
            }
        }, 2000);
    }
}

async function calculateTSP() {
    if (state.markers.tsp.length < 2) {
        showInfo("❌ Need at least 2 points for TSP");
        return;
    }

    showInfo(`⏳ Solving TSP for ${state.markers.tsp.length} points...`);

    try {
        const points = state.markers.tsp.map(m => [m.lngLat.lng, m.lngLat.lat]);
        
        const data = await fetchWithTimeout(API_ENDPOINTS.route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ points })
        });

        if (data.error) {
            throw new Error(data.error);
        }

        state.currentRouteData = data;
        addRouteLayer(data, '#9333ea');
        fitToFeatures(data);

        const orderStr = data.waypoint_order.map(i => i + 1).join(' → ');
        showInfo(`
            ✅ <strong>TSP Optimized!</strong><br>
            Order: ${orderStr}<br>
            ${data.duration_minutes} min • ${data.total_distance_km} km
        `);
    } catch (error) {
        handleError('TSP calculation', error);
    }
}

// ============================================================================
// NEAREST FACILITY MODE
// ============================================================================

function handleFacilityClick(lngLat) {
    // Clean up previous state
    cleanupFacilityMode();

    // Place marker at click location
    state.markers.facility = new maplibregl.Marker({
        element: createMarker('📍', '#dc2626')
    })
        .setLngLat(lngLat)
        .addTo(state.map);

    showInfo("⏳ Searching nearest facilities...");
    calculateNearestFacilities(lngLat);
}

function cleanupFacilityMode() {
    if (state.markers.facility) {
        state.markers.facility.remove();
        state.markers.facility = null;
    }

    const layersToRemove = ['facility-lines', 'facility-points', 'facility-labels', 'facility-names'];
    layersToRemove.forEach(layerId => {
        if (state.map.getLayer(layerId)) {
            state.map.removeLayer(layerId);
        }
    });

    if (state.map.getSource('facility-results')) {
        state.map.removeSource('facility-results');
    }
}

async function calculateNearestFacilities(lngLat) {
    const facilityType = document.getElementById('facility-type-select')?.value || 'hospital';
    const limit = 5;

    showInfo("⏳ Searching for nearest facilities...<br><small>This may take 10-15 seconds</small>");

    try {
        // Build URL with correct backend
        const url = `${API_ENDPOINTS.nearestFacility}?lon=${lngLat.lng}&lat=${lngLat.lat}&type=${facilityType}&limit=${limit}`;

        const data = await fetchWithTimeout(url);

        if (data.error) {
            throw new Error(data.error);
        }

        if (!data.facilities || data.facilities.length === 0) {
            showInfo(`ℹ️ No ${facilityType.replace('_', ' ')} found within network reach`);
            return;
        }

        displayFacilityResults(lngLat, data, facilityType);
    } catch (error) {
        handleError('Facility search', error);
    }
}

function displayFacilityResults(lngLat, data, facilityType) {
    // Create line features from click point to each facility
    const lineFeatures = data.facilities.map(facility => ({
        type: "Feature",
        geometry: {
            type: "LineString",
            coordinates: [
                [lngLat.lng, lngLat.lat],
                [parseFloat(facility.facility_lon), parseFloat(facility.facility_lat)]
            ]
        },
        properties: {
            name: facility.name,
            minutes: parseFloat(facility.travel_minutes),
            type: facility.type,
            address: facility.address || '',
            distance_km: facility.crow_distance_km || null,
            rank: data.facilities.indexOf(facility) + 1
        }
    }));

    // Create point features for facilities
    const pointFeatures = data.facilities.map(facility => ({
        type: "Feature",
        geometry: {
            type: "Point",
            coordinates: [parseFloat(facility.facility_lon), parseFloat(facility.facility_lat)]
        },
        properties: {
            name: facility.name,
            minutes: parseFloat(facility.travel_minutes),
            type: facility.type,
            address: facility.address || '',
            distance_km: facility.crow_distance_km || null,
            rank: data.facilities.indexOf(facility) + 1
        }
    }));

    // Add GeoJSON source
    state.map.addSource('facility-results', {
        type: 'geojson',
        data: {
            type: "FeatureCollection",
            features: [...lineFeatures, ...pointFeatures]
        }
    });

    const facilityColor = FACILITY_COLORS[facilityType] || '#6366f1';

    // Add line layer (routes to facilities)
    state.map.addLayer({
        id: 'facility-lines',
        type: 'line',
        source: 'facility-results',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
            'line-color': facilityColor,
            'line-width': [
                'interpolate', ['linear'], ['get', 'rank'],
                1, 5,    // Closest facility: thicker line
                5, 3     // Farthest: thinner line
            ],
            'line-opacity': 0.7,
            'line-dasharray': [2, 1.5]
        }
    });

    // Add facility point layer with numbered markers
    state.map.addLayer({
        id: 'facility-points',
        type: 'circle',
        source: 'facility-results',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                10, 8,
                15, 14
            ],
            'circle-color': facilityColor,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 3,
            'circle-opacity': 0.95
        }
    });

    // Add numbered labels on facilities
    state.map.addLayer({
        id: 'facility-labels',
        type: 'symbol',
        source: 'facility-results',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
            'text-field': ['to-string', ['get', 'rank']],
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-size': 14,
            'text-allow-overlap': true
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-width': 0
        }
    });

    // Add facility names below the markers
    state.map.addLayer({
        id: 'facility-names',
        type: 'symbol',
        source: 'facility-results',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
            'text-field': ['concat', ['get', 'name'], '\n', ['get', 'minutes'], ' min'],
            'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
            'text-size': 11,
            'text-offset': [0, 2],
            'text-anchor': 'top',
            'text-max-width': 12
        },
        paint: {
            'text-color': '#1f2937',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2
        }
    });

    // Setup interactions
    setupFacilityInteractions();

    // Display summary
    const closestFacility = data.facilities[0];
    const facilityLabel = facilityType.replace('_', ' ');
    
    // Build list of all facilities
    const facilityList = data.facilities.map((f, i) => 
        `${i + 1}. ${f.name} (${f.travel_minutes} min)`
    ).join('<br>');
    
    showInfo(`
        ✅ Found ${data.count} ${facilityLabel}${data.count > 1 ? 's' : ''}
        <br><strong>Closest:</strong> ${closestFacility.name}
        <br><strong>Travel time:</strong> ${closestFacility.travel_minutes} minutes
        ${closestFacility.crow_distance_km ? `<br><small>Straight-line: ${closestFacility.crow_distance_km.toFixed(1)} km</small>` : ''}
        <br><br><small style="font-size: 0.85rem;">${facilityList}</small>
    `);

    // Fit map bounds
    fitMapToFacilities(lngLat, data.facilities);
}

function setupFacilityInteractions() {
    // Change cursor on hover
    state.map.on('mouseenter', 'facility-points', () => {
        state.map.getCanvas().style.cursor = 'pointer';
    });

    state.map.on('mouseleave', 'facility-points', () => {
        state.map.getCanvas().style.cursor = '';
    });

    // Show popup on click
    state.map.on('click', 'facility-points', (e) => {
        const props = e.features[0].properties;
        
        const popupContent = `
            <div style="font-family: Inter, sans-serif; min-width: 200px;">
                <strong style="font-size: 14px; color: #1f2937;">${props.name}</strong>
                ${props.address ? `<p style="margin: 4px 0; font-size: 12px; color: #6b7280;">${props.address}</p>` : ''}
                <p style="margin: 8px 0 0 0; font-size: 13px; color: #059669;">
                    <strong>⏱️ ${props.minutes} minutes</strong> drive
                </p>
                ${props.distance_km ? `<p style="margin: 4px 0 0 0; font-size: 11px; color: #9ca3af;">Straight-line: ${parseFloat(props.distance_km).toFixed(1)} km</p>` : ''}
            </div>
        `;
        
        new maplibregl.Popup({ 
            offset: 15,
            closeButton: true,
            closeOnClick: true
        })
            .setLngLat(e.lngLat)
            .setHTML(popupContent)
            .addTo(state.map);
    });
}

function fitMapToFacilities(lngLat, facilities) {
    const bounds = new maplibregl.LngLatBounds();
    bounds.extend([lngLat.lng, lngLat.lat]);
    
    facilities.forEach(facility => {
        bounds.extend([
            parseFloat(facility.facility_lon), 
            parseFloat(facility.facility_lat)
        ]);
    });
    
    state.map.fitBounds(bounds, { 
        padding: { top: 80, bottom: 80, left: 80, right: 80 },
        maxZoom: 14,
        duration: 1000
    });
}

// ============================================================================
// SERVICE AREA MODE (Service/Reachability)
// ============================================================================

function handleServiceClick(lngLat) {
    if (state.markers.service) {
        state.markers.service.remove();
    }
    
    state.markers.service = new maplibregl.Marker({ 
        element: createMarker('🚚', '#1c2ae1ff') 
    })
        .setLngLat(lngLat)
        .addTo(state.map);
    
    calculateServiceArea(lngLat);
}

async function calculateServiceArea(lngLat) {
    showInfo(`⏳ Calculating ${state.serviceMinutes}-min service area...`);

    try {
        const url = `${API_ENDPOINTS.serviceArea}?lon=${lngLat.lng}&lat=${lngLat.lat}&minutes=${state.serviceMinutes}`;
        const data = await fetchWithTimeout(url);

        if (data.error) {
            throw new Error(data.error);
        }

        // Remove old layers
        const layersToRemove = ['service-network', 'service-hull', 'service-border'];
        layersToRemove.forEach(id => {
            if (state.map.getLayer(id)) state.map.removeLayer(id);
            if (state.map.getSource(id)) state.map.removeSource(id);
        });

        // Add reachable network
        state.map.addSource('service-network', { 
            type: 'geojson', 
            data: data.reachable_network 
        });
        state.map.addLayer({
            id: 'service-network',
            type: 'line',
            source: 'service-network',
            paint: { 
                'line-color': '#f59e0b', 
                'line-width': 3, 
                'line-opacity': 0.6 
            }
        });

        // Add service hull
        state.map.addSource('service-hull', { 
            type: 'geojson', 
            data: data.service_area 
        });
        state.map.addLayer({
            id: 'service-hull',
            type: 'fill',
            source: 'service-hull',
            paint: { 
                'fill-color': '#dc2626', 
                'fill-opacity': 0.15 
            }
        });
        state.map.addLayer({
            id: 'service-border',
            type: 'line',
            source: 'service-hull',
            paint: { 
                'line-color': '#dc2626', 
                'line-width': 4, 
                'line-dasharray': [3, 2], 
                'line-opacity': 0.8 
            }
        });

        // Fit bounds
        if (data.service_area.coordinates?.[0]) {
            const bounds = new maplibregl.LngLatBounds();
            data.service_area.coordinates[0].forEach(coord => bounds.extend(coord));
            state.map.fitBounds(bounds, { 
                padding: 100, 
                maxZoom: 14, 
                duration: 1500 
            });
        }

        showInfo(`🚚 ${state.serviceMinutes}-min service area calculated<br><small>Red zone = reachable area from service point</small>`);
    } catch (error) {
        handleError('Service area calculation', error);
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Server error: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError') {
            throw new Error('Request timed out. Please try again.');
        }
        throw error;
    }
}

function handleError(context, error) {
    console.error(`${context} error:`, error);
    
    let message = error.message;
    if (error.message.includes('Failed to fetch')) {
        message = 'Network error. Check your connection and try again.';
    }
    
    showInfo(`❌ ${message}`);
}

function createMarker(text, bgColor = null) {
    const el = document.createElement('div');
    el.className = 'marker';
    
    if (text === '🚚') el.classList.add('marker-service');
    if (text === 'E') el.classList.add('marker-end');
    if (bgColor) el.style.backgroundColor = bgColor;
    
    el.textContent = text;
    return el;
}

function showInfo(text) {
    const infoBox = document.getElementById('info-box');
    const routeInfo = document.getElementById('route-info');
    
    if (infoBox && routeInfo) {
        infoBox.classList.remove('hidden');
        routeInfo.innerHTML = text;
    }
}

function addRouteLayer(data, color) {
    if (state.map.getLayer('route')) state.map.removeLayer('route');
    if (state.map.getSource('route')) state.map.removeSource('route');

    state.map.addSource('route', { type: 'geojson', data });
    state.map.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 
            'line-color': color, 
            'line-width': 7, 
            'line-opacity': 0.9 
        }
    });
}

function fitToFeatures(data) {
    const bounds = new maplibregl.LngLatBounds();
    
    data.features.forEach(feature => {
        if (feature.geometry?.coordinates) {
            feature.geometry.coordinates.forEach(coord => bounds.extend(coord));
        }
    });
    
    state.map.fitBounds(bounds, { 
        padding: 80, 
        maxZoom: 15, 
        duration: 1500 
    });
}

function clearAll() {
    // Remove all layers
    const layersToRemove = [
        'route',
        'service-network',
        'service-hull',
        'service-border',
        'facility-lines',
        'facility-points',
        'facility-labels',
        'facility-names'
    ];

    layersToRemove.forEach(layerId => {
        if (state.map.getLayer(layerId)) {
            state.map.removeLayer(layerId);
        }
    });

    // Remove all sources
    const sourcesToRemove = [
        'route',
        'service-network',
        'service-hull',
        'facility-results'
    ];

    sourcesToRemove.forEach(sourceId => {
        if (state.map.getSource(sourceId)) {
            state.map.removeSource(sourceId);
        }
    });

    // Remove all markers
    Object.keys(state.markers).forEach(key => {
        if (key === 'tsp') {
            state.markers.tsp.forEach(item => {
                if (item.marker) item.marker.remove();
            });
            state.markers.tsp = [];
        } else if (state.markers[key]) {
            state.markers[key].remove();
            state.markers[key] = null;
        }
    });

    // Reset data
    state.currentRouteData = null;
    showInfo("Click to start");
}

// ============================================================================
// LAYER SWITCHER
// ============================================================================

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
                        // Restore route if exists
                        if (state.currentMode === 'route' && state.currentRouteData) {
                            addRouteLayer(state.currentRouteData, '#3b82f6');
                        }
                        map.easeTo({ 
                            pitch: style.pitch, 
                            zoom: style.zoom || state.currentZoom, 
                            duration: 1000 
                        });
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

// ============================================================================
// INITIALIZATION
// ============================================================================

window.addEventListener('load', initMap);
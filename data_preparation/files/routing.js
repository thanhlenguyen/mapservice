// ============================================================================
// CONFIGURATION & CONSTANTS - Routing JavaScript
// ============================================================================

const STYLES = [
    { id: 'basic-style', name: 'Default',   url: 'http://localhost:3001/styles/martin/style.json', pitch: 0, zoom: 12, bearing: 0 },
    { id: 'sat-style',   name: 'Satellite', url: 'http://localhost:3001/styles/martin/style_sat.json', pitch: 0, zoom: 12, bearing: 0 },
    { id: '3d-style',    name: '3D',        url: 'http://localhost:3001/styles/martin/style_3d.json', pitch: 45, zoom: 14, bearing: 0 }
];

const FACILITY_COLORS = {
    'hospital': '#ef4444',
    'fire station': '#f97316',
    'police': '#8b5cf6',
    'clinic': '#10b981'
};

const FACILITY_ICONS = {
    'hospital': '🏥',
    'fire station': '🚒',
    'police': '👮',
    'clinic': '⚕️'
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

// Global limits for sliders - CHANGE THESE TO UPDATE MAX VALUES
const MAX_FACILITY_COUNT = 20;  // Maximum facilities to search
const MAX_SERVICE_MINUTES = 20; // Maximum service area time in minutes
const MAX_SEARCH_DISTANCE_KM = 30; // Maximum search distance in kilometers

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
    facilityMarkers: [],
    currentRouteData: null,
    serviceMinutes: 5,
    facilityCount: 5,  // Default number of facilities to find
    searchDistanceKm: 10  // Default search distance in km
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
    
    // Initialize sliders with global limits
    initializeSliders();

    // Setup event handlers
    setupEventHandlers();

    state.map.on('load', () => {
        showInfo("Click anywhere to begin");
    });
}

// ============================================================================
// SLIDER INITIALIZATION
// ============================================================================

function initializeSliders() {
    // Initialize facility count slider
    const facilityCountInput = document.getElementById('facility-count-input');
    if (facilityCountInput) {
        facilityCountInput.max = MAX_FACILITY_COUNT;
    }

    // Initialize service time slider
    const timeInput = document.getElementById('time-input');
    if (timeInput) {
        timeInput.max = MAX_SERVICE_MINUTES;
    }

    // Initialize search distance slider
    const distanceInput = document.getElementById('distance-input');
    if (distanceInput) {
        distanceInput.max = MAX_SEARCH_DISTANCE_KM;
    }
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
    const timeValue = document.getElementById('time-value');
    if (timeInput && timeValue) {
        // Set initial value
        timeValue.textContent = timeInput.value;
        
        timeInput.addEventListener('input', (e) => {
            state.serviceMinutes = parseInt(e.target.value, 10);
            timeValue.textContent = state.serviceMinutes;
            
            if (state.markers.service) {
                calculateServiceArea(state.markers.service.getLngLat());
            }
        });
    }

    // Facility count slider
    const facilityCountInput = document.getElementById('facility-count-input');
    const facilityCountValue = document.getElementById('facility-count-value');
    if (facilityCountInput && facilityCountValue) {
        // Set initial value
        facilityCountValue.textContent = facilityCountInput.value;
        
        facilityCountInput.addEventListener('input', (e) => {
            state.facilityCount = parseInt(e.target.value, 10);
            facilityCountValue.textContent = state.facilityCount;
            
            // Automatically recalculate if a facility search is active
            if (state.markers.facility) {
                calculateNearestFacilities(state.markers.facility.getLngLat());
            }
        });
    }

    // Search distance slider
    const distanceInput = document.getElementById('distance-input');
    const distanceValue = document.getElementById('distance-value');
    if (distanceInput && distanceValue) {
        // Set initial value
        distanceValue.textContent = distanceInput.value;
        
        distanceInput.addEventListener('input', (e) => {
            state.searchDistanceKm = parseInt(e.target.value, 10);
            distanceValue.textContent = state.searchDistanceKm;
            
            // Automatically recalculate if a facility search is active
            if (state.markers.facility) {
                calculateNearestFacilities(state.markers.facility.getLngLat());
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
    const timeSlider = document.getElementById('time-slider');
    const facilitySelector = document.getElementById('facility-selector');
    const facilityCountSlider = document.getElementById('facility-count-slider');
    const distanceSlider = document.getElementById('distance-slider');
    const instruction = document.getElementById('mode-instruction');

    if (timeSlider) {
        timeSlider.classList.toggle('hidden', mode !== 'service');
    }

    if (facilitySelector) {
        facilitySelector.classList.toggle('hidden', mode !== 'facility');
    }

    if (facilityCountSlider) {
        facilityCountSlider.classList.toggle('hidden', mode !== 'facility');
    }

    if (distanceSlider) {
        distanceSlider.classList.toggle('hidden', mode !== 'facility');
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

    // Remove facility icon markers
    if (state.facilityMarkers) {
        state.facilityMarkers.forEach(marker => marker.remove());
        state.facilityMarkers = [];
    }

    // Remove route layers
    const layersToRemove = ['facility-routes'];
    layersToRemove.forEach(layerId => {
        if (state.map.getLayer(layerId)) {
            state.map.removeLayer(layerId);
        }
    });

    const sourcesToRemove = ['facility-routes'];
    sourcesToRemove.forEach(sourceId => {
        if (state.map.getSource(sourceId)) {
            state.map.removeSource(sourceId);
        }
    });
}

async function calculateNearestFacilities(lngLat) {
    const facilityType = document.getElementById('facility-type-select')?.value || 'hospital';
    const limit = state.facilityCount;
    const maxDistanceKm = state.searchDistanceKm;

    showInfo(`⏳ Searching for nearest facilities within ${maxDistanceKm}km...<br><small>This may take a few seconds</small>`);

    try {
        // Build URL with distance limitation
        const url = `${API_ENDPOINTS.nearestFacility}?lon=${lngLat.lng}&lat=${lngLat.lat}&type=${encodeURIComponent(facilityType)}&limit=${limit}&max_distance_km=${maxDistanceKm}&routes=true`;

        const data = await fetchWithTimeout(url);

        if (data.error) {
            throw new Error(data.error);
        }

        if (!data.facilities || data.facilities.length === 0) {
            showInfo(`ℹ️ No ${facilityType} found within ${maxDistanceKm}km radius`);
            return;
        }

        displayFacilityResults(lngLat, data, facilityType);
    } catch (error) {
        handleError('Facility search', error);
    }
}

function displayFacilityResults(lngLat, data, facilityType) {
    // Collect all route features from all facilities
    const allRouteFeatures = [];
    
    data.facilities.forEach((facility, index) => {
        // Add route features if available
        if (facility.route && facility.route.features) {
            facility.route.features.forEach(feature => {
                allRouteFeatures.push({
                    ...feature,
                    properties: {
                        ...feature.properties,
                        facility_name: facility.name,
                        facility_rank: index + 1,
                        travel_minutes: facility.travel_minutes
                    }
                });
            });
        }
    });

    // Add routes source and layer
    if (allRouteFeatures.length > 0) {
        state.map.addSource('facility-routes', {
            type: 'geojson',
            data: {
                type: "FeatureCollection",
                features: allRouteFeatures
            }
        });

        const facilityColor = FACILITY_COLORS[facilityType] || '#6366f1';

        state.map.addLayer({
            id: 'facility-routes',
            type: 'line',
            source: 'facility-routes',
            paint: {
                'line-color': facilityColor,
                'line-width': [
                    'interpolate', ['linear'], ['get', 'facility_rank'],
                    1, 6,    // Closest facility: thicker line
                    5, 3     // Farthest: thinner line
                ],
                'line-opacity': 0.8
            }
        });
    }

    // Create facility markers with icons
    const facilityMarkers = [];
    
    data.facilities.forEach((facility, index) => {
        const facilityIcon = FACILITY_ICONS[facility.type] || '📍';
        const facilityColor = FACILITY_COLORS[facility.type] || '#6366f1';
        
        // Create custom marker element with icon and rank
        const markerEl = document.createElement('div');
        markerEl.className = 'facility-marker';
        markerEl.style.cssText = `
            width: 48px;
            height: 48px;
            background: ${facilityColor};
            border: 3px solid white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            cursor: pointer;
            position: relative;
        `;
        markerEl.innerHTML = facilityIcon;
        
        // Add rank badge
        const rankBadge = document.createElement('div');
        rankBadge.className = 'rank-badge';
        rankBadge.style.cssText = `
            position: absolute;
            top: -8px;
            right: -8px;
            width: 24px;
            height: 24px;
            background: white;
            border: 2px solid ${facilityColor};
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: bold;
            color: ${facilityColor};
        `;
        rankBadge.textContent = index + 1;
        markerEl.appendChild(rankBadge);
        
        // Create MapLibre marker
        const marker = new maplibregl.Marker({ element: markerEl })
            .setLngLat([parseFloat(facility.facility_lon), parseFloat(facility.facility_lat)])
            .addTo(state.map);
        
        // Add click handler for popup
        markerEl.addEventListener('click', () => {
            const popupContent = `
                <div style="font-family: Inter, sans-serif; min-width: 220px;">
                    <div style="font-size: 24px; margin-bottom: 8px;">${facilityIcon}</div>
                    <strong style="font-size: 14px; color: #1f2937;">${facility.name}</strong>
                    ${facility.address ? `<p style="margin: 4px 0; font-size: 12px; color: #6b7280;">${facility.address}</p>` : ''}
                    <p style="margin: 8px 0 0 0; font-size: 13px; color: #059669;">
                        <strong>⏱️ ${facility.travel_minutes} minutes</strong> drive
                    </p>
                    <p style="margin: 4px 0 0 0; font-size: 11px; color: #9ca3af;">
                        Rank: #${index + 1}
                        ${facility.crow_distance_km ? ` • ${parseFloat(facility.crow_distance_km).toFixed(1)} km straight-line` : ''}
                    </p>
                </div>
            `;
            
            new maplibregl.Popup({ 
                offset: 25,
                closeButton: true,
                closeOnClick: true
            })
                .setLngLat([parseFloat(facility.facility_lon), parseFloat(facility.facility_lat)])
                .setHTML(popupContent)
                .addTo(state.map);
        });
        
        facilityMarkers.push(marker);
    });
    
    // Store markers for cleanup
    if (!state.facilityMarkers) {
        state.facilityMarkers = [];
    }
    state.facilityMarkers = facilityMarkers;

    // Display summary
    const closestFacility = data.facilities[0];
    const facilityLabel = facilityType;
    const facilityIcon = FACILITY_ICONS[facilityType] || '📍';
    
    // Build list of all facilities
    const facilityList = data.facilities.map((f, i) => 
        `${i + 1}. ${FACILITY_ICONS[f.type] || '📍'} ${f.name} (${f.travel_minutes} min)`
    ).join('<br>');
    
    showInfo(`
        ✅ Found ${data.count} ${facilityLabel}${data.count > 1 ? 's' : ''} within ${state.searchDistanceKm}km
        <br><strong>Closest:</strong> ${facilityIcon} ${closestFacility.name}
        <br><strong>Travel time:</strong> ${closestFacility.travel_minutes} minutes
        ${closestFacility.crow_distance_km ? `<br><small>Straight-line: ${closestFacility.crow_distance_km.toFixed(1)} km</small>` : ''}
        <br><br><small style="font-size: 0.85rem;">${facilityList}</small>
    `);

    // Fit map bounds
    fitMapToFacilities(lngLat, data.facilities);
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
        'facility-routes'
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
        'facility-routes'
    ];

    sourcesToRemove.forEach(sourceId => {
        if (state.map.getSource(sourceId)) {
            state.map.removeSource(sourceId);
        }
    });

    // Remove facility markers
    if (state.facilityMarkers) {
        state.facilityMarkers.forEach(marker => marker.remove());
        state.facilityMarkers = [];
    }

    // Remove all other markers
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

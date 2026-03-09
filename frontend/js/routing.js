// ============================================================================
// CONFIGURATION & CONSTANTS - Routing JavaScript
// ============================================================================

const STYLES = [
    { id: 'basic-style', name: 'Default',   url: 'http://localhost:3001/styles/martin/style.json', pitch: 0, zoom: 12, bearing: 0 },
    { id: 'sat-style',   name: 'Satellite', url: 'http://localhost:3001/styles/martin/style_sat.json', pitch: 0, zoom: 12, bearing: 0 },
    { id: '3d-style',    name: '3D',        url: 'http://localhost:3001/styles/martin/style_3d.json', pitch: 45, zoom: 14, bearing: 0 }
];

// Backend API configuration
const BACKEND_URL = 'http://localhost:5000';

const API_ENDPOINTS = {
    route: `${BACKEND_URL}/route`,
    tsp: `${BACKEND_URL}/route/tsp`,
    nearestFacility: `${BACKEND_URL}/nearest_facility`,
    serviceArea: `${BACKEND_URL}/service_area`
};
const DEFAULT_CENTER = [46.6167, 24.8258]; // Riyadh
const DEFAULT_ZOOM = 12;
const REQUEST_TIMEOUT = 20000; // 20 seconds

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
    searchDistanceKm: 10, // Default search distance in kilometers
    routeOptimization: 'fastest',  // 'fastest' or 'shortest'
    showAlternatives: true,  // Show 3 alternative routes
    // Info pointer state
    infoPointerActive: false,
    highlightedFeatureId: null,
    highlightedSourceLayer: null,
    // Draggable panel state
    isDragging: false,
    dragOffset: { x: 0, y: 0 },
    panelPosition: null
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
    state.map.addControl(createInfoPointerToggle(), 'top-right');
    
    // Initialize sliders with global limits
    initializeSliders();

    // Setup event handlers
    setupEventHandlers();

    state.map.on('load', () => {
        showInfo("Click anywhere to begin");
        setupInfoPointerLayers();
    });
    
    // Handle style changes
    state.map.on('styledata', () => {
        // Recreate info pointer layers after style change
        if (state.infoPointerActive) {
            setupInfoPointerLayers();
        }
    });
}

// ============================================================================
// INFO POINTER FUNCTIONALITY
// ============================================================================

function createInfoPointerToggle() {
    class InfoPointerControl {
        onAdd(map) {
            this.map = map;
            this.container = document.createElement('div');
            this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group info-pointer-toggle';
            
            this.button = document.createElement('button');
            this.button.className = 'info-pointer-btn';
            this.button.type = 'button';
            this.button.innerHTML = 'ℹ️';
            this.button.title = 'Toggle Info Pointer';
            
            this.button.onclick = () => toggleInfoPointer();
            
            this.container.appendChild(this.button);
            return this.container;
        }
        
        onRemove() {
            this.container.parentNode.removeChild(this.container);
        }
    }
    return new InfoPointerControl();
}

function toggleInfoPointer() {
    state.infoPointerActive = !state.infoPointerActive;
    
    const btn = document.querySelector('.info-pointer-btn');
    const mapContainer = document.getElementById('map');
    const featurePanel = document.getElementById('feature-info-panel');
    
    if (state.infoPointerActive) {
        btn.classList.add('active');
        mapContainer.classList.add('info-pointer-active');
        featurePanel.classList.remove('hidden');
        
        // Reset panel position to default
        resetPanelPosition();
        
        // Setup draggable functionality
        setupDraggablePanel();
        
        // Clear any existing highlights
        clearFeatureHighlight();
        
        // Show hint
        updateFeatureInfo({
            html: '<p class="info-hint">Click on any feature to see its details</p>'
        });
    } else {
        btn.classList.remove('active');
        mapContainer.classList.remove('info-pointer-active');
        featurePanel.classList.add('hidden');
        
        // Clear highlights
        clearFeatureHighlight();
    }
}

function setupInfoPointerLayers() {
    // Wait for map to be fully loaded
    if (!state.map.isStyleLoaded()) {
        state.map.once('styledata', setupInfoPointerLayers);
        return;
    }

    // Add highlight layer for selected features
    if (!state.map.getSource('feature-highlight')) {
        state.map.addSource('feature-highlight', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: []
            }
        });
    }

    // Add highlight layers for different geometry types
    const highlightLayers = [
        {
            id: 'feature-highlight-fill',
            type: 'fill',
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: {
                'fill-color': '#3b82f6',
                'fill-opacity': 0.3
            }
        },
        {
            id: 'feature-highlight-line',
            type: 'line',
            filter: ['any', 
                ['==', ['geometry-type'], 'LineString'],
                ['==', ['geometry-type'], 'Polygon']
            ],
            paint: {
                'line-color': '#3b82f6',
                'line-width': 3,
                'line-opacity': 0.8
            }
        },
        {
            id: 'feature-highlight-point',
            type: 'circle',
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
                'circle-radius': 8,
                'circle-color': '#3b82f6',
                'circle-opacity': 0.6,
                'circle-stroke-width': 2,
                'circle-stroke-color': '#1e40af'
            }
        }
    ];

    highlightLayers.forEach(layer => {
        if (!state.map.getLayer(layer.id)) {
            state.map.addLayer({
                ...layer,
                source: 'feature-highlight'
            });
        }
    });
}

// ============================================================================
// DRAGGABLE PANEL FUNCTIONALITY
// ============================================================================

function setupDraggablePanel() {
    const panel = document.getElementById('feature-info-panel');
    const header = document.querySelector('.feature-info-header');
    
    if (!panel || !header) return;
    
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    
    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
    
    // Touch support
    header.addEventListener('touchstart', dragStart, { passive: false });
    document.addEventListener('touchmove', drag, { passive: false });
    document.addEventListener('touchend', dragEnd);
    
    function dragStart(e) {
        // Don't drag if clicking the close button
        if (e.target.closest('.close-btn')) return;
        
        if (e.type === 'touchstart') {
            initialX = e.touches[0].clientX - (state.panelPosition?.x || 0);
            initialY = e.touches[0].clientY - (state.panelPosition?.y || 0);
        } else {
            initialX = e.clientX - (state.panelPosition?.x || 0);
            initialY = e.clientY - (state.panelPosition?.y || 0);
        }
        
        isDragging = true;
        state.isDragging = true;
    }
    
    function drag(e) {
        if (!isDragging) return;
        
        e.preventDefault();
        
        if (e.type === 'touchmove') {
            currentX = e.touches[0].clientX - initialX;
            currentY = e.touches[0].clientY - initialY;
        } else {
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
        }
        
        // Constrain to viewport
        const maxX = window.innerWidth - panel.offsetWidth;
        const maxY = window.innerHeight - panel.offsetHeight;
        
        currentX = Math.max(0, Math.min(currentX, maxX));
        currentY = Math.max(0, Math.min(currentY, maxY));
        
        state.panelPosition = { x: currentX, y: currentY };
        
        panel.style.left = 'auto';
        panel.style.right = 'auto';
        panel.style.top = 'auto';
        panel.style.transform = `translate(${currentX}px, ${currentY}px)`;
    }
    
    function dragEnd() {
        isDragging = false;
        state.isDragging = false;
    }
}

function resetPanelPosition() {
    const panel = document.getElementById('feature-info-panel');
    if (panel) {
        panel.style.left = 'auto';
        panel.style.right = '1rem';
        panel.style.top = '1rem';
        panel.style.transform = 'none';
        state.panelPosition = null;
    }
}

function handleInfoPointerClick(e) {
    if (!state.infoPointerActive) return;
    
    // Don't process click if we were just dragging
    if (state.isDragging) return;

    // Query all visible features at click point
    const features = state.map.queryRenderedFeatures(e.point);
    
    if (!features || features.length === 0) {
        clearFeatureHighlight();
        updateFeatureInfo({
            html: '<p class="info-hint">No features found at this location</p>'
        });
        return;
    }

    // Filter out our own highlight and route layers
    const validFeatures = features.filter(f => {
        const layerId = f.layer.id;
        return !layerId.startsWith('feature-highlight') &&
               !layerId.startsWith('route') &&
               !layerId.startsWith('service-') &&
               !layerId.startsWith('facility-');
    });

    if (validFeatures.length === 0) {
        clearFeatureHighlight();
        updateFeatureInfo({
            html: '<p class="info-hint">No base layer features at this location</p>'
        });
        return;
    }

    // Get the topmost feature
    const feature = validFeatures[0];
    
    // Highlight the feature
    highlightFeature(feature);
    
    // Display feature information
    displayFeatureInfo(feature);
}

function highlightFeature(feature) {
    // Clear previous highlight
    clearFeatureHighlight();
    
    // Store current highlight info
    state.highlightedFeatureId = feature.id;
    state.highlightedSourceLayer = feature.sourceLayer;
    
    // Update highlight source
    const highlightSource = state.map.getSource('feature-highlight');
    if (highlightSource) {
        highlightSource.setData({
            type: 'FeatureCollection',
            features: [feature]
        });
    }
}

function clearFeatureHighlight() {
    state.highlightedFeatureId = null;
    state.highlightedSourceLayer = null;
    
    const highlightSource = state.map.getSource('feature-highlight');
    if (highlightSource) {
        highlightSource.setData({
            type: 'FeatureCollection',
            features: []
        });
    }
}

function displayFeatureInfo(feature) {
    const properties = feature.properties || {};
    const layer = feature.layer.id;
    const sourceLayer = feature.sourceLayer || 'N/A';
    const geometryType = feature.geometry.type;
    
    let html = `
        <div class="feature-layer-info">
            <p><strong>Layer:</strong> ${layer}</p>
            <p><strong>Source Layer:</strong> ${sourceLayer}</p>
            <p><strong>Geometry:</strong> ${geometryType}</p>
        </div>
    `;
    
    if (Object.keys(properties).length > 0) {
        html += '<div class="feature-properties">';
        
        // Sort properties for better display
        const sortedKeys = Object.keys(properties).sort();
        
        sortedKeys.forEach(key => {
            const value = properties[key];
            
            // Skip null/undefined values
            if (value === null || value === undefined) return;
            
            // Format the value
            let formattedValue = value;
            if (typeof value === 'object') {
                formattedValue = JSON.stringify(value);
            } else if (typeof value === 'number') {
                formattedValue = value.toLocaleString();
            }
            
            html += `
                <div class="feature-property">
                    <span class="property-key">${formatPropertyKey(key)}</span>
                    <span class="property-value">${formattedValue}</span>
                </div>
            `;
        });
        
        html += '</div>';
    } else {
        html += '<p class="info-hint">No properties available for this feature</p>';
    }
    
    updateFeatureInfo({ html });
}

function formatPropertyKey(key) {
    // Convert snake_case or camelCase to Title Case
    return key
        .replace(/_/g, ' ')
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, str => str.toUpperCase())
        .trim();
}

function updateFeatureInfo({ html }) {
    const content = document.getElementById('feature-info-content');
    if (content) {
        content.innerHTML = html;
    }
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
    state.map.on('click', (e) => {
        // Handle info pointer click first
        if (state.infoPointerActive) {
            handleInfoPointerClick(e);
        } else {
            handleMapClick(e);
        }
    });

    // Close feature info panel
    document.getElementById('close-feature-info')?.addEventListener('click', () => {
        state.infoPointerActive = false;
        toggleInfoPointer();
    });

    // Mode switcher buttons
    document.getElementById('mode-route')?.addEventListener('click', () => switchMode('route'));
    document.getElementById('mode-tsp')?.addEventListener('click', () => switchMode('tsp'));
    document.getElementById('mode-facility')?.addEventListener('click', () => switchMode('facility'));
    document.getElementById('mode-service')?.addEventListener('click', () => switchMode('service'));

        // Route optimization buttons
    document.getElementById('opt-fastest')?.addEventListener('click', () => {
        state.routeOptimization = 'fastest';
        updateRouteOptButtons();
        // Recalculate if route exists
        if (state.markers.start && state.markers.end) {
            calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
        }
    });

    document.getElementById('opt-shortest')?.addEventListener('click', () => {
        state.routeOptimization = 'shortest';
        updateRouteOptButtons();
        // Recalculate if route exists
        if (state.markers.start && state.markers.end) {
            calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
        }
    });

    // Show alternatives checkbox
    document.getElementById('show-alternatives')?.addEventListener('change', (e) => {
        state.showAlternatives = e.target.checked;
        // Recalculate if route exists
        if (state.markers.start && state.markers.end) {
            calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
        }
    });

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

function updateRouteOptButtons() {
    document.querySelectorAll('.route-opt-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    if (state.routeOptimization === 'fastest') {
        document.getElementById('opt-fastest')?.classList.add('active');
    } else {
        document.getElementById('opt-shortest')?.classList.add('active');
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
        
    // Disable info pointer when switching modes
    if (state.infoPointerActive) {
        toggleInfoPointer();
    }
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
    const facilitySlidersContainer = document.getElementById('facility-sliders-container');
    const routeOptions = document.getElementById('route-options');
    const instruction = document.getElementById('mode-instruction');

    if (timeSlider) {
        timeSlider.classList.toggle('hidden', mode !== 'service');
    }

    if (facilitySelector) {
        facilitySelector.classList.toggle('hidden', mode !== 'facility');
    }

    if (facilitySlidersContainer) {
        facilitySlidersContainer.classList.toggle('hidden', mode !== 'facility');
    }
    
    if (routeOptions) {
        routeOptions.classList.toggle('hidden', mode !== 'route');
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
    showInfo("⏳ Calculating routes...");

    try {
        const alternatives = state.showAlternatives ? 3 : 1;
        const optimization = state.routeOptimization; // 'fastest' or 'shortest'
        
        const url = `${API_ENDPOINTS.route}?start_lon=${start.lng}&start_lat=${start.lat}&end_lon=${end.lng}&end_lat=${end.lat}&alternatives=${alternatives}&optimization=${optimization}`;
        const data = await fetchWithTimeout(url);

        if (data.error) {
            throw new Error(data.error);
        }

        // Handle multiple routes
        if (data.routes && Array.isArray(data.routes)) {
            // Clear old routes
            clearRouteLayers();
            
            // Add all routes with different colors
            data.routes.forEach((route, index) => {
                const color = getRouteColor(index);
                const opacity = index === 0 ? 0.9 : 0.6;
                const width = index === 0 ? 7 : 5;
                addRouteLayer(route, color, opacity, width, `route-${index}`);
            });
            
            state.currentRouteData = data.routes;
            
            // Fit map to show all routes
            fitToMultipleRoutes(data.routes);
            
            // Build summary
            const primaryRoute = data.routes[0];
            let summary = `✅ <strong>Best ${optimization} route:</strong> ${primaryRoute.duration_minutes} min • ${primaryRoute.total_distance_km} km`;
            
            if (data.routes.length > 1) {
                summary += `<br><small>Showing ${data.routes.length} alternative routes</small>`;
                data.routes.slice(1).forEach((route, idx) => {
                    summary += `<br><small style="color:#60a5fa;">Route ${idx + 2}: ${route.duration_minutes} min • ${route.total_distance_km} km</small>`;
                });
            }
            
            showInfo(summary);
        } else {
            // Single route (backward compatibility)
            state.currentRouteData = data;
            clearRouteLayers();
            addRouteLayer(data, '#3b82f6', 0.9, 7, 'route-0');
            fitToFeatures(data);
            showInfo(`✅ Route: ${data.duration_minutes} min • ${data.total_distance_km} km`);
        }
    } catch (error) {
        handleError('Route calculation', error);
    }
}

function getRouteColor(index) {
    const colors = [
        '#0865fc',  // Primary: Blue
        '#4f9af7',  // Alternative 1: Light blue
        '#6095d3'   // Alternative 2: Lighter blue
    ];
    return colors[index] || '#5e8bbe';
}

function clearRouteLayers() {
    // Remove all route layers and sources
    for (let i = 0; i < 5; i++) {
        const layerId = `route-${i}`;
        if (state.map.getLayer(layerId)) {
            state.map.removeLayer(layerId);
        }
        if (state.map.getSource(layerId)) {
            state.map.removeSource(layerId);
        }
    }
    
    // Also remove old single route layer for backward compatibility
    if (state.map.getLayer('route')) state.map.removeLayer('route');
    if (state.map.getSource('route')) state.map.removeSource('route');
}

function fitToMultipleRoutes(routes) {
    const bounds = new maplibregl.LngLatBounds();
    
    routes.forEach(route => {
        route.features.forEach(feature => {
            if (feature.geometry?.coordinates) {
                feature.geometry.coordinates.forEach(coord => bounds.extend(coord));
            }
        });
    });
    
    state.map.fitBounds(bounds, { 
        padding: 80, 
        maxZoom: 15, 
        duration: 1500 
    });
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
        
        const data = await fetchWithTimeout(API_ENDPOINTS.tsp, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ points })
        });

        if (data.error) {
            throw new Error(data.error);
        }

        state.currentRouteData = data;
        clearRouteLayers();
        addRouteLayer(data, '#9333ea', 0.9, 7, 'route-0');
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

function addRouteLayer(data, color, opacity = 0.9, width = 7, layerId = 'route') {
    if (state.map.getLayer(layerId)) state.map.removeLayer(layerId);
    if (state.map.getSource(layerId)) state.map.removeSource(layerId);

    state.map.addSource(layerId, { type: 'geojson', data });
    state.map.addLayer({
        id: layerId,
        type: 'line',
        source: layerId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 
            'line-color': color, 
            'line-width': width, 
            'line-opacity': opacity 
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
    // Clear route layers
    clearRouteLayers();
    
    // Remove all other layers
    const layersToRemove = [
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
        
    // Clear feature highlight if active
    if (state.infoPointerActive) {
        clearFeatureHighlight();
    }
    
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
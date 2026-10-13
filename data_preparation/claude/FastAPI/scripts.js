// ============================================================================
// ROUTING & SERVICES ANALYSIS APPLICATION
// ============================================================================
// CHANGES IN THIS VERSION vs original:
//
//  BUG FIXES
//    1. /route response shape:  API now ALWAYS returns { routes: [...] }.
//       The old dual-path  (data.routes ? … : [data])  is removed.
//       calculateRoute() now directly reads data.routes.
//
//    2. TSP segment coloring:   drawTSPSegments() received waypoint_order whose
//       last entry closes the loop (length = N+1), so legs.length = N but
//       waypoint_order[N] was undefined → wrong color on the last leg.
//       Fixed by clamping the color lookup to waypoint_order.length - 1.
//
//    3. Facility popup memory leak: popup objects were created but never stored,
//       so old popups couldn't be closed when a new search ran.
//       Each marker now stores its popup on marker._popup.
//
//    4. Style-switch duplicate markers: restoreFacilityData() called
//       displayFacilityResults() which called addTo(state.map) again,
//       creating invisible duplicate markers. Now restoreFacilityData()
//       only rebuilds the route LAYERS via rebuildFacilityRouteLayers()
//       and leaves the DOM markers untouched (they survive style switches).
//
//    5. clearAll() marker removal: the TSP marker objects are stored as
//       { marker, lngLat, color } — the old code called item.remove()
//       instead of item.marker.remove() → markers were never removed.
//       Fixed to item.marker?.remove().
//
//    6. Panel expand-on-click: the panel header had two stacked listeners
//       (one from injectMapButtons and one from toggleControlPanel) causing
//       double-toggle. Removed the redundant listener in injectMapButtons.
//
//  IMPROVEMENTS
//    7. fetchWithTimeout: surfaces the HTTP status text in error messages so
//       "404 Not Found" is shown instead of the generic "Server error: 404".
//
//    8. calculateRoute now shows per-route color swatches in the info box
//       matching the actual colors drawn on the map.
//
//    9. TSP info box shows total legs and distance, not just the time.
//
//   10. Facility hover popup delay is cancelled on mouseenter to prevent the
//       popup flickering when the mouse moves between marker and popup.
// ============================================================================

// ============================================================================
// SECTION 1: CONFIGURATION & CONSTANTS
// ============================================================================

// --- Map Style Definitions ---
const STYLES = [
    { id: 'basic-style', name: 'Default',   url: 'http://localhost:3001/styles/martin/style.json',     pitch: 0,  bearing: 0  },
    { id: 'sat-style',   name: 'Satellite', url: 'http://localhost:3001/styles/martin/style_sat.json', pitch: 0,  bearing: 0  },
    { id: '3d-style',    name: '3D',        url: 'http://localhost:3001/styles/martin/style_3d.json',  pitch: 45, bearing: 0  },
    { id: 'bdf-style',   name: 'BDF',       url: 'http://localhost:3001/styles/martin/style_bdf.json', pitch: 60, bearing: -20 }
];

// --- Backend API Configuration ---
const BACKEND_URL = 'http://localhost:5000';
const API_ENDPOINTS = {
    route:           `${BACKEND_URL}/route`,
    tsp:             `${BACKEND_URL}/route/tsp`,
    nearestFacility: `${BACKEND_URL}/nearest_facility`,
    serviceArea:     `${BACKEND_URL}/service_area`
};

// --- Elasticsearch Configuration ---
const ES_URL = 'http://localhost:9200';

// --- Map Default Settings ---
const DEFAULT_CENTER = [46.6167, 24.8258]; // Riyadh [lng, lat]
const DEFAULT_ZOOM   = 12;
const REQUEST_TIMEOUT = 65000; // 65 s — TSP and facility searches can be slow

// --- Facility Display Configuration ---
const FACILITY_COLORS = {
    'hospital':      '#ef4444',
    'fire station':  '#f97316',
    'police':        '#8b5cf6',
    'clinic':        '#10b981'
};
const FACILITY_ICONS = {
    'hospital':     '🏥',
    'fire station': '🚒',
    'police':       '👮',
    'clinic':       '⚕️'
};

// --- Route Color Palette ---
// Index 0 = primary (best) route, 1 and 2 = alternatives
const ROUTE_COLORS = ['#0865fc', '#4f9af7', '#6095d3'];

// --- TSP Color Palette ---
// Each waypoint and its outgoing leg share the same color from this list.
const TSP_COLORS = [
    '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
];

// --- UI Control Limits ---
const MAX_FACILITY_COUNT    = 20;
const MAX_SERVICE_MINUTES   = 20;
const MAX_SEARCH_DISTANCE_KM = 30;

// ============================================================================
// SECTION 2: APPLICATION STATE
// ============================================================================

const state = {
    map:          null,
    currentMode:  'route',
    currentCenter: DEFAULT_CENTER,
    currentZoom:   DEFAULT_ZOOM,
    currentPitch:  0,
    currentBearing: 0,

    markers: {
        start:    null,
        end:      null,
        service:  null,
        facility: null,
        tsp:      []    // Array of { marker, lngLat, color }
    },

    facilityMarkers: [], // maplibregl.Marker objects for facility search results

    // Saved API data — needed to redraw layers after style switches
    currentRouteData: null, // Array of FeatureCollections for /route
    lastTSPRouteData:  null, // { segments, waypoint_order }
    lastFacilityData:  null, // Full /nearest_facility API response
    lastServiceData:   null, // Full /service_area API response

    // User settings
    serviceMinutes:    5,
    facilityCount:     5,
    searchDistanceKm:  10,
    routeOptimization: 'fastest',
    showAlternatives:  true,

    // Info pointer
    infoPointerActive:      false,
    highlightedFeatureId:   null,
    highlightedSourceLayer: null,

    // Draggable info panel
    isDragging:    false,
    dragOffset:    { x: 0, y: 0 },
    panelPosition: null
};

// Module-level vars
let currentDataset     = 'units';
let currentStyleId     = 'basic-style';
let currentHighlightIds = [];
let currentPopup       = null;
let _facilitySearchId  = 0; // Incremented each search to detect stale responses

// ============================================================================
// SECTION 3: MAP INITIALIZATION
// ============================================================================

function initMap() {
    state.map = new maplibregl.Map({
        container:  'map',
        style:      STYLES[0].url,
        center:     state.currentCenter,
        zoom:       state.currentZoom,
        pitch:      state.currentPitch,
        bearing:    state.currentBearing,
        maxPitch:   85
    });

    // Keep camera state in sync so style switches can restore the view
    state.map.on('moveend', () => {
        state.currentCenter  = state.map.getCenter().toArray();
        state.currentZoom    = state.map.getZoom();
        state.currentPitch   = state.map.getPitch();
        state.currentBearing = state.map.getBearing();
    });

    state.map.addControl(new maplibregl.NavigationControl(), 'top-right');
    state.map.addControl(createLayerSwitcher(), 'bottom-right');

    initializeSliders();
    setupEventHandlers();

    state.map.on('load', () => {
        showInfo('Click anywhere to begin routing of two points');
        setupInfoPointerLayers();
        injectMapButtons();
    });

    // After a style switch the style is reloaded — rebuild info pointer layers
    state.map.on('styledata', () => {
        if (state.infoPointerActive) setupInfoPointerLayers();
    });
}

// ============================================================================
// SECTION 4: MAP CONTROLS & UI HELPERS
// ============================================================================

function createLayerSwitcher() {
    class LayerSwitcher {
        onAdd(map) {
            this.map = map;
            this.container = document.createElement('div');
            this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group flex flex-col bg-white';
            STYLES.forEach(style => {
                const btn = document.createElement('button');
                btn.type      = 'button';
                btn.className = 'px-4 py-3 text-sm font-medium hover:bg-blue-50 border-b border-gray-200 transition';
                btn.textContent = (style.name === '3D' || style.name === 'BDF')
                    ? style.name
                    : style.name.charAt(0);
                btn.onclick = () => switchMapStyle(style);
                this.container.appendChild(btn);
            });
            return this.container;
        }
        onRemove() { this.container.parentNode?.removeChild(this.container); }
    }
    return new LayerSwitcher();
}

async function switchMapStyle(style) {
    currentStyleId = style.id;

    const center  = state.map.getCenter();
    const zoom    = style.zoom    ?? state.map.getZoom();
    const pitch   = style.pitch   ?? state.map.getPitch();
    const bearing = style.bearing ?? state.map.getBearing();

    state.map.setStyle(style.url);

    state.map.once('idle', () => {
        state.map.jumpTo({ center, zoom, pitch, bearing });

        if (state.infoPointerActive) setupInfoPointerLayers();

        switch (state.currentMode) {
            case 'route':    restoreRouteLayers();  break;
            case 'tsp':      restoreTSPRoute();     break;
            case 'facility': restoreFacilityData(); break;
            case 'service':  restoreServiceArea();  break;
        }
    });
}

function injectMapButtons() {
    const topRight = document.querySelector('.maplibregl-ctrl-top-right');
    if (!topRight) return;

    const ctrlGroup = document.createElement('div');
    ctrlGroup.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    ctrlGroup.id = 'custom-map-controls';

    // Info pointer toggle
    const infoBtn = document.createElement('button');
    infoBtn.className = 'info-pointer-btn';
    infoBtn.type      = 'button';
    infoBtn.innerHTML = 'ℹ️';
    infoBtn.title     = 'Toggle Info Pointer';
    infoBtn.addEventListener('click', toggleInfoPointer);

    // Panel toggle
    const panelBtn = document.createElement('button');
    panelBtn.className = 'panel-toggle-btn';
    panelBtn.type      = 'button';
    panelBtn.innerHTML = '◀';
    panelBtn.title     = 'Hide Control Panel';
    panelBtn.addEventListener('click', () => toggleControlPanel(panelBtn));

    ctrlGroup.appendChild(infoBtn);
    ctrlGroup.appendChild(panelBtn);
    topRight.appendChild(ctrlGroup);

    // BUG FIX #6: The original code attached a panel expand listener here AND
    // inside toggleControlPanel(), causing a double-toggle.
    // The expand-on-minimised-click is handled entirely inside toggleControlPanel().
}

function toggleControlPanel(btn) {
    const panel = document.querySelector('.control-panel.header');
    if (!panel) return;

    const isMinimised = panel.classList.toggle('panel-minimised');
    btn.classList.toggle('active', isMinimised);
    btn.innerHTML = isMinimised ? '▶' : '◀';
    btn.title     = isMinimised ? 'Show Control Panel' : 'Hide Control Panel';

    if (isMinimised) {
        // Clicking the panel header while minimised expands it again
        panel._expandHandler = (e) => {
            // Don't expand when clicking interactive children
            if (e.target.closest('button,input,select,label,.mode-btn,.route-opt-btn,.range-slider')) return;
            toggleControlPanel(btn);
        };
        panel.addEventListener('click', panel._expandHandler);
    } else {
        if (panel._expandHandler) {
            panel.removeEventListener('click', panel._expandHandler);
            delete panel._expandHandler;
        }
    }
}

// ============================================================================
// SECTION 5: INFO POINTER FEATURE
// ============================================================================

function toggleInfoPointer() {
    state.infoPointerActive = !state.infoPointerActive;

    const btn          = document.querySelector('.info-pointer-btn');
    const mapContainer = document.getElementById('map');
    const featurePanel = document.getElementById('feature-info-panel');

    if (state.infoPointerActive) {
        btn.classList.add('active');
        mapContainer.classList.add('info-pointer-active');
        featurePanel.classList.remove('hidden');
        resetPanelPosition();
        setupDraggablePanel();
        clearFeatureHighlight();
        updateFeatureInfo({ html: '<p class="info-hint">Click on any feature to see its details</p>' });
    } else {
        btn.classList.remove('active');
        mapContainer.classList.remove('info-pointer-active');
        featurePanel.classList.add('hidden');
        clearFeatureHighlight();
    }
}

function setupInfoPointerLayers() {
    if (!state.map.isStyleLoaded()) {
        state.map.once('styledata', setupInfoPointerLayers);
        return;
    }

    if (!state.map.getSource('feature-highlight')) {
        state.map.addSource('feature-highlight', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }

    const highlightLayers = [
        {
            id: 'feature-highlight-fill',
            type: 'fill',
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.3 }
        },
        {
            id: 'feature-highlight-line',
            type: 'line',
            filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'Polygon']],
            paint: { 'line-color': '#3b82f6', 'line-width': 3, 'line-opacity': 0.8 }
        },
        {
            id: 'feature-highlight-point',
            type: 'circle',
            filter: ['==', ['geometry-type'], 'Point'],
            paint: { 'circle-radius': 8, 'circle-color': '#3b82f6', 'circle-opacity': 0.6, 'circle-stroke-width': 2, 'circle-stroke-color': '#1e40af' }
        }
    ];

    highlightLayers.forEach(layer => {
        if (!state.map.getLayer(layer.id)) {
            state.map.addLayer({ ...layer, source: 'feature-highlight' });
        }
    });
}

function handleInfoPointerClick(e) {
    if (!state.infoPointerActive || state.isDragging) return;

    const features = state.map.queryRenderedFeatures(e.point);
    if (!features || features.length === 0) {
        clearFeatureHighlight();
        updateFeatureInfo({ html: '<p class="info-hint">No features found at this location</p>' });
        return;
    }

    // Filter out our own layers — only inspect base-map features
    const validFeatures = features.filter(f => {
        const id = f.layer.id;
        return !id.startsWith('feature-highlight') &&
               !id.startsWith('route')             &&
               !id.startsWith('tsp-segment')       &&
               !id.startsWith('service-')          &&
               !id.startsWith('facility-');
    });

    if (validFeatures.length === 0) {
        clearFeatureHighlight();
        updateFeatureInfo({ html: '<p class="info-hint">No base layer features at this location</p>' });
        return;
    }

    const feature = validFeatures[0];
    highlightFeature(feature);
    displayFeatureInfo(feature);
}

function highlightFeature(feature) {
    clearFeatureHighlight();
    state.highlightedFeatureId   = feature.id;
    state.highlightedSourceLayer = feature.sourceLayer;

    const src = state.map.getSource('feature-highlight');
    if (src) src.setData({ type: 'FeatureCollection', features: [feature] });
}

function displayFeatureInfo(feature) {
    const properties = feature.properties || {};
    const geomType   = feature.geometry.type;

    let html = `
        <div class="feature-layer-info">
            <p><strong>Layer:</strong> ${feature.layer.id}</p>
            <p><strong>Source Layer:</strong> ${feature.sourceLayer || 'N/A'}</p>
            <p><strong>Geometry:</strong> ${geomType}</p>
        </div>
    `;

    if (Object.keys(properties).length > 0) {
        html += '<div class="feature-properties">';
        Object.keys(properties).sort().forEach(key => {
            const val = properties[key];
            if (val === null || val === undefined) return;
            const formatted = typeof val === 'object'
                ? JSON.stringify(val)
                : typeof val === 'number'
                ? val.toLocaleString()
                : val;
            html += `
                <div class="feature-property">
                    <span class="property-key">${formatPropertyKey(key)}</span>
                    <span class="property-value">${formatted}</span>
                </div>`;
        });
        html += '</div>';
    } else {
        html += '<p class="info-hint">No properties available for this feature</p>';
    }

    updateFeatureInfo({ html });
}

function formatPropertyKey(key) {
    if (key === key.toUpperCase()) return key.replace(/_/g, ' ').trim();
    return key
        .replace(/_/g, ' ')
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, s => s.toUpperCase())
        .trim();
}

function updateFeatureInfo({ html }) {
    const content = document.getElementById('feature-info-content');
    if (content) content.innerHTML = html;
}

function clearFeatureHighlight() {
    state.highlightedFeatureId   = null;
    state.highlightedSourceLayer = null;
    const src = state.map.getSource('feature-highlight');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
}

// ============================================================================
// SECTION 6: DRAGGABLE PANEL
// ============================================================================

function setupDraggablePanel() {
    const panel  = document.getElementById('feature-info-panel');
    const header = document.querySelector('.feature-info-header');
    if (!panel || !header) return;

    // Remove stacked listeners from previous activations
    if (panel._dragStart) {
        header.removeEventListener('mousedown',  panel._dragStart);
        header.removeEventListener('touchstart', panel._dragStart);
        document.removeEventListener('mousemove', panel._drag);
        document.removeEventListener('touchmove', panel._drag);
        document.removeEventListener('mouseup',   panel._dragEnd);
        document.removeEventListener('touchend',  panel._dragEnd);
    }

    let isDragging = false;
    let initialX = 0, initialY = 0;

    const dragStart = (e) => {
        if (e.target.closest('.close-btn')) return;
        const touch = e.touches?.[0] || e;
        const rect  = panel.getBoundingClientRect();
        initialX = touch.clientX - rect.left;
        initialY = touch.clientY - rect.top;
        isDragging = true;
        state.isDragging = true;
        panel.style.right     = 'auto';
        panel.style.left      = rect.left + 'px';
        panel.style.top       = rect.top  + 'px';
        panel.style.transform = 'none';
    };

    const drag = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const touch = e.touches?.[0] || e;
        const newX = Math.max(0, Math.min(touch.clientX - initialX, window.innerWidth  - panel.offsetWidth));
        const newY = Math.max(0, Math.min(touch.clientY - initialY, window.innerHeight - panel.offsetHeight));
        panel.style.left = newX + 'px';
        panel.style.top  = newY + 'px';
    };

    const dragEnd = () => {
        isDragging = false;
        state.isDragging = false;
    };

    header.addEventListener('mousedown',  dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup',   dragEnd);
    header.addEventListener('touchstart', dragStart, { passive: false });
    document.addEventListener('touchmove', drag,     { passive: false });
    document.addEventListener('touchend',  dragEnd);

    panel._dragStart = dragStart;
    panel._drag      = drag;
    panel._dragEnd   = dragEnd;
}

function resetPanelPosition() {
    const panel = document.getElementById('feature-info-panel');
    if (!panel) return;
    panel.style.left      = 'auto';
    panel.style.right     = '1rem';
    panel.style.top       = '1rem';
    panel.style.bottom    = 'auto';
    panel.style.transform = 'none';
    state.panelPosition   = null;
}

// ============================================================================
// SECTION 7: UI INITIALIZATION & EVENT HANDLERS
// ============================================================================

function initializeSliders() {
    const fc = document.getElementById('facility-count-input');
    if (fc) fc.max = MAX_FACILITY_COUNT;
    const ti = document.getElementById('time-input');
    if (ti) ti.max = MAX_SERVICE_MINUTES;
    const di = document.getElementById('distance-input');
    if (di) di.max = MAX_SEARCH_DISTANCE_KM;
}

function setupEventHandlers() {
    // All map clicks go through one gate
    state.map.on('click', (e) => {
        if (state.infoPointerActive) handleInfoPointerClick(e);
        else                          handleMapClick(e);
    });

    document.getElementById('close-feature-info')?.addEventListener('click', () => {
        state.infoPointerActive = true; // Flip so toggleInfoPointer turns it OFF
        toggleInfoPointer();
    });

    // Mode buttons
    ['route', 'tsp', 'facility', 'service'].forEach(mode => {
        document.getElementById(`mode-${mode}`)?.addEventListener('click', () => switchMode(mode));
    });

    // Route optimization
    document.getElementById('opt-fastest')?.addEventListener('click', () => {
        state.routeOptimization = 'fastest';
        updateRouteOptButtons();
        if (state.markers.start && state.markers.end)
            calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
    });
    document.getElementById('opt-shortest')?.addEventListener('click', () => {
        state.routeOptimization = 'shortest';
        updateRouteOptButtons();
        if (state.markers.start && state.markers.end)
            calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
    });

    // Show alternatives checkbox
    document.getElementById('show-alternatives')?.addEventListener('change', (e) => {
        state.showAlternatives = e.target.checked;
        if (state.markers.start && state.markers.end)
            calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
    });

    // Service time slider
    const timeInput = document.getElementById('time-input');
    const timeValue = document.getElementById('time-value');
    if (timeInput && timeValue) {
        timeValue.textContent = timeInput.value;
        timeInput.addEventListener('input', (e) => {
            state.serviceMinutes  = parseInt(e.target.value, 10);
            timeValue.textContent = state.serviceMinutes;
            if (state.markers.service)
                calculateServiceArea(state.markers.service.getLngLat());
        });
    }

    // Facility count slider
    const facilityCountInput = document.getElementById('facility-count-input');
    const facilityCountValue = document.getElementById('facility-count-value');
    if (facilityCountInput && facilityCountValue) {
        facilityCountValue.textContent = facilityCountInput.value;
        facilityCountInput.addEventListener('input', (e) => {
            state.facilityCount   = parseInt(e.target.value, 10);
            facilityCountValue.textContent = state.facilityCount;
            if (state.markers.facility)
                calculateNearestFacilities(state.markers.facility.getLngLat());
        });
    }

    // Search distance slider
    const distanceInput = document.getElementById('distance-input');
    const distanceValue = document.getElementById('distance-value');
    if (distanceInput && distanceValue) {
        distanceValue.textContent = distanceInput.value;
        distanceInput.addEventListener('input', (e) => {
            state.searchDistanceKm = parseInt(e.target.value, 10);
            distanceValue.textContent  = state.searchDistanceKm;
            if (state.markers.facility)
                calculateNearestFacilities(state.markers.facility.getLngLat());
        });
    }

    // Elasticsearch search box
    document.getElementById('searchInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchUnits();
    });

    // Dataset radio buttons
    document.querySelectorAll('input[name="dataset"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            currentDataset = e.target.value;
            document.getElementById('results').innerHTML = '';
            clearHighlight();
        });
    });
}

function updateRouteOptButtons() {
    document.querySelectorAll('.route-opt-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(state.routeOptimization === 'fastest' ? 'opt-fastest' : 'opt-shortest')
        ?.classList.add('active');
}

function handleMapClick(e) {
    const handlers = { route: handleRouteClick, tsp: handleTSPClick, facility: handleFacilityClick, service: handleServiceClick };
    const handler  = handlers[state.currentMode];
    if (handler) handler(e.lngLat);
    else console.warn(`Unknown mode: ${state.currentMode}`);
}

// ============================================================================
// SECTION 8: MODE SWITCHING
// ============================================================================

function switchMode(mode) {
    clearAll();
    state.currentMode = mode;
    updateModeButtons(mode);
    updateModeInstructions(mode);
    if (state.infoPointerActive) toggleInfoPointer();
}

function updateModeButtons(activeMode) {
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`mode-${activeMode}`)?.classList.add('active');
}

function updateModeInstructions(mode) {
    document.getElementById('time-slider')?.classList.toggle('hidden', mode !== 'service');
    document.getElementById('facility-selector')?.classList.toggle('hidden', mode !== 'facility');
    document.getElementById('facility-sliders-container')?.classList.toggle('hidden', mode !== 'facility');
    document.getElementById('route-options')?.classList.toggle('hidden', mode !== 'route');

    const instructions = {
        route:    { html: 'Click: <span class="highlight start">Start</span> → <span class="highlight end">End</span>', info: '🗺️ A→B Route mode active' },
        tsp:      { html: 'Click to add <span style="color:#8b5cf6;font-weight:bold">waypoints</span> (min 3)', info: '🔄 TSP mode: Add at least 3 points' },
        facility: { html: 'Click a <span style="color:#ef4444;font-weight:bold">location</span> to find nearest facilities', info: '🏥 Nearest Facility mode active' },
        service:  { html: 'Click <span style="color:#ef4444;font-weight:bold">service location</span> + adjust time', info: '🚚 Service Area mode active' }
    };

    const cfg = instructions[mode];
    if (cfg) {
        const instruction = document.getElementById('mode-instruction');
        if (instruction) instruction.innerHTML = cfg.html;
        showInfo(cfg.info);
    }
}

// ============================================================================
// SECTION 9: ROUTE MODE (A→B)
// ============================================================================

function handleRouteClick(lngLat) {
    if (!state.markers.start) {
        state.markers.start = new maplibregl.Marker({ element: createMarker('S', '#10b981') })
            .setLngLat(lngLat).addTo(state.map);
        showInfo('✅ Start set. Click destination');
    } else if (!state.markers.end) {
        state.markers.end = new maplibregl.Marker({ element: createMarker('E', '#ef4444') })
            .setLngLat(lngLat).addTo(state.map);
        calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
    } else {
        clearAll();
        showInfo('🔄 Cleared. Click new start point');
    }
}

async function calculateRoute(start, end) {
    clearRouteLayers();
    showInfo('⏳ Calculating routes...');

    try {
        const url  = `${API_ENDPOINTS.route}?start_lon=${start.lng}&start_lat=${start.lat}&end_lon=${end.lng}&end_lat=${end.lat}&alternatives=${state.showAlternatives ? 3 : 1}&optimization=${state.routeOptimization}`;
        const data = await fetchWithTimeout(url);

        if (data.error) throw new Error(data.error);

        // BUG FIX #1: API now ALWAYS returns { routes: [...] }.
        // No need for the old "data.routes ? data.routes : [data]" fallback.
        const routes = data.routes;
        if (!routes || routes.length === 0) throw new Error('No routes returned by the server.');

        state.currentRouteData = routes;

        routes.forEach((route, i) => {
            const color   = ROUTE_COLORS[i] || '#5e8bbe';
            const opacity = i === 0 ? 0.9 : 0.6;
            const width   = i === 0 ? 7   : 5;
            addRouteLayer(route, color, opacity, width, `route-${i}`);
        });

        routes.length > 1 ? fitToMultipleRoutes(routes) : fitToFeatures(routes[0]);

        // Build info box — show a color swatch for each route so the user can
        // match the text to the lines drawn on the map
        const best = routes[0];
        let summary = `✅ <strong>Best ${state.routeOptimization} route:</strong> ${best.duration_minutes} min • ${best.total_distance_km} km`;

        if (routes.length > 1) {
            summary += `<br><small>Showing ${routes.length} of ${data.requested} requested routes</small>`;
            routes.slice(1).forEach((r, i) => {
                const color = ROUTE_COLORS[i + 1] || '#5e8bbe';
                summary += `<br><small style="color:${color};">● Route ${i + 2}: ${r.duration_minutes} min • ${r.total_distance_km} km</small>`;
            });
        }

        showInfo(summary);

    } catch (error) {
        handleError('Route calculation', error);
    }
}

function fitToMultipleRoutes(routes) {
    const bounds = new maplibregl.LngLatBounds();
    routes.forEach(route => {
        route.features.forEach(f => {
            if (f.geometry?.coordinates) f.geometry.coordinates.forEach(c => bounds.extend(c));
        });
    });
    state.map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 1500 });
}

// ============================================================================
// SECTION 10: TSP MODE
// ============================================================================

function handleTSPClick(lngLat) {
    const MIN_DISTANCE_METERS = 100;

    const isTooClose = state.markers.tsp.some(item => {
        const dx = item.lngLat.lng - lngLat.lng;
        const dy = item.lngLat.lat - lngLat.lat;
        return Math.sqrt(dx * dx + dy * dy) * 111320 < MIN_DISTANCE_METERS;
    });

    if (isTooClose) {
        showInfo('⚠️ This point is too close to an existing waypoint.');
        return;
    }

    const num   = state.markers.tsp.length + 1;
    const color = TSP_COLORS[(num - 1) % TSP_COLORS.length];

    const marker = new maplibregl.Marker({ element: createMarker(num.toString(), color) })
        .setLngLat(lngLat).addTo(state.map);

    state.markers.tsp.push({ marker, lngLat, color });

    if (state.markers.tsp.length < 3) {
        showInfo(`✅ Point ${num} added. Need ${3 - state.markers.tsp.length} more (min 3)`);
    } else {
        showInfo(`✅ Point ${num} added. Auto-calculating optimized route in 2 seconds...`);
        setTimeout(() => {
            if (state.markers.tsp.length >= 3) calculateTSP();
        }, 2000);
    }
}

async function calculateTSP() {
    if (state.markers.tsp.length < 3) { showInfo('❌ Need at least 3 points for TSP'); return; }

    showInfo(`⏳ Solving TSP for ${state.markers.tsp.length} points...`);

    try {
        const points = state.markers.tsp.map(m => [m.lngLat.lng, m.lngLat.lat]);

        const data = await fetchWithTimeout(API_ENDPOINTS.tsp, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ points })
        });

        if (data.error) throw new Error(data.error);

        clearTSPLayers();

        state.lastTSPRouteData = {
            segments:       data.segments,
            waypoint_order: data.waypoint_order
        };

        drawTSPSegments(data.segments, data.waypoint_order);

        if (data.segments?.length > 0) fitToFeatures(data.segments[0]);

        // Build visit order string with matching colors
        const orderStr = data.waypoint_order
            .map(idx => {
                const color = TSP_COLORS[idx % TSP_COLORS.length];
                return `<span style="color:${color};font-weight:bold;">${idx + 1}</span>`;
            })
            .join(' <span style="color:#6b7280;">→</span> ');

        showInfo(`
            ✅ <strong>TSP Optimized!</strong><br>
            Order: ${orderStr}<br>
            ${data.duration_minutes} min • ${data.total_distance_km} km • ${data.segment_count} legs
        `);

    } catch (error) {
        handleError('TSP calculation', error);
    }
}

/**
 * Draw each TSP leg as a colored route layer.
 *
 * BUG FIX #2:
 *   waypoint_order has length N+1 (last entry closes the loop back to start).
 *   legs has length N.
 *   For the Nth leg (index N-1), waypoint_order[N-1] is the correct starting
 *   waypoint — but only if we don't accidentally use waypoint_order[N] which
 *   equals waypoint_order[0] (the loop-close entry) and would give the wrong color.
 *   We guard with:  waypoint_order[Math.min(i, waypoint_order.length - 2)]
 *   so the last leg always gets index [N-1], never [N].
 */
function drawTSPSegments(segments, waypoint_order) {
    if (!segments || segments.length === 0) return;

    segments.forEach((segmentData, i) => {
        // waypoint_order may be longer than segments (loop-close entry).
        // Clamp to the valid range:  [0 .. segments.length - 1]
        const safeIdx          = waypoint_order
            ? Math.min(i, waypoint_order.length - 2)
            : i;
        const startWaypointIdx = waypoint_order ? waypoint_order[safeIdx] : i;
        const color            = TSP_COLORS[startWaypointIdx % TSP_COLORS.length];

        addRouteLayer(segmentData, color, 0.95, 6.5, `tsp-segment-${i}`);
    });
}

// ============================================================================
// SECTION 11: NEAREST FACILITY MODE
// ============================================================================

function handleFacilityClick(lngLat) {
    clearFacilityData();
    state.markers.facility = new maplibregl.Marker({ element: createMarker('📍', '#dc2626') })
        .setLngLat(lngLat).addTo(state.map);
    showInfo('⏳ Searching nearest facilities...');
    calculateNearestFacilities(lngLat);
}

async function calculateNearestFacilities(lngLat) {
    const mySearchId = ++_facilitySearchId;

    const facilityType = document.getElementById('facility-type-select')?.value || 'hospital';
    showInfo(`⏳ Searching for nearest ${facilityType}s within ${state.searchDistanceKm} km…<br><small>This may take a few seconds</small>`);

    try {
        const url  = `${API_ENDPOINTS.nearestFacility}?lon=${lngLat.lng}&lat=${lngLat.lat}&type=${encodeURIComponent(facilityType)}&limit=${state.facilityCount}&max_distance_km=${state.searchDistanceKm}&routes=true`;
        const data = await fetchWithTimeout(url);

        if (mySearchId !== _facilitySearchId) return; // Stale response — discard

        if (data.error) throw new Error(data.error);

        if (!data.facilities || data.facilities.length === 0) {
            showInfo(`ℹ️ No ${facilityType} found within ${state.searchDistanceKm} km radius`);
            return;
        }

        displayFacilityResults(lngLat, data, facilityType);

    } catch (error) {
        if (mySearchId === _facilitySearchId) handleError('Facility search', error);
    }
}

function displayFacilityResults(lngLat, data, facilityType) {
    removeFacilityLayers();
    removeFacilityMarkers();

    // Draw all route lines in a single layer
    const allRouteFeatures = [];
    data.facilities.forEach((facility, index) => {
        if (facility.route?.features) {
            facility.route.features.forEach(f => {
                allRouteFeatures.push({
                    ...f,
                    properties: { ...f.properties, facility_rank: index + 1, travel_minutes: facility.travel_minutes }
                });
            });
        }
    });

    if (allRouteFeatures.length > 0) {
        const facilityColor = FACILITY_COLORS[facilityType] || '#6366f1';
        state.map.addSource('facility-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: allRouteFeatures } });
        state.map.addLayer({
            id: 'facility-routes', type: 'line', source: 'facility-routes',
            paint: {
                'line-color':   facilityColor,
                'line-width':   ['interpolate', ['linear'], ['get', 'facility_rank'], 1, 6, 5, 3],
                'line-opacity': 0.8
            }
        });
    }

    // Create facility markers
    state.facilityMarkers = data.facilities.map((facility, index) => {
        const icon  = FACILITY_ICONS[facility.type] || '📍';
        const color = FACILITY_COLORS[facility.type] || '#6366f1';

        const el = document.createElement('div');
        el.style.cssText = `
            width:48px;height:48px;background:${color};border:3px solid white;
            border-radius:50%;display:flex;align-items:center;justify-content:center;
            font-size:24px;box-shadow:0 4px 12px rgba(0,0,0,0.3);cursor:pointer;position:relative;
        `;
        el.innerHTML = icon;

        // Rank badge
        const badge = document.createElement('div');
        badge.style.cssText = `
            position:absolute;top:-8px;right:-8px;width:24px;height:24px;
            background:white;border:2px solid ${color};border-radius:50%;
            display:flex;align-items:center;justify-content:center;
            font-size:12px;font-weight:bold;color:${color};
        `;
        badge.textContent = index + 1;
        el.appendChild(badge);

        // BUG FIX #3: Store popup reference on the marker so it can be properly closed
        const popup = new maplibregl.Popup({
            offset: 25, closeButton: true, closeOnClick: true, closeOnMove: false, maxWidth: '300px'
        }).setHTML(`
            <div style="font-family:sans-serif;min-width:220px;">
                <div style="font-size:24px;margin-bottom:8px;">${icon}</div>
                <strong style="font-size:14px;color:#1f2937;">${facility.name}</strong>
                ${facility.address ? `<p style="margin:4px 0;font-size:12px;color:#6b7280;">${facility.address}</p>` : ''}
                <p style="margin:8px 0 0;font-size:13px;color:#059669;"><strong>⏱️ ${facility.travel_minutes} min</strong> drive</p>
                <p style="margin:4px 0 0;font-size:11px;color:#9ca3af;">
                    Rank: #${index + 1}${facility.crow_distance_km ? ` • ${parseFloat(facility.crow_distance_km).toFixed(1)} km straight-line` : ''}
                </p>
            </div>
        `);

        const marker = new maplibregl.Marker({ element: el })
            .setLngLat([parseFloat(facility.facility_lon), parseFloat(facility.facility_lat)])
            .setPopup(popup)
            .addTo(state.map);

        // Store popup on marker for cleanup
        marker._popup = popup;

        let closeTimeout;
        el.addEventListener('mouseenter', () => {
            clearTimeout(closeTimeout); // BUG FIX #10: cancel pending close on re-enter
            if (!marker.getPopup().isOpen()) marker.togglePopup();
        });
        el.addEventListener('mouseleave', () => {
            closeTimeout = setTimeout(() => {
                if (marker.getPopup().isOpen()) marker.togglePopup();
            }, 200);
        });

        return marker;
    });

    state.lastFacilityData = data;

    // Build summary
    const closest = data.facilities[0];
    const icon = FACILITY_ICONS[facilityType] || '📍';
    const list = data.facilities
        .map((f, i) => `${i + 1}. ${FACILITY_ICONS[f.type] || '📍'} ${f.name} (${f.travel_minutes} min)`)
        .join('<br>');

    showInfo(`
        ✅ Found ${data.count} ${facilityType}${data.count > 1 ? 's' : ''} within ${state.searchDistanceKm} km
        <br><strong>Closest:</strong> ${icon} ${closest.name}
        <br><strong>Travel time:</strong> ${closest.travel_minutes} minutes
        ${closest.crow_distance_km ? `<br><small>Straight-line: ${closest.crow_distance_km.toFixed(1)} km</small>` : ''}
        <br><br><small>${list}</small>
    `);

    const bounds = new maplibregl.LngLatBounds();
    bounds.extend([lngLat.lng, lngLat.lat]);
    data.facilities.forEach(f => bounds.extend([parseFloat(f.facility_lon), parseFloat(f.facility_lat)]));
    state.map.fitBounds(bounds, { padding: { top: 80, bottom: 80, left: 80, right: 80 }, maxZoom: 14, duration: 1000 });
}

function removeFacilityMarkers() {
    // BUG FIX #3 continued: close popup before removing marker
    state.facilityMarkers.forEach(m => {
        if (m._popup && m._popup.isOpen()) m._popup.remove();
        m.remove();
    });
    state.facilityMarkers = [];
}

function removeFacilityLayers() {
    ['facility-routes'].forEach(id => {
        if (state.map.getLayer(id))  state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    });
}

function rebuildFacilityRouteLayers(data, facilityType) {
    const allRouteFeatures = [];
    data.facilities.forEach((facility, index) => {
        if (facility.route?.features) {
            facility.route.features.forEach(f => {
                allRouteFeatures.push({ ...f, properties: { ...f.properties, facility_rank: index + 1 } });
            });
        }
    });
    if (allRouteFeatures.length === 0) return;

    const facilityColor = FACILITY_COLORS[facilityType] || '#6366f1';
    state.map.addSource('facility-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: allRouteFeatures } });
    state.map.addLayer({
        id: 'facility-routes', type: 'line', source: 'facility-routes',
        paint: {
            'line-color':   facilityColor,
            'line-width':   ['interpolate', ['linear'], ['get', 'facility_rank'], 1, 6, 5, 3],
            'line-opacity': 0.8
        }
    });
}

// ============================================================================
// SECTION 12: SERVICE AREA MODE
// ============================================================================

function handleServiceClick(lngLat) {
    clearServiceArea();
    if (state.markers.service) { state.markers.service.remove(); state.markers.service = null; }
    state.markers.service = new maplibregl.Marker({ element: createMarker('🚚', '#1c2ae1') })
        .setLngLat(lngLat).addTo(state.map);
    calculateServiceArea(lngLat);
}

async function calculateServiceArea(lngLat) {
    showInfo(`⏳ Calculating ${state.serviceMinutes}-min service area...`);
    try {
        const data = await fetchWithTimeout(
            `${API_ENDPOINTS.serviceArea}?lon=${lngLat.lng}&lat=${lngLat.lat}&minutes=${state.serviceMinutes}`
        );
        if (data.error) throw new Error(data.error);
        state.lastServiceData = data;
        rebuildServiceAreaLayers(data);

        if (data.service_area.coordinates?.[0]) {
            const bounds = new maplibregl.LngLatBounds();
            data.service_area.coordinates[0].forEach(c => bounds.extend(c));
            state.map.fitBounds(bounds, { padding: 100, maxZoom: 14, duration: 1500 });
        }

        showInfo(`🚚 ${state.serviceMinutes}-min service area calculated<br><small>Red zone = reachable area from service point</small>`);
    } catch (error) {
        handleError('Service area calculation', error);
    }
}

function rebuildServiceAreaLayers(data) {
    clearServiceArea();

    if (data.reachable_network) {
        state.map.addSource('service-network', { type: 'geojson', data: data.reachable_network });
        state.map.addLayer({ id: 'service-network', type: 'line', source: 'service-network',
            paint: { 'line-color': '#f59e0b', 'line-width': 3, 'line-opacity': 0.6 } });
    }

    if (data.service_area) {
        state.map.addSource('service-hull', { type: 'geojson', data: data.service_area });
        state.map.addLayer({ id: 'service-hull', type: 'fill', source: 'service-hull',
            paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.15 } });
        state.map.addLayer({ id: 'service-border', type: 'line', source: 'service-hull',
            paint: { 'line-color': '#dc2626', 'line-width': 4, 'line-dasharray': [3, 2], 'line-opacity': 0.8 } });
    }
}

// ============================================================================
// SECTION 13: UTILITY FUNCTIONS
// ============================================================================

/**
 * Fetch a URL with a timeout.
 *
 * BUG FIX #7: Surfaces the HTTP status text so error messages say
 * "404 Not Found" or "422 Unprocessable Entity" instead of just "Server error: 404".
 */
async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            // Try to read the error detail from the JSON body (FastAPI provides this)
            let detail = `${response.status} ${response.statusText}`;
            try {
                const body = await response.json();
                if (body.detail) detail = body.detail;
            } catch { /* body wasn't JSON — use the status text */ }
            throw new Error(detail);
        }

        return await response.json();

    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') throw new Error('Request timed out. Please try again.');
        throw error;
    }
}

function handleError(context, error) {
    console.error(`${context} error:`, error);
    const message = error.message.includes('Failed to fetch')
        ? 'Network error. Check your connection and try again.'
        : error.message;
    showInfo(`❌ ${message}`);
}

function createMarker(text, bgColor = null) {
    const el = document.createElement('div');
    el.className = 'marker';
    if (text === '🚚') el.classList.add('marker-service');
    if (text === 'E')  el.classList.add('marker-end');
    if (bgColor) el.style.backgroundColor = bgColor;
    el.textContent = text;
    return el;
}

function showInfo(text) {
    const infoBox   = document.getElementById('info-box');
    const routeInfo = document.getElementById('route-info');
    if (infoBox && routeInfo) {
        infoBox.classList.remove('hidden');
        routeInfo.innerHTML = text;
    }
}

function addRouteLayer(data, color, opacity = 0.9, width = 7, layerId = 'route') {
    if (state.map.getLayer(layerId))   state.map.removeLayer(layerId);
    if (state.map.getSource(layerId))  state.map.removeSource(layerId);
    state.map.addSource(layerId, { type: 'geojson', data });
    state.map.addLayer({
        id: layerId, type: 'line', source: layerId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint:  { 'line-color': color, 'line-width': width, 'line-opacity': opacity }
    });
}

function fitToFeatures(data) {
    const bounds = new maplibregl.LngLatBounds();
    data.features.forEach(f => {
        if (f.geometry?.coordinates) f.geometry.coordinates.forEach(c => bounds.extend(c));
    });
    state.map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 1500 });
}

// ============================================================================
// SECTION 14: RESTORE FUNCTIONS (after map style switch)
// ============================================================================

function restoreRouteLayers() {
    if (!Array.isArray(state.currentRouteData)) return;
    state.currentRouteData.forEach((route, i) => {
        addRouteLayer(route, ROUTE_COLORS[i] || '#5e8bbe', i === 0 ? 0.9 : 0.6, i === 0 ? 7 : 5, `route-${i}`);
    });
}

function restoreTSPRoute() {
    if (!state.lastTSPRouteData) return;
    const { segments, waypoint_order } = state.lastTSPRouteData;

    for (let i = 0; i < 50; i++) {
        const id = `tsp-segment-${i}`;
        if (state.map.getLayer(id))   state.map.removeLayer(id);
        if (state.map.getSource(id))  state.map.removeSource(id);
    }

    if (!state.map.isStyleLoaded()) {
        state.map.once('styledata', () => restoreTSPRoute());
        return;
    }

    drawTSPSegments(segments, waypoint_order);
    // NOTE: TSP markers are DOM elements — they survive style switches automatically.
    // Do NOT call addTo(state.map) again here.
}

/**
 * BUG FIX #4: After a style switch, only rebuild the ROUTE LAYERS.
 * Do NOT call displayFacilityResults() — it would call addTo(state.map) on
 * all the markers again, creating invisible duplicate markers that can never
 * be removed by clearFacilityData().
 *
 * MapLibre Marker objects are attached to the map's container <div>, not to
 * the style, so they survive style switches without any intervention.
 */
function restoreFacilityData() {
    if (!state.lastFacilityData || !state.markers.facility) return;
    const facilityType = document.getElementById('facility-type-select')?.value || 'hospital';
    removeFacilityLayers();                                        // Remove old lines
    rebuildFacilityRouteLayers(state.lastFacilityData, facilityType); // Add fresh lines
}

function restoreServiceArea() {
    if (!state.lastServiceData || !state.markers.service) return;
    rebuildServiceAreaLayers(state.lastServiceData);
}

// ============================================================================
// SECTION 15: CLEANUP FUNCTIONS
// ============================================================================

function clearRouteLayers() {
    for (let i = 0; i < 20; i++) {
        const id = `route-${i}`;
        if (state.map.getLayer(id))  state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    }
    if (state.map.getLayer('route'))  state.map.removeLayer('route');
    if (state.map.getSource('route')) state.map.removeSource('route');
    state.currentRouteData = null;
}

function clearTSPLayers() {
    for (let i = 0; i < 50; i++) {
        const id = `tsp-segment-${i}`;
        if (state.map.getLayer(id))  state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    }
    state.lastTSPRouteData = null;
}

function clearFacilityData() {
    if (state.markers.facility) { state.markers.facility.remove(); state.markers.facility = null; }
    removeFacilityMarkers();
    removeFacilityLayers();
    state.lastFacilityData = null;
}

function clearServiceArea() {
    if (!state.map) return;
    // Remove layers BEFORE sources (MapLibre enforces this order)
    ['service-border', 'service-hull', 'service-network'].forEach(id => {
        if (state.map.getLayer(id)) state.map.removeLayer(id);
    });
    ['service-hull', 'service-network'].forEach(id => {
        if (state.map.getSource(id)) state.map.removeSource(id);
    });
}

function clearHighlight() {
    currentHighlightIds.forEach(id => {
        if (state.map?.getLayer(id))  state.map.removeLayer(id);
        if (state.map?.getSource(id)) state.map.removeSource(id);
    });
    currentHighlightIds = [];
    if (currentPopup) { currentPopup.remove(); currentPopup = null; }
    document.querySelectorAll('.result-item').forEach(el => el.classList.remove('active'));
}

/**
 * Master cleanup — clears every layer, marker, and saved state.
 *
 * BUG FIX #5: TSP markers are stored as { marker, lngLat, color }.
 * The original code called item.remove() — but Marker objects don't have
 * a .remove() method directly on the wrapper object, only on the .marker property.
 * Fixed to item.marker?.remove().
 */
function clearAll() {
    clearRouteLayers();
    clearTSPLayers();
    clearFacilityData();
    clearServiceArea();
    clearHighlight();
    clearFeatureHighlight();

    Object.keys(state.markers).forEach(key => {
        if (key === 'tsp') {
            state.markers.tsp.forEach(item => item.marker?.remove()); // BUG FIX #5
            state.markers.tsp = [];
        } else if (state.markers[key]) {
            state.markers[key].remove();
            state.markers[key] = null;
        }
    });

    state.currentRouteData = null;
    state.lastTSPRouteData  = null;
    state.lastFacilityData  = null;
    state.lastServiceData   = null;

    showInfo('Click to start');
}

// ============================================================================
// SECTION 16: SEARCH FUNCTIONALITY (Elasticsearch)
// ============================================================================

async function searchUnits() {
    const queryText  = document.getElementById('searchInput').value.trim();
    const resultsDiv = document.getElementById('results');

    if (!queryText) {
        resultsDiv.innerHTML = '<div class="no-results">Please enter a search term</div>';
        return;
    }

    resultsDiv.innerHTML = '<div class="loading">Searching...</div>';
    clearHighlight();

    const index  = currentDataset === 'units' ? 'building_units' : 'buildings_vertical';
    const fields = currentDataset === 'units'
        ? ['UNIT_ID', 'NAME^2', 'NAME_LONG', 'UnitAddres', 'LabelNames']
        : ['UnitAddress^3', 'ShortAddress^1.8', 'fkFloorID^1.5', 'FloorUsage'];

    const esQuery = {
        query: { multi_match: { query: queryText, fields, type: 'best_fields', fuzziness: 'AUTO' } },
        size: 20
    };

    try {
        const response = await fetch(`${ES_URL}/${index}/_search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(esQuery)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        resultsDiv.innerHTML = '';

        if (data.hits.hits.length === 0) {
            resultsDiv.innerHTML = '<div class="no-results">No results found.</div>';
            return;
        }

        data.hits.hits.forEach(hit => {
            const doc  = hit._source;
            const item = document.createElement('div');
            item.className = 'result-item';

            if (currentDataset === 'units') {
                item.innerHTML = `
                    <strong>${doc.UNIT_ID || 'N/A'}</strong><br>
                    ${doc.LabelNames || 'Unnamed'} (${doc.UnitAddres || 'No address'})<br>
                    <small>Floor Height: ${doc.Base !== undefined ? doc.Base.toFixed(2) + 'm' : 'N/A'} | Type: ${doc.USE_TYPE || 'N/A'}</small>
                `;
            } else {
                item.innerHTML = `
                    <strong>${doc.UnitAddress || doc.fkFloorID || '—'}</strong><br>
                    Floor ${doc.FloorNumber ?? '—'} – ${doc.FloorUsage || '—'}<br>
                    <small>Address: ${doc.UnitAddress || doc.ShortAddress || 'No address'} | Building: ${doc.BuildingHeight ? doc.BuildingHeight.toFixed(1) + 'm' : '—'}</small>
                `;
            }

            item.onclick = () => zoomToFeature(doc, item);
            resultsDiv.appendChild(item);
        });

    } catch (err) {
        console.error('Search error:', err);
        resultsDiv.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    }
}

function getPopupAnchorPosition(bounds) {
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    return [
        ne.lng + (ne.lng - sw.lng) * 0.3,
        sw.lat + (ne.lat - sw.lat) * 0.65
    ];
}

async function zoomToFeature(feature, clickedElement) {
    if (!state.map) return;

    clearHighlight();
    clickedElement.classList.add('active');

    if (!feature.geometry) { alert('No geometry available.'); return; }

    const bounds = new maplibregl.LngLatBounds();
    const flattenCoords = (arr) => {
        if (typeof arr[0] === 'number') bounds.extend([arr[0], arr[1]]);
        else arr.forEach(flattenCoords);
    };
    flattenCoords(feature.geometry.coordinates);
    if (bounds.isEmpty()) { alert('No valid geometry found.'); return; }

    const popupPosition = getPopupAnchorPosition(bounds);

    let popupHTML = `<div style="max-width:280px;font-size:14px;line-height:1.6;">
        <strong style="font-size:16px;color:#1f2937;">${feature.NAME || feature.FloorUsage || feature.UnitAddress || 'Feature'}</strong><br>`;

    if (currentDataset === 'units') {
        popupHTML += `
            <strong>Unit ID:</strong> ${feature.UNIT_ID || '—'}<br>
            <strong>Address:</strong> ${feature.UnitAddres || 'N/A'}<br>
            <strong>Floor:</strong> ${feature.Base !== undefined ? feature.Base.toFixed(2) + 'm' : 'N/A'}<br>
            <strong>Height:</strong> ${feature.HEIGHT !== undefined ? feature.HEIGHT.toFixed(2) + 'm' : 'N/A'}<br>
            <strong>Type:</strong> ${feature.USE_TYPE || 'N/A'}`;
    } else {
        popupHTML += `
            <strong>ID:</strong> ${feature.fkFloorID || feature.UnitAddress || '—'}<br>
            <strong>Address:</strong> ${feature.UnitAddress || feature.ShortAddress || 'N/A'}<br>
            <strong>Floor:</strong> ${feature.FloorNumber ?? '—'}<br>
            <strong>Usage:</strong> ${feature.FloorUsage || '—'}<br>
            <strong>Total Floors:</strong> ${feature.NoofFloors || '—'}<br>
            <strong>Building Height:</strong> ${feature.BuildingHeight ? feature.BuildingHeight.toFixed(1) + 'm' : '—'}`;
    }
    popupHTML += '</div>';

    const afterStyleLoad = () => addHighlightAndAnimate(feature, bounds, popupPosition, popupHTML);

    if (currentStyleId !== 'bdf-style') {
        const bdfStyle = STYLES.find(s => s.id === 'bdf-style');
        state.map.setStyle(bdfStyle.url);
        currentStyleId = 'bdf-style';
        state.map.once('idle', afterStyleLoad);
    } else {
        afterStyleLoad();
    }
}

function addHighlightAndAnimate(feature, bounds, popupPosition, popupHTML) {
    const layers   = state.map.getStyle().layers || [];
    const beforeId = layers.length > 0 ? layers[layers.length - 1].id : undefined;

    const safeId = (feature.UNIT_ID || feature.fkFloorID || feature.UnitAddress || 'feat')
        .replace(/[^a-z0-9]/gi, '-');
    const id = `highlight-${safeId}`;
    currentHighlightIds.push(id);

    state.map.addSource(id, { type: 'geojson', data: { type: 'Feature', geometry: feature.geometry, properties: { ...feature } } });

    let extrusionBase, extrusionHeight;
    if (currentDataset === 'units') {
        extrusionBase   = feature.Base || 0;
        extrusionHeight = extrusionBase + (feature.HEIGHT || 4.25);
    } else {
        const floorH    = (feature.BuildingHeight || 0) / (feature.NoofFloors || 1);
        extrusionBase   = floorH * (feature.FloorNumber || 0);
        extrusionHeight = extrusionBase + floorH;
    }

    state.map.addLayer({
        id, type: 'fill-extrusion', source: id,
        paint: {
            'fill-extrusion-color':   '#ff5c00',
            'fill-extrusion-opacity': 0.95,
            'fill-extrusion-height':  ['+', extrusionHeight, 1],
            'fill-extrusion-base':    extrusionBase
        }
    }, beforeId);

    state.map.fitBounds(bounds, {
        padding: { top: 100, bottom: 100, left: 420, right: 100 },
        pitch: 60, bearing: -18, minZoom: 16, maxZoom: 19.5, duration: 1600, essential: true
    });

    setTimeout(() => {
        currentPopup = new maplibregl.Popup({ offset: [15, 0], closeButton: true, className: 'unit-popup', maxWidth: '300px', anchor: 'left' })
            .setLngLat(popupPosition)
            .setHTML(popupHTML)
            .addTo(state.map);
        currentPopup.on('close', () => { currentPopup = null; });
    }, 800);
}

// ============================================================================
// SECTION 17: INITIALIZATION
// ============================================================================

window.addEventListener('load', initMap);

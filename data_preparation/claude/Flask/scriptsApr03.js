// ============================================================================
// ROUTING & SERVICES ANALYSIS APPLICATION
// ============================================================================
// This file controls everything on the map:
//   - Route planning (A→B and multi-point TSP optimization)
//   - Nearest facility finding (hospitals, fire stations, police, clinics)
//   - Service area calculation (what area can you reach in X minutes?)
//   - Building/unit search with 3D visualization
//   - Feature inspection tool (click any map feature to see its data)
// ============================================================================


// ============================================================================
// SECTION 1: CONFIGURATION & CONSTANTS
// ============================================================================
// Think of this section as the "settings panel" for the whole application.
// If you want to change how something looks or where it connects to, edit here.

// --- Map Style Definitions ---
// Each style is a different way of looking at the map.
// pitch  = how much the map tilts (0 = flat top-down, 60 = tilted like a 3D view)
// zoom   = how close/far the initial camera is
// bearing = compass rotation (0 = north up, 45 = rotated 45 degrees clockwise)
const STYLES = [
    { id: 'basic-style', name: 'Default',   url: 'http://localhost:3001/styles/martin/style.json',     pitch: 0,  zoom: 12, bearing: 0   },
    { id: 'sat-style',   name: 'Satellite', url: 'http://localhost:3001/styles/martin/style_sat.json',  pitch: 0,  zoom: 12, bearing: 0   },
    { id: '3d-style',    name: '3D',        url: 'http://localhost:3001/styles/martin/style_3d.json',   pitch: 45, zoom: 14, bearing: 0   },
    { id: 'bdf-style',   name: 'BDF',       url: 'http://localhost:3001/styles/martin/style_bdf.json',  pitch: 60, zoom: 17, bearing: -20 }
];

// --- Backend API Configuration ---
// These are the URLs our app sends requests to for route calculations, etc.
// "localhost" means the server is running on your own computer.
const BACKEND_URL = 'http://localhost:5000';
const API_ENDPOINTS = {
    route:           `${BACKEND_URL}/route`,             // Calculate A→B route
    tsp:             `${BACKEND_URL}/route/tsp`,          // Solve multi-point optimal route
    nearestFacility: `${BACKEND_URL}/nearest_facility`,   // Find nearby hospitals/police/etc.
    serviceArea:     `${BACKEND_URL}/service_area`        // Find reachable area in X minutes
};

// --- Elasticsearch Configuration ---
// Elasticsearch is a search engine used to find buildings and floors by name/address.
const ES_URL = 'http://localhost:9200';

// --- Map Default Settings ---
// Riyadh coordinates: [longitude, latitude]
// Longitude = east-west position, Latitude = north-south position
const DEFAULT_CENTER = [46.6167, 24.8258];
const DEFAULT_ZOOM   = 12;
const REQUEST_TIMEOUT = 65000; // How many milliseconds to wait before giving up on an API call (65 seconds)

// --- Facility Display Configuration ---
// Colors and emoji icons used for each type of facility on the map.
// These control how facility markers look when you search for nearby places.
const FACILITY_COLORS = {
    'hospital':     '#ef4444', // Red
    'fire station': '#f97316', // Orange
    'police':       '#8b5cf6', // Purple
    'clinic':       '#10b981'  // Green
};
const FACILITY_ICONS = {
    'hospital':     '🏥',
    'fire station': '🚒',
    'police':       '👮',
    'clinic':       '⚕️'
};

// --- UI Control Limits ---
// These set the maximum values on the sliders in the sidebar.
const MAX_FACILITY_COUNT    = 20;  // Max number of facilities to show
const MAX_SERVICE_MINUTES   = 20;  // Max minutes for service area calculation
const MAX_SEARCH_DISTANCE_KM = 30; // Max kilometers for facility search radius

// --- TSP Color Palette ---
// Each waypoint in TSP mode gets a unique color from this list.
// The route SEGMENT from point N to point N+1 uses the SAME color as point N.
// This makes it visually clear which road belongs to which leg of the journey.
// Colors cycle back to the start if you add more points than there are colors.
const TSP_COLORS = [
    '#3b82f6', // Blue        → Point 1 marker + route from 1 to 2
    '#ef4444', // Red         → Point 2 marker + route from 2 to 3
    '#10b981', // Green       → Point 3 marker + route from 3 to 4
    '#f59e0b', // Amber       → Point 4 marker + route from 4 to 5
    '#8b5cf6', // Purple      → Point 5 marker + route from 5 to 6
    '#ec4899', // Pink        → Point 6 marker + route from 6 to 7
    '#14b8a6', // Teal        → Point 7 marker + route from 7 to 8
    '#f97316', // Orange      → Point 8 marker + route from 8 to 9
    '#6366f1', // Indigo      → Point 9 marker + route from 9 to 10
    '#84cc16', // Lime        → Point 10 marker + route from 10 to 11
];


// ============================================================================
// SECTION 2: APPLICATION STATE
// ============================================================================
// "State" = the current memory of everything happening in the app right now.
// Whenever something changes (user clicks, mode switches, etc.) we update
// the relevant property in this object so the rest of the app knows about it.

const state = {
    // --- Core Map ---
    map:            null,           // The MapLibre map object (created in initMap)
    currentMode:    'route',        // Which tool is active: 'route', 'tsp', 'facility', or 'service'
    currentCenter:  DEFAULT_CENTER, // Where the map is currently centered [lng, lat]
    currentZoom:    DEFAULT_ZOOM,   // Current zoom level
    currentPitch:   0,              // Camera tilt angle
    currentBearing: 0,              // Compass direction

    // --- Markers ---
    // Markers are the pins/icons placed on the map by the user clicking.
    markers: {
        start:    null,  // Green "S" pin for the start of an A→B route
        end:      null,  // Red "E" pin for the end of an A→B route
        service:  null,  // Blue truck icon for service area center
        facility: null,  // Red pin for facility search location
        tsp:      []     // Array of { marker, lngLat, color } objects for TSP waypoints
    },

    // --- Facility Markers ---
    // Separate array for the result markers (hospitals, police, etc.) shown after a search.
    // We keep these separate so we can remove just the results without touching the search pin.
    facilityMarkers: [],

    // --- Route Data (stored so we can redraw after switching map styles) ---
    currentRouteData:  null, // Route(s) for the Route mode (A→B)
    lastTSPRouteData:  null, // Route data for TSP mode
    lastFacilityData:  null, // Full API response from the nearest facility search
    lastServiceData:   null, // Full API response from the service area calculation

    // --- User Settings ---
    serviceMinutes:      5,          // Minutes for service area
    facilityCount:       5,          // How many facilities to find
    searchDistanceKm:    10,         // Search radius in km
    routeOptimization:   'fastest',  // 'fastest' or 'shortest'
    showAlternatives:    true,       // Show alternative routes?

    // --- Info Pointer Tool ---
    infoPointerActive:       false, // Is the "click to inspect feature" mode on?
    highlightedFeatureId:    null,  // ID of the feature currently highlighted
    highlightedSourceLayer:  null,  // Which map layer the highlighted feature belongs to

    // --- Draggable Panel ---
    isDragging:    false,           // Is the user currently dragging the info panel?
    dragOffset:    { x: 0, y: 0 }, // Mouse position offset when drag started
    panelPosition: null             // Last saved position of the info panel
};

// --- Module-Level Variables ---
// These live outside `state` because they're used by specific features
// and don't need to be part of the global state object.
let currentDataset    = 'units';       // Which Elasticsearch index to search: 'units' or 'floors'
let currentStyleId    = 'basic-style'; // Which map style is currently active
let currentHighlightIds = [];          // Layer IDs for 3D search highlights (so we can remove them)
let currentPopup      = null;          // The currently open map popup (so we can close it later)


// ============================================================================
// SECTION 3: MAP INITIALIZATION
// ============================================================================
// This function runs once when the page loads and sets everything up.

/**
 * Create the map and attach all the controls and event listeners.
 * This is the entry point — everything else flows from here.
 */
function initMap() {
    // Create the MapLibre map inside the HTML element with id="map"
    state.map = new maplibregl.Map({
        container:  'map',
        style:      STYLES[0].url,       // Start with the Default style
        center:     state.currentCenter,
        zoom:       state.currentZoom,
        pitch:      state.currentPitch,
        bearing:    state.currentBearing,
        maxPitch:   85                   // Maximum tilt angle allowed
    });

    // Whenever the user pans/zooms/tilts, save the new camera position to state.
    // This is important so we can restore the same view when switching map styles.
    state.map.on('moveend', () => {
        state.currentCenter  = state.map.getCenter().toArray();
        state.currentZoom    = state.map.getZoom();
        state.currentPitch   = state.map.getPitch();
        state.currentBearing = state.map.getBearing();
    });

    // Add the built-in zoom buttons and compass control (top-right corner)
    state.map.addControl(new maplibregl.NavigationControl(), 'top-right');

    // Add our custom layer switcher buttons (Default / Satellite / 3D / BDF)
    state.map.addControl(createLayerSwitcher(), 'bottom-right');

    // Set up the sliders (max values, initial display values)
    initializeSliders();

    // Attach click/change listeners to all sidebar buttons and inputs
    setupEventHandlers();

    // When the map finishes loading its initial tiles and style:
    state.map.on('load', () => {
        showInfo('Click anywhere to begin');

        // Create the invisible highlight layers used by the info pointer tool
        setupInfoPointerLayers();

        // Inject the info-pointer button and panel-toggle button into the map UI
        injectMapButtons();
    });

    // When the map style changes (user switches Default → Satellite etc.),
    // re-create the info pointer layers because they get wiped out by style changes.
    state.map.on('styledata', () => {
        if (state.infoPointerActive) {
            setupInfoPointerLayers();
        }
    });
}


// ============================================================================
// SECTION 4: MAP CONTROLS
// ============================================================================
// Custom buttons and controls that appear on the map itself.

/**
 * Build the layer-switcher control (Default / Satellite / 3D / BDF buttons).
 * MapLibre requires controls to be objects with onAdd() and onRemove() methods.
 */
function createLayerSwitcher() {
    class LayerSwitcher {
        onAdd(map) {
            this.map = map;

            // Create a white vertical button group in the bottom-right
            this.container = document.createElement('div');
            this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group flex flex-col bg-white';

            // Create one button per style
            STYLES.forEach(style => {
                const btn = document.createElement('button');
                btn.type      = 'button';
                btn.className = 'px-4 py-3 text-sm font-medium hover:bg-blue-50 border-b border-gray-200 transition';
                // Use short labels (single letter, or '3D' / 'BDF')
                btn.textContent = style.name === '3D' ? '3D'
                                : style.name === 'BDF' ? 'BDF'
                                : style.name.charAt(0);
                btn.onclick = () => switchMapStyle(style);
                this.container.appendChild(btn);
            });

            return this.container;
        }
        onRemove() {
            this.container.parentNode?.removeChild(this.container);
        }
    }
    return new LayerSwitcher();
}

/**
 * Switch to a different map style while keeping all markers and layers intact.
 * When you change a style in MapLibre, it wipes all custom layers — so we need
 * to wait for the new style to fully load, then redraw everything.
 *
 * @param {Object} style - One of the objects from the STYLES array
 */
async function switchMapStyle(style) {
    currentStyleId = style.id;

    // Save the current camera so we can restore it after the style loads
    const center  = state.map.getCenter();
    const zoom    = style.zoom    ?? state.map.getZoom();
    const pitch   = style.pitch   ?? state.map.getPitch();
    const bearing = style.bearing ?? state.map.getBearing();

    // Tell MapLibre to load the new style (this wipes all custom layers)
    state.map.setStyle(style.url);

    // Wait until the new style is fully loaded, then restore everything
    state.map.once('idle', () => {
        // Restore camera position
        state.map.jumpTo({ center, zoom, pitch, bearing });

        // Rebuild info pointer highlight layers if the tool was active
        if (state.infoPointerActive) {
            setupInfoPointerLayers();
        }

        // Redraw data layers that belong to the current mode
        switch (state.currentMode) {
            case 'route':    restoreRouteLayers();    break;
            case 'tsp':      restoreTSPRoute();       break;
            case 'facility': restoreFacilityData();   break;
            case 'service':  restoreServiceArea();    break;
        }
    });
}

// --- Restore functions ---
// Each function redraws one mode's data after a style switch.
// They read from the saved state (currentRouteData, lastFacilityData, etc.)
// so no new API calls are needed.

/** Redraw A→B route(s) after a style switch */
function restoreRouteLayers() {
    if (!Array.isArray(state.currentRouteData)) return;
    state.currentRouteData.forEach((route, i) => {
        addRouteLayer(route, getRouteColor(i), i === 0 ? 0.9 : 0.6, i === 0 ? 7 : 5, `route-${i}`);
    });
}

/**
 * Redraw TSP route + re-add all waypoint markers after a style switch.
 * Each marker uses the same color it had originally (stored in state.markers.tsp).
 */
function restoreTSPRoute() {
    if (!state.lastTSPRouteData) return;

    // Re-draw each colored route segment
    // state.lastTSPRouteData is an array: one FeatureCollection per segment
    state.lastTSPRouteData.forEach((segmentData, i) => {
        const color = TSP_COLORS[i % TSP_COLORS.length];
        addRouteLayer(segmentData, color, 0.9, 6, `tsp-segment-${i}`);
    });

    // Re-add the numbered markers (they disappear when the style is swapped)
    state.markers.tsp.forEach((item, index) => {
        // Remove the old marker object (it's been detached from the map by the style change)
        if (item.marker) item.marker.remove();

        // Create a fresh marker with the same position and color
        item.marker = new maplibregl.Marker({
            element: createMarker((index + 1).toString(), item.color)
        })
            .setLngLat(item.lngLat)
            .addTo(state.map);
    });
}

/**
 * Redraw facility results (routes + markers) after a style switch.
 * BUG FIX: We now explicitly remove any existing facility layers before redrawing.
 * Previously, the old layers were still present after a style switch, causing
 * a "Source already exists" crash.
 */
function restoreFacilityData() {
    if (!state.lastFacilityData || !state.markers.facility) return;

    const facilityType = document.getElementById('facility-type-select')?.value || 'hospital';

    // Remove any leftover facility layers before we add new ones
    removeFacilityLayers();

    // Re-add the search-location marker (the red pin the user clicked)
    state.markers.facility.addTo(state.map);

    // Re-draw all facility result markers and their route lines
    displayFacilityResults(
        state.markers.facility.getLngLat(),
        state.lastFacilityData,
        facilityType
    );
}

/** Redraw service area polygon + road network after a style switch */
function restoreServiceArea() {
    if (!state.lastServiceData || !state.markers.service) return;
    rebuildServiceAreaLayers(state.lastServiceData);
}

/**
 * Helper: remove facility route layers from the map without touching markers.
 * Called before re-adding layers to prevent "Source already exists" errors.
 */
function removeFacilityLayers() {
    ['facility-routes'].forEach(id => {
        if (state.map.getLayer(id))  state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    });
}

/**
 * Inject the info-pointer button (ℹ️) and panel-toggle button (◀) into the
 * top-right map control area. These can't be added via addControl() because
 * they need to share a group with the existing navigation buttons.
 */
function injectMapButtons() {
    const topRight = document.querySelector('.maplibregl-ctrl-top-right');
    if (!topRight) return;

    // Create a MapLibre-style control group container
    const ctrlGroup = document.createElement('div');
    ctrlGroup.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    ctrlGroup.id        = 'custom-map-controls';

    // --- Info Pointer Button ---
    const infoBtn   = document.createElement('button');
    infoBtn.className = 'info-pointer-btn';
    infoBtn.type      = 'button';
    infoBtn.innerHTML = 'ℹ️';
    infoBtn.title     = 'Toggle Info Pointer';
    infoBtn.addEventListener('click', () => toggleInfoPointer());

    // --- Panel Toggle Button (hides/shows the sidebar) ---
    const panelBtn   = document.createElement('button');
    panelBtn.className = 'panel-toggle-btn';
    panelBtn.type      = 'button';
    panelBtn.innerHTML = '◀';
    panelBtn.title     = 'Hide Control Panel';
    panelBtn.addEventListener('click', () => toggleControlPanel(panelBtn));

    ctrlGroup.appendChild(infoBtn);
    ctrlGroup.appendChild(panelBtn);
    topRight.appendChild(ctrlGroup);
}

/**
 * Show or hide the left sidebar panel.
 * When minimized, clicking anywhere on the panel header expands it again.
 *
 * @param {HTMLElement} btn - The toggle button (◀ / ▶)
 */
function toggleControlPanel(btn) {
    const panel = document.querySelector('.control-panel.header');
    if (!panel) return;

    const isMinimised = panel.classList.toggle('panel-minimised');

    // Update button arrow direction and tooltip
    btn.classList.toggle('active', isMinimised);
    btn.innerHTML = isMinimised ? '▶' : '◀';
    btn.title     = isMinimised ? 'Show Control Panel' : 'Hide Control Panel';

    if (isMinimised) {
        // When minimized: store the expand handler so we can remove it later
        panel._expandHandler = () => toggleControlPanel(btn);
        panel.addEventListener('click', panel._expandHandler);
    } else {
        // When expanded: remove the expand-on-click handler
        if (panel._expandHandler) {
            panel.removeEventListener('click', panel._expandHandler);
            delete panel._expandHandler;
        }
    }
}


// ============================================================================
// SECTION 5: INFO POINTER FEATURE
// ============================================================================
// When active, clicking any feature on the map shows its raw data properties
// in a floating panel. Useful for inspecting building attributes, road types, etc.

/**
 * Turn the info pointer mode on or off.
 * When ON:  the cursor changes, and clicking the map shows feature data.
 * When OFF: clicking the map places markers as normal.
 */
function toggleInfoPointer() {
    state.infoPointerActive = !state.infoPointerActive;

    const btn          = document.querySelector('.info-pointer-btn');
    const mapContainer = document.getElementById('map');
    const featurePanel = document.getElementById('feature-info-panel');

    if (state.infoPointerActive) {
        btn.classList.add('active');
        mapContainer.classList.add('info-pointer-active'); // CSS changes cursor to crosshair
        featurePanel.classList.remove('hidden');
        resetPanelPosition();    // Move the info panel back to the top-right corner
        setupDraggablePanel();   // Allow the user to drag the info panel around
        clearFeatureHighlight(); // Remove any old highlight from the map
        updateFeatureInfo({ html: '<p class="info-hint">Click on any feature to see its details</p>' });
    } else {
        btn.classList.remove('active');
        mapContainer.classList.remove('info-pointer-active');
        featurePanel.classList.add('hidden');
        clearFeatureHighlight();
    }
}

/**
 * Create the hidden highlight layers that are used to visually mark
 * the feature the user clicked on.
 * There are three layers (fill, line, circle) to handle all geometry types.
 */
function setupInfoPointerLayers() {
    // If the style hasn't loaded yet, wait for it
    if (!state.map.isStyleLoaded()) {
        state.map.once('styledata', setupInfoPointerLayers);
        return;
    }

    // Add the data source that will hold the highlighted feature's GeoJSON
    if (!state.map.getSource('feature-highlight')) {
        state.map.addSource('feature-highlight', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] } // Empty at first
        });
    }

    // Define the three highlight layers (one per geometry type)
    const highlightLayers = [
        {
            id:     'feature-highlight-fill',
            type:   'fill',
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint:  { 'fill-color': '#3b82f6', 'fill-opacity': 0.3 }
        },
        {
            id:     'feature-highlight-line',
            type:   'line',
            filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'Polygon']],
            paint:  { 'line-color': '#3b82f6', 'line-width': 3, 'line-opacity': 0.8 }
        },
        {
            id:     'feature-highlight-point',
            type:   'circle',
            filter: ['==', ['geometry-type'], 'Point'],
            paint:  { 'circle-radius': 8, 'circle-color': '#3b82f6', 'circle-opacity': 0.6, 'circle-stroke-width': 2, 'circle-stroke-color': '#1e40af' }
        }
    ];

    highlightLayers.forEach(layer => {
        if (!state.map.getLayer(layer.id)) {
            state.map.addLayer({ ...layer, source: 'feature-highlight' });
        }
    });
}

/**
 * Handle a map click while the info pointer is active.
 * Finds whatever feature is at the clicked pixel and displays its properties.
 *
 * @param {Object} e - The MapLibre click event (contains e.point = pixel coords)
 */
function handleInfoPointerClick(e) {
    // Do nothing if the user is dragging the panel (not actually clicking the map)
    if (!state.infoPointerActive || state.isDragging) return;

    // Ask MapLibre for all features rendered at this pixel
    const features = state.map.queryRenderedFeatures(e.point);

    if (!features || features.length === 0) {
        clearFeatureHighlight();
        updateFeatureInfo({ html: '<p class="info-hint">No features found at this location</p>' });
        return;
    }

    // Filter out our own layers (route lines, facility markers, etc.)
    // We only want to inspect the BASE MAP features.
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

    // The first feature in the list is the topmost one the user likely intended to click
    const feature = validFeatures[0];
    highlightFeature(feature);
    displayFeatureInfo(feature);
}

/**
 * Update the highlight source to contain just the clicked feature,
 * which causes the blue highlight to appear on the map.
 *
 * @param {Object} feature - A GeoJSON feature from queryRenderedFeatures()
 */
function highlightFeature(feature) {
    clearFeatureHighlight(); // Remove previous highlight first

    state.highlightedFeatureId   = feature.id;
    state.highlightedSourceLayer = feature.sourceLayer;

    const src = state.map.getSource('feature-highlight');
    if (src) {
        src.setData({ type: 'FeatureCollection', features: [feature] });
    }
}

/**
 * Build and display the HTML table of a feature's properties in the info panel.
 *
 * @param {Object} feature - A GeoJSON feature
 */
function displayFeatureInfo(feature) {
    const properties = feature.properties || {};
    const layer      = feature.layer.id;
    const sourceLayer = feature.sourceLayer || 'N/A';
    const geomType   = feature.geometry.type;

    // Header: show which layer this feature belongs to
    let html = `
        <div class="feature-layer-info">
            <p><strong>Layer:</strong> ${layer}</p>
            <p><strong>Source Layer:</strong> ${sourceLayer}</p>
            <p><strong>Geometry:</strong> ${geomType}</p>
        </div>
    `;

    if (Object.keys(properties).length > 0) {
        html += '<div class="feature-properties">';

        // Sort keys alphabetically so the list is easy to read
        Object.keys(properties).sort().forEach(key => {
            const val = properties[key];
            if (val === null || val === undefined) return; // Skip empty values

            // Format numbers nicely, stringify objects (like nested JSON)
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

/**
 * Convert a raw property key like "building_height" or "buildingHeight"
 * into a readable label like "Building height".
 * Special case: ALL_CAPS keys (common in GIS data like "UNIT_ID") are
 * left mostly as-is instead of being split into single letters.
 *
 * @param {string} key - The raw key from GeoJSON properties
 * @returns {string} A human-friendly label
 */
function formatPropertyKey(key) {
    // If the key is ALL_CAPS (like UNIT_ID, USE_TYPE), just replace _ with space
    if (key === key.toUpperCase()) {
        return key.replace(/_/g, ' ').trim();
    }
    // Otherwise handle camelCase and snake_case
    return key
        .replace(/_/g, ' ')             // snake_case → words
        .replace(/([A-Z])/g, ' $1')     // camelCase → words
        .replace(/^./, s => s.toUpperCase()) // Capitalize first letter
        .trim();
}

/**
 * Update the HTML content inside the info panel.
 * @param {Object} options
 * @param {string} options.html - HTML string to display
 */
function updateFeatureInfo({ html }) {
    const content = document.getElementById('feature-info-content');
    if (content) content.innerHTML = html;
}

/**
 * Clear the blue highlight from the map by emptying the feature-highlight source.
 */
function clearFeatureHighlight() {
    state.highlightedFeatureId   = null;
    state.highlightedSourceLayer = null;

    const src = state.map.getSource('feature-highlight');
    if (src) {
        src.setData({ type: 'FeatureCollection', features: [] });
    }
}


// ============================================================================
// SECTION 6: DRAGGABLE PANEL
// ============================================================================
// Allows the user to click and drag the feature info panel to any position on screen.

/**
 * Attach mouse/touch drag handlers to the feature info panel's header bar.
 * The panel can then be repositioned by dragging.
 * 
 * NOTE: We store handler references on the panel itself so we can remove them
 * later if this function is called again, preventing stacked listeners.
 */
function setupDraggablePanel() {
    const panel  = document.getElementById('feature-info-panel');
    const header = document.querySelector('.feature-info-header');
    if (!panel || !header) return;

    // Remove any previously attached drag listeners to avoid stacking them
    if (panel._dragStart) {
        header.removeEventListener('mousedown',  panel._dragStart);
        header.removeEventListener('touchstart', panel._dragStart);
        document.removeEventListener('mousemove', panel._drag);
        document.removeEventListener('touchmove', panel._drag);
        document.removeEventListener('mouseup',   panel._dragEnd);
        document.removeEventListener('touchend',  panel._dragEnd);
    }

    let isDragging = false;
    let initialX = 0;
    let initialY = 0;

    // --- Start drag ---
    const dragStart = (e) => {
        if (e.target.closest('.close-btn')) return; // Don't drag if clicking close button

        const touch = e.touches?.[0] || e;
        const rect  = panel.getBoundingClientRect();

        // How far the mouse is from the panel's top-left corner when drag starts
        initialX = touch.clientX - rect.left;
        initialY = touch.clientY - rect.top;

        isDragging        = true;
        state.isDragging  = true;

        // Switch from CSS positioning to absolute so the panel follows the cursor
        panel.style.right    = 'auto';
        panel.style.left     = rect.left + 'px';
        panel.style.top      = rect.top  + 'px';
        panel.style.transform = 'none';
    };

    // --- During drag ---
    const drag = (e) => {
        if (!isDragging) return;
        e.preventDefault();

        const touch = e.touches?.[0] || e;

        // Calculate new position, clamped so the panel doesn't go off screen
        const newX = Math.max(0, Math.min(touch.clientX - initialX, window.innerWidth  - panel.offsetWidth));
        const newY = Math.max(0, Math.min(touch.clientY - initialY, window.innerHeight - panel.offsetHeight));

        panel.style.left = newX + 'px';
        panel.style.top  = newY + 'px';
    };

    // --- End drag ---
    const dragEnd = () => {
        isDragging       = false;
        state.isDragging = false;
    };

    // Attach listeners and save references for later cleanup
    header.addEventListener('mousedown',  dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup',   dragEnd);
    header.addEventListener('touchstart', dragStart, { passive: false });
    document.addEventListener('touchmove', drag,    { passive: false });
    document.addEventListener('touchend',  dragEnd);

    // Save references on the panel element for cleanup next time
    panel._dragStart = dragStart;
    panel._drag      = drag;
    panel._dragEnd   = dragEnd;
}

/**
 * Reset the info panel to its default position in the top-right corner.
 */
function resetPanelPosition() {
    const panel = document.getElementById('feature-info-panel');
    if (!panel) return;

    panel.style.left      = 'auto';
    panel.style.right     = '1rem';
    panel.style.top       = '1rem';
    panel.style.bottom    = 'auto';
    panel.style.transform = 'none';

    state.panelPosition = null;
}


// ============================================================================
// SECTION 7: UI INITIALIZATION & EVENT HANDLERS
// ============================================================================
// Set up the sidebar sliders and wire up all button click/change events.

/**
 * Set the maximum values on the three range sliders based on our constants.
 * This way, changing MAX_FACILITY_COUNT etc. at the top automatically
 * updates the slider limits.
 */
function initializeSliders() {
    const fc = document.getElementById('facility-count-input');
    if (fc) fc.max = MAX_FACILITY_COUNT;

    const ti = document.getElementById('time-input');
    if (ti) ti.max = MAX_SERVICE_MINUTES;

    const di = document.getElementById('distance-input');
    if (di) di.max = MAX_SEARCH_DISTANCE_KM;
}

/**
 * Attach event listeners to all interactive elements in the sidebar.
 * This is called once during map initialization.
 */
function setupEventHandlers() {
    // --- Map Click ---
    // Route all map clicks through a single handler that decides what to do
    // based on whether the info pointer is active and which mode is current.
    state.map.on('click', (e) => {
        if (state.infoPointerActive) {
            handleInfoPointerClick(e); // Show feature data
        } else {
            handleMapClick(e);         // Place markers / run tools
        }
    });

    // --- Feature Info Panel: Close Button ---
    document.getElementById('close-feature-info')?.addEventListener('click', () => {
        state.infoPointerActive = true; // Set to true so toggleInfoPointer() turns it OFF
        toggleInfoPointer();
    });

    // --- Mode Switcher Buttons ---
    document.getElementById('mode-route')?.addEventListener('click',    () => switchMode('route'));
    document.getElementById('mode-tsp')?.addEventListener('click',      () => switchMode('tsp'));
    document.getElementById('mode-facility')?.addEventListener('click', () => switchMode('facility'));
    document.getElementById('mode-service')?.addEventListener('click',  () => switchMode('service'));

    // --- Route Optimization (Fastest / Shortest) ---
    document.getElementById('opt-fastest')?.addEventListener('click', () => {
        state.routeOptimization = 'fastest';
        updateRouteOptButtons();
        // Recalculate immediately if both endpoints are already placed
        if (state.markers.start && state.markers.end) {
            calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
        }
    });
    document.getElementById('opt-shortest')?.addEventListener('click', () => {
        state.routeOptimization = 'shortest';
        updateRouteOptButtons();
        if (state.markers.start && state.markers.end) {
            calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
        }
    });

    // --- Show Alternatives Checkbox ---
    document.getElementById('show-alternatives')?.addEventListener('change', (e) => {
        state.showAlternatives = e.target.checked;
        if (state.markers.start && state.markers.end) {
            calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
        }
    });

    // --- Service Time Slider ---
    const timeInput = document.getElementById('time-input');
    const timeValue = document.getElementById('time-value');
    if (timeInput && timeValue) {
        timeValue.textContent = timeInput.value;
        timeInput.addEventListener('input', (e) => {
            state.serviceMinutes  = parseInt(e.target.value, 10);
            timeValue.textContent = state.serviceMinutes;
            if (state.markers.service) {
                calculateServiceArea(state.markers.service.getLngLat());
            }
        });
    }

    // --- Facility Count Slider ---
    const facilityCountInput = document.getElementById('facility-count-input');
    const facilityCountValue = document.getElementById('facility-count-value');
    if (facilityCountInput && facilityCountValue) {
        facilityCountValue.textContent = facilityCountInput.value;
        facilityCountInput.addEventListener('input', (e) => {
            state.facilityCount          = parseInt(e.target.value, 10);
            facilityCountValue.textContent = state.facilityCount;
            if (state.markers.facility) {
                calculateNearestFacilities(state.markers.facility.getLngLat());
            }
        });
    }

    // --- Search Distance Slider ---
    const distanceInput = document.getElementById('distance-input');
    const distanceValue = document.getElementById('distance-value');
    if (distanceInput && distanceValue) {
        distanceValue.textContent = distanceInput.value;
        distanceInput.addEventListener('input', (e) => {
            state.searchDistanceKm       = parseInt(e.target.value, 10);
            distanceValue.textContent    = state.searchDistanceKm;
            if (state.markers.facility) {
                calculateNearestFacilities(state.markers.facility.getLngLat());
            }
        });
    }

    // --- Search Panel: press Enter to search ---
    document.getElementById('searchInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchUnits();
    });

    // --- Search Panel: switch between units and floors dataset ---
    document.querySelectorAll('input[name="dataset"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            currentDataset = e.target.value;
            document.getElementById('results').innerHTML = '';
            clearHighlight();
        });
    });
}

/**
 * Highlight the active route optimization button (Fastest or Shortest).
 */
function updateRouteOptButtons() {
    document.querySelectorAll('.route-opt-btn').forEach(btn => btn.classList.remove('active'));
    const activeId = state.routeOptimization === 'fastest' ? 'opt-fastest' : 'opt-shortest';
    document.getElementById(activeId)?.classList.add('active');
}

/**
 * Dispatch a map click to the correct mode handler.
 * @param {Object} e - MapLibre click event
 */
function handleMapClick(e) {
    const handlers = {
        route:    handleRouteClick,
        tsp:      handleTSPClick,
        facility: handleFacilityClick,
        service:  handleServiceClick
    };

    const handler = handlers[state.currentMode];
    if (handler) {
        handler(e.lngLat);
    } else {
        console.warn(`Unknown mode: ${state.currentMode}`); // Help during development
    }
}


// ============================================================================
// SECTION 8: MODE SWITCHING
// ============================================================================

/**
 * Switch to a different tool mode (Route / TSP / Facility / Service).
 * Clears all current markers and layers, then updates the UI.
 *
 * @param {string} mode - 'route', 'tsp', 'facility', or 'service'
 */
function switchMode(mode) {
    clearAll();                   // Remove all existing markers and layers
    state.currentMode = mode;
    updateModeButtons(mode);
    updateModeInstructions(mode);

    // Turn off info pointer when switching modes (it would conflict)
    if (state.infoPointerActive) {
        toggleInfoPointer();
    }
}

/**
 * Update the highlighted (active) mode button in the sidebar.
 * @param {string} activeMode - The currently active mode
 */
function updateModeButtons(activeMode) {
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`mode-${activeMode}`)?.classList.add('active');
}

/**
 * Show/hide the mode-specific controls (sliders, dropdowns) and update
 * the instruction text that tells the user what to click next.
 *
 * @param {string} mode - The currently active mode
 */
function updateModeInstructions(mode) {
    // Show/hide relevant control sections
    document.getElementById('time-slider')?.classList.toggle('hidden',                  mode !== 'service');
    document.getElementById('facility-selector')?.classList.toggle('hidden',            mode !== 'facility');
    document.getElementById('facility-sliders-container')?.classList.toggle('hidden',   mode !== 'facility');
    document.getElementById('route-options')?.classList.toggle('hidden',                mode !== 'route');

    // Instructions per mode
    const instructions = {
        route:    { html: 'Click: <span class="highlight start">Start</span> → <span class="highlight end">End</span>', info: '🗺️ A→B Route mode active' },
        tsp:      { html: 'Click to add <span style="color:#8b5cf6;font-weight:bold">waypoints</span> (min 3)',         info: '🔄 TSP mode: Add at least 3 points' },
        facility: { html: 'Click a <span style="color:#ef4444;font-weight:bold">location</span> to find nearest facilities', info: '🏥 Nearest Facility mode active' },
        service:  { html: 'Click <span style="color:#ef4444;font-weight:bold">service location</span> + adjust time',  info: '🚚 Service Area mode active' }
    };

    const cfg = instructions[mode];
    if (cfg) {
        const instruction = document.getElementById('mode-instruction');
        if (instruction) instruction.innerHTML = cfg.html;
        showInfo(cfg.info);
    }
}


// ============================================================================
// SECTION 9: ROUTE MODE (A→B Routing)
// ============================================================================
// First click = green Start pin, second click = red End pin, route is calculated.
// Third click resets and starts over.

/**
 * Handle map clicks in Route mode.
 * @param {Object} lngLat - Clicked coordinates { lng, lat }
 */
function handleRouteClick(lngLat) {
    if (!state.markers.start) {
        // First click: place the green Start marker
        state.markers.start = new maplibregl.Marker({ element: createMarker('S', '#10b981') })
            .setLngLat(lngLat)
            .addTo(state.map);
        showInfo('✅ Start set. Click destination');

    } else if (!state.markers.end) {
        // Second click: place the red End marker and calculate the route
        state.markers.end = new maplibregl.Marker({ element: createMarker('E', '#ef4444') })
            .setLngLat(lngLat)
            .addTo(state.map);
        calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());

    } else {
        // Third click: reset everything so the user can start a new route
        clearAll();
        showInfo('🔄 Cleared. Click new start point');
    }
}

/**
 * Request a route from the backend API and draw it on the map.
 * @param {Object} start - { lng, lat } of the start point
 * @param {Object} end   - { lng, lat } of the end point
 */
async function calculateRoute(start, end) {
    clearRouteLayers();
    showInfo('⏳ Calculating routes...');

    try {
        const url  = `${API_ENDPOINTS.route}?start_lon=${start.lng}&start_lat=${start.lat}&end_lon=${end.lng}&end_lat=${end.lat}&alternatives=${state.showAlternatives ? 3 : 1}&optimization=${state.routeOptimization}`;
        const data = await fetchWithTimeout(url);

        if (data.error) throw new Error(data.error);

        // Normalize: API might return { routes: [...] } or a single FeatureCollection
        const routes = (data.routes && Array.isArray(data.routes)) ? data.routes : [data];
        state.currentRouteData = routes;

        // Draw each route (primary = darker/thicker, alternatives = lighter/thinner)
        routes.forEach((route, i) => {
            addRouteLayer(route, getRouteColor(i), i === 0 ? 0.9 : 0.6, i === 0 ? 7 : 5, `route-${i}`);
        });

        // Zoom map to fit all routes
        routes.length > 1 ? fitToMultipleRoutes(routes) : fitToFeatures(routes[0]);

        // Build summary text
        const best = routes[0];
        let summary = `✅ <strong>Best ${state.routeOptimization} route:</strong> ${best.duration_minutes} min • ${best.total_distance_km} km`;
        if (routes.length > 1) {
            summary += `<br><small>Showing ${routes.length} alternative routes</small>`;
            routes.slice(1).forEach((r, i) => {
                summary += `<br><small style="color:#60a5fa;">Route ${i + 2}: ${r.duration_minutes} min • ${r.total_distance_km} km</small>`;
            });
        }
        showInfo(summary);

    } catch (error) {
        handleError('Route calculation', error);
    }
}

/**
 * Get the color for a route by its index.
 * Route 0 (primary) is darkest; alternatives are progressively lighter.
 *
 * @param {number} index - 0 for primary, 1+ for alternatives
 * @returns {string} Hex color
 */
function getRouteColor(index) {
    const colors = ['#0865fc', '#4f9af7', '#6095d3'];
    return colors[index] || '#5e8bbe';
}

/**
 * Fit the map view to show all route lines in frame.
 * @param {Array} routes - Array of GeoJSON FeatureCollections
 */
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
// SECTION 10: TSP MODE (Multi-Point Optimization)
// ============================================================================
// Click to add numbered waypoints. Once you have at least 3 points,
// the app automatically calculates the most efficient route connecting them all.
// Each point and its outgoing route segment share the same unique color.

/**
 * Handle map clicks in TSP mode.
 * Each click adds a new colored waypoint. After the 3rd point,
 * a 2-second countdown starts and then the TSP route is calculated.
 *
 * @param {Object} lngLat - Clicked coordinates { lng, lat }
 */
function handleTSPClick(lngLat) {
    const num   = state.markers.tsp.length + 1;         // Waypoint number (1-based)
    const color = TSP_COLORS[(num - 1) % TSP_COLORS.length]; // Pick a color from the palette

    // Create a numbered marker in the waypoint's color
    const marker = new maplibregl.Marker({ element: createMarker(num.toString(), color) })
        .setLngLat(lngLat)
        .addTo(state.map);

    // Store the marker along with its color so we can re-use the color for the route segment
    state.markers.tsp.push({ marker, lngLat, color });

    if (state.markers.tsp.length < 3) {
        const remaining = 3 - state.markers.tsp.length;
        showInfo(`✅ Point ${num} added (${color.toUpperCase()}). Need ${remaining} more (min 3)`);
    } else {
        showInfo(`✅ Point ${num} added. Auto-calculating optimized route in 2 seconds...`);
        // Small delay so the user can keep clicking before calculation starts
        setTimeout(() => {
            if (state.markers.tsp.length >= 3) calculateTSP();
        }, 2000);
    }
}

/**
 * Request an optimized multi-point route from the backend.
 * The result is drawn as separate colored segments — segment from point N to N+1
 * uses the same color as point N's marker.
 */
async function calculateTSP() {
    if (state.markers.tsp.length < 3) {
        showInfo('❌ Need at least 3 points for TSP');
        return;
    }

    showInfo(`⏳ Solving TSP for ${state.markers.tsp.length} points...`);

    try {
        // Extract [lng, lat] pairs from all markers
        const points = state.markers.tsp.map(m => [m.lngLat.lng, m.lngLat.lat]);

        // Send to the TSP API — it returns one big optimized route and the order of waypoints
        const data = await fetchWithTimeout(API_ENDPOINTS.tsp, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ points })
        });

        if (data.error) throw new Error(data.error);

        // ---------------------------------------------------------------
        // COLOR INDIVIDUAL SEGMENTS
        // ---------------------------------------------------------------
        // The API returns a single combined route but also a `segments` array
        // where each entry is the sub-route between two consecutive waypoints.
        //
        // waypoint_order tells us the optimized visiting sequence, e.g. [0,2,1,3].
        // Segment 0 is the road from waypoint_order[0] → waypoint_order[1], etc.
        // We color each segment using the color of the ORIGIN waypoint in that leg.

        clearTSPLayers(); // Remove any previous TSP route layers

        const order = data.waypoint_order || points.map((_, i) => i); // Fallback: original order

        if (data.segments && Array.isArray(data.segments)) {
            // API provided separate segments — draw each one in its own color
            const segmentDataArray = [];

            data.segments.forEach((segment, segIndex) => {
                // The origin waypoint for this segment
                const originWaypointIndex = order[segIndex] ?? segIndex;
                const color = TSP_COLORS[originWaypointIndex % TSP_COLORS.length];

                addRouteLayer(segment, color, 0.9, 6, `tsp-segment-${segIndex}`);
                segmentDataArray.push(segment);
            });

            state.lastTSPRouteData = segmentDataArray; // Save for style-switch restoration

        } else {
            // API returned one combined route — split features into groups and color them
            // Each feature in the FeatureCollection is roughly one road segment;
            // we distribute them evenly across waypoint colors.
            const features  = data.features || [];
            const numLegs   = order.length - 1 || 1;
            const chunkSize = Math.ceil(features.length / numLegs);
            const segmentDataArray = [];

            for (let legIndex = 0; legIndex < numLegs; legIndex++) {
                const legFeatures = features.slice(legIndex * chunkSize, (legIndex + 1) * chunkSize);
                if (legFeatures.length === 0) continue;

                const originWaypointIndex = order[legIndex] ?? legIndex;
                const color  = TSP_COLORS[originWaypointIndex % TSP_COLORS.length];
                const legGeoJSON = { type: 'FeatureCollection', features: legFeatures };

                addRouteLayer(legGeoJSON, color, 0.9, 6, `tsp-segment-${legIndex}`);
                segmentDataArray.push(legGeoJSON);
            }

            state.lastTSPRouteData = segmentDataArray;
        }

        // Zoom map to show the full route
        fitToFeatures(data);

        // Build a color-coded summary of the optimized visiting order
        const orderStr = order.map((waypointIdx, legIdx) => {
            const color  = TSP_COLORS[waypointIdx % TSP_COLORS.length];
            return `<span style="color:${color};font-weight:bold">${waypointIdx + 1}</span>`;
        }).join(' → ');

        showInfo(`
            ✅ <strong>TSP Optimized!</strong><br>
            Order: ${orderStr}<br>
            ${data.duration_minutes} min • ${data.total_distance_km} km
        `);

    } catch (error) {
        handleError('TSP calculation', error);
    }
}

/**
 * Remove all TSP route segment layers from the map.
 * Supports up to 50 segments (more than enough for any realistic use).
 */
function clearTSPLayers() {
    for (let i = 0; i < 50; i++) {
        const id = `tsp-segment-${i}`;
        if (state.map.getLayer(id))  state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    }
    state.lastTSPRouteData = null;
}


// ============================================================================
// SECTION 11: NEAREST FACILITY MODE
// ============================================================================
// Click the map to search for the nearest hospitals, police stations, etc.
// Results appear as colored markers with route lines to each one.

/**
 * Handle map clicks in Facility mode.
 * BUG FIX: clearFacilityData() is called FIRST to fully remove all previous
 * markers AND layers before placing a new search pin. Previously, the layers
 * were not being removed, causing the old ones to persist on the map.
 *
 * @param {Object} lngLat - Clicked coordinates { lng, lat }
 */
function handleFacilityClick(lngLat) {
    // Step 1: Remove EVERYTHING from the previous facility search
    // (old search pin, result markers, and route lines)
    clearFacilityData();

    // Step 2: Place the new search-location pin (red map pin)
    state.markers.facility = new maplibregl.Marker({ element: createMarker('📍', '#dc2626') })
        .setLngLat(lngLat)
        .addTo(state.map);

    showInfo('⏳ Searching nearest facilities...');
    calculateNearestFacilities(lngLat);
}

/**
 * Send a request to the API to find nearby facilities and draw the results.
 * @param {Object} lngLat - Center point for the search { lng, lat }
 */
async function calculateNearestFacilities(lngLat) {
    const facilityType = document.getElementById('facility-type-select')?.value || 'hospital';
    showInfo(`⏳ Searching for nearest ${facilityType}s within ${state.searchDistanceKm}km...<br><small>This may take a few seconds</small>`);

    try {
        const url  = `${API_ENDPOINTS.nearestFacility}?lon=${lngLat.lng}&lat=${lngLat.lat}&type=${encodeURIComponent(facilityType)}&limit=${state.facilityCount}&max_distance_km=${state.searchDistanceKm}&routes=true`;
        const data = await fetchWithTimeout(url);

        if (data.error) throw new Error(data.error);

        if (!data.facilities || data.facilities.length === 0) {
            showInfo(`ℹ️ No ${facilityType} found within ${state.searchDistanceKm}km radius`);
            return;
        }

        displayFacilityResults(lngLat, data, facilityType);

    } catch (error) {
        handleError('Facility search', error);
    }
}

/**
 * Draw facility markers and route lines on the map.
 * This function is also called by restoreFacilityData() after a style switch.
 *
 * @param {Object} lngLat       - The search center { lng, lat }
 * @param {Object} data         - API response { facilities: [...], count: N }
 * @param {string} facilityType - e.g. 'hospital'
 */
function displayFacilityResults(lngLat, data, facilityType) {
    // --- Collect all route features into one GeoJSON FeatureCollection ---
    // We draw all the route lines as a single map layer for efficiency.
    const allRouteFeatures = [];
    data.facilities.forEach((facility, index) => {
        if (facility.route?.features) {
            facility.route.features.forEach(f => {
                allRouteFeatures.push({
                    ...f,
                    properties: {
                        ...f.properties,
                        facility_name:    facility.name,
                        facility_rank:    index + 1,
                        travel_minutes:   facility.travel_minutes
                    }
                });
            });
        }
    });

    // Draw route lines if any exist
    if (allRouteFeatures.length > 0) {
        const facilityColor = FACILITY_COLORS[facilityType] || '#6366f1';

        state.map.addSource('facility-routes', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: allRouteFeatures }
        });
        state.map.addLayer({
            id:     'facility-routes',
            type:   'line',
            source: 'facility-routes',
            paint: {
                'line-color': facilityColor,
                // Closest facility gets a thicker line (rank 1 = width 6, rank 5+ = width 3)
                'line-width': ['interpolate', ['linear'], ['get', 'facility_rank'], 1, 6, 5, 3],
                'line-opacity': 0.8
            }
        });
    }

    // --- Create a marker for each facility result ---
    state.facilityMarkers = data.facilities.map((facility, index) => {
        const icon  = FACILITY_ICONS[facility.type] || '📍';
        const color = FACILITY_COLORS[facility.type] || '#6366f1';

        // Build a custom circular marker with an icon and a rank badge
        const el = document.createElement('div');
        el.style.cssText = `
            width:48px; height:48px; background:${color}; border:3px solid white;
            border-radius:50%; display:flex; align-items:center; justify-content:center;
            font-size:24px; box-shadow:0 4px 12px rgba(0,0,0,0.3); cursor:pointer; position:relative;
        `;
        el.innerHTML = icon;

        // Small badge in the top-right of the marker showing its rank (1 = closest)
        const badge = document.createElement('div');
        badge.style.cssText = `
            position:absolute; top:-8px; right:-8px; width:24px; height:24px;
            background:white; border:2px solid ${color}; border-radius:50%;
            display:flex; align-items:center; justify-content:center;
            font-size:12px; font-weight:bold; color:${color};
        `;
        badge.textContent = index + 1;
        el.appendChild(badge);

        const marker = new maplibregl.Marker({ element: el })
            .setLngLat([parseFloat(facility.facility_lon), parseFloat(facility.facility_lat)])
            .addTo(state.map);

        // Clicking a facility marker opens a popup with its details
        el.addEventListener('click', () => {
            new maplibregl.Popup({ offset: 25, closeButton: true, closeOnClick: true })
                .setLngLat([parseFloat(facility.facility_lon), parseFloat(facility.facility_lat)])
                .setHTML(`
                    <div style="font-family:Inter,sans-serif;min-width:220px;">
                        <div style="font-size:24px;margin-bottom:8px;">${icon}</div>
                        <strong style="font-size:14px;color:#1f2937;">${facility.name}</strong>
                        ${facility.address ? `<p style="margin:4px 0;font-size:12px;color:#6b7280;">${facility.address}</p>` : ''}
                        <p style="margin:8px 0 0;font-size:13px;color:#059669;">
                            <strong>⏱️ ${facility.travel_minutes} minutes</strong> drive
                        </p>
                        <p style="margin:4px 0 0;font-size:11px;color:#9ca3af;">
                            Rank: #${index + 1}
                            ${facility.crow_distance_km ? ` • ${parseFloat(facility.crow_distance_km).toFixed(1)} km straight-line` : ''}
                        </p>
                    </div>
                `)
                .addTo(state.map);
        });

        return marker;
    });

    // Save full response so style-switch can restore without another API call
    state.lastFacilityData = data;

    // --- Build summary text for the info box ---
    const closest = data.facilities[0];
    const icon    = FACILITY_ICONS[facilityType] || '📍';
    const list    = data.facilities.map((f, i) =>
        `${i + 1}. ${FACILITY_ICONS[f.type] || '📍'} ${f.name} (${f.travel_minutes} min)`
    ).join('<br>');

    showInfo(`
        ✅ Found ${data.count} ${facilityType}${data.count > 1 ? 's' : ''} within ${state.searchDistanceKm}km
        <br><strong>Closest:</strong> ${icon} ${closest.name}
        <br><strong>Travel time:</strong> ${closest.travel_minutes} minutes
        ${closest.crow_distance_km ? `<br><small>Straight-line: ${closest.crow_distance_km.toFixed(1)} km</small>` : ''}
        <br><br><small style="font-size:0.85rem;">${list}</small>
    `);

    // Zoom to fit all facilities and the search point in the viewport
    const bounds = new maplibregl.LngLatBounds();
    bounds.extend([lngLat.lng, lngLat.lat]);
    data.facilities.forEach(f => {
        bounds.extend([parseFloat(f.facility_lon), parseFloat(f.facility_lat)]);
    });
    state.map.fitBounds(bounds, { padding: { top: 80, bottom: 80, left: 80, right: 80 }, maxZoom: 14, duration: 1000 });
}


// ============================================================================
// SECTION 12: SERVICE AREA MODE
// ============================================================================
// Click to set a service center, then the map shades the area reachable
// within the selected number of minutes by road.

/**
 * Handle map clicks in Service Area mode.
 * @param {Object} lngLat - Clicked coordinates { lng, lat }
 */
function handleServiceClick(lngLat) {
    clearServiceArea(); // Remove previous service area polygon

    if (state.markers.service) state.markers.service.remove();

    // Place the blue truck icon at the service center
    state.markers.service = new maplibregl.Marker({ element: createMarker('🚚', '#1c2ae1') })
        .setLngLat(lngLat)
        .addTo(state.map);

    calculateServiceArea(lngLat);
}

/**
 * Request a service area polygon from the API and draw it on the map.
 * @param {Object} lngLat - Service center coordinates { lng, lat }
 */
async function calculateServiceArea(lngLat) {
    showInfo(`⏳ Calculating ${state.serviceMinutes}-min service area...`);

    try {
        const data = await fetchWithTimeout(
            `${API_ENDPOINTS.serviceArea}?lon=${lngLat.lng}&lat=${lngLat.lat}&minutes=${state.serviceMinutes}`
        );

        if (data.error) throw new Error(data.error);

        clearServiceArea();            // Remove old polygon if recalculating
        state.lastServiceData = data;  // Save for style-switch restoration
        rebuildServiceAreaLayers(data);

        // Zoom to fit the service area polygon
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

/**
 * Draw the service area polygon, border, and road network from saved API data.
 * Separated from calculateServiceArea() so it can be called both initially
 * and when restoring after a map style switch.
 *
 * @param {Object} data - Saved API response from service area endpoint
 */
function rebuildServiceAreaLayers(data) {
    clearServiceArea(); // Always start clean

    // Yellow road network (the roads you can actually drive within the time limit)
    state.map.addSource('service-network', { type: 'geojson', data: data.reachable_network });
    state.map.addLayer({ id: 'service-network', type: 'line', source: 'service-network',
        paint: { 'line-color': '#f59e0b', 'line-width': 3, 'line-opacity': 0.6 }
    });

    // Red polygon fill (the catchment area)
    state.map.addSource('service-hull', { type: 'geojson', data: data.service_area });
    state.map.addLayer({ id: 'service-hull', type: 'fill', source: 'service-hull',
        paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.15 }
    });

    // Red dashed border around the polygon
    state.map.addLayer({ id: 'service-border', type: 'line', source: 'service-hull',
        paint: { 'line-color': '#dc2626', 'line-width': 4, 'line-dasharray': [3, 2], 'line-opacity': 0.8 }
    });
}


// ============================================================================
// SECTION 13: SEARCH FUNCTIONALITY (Elasticsearch)
// ============================================================================
// Search for building units or floors by name/address.
// Results appear in the sidebar; clicking one zooms to it in 3D and highlights it.

/**
 * Execute a search against the Elasticsearch index.
 * Uses "multi_match" so it searches several fields at once,
 * and "fuzziness: AUTO" to tolerate minor typos.
 */
async function searchUnits() {
    const queryText  = document.getElementById('searchInput').value.trim();
    const resultsDiv = document.getElementById('results');

    if (!queryText) {
        resultsDiv.innerHTML = '<div class="no-results">Please enter a search term</div>';
        return;
    }

    resultsDiv.innerHTML = '<div class="loading">Searching...</div>';
    clearHighlight();

    // Choose the right index and fields based on the selected dataset radio button
    const index  = currentDataset === 'units' ? 'building_units' : 'buildings_vertical';
    const fields = currentDataset === 'units'
        ? ['UNIT_ID', 'NAME^2', 'NAME_LONG', 'UnitAddres', 'LabelNames']       // ^2 = double weight
        : ['UnitAddress^3', 'ShortAddress^1.8', 'fkFloorID^1.5', 'FloorUsage'];

    const esQuery = {
        query: {
            multi_match: {
                query:     queryText,
                fields,
                type:      'best_fields',
                fuzziness: 'AUTO'  // Tolerate up to 2 character differences
            }
        },
        size: 20 // Return at most 20 results
    };

    try {
        const response = await fetch(`${ES_URL}/${index}/_search`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(esQuery)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        resultsDiv.innerHTML = '';

        if (data.hits.hits.length === 0) {
            resultsDiv.innerHTML = '<div class="no-results">No results found.</div>';
            return;
        }

        // Render each result as a clickable list item
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
        resultsDiv.innerHTML = `<div class="error">Error: ${err.message}<br><small>Check console for details</small></div>`;
    }
}

/**
 * Calculate where to place the info popup relative to a feature's bounding box.
 * Positions it slightly to the right of and above the feature's center.
 *
 * @param {Object} bounds - MapLibre LngLatBounds of the feature
 * @returns {Array} [lng, lat] for the popup anchor
 */
function getPopupAnchorPosition(bounds) {
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    // Place the popup 30% to the right and 65% up from the bottom of the bounding box
    return [
        ne.lng + (ne.lng - sw.lng) * 0.3,
        sw.lat + (ne.lat - sw.lat) * 0.65
    ];
}

/**
 * Zoom to a search result, switch to 3D BDF view, and highlight the feature.
 *
 * @param {Object} feature      - The Elasticsearch document (_source)
 * @param {HTMLElement} clickedElement - The result list item that was clicked
 */
async function zoomToFeature(feature, clickedElement) {
    if (!state.map) { console.warn('Map not ready'); return; }

    clearHighlight();
    clickedElement.classList.add('active');

    if (!feature.geometry) {
        alert('No geometry available for this feature.');
        return;
    }

    // Calculate the bounding box of the feature's geometry
    const bounds = new maplibregl.LngLatBounds();
    const flattenCoords = (arr) => {
        if (typeof arr[0] === 'number') bounds.extend([arr[0], arr[1]]);
        else arr.forEach(flattenCoords);
    };
    flattenCoords(feature.geometry.coordinates);

    if (bounds.isEmpty()) { alert('No valid geometry found.'); return; }

    const popupPosition = getPopupAnchorPosition(bounds);

    // Build the popup HTML with the feature's attributes
    let popupHTML = `
        <div style="max-width:280px;font-size:14px;line-height:1.6;">
            <strong style="font-size:16px;color:#1f2937;">
                ${feature.NAME || feature.FloorUsage || feature.UnitAddress || 'Feature'}
            </strong><br>
    `;
    if (currentDataset === 'units') {
        popupHTML += `
            <strong>Unit ID:</strong> ${feature.UNIT_ID || '—'}<br>
            <strong>Address:</strong> ${feature.UnitAddres || 'N/A'}<br>
            <strong>Floor:</strong> ${feature.Base !== undefined ? feature.Base.toFixed(2) + 'm' : 'N/A'}<br>
            <strong>Height:</strong> ${feature.HEIGHT !== undefined ? feature.HEIGHT.toFixed(2) + 'm' : 'N/A'}<br>
            <strong>Type:</strong> ${feature.USE_TYPE || 'N/A'}
        `;
    } else {
        popupHTML += `
            <strong>ID:</strong> ${feature.fkFloorID || feature.UnitAddress || '—'}<br>
            <strong>Address:</strong> ${feature.UnitAddress || feature.ShortAddress || 'N/A'}<br>
            <strong>Floor:</strong> ${feature.FloorNumber ?? '—'}<br>
            <strong>Usage:</strong> ${feature.FloorUsage || '—'}<br>
            <strong>Total Floors:</strong> ${feature.NoofFloors || '—'}<br>
            <strong>Building Height:</strong> ${feature.BuildingHeight ? feature.BuildingHeight.toFixed(1) + 'm' : '—'}
        `;
    }
    popupHTML += '</div>';

    // Switch to 3D BDF style if not already active, then highlight the feature
    const afterStyleLoad = () => addHighlightAndAnimate(feature, bounds, popupPosition, popupHTML);
    const bdfStyle       = STYLES.find(s => s.id === 'bdf-style');

    if (currentStyleId !== 'bdf-style') {
        state.map.setStyle(bdfStyle.url);
        currentStyleId = 'bdf-style';
        state.map.once('idle', afterStyleLoad);
    } else {
        afterStyleLoad();
    }
}

/**
 * Add a 3D orange extrusion highlight and animate the camera to the feature.
 *
 * @param {Object} feature        - Elasticsearch document
 * @param {Object} bounds         - LngLatBounds of the feature
 * @param {Array}  popupPosition  - [lng, lat] for the popup
 * @param {string} popupHTML      - HTML content for the popup
 */
function addHighlightAndAnimate(feature, bounds, popupPosition, popupHTML) {
    const layers  = state.map.getStyle().layers || [];
    const beforeId = layers.length > 0 ? layers[layers.length - 1].id : undefined;

    // Create a safe CSS/MapLibre ID from the feature's identifier
    const safeId = (feature.UNIT_ID || feature.fkFloorID || feature.UnitAddress || 'feat')
        .replace(/[^a-z0-9]/gi, '-');
    const id = `highlight-${safeId}`;
    currentHighlightIds.push(id);

    // Add the feature as a GeoJSON source
    state.map.addSource(id, {
        type: 'geojson',
        data: { type: 'Feature', geometry: feature.geometry, properties: { ...feature } }
    });

    // Calculate extrusion heights based on dataset
    let extrusionBase, extrusionHeight;
    if (currentDataset === 'units') {
        extrusionBase   = feature.Base   || 0;
        extrusionHeight = extrusionBase + (feature.HEIGHT || 4.25);
    } else {
        const floorH    = (feature.BuildingHeight || 0) / (feature.NoofFloors || 1);
        extrusionBase   = floorH * (feature.FloorNumber || 0);
        extrusionHeight = extrusionBase + floorH;
    }

    // Add the 3D extruded polygon in orange
    state.map.addLayer({
        id, type: 'fill-extrusion', source: id,
        paint: {
            'fill-extrusion-color':   '#ff5c00',
            'fill-extrusion-opacity': 0.95,
            'fill-extrusion-height':  ['+', extrusionHeight, 1],
            'fill-extrusion-base':    extrusionBase
        }
    }, beforeId);

    // Animate the camera to the feature with a tilted, slightly rotated view
    state.map.fitBounds(bounds, {
        padding:   { top: 100, bottom: 100, left: 420, right: 100 },
        pitch:     60,
        bearing:   -18,
        minZoom:   16,
        maxZoom:   19.5,
        duration:  1600,
        essential: true
    });

    // Show the popup 0.8 seconds after the camera animation starts
    setTimeout(() => {
        currentPopup = new maplibregl.Popup({
            offset:      [15, 0],
            closeButton: true,
            className:   'unit-popup',
            maxWidth:    '300px',
            anchor:      'left'
        })
            .setLngLat(popupPosition)
            .setHTML(popupHTML)
            .addTo(state.map);

        currentPopup.on('close', () => { currentPopup = null; });
    }, 800);
}


// ============================================================================
// SECTION 14: UTILITY FUNCTIONS
// ============================================================================
// Small reusable helpers used throughout the application.

/**
 * Fetch a URL with an automatic timeout.
 * If the server doesn't respond within REQUEST_TIMEOUT milliseconds,
 * the request is cancelled and an error is thrown.
 *
 * @param {string} url     - The URL to fetch
 * @param {Object} options - Standard fetch() options (method, headers, body, etc.)
 * @returns {Promise<Object>} Parsed JSON response
 */
async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Server error: ${response.status} ${response.statusText}`);
        }

        return await response.json();

    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Request timed out. Please try again.', { cause: error });
        }
        throw error;
    }
}

/**
 * Log an error and show a user-friendly message in the info box.
 * @param {string} context - Which operation failed (e.g. 'Route calculation')
 * @param {Error}  error   - The Error object that was thrown
 */
function handleError(context, error) {
    console.error(`${context} error:`, error);
    const message = error.message.includes('Failed to fetch')
        ? 'Network error. Check your connection and try again.'
        : error.message;
    showInfo(`❌ ${message}`);
}

/**
 * Create a custom circular marker element for use with MapLibre.
 * The marker is a colored circle with text inside.
 *
 * @param {string} text    - Text or emoji to show inside the circle
 * @param {string} bgColor - Background color in hex (e.g. '#ef4444')
 * @returns {HTMLElement} The finished marker DOM element
 */
function createMarker(text, bgColor = null) {
    const el = document.createElement('div');
    el.className = 'marker';

    // Special CSS classes for specific marker types (styling in CSS file)
    if (text === '🚚') el.classList.add('marker-service');
    if (text === 'E')  el.classList.add('marker-end');

    if (bgColor) el.style.backgroundColor = bgColor;
    el.textContent = text;

    return el;
}

/**
 * Show a message in the info box at the bottom of the sidebar.
 * Supports HTML so you can use <strong>, <small>, <br>, etc.
 *
 * @param {string} text - HTML string to display
 */
function showInfo(text) {
    const infoBox   = document.getElementById('info-box');
    const routeInfo = document.getElementById('route-info');

    if (infoBox && routeInfo) {
        infoBox.classList.remove('hidden');
        routeInfo.innerHTML = text;
    }
}

/**
 * Add a line layer to the map for displaying a route.
 * If a layer/source with the same ID already exists, it is removed first.
 *
 * @param {Object} data    - GeoJSON FeatureCollection for the route
 * @param {string} color   - Line color in hex
 * @param {number} opacity - Line opacity 0–1
 * @param {number} width   - Line width in pixels
 * @param {string} layerId - Unique ID for this layer (used for cleanup later)
 */
function addRouteLayer(data, color, opacity = 0.9, width = 7, layerId = 'route') {
    // Remove existing layer/source with this ID if present (prevents "already exists" error)
    if (state.map.getLayer(layerId))  state.map.removeLayer(layerId);
    if (state.map.getSource(layerId)) state.map.removeSource(layerId);

    state.map.addSource(layerId, { type: 'geojson', data });
    state.map.addLayer({
        id:     layerId,
        type:   'line',
        source: layerId,
        layout: { 'line-join': 'round', 'line-cap': 'round' }, // Smooth corners and ends
        paint:  { 'line-color': color, 'line-width': width, 'line-opacity': opacity }
    });
}

/**
 * Zoom and pan the map to fit a GeoJSON FeatureCollection in the viewport.
 * @param {Object} data - GeoJSON FeatureCollection
 */
function fitToFeatures(data) {
    const bounds = new maplibregl.LngLatBounds();
    data.features.forEach(f => {
        if (f.geometry?.coordinates) f.geometry.coordinates.forEach(c => bounds.extend(c));
    });
    state.map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 1500 });
}


// ============================================================================
// SECTION 15: CLEANUP FUNCTIONS
// ============================================================================
// Functions to remove specific layers/markers from the map and reset state.

/**
 * Remove all A→B route layers (supports up to 20 alternatives).
 */
function clearRouteLayers() {
    for (let i = 0; i < 20; i++) {
        const id = `route-${i}`;
        if (state.map.getLayer(id))  state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    }
    // Also remove the legacy single-route layer (backward compatibility)
    if (state.map.getLayer('route'))  state.map.removeLayer('route');
    if (state.map.getSource('route')) state.map.removeSource('route');

    state.currentRouteData = null;
}

/**
 * Remove all facility-related markers and route layers.
 * This handles BOTH the search pin AND the result markers AND the route lines.
 * 
 * BUG FIX: Previously this function was not called properly before re-adding 
 * results, which left old layers on the map. Now it is always called first
 * in handleFacilityClick() before anything new is added.
 */
function clearFacilityData() {
    // Remove the search-location pin (the red map pin the user clicked)
    if (state.markers.facility) {
        state.markers.facility.remove();
        state.markers.facility = null;
    }

    // Remove all facility result markers (the hospital/police/etc. icons)
    state.facilityMarkers.forEach(m => m.remove());
    state.facilityMarkers = [];

    // Remove the route lines connecting search point to each facility
    removeFacilityLayers();

    // Clear the saved data so the style-switch restore doesn't redraw stale results
    state.lastFacilityData = null;
}

/**
 * Remove service area polygon and road network layers.
 */
function clearServiceArea() {
    ['service-network', 'service-hull', 'service-border'].forEach(id => {
        if (state.map.getLayer(id))  state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    });
}

/**
 * Remove 3D search result highlights and close any open popup.
 */
function clearHighlight() {
    currentHighlightIds.forEach(id => {
        if (state.map?.getLayer(id))  state.map.removeLayer(id);
        if (state.map?.getSource(id)) state.map.removeSource(id);
    });
    currentHighlightIds = [];

    if (currentPopup) {
        currentPopup.remove();
        currentPopup = null;
    }

    document.querySelectorAll('.result-item').forEach(el => el.classList.remove('active'));
}

/**
 * MASTER CLEANUP — removes everything and resets the app to a clean state.
 * Called when switching modes or explicitly resetting the map.
 */
function clearAll() {
    clearRouteLayers();
    clearTSPLayers();
    clearFacilityData();
    clearServiceArea();
    clearHighlight();
    clearFeatureHighlight();

    // Remove all individual markers
    Object.keys(state.markers).forEach(key => {
        if (key === 'tsp') {
            // TSP markers are stored in an array of objects
            state.markers.tsp.forEach(item => item.marker?.remove());
            state.markers.tsp = [];
        } else if (state.markers[key]) {
            state.markers[key].remove();
            state.markers[key] = null;
        }
    });

    // Reset all saved API response data
    state.currentRouteData = null;
    state.lastTSPRouteData = null;
    state.lastFacilityData = null;
    state.lastServiceData  = null;

    showInfo('Click to start');
}


// ============================================================================
// SECTION 16: APPLICATION INITIALIZATION
// ============================================================================

// Start the app as soon as the browser has fully loaded the HTML page.
window.addEventListener('load', initMap);

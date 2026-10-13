// ============================================================================
// ROUTING & SERVICES ANALYSIS APPLICATION
// ============================================================================
// This application provides:
// - Route planning (A→B and multi-point TSP optimization)
// - Nearest facility finding (hospitals, fire stations, police)
// - Service area calculation (reachability analysis)
// - Building/unit search with 3D visualization
// - Feature inspection tool (info pointer)
// ============================================================================

// ============================================================================
// SECTION 1: CONFIGURATION & CONSTANTS
// ============================================================================
// All application settings and fixed values are defined here
// Change these values to customize the application behavior

// --- Map Style Definitions ---
// Each style has a URL, default camera position (pitch, zoom, bearing)
const STYLES = [
    { 
        id: 'basic-style', 
        name: 'Default', 
        url: 'http://localhost:3001/styles/martin/style.json', 
        pitch: 0,  
        zoom: 12, 
        bearing: 0 
    },
    { 
        id: 'sat-style', 
        name: 'Satellite', 
        url: 'http://localhost:3001/styles/martin/style_sat.json', 
        pitch: 0,  
        zoom: 12, 
        bearing: 0 
    },
    { 
        id: '3d-style', 
        name: '3D', 
        url: 'http://localhost:3001/styles/martin/style_3d.json', 
        pitch: 45, 
        zoom: 14, 
        bearing: 0 
    },
    { 
        id: 'bdf-style', 
        name: 'BDF', 
        url: 'http://localhost:3001/styles/martin/style_bdf.json', 
        pitch: 60, 
        zoom: 17, 
        bearing: -20 
    }
];

// --- Backend API Configuration ---
// URL endpoints for routing and analysis services
const BACKEND_URL = 'http://localhost:5000';
const API_ENDPOINTS = {
    route: `${BACKEND_URL}/route`,                    // A→B routing
    tsp: `${BACKEND_URL}/route/tsp`,                  // Multi-point optimization
    nearestFacility: `${BACKEND_URL}/nearest_facility`, // Facility search
    serviceArea: `${BACKEND_URL}/service_area`         // Reachability analysis
};

// --- Elasticsearch Configuration ---
// For searching building units and floors
const ES_URL = 'http://localhost:9200';

// --- Map Default Settings ---
const DEFAULT_CENTER = [46.6167, 24.8258]; // Riyadh coordinates [lng, lat]
const DEFAULT_ZOOM = 12;                    // Initial zoom level
const REQUEST_TIMEOUT = 65000;              // API timeout in milliseconds

// --- Facility Display Configuration ---
// Colors and icons for different facility types
const FACILITY_COLORS = {
    'hospital': '#ef4444',      // Red
    'fire station': '#f97316',  // Orange
    'police': '#8b5cf6',        // Purple
    'clinic': '#10b981'         // Green
};

const FACILITY_ICONS = {
    'hospital': '🏥',
    'fire station': '🚒',
    'police': '👮',
    'clinic': '⚕️'
};

// --- UI Control Limits ---
// Maximum values for sliders (easy to adjust)
const MAX_FACILITY_COUNT = 20;      // Max facilities to search
const MAX_SERVICE_MINUTES = 20;     // Max service area time
const MAX_SEARCH_DISTANCE_KM = 30;  // Max search radius

// ============================================================================
// SECTION 2: APPLICATION STATE
// ============================================================================
// This object holds all the current state of the application
// Think of it as the "memory" of what's happening right now

const state = {
    // --- Core Map Properties ---
    map: null,                      // MapLibre map instance
    currentMode: 'route',           // Active mode: 'route', 'tsp', 'facility', or 'service'
    currentCenter: DEFAULT_CENTER,  // Current map center
    currentZoom: DEFAULT_ZOOM,      // Current zoom level
    currentPitch: 0,                // Current camera tilt (0-85 degrees)
    currentBearing: 0,              // Current compass direction
    
    // --- Markers on the Map ---
    markers: {
        start: null,                // Start point marker (route mode)
        end: null,                  // End point marker (route mode)
        service: null,              // Service center marker (service area mode)
        facility: null,             // Search location marker (facility mode)
        tsp: []                     // Array of waypoint markers (TSP mode)
    },
    
    // --- Facility Search State ---
    facilityMarkers: [],            // Array of facility result markers
    
    // --- Route Data ---
    currentRouteData: null,         // Currently displayed route(s)
    
    // --- User Settings ---
    serviceMinutes: 5,              // Service area time setting
    facilityCount: 5,               // Number of facilities to find
    searchDistanceKm: 10,           // Search radius in kilometers
    routeOptimization: 'fastest',   // Route type: 'fastest' or 'shortest'
    showAlternatives: true,         // Show alternative routes
    
    // --- Info Pointer Tool State ---
    infoPointerActive: false,       // Is info pointer mode enabled?
    highlightedFeatureId: null,     // Currently selected feature ID
    highlightedSourceLayer: null,   // Source layer of selected feature
    
    // --- Draggable Panel State ---
    isDragging: false,              // Is panel currently being dragged?
    dragOffset: { x: 0, y: 0 },     // Mouse offset during drag
    panelPosition: null             // Stored panel position
};

// --- Search Application State ---
// Separate state for the building/unit search feature
let currentDataset = 'units';       // Current search dataset: 'units' or 'floors'
let currentStyleId = 'basic-style'; // Currently active map style ID
let currentHighlightIds = [];       // Array of highlighted feature layer IDs
let currentPopup = null;            // Currently open popup reference

// ============================================================================
// SECTION 3: MAP INITIALIZATION
// ============================================================================
// This function sets up the map when the page loads

/**
 * Initialize the MapLibre map and set up all core functionality
 * This is the main entry point that runs when the page loads
 */
function initMap() {
    // Create the map instance
    state.map = new maplibregl.Map({
        container: 'map',               // HTML element ID
        style: STYLES[0].url,           // Start with first style
        center: state.currentCenter,    // Initial position
        zoom: state.currentZoom,
        pitch: state.currentPitch,
        bearing: state.currentBearing,
        maxPitch: 85                    // Maximum tilt angle
    });

    // --- Track Camera Changes ---
    // Update our state whenever the user pans/zooms/tilts the map
    state.map.on('moveend', () => {
        const center = state.map.getCenter().toArray();
        state.currentCenter = center;
        state.currentZoom = state.map.getZoom();
        state.currentPitch = state.map.getPitch();
        state.currentBearing = state.map.getBearing();
    });

    // --- Add Map Controls ---
    // Navigation controls (zoom, compass, pitch)
    state.map.addControl(new maplibregl.NavigationControl(), 'top-right');
    
    // Custom layer switcher control
    state.map.addControl(createLayerSwitcher(), 'bottom-right');

    // --- Initialize UI Components ---
    initializeSliders();    // Set up range sliders
    setupEventHandlers();   // Attach click/change listeners

    // --- Set Up When Map is Loaded ---
    state.map.on('load', () => {
        showInfo('Click anywhere to begin');
        setupInfoPointerLayers();  // Create layers for feature highlighting
        injectMapButtons();        // Add custom control buttons
    });

    // --- Handle Style Changes ---
    // When user switches map styles, recreate info pointer layers
    state.map.on('styledata', () => {
        if (state.infoPointerActive) {
            setupInfoPointerLayers();
        }
    });
}

// ============================================================================
// SECTION 4: MAP CONTROLS
// ============================================================================
// Custom UI controls that appear on the map

/**
 * Create the layer switcher control
 * Allows users to switch between different map styles (Default, Satellite, 3D, BDF)
 * @returns {Object} MapLibre control object
 **/
function createLayerSwitcher() {
    class LayerSwitcher {
        onAdd(map) {
            this.map = map;
            
            // Create container element
            this.container = document.createElement('div');
            this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group flex flex-col bg-white';

            // Create a button for each style
            STYLES.forEach(style => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'px-4 py-3 text-sm font-medium hover:bg-blue-50 border-b border-gray-200 transition';
                
                // Use abbreviated labels for cleaner UI
                btn.textContent = style.name === '3D' ? '3D' 
                                : style.name === 'BDF' ? 'BDF' 
                                : style.name.charAt(0);
                
                // Handle style change on click
                btn.onclick = () => {
                    currentStyleId = style.id;
                    
                    // Save current camera position before switching
                    const center = map.getCenter();
                    const zoom = style.zoom ?? map.getZoom();
                    const pitch = style.pitch ?? 0;
                    const bearing = style.bearing ?? 0;

                    // Apply new style
                    map.setStyle(style.url);

                    // Wait for style to fully load, then restore camera and routes
                    map.once('idle', () => {
                        map.jumpTo({ center, zoom, pitch, bearing });
                        
                        // Redraw routes if they exist
                        if (state.currentMode === 'route' && Array.isArray(state.currentRouteData)) {
                            state.currentRouteData.forEach((route, i) => {
                                const color = getRouteColor(i);
                                const opacity = i === 0 ? 0.9 : 0.6;
                                const width = i === 0 ? 7 : 5;
                                addRouteLayer(route, color, opacity, width, `route-${i}`);
                            });
                        }
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

/**
 * Inject custom control buttons into the map UI
 * Creates the info pointer button and panel toggle button
 */
function injectMapButtons() {
    const topRight = document.querySelector('.maplibregl-ctrl-top-right');
    if (!topRight) return;

    // Create a control group to hold both buttons
    const ctrlGroup = document.createElement('div');
    ctrlGroup.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    ctrlGroup.id = 'custom-map-controls';

    // --- Info Pointer Button ---
    const infoBtn = document.createElement('button');
    infoBtn.className = 'info-pointer-btn';
    infoBtn.type = 'button';
    infoBtn.innerHTML = 'ℹ️';
    infoBtn.title = 'Toggle Info Pointer';
    infoBtn.addEventListener('click', () => toggleInfoPointer());

    // --- Panel Toggle Button ---
    const panelBtn = document.createElement('button');
    panelBtn.className = 'panel-toggle-btn';
    panelBtn.type = 'button';
    panelBtn.innerHTML = '◀';
    panelBtn.title = 'Hide Control Panel';
    panelBtn.addEventListener('click', () => toggleControlPanel(panelBtn));

    // Add buttons to control group
    ctrlGroup.appendChild(infoBtn);
    ctrlGroup.appendChild(panelBtn);
    topRight.appendChild(ctrlGroup);

    // --- Make Minimized Panel Clickable ---
    // Allow users to click on minimized panel to expand it
    const panel = document.querySelector('.control-panel.header');
    if (panel) {
        panel.addEventListener('click', function expandIfMinimised(e) {
            // Don't expand if clicking interactive elements
            if (e.target.closest('button, input, select, label, .mode-btn, .route-opt-btn, .range-slider')) {
                return;
            }

            // Only expand if currently minimized
            if (!panel.classList.contains('panel-minimised')) return;

            toggleControlPanel(panelBtn);
        });
    }
}

/**
 * Toggle the main control panel (minimize/expand)
 * @param {HTMLElement} btn - The toggle button element
 */
function toggleControlPanel(btn) {
    const panel = document.querySelector('.control-panel.header');
    if (!panel) return;

    // Toggle minimized state
    const isMinimised = panel.classList.toggle('panel-minimised');
    
    // Update button appearance
    btn.classList.toggle('active', isMinimised);
    btn.innerHTML = isMinimised ? '▶' : '◀';
    btn.title = isMinimised ? 'Show Control Panel' : 'Hide Control Panel';

    // Handle click-to-expand functionality
    if (isMinimised) {
        panel._expandHandler = (e) => {
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
// Allows users to click on map features to inspect their properties

/**
 * Toggle info pointer mode on/off
 * When active, clicking the map shows feature information instead of placing markers
 */
function toggleInfoPointer() {
    state.infoPointerActive = !state.infoPointerActive;

    const btn = document.querySelector('.info-pointer-btn');
    const mapContainer = document.getElementById('map');
    const featurePanel = document.getElementById('feature-info-panel');

    if (state.infoPointerActive) {
        // --- Activate Info Pointer ---
        btn.classList.add('active');
        mapContainer.classList.add('info-pointer-active');  // Changes cursor
        featurePanel.classList.remove('hidden');
        
        // Reset panel to default position
        resetPanelPosition();
        
        // Enable dragging
        setupDraggablePanel();
        
        // Clear any previous highlights
        clearFeatureHighlight();
        
        // Show helpful hint
        updateFeatureInfo({ 
            html: '<p class="info-hint">Click on any feature to see its details</p>' 
        });
    } else {
        // --- Deactivate Info Pointer ---
        btn.classList.remove('active');
        mapContainer.classList.remove('info-pointer-active');
        featurePanel.classList.add('hidden');
        
        // Clean up
        clearFeatureHighlight();
    }
}

/**
 * Set up highlight layers for selected features
 * Creates special map layers that show which feature is selected
 */
function setupInfoPointerLayers() {
    // Wait for map style to be fully loaded
    if (!state.map.isStyleLoaded()) {
        state.map.once('styledata', setupInfoPointerLayers);
        return;
    }

    // Create data source for highlighted features
    if (!state.map.getSource('feature-highlight')) {
        state.map.addSource('feature-highlight', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }

    // Define how different geometry types should be highlighted
    const highlightLayers = [
        {
            id: 'feature-highlight-fill',
            type: 'fill',
            filter: ['==', ['geometry-type'], 'Polygon'],  // Only polygons
            paint: { 
                'fill-color': '#3b82f6',      // Blue fill
                'fill-opacity': 0.3 
            }
        },
        {
            id: 'feature-highlight-line',
            type: 'line',
            filter: ['any',                               // Lines and polygon outlines
                ['==', ['geometry-type'], 'LineString'],
                ['==', ['geometry-type'], 'Polygon']
            ],
            paint: { 
                'line-color': '#3b82f6',      // Blue outline
                'line-width': 3, 
                'line-opacity': 0.8 
            }
        },
        {
            id: 'feature-highlight-point',
            type: 'circle',
            filter: ['==', ['geometry-type'], 'Point'],   // Only points
            paint: {
                'circle-radius': 8,
                'circle-color': '#3b82f6',
                'circle-opacity': 0.6,
                'circle-stroke-width': 2,
                'circle-stroke-color': '#1e40af'
            }
        }
    ];

    // Add each highlight layer to the map
    highlightLayers.forEach(layer => {
        if (!state.map.getLayer(layer.id)) {
            state.map.addLayer({ 
                ...layer, 
                source: 'feature-highlight' 
            });
        }
    });
}

/**
 * Handle map clicks in info pointer mode
 * Queries features at click point and displays information
 * @param {Object} e - MapLibre click event
 */
function handleInfoPointerClick(e) {
    // Only process if info pointer is active and not dragging panel
    if (!state.infoPointerActive || state.isDragging) return;

    // Query all features at the clicked point
    const features = state.map.queryRenderedFeatures(e.point);
    
    if (!features || features.length === 0) {
        clearFeatureHighlight();
        updateFeatureInfo({ 
            html: '<p class="info-hint">No features found at this location</p>' 
        });
        return;
    }

    // Filter out our own UI layers (routes, highlights, etc.)
    const validFeatures = features.filter(f => {
        const id = f.layer.id;
        return !id.startsWith('feature-highlight') &&
               !id.startsWith('route') &&
               !id.startsWith('service-') &&
               !id.startsWith('facility-');
    });

    if (validFeatures.length === 0) {
        clearFeatureHighlight();
        updateFeatureInfo({ 
            html: '<p class="info-hint">No base layer features at this location</p>' 
        });
        return;
    }

    // Get the topmost feature (what user likely clicked on)
    const feature = validFeatures[0];
    
    // Highlight and display information
    highlightFeature(feature);
    displayFeatureInfo(feature);
}

/**
 * Highlight a selected feature on the map
 * @param {Object} feature - GeoJSON feature to highlight
 */
function highlightFeature(feature) {
    // Clear previous highlight first
    clearFeatureHighlight();
    
    // Store what we're highlighting
    state.highlightedFeatureId = feature.id;
    state.highlightedSourceLayer = feature.sourceLayer;
    
    // Update the highlight layer with this feature
    const src = state.map.getSource('feature-highlight');
    if (src) {
        src.setData({ 
            type: 'FeatureCollection', 
            features: [feature] 
        });
    }
}

/**
 * Display feature information in the info panel
 * @param {Object} feature - GeoJSON feature to display
 */
function displayFeatureInfo(feature) {
    const properties = feature.properties || {};
    const layer = feature.layer.id;
    const sourceLayer = feature.sourceLayer || 'N/A';
    const geomType = feature.geometry.type;

    // Build HTML for layer information
    let html = `
        <div class="feature-layer-info">
            <p><strong>Layer:</strong> ${layer}</p>
            <p><strong>Source Layer:</strong> ${sourceLayer}</p>
            <p><strong>Geometry:</strong> ${geomType}</p>
        </div>
    `;

    // Add property information if available
    if (Object.keys(properties).length > 0) {
        html += '<div class="feature-properties">';
        
        // Sort properties alphabetically for consistent display
        Object.keys(properties).sort().forEach(key => {
            const val = properties[key];
            
            // Skip null/undefined values
            if (val === null || val === undefined) return;
            
            // Format value based on type
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
 * Format property keys for display
 * Converts snake_case or camelCase to Title Case
 * @param {string} key - Property key to format
 * @returns {string} Formatted key
 */
function formatPropertyKey(key) {
    return key
        .replace(/_/g, ' ')              // Replace underscores with spaces
        .replace(/([A-Z])/g, ' $1')      // Add space before capital letters
        .replace(/^./, s => s.toUpperCase())  // Capitalize first letter
        .trim();
}

/**
 * Update the feature info panel content
 * @param {Object} options - Options object
 * @param {string} options.html - HTML content to display
 */
function updateFeatureInfo({ html }) {
    const content = document.getElementById('feature-info-content');
    if (content) {
        content.innerHTML = html;
    }
}

/**
 * Clear feature highlight from the map
 */
function clearFeatureHighlight() {
    state.highlightedFeatureId = null;
    state.highlightedSourceLayer = null;

    const src = state.map.getSource('feature-highlight');
    if (src) {
        src.setData({ 
            type: 'FeatureCollection', 
            features: [] 
        });
    }
}

// ============================================================================
// SECTION 6: DRAGGABLE PANEL
// ============================================================================
// Makes the feature info panel draggable

/**
 * Set up drag functionality for the feature info panel
 * Allows users to move the panel anywhere on screen
 */
function setupDraggablePanel() {
    const panel = document.getElementById('feature-info-panel');
    const header = document.querySelector('.feature-info-header');
    if (!panel || !header) return;

    // Drag state variables
    let isDragging = false;
    let initialX = 0;
    let initialY = 0;
    let currentX = 0;
    let currentY = 0;

    /**
     * Start dragging
     * @param {Event} e - Mouse or touch event
     */
    const dragStart = (e) => {
        // Don't drag if clicking the close button
        if (e.target.closest('.close-btn')) return;

        // Get the event coordinates (works for both mouse and touch)
        const touch = e.touches?.[0] || e;
        const rect = panel.getBoundingClientRect();

        // Calculate offset so panel doesn't jump when drag starts
        initialX = touch.clientX - rect.left;
        initialY = touch.clientY - rect.top;

        isDragging = true;
        state.isDragging = true;
        
        // Switch to absolute positioning for smooth dragging
        panel.style.right = 'auto';
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        panel.style.transform = 'none';
    };

    /**
     * Handle dragging movement
     * @param {Event} e - Mouse or touch event
     */
    const drag = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        
        const touch = e.touches?.[0] || e;
        
        // Calculate new position, keeping panel within viewport
        currentX = Math.max(0, Math.min(
            touch.clientX - initialX, 
            window.innerWidth - panel.offsetWidth
        ));
        currentY = Math.max(0, Math.min(
            touch.clientY - initialY, 
            window.innerHeight - panel.offsetHeight
        ));
        
        // Apply new position
        panel.style.left = currentX + 'px';
        panel.style.top = currentY + 'px';
        panel.style.transform = 'none';
    };

    /**
     * End dragging
     */
    const dragEnd = () => {
        isDragging = false;
        state.isDragging = false;
    };

    // --- Attach Event Listeners ---
    // Mouse events
    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
    
    // Touch events (for mobile)
    header.addEventListener('touchstart', dragStart, { passive: false });
    document.addEventListener('touchmove', drag, { passive: false });
    document.addEventListener('touchend', dragEnd);
}

/**
 * Reset panel to its default position (top-right corner)
 */
function resetPanelPosition() {
    const panel = document.getElementById('feature-info-panel');
    if (!panel) return;

    // Reset to original CSS positioning
    panel.style.left = 'auto';
    panel.style.right = '1rem';
    panel.style.top = '1rem';
    panel.style.bottom = 'auto';
    panel.style.transform = 'none';
    
    state.panelPosition = null;
}

// ============================================================================
// SECTION 7: UI INITIALIZATION & EVENT HANDLERS
// ============================================================================
// Set up sliders and attach event listeners to UI elements

/**
 * Initialize range sliders with maximum values
 * Sets the 'max' attribute based on global constants
 */
function initializeSliders() {
    // Facility count slider
    const fc = document.getElementById('facility-count-input');
    if (fc) fc.max = MAX_FACILITY_COUNT;

    // Service time slider
    const ti = document.getElementById('time-input');
    if (ti) ti.max = MAX_SERVICE_MINUTES;

    // Search distance slider
    const di = document.getElementById('distance-input');
    if (di) di.max = MAX_SEARCH_DISTANCE_KM;
}

/**
 * Set up all event handlers for user interactions
 * This is called once during map initialization
 */
function setupEventHandlers() {
    // --- Map Click Handler ---
    // Different behavior based on active mode
    state.map.on('click', (e) => {
        if (state.infoPointerActive) {
            handleInfoPointerClick(e);
        } else {
            handleMapClick(e);
        }
    });

    // --- Feature Info Panel Close Button ---
    document.getElementById('close-feature-info')?.addEventListener('click', () => {
        state.infoPointerActive = true;
        toggleInfoPointer();
    });

    // --- Mode Switcher Buttons ---
    document.getElementById('mode-route')?.addEventListener('click', () => switchMode('route'));
    document.getElementById('mode-tsp')?.addEventListener('click', () => switchMode('tsp'));
    document.getElementById('mode-facility')?.addEventListener('click', () => switchMode('facility'));
    document.getElementById('mode-service')?.addEventListener('click', () => switchMode('service'));

    // --- Route Optimization Buttons ---
    document.getElementById('opt-fastest')?.addEventListener('click', () => {
        state.routeOptimization = 'fastest';
        updateRouteOptButtons();
        // Recalculate route if markers exist
        if (state.markers.start && state.markers.end) {
            calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
        }
    });

    document.getElementById('opt-shortest')?.addEventListener('click', () => {
        state.routeOptimization = 'shortest';
        updateRouteOptButtons();
        // Recalculate route if markers exist
        if (state.markers.start && state.markers.end) {
            calculateRoute(state.markers.start.getLngLat(), state.markers.end.getLngLat());
        }
    });

    // --- Show Alternatives Checkbox ---
    document.getElementById('show-alternatives')?.addEventListener('change', (e) => {
        state.showAlternatives = e.target.checked;
        // Recalculate route if markers exist
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
            state.serviceMinutes = parseInt(e.target.value, 10);
            timeValue.textContent = state.serviceMinutes;
            // Recalculate service area if marker exists
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
            state.facilityCount = parseInt(e.target.value, 10);
            facilityCountValue.textContent = state.facilityCount;
            // Recalculate facilities if search is active
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
            state.searchDistanceKm = parseInt(e.target.value, 10);
            distanceValue.textContent = state.searchDistanceKm;
            // Recalculate facilities if search is active
            if (state.markers.facility) {
                calculateNearestFacilities(state.markers.facility.getLngLat());
            }
        });
    }

    // --- Search Panel: Enter Key ---
    document.getElementById('searchInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchUnits();
    });

    // --- Search Panel: Dataset Radio Buttons ---
    document.querySelectorAll('input[name="dataset"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            currentDataset = e.target.value;
            document.getElementById('results').innerHTML = '';
            clearHighlight();
        });
    });
}

/**
 * Update route optimization button states
 * Highlights the active optimization method
 */
function updateRouteOptButtons() {
    // Remove active class from all buttons
    document.querySelectorAll('.route-opt-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Add active class to selected button
    const activeBtn = state.routeOptimization === 'fastest' 
        ? 'opt-fastest' 
        : 'opt-shortest';
    document.getElementById(activeBtn)?.classList.add('active');
}

/**
 * Handle map clicks - routes to appropriate mode handler
 * @param {Object} e - MapLibre click event
 */
function handleMapClick(e) {
    const handlers = {
        route: handleRouteClick,
        tsp: handleTSPClick,
        facility: handleFacilityClick,
        service: handleServiceClick
    };
    
    const handler = handlers[state.currentMode];
    if (handler) {
        handler(e.lngLat);
    }
}

// ============================================================================
// SECTION 8: MODE SWITCHING
// ============================================================================
// Handle switching between different application modes

/**
 * Switch to a different application mode
 * Clears current state and updates UI
 * @param {string} mode - Mode to switch to: 'route', 'tsp', 'facility', or 'service'
 */
function switchMode(mode) {
    clearAll();                      // Clean up previous mode
    state.currentMode = mode;        // Update current mode
    updateModeButtons(mode);         // Update button highlights
    updateModeInstructions(mode);    // Update instruction text
    
    // Disable info pointer when switching modes
    if (state.infoPointerActive) {
        toggleInfoPointer();
    }
}

/**
 * Update mode button active states
 * @param {string} activeMode - Currently active mode
 */
function updateModeButtons(activeMode) {
    // Remove active class from all mode buttons
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Add active class to selected mode button
    document.getElementById(`mode-${activeMode}`)?.classList.add('active');
}

/**
 * Update mode-specific UI elements and instructions
 * Shows/hides controls based on active mode
 * @param {string} mode - Current mode
 */
function updateModeInstructions(mode) {
    // Toggle visibility of mode-specific controls
    document.getElementById('time-slider')?.classList.toggle('hidden', mode !== 'service');
    document.getElementById('facility-selector')?.classList.toggle('hidden', mode !== 'facility');
    document.getElementById('facility-sliders-container')?.classList.toggle('hidden', mode !== 'facility');
    document.getElementById('route-options')?.classList.toggle('hidden', mode !== 'route');

    // Define instructions for each mode
    const instructions = {
        route: { 
            html: 'Click: <span class="highlight start">Start</span> → <span class="highlight end">End</span>', 
            info: '🗺️ A→B Route mode active' 
        },
        tsp: { 
            html: 'Click to add <span style="color:#8b5cf6;font-weight:bold">waypoints</span> (min 3)', 
            info: '🔄 TSP mode: Add at least 3 points' 
        },
        facility: { 
            html: 'Click a <span style="color:#ef4444;font-weight:bold">location</span> to find nearest facilities', 
            info: '🏥 Nearest Facility mode active' 
        },
        service: { 
            html: 'Click <span style="color:#ef4444;font-weight:bold">service location</span> + adjust time', 
            info: '🚚 Service Area mode active' 
        }
    };

    const cfg = instructions[mode];
    if (cfg) {
        const instruction = document.getElementById('mode-instruction');
        if (instruction) {
            instruction.innerHTML = cfg.html;
        }
        showInfo(cfg.info);
    }
}

// ============================================================================
// SECTION 9: ROUTE MODE (A→B Routing)
// ============================================================================
// Two-point routing with alternative routes

/**
 * Handle map clicks in route mode
 * First click = start point, second click = end point, third click = reset
 * @param {Object} lngLat - Clicked coordinates {lng, lat}
 */
function handleRouteClick(lngLat) {
    if (!state.markers.start) {
        // Place start marker
        state.markers.start = new maplibregl.Marker({ 
            element: createMarker('S', '#10b981')  // Green "S" marker
        })
            .setLngLat(lngLat)
            .addTo(state.map);
        
        showInfo('✅ Start set. Click destination');
        
    } else if (!state.markers.end) {
        // Place end marker
        state.markers.end = new maplibregl.Marker({ 
            element: createMarker('E', '#ef4444')  // Red "E" marker
        })
            .setLngLat(lngLat)
            .addTo(state.map);
        
        // Calculate route between start and end
        calculateRoute(
            state.markers.start.getLngLat(), 
            state.markers.end.getLngLat()
        );
        
    } else {
        // Reset: clear everything and start over
        clearAll();
        showInfo('🔄 Cleared. Click new start point');
    }
}

/**
 * Calculate route between two points
 * Fetches route from API and displays on map
 * @param {Object} start - Start coordinates {lng, lat}
 * @param {Object} end - End coordinates {lng, lat}
 */
async function calculateRoute(start, end) {
    // Clear any previous routes
    clearRouteLayers();
    showInfo('⏳ Calculating routes...');
    
    try {
        // Build API request URL
        const url = `${API_ENDPOINTS.route}?start_lon=${start.lng}&start_lat=${start.lat}&end_lon=${end.lng}&end_lat=${end.lat}&alternatives=${state.showAlternatives ? 3 : 1}&optimization=${state.routeOptimization}`;
        
        // Fetch route data
        const data = await fetchWithTimeout(url);
        
        if (data.error) {
            throw new Error(data.error);
        }

        // Normalize response format
        // API can return either { routes: [...] } or a single FeatureCollection
        const routes = (data.routes && Array.isArray(data.routes))
            ? data.routes              // Multiple routes
            : [data];                  // Single route - wrap in array

        // Store routes for style reload
        state.currentRouteData = routes;

        // Draw each route on the map
        routes.forEach((route, i) => {
            const color = getRouteColor(i);
            const opacity = i === 0 ? 0.9 : 0.6;   // Primary route more opaque
            const width = i === 0 ? 7 : 5;          // Primary route thicker
            addRouteLayer(route, color, opacity, width, `route-${i}`);
        });

        // Fit map to show all routes
        if (routes.length > 1) {
            fitToMultipleRoutes(routes);
        } else {
            fitToFeatures(routes[0]);
        }

        // Build summary information
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
 * Get color for route based on index
 * Primary route is darkest blue, alternatives are lighter
 * @param {number} index - Route index (0 = primary)
 * @returns {string} Hex color code
 */
function getRouteColor(index) {
    const colors = [
        '#0865fc',  // Primary: Dark blue
        '#4f9af7',  // Alternative 1: Medium blue
        '#6095d3'   // Alternative 2: Light blue
    ];
    return colors[index] || '#5e8bbe';
}

/**
 * Fit map view to show multiple routes
 * @param {Array} routes - Array of route FeatureCollections
 */
function fitToMultipleRoutes(routes) {
    const bounds = new maplibregl.LngLatBounds();
    
    // Extend bounds to include all route coordinates
    routes.forEach(route => {
        route.features.forEach(f => {
            if (f.geometry?.coordinates) {
                f.geometry.coordinates.forEach(c => bounds.extend(c));
            }
        });
    });
    
    // Animate map to fit bounds
    state.map.fitBounds(bounds, { 
        padding: 80, 
        maxZoom: 15, 
        duration: 1500 
    });
}

// ============================================================================
// SECTION 10: TSP MODE (Multi-Point Optimization)
// ============================================================================
// Traveling Salesman Problem - find optimal route through multiple points

/**
 * Handle map clicks in TSP mode
 * Adds waypoints and calculates optimal route when enough points are placed
 * @param {Object} lngLat - Clicked coordinates {lng, lat}
 */
function handleTSPClick(lngLat) {
    const num = state.markers.tsp.length + 1;
    
    // Create numbered marker
    const marker = new maplibregl.Marker({ 
        element: createMarker(num.toString(), '#9333ea')  // Purple numbered marker
    })
        .setLngLat(lngLat)
        .addTo(state.map);
    
    // Store marker and coordinates
    state.markers.tsp.push({ marker, lngLat });

    if (state.markers.tsp.length < 3) {
        // Need at least 3 points for TSP
        const remaining = 3 - state.markers.tsp.length;
        showInfo(`✅ Point ${num} added. Need ${remaining} more (min 3 points)`);
    } else {
        // Auto-calculate after short delay
        showInfo(`✅ Point ${num} added. Auto-calculating TSP in 2 seconds...`);
        setTimeout(() => {
            if (state.markers.tsp.length >= 3) {
                calculateTSP();
            }
        }, 2000);
    }
}

/**
 * Calculate optimal TSP route through all waypoints
 * Uses backend API to solve traveling salesman problem
 */
async function calculateTSP() {
    if (state.markers.tsp.length < 2) {
        showInfo('❌ Need at least 2 points for TSP');
        return;
    }

    showInfo(`⏳ Solving TSP for ${state.markers.tsp.length} points...`);
    
    try {
        // Extract coordinates from markers
        const points = state.markers.tsp.map(m => [m.lngLat.lng, m.lngLat.lat]);
        
        // Send to TSP API
        const data = await fetchWithTimeout(API_ENDPOINTS.tsp, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ points })
        });
        
        if (data.error) {
            throw new Error(data.error);
        }

        // Display optimized route
        state.currentRouteData = data;
        clearRouteLayers();
        addRouteLayer(data, '#9333ea', 0.9, 7, 'route-0');
        fitToFeatures(data);

        // Show optimized order
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
// SECTION 11: NEAREST FACILITY MODE
// ============================================================================
// Find and route to nearest facilities (hospitals, fire stations, etc.)

/**
 * Handle map clicks in facility mode
 * Searches for nearest facilities from clicked location
 * @param {Object} lngLat - Clicked coordinates {lng, lat}
 */
function handleFacilityClick(lngLat) {
    // Clear previous facility search
    clearFacilityData();

    // Place search location marker
    state.markers.facility = new maplibregl.Marker({ 
        element: createMarker('📍', '#dc2626')  // Red pin marker
    })
        .setLngLat(lngLat)
        .addTo(state.map);

    showInfo('⏳ Searching nearest facilities...');
    calculateNearestFacilities(lngLat);
}

/**
 * Search for nearest facilities and display results
 * @param {Object} lngLat - Search center coordinates {lng, lat}
 */
async function calculateNearestFacilities(lngLat) {
    const facilityType = document.getElementById('facility-type-select')?.value || 'hospital';
    
    showInfo(`⏳ Searching for nearest facilities within ${state.searchDistanceKm}km...<br><small>This may take a few seconds</small>`);
    
    try {
        // Build API request
        const url = `${API_ENDPOINTS.nearestFacility}?lon=${lngLat.lng}&lat=${lngLat.lat}&type=${encodeURIComponent(facilityType)}&limit=${state.facilityCount}&max_distance_km=${state.searchDistanceKm}&routes=true`;
        
        // Fetch facility data
        const data = await fetchWithTimeout(url);
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        // Check if any facilities found
        if (!data.facilities || data.facilities.length === 0) {
            showInfo(`ℹ️ No ${facilityType} found within ${state.searchDistanceKm}km radius`);
            return;
        }

        // Display results on map
        displayFacilityResults(lngLat, data, facilityType);
        
    } catch (error) {
        handleError('Facility search', error);
    }
}

/**
 * Display facility search results on the map
 * Creates markers and routes for each facility
 * @param {Object} lngLat - Search center coordinates
 * @param {Object} data - API response with facilities
 * @param {string} facilityType - Type of facility searched
 */
function displayFacilityResults(lngLat, data, facilityType) {
    // --- Collect All Route Features ---
    const allRouteFeatures = [];
    data.facilities.forEach((facility, index) => {
        if (facility.route?.features) {
            facility.route.features.forEach(f => {
                // Add metadata to each route segment
                allRouteFeatures.push({ 
                    ...f, 
                    properties: { 
                        ...f.properties, 
                        facility_name: facility.name, 
                        facility_rank: index + 1, 
                        travel_minutes: facility.travel_minutes 
                    } 
                });
            });
        }
    });

    // --- Add Route Lines ---
    if (allRouteFeatures.length > 0) {
        state.map.addSource('facility-routes', { 
            type: 'geojson', 
            data: { 
                type: 'FeatureCollection', 
                features: allRouteFeatures 
            } 
        });

        const facilityColor = FACILITY_COLORS[facilityType] || '#6366f1';

        // Add route layer with dynamic width based on rank
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

    // --- Create Facility Markers ---
    state.facilityMarkers = data.facilities.map((facility, index) => {
        const icon = FACILITY_ICONS[facility.type] || '📍';
        const color = FACILITY_COLORS[facility.type] || '#6366f1';

        // Create custom marker element
        const el = document.createElement('div');
        el.style.cssText = `
            width:48px;
            height:48px;
            background:${color};
            border:3px solid white;
            border-radius:50%;
            display:flex;
            align-items:center;
            justify-content:center;
            font-size:24px;
            box-shadow:0 4px 12px rgba(0,0,0,0.3);
            cursor:pointer;
            position:relative;
        `;
        el.innerHTML = icon;

        // Add rank badge
        const badge = document.createElement('div');
        badge.style.cssText = `
            position:absolute;
            top:-8px;
            right:-8px;
            width:24px;
            height:24px;
            background:white;
            border:2px solid ${color};
            border-radius:50%;
            display:flex;
            align-items:center;
            justify-content:center;
            font-size:12px;
            font-weight:bold;
            color:${color};
        `;
        badge.textContent = index + 1;
        el.appendChild(badge);

        // Create marker
        const marker = new maplibregl.Marker({ element: el })
            .setLngLat([parseFloat(facility.facility_lon), parseFloat(facility.facility_lat)])
            .addTo(state.map);

        // Add click handler for popup
        el.addEventListener('click', () => {
            new maplibregl.Popup({ 
                offset: 25, 
                closeButton: true, 
                closeOnClick: true 
            })
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

    // --- Build Summary ---
    const closest = data.facilities[0];
    const icon = FACILITY_ICONS[facilityType] || '📍';
    const list = data.facilities.map((f, i) => 
        `${i + 1}. ${FACILITY_ICONS[f.type] || '📍'} ${f.name} (${f.travel_minutes} min)`
    ).join('<br>');

    showInfo(`
        ✅ Found ${data.count} ${facilityType}${data.count > 1 ? 's' : ''} within ${state.searchDistanceKm}km
        <br><strong>Closest:</strong> ${icon} ${closest.name}
        <br><strong>Travel time:</strong> ${closest.travel_minutes} minutes
        ${closest.crow_distance_km ? `<br><small>Straight-line: ${closest.crow_distance_km.toFixed(1)} km</small>` : ''}
        <br><br><small style="font-size:0.85rem;">${list}</small>
    `);

    // --- Fit Map to Results ---
    const bounds = new maplibregl.LngLatBounds();
    bounds.extend([lngLat.lng, lngLat.lat]);
    data.facilities.forEach(f => {
        bounds.extend([parseFloat(f.facility_lon), parseFloat(f.facility_lat)]);
    });
    
    state.map.fitBounds(bounds, { 
        padding: { top: 80, bottom: 80, left: 80, right: 80 }, 
        maxZoom: 14, 
        duration: 1000 
    });
}

// ============================================================================
// SECTION 12: SERVICE AREA MODE
// ============================================================================
// Calculate reachable area within time limit

/**
 * Handle map clicks in service area mode
 * Calculates what area is reachable within X minutes from clicked point
 * @param {Object} lngLat - Service center coordinates {lng, lat}
 */
function handleServiceClick(lngLat) {
    // Clear previous service area
    clearServiceArea();
    
    // Remove old marker if exists
    if (state.markers.service) {
        state.markers.service.remove();
    }
    
    // Place service center marker
    state.markers.service = new maplibregl.Marker({ 
        element: createMarker('🚚', '#1c2ae1')  // Blue truck marker
    })
        .setLngLat(lngLat)
        .addTo(state.map);
    
    calculateServiceArea(lngLat);
}

/**
 * Calculate and display service area
 * Shows what area is reachable within the specified time
 * @param {Object} lngLat - Service center coordinates {lng, lat}
 */
async function calculateServiceArea(lngLat) {
    showInfo(`⏳ Calculating ${state.serviceMinutes}-min service area...`);
    
    try {
        // Fetch service area data
        const data = await fetchWithTimeout(
            `${API_ENDPOINTS.serviceArea}?lon=${lngLat.lng}&lat=${lngLat.lat}&minutes=${state.serviceMinutes}`
        );
        
        if (data.error) {
            throw new Error(data.error);
        }

        // Remove old service area layers
        ['service-network', 'service-hull', 'service-border'].forEach(id => {
            if (state.map.getLayer(id)) state.map.removeLayer(id);
            if (state.map.getSource(id)) state.map.removeSource(id);
        });

        // --- Add Reachable Network Layer ---
        // Shows actual road network that's reachable
        state.map.addSource('service-network', { 
            type: 'geojson', 
            data: data.reachable_network 
        });
        state.map.addLayer({ 
            id: 'service-network', 
            type: 'line', 
            source: 'service-network', 
            paint: { 
                'line-color': '#f59e0b',  // Orange
                'line-width': 3, 
                'line-opacity': 0.6 
            } 
        });

        // --- Add Service Area Polygon ---
        // Shows approximate coverage area (convex hull)
        state.map.addSource('service-hull', { 
            type: 'geojson', 
            data: data.service_area 
        });
        
        // Fill layer
        state.map.addLayer({ 
            id: 'service-hull', 
            type: 'fill', 
            source: 'service-hull', 
            paint: { 
                'fill-color': '#dc2626',  // Red
                'fill-opacity': 0.15 
            } 
        });
        
        // Border layer
        state.map.addLayer({ 
            id: 'service-border', 
            type: 'line', 
            source: 'service-hull', 
            paint: { 
                'line-color': '#dc2626', 
                'line-width': 4, 
                'line-dasharray': [3, 2],  // Dashed line
                'line-opacity': 0.8 
            } 
        });

        // Fit map to service area
        if (data.service_area.coordinates?.[0]) {
            const bounds = new maplibregl.LngLatBounds();
            data.service_area.coordinates[0].forEach(c => bounds.extend(c));
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
// SECTION 13: SEARCH FUNCTIONALITY (Elasticsearch)
// ============================================================================
// Search for building units and floors with 3D visualization

/**
 * Search for building units or floors
 * Queries Elasticsearch index and displays results
 */
async function searchUnits() {
    const queryText = document.getElementById('searchInput').value.trim();
    const resultsDiv = document.getElementById('results');

    // Validate input
    if (!queryText) {
        resultsDiv.innerHTML = '<div class="no-results">Please enter a search term</div>';
        return;
    }

    resultsDiv.innerHTML = '<div class="loading">Searching...</div>';
    clearHighlight();

    // Determine which index to search
    const index = currentDataset === 'units' ? 'building_units' : 'buildings_vertical';
    
    // Define which fields to search (with boost values)
    const fields = currentDataset === 'units'
        ? ['UNIT_ID', 'NAME^2', 'NAME_LONG', 'UnitAddres', 'LabelNames']
        : ['UnitAddress^3', 'ShortAddress^1.8', 'fkFloorID^1.5', 'FloorUsage'];

    // Build Elasticsearch query
    const esQuery = { 
        query: { 
            multi_match: { 
                query: queryText, 
                fields, 
                type: 'best_fields', 
                fuzziness: 'AUTO'  // Allow fuzzy matching
            } 
        }, 
        size: 20  // Limit results
    };

    try {
        // Execute search
        const response = await fetch(`${ES_URL}/${index}/_search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(esQuery)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        resultsDiv.innerHTML = '';

        // Check for results
        if (data.hits.hits.length === 0) {
            resultsDiv.innerHTML = '<div class="no-results">No results found.</div>';
            return;
        }

        // Display each result
        data.hits.hits.forEach(hit => {
            const doc = hit._source;
            const item = document.createElement('div');
            item.className = 'result-item';

            // Format based on dataset type
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

            // Add click handler to zoom to feature
            item.onclick = () => zoomToFeature(doc, item);
            resultsDiv.appendChild(item);
        });

    } catch (err) {
        console.error('Search error:', err);
        resultsDiv.innerHTML = `<div class="error">Error: ${err.message}<br><small>Check console for details</small></div>`;
    }
}

/**
 * Calculate popup anchor position relative to feature bounds
 * Places popup to the right and slightly below center
 * @param {Object} bounds - MapLibre bounds object
 * @returns {Array} [lng, lat] coordinates for popup
 */
function getPopupAnchorPosition(bounds) {
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    return [
        ne.lng + (ne.lng - sw.lng) * 0.3,  // 30% to the right
        sw.lat + (ne.lat - sw.lat) * 0.65  // 65% up from bottom
    ];
}

/**
 * Zoom to and highlight a search result feature
 * Switches to 3D view and displays feature information
 * @param {Object} feature - Feature data from Elasticsearch
 * @param {HTMLElement} clickedElement - Clicked result item element
 */
async function zoomToFeature(feature, clickedElement) {
    if (!state.map) {
        console.warn('Map not ready');
        return;
    }

    // Clear previous highlights and mark new selection
    clearHighlight();
    clickedElement.classList.add('active');

    // Validate geometry
    if (!feature.geometry) {
        alert('No geometry available for this feature.');
        return;
    }

    // Calculate feature bounds
    const bounds = new maplibregl.LngLatBounds();
    const flattenCoords = (arr) => {
        if (typeof arr[0] === 'number') {
            bounds.extend([arr[0], arr[1]]);
        } else {
            arr.forEach(flattenCoords);
        }
    };
    flattenCoords(feature.geometry.coordinates);
    
    if (bounds.isEmpty()) {
        alert('No valid geometry found.');
        return;
    }

    // Calculate popup position
    const popupPosition = getPopupAnchorPosition(bounds);

    // --- Build Popup HTML ---
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

    // Function to add highlight and animate camera
    const afterStyleLoad = () => {
        addHighlightAndAnimate(feature, bounds, popupPosition, popupHTML);
    };

    // Switch to 3D BDF style if not already active
    const bdfStyle = STYLES.find(s => s.id === 'bdf-style');
    if (currentStyleId !== 'bdf-style') {
        state.map.setStyle(bdfStyle.url);
        currentStyleId = 'bdf-style';
        state.map.once('idle', afterStyleLoad);
    } else {
        afterStyleLoad();
    }
}

/**
 * Add 3D highlight and animate camera to feature
 * Creates extruded polygon to highlight building/unit in 3D
 * @param {Object} feature - Feature to highlight
 * @param {Object} bounds - Feature bounds
 * @param {Array} popupPosition - Where to place popup [lng, lat]
 * @param {string} popupHTML - HTML content for popup
 */
function addHighlightAndAnimate(feature, bounds, popupPosition, popupHTML) {
    // Get layer ordering
    const layers = state.map.getStyle().layers || [];
    const beforeId = layers.length > 0 ? layers[layers.length - 1].id : undefined;
    
    // Create safe layer ID
    const safeId = (feature.UNIT_ID || feature.fkFloorID || feature.UnitAddress || 'feat')
        .replace(/[^a-z0-9]/gi, '-');
    const id = `highlight-${safeId}`;

    // Track for cleanup
    currentHighlightIds.push(id);
    
    // Add feature source
    state.map.addSource(id, { 
        type: 'geojson', 
        data: { 
            type: 'Feature', 
            geometry: feature.geometry, 
            properties: { ...feature } 
        } 
    });

    // Calculate extrusion heights based on dataset
    let extrusionBase, extrusionHeight;
    if (currentDataset === 'units') {
        // Units: use Base and HEIGHT properties
        extrusionBase = feature.Base || 0;
        extrusionHeight = extrusionBase + (feature.HEIGHT || 4.25);
    } else {
        // Floors: calculate from building height and floor number
        const floorH = (feature.BuildingHeight || 0) / (feature.NoofFloors || 1);
        extrusionBase = floorH * (feature.FloorNumber || 0);
        extrusionHeight = extrusionBase + floorH;
    }

    // Add 3D extrusion layer
    state.map.addLayer({
        id, 
        type: 'fill-extrusion', 
        source: id,
        paint: { 
            'fill-extrusion-color': '#ff5c00',      // Orange highlight
            'fill-extrusion-opacity': 0.95, 
            'fill-extrusion-height': ['+', extrusionHeight, 1],  // Slightly above
            'fill-extrusion-base': extrusionBase 
        }
    }, beforeId);

    // Animate camera to feature
    state.map.fitBounds(bounds, { 
        padding: { 
            top: 100, 
            bottom: 100, 
            left: 420,  // Extra padding for search panel
            right: 100 
        }, 
        pitch: 60,          // Tilted view
        bearing: -18,       // Slight rotation
        minZoom: 16, 
        maxZoom: 19.5, 
        duration: 1600, 
        essential: true 
    });

    // Show popup after camera animation
    setTimeout(() => {
        currentPopup = new maplibregl.Popup({ 
            offset: [15, 0], 
            closeButton: true, 
            className: 'unit-popup', 
            maxWidth: '300px', 
            anchor: 'left' 
        })
            .setLngLat(popupPosition)
            .setHTML(popupHTML)
            .addTo(state.map);
        
        currentPopup.on('close', () => {
            currentPopup = null;
        });
    }, 800);
}

// ============================================================================
// SECTION 14: UTILITY FUNCTIONS
// ============================================================================
// Shared helper functions used throughout the application

/**
 * Fetch with timeout
 * Wraps fetch() with automatic timeout handling
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @returns {Promise} Response JSON
 */
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

/**
 * Handle and display errors
 * Logs error and shows user-friendly message
 * @param {string} context - What operation failed
 * @param {Error} error - Error object
 */
function handleError(context, error) {
    console.error(`${context} error:`, error);
    
    // Friendly error message for network issues
    const message = error.message.includes('Failed to fetch')
        ? 'Network error. Check your connection and try again.'
        : error.message;
    
    showInfo(`❌ ${message}`);
}

/**
 * Create a custom marker element
 * @param {string} text - Text to display in marker
 * @param {string} bgColor - Background color (hex)
 * @returns {HTMLElement} Marker element
 */
function createMarker(text, bgColor = null) {
    const el = document.createElement('div');
    el.className = 'marker';
    
    // Apply special styles for certain markers
    if (text === '🚚') el.classList.add('marker-service');
    if (text === 'E') el.classList.add('marker-end');
    
    if (bgColor) {
        el.style.backgroundColor = bgColor;
    }
    
    el.textContent = text;
    return el;
}

/**
 * Show information in the info panel
 * @param {string} text - HTML text to display
 */
function showInfo(text) {
    const infoBox = document.getElementById('info-box');
    const routeInfo = document.getElementById('route-info');
    
    if (infoBox && routeInfo) {
        infoBox.classList.remove('hidden');
        routeInfo.innerHTML = text;
    }
}

/**
 * Add a route layer to the map
 * @param {Object} data - GeoJSON FeatureCollection
 * @param {string} color - Line color (hex)
 * @param {number} opacity - Line opacity (0-1)
 * @param {number} width - Line width in pixels
 * @param {string} layerId - Unique layer ID
 */
function addRouteLayer(data, color, opacity = 0.9, width = 7, layerId = 'route') {
    // Remove existing layer/source if present
    if (state.map.getLayer(layerId)) state.map.removeLayer(layerId);
    if (state.map.getSource(layerId)) state.map.removeSource(layerId);

    // Add new source
    state.map.addSource(layerId, { type: 'geojson', data });
    
    // Add new layer
    state.map.addLayer({
        id: layerId, 
        type: 'line', 
        source: layerId,
        layout: { 
            'line-join': 'round',  // Smooth corners
            'line-cap': 'round'    // Rounded ends
        },
        paint: { 
            'line-color': color, 
            'line-width': width, 
            'line-opacity': opacity 
        }
    });
}

/**
 * Fit map view to GeoJSON features
 * @param {Object} data - GeoJSON FeatureCollection
 */
function fitToFeatures(data) {
    const bounds = new maplibregl.LngLatBounds();
    
    // Extend bounds to include all coordinates
    data.features.forEach(f => {
        if (f.geometry?.coordinates) {
            f.geometry.coordinates.forEach(c => bounds.extend(c));
        }
    });
    
    // Animate to bounds
    state.map.fitBounds(bounds, { 
        padding: 80, 
        maxZoom: 15, 
        duration: 1500 
    });
}

// ============================================================================
// SECTION 15: CLEANUP FUNCTIONS
// ============================================================================
// Functions to remove layers, markers, and reset state

/**
 * Clear all route layers from the map
 * Removes both single and alternative route layers
 */
function clearRouteLayers() {
    // Remove alternative route layers (support up to 20 alternatives)
    for (let i = 0; i < 20; i++) {
        const layerId = `route-${i}`;
        if (state.map.getLayer(layerId)) state.map.removeLayer(layerId);
        if (state.map.getSource(layerId)) state.map.removeSource(layerId);
    }
    
    // Remove old single route layer (backward compatibility)
    if (state.map.getLayer('route')) state.map.removeLayer('route');
    if (state.map.getSource('route')) state.map.removeSource('route');

    state.currentRouteData = null;
}

/**
 * Clear facility search data
 * Removes facility markers and route layers
 */
function clearFacilityData() {
    // Remove search location marker
    if (state.markers.facility) {
        state.markers.facility.remove();
        state.markers.facility = null;
    }

    // Remove all facility result markers
    state.facilityMarkers.forEach(m => m.remove());
    state.facilityMarkers = [];

    // Remove facility route layers
    ['facility-routes'].forEach(id => {
        if (state.map.getLayer(id)) state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    });
}

/**
 * Clear service area visualization
 * Removes service area polygon and network layers
 */
function clearServiceArea() {
    ['service-network', 'service-hull', 'service-border'].forEach(id => {
        if (state.map.getLayer(id)) state.map.removeLayer(id);
        if (state.map.getSource(id)) state.map.removeSource(id);
    });
}

/**
 * Clear search result highlights
 * Removes Elasticsearch result highlights and popups
 */
function clearHighlight() {
    // Remove all highlight layers
    currentHighlightIds.forEach(id => {
        if (state.map?.getLayer(id)) state.map.removeLayer(id);
        if (state.map?.getSource(id)) state.map.removeSource(id);
    });
    currentHighlightIds = [];

    // Close popup if open
    if (currentPopup) {
        currentPopup.remove();
        currentPopup = null;
    }

    // Remove active class from result items
    document.querySelectorAll('.result-item').forEach(el => {
        el.classList.remove('active');
    });
}

/**
 * MASTER CLEANUP FUNCTION
 * Clears everything and resets to initial state
 * Called when switching modes or resetting the application
 */
function clearAll() {
    // Clear all feature layers
    clearRouteLayers();
    clearFacilityData();
    clearServiceArea();
    clearHighlight();
    clearFeatureHighlight();

    // Remove all markers
    Object.keys(state.markers).forEach(key => {
        if (key === 'tsp') {
            // TSP markers are stored in array
            state.markers.tsp.forEach(item => item.marker?.remove());
            state.markers.tsp = [];
        } else if (state.markers[key]) {
            // Single markers
            state.markers[key].remove();
            state.markers[key] = null;
        }
    });

    // Reset route data
    state.currentRouteData = null;

    // Show ready message
    showInfo('Click to start');
}

// ============================================================================
// SECTION 16: APPLICATION INITIALIZATION
// ============================================================================
// Start the application when page loads

/**
 * Initialize the application
 * This is the entry point that runs when the DOM is ready
 */
window.addEventListener('load', initMap);

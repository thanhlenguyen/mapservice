const STYLES = [
    { id: 'basic', name: 'Default', url: 'http://tileserver.172-17-65-26.sslip.io/styles/basic-style/style.json', pitch: 0, zoom: 12 },
    { id: 'sat', name: 'Satellite', url: 'http://tileserver.172-17-65-26.sslip.io/styles/sat-style/style.json', pitch: 0, zoom: 12 },
    { id: '3d', name: '3D', url: 'http://tileserver.172-17-65-26.sslip.io/styles/3d-style/style.json', pitch: 45, zoom: 14 }
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

// ── The rest of your functions remain the same ──
// (handleRouteClick, handleTSPClick, handleFacilityClick, handleCrimeClick, etc.)

// Just make sure these are present:
function handleFacilityClick(lngLat) {
    // ... your existing facility click logic ...
}

function clearAll() {
    // ... your existing clear logic ...
    // Make sure to also clean facility layers if needed
    if (map.getLayer('facility-lines')) map.removeLayer('facility-lines');
    if (map.getLayer('facility-points')) map.removeLayer('facility-points');
    if (map.getSource('facility-results')) map.removeSource('facility-results');
    facilityMarker?.remove();
}

// Initialize
window.addEventListener('load', initMap);
// Add PMTiles protocol support (using the global PMTiles object from UMD build)

let protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// Optional cleanup on unload
window.addEventListener('unload', () => maplibregl.removeProtocol("pmtiles"));

// ---------- 1. Define the three styles ----------
const STYLES = [
    { id: 'basic-style', name: 'Default',   url: 'http://map.172-17-65-26.sslip.io/styles/pmtiles/style.json', pitch: 0, zoom: 12, bearing: 0 },
    { id: 'sat-style',   name: 'Satellite', url: 'http://map.172-17-65-26.sslip.io/styles/pmtiles/style_sat.json', pitch: 0, zoom: 12, bearing: 0 },
    { id: '3d-style',    name: '3D',        url: 'http://map.172-17-65-26.sslip.io/styles/pmtiles/style_3d.json', pitch: 45, zoom: 14, bearing: 0 }
];
// ---------- 2. Track current view to preserve user navigation ----------
let currentCenter = [46.6753, 24.7136];
let currentZoom = 10;
let currentPitch = 0;
let currentBearing = 0;

// ---------- 3. Initialize map ----------
let map;
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

    // Update current view on move
    map.on('moveend', () => {
        currentCenter = map.getCenter();
        currentZoom = map.getZoom();
        currentPitch = map.getPitch();
        currentBearing = map.getBearing();
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
        console.log('Map loaded with style:', STYLES[0].name);
        applyViewForStyle(STYLES[0]); // apply default view
    });

    // map.on('error', e => showErrorMessage('MapLibre error: ' + (e.error?.message || e.error)));
}

// ---------- 4. Apply view settings for a given style ----------
function applyViewForStyle(style) {
    map.easeTo({
        center: currentCenter,
        zoom: style.zoom ?? currentZoom,
        pitch: style.pitch,
        bearing: style.bearing ?? currentBearing,
        duration: 1000,        // smooth 1-second transition
        easing: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    });
}

// ---------- 5. Layer Switcher Control ----------
class LayerSwitcherControl {
    onAdd(map) {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

        STYLES.forEach((s, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'maplibregl-ctrl-icon w-10 h-10 flex items-center justify-center text-sm font-medium border-b border-gray-200 hover:bg-gray-100';
            btn.title = s.name;
            btn.textContent = s.name === '3D' ? '3D' : s.name.charAt(0);
            btn.dataset.styleId = s.id;

            if (idx === 0) btn.classList.add('bg-blue-100');

            btn.addEventListener('click', () => {
                // Update active button
                this._container.querySelectorAll('button').forEach(b => b.classList.remove('bg-blue-100'));
                btn.classList.add('bg-blue-100');

                // Load new style
                map.setStyle(s.url);

                // Once new style loads, apply its view settings
                map.once('styledata', () => {
                    applyViewForStyle(s);
                    console.log(`Switched to ${s.name} with pitch: ${s.pitch}`);
                });
            });

            this._container.appendChild(btn);
        });

        return this._container;
    }

    onRemove() {
        this._container.parentNode.removeChild(this._container);
    }
}

// ---------- 6. Start everything ----------
window.onload = () => {
    initMap();
    map.addControl(new LayerSwitcherControl(), 'bottom-right');
};

// ---------- 7. Error overlay (unchanged) ----------
// function showErrorMessage(message) {
//     const container = document.getElementById('map');
//     const errorBox = document.createElement('div');
//     errorBox.className = 'fixed inset-0 bg-red-500 bg-opacity-90 flex items-center justify-center p-6 z-50';
//     errorBox.innerHTML = `
//         <div class="bg-white p-8 rounded-lg shadow-xl max-w-lg text-center">
//             <h2 class="text-2xl font-bold text-red-600 mb-4">Connection Error</h2>
//             <p class="text-gray-700 mb-6">${message}</p>
//             <p class="text-sm text-gray-500">Check Docker containers (tileserver-gl on :8080).</p>
//         </div>
//     `;
//     container.appendChild(errorBox);
// }

let rhinePoints = [];
let places = [];
let selectedDestination = null;
let followVessel = true; // Map lock tracking state
let lockDelayMinutes = 30; // Configurable lock overhead parameter

// Realistic inland vessel SVG — pointed upward = 0° heading reference
const shipSvg = `
<div class="vessel-icon-container" id="vesselRotator">
  <svg class="vessel-svg" viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Hull: flat bottom, tapered bow at top -->
    <path d="M10 36 L6 20 L8 8 L16 2 L24 8 L26 20 L22 36 Z"
          fill="#1a3a5c" stroke="#4dd9e8" stroke-width="1.2" stroke-linejoin="round"/>
    <!-- Waterline band -->
    <path d="M7.5 22 L24.5 22" stroke="#4dd9e8" stroke-width="0.8" opacity="0.5"/>
    <!-- Superstructure / wheelhouse -->
    <rect x="12" y="14" width="8" height="7" rx="1"
          fill="#0e2a44" stroke="#4dd9e8" stroke-width="0.9"/>
    <!-- Wheelhouse windows -->
    <rect x="13.5" y="15.5" width="2" height="2" rx="0.4" fill="#4dd9e8" opacity="0.9"/>
    <rect x="16.5" y="15.5" width="2" height="2" rx="0.4" fill="#4dd9e8" opacity="0.9"/>
    <!-- Mast -->
    <line x1="16" y1="4" x2="16" y2="14" stroke="#4dd9e8" stroke-width="0.8" opacity="0.7"/>
    <!-- Bow light -->
    <circle cx="16" cy="3.5" r="1.2" fill="#ffffff" opacity="0.95"/>
  </svg>
</div>`;

const vesselIcon = L.divIcon({
  className: '',
  html: shipSvg,
  iconSize: [32, 40],
  iconAnchor: [16, 20]
});

// Polyline asset instance mapping the river route trailing line
let routeLine = null;

const basePath = window.location.pathname.endsWith('/') 
  ? window.location.pathname.slice(0, -1) 
  : window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/'));

// Fetch GeoJSON coordinates
fetch(`${basePath}/rhine.geojson`)
  .then(r => r.ok ? r.json() : null)
  .then(data => {
    if(!data) return;
    // Keep raw nodes ordered to build trailing polylines correctly
    rhinePoints = data.features
      .filter(f => f.properties.SPLIT === 1)
      .map(f => ({
        km:  Number(f.properties.KM1),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0]
      })).sort((a,b) => a.km - b.km);
    console.log('Coordinates initialized:', rhinePoints.length);
  });

// Fetch destinations checklist
fetch(`${basePath}/rhine-places.json`)
  .then(r => r.ok ? r.json() : [])
  .then(data => {
    places = data;
    const saved = localStorage.getItem('destination');
    if (saved) {
      selectedDestination = places.find(p => p.name === saved);
      if (searchInput) searchInput.value = saved;
      if (window.hudUpdate) window.hudUpdate({ dest: saved });
    }
  });

const map = L.map('map', { zoomControl: true }).setView([50, 7], 6);

// Base OSM layer (OpenSeaMap needs it underneath)
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// OpenSeaMap nautical overlay (buoys, depth contours, waterway marks, locks…)
L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  maxZoom: 18,
  opacity: 0.85,
  attribution: '© OpenSeaMap contributors'
}).addTo(map);

let marker = null;
let firstFix = true;
let lastValidHeading = 0; 
let previousCoords = null; 

// UI Elements Configuration references
const searchBtn    = document.getElementById('searchBtn');
const mapLockBtn   = document.getElementById('mapLockBtn');
const searchPanel  = document.getElementById('searchPanel');
const searchInput  = document.getElementById('destinationSearch');
const suggestions  = document.getElementById('suggestions');
const lockDelayInp = document.getElementById('lockDelayInput');

searchBtn.addEventListener('click', () => searchPanel.classList.toggle('open'));
map.on('click', () => searchPanel.classList.remove('open'));

// Follow / Free Scroll toggle logic
mapLockBtn.addEventListener('click', () => {
  followVessel = !followVessel;
  if(followVessel) {
    mapLockBtn.classList.remove('unlocked');
    mapLockBtn.style.color = "var(--cyan)";
    if(marker) map.panTo(marker.getLatLng());
  } else {
    mapLockBtn.classList.add('unlocked');
    mapLockBtn.style.color = "var(--muted)";
  }
});

// Track when users manually drag or zoom out, unlocking camera focus safely
map.on('movestart', (e) => {
  if (e.hard) return; // ignore code-based center pans
  if (followVessel) {
    followVessel = false;
    mapLockBtn.classList.add('unlocked');
    mapLockBtn.style.color = "var(--muted)";
  }
});

lockDelayInp.addEventListener('input', () => {
  lockDelayMinutes = Math.max(0, parseInt(lockDelayInp.value) || 0);
});

// Dropdown input search processing engine
searchInput.addEventListener('input', () => {
  const value = searchInput.value.toLowerCase().trim();
  suggestions.innerHTML = '';
  if (value.length < 1) return;

  places
    .filter(p => p.name.toLowerCase().includes(value))
    .slice(0, 15)
    .forEach(place => {
      const div = document.createElement('div');
      div.className = 'suggestion';

      const typeEl = document.createElement('span');
      typeEl.className = 'suggestion-type ' + (place.type || '');
      typeEl.textContent = (place.type || 'POI').toUpperCase();

      const nameEl = document.createElement('span');
      nameEl.textContent = place.name;

      const kmEl = document.createElement('span');
      kmEl.className = 'suggestion-km';
      kmEl.textContent = `KM ${place.km.toFixed(1)}`;

      div.appendChild(typeEl);
      div.appendChild(nameEl);
      div.appendChild(kmEl);

      div.onclick = () => {
        selectedDestination = place;
        localStorage.setItem('destination', place.name);
        searchInput.value = place.name;
        suggestions.innerHTML = '';
        searchPanel.classList.remove('open');
        if (window.hudUpdate) window.hudUpdate({ dest: place.name });
        triggerRouteRedraw(); 
      };
      suggestions.appendChild(div);
    });
});

// Calculations helper operations
function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getNearestPoints(lat, lon) {
  return [...rhinePoints]
    .map(p => ({ ...p, dist: distance(lat, lon, p.lat, p.lon) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 2);
}

function interpolateKm(lat, lon) {
  if (rhinePoints.length < 2) return null;

  // Search all consecutive segment pairs for the closest perpendicular projection.
  // Simple nearest-2-points can snap wrongly near bends where two distant segments
  // are equidistant; instead we test every segment and keep the best projected point.
  let bestKm   = null;
  let bestDist = Infinity;

  for (let i = 0; i < rhinePoints.length - 1; i++) {
    const a = rhinePoints[i];
    const b = rhinePoints[i + 1];

    // Represent segment and query point in a flat Cartesian approximation
    // (good enough for short river segments; avoids full spherical projection)
    const toRad = Math.PI / 180;
    const cosLat = Math.cos(((a.lat + b.lat) / 2) * toRad);

    const ax = a.lon * cosLat, ay = a.lat;
    const bx = b.lon * cosLat, by = b.lat;
    const px = lon  * cosLat, py = lat;

    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const ab2 = abx * abx + aby * aby;

    // Project p onto the segment ab, clamped to [0,1]
    const t = ab2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));

    const closestX = ax + t * abx;
    const closestY = ay + t * aby;

    // Actual geodesic distance from query to the projected point
    const closestLat = closestY;
    const closestLon = closestX / cosLat;
    const d = distance(lat, lon, closestLat, closestLon);

    if (d < bestDist) {
      bestDist = d;
      bestKm   = a.km + (b.km - a.km) * t;
    }
  }

  return bestKm;
}

// ── OSM Milestone Snapping ──────────────────────────────────────────────────
// Queries Overpass for waterway=milestone nodes near the vessel.
// Throttled: only fires when vessel has moved >200 m from last query point.
// Falls back to interpolateKm() if no milestone found within snap radius.

const SNAP_RADIUS_M   = 500;   // metres — search circle sent to Overpass
const SNAP_USE_M      = 300;   // metres — only snap if closest milestone is within this
const REQUERY_DIST_KM = 0.2;   // km     — minimum movement before re-querying Overpass

let lastQueryCoords  = null;   // {lat, lon} of last Overpass request
let cachedMilestones = [];     // last batch of milestone nodes returned
let kmSource         = 'EST';  // 'OSM' | 'EST' — shown in HUD

async function fetchNearbyMilestones(lat, lon) {
  const r = SNAP_RADIUS_M;
  const query = `[out:json][timeout:10];
node(around:${r},${lat},${lon})["waterway"="milestone"];
out body;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query
    });
    if (!res.ok) return [];
    const data = await res.json();
    // Keep only nodes that carry a numeric distance tag
    return (data.elements || []).filter(n => {
      const d = n.tags && (n.tags.distance || n.tags.name);
      return d && !isNaN(parseFloat(d));
    }).map(n => ({
      lat:  n.lat,
      lon:  n.lon,
      km:   parseFloat(n.tags.distance || n.tags.name)
    }));
  } catch (e) {
    console.warn('Overpass query failed:', e);
    return [];
  }
}

// Returns the best km value for the current position.
// Side-effect: updates kmSource and triggers a Overpass refresh when needed.
async function resolveKm(lat, lon) {
  // Decide whether to re-query Overpass
  const movedFar = !lastQueryCoords ||
    distance(lastQueryCoords.lat, lastQueryCoords.lon, lat, lon) >= REQUERY_DIST_KM;

  if (movedFar) {
    lastQueryCoords  = { lat, lon };
    cachedMilestones = await fetchNearbyMilestones(lat, lon);
  }

  // Find closest milestone in the cached batch
  if (cachedMilestones.length > 0) {
    let closest = null, closestDist = Infinity;
    for (const m of cachedMilestones) {
      const d = distance(lat, lon, m.lat, m.lon);
      if (d < closestDist) { closestDist = d; closest = m; }
    }
    if (closest && closestDist * 1000 <= SNAP_USE_M) {
      kmSource = 'OSM';
      return closest.km;
    }
  }

  // Fallback to GeoJSON interpolation
  kmSource = 'EST';
  return interpolateKm(lat, lon);
}
// ────────────────────────────────────────────────────────────────────────────

  const min = Math.min(currentKm, destinationKm);
  const max = Math.max(currentKm, destinationKm);
  return places.filter(p => p.type === 'lock' && p.km >= min && p.km <= max).length;
}

// Draw polyline pathway following exactly the river curves
function drawRiverPathLine(currentKm, destKm) {
  if (rhinePoints.length === 0) return;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }

  const start = Math.min(currentKm, destKm);
  const end = Math.max(currentKm, destKm);

  // Filter geo nodes falling directly inside bounding window
  const pathNodes = rhinePoints.filter(p => p.km >= start && p.km <= end);
  const latLngs = pathNodes.map(p => [p.lat, p.lon]);

  if (latLngs.length > 1) {
    routeLine = L.polyline(latLngs, {
      color: '#4dd9e8',
      weight: 4,
      opacity: 0.8,
      dashArray: '1, 8', // Pulse tech appearance lines
      lineCap: 'round'
    }).addTo(map);
  }
}

let lastCalculatedKm = null;
function triggerRouteRedraw() {
  if(lastCalculatedKm && selectedDestination) {
    drawRiverPathLine(lastCalculatedKm, selectedDestination.km);
  }
}

// ── Main Positioning Processing Stream
navigator.geolocation.watchPosition(
  async position => {
    const lat   = position.coords.latitude;
    const lon   = position.coords.longitude;
    const speed = (position.coords.speed || 0) * 3.6;
    const km    = await resolveKm(lat, lon);
    lastCalculatedKm = km;

    // Resolve true heading trajectory using hardware fallback matrix
    let heading = position.coords.heading;
    if (heading === null || isNaN(heading)) {
      if (previousCoords && distance(previousCoords.lat, previousCoords.lon, lat, lon) > 0.005) {
        // Calculate heading azimuth manually based on movement displacement vectors
        const dLon = (lon - previousCoords.lon) * Math.PI / 180;
        const lat1 = previousCoords.lat * Math.PI / 180;
        const lat2 = lat * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        heading = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      } else {
        heading = lastValidHeading;
      }
    }
    lastValidHeading = heading;
    previousCoords = { lat, lon };

    // Update marker or create asset instance
    if (!marker) {
      marker = L.marker([lat, lon], { icon: vesselIcon }).addTo(map);
    } else {
      marker.setLatLng([lat, lon]);
    }

    // CSS rotation execution directly injecting into active marker container instance element
    setTimeout(() => {
      const rotator = document.getElementById('vesselRotator');
      if (rotator) {
        rotator.style.transform = `rotate(${Math.round(heading)}deg)`;
      }
    }, 50);

    if (firstFix) {
      map.setView([lat, lon], 14);
      firstFix = false;
    } else if (followVessel) {
      map.panTo([lat, lon]);
    }

    const update = {
      km:     km ? km.toFixed(1) : '---.-',
      kmSrc:  kmSource,
      sog:    speed.toFixed(1),
      gps:    true
    };

    if (selectedDestination && km) {
      const distLeft = Math.abs(selectedDestination.km - km);
      const locks    = countLocks(km, selectedDestination.km);
      const ttlMin   = locks * lockDelayMinutes; 
      const moveSpd  = Math.max(speed, 1.5); 
      const etaHours = distLeft / moveSpd + ttlMin / 60;
      const etaH     = Math.floor(etaHours);
      const etaM     = Math.round((etaHours - etaH) * 60);

      update.rem   = distLeft.toFixed(1);
      update.locks = String(locks);
      update.ttl   = String(ttlMin);
      update.eta   = `${etaH}h${String(etaM).padStart(2,'0')}`;

      // Refresh path line matching current updated position point coordinates
      drawRiverPathLine(km, selectedDestination.km);
    } else {
      update.rem   = '---.-';
      update.locks = '--';
      update.ttl   = '--';
      update.eta   = '--h--';
      if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    }

    if (window.hudUpdate) window.hudUpdate(update);
  },
  error => {
    console.error(error);
    if (window.hudUpdate) window.hudUpdate({ gpsError: true });
  },
  { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
);

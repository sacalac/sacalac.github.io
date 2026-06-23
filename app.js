let rhinePoints = [];
let places = [];
let selectedDestination = null;
let followVessel = true; // Map lock tracking state
let lockDelayMinutes = 30; // Configurable lock overhead parameter

// ── Ship icon — proportional to real 135m vessel length ──────────────────────
// The SVG viewBox ratio is 20:100 (width:height). We scale height to match
// 135 real-world metres on the map at the current zoom level.
const SHIP_LENGTH_M = 135;
const SHIP_ASPECT   = 20 / 100; // width / height

function metersToPixels(meters, lat, zoom) {
  // Leaflet uses 256px tiles; each zoom doubles resolution
  const earthCircum = 2 * Math.PI * 6378137; // metres
  const metersPerPx = earthCircum * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, zoom));
  return meters / metersPerPx;
}

function buildShipSvg(heightPx) {
  const w = Math.max(4,  Math.round(heightPx * SHIP_ASPECT));
  const h = Math.max(10, Math.round(heightPx));
  return `
<div id="vesselRotator" style="width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;transition:transform 0.2s linear;">
  <svg width="${w}" height="${h}" viewBox="0 0 20 100" fill="none" xmlns="http://www.w3.org/2000/svg"
       style="filter:drop-shadow(0 0 4px rgba(77,217,232,0.9));">
    <path d="M10 2 L17 14 L17 88 Q17 98 10 98 Q3 98 3 88 L3 14 Z"
          fill="#1a3a5c" stroke="#4dd9e8" stroke-width="1" stroke-linejoin="round"/>
    <line x1="3" y1="74" x2="17" y2="74" stroke="#4dd9e8" stroke-width="0.6" opacity="0.4"/>
    <rect x="4.5" y="32" width="11" height="30" rx="1" fill="none" stroke="#4dd9e8" stroke-width="0.5" opacity="0.3"/>
    <line x1="10" y1="32" x2="10" y2="62" stroke="#4dd9e8" stroke-width="0.4" opacity="0.2"/>
    <rect x="5.5" y="16" width="9" height="11" rx="1" fill="#0e2a44" stroke="#4dd9e8" stroke-width="0.8"/>
    <rect x="6.5" y="17.5" width="2.5" height="2" rx="0.3" fill="#4dd9e8" opacity="0.85"/>
    <rect x="11"  y="17.5" width="2.5" height="2" rx="0.3" fill="#4dd9e8" opacity="0.85"/>
    <line x1="10" y1="4" x2="10" y2="16" stroke="#4dd9e8" stroke-width="0.7" opacity="0.6"/>
    <circle cx="10" cy="3"  r="1.4" fill="#ffffff" opacity="0.95"/>
    <circle cx="10" cy="97" r="1.1" fill="#ffcc00" opacity="0.8"/>
  </svg>
</div>`;
}

function makeVesselIcon(lat, zoom) {
  const h = metersToPixels(SHIP_LENGTH_M, lat, zoom);
  const w = Math.max(4, Math.round(h * SHIP_ASPECT));
  const hpx = Math.max(10, Math.round(h));
  return L.divIcon({
    className: '',
    html: buildShipSvg(h),
    iconSize:   [w, hpx],
    iconAnchor: [Math.round(w / 2), Math.round(hpx / 2)]
  });
}

// Start with a sensible default icon (lat 50, zoom 14)
let currentLat  = 50;
let vesselIcon  = makeVesselIcon(50, 14);

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

// Resize ship icon whenever zoom changes
map.on('zoom', () => {
  if (!marker) return;
  const newIcon = makeVesselIcon(currentLat, map.getZoom());
  marker.setIcon(newIcon);
  // Re-apply rotation after icon swap
  setTimeout(() => {
    const r = document.getElementById('vesselRotator');
    if (r) r.style.transform = `rotate(${Math.round(lastValidHeading)}deg)`;
  }, 30);
});

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
  let bestKm   = null;
  let bestDist = Infinity;

  for (let i = 0; i < rhinePoints.length - 1; i++) {
    const a = rhinePoints[i];
    const b = rhinePoints[i + 1];

    const toRad = Math.PI / 180;
    const cosLat = Math.cos(((a.lat + b.lat) / 2) * toRad);

    const ax = a.lon * cosLat, ay = a.lat;
    const bx = b.lon * cosLat, by = b.lat;
    const px = lon  * cosLat, py = lat;

    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const ab2 = abx * abx + aby * aby;

    const t = ab2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));

    const closestX = ax + t * abx;
    const closestY = ay + t * aby;

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
const SNAP_RADIUS_M   = 500;   
const SNAP_USE_M      = 300;   
const REQUERY_DIST_KM = 0.2;   

let lastQueryCoords  = null;   
let cachedMilestones = [];     
let kmSource         = 'EST';  

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

async function resolveKm(lat, lon) {
  const movedFar = !lastQueryCoords ||
    distance(lastQueryCoords.lat, lastQueryCoords.lon, lat, lon) >= REQUERY_DIST_KM;

  if (movedFar) {
    lastQueryCoords  = { lat, lon };
    cachedMilestones = await fetchNearbyMilestones(lat, lon);
  }

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

  kmSource = 'EST';
  return interpolateKm(lat, lon);
}
// ────────────────────────────────────────────────────────────────────────────

// FIXED: Added missing function declaration line
function countLocks(currentKm, destinationKm) {
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
  
  // FIXED: Standardize correctly back to arrays [lat, lon] expected by Leaflet polylines
  const latLngs = pathNodes.map(p => [p.lat, p.lon]);

  if (latLngs.length > 1) {
    routeLine = L.polyline(latLngs, {
      color: '#4dd9e8',
      weight: 4,
      opacity: 0.8,
      dashArray: '1, 8', 
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

    let heading = position.coords.heading;
    if (heading === null || isNaN(heading)) {
      if (previousCoords && distance(previousCoords.lat, previousCoords.lon, lat, lon) > 0.005) {
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
    currentLat = lat; // keep updated for zoom-based icon scaling

    // Update or create marker with correctly sized icon for current zoom
    const zoomedIcon = makeVesselIcon(lat, map.getZoom());
    if (!marker) {
      marker = L.marker([lat, lon], { icon: zoomedIcon }).addTo(map);
    } else {
      marker.setLatLng([lat, lon]);
      marker.setIcon(zoomedIcon);
    }

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
      const distLeft  = Math.abs(selectedDestination.km - km);
      const goingDown = selectedDestination.km < km;
      const minKm     = Math.min(km, selectedDestination.km);
      const maxKm     = Math.max(km, selectedDestination.km);

      // All locks between current position and destination in travel order
      const locksAhead = places
        .filter(p => p.type === 'lock' && p.km > minKm && p.km < maxKm)
        .sort((a, b) => goingDown ? b.km - a.km : a.km - b.km);

      const lockCount = locksAhead.length;
      const moveSpd   = Math.max(speed, 1.5);

      // Next lock: time as h:mm
      let nxtLckStr = '--';
      if (locksAhead.length > 0) {
        const kmToNext   = Math.abs(locksAhead[0].km - km);
        const totalMins  = Math.round((kmToNext / moveSpd) * 60);
        const nlH        = Math.floor(totalMins / 60);
        const nlM        = totalMins % 60;
        nxtLckStr        = nlH > 0
          ? `${nlH}h${String(nlM).padStart(2, '0')}`
          : `${nlM}m`;
      }

      // ETA: travel time + all lock delays
      const etaHours  = distLeft / moveSpd + (lockCount * lockDelayMinutes) / 60;
      const etaH      = Math.floor(etaHours);
      const etaM      = Math.round((etaHours - etaH) * 60);

      // Clock arrival time
      const arrival   = new Date(Date.now() + etaHours * 3600 * 1000);
      const hh        = String(arrival.getHours()).padStart(2, '0');
      const mm        = String(arrival.getMinutes()).padStart(2, '0');

      update.rem      = distLeft.toFixed(1);
      update.locks    = String(lockCount);
      update.nxtLck   = nxtLckStr;
      update.eta      = `${etaH}h${String(etaM).padStart(2, '0')}`;
      update.etaClock = `${hh}:${mm}`;

      drawRiverPathLine(km, selectedDestination.km);
    } else {
      update.rem      = '---.-';
      update.locks    = '--';
      update.nxtLck   = '--';
      update.eta      = '--h--';
      update.etaClock = '--:--';
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

// ── State ────────────────────────────────────────────────────────────────────
let rhinePoints         = [];
let places              = [];
let selectedDestination = null;
let followVessel        = true;
let headUpMode          = false;
let lockDelayMinutes    = 30;
let marker              = null;
let firstFix            = true;
let lastValidHeading    = 0;
let previousCoords      = null;
let lastCalculatedKm    = null;
let routeLine           = null;
let programmaticMove    = false;

// ── Ship Icon ────────────────────────────────────────────────────────────────
const shipSvg = `
<div class="vessel-icon-container" id="vesselRotator">
  <svg class="vessel-svg" viewBox="0 0 20 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 2 L17 14 L17 88 Q17 98 10 98 Q3 98 3 88 L3 14 Z"
          fill="#1a3a5c" stroke="#4dd9e8" stroke-width="1" stroke-linejoin="round"/>
    <line x1="3" y1="74" x2="17" y2="74" stroke="#4dd9e8" stroke-width="0.6" opacity="0.4"/>
    <rect x="4.5" y="32" width="11" height="30" rx="1"
          fill="none" stroke="#4dd9e8" stroke-width="0.5" opacity="0.3"/>
    <line x1="10" y1="32" x2="10" y2="62" stroke="#4dd9e8" stroke-width="0.4" opacity="0.2"/>
    <rect x="5.5" y="16" width="9" height="11" rx="1"
          fill="#0e2a44" stroke="#4dd9e8" stroke-width="0.8"/>
    <rect x="6.5"  y="17.5" width="2.5" height="2" rx="0.3" fill="#4dd9e8" opacity="0.85"/>
    <rect x="11"   y="17.5" width="2.5" height="2" rx="0.3" fill="#4dd9e8" opacity="0.85"/>
    <line x1="10" y1="4" x2="10" y2="16" stroke="#4dd9e8" stroke-width="0.7" opacity="0.6"/>
    <circle cx="10" cy="3"  r="1.4" fill="#ffffff" opacity="0.95"/>
    <circle cx="10" cy="97" r="1.1" fill="#ffcc00" opacity="0.8"/>
  </svg>
</div>`;

const vesselIcon = L.divIcon({
  className:  '',
  html:       shipSvg,
  iconSize:   [20, 100],
  iconAnchor: [10, 50]
});

// ── Base path ────────────────────────────────────────────────────────────────
const basePath = window.location.pathname.endsWith('/')
  ? window.location.pathname.slice(0, -1)
  : window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/'));

// ── Load GeoJSON river centreline ────────────────────────────────────────────
fetch(`${basePath}/rhine.geojson`)
  .then(r => r.ok ? r.json() : null)
  .then(data => {
    if (!data) return;
    rhinePoints = data.features
      .filter(f => f.properties.SPLIT === 1)
      .map(f => ({
        km:  Number(f.properties.KM1),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0]
      }))
      .sort((a, b) => a.km - b.km);
    console.log('Rhine points loaded:', rhinePoints.length);
  });

// ── Load places / locks ───────────────────────────────────────────────────────
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

// ── Map ───────────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([50, 7], 6);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  maxZoom: 18,
  opacity: 0.85,
  attribution: '© OpenSeaMap contributors'
}).addTo(map);

// ── UI element refs ───────────────────────────────────────────────────────────
const searchBtn    = document.getElementById('searchBtn');
const mapLockBtn   = document.getElementById('mapLockBtn');
const headingBtn   = document.getElementById('headingBtn');
const searchPanel  = document.getElementById('searchPanel');
const searchInput  = document.getElementById('destinationSearch');
const suggestions  = document.getElementById('suggestions');
const lockDelayInp = document.getElementById('lockDelayInput');

// ── Search panel ──────────────────────────────────────────────────────────────
searchBtn.addEventListener('click', () => searchPanel.classList.toggle('open'));
map.on('click', () => searchPanel.classList.remove('open'));

// ── Follow toggle ─────────────────────────────────────────────────────────────
function setFollow(on) {
  followVessel = on;
  if (on) {
    mapLockBtn.style.color       = 'var(--cyan)';
    mapLockBtn.style.borderColor = 'var(--border)';
    if (marker) {
      programmaticMove = true;
      map.panTo(marker.getLatLng());
      programmaticMove = false;
    }
  } else {
    mapLockBtn.style.color       = 'var(--muted)';
    mapLockBtn.style.borderColor = 'var(--border)';
  }
}

mapLockBtn.addEventListener('click', () => setFollow(!followVessel));

map.on('movestart', () => {
  if (programmaticMove) return;
  if (followVessel) setFollow(false);
});

// ── Head-up / North-up toggle ─────────────────────────────────────────────────
function applyMapBearing(heading) {
  if (map.setBearing) {
    map.setBearing(headUpMode ? heading : 0);
  }
}

headingBtn.addEventListener('click', () => {
  headUpMode = !headUpMode;
  if (headUpMode) {
    headingBtn.style.color       = 'var(--cyan)';
    headingBtn.style.borderColor = 'var(--cyan)';
    headingBtn.title = 'Head-up — tap for North-up';
  } else {
    headingBtn.style.color       = 'var(--muted)';
    headingBtn.style.borderColor = 'var(--border)';
    headingBtn.title = 'North-up — tap for Head-up';
    if (map.setBearing) map.setBearing(0);
  }
  applyMapBearing(lastValidHeading);
});

// ── Lock delay config ─────────────────────────────────────────────────────────
lockDelayInp.addEventListener('input', () => {
  lockDelayMinutes = Math.max(0, parseInt(lockDelayInp.value) || 0);
});

// ── Destination search ────────────────────────────────────────────────────────
searchInput.addEventListener('input', () => {
  const value = searchInput.value.toLowerCase().trim();
  suggestions.innerHTML = '';
  if (value.length < 1) return;

  places
    .filter(p => p.name.toLowerCase().includes(value))
    .slice(0, 15)
    .forEach(place => {
      const div     = document.createElement('div');
      div.className = 'suggestion';

      const typeEl = document.createElement('span');
      typeEl.className   = 'suggestion-type ' + (place.type || '');
      typeEl.textContent = (place.type || 'POI').toUpperCase();

      const nameEl = document.createElement('span');
      nameEl.textContent = place.name;

      const kmEl = document.createElement('span');
      kmEl.className   = 'suggestion-km';
      kmEl.textContent = `KM ${place.km.toFixed(1)}`;

      div.appendChild(typeEl);
      div.appendChild(nameEl);
      div.appendChild(kmEl);

      div.onclick = () => {
        selectedDestination = place;
        localStorage.setItem('destination', place.name);
        searchInput.value     = place.name;
        suggestions.innerHTML = '';
        searchPanel.classList.remove('open');
        if (window.hudUpdate) window.hudUpdate({ dest: place.name });
        triggerRouteRedraw();
      };
      suggestions.appendChild(div);
    });
});

// ── Distance helper ───────────────────────────────────────────────────────────
function distance(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── GeoJSON interpolation (fallback) ─────────────────────────────────────────
function interpolateKm(lat, lon) {
  if (rhinePoints.length < 2) return null;
  let bestKm = null, bestDist = Infinity;

  for (let i = 0; i < rhinePoints.length - 1; i++) {
    const a = rhinePoints[i];
    const b = rhinePoints[i + 1];

    const cosLat = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    const ax = a.lon * cosLat, ay = a.lat;
    const bx = b.lon * cosLat, by = b.lat;
    const px = lon   * cosLat, py = lat;

    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const ab2 = abx * abx + aby * aby;
    const t   = ab2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));

    const clat = ay + t * aby;
    const clon = (ax + t * abx) / cosLat;
    const d    = distance(lat, lon, clat, clon);

    if (d < bestDist) { bestDist = d; bestKm = a.km + (b.km - a.km) * t; }
  }
  return bestKm;
}

// ── OSM Milestone snapping (primary) ─────────────────────────────────────────
const MILESTONE_RADIUS_M = 2000;
const REQUERY_DIST_KM    = 0.5;

let lastQueryCoords  = null;
let cachedMilestones = [];
let kmSource         = 'EST';

async function fetchNearbyMilestones(lat, lon) {
  const query = `[out:json][timeout:15];
node(around:${MILESTONE_RADIUS_M},${lat},${lon})["waterway"="milestone"];
out body;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body:   query
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.elements || [])
      .filter(n => {
        const v = n.tags && (n.tags.distance || n.tags.name);
        return v && !isNaN(parseFloat(v));
      })
      .map(n => ({
        lat: n.lat,
        lon: n.lon,
        km:  parseFloat(n.tags.distance ?? n.tags.name)
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

  if (cachedMilestones.length >= 2) {
    const sorted = [...cachedMilestones]
      .map(m => ({ ...m, d: distance(lat, lon, m.lat, m.lon) }))
      .sort((a, b) => a.d - b.d);

    const a = sorted[0], b = sorted[1];
    const total = a.d + b.d;
    if (total > 0) {
      const wA = 1 - a.d / total;
      const wB = 1 - b.d / total;
      kmSource = 'OSM';
      return Math.round((a.km * wA + b.km * wB) / (wA + wB) * 10) / 10;
    }
    kmSource = 'OSM';
    return a.km;
  }

  if (cachedMilestones.length === 1) {
    const m = cachedMilestones[0];
    if (distance(lat, lon, m.lat, m.lon) < 1.0) {
      kmSource = 'OSM';
      return m.km;
    }
  }

  kmSource = 'EST';
  return interpolateKm(lat, lon);
}

// ── Route helpers ─────────────────────────────────────────────────────────────

// Returns all locks between current position and destination, in travel order
function getLocksAhead(currentKm, destinationKm) {
  const goingDownstream = destinationKm < currentKm;
  const min = Math.min(currentKm, destinationKm);
  const max = Math.max(currentKm, destinationKm);
  const locks = places
    .filter(p => p.type === 'lock' && p.km > min && p.km < max)
    .sort((a, b) => goingDownstream ? b.km - a.km : a.km - b.km);
  return locks;
}

// Returns km to the next lock ahead, or null if none
function kmToNextLock(currentKm, destinationKm) {
  const locks = getLocksAhead(currentKm, destinationKm);
  if (locks.length === 0) return null;
  return Math.abs(locks[0].km - currentKm);
}

// Returns minutes to reach the next lock at current speed
function minsToNextLock(currentKm, destinationKm, speedKmh) {
  const kmDist = kmToNextLock(currentKm, destinationKm);
  if (kmDist === null) return null;
  const spd = Math.max(speedKmh, 1.5);
  return Math.round((kmDist / spd) * 60);
}

function drawRiverPathLine(currentKm, destKm) {
  if (rhinePoints.length === 0) return;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }

  const start     = Math.min(currentKm, destKm);
  const end       = Math.max(currentKm, destKm);
  const pathNodes = rhinePoints.filter(p => p.km >= start && p.km <= end);
  const latLngs   = pathNodes.map(p => [p.lat, p.lon]);

  if (latLngs.length > 1) {
    routeLine = L.polyline(latLngs, {
      color:     '#4dd9e8',
      weight:    4,
      opacity:   0.8,
      dashArray: '1, 8',
      lineCap:   'round'
    }).addTo(map);
  }
}

function triggerRouteRedraw() {
  if (lastCalculatedKm && selectedDestination) {
    drawRiverPathLine(lastCalculatedKm, selectedDestination.km);
  }
}

// ── GPS watch ─────────────────────────────────────────────────────────────────
navigator.geolocation.watchPosition(
  async position => {
    const lat   = position.coords.latitude;
    const lon   = position.coords.longitude;
    const speed = (position.coords.speed || 0) * 3.6;
    const km    = await resolveKm(lat, lon);
    lastCalculatedKm = km;

    // Heading: device sensor preferred, computed bearing as fallback
    let heading = position.coords.heading;
    if (heading === null || isNaN(heading)) {
      if (previousCoords && distance(previousCoords.lat, previousCoords.lon, lat, lon) > 0.005) {
        const dLon = (lon - previousCoords.lon) * Math.PI / 180;
        const lat1 = previousCoords.lat * Math.PI / 180;
        const lat2 = lat * Math.PI / 180;
        const y    = Math.sin(dLon) * Math.cos(lat2);
        const x    = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        heading    = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      } else {
        heading = lastValidHeading;
      }
    }
    lastValidHeading = heading;
    previousCoords   = { lat, lon };

    // Place / update vessel marker
    if (!marker) {
      marker = L.marker([lat, lon], { icon: vesselIcon }).addTo(map);
    } else {
      marker.setLatLng([lat, lon]);
    }

    // Rotate ship icon to heading
    setTimeout(() => {
      const rotator = document.getElementById('vesselRotator');
      if (rotator) rotator.style.transform = `rotate(${Math.round(heading)}deg)`;
    }, 50);

    // Map follow + head-up bearing
    if (firstFix) {
      programmaticMove = true;
      map.setView([lat, lon], 14);
      programmaticMove = false;
      firstFix = false;
    } else if (followVessel) {
      programmaticMove = true;
      map.panTo([lat, lon]);
      programmaticMove = false;
    }
    applyMapBearing(heading);

    // ── HUD ──────────────────────────────────────────────────────────────────
    const update = {
      km:    km ? km.toFixed(1) : '---.-',
      kmSrc: kmSource,
      sog:   speed.toFixed(1),
      gps:   true
    };

    if (selectedDestination && km) {
      const distLeft  = Math.abs(selectedDestination.km - km);
      const locks     = getLocksAhead(km, selectedDestination.km);
      const lockCount = locks.length;

      // TTL = minutes to the NEXT lock ahead (not total delay)
      const nextLockMins = minsToNextLock(km, selectedDestination.km, speed);

      // ETA = travel time for all remaining km + lock delays
      const moveSpd  = Math.max(speed, 1.5);
      const etaHours = distLeft / moveSpd + (lockCount * lockDelayMinutes) / 60;

      const durH = Math.floor(etaHours);
      const durM = Math.round((etaHours - durH) * 60);

      const arrival = new Date(Date.now() + etaHours * 3600 * 1000);
      const clockH  = String(arrival.getHours()).padStart(2, '0');
      const clockM  = String(arrival.getMinutes()).padStart(2, '0');

      update.rem      = distLeft.toFixed(1);
      update.locks    = String(lockCount);
      update.ttl      = nextLockMins !== null ? String(nextLockMins) : '--';
      update.eta      = `${durH}h${String(durM).padStart(2, '0')}`;
      update.etaClock = `${clockH}:${clockM}`;

      drawRiverPathLine(km, selectedDestination.km);
    } else {
      update.rem      = '---.-';
      update.locks    = '--';
      update.ttl      = '--';
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

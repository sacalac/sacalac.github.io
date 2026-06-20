let branchPaths = []; 
let places = [];
let selectedDestination = null;
let followVessel = true;

const shipSvg = `
<div class="vessel-icon-container" id="vesselRotator">
  <svg class="vessel-svg" viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 36 L6 20 L8 8 L16 2 L24 8 L26 20 L22 36 Z" fill="#2563eb" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
    <path d="M7.5 22 L24.5 22" stroke="#ffffff" stroke-width="1" opacity="0.5"/>
    <rect x="12" y="14" width="8" height="7" rx="1" fill="#1e3a8a" stroke="#ffffff" stroke-width="1"/>
    <line x1="16" y1="4" x2="16" y2="14" stroke="#ffffff" stroke-width="1.5" opacity="0.9"/>
    <circle cx="16" cy="3.5" r="1.5" fill="#facc15" opacity="1"/>
  </svg>
</div>`;

const vesselIcon = L.divIcon({
  className: '',
  html: shipSvg,
  iconSize: [32, 40],
  iconAnchor: [16, 20]
});

let routeLine = null;

const basePath = window.location.pathname.endsWith('/') 
  ? window.location.pathname.slice(0, -1) 
  : window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/'));

// Load Rhine Coordinates (Multi-branch fix)
fetch(`${basePath}/rhine.geojson`)
  .then(r => r.ok ? r.json() : null)
  .then(data => {
    if(!data) return;
    const groups = {};
    data.features.filter(f => f.properties.SPLIT === 1).forEach(f => {
      const fluss = f.properties.FLUSS || 'main';
      if (!groups[fluss]) groups[fluss] = [];
      groups[fluss].push({
        km:  Number(f.properties.KM1),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0]
      });
    });
    branchPaths = Object.values(groups).map(branch => branch.sort((a,b) => a.km - b.km));
  });

// Load Places
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

// Clean, bright map layer for tourists
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let marker = null;
let firstFix = true;
let lastValidHeading = 0; 
let previousCoords = null; 

const searchBtn    = document.getElementById('searchBtn');
const mapLockBtn   = document.getElementById('mapLockBtn');
const searchPanel  = document.getElementById('searchPanel');
const searchInput  = document.getElementById('destinationSearch');
const suggestions  = document.getElementById('suggestions');

searchBtn.addEventListener('click', () => searchPanel.classList.toggle('open'));
map.on('click', () => searchPanel.classList.remove('open'));

mapLockBtn.addEventListener('click', () => {
  followVessel = !followVessel;
  if(followVessel) {
    mapLockBtn.classList.remove('unlocked');
    mapLockBtn.style.color = "var(--water-blue)";
    if(marker) map.panTo(marker.getLatLng());
  } else {
    mapLockBtn.classList.add('unlocked');
    mapLockBtn.style.color = "var(--text-muted)";
  }
});

map.on('movestart', (e) => {
  if (e.hard) return; 
  if (followVessel) {
    followVessel = false;
    mapLockBtn.classList.add('unlocked');
    mapLockBtn.style.color = "var(--text-muted)";
  }
});

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
      typeEl.className = 'suggestion-type';
      typeEl.textContent = (place.type || 'TOWN').toUpperCase();

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

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function interpolateKm(lat, lon) {
  if (branchPaths.length === 0) return null;

  let bestKm   = null;
  let bestDist = Infinity;

  for (const branch of branchPaths) {
    for (let i = 0; i < branch.length - 1; i++) {
      const a = branch[i];
      const b = branch[i + 1];

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
      const d = n.tags && (n.tags.distance || n.tags.name || n.tags['seamark:distance:value']);
      return d && !isNaN(parseFloat(d));
    }).map(n => ({
      lat:  n.lat,
      lon:  n.lon,
      km:   parseFloat(n.tags.distance || n.tags.name || n.tags['seamark:distance:value'])
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

  const currentEstKm = interpolateKm(lat, lon);

  if (cachedMilestones.length > 0) {
    let closest = null, closestDist = Infinity;
    for (const m of cachedMilestones) {
      const d = distance(lat, lon, m.lat, m.lon);
      if (d < closestDist) { closestDist = d; closest = m; }
    }
    
    if (closest && closestDist * 1000 <= SNAP_USE_M) {
      kmSource = 'OSM';
      const milestoneEstKm = interpolateKm(closest.lat, closest.lon);
      
      if (milestoneEstKm !== null && currentEstKm !== null) {
        const offset = closest.km - milestoneEstKm;
        return currentEstKm + offset;
      }
      return closest.km;
    }
  }

  kmSource = 'EST';
  return currentEstKm;
}

function drawRiverPathLine(currentKm, destKm) {
  if (branchPaths.length === 0) return;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }

  const start = Math.min(currentKm, destKm);
  const end = Math.max(currentKm, destKm);

  let latLngsMulti = [];
  for (const branch of branchPaths) {
    const pathNodes = branch.filter(p => p.km >= start && p.km <= end);
    if (pathNodes.length > 1) {
      latLngsMulti.push(pathNodes.map(p => [p.lat, p.lon]));
    }
  }

  if (latLngsMulti.length > 0) {
    routeLine = L.polyline(latLngsMulti, {
      color: '#ef4444', // Red path for high visibility
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

// ── Main GPS Processing Stream
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

    if (!marker) {
      marker = L.marker([lat, lon], { icon: vesselIcon }).addTo(map);
    } else {
      marker.setLatLng([lat, lon]);
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
      update.dest = selectedDestination.name;
      drawRiverPathLine(km, selectedDestination.km);
    } else {
      update.dest = null;
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

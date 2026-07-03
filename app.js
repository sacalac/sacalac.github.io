let riverPaths = { rhine: [], moselle: [] };
let places = [];
let selectedDestination = null;

let followVessel = true;
let headUp = false;
let lockDelayMinutes = 30;

// River-km value at Koblenz (the Rhine/Moselle confluence) for each river's own numbering.
const CONFLUENCE = { rhine: 592.0, moselle: 0.0 };
const RIVER_LABEL = { rhine: 'Rhine', moselle: 'Moselle' };

// Speed averaging queue to prevent ETA jitter
let speedHistory = [];

let routeLayer = null;

const basePath = window.location.pathname.endsWith('/')
  ? window.location.pathname.slice(0, -1)
  : window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/'));

// ── Load a river's GeoJSON path into riverPaths[riverKey]
function loadRiverGeoJSON(url, riverKey) {
  return fetch(url)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data) return;
      const groups = {};
      data.features.filter(f => f.properties.SPLIT === 1).forEach(f => {
        const key = f.properties.FLUSS || 'main';
        if (!groups[key]) groups[key] = [];
        groups[key].push({
          km:  Number(f.properties.KM1),
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0]
        });
      });
      riverPaths[riverKey] = Object.values(groups).map(branch => branch.sort((a, b) => a.km - b.km));
    })
    .catch(e => console.error(`${riverKey} geojson error`, e));
}

// ── Load a river's places list, tagging each entry with its river
function loadPlaces(url, riverKey) {
  return fetch(url)
    .then(r => r.ok ? r.json() : [])
    .then(data => {
      data.forEach(p => p.river = riverKey);
      places = places.concat(data);
    })
    .catch(e => console.error(`${riverKey} places error`, e));
}

Promise.all([
  loadRiverGeoJSON(`${basePath}/rhine.geojson`, 'rhine'),
  loadRiverGeoJSON(`${basePath}/moselle.geojson`, 'moselle')
]);

Promise.all([
  loadPlaces(`${basePath}/rhine-places.json`, 'rhine'),
  loadPlaces(`${basePath}/moselle-places.json`, 'moselle')
]).then(() => {
  const saved = localStorage.getItem('destination');
  if (saved) {
    selectedDestination = places.find(p => p.name === saved);
    if (selectedDestination) {
      if (searchInput) searchInput.value = saved;
      if (window.hudUpdate) window.hudUpdate({ dest: `${selectedDestination.name} · ${RIVER_LABEL[selectedDestination.river]}` });
    }
  }
});

const map = L.map('map', { zoomControl: false }).setView([50, 7], 6);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  maxZoom: 18,
  opacity: 0.85,
  attribution: '© OpenSeaMap'
}).addTo(map);

let marker = null;
let firstFix = true;
let lastValidHeading = 0;
let previousCoords = null;

const searchBtn    = document.getElementById('searchBtn');
const mapLockBtn   = document.getElementById('mapLockBtn');
const headUpBtn    = document.getElementById('headUpBtn');
const searchPanel  = document.getElementById('searchPanel');
const searchInput  = document.getElementById('destinationSearch');
const suggestions  = document.getElementById('suggestions');
const lockDelayInp = document.getElementById('lockDelayInput');
const mapContainer = document.getElementById('map');

searchBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  searchPanel.classList.toggle('open');
});

mapLockBtn.addEventListener('click', () => {
  followVessel = !followVessel;
  if(followVessel) {
    mapLockBtn.classList.remove('unlocked');
    if(marker) map.panTo(marker.getLatLng());
  } else {
    headUp = false;
    mapContainer.style.transform = `rotate(0deg)`;
    headUpBtn.classList.remove('active');
    mapLockBtn.classList.add('unlocked');
  }
});

headUpBtn.addEventListener('click', () => {
  headUp = !headUp;
  if(headUp) {
    headUpBtn.classList.add('active');
    followVessel = true;
    mapLockBtn.classList.remove('unlocked');
    if(marker) map.panTo(marker.getLatLng());
  } else {
    headUpBtn.classList.remove('active');
    mapContainer.style.transform = `rotate(0deg)`;
  }
});

map.on('dragstart', () => {
  if (followVessel) {
    followVessel = false;
    headUp = false;
    mapContainer.style.transform = `rotate(0deg)`;
    headUpBtn.classList.remove('active');
    mapLockBtn.classList.add('unlocked');
  }
});

if (lockDelayInp) {
  lockDelayInp.addEventListener('input', () => {
    lockDelayMinutes = Math.max(0, parseInt(lockDelayInp.value) || 0);
  });
}

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
      kmEl.textContent = `KM ${place.km.toFixed(1)} · ${RIVER_LABEL[place.river] || ''}`;

      div.appendChild(typeEl);
      div.appendChild(nameEl);
      div.appendChild(kmEl);

      div.onclick = () => {
        selectedDestination = place;
        localStorage.setItem('destination', place.name);
        searchInput.value = place.name;
        suggestions.innerHTML = '';
        searchPanel.classList.remove('open');
        if (window.hudUpdate) window.hudUpdate({ dest: `${place.name} · ${RIVER_LABEL[place.river]}` });
        triggerRouteRedraw();
      };
      suggestions.appendChild(div);
    });
});

// ── Dynamic Scalable 135m Ship Generation ──
function getVesselIcon(lat, zoom) {
  // Convert map zoom and latitude into true real-world meters per pixel
  const mpp = 156543.03 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);

  // Base size of 135m x 15m (Calculated to pixel size, capped at a visible minimum)
  const pxLength = Math.max(135 / mpp, 25);
  const pxWidth  = Math.max(15 / mpp, 25 * (15/135));

  // Sleek Apple-style cargo barge SVG
  const svg = `
  <div class="vessel-icon-container" id="vesselRotator" style="width:${pxWidth}px; height:${pxLength}px; transition: transform 0.2s linear;">
    <svg class="vessel-svg" viewBox="0 0 15 135" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:100%; height:100%; filter: drop-shadow(0px 4px 6px rgba(0,0,0,0.4));">
      <path d="M 7.5 0 C 13 0, 15 5, 15 15 L 15 130 C 15 133, 13 135, 7.5 135 C 2 135, 0 133, 0 130 L 0 15 C 0 5, 2 0, 7.5 0 Z" fill="#ffffff" stroke="#1e293b" stroke-width="1"/>
      <rect x="2.5" y="15" width="10" height="95" fill="#f1f5f9" stroke="#94a3b8" stroke-width="0.8" rx="1"/>
      <rect x="2.5" y="115" width="10" height="10" fill="#1e293b" rx="1"/>
      <rect x="3.5" y="116" width="8" height="3" fill="#38bdf8"/>
      <line x1="7.5" y1="2" x2="7.5" y2="10" stroke="#1e293b" stroke-width="0.8"/>
    </svg>
  </div>`;

  return L.divIcon({
    className: '',
    html: svg,
    iconSize: [pxWidth, pxLength],
    iconAnchor: [pxWidth / 2, pxLength / 2]
  });
}

// Re-render the ship size proportionally whenever the user zooms
map.on('zoomend', () => {
  if (marker) {
    const lat = marker.getLatLng().lat;
    marker.setIcon(getVesselIcon(lat, map.getZoom()));
    setTimeout(() => {
      const rotator = document.getElementById('vesselRotator');
      if (rotator) rotator.style.transform = `rotate(${Math.round(lastValidHeading)}deg)`;
    }, 10);
  }
});


function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Finds the closest point across ALL rivers' paths and returns which river it belongs to.
function interpolateKm(lat, lon) {
  let bestKm = null, bestDist = Infinity, bestRiver = null;

  for (const riverKey in riverPaths) {
    for (const branch of riverPaths[riverKey]) {
      for (let i = 0; i < branch.length - 1; i++) {
        const a = branch[i], b = branch[i + 1];
        const toRad = Math.PI / 180;
        const cosLat = Math.cos(((a.lat + b.lat) / 2) * toRad);

        const ax = a.lon * cosLat, ay = a.lat;
        const bx = b.lon * cosLat, by = b.lat;
        const px = lon  * cosLat, py = lat;

        const abx = bx - ax, aby = by - ay;
        const apx = px - ax, apy = py - ay;
        const ab2 = abx * abx + aby * aby;

        const t = ab2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));

        const closestLat = ay + t * aby;
        const closestLon = (ax + t * abx) / cosLat;
        const d = distance(lat, lon, closestLat, closestLon);

        if (d < bestDist) {
          bestDist = d;
          bestKm   = a.km + (b.km - a.km) * t;
          bestRiver = riverKey;
        }
      }
    }
  }

  if (bestKm === null) return null;
  return { km: bestKm, river: bestRiver, dist: bestDist };
}

const SNAP_RADIUS_M   = 600;
const REQUERY_DIST_KM = 0.3;

let lastQueryCoords  = null;
let cachedMilestones = [];
let kmSource         = 'EST';

async function fetchNearbyMilestones(lat, lon) {
  const query = `[out:json][timeout:10];
(
  node(around:${SNAP_RADIUS_M},${lat},${lon})["waterway"="milestone"];
  node(around:${SNAP_RADIUS_M},${lat},${lon})["seamark:type"="distance_mark"];
);
out body;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: query });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.elements || []).filter(n => {
      const d = n.tags && (n.tags['seamark:distance:value'] || n.tags.distance || n.tags.name);
      return d && !isNaN(parseFloat(d));
    }).map(n => ({
      lat: n.lat, lon: n.lon,
      km: parseFloat(n.tags['seamark:distance:value'] || n.tags.distance || n.tags.name)
    }));
  } catch (e) { return []; }
}

// Returns { km, river } or null
async function resolveKm(lat, lon) {
  const movedFar = !lastQueryCoords || distance(lastQueryCoords.lat, lastQueryCoords.lon, lat, lon) >= REQUERY_DIST_KM;
  if (movedFar) {
    lastQueryCoords = { lat, lon };
    cachedMilestones = await fetchNearbyMilestones(lat, lon);
  }

  const currentEst = interpolateKm(lat, lon);
  if (!currentEst) { kmSource = 'EST'; return null; }

  if (cachedMilestones.length > 0) {
    // Only trust milestones that resolve onto the SAME river as our coarse estimate,
    // which avoids cross-contamination near the Koblenz confluence.
    let closest = null, closestDist = Infinity, closestEst = null;
    for (const m of cachedMilestones) {
      const mEst = interpolateKm(m.lat, m.lon);
      if (!mEst || mEst.river !== currentEst.river) continue;
      const d = distance(lat, lon, m.lat, m.lon);
      if (d < closestDist) { closestDist = d; closest = m; closestEst = mEst; }
    }

    if (closest) {
      kmSource = 'OSM';
      const fractionalOffset = currentEst.km - closestEst.km;
      return { km: closest.km + fractionalOffset, river: currentEst.river };
    }
  }

  kmSource = 'EST';
  return currentEst;
}

// Builds route segments (and lock list, ordered by travel distance) between the vessel
// and a destination, handling both same-river trips and cross-river trips that pass
// through the Koblenz confluence.
function computeRouteInfo(kmResult, dest) {
  if (!kmResult || !dest) return null;

  const segments = [];
  if (kmResult.river === dest.river) {
    segments.push({ river: dest.river, from: kmResult.km, to: dest.km, baseDist: 0 });
  } else {
    const confFrom = CONFLUENCE[kmResult.river];
    const confTo   = CONFLUENCE[dest.river];
    const dist1 = Math.abs(confFrom - kmResult.km);
    segments.push({ river: kmResult.river, from: kmResult.km, to: confFrom, baseDist: 0 });
    segments.push({ river: dest.river,     from: confTo,      to: dest.km,  baseDist: dist1 });
  }

  let locksWithDist = [];
  let totalDistance = 0;
  segments.forEach(seg => {
    const segMin = Math.min(seg.from, seg.to);
    const segMax = Math.max(seg.from, seg.to);
    places
      .filter(p => p.type === 'lock' && p.river === seg.river && p.km >= segMin && p.km <= segMax)
      .forEach(lock => {
        locksWithDist.push({ ...lock, distanceFromVessel: seg.baseDist + Math.abs(lock.km - seg.from) });
      });
    totalDistance = seg.baseDist + Math.abs(seg.to - seg.from);
  });
  locksWithDist.sort((a, b) => a.distanceFromVessel - b.distanceFromVessel);

  return { distance: totalDistance, locks: locksWithDist, segments };
}

function clearRoute() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
}

function drawRoute(segments) {
  clearRoute();
  if (!segments || segments.length === 0) return;

  let allLatLngs = [];
  segments.forEach(seg => {
    const branches = riverPaths[seg.river] || [];
    const segMin = Math.min(seg.from, seg.to);
    const segMax = Math.max(seg.from, seg.to);
    branches.forEach(branch => {
      const nodes = branch.filter(p => p.km >= segMin && p.km <= segMax);
      if (nodes.length > 1) allLatLngs.push(nodes.map(p => [p.lat, p.lon]));
    });
  });

  if (allLatLngs.length > 0) {
    routeLayer = L.polyline(allLatLngs, {
      color: '#4dd9e8', weight: 4, opacity: 0.8, dashArray: '1, 8', lineCap: 'round'
    }).addTo(map);
  }
}

let lastCalculatedKm = null; // { km, river } | null
function triggerRouteRedraw() {
  if (lastCalculatedKm && selectedDestination) {
    const info = computeRouteInfo(lastCalculatedKm, selectedDestination);
    if (info) drawRoute(info.segments);
  }
}

// ── Main Processing Stream
navigator.geolocation.watchPosition(
  async position => {
    const lat   = position.coords.latitude;
    const lon   = position.coords.longitude;
    const rawSpeed = (position.coords.speed || 0) * 3.6;
    const kmResult = await resolveKm(lat, lon);
    lastCalculatedKm = kmResult;

    // Rolling average speed over the last 10 ticks (approx 10 seconds)
    speedHistory.push(rawSpeed);
    if (speedHistory.length > 10) speedHistory.shift();
    const avgSpeed = speedHistory.reduce((a, b) => a + b, 0) / speedHistory.length;

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
      marker = L.marker([lat, lon], { icon: getVesselIcon(lat, map.getZoom()) }).addTo(map);
    } else {
      marker.setLatLng([lat, lon]);
    }

    // Always rotate the ship marker to its absolute heading
    setTimeout(() => {
      const rotator = document.getElementById('vesselRotator');
      if (rotator) rotator.style.transform = `rotate(${Math.round(heading)}deg)`;
    }, 50);

    // Apply head-up map rotation
    if (headUp) {
      mapContainer.style.transform = `rotate(${-Math.round(heading)}deg)`;
    }

    if (firstFix) {
      map.setView([lat, lon], 14);
      firstFix = false;
    } else if (followVessel) {
      map.panTo([lat, lon]);
    }

    const update = {
      km:     kmResult ? kmResult.km.toFixed(1) : '---.-',
      kmSrc:  kmSource,
      sog:    avgSpeed.toFixed(1), // Passed the averaged speed to the HUD
      gps:    true,
      river:  kmResult ? kmResult.river : null
    };

    if (selectedDestination && kmResult) {
      const moveSpd = Math.max(avgSpeed, 1.5); // Prevent infinite ETA if stopped
      const routeInfo = computeRouteInfo(kmResult, selectedDestination);

      if (routeInfo) {
        const distLeft   = routeInfo.distance;
        const totalLocks = routeInfo.locks.length;

        // Top Bar Lock Logic
        if (totalLocks > 0) {
          const nextLock = routeInfo.locks[0]; // already sorted by travel distance
          const lockEtaHours = nextLock.distanceFromVessel / moveSpd;
          const lockArrivalTime = new Date(Date.now() + lockEtaHours * 3600000);

          update.nextLockEta = lockArrivalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          update.locksRemaining = `${totalLocks} REMAINING`;
        } else {
          update.nextLockEta = '--:--';
          update.locksRemaining = '0 REMAINING';
        }

        // Final Destination ETA Logic (incorporating lock delays)
        const ttlMin = totalLocks * lockDelayMinutes;
        const etaHours = distLeft / moveSpd + ttlMin / 60;
        const arrivalTime = new Date(Date.now() + etaHours * 3600000);

        update.eta = arrivalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

        drawRoute(routeInfo.segments);
      }
    } else {
      update.eta   = '--:--';
      update.nextLockEta = '--:--';
      update.locksRemaining = '0 REMAINING';
      clearRoute();
    }

    if (window.hudUpdate) window.hudUpdate(update);
  },
  error => {
    console.error(error);
    if (window.hudUpdate) window.hudUpdate({ gpsError: true });
  },
  { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
);

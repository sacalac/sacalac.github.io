let rhinePoints = [];
let places = [];
let selectedDestination = null;
let followVessel = true; // Map lock tracking state
let lockDelayMinutes = 30; // Configurable lock overhead parameter

// Glowing Ship SVG template pointed upward (0 degrees Heading reference)
const shipSvg = `
<div class="vessel-icon-container" id="vesselRotator">
  <svg class="vessel-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2L17 7V17L12 22L7 17V7L12 2.02V2Z" fill="#4dd9e8" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="12" cy="11" r="2" fill="#0a0f1a"/>
  </svg>
</div>`;

const vesselIcon = L.divIcon({
  className: '',
  html: shipSvg,
  iconSize: [32, 32],
  iconAnchor: [16, 16]
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
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

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
  const nearest = getNearestPoints(lat, lon);
  if(nearest.length < 2) return null;
  const [a, b] = nearest;
  const total = distance(a.lat, a.lon, b.lat, b.lon);
  if (total === 0) return a.km;
  const d = distance(a.lat, a.lon, lat, lon);
  const ratio = Math.max(0, Math.min(1, d / total));
  return a.km + (b.km - a.km) * ratio;
}

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
  position => {
    const lat   = position.coords.latitude;
    const lon   = position.coords.longitude;
    const speed = (position.coords.speed || 0) * 3.6;
    const km    = interpolateKm(lat, lon);
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
      km:  km ? km.toFixed(1) : '---.-',
      sog: speed.toFixed(1),
      gps: true
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

let rhinePoints = [];
let places = [];
let selectedDestination = null;

// Custom vessel icon
const vesselIcon = L.divIcon({
  className: '',
  html: '<div class="vessel-marker"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7]
});
// This forces the browser to look in the exact same folder your HTML is running from
fetch(window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/')) + '/rhine.geojson.txt')

.then(r => r.json())
.then(data => {
  rhinePoints = data.features
    .filter(f => f.properties.SPLIT === 1)
    .map(f => ({
      km:  Number(f.properties.KM1),
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      fluss: f.properties.FLUSS
    }));
  console.log('Rhine markers successfully loaded:', rhinePoints.length);
})
.catch(err => console.error("Error loading Rhine coordinates:", err));

fetch(window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/')) + '/rhine_places.json')

.then(r => r.json())
.then(data => {
  places = data;
  const saved = localStorage.getItem('destination');
  if (saved) {
    selectedDestination = places.find(p => p.name === saved);
    const el = document.getElementById('destinationSearch');
    if (el) el.value = saved;
    if (window.hudUpdate) window.hudUpdate({ dest: saved });
  }
})
.catch(() => {
  places = [];
});

const map = L.map('map', { zoomControl: true }).setView([50, 7], 6);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: ''
}).addTo(map);

let marker = null;
let firstFix = true;

// Search toggle
document.getElementById('searchBtn').addEventListener('click', () => {
  document.getElementById('searchPanel').classList.toggle('open');
});

// Close panel on map click
map.on('click', () => {
  document.getElementById('searchPanel').classList.remove('open');
});

const searchInput   = document.getElementById('destinationSearch');
const suggestions   = document.getElementById('suggestions');

searchInput.addEventListener('input', () => {
  const value = searchInput.value.toLowerCase().trim();
  suggestions.innerHTML = '';
  if (value.length < 2) return;

  places
    .filter(p => p.name.toLowerCase().includes(value))
    .slice(0, 20)
    .forEach(place => {
      const div = document.createElement('div');
      div.className = 'suggestion';

      const typeEl = document.createElement('span');
      typeEl.className = 'suggestion-type ' + (place.type || '');
      typeEl.textContent = (place.type || 'POI').toUpperCase();

      const nameEl = document.createElement('span');
      nameEl.textContent = place.name;

      div.appendChild(typeEl);
      div.appendChild(nameEl);

      div.onclick = () => {
        selectedDestination = place;
        localStorage.setItem('destination', place.name);
        searchInput.value = place.name;
        suggestions.innerHTML = '';
        document.getElementById('searchPanel').classList.remove('open');
        if (window.hudUpdate) window.hudUpdate({ dest: place.name });
      };

      suggestions.appendChild(div);
    });
});

// ── Haversine distance (km)
function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getNearestPoints(lat, lon) {
  return rhinePoints
    .map(p => ({ ...p, dist: distance(lat, lon, p.lat, p.lon) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 2);
}

function interpolateKm(lat, lon) {
  if (rhinePoints.length < 2) return null;
  const [a, b] = getNearestPoints(lat, lon);
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

// ── GPS watch
navigator.geolocation.watchPosition(
  position => {
    const lat   = position.coords.latitude;
    const lon   = position.coords.longitude;
    const speed = (position.coords.speed || 0) * 3.6;
    const km    = interpolateKm(lat, lon);

    if (!marker) {
      marker = L.marker([lat, lon], { icon: vesselIcon }).addTo(map);
    } else {
      marker.setLatLng([lat, lon]);
    }

    if (firstFix) {
      map.setView([lat, lon], 15);
      firstFix = false;
    }

    const update = {
      km:  km ? km.toFixed(1) : '---.-',
      sog: speed.toFixed(1),
      gps: true
    };

    if (selectedDestination && km) {
      const distLeft = Math.abs(selectedDestination.km - km);
      const locks    = countLocks(km, selectedDestination.km);
      const ttlMin   = locks * 30;
      const moveSpd  = Math.max(speed, 1);
      const etaHours = distLeft / moveSpd + ttlMin / 60;
      const etaH     = Math.floor(etaHours);
      const etaM     = Math.round((etaHours - etaH) * 60);

      update.rem   = distLeft.toFixed(1);
      update.locks = String(locks);
      update.ttl   = String(ttlMin);
      update.eta   = `${etaH}h${String(etaM).padStart(2,'0')}`;
    } else {
      update.rem   = '---.-';
      update.locks = '--';
      update.ttl   = '--';
      update.eta   = '--h--';
    }

    if (window.hudUpdate) window.hudUpdate(update);
  },
  error => {
    console.error(error);
    if (window.hudUpdate) window.hudUpdate({ gpsError: true });
  },
  { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
);

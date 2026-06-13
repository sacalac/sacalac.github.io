let rhinePoints = [];

fetch('rhine_points.json')
    .then(r => r.json())
    .then(data => {
        rhinePoints = data;
        console.log("Loaded Rhine points:", rhinePoints.length);
    })
    .catch(err => {
        console.error("Failed to load rhine_points.json", err);
    });

function distance(lat1, lon1, lat2, lon2) {
    const R = 6371;

    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;

    return R * 2 * Math.atan2(
        Math.sqrt(a),
        Math.sqrt(1 - a)
    );
}

function nearestRhinePoint(lat, lon) {

    let nearest = null;
    let best = Infinity;

    rhinePoints.forEach(point => {

        const d = distance(
            lat,
            lon,
            point.lat,
            point.lon
        );

        if (d < best) {
            best = d;
            nearest = point;
        }
    });

    return nearest;
}

const map = L.map('map').setView([50.0, 7.0], 6);

L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
        attribution: '&copy; OpenStreetMap contributors'
    }
).addTo(map);

let marker = null;
let firstFix = true;

const info = L.control({ position: 'topright' });

info.onAdd = function () {
    this._div = L.DomUtil.create('div');

    this._div.style.background = 'white';
    this._div.style.padding = '10px';
    this._div.style.borderRadius = '5px';
    this._div.style.boxShadow =
        '0 0 5px rgba(0,0,0,0.3)';

    this._div.innerHTML =
        'Waiting for GPS...';

    return this._div;
};

info.addTo(map);

navigator.geolocation.watchPosition(
    (position) => {

        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        const speed =
            position.coords.speed || 0;

        const nearest =
            nearestRhinePoint(lat, lon);

        if (nearest) {

            info._div.innerHTML = `
                <b>Rhine Navigation</b><br>
                Rhine km: ${nearest.km}<br>
                Place: ${nearest.name}<br>
                Speed: ${(speed * 3.6).toFixed(1)} km/h<br>
                Lat: ${lat.toFixed(5)}<br>
                Lon: ${lon.toFixed(5)}
            `;
        }

        if (!marker) {

            marker =
                L.marker([lat, lon])
                .addTo(map);

        } else {

            marker.setLatLng([lat, lon]);

        }

        if (firstFix) {

            map.setView(
                [lat, lon],
                15
            );

            firstFix = false;
        }

    },
    (error) => {

        console.error(error);

    },
    {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000
    }
);

const map = L.map('map').setView([50.0, 7.0], 6);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let marker = null;
let firstFix = true;

const info = L.control({ position: 'topright' });

info.onAdd = function () {
    this._div = L.DomUtil.create('div');
    this._div.style.background = 'white';
    this._div.style.padding = '10px';
    this._div.style.borderRadius = '5px';
    this._div.innerHTML = 'Waiting for GPS...';
    return this._div;
};

info.addTo(map);

navigator.geolocation.watchPosition(
    (position) => {

        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        const speed = position.coords.speed || 0;

        if (!marker) {
            marker = L.marker([lat, lon]).addTo(map);
        } else {
            marker.setLatLng([lat, lon]);
        }

        if (firstFix) {
            map.setView([lat, lon], 15);
            firstFix = false;
        }

        info._div.innerHTML = `
            <b>Your Position</b><br>
            Lat: ${lat.toFixed(5)}<br>
            Lon: ${lon.toFixed(5)}<br>
            Speed: ${(speed * 3.6).toFixed(1)} km/h
        `;

    },
    (error) => {
        alert(error.message);
    },
    {
        enableHighAccuracy: true
    }
);

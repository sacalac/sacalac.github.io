const map = L.map('map').setView([50.0, 7.0], 6);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let marker = null;
let firstFix = true;

navigator.geolocation.watchPosition(
    (position) => {

        const lat = position.coords.latitude;
        const lon = position.coords.longitude;

        if (!marker) {
            marker = L.marker([lat, lon]).addTo(map);
        } else {
            marker.setLatLng([lat, lon]);
        }

        if (firstFix) {
            map.setView([lat, lon], 15);
            firstFix = false;
        }

    },
    (error) => {
        alert("GPS Error: " + error.message);
    },
    {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000
    }
);

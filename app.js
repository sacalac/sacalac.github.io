const map = L.map('map').setView([47.5596, 7.5886], 10);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let userMarker = null;

navigator.geolocation.watchPosition(
    (position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;

        map.setView([lat, lon], 14);

        if (!userMarker) {
            userMarker = L.marker([lat, lon]).addTo(map);
        } else {
            userMarker.setLatLng([lat, lon]);
        }
    },
    (error) => {
        console.log(error);
    },
    {
        enableHighAccuracy: true
    }
);

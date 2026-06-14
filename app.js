let rhinePoints = [];

fetch('rhine.geojson')
    .then(r => r.json())
    .then(data => {

        rhinePoints = data.features.map(f => ({
            km: Number(f.properties.KM1),
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0]
        }));

        console.log(
            "Loaded Rhine markers:",
            rhinePoints.length
        );
    })
    .catch(err => {
        console.error(err);
    });

function distance(lat1, lon1, lat2, lon2) {

    const R = 6371;

    const dLat =
        (lat2 - lat1) *
        Math.PI / 180;

    const dLon =
        (lon2 - lon1) *
        Math.PI / 180;

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;

    return R * 2 *
        Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        );
}

function getNearestPoints(lat, lon) {

    const points =
        rhinePoints
            .map(p => ({
                ...p,
                dist: distance(
                    lat,
                    lon,
                    p.lat,
                    p.lon
                )
            }))
            .sort(
                (a, b) =>
                    a.dist - b.dist
            );

    return [
        points[0],
        points[1]
    ];
}

function interpolateKm(lat, lon) {

    if (
        rhinePoints.length < 2
    ) {
        return null;
    }

    const [a, b] =
        getNearestPoints(
            lat,
            lon
        );

    const total =
        distance(
            a.lat,
            a.lon,
            b.lat,
            b.lon
        );

    if (total === 0) {
        return a.km;
    }

    const d =
        distance(
            a.lat,
            a.lon,
            lat,
            lon
        );

    const ratio =
        Math.min(
            1,
            Math.max(
                0,
                d / total
            )
        );

    return (
        a.km +
        (
            (b.km - a.km) *
            ratio
        )
    );
}

const map = L.map('map').setView([50.0, 7.0], 6);

L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
        attribution:
            '&copy; OpenStreetMap contributors'
    }
).addTo(map);

let marker = null;
let firstFix = true;

const info = L.control({
    position: 'topright'
});

info.onAdd = function () {

    this._div =
        L.DomUtil.create('div');

    this._div.style.background =
        'white';

    this._div.style.padding =
        '10px';

    this._div.style.borderRadius =
        '5px';

    this._div.style.boxShadow =
        '0 0 5px rgba(0,0,0,0.3)';

    this._div.innerHTML =
        'Waiting for GPS...';

    return this._div;
};

info.addTo(map);

navigator.geolocation.watchPosition(

    (position) => {

        const lat =
            position.coords.latitude;

        const lon =
            position.coords.longitude;

        const speed =
            position.coords.speed || 0;

        const km =
            interpolateKm(
                lat,
                lon
            );

        if (!marker) {

            marker =
                L.marker([
                    lat,
                    lon
                ]).addTo(map);

        } else {

            marker.setLatLng([
                lat,
                lon
            ]);
        }

        if (firstFix) {

            map.setView(
                [lat, lon],
                15
            );

            firstFix = false;
        }

        info._div.innerHTML = `
            <b>Rhine Navigation</b><br>
            Rhine km:
            ${km ? km.toFixed(1) : "--"}<br>
            Speed:
            ${(speed * 3.6).toFixed(1)} km/h<br>
            Lat:
            ${lat.toFixed(5)}<br>
            Lon:
            ${lon.toFixed(5)}
        `;
    },

    (error) => {

        console.error(
            "GPS Error:",
            error
        );
    },

    {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000
    }
);

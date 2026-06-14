let rhinePoints = [];
let places = [];
let selectedDestination = null;

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
    });

fetch('rhine_places.json')
    .then(r => r.json())
    .then(data => {

        places = data;

        const list =
            document.getElementById(
                'destinationList'
            );

        data.forEach(place => {

            const option =
                document.createElement(
                    'option'
                );

            option.value =
                place.name;

            list.appendChild(
                option
            );
        });

        const saved =
            localStorage.getItem(
                'destination'
            );

        if (saved) {

            document.getElementById(
                'destinationSearch'
            ).value = saved;

            selectedDestination =
                places.find(
                    p =>
                    p.name === saved
                );
        }
    });

document
.getElementById(
    'destinationSearch'
)
.addEventListener(
    'change',
    e => {

        const value =
            e.target.value;

        selectedDestination =
            places.find(
                p =>
                p.name === value
            );

        localStorage.setItem(
            'destination',
            value
        );
    }
);

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

function countLocks(
    currentKm,
    destinationKm
) {

    const min =
        Math.min(
            currentKm,
            destinationKm
        );

    const max =
        Math.max(
            currentKm,
            destinationKm
        );

    return places.filter(
        p =>
            p.type === 'lock' &&
            p.km >= min &&
            p.km <= max
    ).length;
}

function nextLock(
    currentKm,
    destinationKm
) {

    if (
        destinationKm >
        currentKm
    ) {

        const locks =
            places
            .filter(
                p =>
                    p.type === 'lock' &&
                    p.km > currentKm
            )
            .sort(
                (a,b)=>
                a.km-b.km
            );

        return locks[0];
    }

    const locks =
        places
        .filter(
            p =>
                p.type === 'lock' &&
                p.km < currentKm
        )
        .sort(
            (a,b)=>
            b.km-a.km
        );

    return locks[0];
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
            ${(speed * 3.6).toFixed(1)} km/h
        `;

        if (
            selectedDestination &&
            km
        ) {

            const distanceLeft =
                Math.abs(
                    selectedDestination.km -
                    km
                );

            const downstream =
                selectedDestination.km >
                km;

            const locks =
                countLocks(
                    km,
                    selectedDestination.km
                );

            const lockDelay =
                locks * 0.5;

            const vesselSpeed =
                Math.max(
                    1,
                    speed * 3.6
                );

            const travelHours =
                distanceLeft /
                vesselSpeed;

            const eta =
                travelHours +
                lockDelay;

            const next =
                nextLock(
                    km,
                    selectedDestination.km
                );

            document
                .getElementById(
                    'routeInfo'
                )
                .innerHTML = `

                <b>${selectedDestination.name}</b><br>

                ${
                    downstream
                    ? '↓ Downstream'
                    : '↑ Upstream'
                }<br>

                ${km.toFixed(1)}
                →
                ${selectedDestination.km}<br>

                ${distanceLeft.toFixed(1)}
                km<br>

                Locks:
                ${locks}<br>

                Next:
                ${
                    next
                    ? next.name
                    : '-'
                }<br>

                ${
                    next
                    ? Math.abs(
                        next.km - km
                      ).toFixed(1)
                    : '-'
                }
                km<br>

                ETA:
                ${eta.toFixed(1)}
                h
                `;
        }
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

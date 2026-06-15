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

    console.log("Rhine markers:", rhinePoints.length);
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

        list.appendChild(option);
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
                p => p.name === saved
            );
    }
});

document
.getElementById('searchBtn')
.addEventListener('click', () => {

    document
    .getElementById(
        'searchPanel'
    )
    .classList
    .toggle('open');
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

function distance(
    lat1,
    lon1,
    lat2,
    lon2
) {

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

function getNearestPoints(
    lat,
    lon
) {

    const points =
        rhinePoints
        .map(p => ({
            ...p,
            dist:
            distance(
                lat,
                lon,
                p.lat,
                p.lon
            )
        }))
        .sort(
            (a,b)=>
            a.dist-b.dist
        );

    return [
        points[0],
        points[1]
    ];
}

function interpolateKm(
    lat,
    lon
) {

    if (
        rhinePoints.length < 2
    ) {
        return null;
    }

    const [a,b] =
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

    const d =
        distance(
            a.lat,
            a.lon,
            lat,
            lon
        );

    const ratio =
        Math.max(
            0,
            Math.min(
                1,
                d / total
            )
        );

    return (
        a.km +
        (
            b.km - a.km
        ) * ratio
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

const map = L.map(
    'map',
    {
        zoomControl: false
    }
).setView(
    [50,7],
    6
);

L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
        attribution: ''
    }
).addTo(map);

let marker = null;
let firstFix = true;

navigator.geolocation.watchPosition(

    position => {

        const lat =
            position.coords.latitude;

        const lon =
            position.coords.longitude;

        const speed =
            (
                position.coords.speed || 0
            ) * 3.6;

        const km =
            interpolateKm(
                lat,
                lon
            );

        if (!marker) {

            marker =
                L.marker(
                    [lat,lon]
                ).addTo(map);

        } else {

            marker.setLatLng(
                [lat,lon]
            );
        }

        if (firstFix) {

            map.setView(
                [lat,lon],
                15
            );

            firstFix = false;
        }

        document
        .getElementById(
            'kmInfo'
        )
        .textContent =
        `RKM:${km ? km.toFixed(1) : '--'}`;

        document
        .getElementById(
            'sogInfo'
        )
        .textContent =
        `SOG:${speed.toFixed(1)}`;

        if (
            !selectedDestination ||
            !km
        ) {
            return;
        }

        const distanceLeft =
            Math.abs(
                selectedDestination.km -
                km
            );

        const locks =
            countLocks(
                km,
                selectedDestination.km
            );

        const ttlMinutes =
            locks * 30;

        const movingSpeed =
            Math.max(
                speed,
                1
            );

        const travelHours =
            distanceLeft /
            movingSpeed;

        const etaHours =
            travelHours +
            (
                ttlMinutes / 60
            );

        const next =
            nextLock(
                km,
                selectedDestination.km
            );

        const etaH =
            Math.floor(
                etaHours
            );

        const etaM =
            Math.round(
                (
                    etaHours -
                    etaH
                ) * 60
            );

        document
        .getElementById(
            'locksInfo'
        )
        .textContent =
        `Locks:${locks}`;

        document
        .getElementById(
            'ttlInfo'
        )
        .textContent =
        `TTL:${ttlMinutes}m`;

        document
        .getElementById(
            'etaInfo'
        )
        .textContent =
        `ETA:${etaH}h ${etaM}m`;

        document
        .getElementById(
            'remInfo'
        )
        .textContent =
        `REM:${distanceLeft.toFixed(1)}km`;

    },

    error => {

        console.error(
            error
        );
    },

    {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000
    }
);

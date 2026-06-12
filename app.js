mapboxgl.accessToken = 'YOUR_MAPBOX_TOKEN';

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/outdoors-v12',
    center: [7.5886, 47.5596],
    zoom: 10
});

navigator.geolocation.watchPosition(
    (position) => {

        const lng = position.coords.longitude;
        const lat = position.coords.latitude;

        map.flyTo({
            center: [lng, lat],
            zoom: 14
        });

        if (!window.userMarker) {
            window.userMarker = new mapboxgl.Marker()
                .setLngLat([lng, lat])
                .addTo(map);
        } else {
            window.userMarker.setLngLat([lng, lat]);
        }
    },
    (error) => {
        console.log(error);
    },
    {
        enableHighAccuracy: true
    }
);

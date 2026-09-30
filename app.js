/* * Inland Navigation App * Rhine + Moselle keep their existing GeoJSON/place data. * Netherlands + Belgium use the supplied EURIS inland-fairway graph. */

let riverPaths = { rhine: [], moselle: [] };
let places = [];
let selectedDestination = null;

let followVessel = true;
let headUp = false;
let lockDelayMinutes = 30;

const CONFLUENCE = { rhine: 592.0, moselle: 0.0 };
const RIVER_LABEL = { rhine: "Rhine", moselle: "Moselle", benelux: "NL / BE" };

let speedHistory = [];
let routeLayer = null;
let marker = null;
let firstFix = true;
let lastValidHeading = 0;
let previousCoords = null;
let lastCalculatedPosition = null;
let lastCalculatedKm = null;

const basePath = window.location.pathname.endsWith("/")
  ? window.location.pathname.slice(0, -1)
  : window.location.pathname.substring(
      0,
      window.location.pathname.lastIndexOf("/")
    );

function asset(name) {
  return `${basePath}/${name}`;
}

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function loadRiverGeoJSON(url, riverKey) {
  return fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !Array.isArray(data.features)) return;
      const groups = {};
      data.features
        .filter((f) => f.properties && f.properties.SPLIT === 1)
        .forEach((f) => {
          const key = f.properties.FLUSS || "main";
          if (!groups[key]) groups[key] = [];
          groups[key].push({
            km: Number(f.properties.KM1),
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0],
          });
        });
      riverPaths[riverKey] = Object.values(groups).map((branch) =>
        branch.filter((p) => Number.isFinite(p.km)).sort((a, b) => a.km - b.km)
      );
    })
    .catch((e) => console.error(`${riverKey} geojson error`, e));
}

function loadPlaces(url, riverKey) {
  return fetch(url)
    .then((r) => (r.ok ? r.json() : []))
    .then((data) => {
      data.forEach((p) => (p.river = riverKey));
      places = places.concat(data);
    })
    .catch((e) => console.error(`${riverKey} places error`, e));
}

let benelux = null;
let beneluxAdj = null;
let beneluxLoaded = false;
let beneluxRouteCache = new Map();

async function loadBeneluxNetwork() {
  try {
    const r = await fetch(asset("benelux-network.json"));
    if (!r.ok) throw new Error(`benelux-network.json HTTP ${r.status}`);
    benelux = await r.json();
    beneluxAdj = {};
    Object.keys(benelux.nodes).forEach((id) => (beneluxAdj[id] = []));

    benelux.edges.forEach((e, index) => {
      if (!beneluxAdj[e.s]) beneluxAdj[e.s] = [];
      if (!beneluxAdj[e.t]) beneluxAdj[e.t] = [];
      beneluxAdj[e.s].push({ to: e.t, d: e.d, edge: index, forward: true });
      beneluxAdj[e.t].push({ to: e.s, d: e.d, edge: index, forward: false });
    });

    beneluxLoaded = true;
    addBeneluxSeedDestinations();
    console.log(
      `Benelux network loaded: ${Object.keys(benelux.nodes).length} nodes / ${ benelux.edges.length } edges`
    );
  } catch (e) {
    console.error("Benelux network error", e);
  }
}

function addBeneluxSeedDestinations() {
  if (!benelux || !Array.isArray(benelux.destinations)) return;
  benelux.destinations.forEach((d) => {
    const name = d.name;
    if (!name) return;
    if (
      places.some(
        (p) =>
          p.river === "benelux" && p.name.toLowerCase() === name.toLowerCase()
      )
    )
      return;
    places.push({
      name,
      type: "city",
      river: "benelux",
      lat: d.lat,
      lon: d.lon,
      km: null,
      node: nearestBeneluxNode(d.lat, d.lon),
    });
  });
}

function nearestBeneluxNode(lat, lon) {
  if (!benelux || !benelux.nodes) return null;
  let best = null,
    bestD = Infinity;
  for (const [id, xy] of Object.entries(benelux.nodes)) {
    const d = distance(lat, lon, xy[1], xy[0]);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

function interpolateKm(lat, lon) {
  let bestKm = null,
    bestDist = Infinity,
    bestRiver = null;

  for (const riverKey of ["rhine", "moselle"]) {
    for (const branch of riverPaths[riverKey] || []) {
      for (let i = 0; i < branch.length - 1; i++) {
        const a = branch[i],
          b = branch[i + 1];
        const toRad = Math.PI / 180;
        const cosLat = Math.cos(((a.lat + b.lat) / 2) * toRad);
        const ax = a.lon * cosLat,
          ay = a.lat;
        const bx = b.lon * cosLat,
          by = b.lat;
        const px = lon * cosLat,
          py = lat;
        const abx = bx - ax,
          aby = by - ay;
        const apx = px - ax,
          apy = py - ay;
        const ab2 = abx * abx + aby * aby;
        const t =
          ab2 === 0
            ? 0
            : Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
        const closestLat = ay + t * aby;
        const closestLon = (ax + t * abx) / cosLat;
        const d = distance(lat, lon, closestLat, closestLon);
        if (d < bestDist) {
          bestDist = d;
          bestKm = a.km + (b.km - a.km) * t;
          bestRiver = riverKey;
        }
      }
    }
  }

  if (bestKm === null) return null;
  return { km: bestKm, river: bestRiver, dist: bestDist };
}

const SNAP_RADIUS_M = 600;
const REQUERY_DIST_KM = 0.3;
let lastQueryCoords = null;
let cachedMilestones = [];
let kmSource = "EST";

async function fetchNearbyMilestones(lat, lon, radius = SNAP_RADIUS_M) {
  const query = `[out:json][timeout:10]; ( node(around:${radius},${lat},${lon})["waterway"="milestone"]; node(around:${radius},${lat},${lon})["seamark:type"="distance_mark"]; ); out body;`;
  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: query,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.elements || [])
      .filter((n) => {
        const d =
          n.tags &&
          (n.tags["seamark:distance:value"] ||
            n.tags["seamark:distance_mark:distance"] ||
            n.tags.distance ||
            n.tags.name);
        return d && !isNaN(parseFloat(d));
      })
      .map((n) => ({
        lat: n.lat,
        lon: n.lon,
        km: parseFloat(
          n.tags["seamark:distance:value"] ||
            n.tags["seamark:distance_mark:distance"] ||
            n.tags.distance ||
            n.tags.name
        ),
      }));
  } catch (e) {
    return [];
  }
}

async function resolveKm(lat, lon) {
  const coarse = interpolateKm(lat, lon);

  // Rhine/Moselle: preserve the existing OSM milestone correction.
  if (coarse) {
    const movedFar =
      !lastQueryCoords ||
      distance(lastQueryCoords.lat, lastQueryCoords.lon, lat, lon) >=
        REQUERY_DIST_KM;
    if (movedFar) {
      lastQueryCoords = { lat, lon };
      cachedMilestones = await fetchNearbyMilestones(lat, lon);
    }
    if (cachedMilestones.length) {
      let closest = null,
        closestDist = Infinity,
        closestEst = null;
      for (const m of cachedMilestones) {
        const mEst = interpolateKm(m.lat, m.lon);
        if (!mEst || mEst.river !== coarse.river) continue;
        const d = distance(lat, lon, m.lat, m.lon);
        if (d < closestDist) {
          closestDist = d;
          closest = m;
          closestEst = mEst;
        }
      }
      if (closest) {
        kmSource = "OSM";
        return {
          km: closest.km + (coarse.km - closestEst.km),
          river: coarse.river,
        };
      }
    }
    kmSource = "EST";
    return coarse;
  }

  // Netherlands/Belgium: use the EURIS network and nearby OSM milestone if available.
  if (beneluxLoaded) {
    const node = nearestBeneluxNode(lat, lon);
    if (!node) return null;
    const meta = benelux.nodeMeta && benelux.nodeMeta[node];
    if (meta && Number.isFinite(meta.km)) {
      kmSource = "EURIS";
      return {
        km: meta.km,
        river: "benelux",
        node,
        waterway: meta.waterway,
        section: meta.section,
      };
    }
    kmSource = "NET";
    return { km: null, river: "benelux", node };
  }
  return null;
}

class MinHeap {
  constructor() {
    this.a = [];
  }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= item[0]) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = item;
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const root = a[0],
      last = a.pop();
    if (a.length) {
      let i = 0;
      while (true) {
        let l = i * 2 + 1,
          r = l + 1,
          sm = i;
        if (l < a.length && a[l][0] < a[sm][0]) sm = l;
        if (r < a.length && a[r][0] < a[sm][0]) sm = r;
        if (sm === i) break;
        a[i] = a[sm];
        i = sm;
      }
      a[i] = last;
    }
    return root;
  }
}

function shortestBeneluxRoute(startId, endId) {
  if (!beneluxLoaded || !startId || !endId) return null;
  const key = `${startId}>${endId}`;
  if (beneluxRouteCache.has(key)) return beneluxRouteCache.get(key);

  const distMap = new Map([[startId, 0]]);
  const prev = new Map();
  const heap = new MinHeap();
  heap.push([0, startId]);

  while (true) {
    const item = heap.pop();
    if (!item) break;
    const [d, u] = item;
    if (d !== distMap.get(u)) continue;
    if (u === endId) break;
    for (const a of beneluxAdj[u] || []) {
      const nd = d + a.d;
      if (nd < (distMap.get(a.to) ?? Infinity)) {
        distMap.set(a.to, nd);
        prev.set(a.to, { node: u, edge: a.edge, forward: a.forward });
        heap.push([nd, a.to]);
      }
    }
  }

  if (!distMap.has(endId)) return null;

  const steps = [];
  let cur = endId;
  while (cur !== startId) {
    const p = prev.get(cur);
    if (!p) return null;
    steps.push({ from: p.node, to: cur, edge: p.edge, forward: p.forward });
    cur = p.node;
  }
  steps.reverse();

  const result = { distance: distMap.get(endId) / 1000, steps };
  beneluxRouteCache.set(key, result);
  return result;
}

function routeCoordinates(route) {
  const all = [];
  for (const s of route.steps) {
    const e = benelux.edges[s.edge];
    const pts = s.forward ? e.g : [...e.g].reverse();
    if (!pts.length) continue;
    if (!all.length) all.push(...pts);
    else all.push(...pts.slice(1));
  }
  return all.map((p) => [p[1], p[0]]);
}

function pointToPolylineDistanceKm(lat, lon, latlngs) {
  let best = Infinity;
  for (let i = 0; i < latlngs.length - 1; i++) {
    const a = latlngs[i],
      b = latlngs[i + 1];
    const cos = Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
    const ax = a[1] * cos,
      ay = a[0],
      bx = b[1] * cos,
      by = b[0],
      px = lon * cos,
      py = lat;
    const abx = bx - ax,
      aby = by - ay,
      apx = px - ax,
      apy = py - ay,
      ab2 = abx * abx + aby * aby;
    const t = ab2 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2)) : 0;
    const qlat = ay + t * aby,
      qlon = (ax + t * abx) / cos;
    best = Math.min(best, distance(lat, lon, qlat, qlon));
  }
  return best;
}

function locksForBeneluxRoute(route) {
  if (!benelux || !benelux.locks || !route) return [];
  const coords = routeCoordinates(route);
  const out = [];
  for (const lock of benelux.locks) {
    if (!lock.lat || !lock.lon) continue;
    const d = pointToPolylineDistanceKm(lock.lat, lock.lon, coords);
    if (d <= 0.25)
      out.push({
        ...lock,
        routeDistance: routeDistanceToPoint(route, lock.lat, lock.lon),
      });
  }
  // Collapse multiple lock approach nodes of the same complex.
  out.sort((a, b) => a.routeDistance - b.routeDistance);
  const dedup = [];
  for (const x of out) {
    const last = dedup[dedup.length - 1];
    if (
      last &&
      Math.abs(x.routeDistance - last.routeDistance) < 0.8 &&
      (x.name.toLowerCase().includes("sluis") ||
        last.name.toLowerCase().includes("sluis"))
    ) {
      continue;
    }
    dedup.push(x);
  }
  return dedup;
}

function routeDistanceToPoint(route, lat, lon) {
  let total = 0;
  for (const s of route.steps) {
    const e = benelux.edges[s.edge];
    const pts = s.forward ? e.g : [...e.g].reverse();
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i],
        b = pts[i + 1];
      const seg = distance(a[1], a[0], b[1], b[0]);
      const d1 = distance(lat, lon, a[1], a[0]);
      const d2 = distance(lat, lon, b[1], b[0]);
      if (d1 <= d2) total += seg;
      else {
        total += seg / 2;
        break;
      }
    }
  }
  return total;
}

function computeBeneluxRoute(current, dest) {
  if (
    !current ||
    current.river !== "benelux" ||
    !dest ||
    dest.river !== "benelux"
  )
    return null;
  const startNode =
    current.node || nearestBeneluxNode(current.lat, current.lon);
  const endNode = dest.node || nearestBeneluxNode(dest.lat, dest.lon);
  if (!startNode || !endNode) return null;
  const route = shortestBeneluxRoute(startNode, endNode);
  if (!route) return null;
  const startOffset = distance(
    current.lat,
    current.lon,
    benelux.nodes[startNode][1],
    benelux.nodes[startNode][0]
  );
  const endOffset = distance(
    dest.lat,
    dest.lon,
    benelux.nodes[endNode][1],
    benelux.nodes[endNode][0]
  );
  const locks = locksForBeneluxRoute(route).map((l) => ({
    ...l,
    distanceFromVessel: Math.max(0, l.routeDistance + startOffset),
  }));
  return {
    distance: route.distance + startOffset + endOffset,
    locks,
    route,
    segments: [{ river: "benelux", route }],
    startNode,
    endNode,
  };
}

function coordAtRiverKm(river, km) {
  let best = null,
    bestD = Infinity;
  for (const branch of riverPaths[river] || []) {
    for (let i = 0; i < branch.length - 1; i++) {
      const a = branch[i],
        b = branch[i + 1];
      const lo = Math.min(a.km, b.km),
        hi = Math.max(a.km, b.km);
      if (km < lo || km > hi) continue;
      const t = b.km - a.km === 0 ? 0 : (km - a.km) / (b.km - a.km);
      const lat = a.lat + (b.lat - a.lat) * t,
        lon = a.lon + (b.lon - a.lon) * t;
      return { lat, lon, km };
    }
    const first = branch[0],
      last = branch[branch.length - 1];
    const d = Math.min(Math.abs(km - first.km), Math.abs(km - last.km));
    if (d < bestD) {
      bestD = d;
      best = Math.abs(km - first.km) < Math.abs(km - last.km) ? first : last;
    }
  }
  return best ? { lat: best.lat, lon: best.lon, km: best.km } : null;
}

function nearestBeneluxConnectorToRiver(river, km, maxKm = 15) {
  if (!beneluxLoaded) return null;
  const rp = coordAtRiverKm(river, km);
  if (!rp) return null;
  let best = null,
    bestDist = Infinity;
  for (const [id, xy] of Object.entries(benelux.nodes)) {
    const d = distance(rp.lat, rp.lon, xy[1], xy[0]);
    if (d < bestDist) {
      bestDist = d;
      best = { node: id, dist: d, lat: xy[1], lon: xy[0], riverKm: km };
    }
  }
  return best && best.dist <= maxKm ? best : null;
}

function findClosestBeneluxNodeToRhinePoint(lat, lon, maxKm = 15) {
  if (!beneluxLoaded) return null;
  let best = null,
    bestDist = Infinity;
  for (const [id, xy] of Object.entries(benelux.nodes)) {
    const d = distance(lat, lon, xy[1], xy[0]);
    if (d < bestDist) {
      bestDist = d;
      best = { node: id, dist: d, lat: xy[1], lon: xy[0] };
    }
  }
  if (!best || best.dist > maxKm) return null;
  const est = interpolateKm(best.lat, best.lon);
  if (!est || est.river !== "rhine" || est.dist > maxKm) return null;
  return { ...best, riverKm: est.km };
}

function computeCrossRhineBeneluxRoute(current, dest) {
  if (!current || !dest || !beneluxLoaded) return null;
  let rhineKm, destBeneluxNode, beneluxStartNode;
  let fromRhine = false;

  if (current.river === "rhine" && dest.river === "benelux") {
    rhineKm = current.km;
    destBeneluxNode = dest.node || nearestBeneluxNode(dest.lat, dest.lon);
    const c = nearestBeneluxConnectorToRiver("rhine", rhineKm, 15);
    if (!c || !destBeneluxNode) return null;
    beneluxStartNode = c.node;
    fromRhine = true;
    const route = shortestBeneluxRoute(beneluxStartNode, destBeneluxNode);
    if (!route) return null;
    const rhineSeg = Math.abs(rhineKm - c.riverKm);
    const locks = locksForBeneluxRoute(route).map((l) => ({
      ...l,
      distanceFromVessel: rhineSeg + Math.max(0, l.routeDistance),
    }));
    return {
      distance:
        rhineSeg +
        route.distance +
        distance(
          dest.lat,
          dest.lon,
          benelux.nodes[destBeneluxNode][1],
          benelux.nodes[destBeneluxNode][0]
        ),
      locks,
      route,
      segments: [
        { river: "rhine", from: rhineKm, to: c.riverKm, baseDist: 0 },
        { river: "benelux", route },
      ],
      fromRhine,
    };
  }

  if (current.river === "benelux" && dest.river === "rhine") {
    const currentNode =
      current.node || nearestBeneluxNode(current.lat, current.lon);
    const dcoord = coordAtRiverKm("rhine", dest.km);
    if (!currentNode || !dcoord) return null;
    const c = findClosestBeneluxNodeToRhinePoint(dcoord.lat, dcoord.lon, 15);
    if (!c) return null;
    const route = shortestBeneluxRoute(currentNode, c.node);
    if (!route) return null;
    const locks = locksForBeneluxRoute(route).map((l) => ({
      ...l,
      distanceFromVessel: l.routeDistance,
    }));
    const endOffset = distance(dcoord.lat, dcoord.lon, c.lat, c.lon);
    return {
      distance: route.distance + endOffset + Math.abs(dest.km - c.riverKm),
      locks,
      route,
      segments: [
        { river: "benelux", route },
        {
          river: "rhine",
          from: c.riverKm,
          to: dest.km,
          baseDist: route.distance + endOffset,
        },
      ],
      fromRhine: false,
    };
  }
  return null;
}

function computeRouteInfo(kmResult, dest) {
  if (!kmResult || !dest) return null;

  if (kmResult.river === "benelux" && dest.river === "benelux")
    return computeBeneluxRoute(
      {
        ...kmResult,
        lat: lastCalculatedPosition.lat,
        lon: lastCalculatedPosition.lon,
      },
      dest
    );

  if (kmResult.river === "benelux" || dest.river === "benelux") {
    const cross = computeCrossRhineBeneluxRoute(
      {
        ...kmResult,
        lat: lastCalculatedPosition.lat,
        lon: lastCalculatedPosition.lon,
      },
      dest
    );
    return cross;
  }

  const segments = [];
  if (kmResult.river === dest.river) {
    segments.push({
      river: dest.river,
      from: kmResult.km,
      to: dest.km,
      baseDist: 0,
    });
  } else {
    const confFrom = CONFLUENCE[kmResult.river],
      confTo = CONFLUENCE[dest.river];
    const dist1 = Math.abs(confFrom - kmResult.km);
    segments.push({
      river: kmResult.river,
      from: kmResult.km,
      to: confFrom,
      baseDist: 0,
    });
    segments.push({
      river: dest.river,
      from: confTo,
      to: dest.km,
      baseDist: dist1,
    });
  }

  let locksWithDist = [];
  let totalDistance = 0;
  segments.forEach((seg) => {
    const min = Math.min(seg.from, seg.to),
      max = Math.max(seg.from, seg.to);
    places
      .filter(
        (p) =>
          p.type === "lock" &&
          p.river === seg.river &&
          p.km >= min &&
          p.km <= max
      )
      .forEach((lock) => {
        locksWithDist.push({
          ...lock,
          distanceFromVessel: seg.baseDist + Math.abs(lock.km - seg.from),
        });
      });
    totalDistance = seg.baseDist + Math.abs(seg.to - seg.from);
  });
  locksWithDist.sort((a, b) => a.distanceFromVessel - b.distanceFromVessel);
  return { distance: totalDistance, locks: locksWithDist, segments };
}

function clearRoute() {
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
}

function drawRoute(segments) {
  clearRoute();
  if (!segments || !segments.length) return;

  const all = [];
  for (const seg of segments) {
    if (seg.river === "benelux") {
      const c = routeCoordinates(seg.route);
      if (c.length > 1) all.push(c);
      continue;
    }
    const branches = riverPaths[seg.river] || [];
    const min = Math.min(seg.from, seg.to),
      max = Math.max(seg.from, seg.to);
    branches.forEach((branch) => {
      const nodes = branch.filter((p) => p.km >= min && p.km <= max);
      if (nodes.length > 1) all.push(nodes.map((p) => [p.lat, p.lon]));
    });
  }
  if (all.length) {
    routeLayer = L.polyline(all, {
      color: "#4dd9e8",
      weight: 4,
      opacity: 0.85,
      dashArray: "1,8",
      lineCap: "round",
    }).addTo(map);
  }
}

function getVesselIcon(lat, zoom) {
  const mpp = (156543.03 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  const pxLength = Math.max(135 / mpp, 25);
  const pxWidth = Math.max(15 / mpp, 25 * (15 / 135));
  const svg = `<div class="vessel-icon-container" id="vesselRotator" style="width:${pxWidth}px;height:${pxLength}px;transition:transform .2s linear;"> <svg class="vessel-svg" viewBox="0 0 15 135" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;filter:drop-shadow(0 4px 6px rgba(0,0,0,.4));"> <path d="M7.5 0C13 0 15 5 15 15V130C15 133 13 135 7.5 135S0 133 0 130V15C0 5 2 0 7.5 0Z" fill="#fff" stroke="#1e293b" stroke-width="1"/> <rect x="2.5" y="15" width="10" height="95" fill="#f1f5f9" stroke="#94a3b8" stroke-width=".8" rx="1"/> <rect x="2.5" y="115" width="10" height="10" fill="#1e293b" rx="1"/> <rect x="3.5" y="116" width="8" height="3" fill="#38bdf8"/> <line x1="7.5" y1="2" x2="7.5" y2="10" stroke="#1e293b" stroke-width=".8"/> </svg></div>`;
  return L.divIcon({
    className: "",
    html: svg,
    iconSize: [pxWidth, pxLength],
    iconAnchor: [pxWidth / 2, pxLength / 2],
  });
}

const map = L.map("map", { zoomControl: false }).setView([50, 7], 6);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap",
}).addTo(map);
L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
  maxZoom: 18,
  opacity: 0.85,
  attribution: "© OpenSeaMap",
}).addTo(map);

map.on("zoomend", () => {
  if (marker) {
    const lat = marker.getLatLng().lat;
    marker.setIcon(getVesselIcon(lat, map.getZoom()));
    setTimeout(() => {
      const r = document.getElementById("vesselRotator");
      if (r) r.style.transform = `rotate(${Math.round(lastValidHeading)}deg)`;
    }, 10);
  }
});

const searchBtn = document.getElementById("searchBtn");
const mapLockBtn = document.getElementById("mapLockBtn");
const headUpBtn = document.getElementById("headUpBtn");
const searchPanel = document.getElementById("searchPanel");
const searchInput = document.getElementById("destinationSearch");
const suggestions = document.getElementById("suggestions");
const lockDelayInp = document.getElementById("lockDelayInput");
const mapContainer = document.getElementById("map");

searchBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  searchPanel.classList.toggle("open");
  if (searchPanel.classList.contains("open")) searchInput.focus();
});
mapLockBtn.addEventListener("click", () => {
  followVessel = !followVessel;
  if (followVessel) {
    mapLockBtn.classList.remove("unlocked");
    if (marker) map.panTo(marker.getLatLng());
  } else {
    headUp = false;
    mapContainer.style.transform = "rotate(0deg)";
    headUpBtn.classList.remove("active");
    mapLockBtn.classList.add("unlocked");
  }
});
headUpBtn.addEventListener("click", () => {
  headUp = !headUp;
  if (headUp) {
    headUpBtn.classList.add("active");
    followVessel = true;
    mapLockBtn.classList.remove("unlocked");
    if (marker) map.panTo(marker.getLatLng());
  } else {
    headUpBtn.classList.remove("active");
    mapContainer.style.transform = "rotate(0deg)";
  }
});
map.on("dragstart", () => {
  if (followVessel) {
    followVessel = false;
    headUp = false;
    mapContainer.style.transform = "rotate(0deg)";
    headUpBtn.classList.remove("active");
    mapLockBtn.classList.add("unlocked");
  }
});
if (lockDelayInp)
  lockDelayInp.addEventListener("input", () => {
    lockDelayMinutes = Math.max(0, parseInt(lockDelayInp.value) || 0);
  });

function addSuggestion(place, extra = "") {
  const div = document.createElement("div");
  div.className = "suggestion";
  const type = document.createElement("span");
  type.className = "suggestion-type " + (place.type || "");
  type.textContent = (place.type || "POI").toUpperCase();
  const name = document.createElement("span");
  name.textContent = place.name;
  const km = document.createElement("span");
  km.className = "suggestion-km";
  km.textContent =
    place.river === "benelux"
      ? `NL/BE${extra ? " · " + extra : ""}`
      : `KM ${Number(place.km).toFixed(1)} · ${RIVER_LABEL[place.river] || ""}`;
  div.append(type, name, km);
  div.onclick = () => selectDestination(place);
  suggestions.appendChild(div);
}

function selectDestination(place) {
  selectedDestination = place;
  localStorage.setItem(
    "destination",
    JSON.stringify({
      name: place.name,
      river: place.river,
      lat: place.lat,
      lon: place.lon,
      km: place.km,
      node: place.node,
    })
  );
  searchInput.value = place.name;
  suggestions.innerHTML = "";
  searchPanel.classList.remove("open");
  if (window.hudUpdate)
    window.hudUpdate({
      dest: `${place.name} · ${RIVER_LABEL[place.river] || ""}`,
    });
  triggerRouteRedraw();
}

let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const value = searchInput.value.toLowerCase().trim();
  suggestions.innerHTML = "";
  if (value.length < 1) return;

  places
    .filter((p) => p.name.toLowerCase().includes(value))
    .slice(0, 10)
    .forEach((p) => addSuggestion(p));
  if (value.length < 2) return;

  searchTimer = setTimeout(async () => {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&countrycodes=nl,be&q=${encodeURIComponent( value )}`;
      const res = await fetch(url, { headers: { "Accept-Language": "en" } });
      if (!res.ok) return;
      const data = await res.json();
      const existing = new Set(
        [...suggestions.children].map((x) =>
          x.querySelector("span:nth-child(2)")?.textContent?.toLowerCase()
        )
      );
      data.forEach((x) => {
        const name = (x.display_name || x.name || "").split(",")[0];
        if (!name || existing.has(name.toLowerCase())) return;
        const lat = Number(x.lat),
          lon = Number(x.lon);
        const node = nearestBeneluxNode(lat, lon);
        if (!node) return;
        addSuggestion(
          {
            name,
            type: x.type === "city" ? "city" : "place",
            river: "benelux",
            lat,
            lon,
            node,
          },
          "OSM"
        );
      });
    } catch (e) {
      console.warn("Nominatim search failed", e);
    }
  }, 350);
});

function restoreDestination() {
  const raw = localStorage.getItem("destination");
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    const found =
      places.find((p) => p.name === saved.name && p.river === saved.river) ||
      (saved.river === "benelux" ? { ...saved, type: "city" } : null);
    if (found) {
      selectedDestination = found;
      searchInput.value = found.name;
      if (window.hudUpdate)
        window.hudUpdate({
          dest: `${found.name} · ${RIVER_LABEL[found.river]}`,
        });
    }
  } catch {}
}

Promise.all([
  loadRiverGeoJSON(asset("rhine.geojson"), "rhine"),
  loadRiverGeoJSON(asset("moselle.geojson"), "moselle"),
  loadPlaces(asset("rhine-places.json"), "rhine"),
  loadPlaces(asset("moselle-places.json"), "moselle"),
  loadBeneluxNetwork(),
]).then(() => restoreDestination());

function triggerRouteRedraw() {
  if (lastCalculatedKm && selectedDestination) {
    const info = computeRouteInfo(lastCalculatedKm, selectedDestination);
    if (info) drawRoute(info.segments);
  }
}

navigator.geolocation.watchPosition(
  async (position) => {
    const lat = position.coords.latitude,
      lon = position.coords.longitude;
    lastCalculatedPosition = { lat, lon };
    const rawSpeed = (position.coords.speed || 0) * 3.6;
    const kmResult = await resolveKm(lat, lon);
    lastCalculatedKm = kmResult;

    speedHistory.push(rawSpeed);
    if (speedHistory.length > 10) speedHistory.shift();
    const avgSpeed =
      speedHistory.reduce((a, b) => a + b, 0) / speedHistory.length;

    let heading = position.coords.heading;
    if (heading === null || isNaN(heading)) {
      if (
        previousCoords &&
        distance(previousCoords.lat, previousCoords.lon, lat, lon) > 0.005
      ) {
        const dLon = ((lon - previousCoords.lon) * Math.PI) / 180,
          lat1 = (previousCoords.lat * Math.PI) / 180,
          lat2 = (lat * Math.PI) / 180;
        const y = Math.sin(dLon) * Math.cos(lat2),
          x =
            Math.cos(lat1) * Math.sin(lat2) -
            Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        heading = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
      } else heading = lastValidHeading;
    }
    lastValidHeading = heading;
    previousCoords = { lat, lon };

    if (!marker)
      marker = L.marker([lat, lon], {
        icon: getVesselIcon(lat, map.getZoom()),
      }).addTo(map);
    else marker.setLatLng([lat, lon]);
    setTimeout(() => {
      const r = document.getElementById("vesselRotator");
      if (r) r.style.transform = `rotate(${Math.round(heading)}deg)`;
    }, 50);
    if (headUp)
      mapContainer.style.transform = `rotate(${-Math.round(heading)}deg)`;

    if (firstFix) {
      map.setView([lat, lon], 14);
      firstFix = false;
    } else if (followVessel) map.panTo([lat, lon]);

    const update = {
      km:
        kmResult && kmResult.km !== null && kmResult.km !== undefined
          ? Number(kmResult.km).toFixed(1)
          : "---.-",
      kmSrc: kmSource,
      sog: avgSpeed.toFixed(1),
      gps: true,
      river: kmResult ? kmResult.river : null,
    };

    if (selectedDestination && kmResult) {
      const moveSpd = Math.max(avgSpeed, 1.5);
      const routeInfo = computeRouteInfo(kmResult, selectedDestination);
      if (routeInfo) {
        const distLeft = routeInfo.distance,
          totalLocks = routeInfo.locks.length;
        if (totalLocks > 0) {
          const nextLock = routeInfo.locks[0];
          const lockEtaHours =
            nextLock.distanceFromVessel !== undefined
              ? nextLock.distanceFromVessel / moveSpd
              : 0;
          const lockArrivalTime = new Date(Date.now() + lockEtaHours * 3600000);
          update.nextLockEta = lockArrivalTime.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
          update.locksRemaining = `${totalLocks} REMAINING`;
        } else {
          update.nextLockEta = "--:--";
          update.locksRemaining = "0 REMAINING";
        }
        const ttlMin = totalLocks * lockDelayMinutes;
        const etaHours = distLeft / moveSpd + ttlMin / 60;
        update.eta = new Date(
          Date.now() + etaHours * 3600000
        ).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        drawRoute(routeInfo.segments);
      }
    } else {
      update.eta = "--:--";
      update.nextLockEta = "--:--";
      update.locksRemaining = "0 REMAINING";
      clearRoute();
    }

    if (window.hudUpdate) window.hudUpdate(update);
  },
  (error) => {
    console.error(error);
    if (window.hudUpdate) window.hudUpdate({ gpsError: true });
  },
  { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
);

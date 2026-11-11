const RESERVED = new Set(['cleared', 'occupied']);
const MODES = new Set(['automatic', 'manual']);
const USES = new Set(['closed', 'arrival', 'departure', 'mixed']);

function accepts(runway, operation) {
  return runway.operationUse === operation || runway.operationUse === 'mixed';
}

function endpoints(runway) {
  return [runway.endA ?? runway.thresholdA, runway.endB ?? runway.thresholdB];
}

function intersects(a, b) {
  const [p, q] = endpoints(a);
  const [r, s] = endpoints(b);
  const cross = (x, y, z) =>
    (y.lng - x.lng) * (z.lat - x.lat) - (y.lat - x.lat) * (z.lng - x.lng);
  const overlap = key => Math.max(Math.min(p[key], q[key]), Math.min(r[key], s[key])) <=
    Math.min(Math.max(p[key], q[key]), Math.max(r[key], s[key]));
  return overlap('lat') && overlap('lng') && cross(p, q, r) * cross(p, q, s) <= 0 &&
    cross(r, s, p) * cross(r, s, q) <= 0;
}

function validPoint(point) {
  return Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90 &&
    Number.isFinite(point?.lng) && Math.abs(point.lng) <= 180;
}

function validConfiguration(airfield) {
  const mode = airfield.multiRunway;
  const runways = airfield.runways;
  if (!MODES.has(mode?.arrival) || !MODES.has(mode?.departure) ||
      !Array.isArray(runways) || !runways.some(r => r?.operationUse !== 'closed')) return false;
  const ids = new Set();
  for (const runway of runways) {
    if (!runway?.id || ids.has(runway.id) || !USES.has(runway.operationUse) ||
        !['A', 'B'].includes(runway.active_end) || !validPoint(runway.thresholdA) ||
        !validPoint(runway.thresholdB) || !endpoints(runway).every(validPoint) ||
        (runway.thresholdA.lat === runway.thresholdB.lat && runway.thresholdA.lng === runway.thresholdB.lng) ||
        !Number.isFinite(runway.heading_true_ab) ||
        (runway.apron != null && !validPoint(runway.apron))) return false;
    ids.add(runway.id);
  }
  return airfield.apron == null || validPoint(airfield.apron);
}

function assignedRunway(runway, end) {
  if (runway.active_end === end) return runway;
  return { ...runway, active_end: end, beacons: runway.beaconsByEnd?.[end] };
}

function createMultiRunway({ airfield, geometry, holdShort, apron, distance, etaToPoint, beaconPoint, now = Date.now }) {
  const requests = new Map();
  const getRunway = id => airfield().runways.find(runway => runway.id === id);

  function assign(name, runwayId, end) {
    const request = requests.get(name);
    const runway = getRunway(runwayId);
    if (request?.status !== 'pending' || !runway || !accepts(runway, request.operation) ||
        !['A', 'B'].includes(end)) return false;
    const directionInUse = [...requests.values()].some(item =>
      item.runway?.id === runwayId && item.runway.active_end !== end && item.status !== 'vacated'
    );
    if (directionInUse) return false;
    const selected = assignedRunway(runway, end);
    const geom = geometry(selected);
    const hold = holdShort(geom);
    const parking = apron(geom);
    if (!geom || !hold || !parking) return false;
    Object.assign(request, { runway: selected, geom, hold, parking, status: 'assigned' });
    return true;
  }

  function assignAutomatically(request) {
    for (const runway of airfield().runways) {
      if (assign(request.name, runway.id, runway.active_end)) return;
    }
  }

  function request(name, operation, callsign, emergency) {
    if (!name || !['arrival', 'departure'].includes(operation) || requests.has(name)) return false;
    const item = { name, operation, callsign, emergency: !!emergency, status: 'pending', requestedAt: now() };
    requests.set(name, item);
    if (airfield().multiRunway[operation] === 'automatic') assignAutomatically(item);
    return true;
  }

  function advance() {
    let changed = false;
    for (const item of requests.values()) {
      if (item.status === 'pending' && airfield().multiRunway[item.operation] === 'automatic') {
        assignAutomatically(item);
        if (item.status !== 'pending') changed = true;
      }
    }

    const ready = [...requests.values()].filter(item => item.status === 'ready')
      .sort((a, b) => Number(b.emergency) - Number(a.emergency) ||
        Number(b.operation === 'arrival') - Number(a.operation === 'arrival') ||
        a.readyAt - b.readyAt || a.requestedAt - b.requestedAt);
    for (const item of ready) {
      const blocked = [...requests.values()].some(other =>
        RESERVED.has(other.status) &&
        (other.runway.id === item.runway.id || intersects(other.runway, item.runway))
      );
      if (!blocked) {
        item.status = 'cleared';
        changed = true;
      }
    }

    const arrivalsByRunway = new Map();
    for (const item of requests.values()) {
      if (item.operation !== 'arrival' || !['assigned', 'ready'].includes(item.status)) continue;
      const arrivals = arrivalsByRunway.get(item.runway.id) ?? [];
      arrivals.push({ item, eta: etaToPoint(item.name, item.geom.B1) ?? Infinity });
      arrivalsByRunway.set(item.runway.id, arrivals);
    }
    for (const arrivals of arrivalsByRunway.values()) {
      arrivals.sort((a, b) => Number(b.item.status === 'ready') - Number(a.item.status === 'ready') ||
        Number(b.item.emergency) - Number(a.item.emergency) ||
        a.eta - b.eta || a.item.requestedAt - b.item.requestedAt);
      for (const [index, { item }] of arrivals.entries()) {
        const beacon = index < 30 ? 'B' + (index + 1) : undefined;
        if (item.beacon !== beacon) {
          item.beacon = beacon;
          item.reportedBeacon = undefined;
          changed = true;
        }
      }
    }
    return changed;
  }

  function report(name, state, position, aux) {
    const item = requests.get(name);
    if (!item || item.status === 'pending') return false;

    if (item.status === 'assigned') {
      const arriving = item.operation === 'arrival';
      const target = arriving ? item.beacon && beaconPoint(item.geom, Number(item.beacon.slice(1))) : item.hold;
      if (!target || state !== (arriving ? item.beacon : 'HOLD_SHORT') ||
          !Number.isFinite(position?.latitude) || !Number.isFinite(position?.longitude) ||
          distance(position.latitude, position.longitude, target.lat, target.lon) > (arriving ? 600 : 90) ||
          (!arriving && aux?.holdShortTarget &&
            (!Number.isFinite(aux.holdShortTarget.lat) || !Number.isFinite(aux.holdShortTarget.lon) ||
             distance(aux.holdShortTarget.lat, aux.holdShortTarget.lon, target.lat, target.lon) > 1))) return false;
      if (arriving && state !== 'B1') {
        if (item.reportedBeacon === state) return false;
        item.reportedBeacon = state;
        return true;
      }
      item.status = 'ready';
      item.readyAt = now();
    } else if (item.status === 'cleared' && state === 'RUNWAY_OCCUPIED') {
      item.status = 'occupied';
    } else if (item.status === 'occupied' && item.operation === 'arrival' && state === 'RUNWAY_CLEAR') {
      item.status = 'vacated';
    } else if ((item.status === 'occupied' && item.operation === 'departure' && state === 'AIRBORNE') ||
        (item.status === 'vacated' && state === 'APRON_STOP')) {
      requests.delete(name);
    } else if (item.status !== 'vacated' || state !== 'TAXI_APRON') {
      return false;
    }
    return true;
  }

  function cancel(name) {
    const item = requests.get(name);
    if (!item || RESERVED.has(item.status)) return false;
    return requests.delete(name);
  }

  function goAround(name) {
    const item = requests.get(name);
    if (item?.operation !== 'arrival' || item.status !== 'cleared') return false;
    item.status = 'assigned';
    item.readyAt = undefined;
    return true;
  }

  function expire(isPresent) {
    let changed = false;
    for (const item of requests.values()) {
      if (!isPresent(item.name) && now() - item.requestedAt > 60_000) changed = cancel(item.name) || changed;
    }
    return changed;
  }

  function snapshot(name) {
    const own = requests.get(name);
    const runwayId = own?.runway?.id;
    const assignedOps = {};
    const opsTargets = {};
    const landings = [];
    const takeoffs = [];
    const queuedNames = [];
    let inUse = null;
    for (const item of requests.values()) {
      if (!item.runway) continue;
      const sameRunway = item.runway.id === runwayId;
      const arriving = item.operation === 'arrival';
      if (item.status !== 'occupied' && item.status !== 'vacated') {
        queuedNames.push(item.name);
        if (sameRunway) (arriving ? landings : takeoffs).push(item);
      }
      let fix;
      let point;
      if (sameRunway && item.status === 'occupied') {
        inUse = { name: item.name, action: arriving ? 'landing' : 'takeoff' };
      }
      if (arriving && (item.status === 'occupied' || item.status === 'vacated')) {
        fix = 'APRON';
        point = item.parking;
      } else if (item.status === 'cleared') {
        fix = arriving ? 'FINAL' : 'RWY';
        point = arriving ? item.geom.thr : item.geom.departureStart;
      } else if (item.status === 'assigned' || item.status === 'ready') {
        fix = arriving ? item.beacon : 'HOLD_SHORT';
        point = arriving ? fix && beaconPoint(item.geom, Number(fix.slice(1))) : item.hold;
      }
      if (fix && point) {
        assignedOps[item.name] = fix === 'FINAL' ? fix : 'A_TO_' + fix;
        opsTargets[item.name] = { fix, ...point, runwayId: item.runway.id };
      }
    }
    const firstCleared = (a, b) => Number(b.status === 'cleared') - Number(a.status === 'cleared');
    const arrivalOrder = (a, b) => firstCleared(a, b) ||
      Number(a.beacon?.slice(1) ?? Infinity) - Number(b.beacon?.slice(1) ?? Infinity);
    const publicRequest = ({ name, callsign }) => ({ name, callsign });
    return {
      runwayId,
      runwayEnd: own?.runway?.active_end,
      requestOperation: own?.status !== 'vacated' ? own?.operation : undefined,
      awaitingRunway: own?.status === 'pending',
      assignedOps,
      opsTargets,
      landings: landings.sort(arrivalOrder).map(publicRequest),
      takeoffs: takeoffs.sort(firstCleared).map(publicRequest),
      queuedNames,
      inUse,
    };
  }

  function pending() {
    return [...requests.values()].filter(item => item.status === 'pending' &&
      airfield().multiRunway[item.operation] === 'manual')
      .map(({ name, callsign, operation }) => ({ name, callsign, operation }));
  }

  return { request, assign, advance, report, cancel, goAround, expire, snapshot, pending,
    has: name => requests.has(name),
    busy: () => requests.size > 0 };
}

module.exports = { createMultiRunway, validConfiguration };

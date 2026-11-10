const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const cache = new Map();
const pending = new Map();
const MAX_CACHE_ENTRIES = 128;
const KNOWN_APRONS = {
  // Punto interior de Apron A en https://www.openstreetmap.org/way/766342921.
  EHRD: [{ lat: 51.95154662, lng: 4.43326429 }],
};

function apronInterior(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 4) return null;
  if (!geometry.every(point => Number.isFinite(point?.lat) && Number.isFinite(point?.lon))) return null;
  const first = geometry[0];
  const last = geometry.at(-1);
  if (first.lat !== last.lat || first.lon !== last.lon) return null;

  const minLat = Math.min(...geometry.map(point => point.lat));
  const maxLat = Math.max(...geometry.map(point => point.lat));
  let best = null;
  let width = 0;
  for (let sample = 1; sample <= 9; sample++) {
    const lat = minLat + (maxLat - minLat) * sample / 10;
    const intersections = [];
    for (let i = 1; i < geometry.length; i++) {
      const a = geometry[i - 1];
      const b = geometry[i];
      if ((a.lat > lat) === (b.lat > lat)) continue;
      intersections.push(a.lon + (b.lon - a.lon) * (lat - a.lat) / (b.lat - a.lat));
    }
    intersections.sort((a, b) => a - b);
    for (let i = 1; i < intersections.length; i += 2) {
      const span = intersections[i] - intersections[i - 1];
      if (span <= width) continue;
      width = span;
      best = { lat, lng: (intersections[i] + intersections[i - 1]) / 2 };
    }
  }
  return best;
}

function distanceToRunway(point, runway) {
  const a = runway.endA ?? runway.thresholdA;
  const b = runway.endB ?? runway.thresholdB;
  const lonScale = Math.cos(point.lat * Math.PI / 180);
  const bx = (b.lng - a.lng) * lonScale;
  const by = b.lat - a.lat;
  const px = (point.lng - a.lng) * lonScale;
  const py = point.lat - a.lat;
  const lengthSquared = bx * bx + by * by;
  const fraction = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / lengthSquared));
  return 111195 * Math.hypot(px - fraction * bx, py - fraction * by);
}

function withApronSuggestions(airport, points) {
  if (!points.length) return airport;
  const clearAprons = points.filter(point => airport.runways.every(runway =>
    distanceToRunway(point, runway) > (runway.width_m ?? 45) / 2 + 15
  ));
  return {
    ...airport,
    runways: airport.runways.map(runway => {
      let closest;
      let distance = Infinity;
      for (const point of clearAprons) {
        const candidateDistance = distanceToRunway(point, runway);
        if (candidateDistance < distance) {
          closest = point;
          distance = candidateDistance;
        }
      }
      return closest ? { ...runway, apronSuggestion: closest } : runway;
    }),
  };
}

async function fetchAprons(icao) {
  const query = '[out:json][timeout:5];area["aeroway"="aerodrome"]["icao"="' +
    icao + '"]->.airport;way["aeroway"="apron"](area.airport);out geom;';
  const url = new URL(OVERPASS_URL);
  url.searchParams.set('data', query);
  const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error('Overpass HTTP ' + response.status);
  const data = await response.json();
  return (data.elements ?? []).map(element => apronInterior(element.geometry)).filter(Boolean);
}

async function suggestAirportAprons(airport) {
  if (!/^[A-Z]{4}$/.test(airport.icao) || !airport.runways.length) return airport;
  const previous = cache.get(airport.icao);
  if (previous && previous.expires > Date.now()) {
    return withApronSuggestions(airport, previous.points);
  }

  if (!pending.has(airport.icao)) {
    const load = fetchAprons(airport.icao)
      .catch(() => [])
      .then(points => {
        const suggestions = points.length ? points : KNOWN_APRONS[airport.icao] ?? [];
        if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(airport.icao)) {
          cache.delete(cache.keys().next().value);
        }
        cache.set(airport.icao, {
          points: suggestions,
          expires: Date.now() + (points.length ? 24 * 60 : 5) * 60_000,
        });
        return suggestions;
      })
      .finally(() => pending.delete(airport.icao));
    pending.set(airport.icao, load);
  }
  return withApronSuggestions(airport, await pending.get(airport.icao));
}

module.exports = { suggestAirportAprons, apronInterior, withApronSuggestions };

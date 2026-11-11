const DATA_URL = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main';
const CACHE_MS = 24 * 60 * 60 * 1000;
const FEET_TO_METERS = 0.3048;
const ICAO = /^[A-Z]{4}$/;
const searchMetadata = new WeakMap();

function normalizeSearch(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function* csvRows(text) {
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || field) yield row;
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (row.length || field) yield [...row, field];
}

function* csvRecords(text, requiredColumns) {
  const rows = csvRows(text);
  const headers = rows.next().value ?? [];
  if (!requiredColumns.every(column => headers.includes(column))) {
    throw new Error('Unexpected OurAirports CSV format');
  }
  for (const row of rows) yield key => row[headers.indexOf(key)] ?? '';
}

function number(value) {
  const parsed = value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function point(lat, lng) {
  return lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;
}

function bearing(A, B) {
  const rad = Math.PI / 180;
  const a = A.lat * rad;
  const b = B.lat * rad;
  const lon = (B.lng - A.lng) * rad;
  return (Math.atan2(Math.sin(lon) * Math.cos(b), Math.cos(a) * Math.sin(b) -
    Math.sin(a) * Math.cos(b) * Math.cos(lon)) / rad + 360) % 360;
}

function displacedThreshold(origin, opposite, feet) {
  if (!feet || feet < 0) return origin;
  const rad = Math.PI / 180;
  const distance = feet * FEET_TO_METERS / 6371008.8;
  const course = bearing(origin, opposite) * rad;
  const lat = origin.lat * rad;
  const nextLat = Math.asin(Math.sin(lat) * Math.cos(distance) +
    Math.cos(lat) * Math.sin(distance) * Math.cos(course));
  const lonOffset = Math.atan2(Math.sin(course) * Math.sin(distance) * Math.cos(lat),
    Math.cos(distance) - Math.sin(lat) * Math.sin(nextLat));
  return { lat: nextLat / rad, lng: ((origin.lng + lonOffset / rad + 540) % 360) - 180 };
}

function buildAirportCatalog(airportCsv, runwayCsv) {
  const airports = new Map();
  const byIdent = new Map();
  for (const row of csvRecords(airportCsv, ['ident', 'name', 'latitude_deg', 'longitude_deg'])) {
    const ident = row('ident');
    const icao = row('icao_code') || row('gps_code') || ident;
    if (!ICAO.test(icao) || row('type') === 'closed') continue;
    const airport = {
      id: 'ourairports-' + ident,
      icao,
      iata: row('iata_code') || undefined,
      name: row('name'),
      country: row('iso_country') || undefined,
      elevation_ft: number(row('elevation_ft')),
      location: point(number(row('latitude_deg')), number(row('longitude_deg'))),
      runways: [],
      source: 'ourairports',
      incompleteRunways: 0,
    };
    airports.set(icao, airport);
    byIdent.set(ident, airport);
    const city = row('municipality');
    const terms = normalizeSearch([icao, airport.iata, airport.name, city, row('keywords')].join(' '));
    searchMetadata.set(airport, {
      city,
      words: terms.split(' '),
      name: normalizeSearch(airport.name),
      priority: ['small_airport', 'medium_airport', 'large_airport'].indexOf(row('type')),
    });
  }
  for (const row of csvRecords(runwayCsv, ['id', 'airport_ident', 'closed', 'le_ident', 'he_ident',
    'le_latitude_deg', 'le_longitude_deg', 'he_latitude_deg', 'he_longitude_deg'])) {
    const airport = byIdent.get(row('airport_ident'));
    if (!airport || row('closed') === '1') continue;
    const identA = row('le_ident');
    const identB = row('he_ident');
    const A = point(number(row('le_latitude_deg')), number(row('le_longitude_deg')));
    const B = point(number(row('he_latitude_deg')), number(row('he_longitude_deg')));
    if (!A || !B || !identA || !identB || (A.lat === B.lat && A.lng === B.lng)) {
      airport.incompleteRunways++;
      continue;
    }
    const length = number(row('length_ft'));
    const width = number(row('width_ft'));
    airport.runways.push({
      id: 'ourairports-runway-' + row('id'),
      identA,
      identB,
      endA: A,
      endB: B,
      thresholdA: displacedThreshold(A, B, number(row('le_displaced_threshold_ft'))),
      thresholdB: displacedThreshold(B, A, number(row('he_displaced_threshold_ft'))),
      heading_true_ab: bearing(A, B),
      length_m: length == null ? undefined : Math.round(length * FEET_TO_METERS),
      width_m: width == null ? undefined : Math.round(width * FEET_TO_METERS),
      surface: row('surface') || undefined,
    });
  }
  return airports;
}

let cache = null;
let loading = null;
async function download(filename) {
  const response = await fetch(DATA_URL + '/' + filename, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('OurAirports HTTP ' + response.status);
  return response.text();
}

async function loadCatalog() {
  if (!cache || Date.now() >= cache.expires) {
    loading ??= Promise.all([download('airports.csv'), download('runways.csv')])
      .then(([airports, runways]) => {
        cache = { airports: buildAirportCatalog(airports, runways), expires: Date.now() + CACHE_MS };
      })
      .catch(error => {
        if (!cache) throw error;
        cache.expires = Date.now() + 5 * 60 * 1000;
      })
      .finally(() => { loading = null; });
    await loading;
  }
  return cache.airports;
}

async function lookupAirport(icao) {
  if (!ICAO.test(icao)) return null;
  return (await loadCatalog()).get(icao) ?? null;
}

async function searchAirports(query) {
  const normalized = normalizeSearch(query);
  if (!normalized) return [];
  const tokens = normalized.split(' ');
  const matches = [];
  for (const airport of (await loadCatalog()).values()) {
    if (!airport.runways.length) continue;
    const { city, words, name, priority } = searchMetadata.get(airport);
    if (!tokens.every(token => words.some(word => word.startsWith(token)))) continue;

    const codes = [airport.icao.toLowerCase(), airport.iata?.toLowerCase() ?? ''];
    let rank = tokens.filter(token => words.includes(token)).length * 10;
    if (name.startsWith(normalized)) rank += 4;
    if (codes.some(code => code.startsWith(normalized))) rank += 8;
    if (codes.includes(normalized)) rank += 100;
    matches.push({ airport, city, rank, priority });
  }
  matches.sort((a, b) => b.rank - a.rank || b.priority - a.priority ||
    a.airport.name.localeCompare(b.airport.name));
  return matches.slice(0, 8).map(({ airport, city }) => ({
    icao: airport.icao, iata: airport.iata, name: airport.name, city,
  }));
}

module.exports = { lookupAirport, searchAirports, buildAirportCatalog };

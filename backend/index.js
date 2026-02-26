const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const ATC_DEFAULTS = {
    // === FSM / sticky & compliance ===
    FINAL_LOCK_RADIUS_M : 2000,   // dentro de 2 km de B1 no reordenar más (comprometido)
    MAX_B2_TO_B1_S : 180,         // si en >180 s no progresa de B2→B1, pierde orden (vuelve a WAIT)
    FINAL_DRIFT_MAX_M : 2500,     // si en FINAL se “abre” >2.5 km de B1, pierde FINAL
    // === B1 latch / anti-histéresis ===
    B1_LATCH_ON_M  : 3500,   // latch ON si estás dentro de 3.5 km
    B1_LATCH_OFF_M : 6000,   // latch OFF si te vas más allá de 6 km
    B1_LATCH_OFF_SUSTAIN_MS : 20000, // debe sostenerse 20 s para soltar

    // === Auto go-around ===
    FINAL_TIMEOUT_MS : 6 * 60 * 1000,     // 6 min en B1/FINAL sin ocupar pista => go-around
    GOAROUND_DRIFT_M : 9000,              // si se va >9 km de B1 (sostenido) => go-around
    GOAROUND_DRIFT_SUSTAIN_MS : 20000,    // 20 s sostenido
    LEADER_TIMEOUT_MS : 240 * 1000, // 4 min líder en FINAL sin RUNWAY_OCCUPIED => OUT
    LEADER_DRIFT_MAX_M : 9000,         // si se aleja >9 km del umbral activo => OUT

};

const  b1LatchByName = new Map();     // name -> { latched:boolean, farSince:number|null }
const  finalEnterByName = new Map();  // name -> timestamp cuando entró a B1/FINAL
const  driftSinceByName = new Map();  // name -> timestamp cuando empezó a “drift” lejos de B1
const finalLatchByName = new Map(); // name -> { latched:boolean, since:number }
function isFinalLatched(name) {
  return !!finalLatchByName.get(name)?.latched;
}
function setFinalLatched(name, on=true) {
  if (!name) return;
  if (on) finalLatchByName.set(name, { latched: true, since: Date.now() });
  else finalLatchByName.delete(name);
}


// ======================= TURN LEASE (líder de aterrizaje) =======================
const turnLeaseByName = new Map(); 
// name -> { startMs:number, lastAlongM:number|null, lastSeenMs:number }

function leaderName() {
  return runwayState.landings?.[0]?.name || null;
}

// Limpieza estándar cuando alguien pierde turno o completa
function clearTurnLease(name) {
  turnLeaseByName.delete(name);
}

function clearATC(name) {
  if (!name) return;

  // borrar directo por key
  if (runwayState.assignedOps) delete runwayState.assignedOps[name];
  if (runwayState.opsTargets)  delete runwayState.opsTargets[name];

  // 🔒 opcional pero recomendado: borrar por callsign si existiera como key
  const cs = String(userLocations?.[name]?.callsign || '').trim();
  if (cs) {
    if (runwayState.assignedOps) delete runwayState.assignedOps[cs];
    if (runwayState.opsTargets)  delete runwayState.opsTargets[cs];
  }
}


// OUT definitivo: se lo saca de la cola y debe pedir de nuevo
function dropFromLandings(name, reason) {
  // Si no está en cola, no hacer nada
  const wasInQueue = runwayState.landings.some(l => l.name === name);
  if (!wasInQueue) return;

  runwayState.landings = runwayState.landings.filter(l => l.name !== name);

  // limpiar timers/latches
  try { clearFinalEnter(name); } catch {}
  try { b1LatchByName.delete(name); } catch {}
  try { driftSinceByName.delete(name); } catch {}
  try { clearTurnLease(name); } catch {}

  // reset de FSM sticky (si querés mantenerlo, comentá estas 2 líneas)
  try { landingStateByName.delete(name); } catch {}
  try { approachPhaseByName.delete(name); } catch {}

  const r = String(reason || '').toLowerCase();

  const isTimeout = r.includes('timeout');
  const isDrift = r.includes('alejó') || r.includes('alejo') || r.includes('drift');
  const isLeader = r.includes('#1') || r.includes('líder') || r.includes('lider');

let key = 'landing-out';
const params = { reason: String(reason || '') };

if (isTimeout) key = 'landing-timeout';
else if (isDrift) key = 'landing-drift';
else if (isLeader) key = 'landing-turn-lost';

emitToUser(name, 'runway-msg', { key, params });

  // Replanificar inmediatamente
  try { enforceCompliance(); } catch {}
  try { planRunwaySequence(); } catch {}
  try { publishRunwayState(); } catch {}
}


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const userLocations = {};
const socketIdToName = {};

// === Airfield (pista activa en memoria) ===
let lastAirfield = null;

function getAtcSettings() {
  const s = lastAirfield?.atcSettings || {};
  const N = (v, fb) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

  return {
    FINAL_LOCK_RADIUS_M: N(s.FINAL_LOCK_RADIUS_M, ATC_DEFAULTS.FINAL_LOCK_RADIUS_M),
    MAX_B2_TO_B1_S: N(s.MAX_B2_TO_B1_S, ATC_DEFAULTS.MAX_B2_TO_B1_S),
    FINAL_DRIFT_MAX_M: N(s.FINAL_DRIFT_MAX_M, ATC_DEFAULTS.FINAL_DRIFT_MAX_M),

    B1_LATCH_ON_M: N(s.B1_LATCH_ON_M, ATC_DEFAULTS.B1_LATCH_ON_M),
    B1_LATCH_OFF_M: N(s.B1_LATCH_OFF_M, ATC_DEFAULTS.B1_LATCH_OFF_M),
    B1_LATCH_OFF_SUSTAIN_MS: N(s.B1_LATCH_OFF_SUSTAIN_MS, ATC_DEFAULTS.B1_LATCH_OFF_SUSTAIN_MS),

    FINAL_TIMEOUT_MS: N(s.FINAL_TIMEOUT_MS, ATC_DEFAULTS.FINAL_TIMEOUT_MS),
    GOAROUND_DRIFT_M: N(s.GOAROUND_DRIFT_M, ATC_DEFAULTS.GOAROUND_DRIFT_M),
    GOAROUND_DRIFT_SUSTAIN_MS: N(s.GOAROUND_DRIFT_SUSTAIN_MS, ATC_DEFAULTS.GOAROUND_DRIFT_SUSTAIN_MS),
    LEADER_TIMEOUT_MS: N(s.LEADER_TIMEOUT_MS, ATC_DEFAULTS.LEADER_TIMEOUT_MS),
    LEADER_DRIFT_MAX_M: N(s.LEADER_DRIFT_MAX_M, ATC_DEFAULTS.LEADER_DRIFT_MAX_M),

  };
}


// === Distancia Haversine unificada (metros) ===
const EARTH_RADIUS_M = 6371008.8; // IUGG mean Earth radius
const toRad = (d) => (d * Math.PI) / 180;

function getDistance(lat1, lon1, lat2, lon2) {
  if (
    typeof lat1 !== 'number' || typeof lon1 !== 'number' ||
    typeof lat2 !== 'number' || typeof lon2 !== 'number'
  ) return NaN;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);

  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

  // === ATC instruction throttling ===
  const INSTR_COOLDOWN_MS = 5000;
  const lastInstrByName = {}; // { [name]: { type: 'goto-beacon'|'turn-to-B1'|'cleared-to-land', ts: number } }


    // ==== Anti-histéresis por avión (FSM de aproximación) ====
  const PHASE_ORDER = ['TO_B2','TO_B1','FINAL','CLRD']; // orden estricto, no se retrocede
  const approachPhaseByName = new Map(); // name -> { phase: 'TO_B2'|'TO_B1'|'FINAL'|'CLRD', ts:number }

  // ==== Estado sticky de ARR/DEP por avión (sin retrocesos) ====
const LANDING_STATE_ORDER = ['ORD','B2','B1','FINAL','RUNWAY_CLEAR','IN_STANDS'];
const landingStateByName = new Map(); // name -> { state: 'ORD'|..., ts:number }

  // === OpsState (estado operativo reportado por el front) ===
  // Valores esperados (frontend): 
  // 'APRON_STOP' | 'TAXI_APRON' | 'TAXI_TO_RWY' | 'HOLD_SHORT' |
  // 'RUNWAY_OCCUPIED' | 'RUNWAY_CLEAR' | 'AIRBORNE' |
  // 'LAND_QUEUE' | 'B2' | 'B1' | 'FINAL'
  const opsStateByName = new Map(); // name -> { state: string, ts: number, aux?: object }
  // Lo que reporta el frontend (B#, RUNWAY_*, TAXI_*, etc.)
  const opsReportedByName = new Map(); // name -> { state, ts, aux }
  // Lo que impone el backend (FINAL / A_TO_Bx). Esto es lo que vos querés.
  const opsBackendByName = new Map();  // name -> { state, ts }


  // ✅ Para detectar flanco real de estado (prev -> next)
  const lastOpsStateByName = new Map(); // name -> string


function getReportedOpsState(name) {
  return opsReportedByName.get(name)?.state || null; // SOLO lo que confirmó el frontend
}

function getEffectiveOpsState(name) {
  const r = getReportedOpsState(name);                 // B#, RUNWAY_*
  const b = opsBackendByName.get(name)?.state || null; // FINAL / A_TO_Bx

  // 1) Críticos del frontend ganan siempre
  if (r === 'RUNWAY_OCCUPIED' || r === 'RUNWAY_CLEAR' || r === 'APRON_STOP') return r;

  // 2) FINAL backend (solo para UI/guía)
  if (b === 'FINAL') return 'FINAL';

  // 3) Beacons confirmados por frontend
  if (r && /^B\d+$/.test(r)) return r;

  // 4) Guía ATC si no hay nada mejor
  if (b && b.startsWith('A_TO_')) return b;

  return r || null;
}


function getOpsState(name) {
  return getEffectiveOpsState(name);
}


function isB1Latched(name) {
  return !!b1LatchByName.get(name)?.latched;
}

function updateB1LatchFor(name) {
  const st = getReportedOpsState(name);
  const latched = (st === 'B1' || st === 'FINAL');
  b1LatchByName.set(name, { latched, farSince: null });
}


function setFinalEnterNow(name) {
  if (!finalEnterByName.has(name)) finalEnterByName.set(name, Date.now());
}
function clearFinalEnter(name) {
  finalEnterByName.delete(name);
  driftSinceByName.delete(name);
}

function autoGoAround(name, reason) {
  // Si no está en cola, no hacemos nada
  const L = runwayState.landings.find(l => l.name === name);
  if (!L) return;

  // Quitar freeze / committed
  L.frozenLevel = 0;
  L.committed = false;

  // Reset de estados
  resetLandingState(name, 'ORD');
  try { setApproachPhase(name, 'TO_B1'); } catch {}
  markAdvancement(name);

  // Soltar latch para que no “pegue” B1 artificialmente
  b1LatchByName.set(name, { latched: false, farSince: null });

  // Aviso al piloto
  emitToUser(name, 'runway-msg', {
    text: `Go-around automático (${reason}). Reingresando en secuencia.`,
    key: 'auto-go-around'
  });

  // replanificar
  enforceCompliance();
  planRunwaySequence();
  publishRunwayState();
}


function getLandingState(name) {
  return landingStateByName.get(name)?.state || 'ORD';
}
function setLandingStateForward(name, next) {
  const cur = getLandingState(name);
  const idxCur = LANDING_STATE_ORDER.indexOf(cur);
  const idxNext = LANDING_STATE_ORDER.indexOf(next);
  if (idxNext > idxCur) {
    landingStateByName.set(name, { state: next, ts: Date.now() });
    // console.log(`[LST] ${name}: ${cur} -> ${next}`);
  }
}
// ⚠️ Sólo usar si querés “borrar” el estado (p.ej. go-around explícito)
function resetLandingState(name, to='ORD') {
  landingStateByName.set(name, { state: to, ts: Date.now() });
}


  function getPhaseIdx(p){ return Math.max(0, PHASE_ORDER.indexOf(p)); }
  function getApproachPhase(name){
    return approachPhaseByName.get(name)?.phase || 'TO_B2';
  }
  function setApproachPhase(name, nextPhase){
    const cur = getApproachPhase(name);
    if (getPhaseIdx(nextPhase) > getPhaseIdx(cur)) {
      approachPhaseByName.set(name, { phase: nextPhase, ts: Date.now() });
      // console.log(`[PHASE] ${name}: ${cur} -> ${nextPhase}`);
    }
  }


  // Beacons activos desde el airfield
  function getActiveBeacons() {
    const rw = lastAirfield?.runways?.[0];
    if (!rw) return null;
    const arr = rw.beacons;
    if (!Array.isArray(arr)) return null;
    const B1 = arr.find(b => (b.name || '').toUpperCase() === 'B1');
    const B2 = arr.find(b => (b.name || '').toUpperCase() === 'B2');
    if (!B1 || !B2) return null;
    return {
      B1: { lat: B1.lat, lon: B1.lon },
      B2: { lat: B2.lat, lon: B2.lon },
    };
  }

  function distUserToLatLonM(name, lat, lon) {
    const u = userLocations[name];
    if (!u) return Infinity;
    return getDistance(u.latitude, u.longitude, lat, lon);
  }

  function maybeEmitInstruction(name, instr) {
    const last = lastInstrByName[name];
    const now = Date.now();
    if (!last || last.type !== instr.type || (now - last.ts) > INSTR_COOLDOWN_MS) {
      emitToUser(name, 'atc-instruction', instr);
      lastInstrByName[name] = { type: instr.type, ts: now };
    }
  }

  // Emite a todos un "sequence-update" con slots y beacons
// function publishSequenceUpdate() {
//   const g = activeRunwayGeom();
//   const slots = (runwayState.timelineSlots || []).map(s => ({
//     opId: s.opId,
//     type: s.type,
//     name: (s.opId || '').split('#')[1],
//     startMs: s.startMs,
//     endMs: s.endMs,
//     frozen: s.frozen,
//   }));
//   io.emit('sequence-update', {
//     serverTime: Date.now(),
//     airfield: lastAirfield || null,
//     beacons: g ? { B1: g.B1, B2: g.B2 } : null,
//     slots,
//   });
// }



/* =======================================================================================
   ░█▀▀░█░█░█▄█░█░█░█▀▀░█░█░█▀▀░█▀▄░█░█      RUNWAY SCHEDULER (NUEVO)
   ======================================================================================= */

// ========= Configuración ATC =========
const NM_TO_M = 1852;
const B1_DIST_NM = 2.5;       // ~3–4 NM
const B2_DIST_NM = 3.5;       // ~6–8 NM
const STACK_SPACING_NM = 1.5; // separación extra entre aviones en la radial de B2
const B1_FREEZE_RADIUS_M = 2500;   // a este radio de B1 se congela el turno
const BEACON_REACHED_M = 600;      // umbral para considerar “llegó” a un beacon
const INTERLEAVE_WINDOW_S = 120;   // ventana de intercalado ±2 min
const MAX_DELAY_SHIFT_S = 60;      // máximo corrimiento permitido de slots no-frozen


// ROT por categoría (segundos)
const ROT_BY_CAT = {
  GLIDER: 80,
  LIGHT: 100,
  TURBOPROP: 130,
  JET_LIGHT: 140,
  JET_MED: 160,
  HEAVY: 180,
};

// Wake extra por categoría previa → siguiente (segundos)
const WAKE_EXTRA = {
  HEAVY:     { GLIDER:60, LIGHT:60, TURBOPROP:60, JET_LIGHT:60, JET_MED:60, HEAVY:60 },
  JET_MED:   { GLIDER:30, LIGHT:30, TURBOPROP:0,  JET_LIGHT:0,  JET_MED:0,  HEAVY:0  },
  JET_LIGHT: { GLIDER:30, LIGHT:30, TURBOPROP:0,  JET_LIGHT:0,  JET_MED:0,  HEAVY:0  },
  TURBOPROP: { GLIDER:0,  LIGHT:0,  TURBOPROP:0,  JET_LIGHT:0,  JET_MED:0,  HEAVY:0  },
  LIGHT:     { GLIDER:0,  LIGHT:0,  TURBOPROP:0,  JET_LIGHT:0,  JET_MED:0,  HEAVY:0  },
  GLIDER:    { GLIDER:0,  LIGHT:0,  TURBOPROP:0,  JET_LIGHT:0,  JET_MED:0,  HEAVY:0  },
};

// Fallbacks si no te pasan slotMin desde el cliente
const MIN_LDG_SEP_MIN = 2; // aterrizaje: 2 min
const TKOF_OCCUPY_MIN = 2; // despegue: 2 min


// Utilidades geográficas (bearing/destino)
function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  let θ = Math.atan2(y, x) * 180/Math.PI;
  if (θ < 0) θ += 360;
  return θ;
}
function destinationPoint(lat, lon, bearingDeg_, distM) {
  const δ = distM / EARTH_RADIUS_M;
  const θ = toRad(bearingDeg_);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ), cosδ = Math.cos(δ);
  const sinφ2 = sinφ1*cosδ + cosφ1*sinδ*Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const y = Math.sin(θ)*sinδ*cosφ1;
  const x = cosδ - sinφ1*sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);
  return { lat: (φ2*180/Math.PI), lon: ((λ2*180/Math.PI + 540) % 360) - 180 };
}

function equirectMeters(lat1, lon1, lat2, lon2) {
  // aproximación local (válida para distancias pequeñas)
  const x = toRad(lon2 - lon1) * Math.cos(toRad((lat1 + lat2) / 2)) * EARTH_RADIUS_M;
  const y = toRad(lat2 - lat1) * EARTH_RADIUS_M;
  return { x, y };
}

// along-track respecto al umbral activo, positivo "antes del umbral", negativo "pasado"
function alongTrackToThresholdM(userLat, userLon) {
  const g = activeRunwayGeom();
  if (!g) return null;

  const thr = g.thr;
  const appBrg = g.app_brg; // dirección desde el umbral hacia afuera (aprox)
  // OJO: app_brg está definido como rumbo de aproximación (desde afuera hacia umbral),
  // pero en tu activeRunwayGeom(): app_brg = hdg_thr_to_opp + 180, que es "hacia afuera".
  // Entonces el vector "hacia afuera" es app_brg. Perfecto: along>0 está afuera, near threshold va a 0.

  const v = equirectMeters(thr.lat, thr.lon, userLat, userLon);
  const ux = Math.sin(toRad(appBrg));
  const uy = Math.cos(toRad(appBrg));
  const along = v.x * ux + v.y * uy; // proyección sobre eje "hacia afuera"
  return along; // m
}




function crossedThreshold(name) {
  const u = userLocations[name];
  const g = activeRunwayGeom();
  if (!u || !g) return false;

  const S = getAtcSettings();
  const st = getReportedOpsState(name);

  // sólo nos interesa si estaba en fase final-like pero NO ocupó pista
  if (st !== 'FINAL' && st !== 'B1') return false;

  // Si ya ocupó pista, NO es overshoot
  if (st === 'RUNWAY_OCCUPIED') return false;

  const along = alongTrackToThresholdM(u.latitude, u.longitude);
  if (along == null || !isFinite(along)) return false;

  const lease = turnLeaseByName.get(name) || { startMs: Date.now(), lastAlongM: null, lastSeenMs: Date.now() };

  // criterio: estaba "afuera" (along > +200m) y ahora está "pasado" (along < -200m)
  const wasOutside = (lease.lastAlongM != null && lease.lastAlongM > 200);
  const nowPassed  = (along < -200);

  lease.lastAlongM = along;
  lease.lastSeenMs = Date.now();
  turnLeaseByName.set(name, lease);

  // filtro anti-falsos: si está muy lejos del umbral, no considerarlo cruce
  const dThr = getDistance(u.latitude, u.longitude, g.thr.lat, g.thr.lon);
  if (!isFinite(dThr) || dThr > S.LEADER_DRIFT_MAX_M) return false;

  return wasOutside && nowPassed;
}


// ========= Categorías y helpers =========
function parseCategory(type='') {
  const T = String(type).toUpperCase();
  if (T.includes('HEAVY')) return 'HEAVY';
  if (T.includes('JET') && T.includes('MED')) return 'JET_MED';
  if (T.includes('JET')) return 'JET_LIGHT';
  if (T.includes('TURBO')) return 'TURBOPROP';
  if (T.includes('GLIDER') || T.includes('PLANEADOR')) return 'GLIDER';
  return 'LIGHT';
}
function rotSecondsFor(type) {
  return ROT_BY_CAT[parseCategory(type)] ?? 100;
}
function wakeExtraSeconds(prevCat, nextCat) {
  return (WAKE_EXTRA[prevCat]?.[nextCat]) ?? 0;
}

// ========= Estado de scheduler =========
const runwayState = {
  landings: [],   // { name, callsign, type, priority, etaB2, etaB1, frozenLevel, lastAdvancementTs, committed, emergency? }
  takeoffs: [],   // { name, callsign, type, ready, etReady }
  inUse: null,    // { action:'landing'|'takeoff', name, callsign, startedAt, slotMin }
  timelineSlots: [], // [{opId, type:'ARR'|'DEP', startMs, endMs, frozen}]
  lastOrder: { landings: [], takeoffs: [] },
};


// Guarda el corrimiento total aplicado a cada slot (opId) en ms
const shiftAccumMsByOpId = new Map();
// Último mapa de operaciones (para enriquecer sequence-update)
let lastOpsById = new Map();


// memoria para asignaciones e instrucciones ATC
const approachAssign = new Map(); // name -> { b1:{lat,lon}, b2:{lat,lon} }
const lastInstr = new Map();      // name -> { phase:'B2'|'B1'|'CLRD', ts:number }

// ========= Geometría de pista activa + beacons =========
function activeRunwayGeom() {
  const rw = lastAirfield?.runways?.[0];
  if (!rw) return null;
  const A = { lat: rw.thresholdA.lat, lon: rw.thresholdA.lng };
  const B = { lat: rw.thresholdB.lat, lon: rw.thresholdB.lng };
  const active = rw.active_end === 'B' ? 'B' : 'A';
  const thr = active === 'A' ? A : B;
  const opp = active === 'A' ? B : A;
  // rumbo de thr→opp
  const hdg_thr_to_opp = bearingDeg(thr.lat, thr.lon, opp.lat, opp.lon);
  // rumbo de aproximación (desde afuera hacia thr)
  const app_brg = (hdg_thr_to_opp + 180) % 360;

  // Si Pista.tsx ya guarda beacons, preferirlos
  const hasBeacons = Array.isArray(rw.beacons) && rw.beacons.length >= 2;
  let B1, B2;
  if (hasBeacons) {
    // espera objetos {name:'B1'|'B2', lat, lon}
    const b1e = rw.beacons.find(b => (b.name||'').toUpperCase()==='B1');
    const b2e = rw.beacons.find(b => (b.name||'').toUpperCase()==='B2');
    if (b1e && b2e) {
      B1 = { lat: b1e.lat, lon: b1e.lon };
      B2 = { lat: b2e.lat, lon: b2e.lon };
    }
  }
  // fallback: centerline extendida
  if (!B1 || !B2) {
    B1 = destinationPoint(thr.lat, thr.lon, app_brg, B1_DIST_NM*NM_TO_M);
    B2 = destinationPoint(thr.lat, thr.lon, app_brg, B2_DIST_NM*NM_TO_M);
  }
  return { rw, active, A, B, thr, opp, app_brg, B1, B2 };
}

function assignBeaconsFor(name) {
  const g = activeRunwayGeom();
  if (!g) return null;

  const baseB1 = g.B1;
  const baseB2 = g.B2;

  const idx = runwayState.landings.findIndex(l => l.name === name);
  const queueIndex = Math.max(0, idx); // 0 = primero, 1 = segundo, etc.

  let asg = approachAssign.get(name);
  if (!asg) {
    asg = {};
    approachAssign.set(name, asg);
  }

  // B1 siempre es el fix interno, común a todos
  asg.b1 = baseB1;

    // ✅ LATCH: si ya estás cerca de B1, nunca te degradamos a B2 aunque cambie el orden
  try {
    const u = userLocations[name];
    if (u) {
      const dToB1 = getDistance(u.latitude, u.longitude, baseB1.lat, baseB1.lon);

      // elegí un radio razonable: 3000–4000m funciona bien
      const LATCH_B1_M = 3500;

      if (isB1Latched(name)) {
        asg.b2 = baseB1;
        asg.beaconName = 'B1';
        asg.beaconIndex = 1;
        return asg;
      }

    }
  } catch {}

    // ✅ LATCH: si estás “pegado” a B1, tu beacon queda en B1 aunque cambie el orden
    if (isB1Latched(name)) {
      asg.b2 = baseB1;
      asg.beaconName = 'B1';
      asg.beaconIndex = 1;
      return asg;
    }



  if (queueIndex === 0) {
    // 👉 PRIMERO EN LA COLA: su beacon principal es B1
    asg.b2 = baseB1;          // usamos la posición de B1 también como "beacon" de espera
    asg.beaconName = 'B1';
    asg.beaconIndex = 1;
  } else {
    // 👉 SEGUNDO → B2, TERCERO → B3, etc. más lejos
    const distB2FromThr = getDistance(g.thr.lat, g.thr.lon, baseB2.lat, baseB2.lon);

    const offsetIndex = queueIndex - 1; // 0 => B2, 1 => B3, 2 => B4...
    const distOffsetM = offsetIndex * STACK_SPACING_NM * NM_TO_M;
    const stackedDistM = distB2FromThr + distOffsetM;

    const stackedBn = destinationPoint(
      g.thr.lat,
      g.thr.lon,
      g.app_brg,
      stackedDistM
    );

    asg.b2 = stackedBn;

    // ✅ clamp: nunca más de B30
    const beaconOrdinalRaw = 2 + offsetIndex;      // 2,3,4,...
    const beaconOrdinal = Math.min(30, beaconOrdinalRaw);

    asg.beaconName = `B${beaconOrdinal}`;
    asg.beaconIndex = beaconOrdinal;

  }

  return asg;
}




function getLandingByName(name) {
  return runwayState.landings.find(l => l.name === name);
}



function markAdvancement(name) {
  const L = getLandingByName(name);
  if (L) L.lastAdvancementTs = Date.now();
}

// Determina si ya no debe reordenarse (comprometido a final)
function isCommitted(name) {
  const L = getLandingByName(name);

  // 1) Frontend confirmado
  const curOps = getReportedOpsState(name);
  if (curOps === 'FINAL' || curOps === 'B1') return true;

  // 2) Backend ya lo mandó a FINAL (esto evita que el scheduler lo reordene)
  const backendAssigned = runwayState?.assignedOps?.[name] || null;
  if (backendAssigned === 'FINAL') return true;

  const backend = opsBackendByName.get(name)?.state || null;
  if (backend === 'FINAL') return true;

  // 3) Sticky interno
  const phase = getApproachPhase(name);
  const sticky = getLandingState(name);
  if (phase === 'FINAL' || sticky === 'FINAL') return true;

  // 4) Freeze local
  if (L?.frozenLevel === 1) return true;

  return false;
}




function updateApproachPhase(name) {
  // ✅ Opción A: el backend NO confirma llegada a B1/B2 por proximidad.
  // El frontend es la única fuente de verdad para B# / FINAL / RUNWAY_*.
  return;
}




function enforceCompliance() {
  const now = Date.now();
  const S = getAtcSettings();   // 👈 ACÁ
  for (const L of runwayState.landings) {
    const assigned = (runwayState.assignedOps?.[L.name]) || null; 
    // ejemplos: 'FINAL', 'A_TO_B2', 'A_TO_B3', ...

    const asg = assignBeaconsFor(L.name);
    const u = userLocations[L.name];
    if (!asg || !u) continue;

    const dB1 = getDistance(u.latitude, u.longitude, asg.b1.lat, asg.b1.lon);
    const dB2 = getDistance(u.latitude, u.longitude, asg.b2.lat, asg.b2.lon);


        // === AUTO GO-AROUND: drift lejos de B1 sostenido ===
    const st = getReportedOpsState(L.name);
    const inFinalLike =
    (st === 'B1' || st === 'FINAL' || isB1Latched(L.name) || getLandingState(L.name) === 'FINAL');




    // === LEADER OUT: timeout en B1/FINAL sin ocupar pista ===
    // Sólo aplica al #1 (líder). Si no cumple, pierde turno y sale de la cola.
    const leader = leaderName();
    if (leader && leader === L.name) {
      const stL = getReportedOpsState(L.name);

      // ✅ SOLO timeout cuando realmente está en FINAL (o backend lo fijó como FINAL)
      const assignedFinal = assigned === 'FINAL';
      const inFinalStrict =
        assignedFinal ||
        (stL === 'FINAL') ||
        (getApproachPhase(L.name) === 'FINAL') ||
        (getLandingState(L.name) === 'FINAL');

      if (inFinalStrict) {
        const S2 = getAtcSettings();

        const lease = turnLeaseByName.get(L.name) || { startMs: now, lastThrDistM: null, lastSeenMs: now };
        if (!turnLeaseByName.has(L.name)) turnLeaseByName.set(L.name, lease);

        // (Opcional pero MUY útil): si se está acercando al umbral, no lo timeoutees
        const g = activeRunwayGeom();
        const uL = userLocations[L.name];
        if (g && uL) {
          const dThr = getDistance(uL.latitude, uL.longitude, g.thr.lat, g.thr.lon);

          if (isFinite(dThr)) {
          // ✅ reset del reloj si progresa o si ya está realmente "en final"
          const improved = (lease.lastThrDistM == null) || (dThr <= lease.lastThrDistM - 50); // 50m
          const inCloseFinal = isFinite(dThr) && dThr <= S2.FINAL_LOCK_RADIUS_M; // ej 2000m

          if (improved || inCloseFinal) {
            lease.startMs = now;
          }
          lease.lastThrDistM = dThr;

          }
        }

        const elapsed = now - lease.startMs;

        // ✅ Timeout SOLO en FINAL
        if (elapsed >= S2.LEADER_TIMEOUT_MS) {
          dropFromLandings(L.name, 'timeout como #1 en FINAL');
          continue;
        }

        // ✅ Drift lejos del umbral activo (mantener)
        if (g && uL) {
          const dThr = getDistance(uL.latitude, uL.longitude, g.thr.lat, g.thr.lon);
          if (isFinite(dThr) && dThr >= S2.LEADER_DRIFT_MAX_M) {
            dropFromLandings(L.name, 'se alejó demasiado del umbral activo');
            continue;
          }
        }
      } else {
        // ✅ Si todavía no está en FINAL, no corras timeout (B1 tiene que ser generoso)
        clearTurnLease(L.name);
      }

    }



    // Refrescar committed siempre
    L.committed = isCommitted(L.name);
  }
}


// Velocidad sobre tierra en m/s tomada del último update del usuario.
// Usa mínimo 30 km/h para evitar 0 al calcular ETA.

// ========= ETAs y freeze =========
function computeETAtoPointSeconds(name, pt) {
  const u = userLocations[name];
  if (!u || !pt) return null;
  const v = estimateGSms(name);
  if (!v || !isFinite(v) || v <= 0) return null;
  const d = getDistance(u.latitude, u.longitude, pt.lat, pt.lon); // m
  return Math.max(1, Math.round(d / v));
}

// === Velocidad suelo estimada (m/s) para ETA ===
function estimateGSms(name) {
  const u = userLocations[name];
  if (!u) return 0;

  // Frontend nos manda speed en km/h. Si falta, usar un default por categoría.
  const cat = parseCategory(u.type);
  const DEFAULTS_KMH = {
    GLIDER: 90,     // ~49 kt
    LIGHT: 140,     // ~76 kt
    TURBOPROP: 240, // ~130 kt
    JET_LIGHT: 280, // ~151 kt
    JET_MED: 320,   // ~173 kt
    HEAVY: 350,     // ~189 kt
  };

  const kmh = (typeof u.speed === 'number' && isFinite(u.speed) && u.speed > 5)
    ? u.speed
    : (DEFAULTS_KMH[cat] ?? 140);

  // m/s
  return Math.max(8, kmh * 1000 / 3600);
}

function computeETAsAndFreeze(l) {
  const asg = assignBeaconsFor(l.name);
  if (!asg) return;
  const etaB2 = computeETAtoPointSeconds(l.name, asg.b2);
  const etaB1 = computeETAtoPointSeconds(l.name, asg.b1);
  l.etaB2 = etaB2 ?? null;
  l.etaB1 = etaB1 ?? (etaB2 ? etaB2 + 60 : null); // estimar si falta dato
  // freeze al cruzar cercanía B1
  //const u = userLocations[l.name];
  //if (u) {
   // const dB1 = getDistance(u.latitude, u.longitude, asg.b1.lat, asg.b1.lon);
   // if (isFinite(dB1) && dB1 <= B1_FREEZE_RADIUS_M) {
   //   l.frozenLevel = 1;
   // }
 // }
}

// ========= Construcción de operaciones y planificador =========
function buildOperations(nowMs) {
  const ops = [];

  // Llegadas
  for (const l of runwayState.landings) {
    computeETAsAndFreeze(l);

    // ▲ calcular "committed" (dentro de 2 km de B1, o tocó B1/FINAL, o frozen)
    l.committed = isCommitted(l.name);

    const priorityBase =
      (l.emergency ? 0 : 1000) +
      Math.min(999, (l.etaB1 ?? l.etaB2 ?? 999999));

    l.priority = priorityBase;

    ops.push({
      id: `ARR#${l.name}`,
      type: 'ARR',
      name: l.name,
      callsign: l.callsign || '',
      category: parseCategory(l.type),
      priority: priorityBase,
      etaB1: l.etaB1, etaB2: l.etaB2,
      frozen: l.frozenLevel === 1,
      committed: !!l.committed,
      emergency: !!l.emergency,
    });
  }

  // Salidas
  const now = nowMs ?? Date.now();
  for (const t of runwayState.takeoffs) {
    const ready = !!t.ready;
    const etReady = ready ? now : now + 3600_000; // si no está listo, poner muy lejos
    const priority = 100000 + (ready ? 0 : 50000);
    ops.push({
      id: `DEP#${t.name}`,
      type: 'DEP',
      name: t.name,
      callsign: t.callsign || '',
      category: parseCategory(t.type),
      priority,
      etReady,
      frozen: false,
    });
  }

  // Orden con emergency/committed primero y, si ambos committed, respetar orden previo
// Orden preliminar por prioridad/ETA, ajustado por committed y orden previo
const prevOrder = runwayState.lastOrder.landings || [];
const idxInPrev = (name) => {
  const i = prevOrder.indexOf(name);
  return i === -1 ? 1e9 : i;
};

ops.sort((a, b) => {
  // 1) Emergencia primero
  const aEmer = (a.type === 'ARR') && runwayState.landings.find(x=>x.name===a.name)?.emergency;
  const bEmer = (b.type === 'ARR') && runwayState.landings.find(x=>x.name===b.name)?.emergency;
  if (aEmer && !bEmer) return -1;
  if (!aEmer && bEmer) return 1;

  // 2) Llegadas comprometidas antes que no comprometidas
  if (a.type === 'ARR' && b.type === 'ARR') {
    if (a.committed && !b.committed) return -1;
    if (!a.committed && b.committed) return 1;

    // 3) Si ambos committed, mantener orden previo (evita shuffle por ETA)
    if (a.committed && b.committed) {
      return idxInPrev(a.name) - idxInPrev(b.name);
    }
  }

  // 4) Resto por priority/ETA (como ya hacías)
  const pa = a.priority - b.priority;
  if (pa !== 0) return pa;

  const ta = a.type === 'ARR' ? (a.etaB1 ?? a.etaB2 ?? 9e12) : (a.etReady ?? 9e12);
  const tb = b.type === 'ARR' ? (b.etaB1 ?? b.etaB2 ?? 9e12) : (b.etReady ?? 9e12);
  return ta - tb;
});


  return ops;
}


function tryShiftChain(slots, startIdx, shiftMs, opsById) {
  // intenta correr slots [startIdx..] hacia adelante respetando MAX_DELAY_SHIFT y frozen
let carry = shiftMs;
for (let i = startIdx; i < slots.length; i++) {
  const s = slots[i];
  if (s.frozen) return false;

  const prevStart = s.startMs;
  const allowed = MAX_DELAY_SHIFT_S * 1000;

  // Corrimiento propuesto para este slot
  let newStart = s.startMs + carry;
  let newEnd   = s.endMs   + carry;

  // Respeto wake con el anterior (si i>startIdx, el anterior ya está ajustado)
  if (i > 0) {
    const prev = slots[i-1];
    const prevOp = opsById.get(prev.opId);
    const currOp = opsById.get(s.opId);
    const extra = wakeExtraSeconds(prevOp.category, currOp.category) * 1000;
    if (newStart < prev.endMs + extra) {
      carry += (prev.endMs + extra) - newStart;
      newStart = s.startMs + carry;
      newEnd   = s.endMs   + carry;
    }
  }

  // Límite por acumulado histórico (por opId)
  const acc = shiftAccumMsByOpId.get(s.opId) || 0;
  const deltaThis = newStart - s.startMs; // delta de este paso
  if ((acc + deltaThis) > allowed) return false;

  // Aplicar
  s.startMs = newStart;
  s.endMs   = newEnd;
  shiftAccumMsByOpId.set(s.opId, acc + deltaThis);
}
return true;

}

function planificar(nowMs) {
  shiftAccumMsByOpId.clear();
  const now = nowMs ?? Date.now();
  const ops = buildOperations(now);
  const opsById = new Map(ops.map(o => [o.id, o]));
  const slots = [];

  function scheduleAfter(prevSlot, op) {
    const prevOp = opsById.get(prevSlot.opId);
    const extra = wakeExtraSeconds(prevOp.category, op.category) * 1000;
    const earliest = prevSlot.endMs + extra;
    return Math.max(earliest, op.type==='ARR' ? now + (op.etaB1 ?? op.etaB2 ?? 0)*1000
                                              : (op.etReady ?? now));
  }

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    const rot = (ROT_BY_CAT[op.category] ?? 100) * 1000;
    const target = op.type === 'ARR'
      ? (op.etaB1 ?? op.etaB2 ?? 9e12) * 1000 + now
      : (op.etReady ?? now);

    // buscar hueco viable entre slots existentes
    let placed = false;
    for (let i = 0; i <= slots.length; i++) {
      const prev = i>0 ? slots[i-1] : null;
      const next = i<slots.length ? slots[i] : null;

      // earliest por wake con anterior (si hay)
      let start = prev ? scheduleAfter(prev, op) : Math.max(now, target);
      // para intercalado en ventana: si next existe, validar que no viole wake con next
      let end = start + rot;

      if (next) {
        // wake con next cuando op va antes de next
        const nextOp = opsById.get(next.opId);
        const extraNext = wakeExtraSeconds(op.category, nextOp.category) * 1000;
        const okWindow = (Math.abs((start - next.startMs)) <= INTERLEAVE_WINDOW_S*1000);
        if (end + extraNext <= next.startMs) {
          // entra sin mover next
          slots.splice(i, 0, { opId: op.id, type: op.type, startMs: start, endMs: end, frozen: op.frozen });
          placed = true;
          break;
        } else if (!next.frozen && okWindow) {
          // intentar correr cadena hacia adelante
          const needed = (end + extraNext) - next.startMs;
          const can = tryShiftChain(slots, i, needed, opsById);
          if (can) {
            slots.splice(i, 0, { opId: op.id, type: op.type, startMs: start, endMs: end, frozen: op.frozen });
            placed = true;
            break;
          }
        }
      } else {
        // al final
        slots.push({ opId: op.id, type: op.type, startMs: start, endMs: end, frozen: op.frozen });
        placed = true;
        break;
      }
    }
    if (!placed) {
      // si no se pudo intercalar, poner al final respetando wake
      const last = slots[slots.length-1];
      const start = last ? scheduleAfter(last, op) : Math.max(now, target);
      slots.push({ opId: op.id, type: op.type, startMs: start, endMs: start + rot, frozen: op.frozen });
    }
  }

  runwayState.timelineSlots = slots;
  lastOpsById = opsById;

  return { slots, opsById };
}

  // ========= Mensajería ATC =========
  function emitToUser(name, event, payload) {
    const sid = userLocations[name]?.socketId;
    if (sid) io.to(sid).emit(event, payload);
  }

function maybeSendInstruction(opId, opsById) {
  const op = opsById.get(opId);
  if (!op || op.type !== 'ARR') return;

  const asg = assignBeaconsFor(op.name);
  if (!asg) return;

  const u = userLocations[op.name];
  if (!u) return;

  // FSM actual y sticky
  const curPhase = getApproachPhase(op.name); // 'TO_B2'|'TO_B1'|'FINAL'|'CLRD'
  const sticky = getLandingState(op.name);    // 'ORD','B2','B1','FINAL','RUNWAY_CLEAR','IN_STANDS'
  const stickyReachedB1    = (sticky === 'B1' || sticky === 'FINAL' || sticky === 'RUNWAY_CLEAR' || sticky === 'IN_STANDS');
  const stickyReachedFinal = (sticky === 'FINAL' || sticky === 'RUNWAY_CLEAR' || sticky === 'IN_STANDS');

  const mySlot = runwayState.timelineSlots.find(s => s.opId === opId);
  const now = Date.now();
  const dt = mySlot ? (mySlot.startMs - now) : null;

  const dB2 = getDistance(u.latitude, u.longitude, asg.b2.lat, asg.b2.lon);
  const dB1 = getDistance(u.latitude, u.longitude, asg.b1.lat, asg.b1.lon);

  const mem = lastInstr.get(op.name) || { phase: null, ts: 0 };

  const r = getReportedOpsState(op.name);
  if (r === 'B1' || r === 'FINAL' || r === 'RUNWAY_OCCUPIED' || r === 'RUNWAY_CLEAR' || r === 'APRON_STOP' || r === 'TAXI_APRON' || r === 'TAXI_TO_RWY' || r === 'HOLD_SHORT') {
    return;
  }


  // 🚦 Guardas por estado operativo reportado (front es la fuente de verdad)
  const curOps = getOpsState(op.name);

  // Nunca pedir B1/B2 si ya está en FINAL, en pista, liberando pista o en stands
  if (
    curOps === 'FINAL' ||
    curOps === 'RUNWAY_OCCUPIED' ||
    curOps === 'RUNWAY_CLEAR' ||
    curOps === 'APRON_STOP'
  ) {
    return;
  }

  // ============================================================
  //  ✅ NUEVO MODELO: NO auto-advance por proximidad.
  //  El backend guía por slots + beacons. El ops cambia en el front
  //  cuando el avión llega cerca del beacon.
  // ============================================================

  const phaseNow = getApproachPhase(op.name);

  // 0) Si ya está CLRD, nunca emitir algo que retroceda
  if (phaseNow === 'CLRD') return;

  // --- helper: detectar líder (#1) ---
  const leader = typeof leaderName === 'function' ? leaderName() : null;
  const isLeader = !!leader && leader === op.name;

  // ============================================================
  // 1) Ir a B2/B3/B4... SOLO si aún estamos en TO_B2
  //    y NO está ya “asegurado” por sticky/ops.
  // ============================================================
  if (
    phaseNow === 'TO_B2' &&
    isFinite(dB2) &&
    dB2 > BEACON_REACHED_M &&
    !stickyReachedB1 &&
    curOps !== 'B1' &&
    curOps !== 'FINAL'
  ) {
    const beaconName = asg.beaconName || 'B2';

    if (mem.phase !== beaconName) {
      emitToUser(op.name, 'atc-instruction', {
        type: 'goto-beacon',
        beacon: beaconName,
        lat: asg.b2.lat,
        lon: asg.b2.lon,
        key: 'nav.proceedTo',
        params: { fix: beaconName },
        spokenKey: 'nav.proceedToBeaconSpoken',
        spokenParams: { beacon: beaconName },
      });
      lastInstr.set(op.name, { phase: beaconName, ts: now });
    }
    return;
  }

  // ============================================================
  // 2) B1: sólo para el #2 (o sea, el que está a punto de ser #1)
  //    Condición gatillo: #1 todavía no ocupó pista (inUse),
  //    y este op no es líder aún, pero su slot está “cerca”.
  //
  //    OJO: tu cadena la maneja el front por OPS:
  //    - #2 recibe instrucción de ir a B1
  //    - recién al llegar cerca, cambia OPS=B1 y queda asegurado.
  // ============================================================
  if (
    (phaseNow === 'TO_B2' || phaseNow === 'TO_B1') &&
    !stickyReachedFinal &&
    dt != null &&
    dt <= 90000 &&
    isFinite(dB1) &&
    dB1 > BEACON_REACHED_M
  ) {
    // Si todavía está en TO_B2, lo pasamos a TO_B1 (no retrocede)
    if (phaseNow === 'TO_B2') setApproachPhase(op.name, 'TO_B1');

    if (getApproachPhase(op.name) === 'TO_B1' && mem.phase !== 'B1') {
      emitToUser(op.name, 'atc-instruction', {
        type: 'goto-beacon',
        beacon: 'B1',
        lat: asg.b1.lat,
        lon: asg.b1.lon,
        key: 'nav.turnToB1',
        params: {},
        spokenKey: 'nav.turnToB1Spoken',
        spokenParams: {},
      });
      lastInstr.set(op.name, { phase: 'B1', ts: now });
    }
    return;
  }

  // ============================================================
  // 3) CLEARED TO LAND: SOLO #1 (líder) y pista libre
  //    (y cerca del slot).
  // ============================================================
  if (
    isLeader &&
    phaseNow === 'FINAL' &&
    dt != null &&
    dt <= 45000 &&
    !runwayState.inUse
  ) {
    if (mem.phase !== 'CLRD') {
      const rwIdent =
        (activeRunwayGeom()?.rw?.ident) || '';

      emitToUser(op.name, 'atc-instruction', {
        type: 'cleared-to-land',
        rwy: rwIdent,
        key: 'runway.clearedToLand',
        params: { rwy: rwIdent },
        spokenKey: 'runway.clearedToLandSpoken',
        spokenParams: { rwy: rwIdent },
      });

      lastInstr.set(op.name, { phase: 'CLRD', ts: now });
      setApproachPhase(op.name, 'CLRD');
      setLandingStateForward(op.name, 'FINAL');
    }
    return;
  }

  // 4) Silencio en cualquier otro caso (nunca retroceder).
}



// ========= Publicación de estado =========
function publishRunwayState() {
  const now = Date.now();
  const slots = runwayState.timelineSlots || [];
  const airfield = lastAirfield || null;

  // Compatibilidad con tu UI actual (timeline simple de aterrizajes)
  const timelineCompat = slots
    .filter(s => s.type === 'ARR')
    .map(s => ({
      action: 'landing',
      name: (s.opId || '').split('#')[1],
      at: new Date(s.startMs),
      slotMin: Math.round((s.endMs - s.startMs) / 60000),
    }));

  // --- FRONT-REPORTED OPS (lo que reporta el frontend) ---
  const reportedOpsStates = Object.fromEntries(
    Array.from(opsReportedByName.entries()).map(([k, v]) => [k, v.state])
  );


  // --- BACKEND NAV ASSIGNMENTS (target de navegación) ---
  const assignedOps = {}; // name -> 'A_TO_Bx' | 'FINAL'
  const opsTargets  = {}; // name -> { fix:'B#'|'FINAL', lat, lon }
  const gNow = activeRunwayGeom();

  const landings = runwayState.landings || [];
  const leaderNow = leaderName();

  // 1) ¿El líder "debe" estar en FINAL? (solo guía ATC)
  let leaderWillBeFinal = false;
  if (leaderNow) {
    const b1LatchedLead = isB1Latched(leaderNow);
    const stLead = getReportedOpsState(leaderNow); // lo que dijo el frontend: B#, RUNWAY_*, etc.
    leaderWillBeFinal =
      (stLead === 'B1' || stLead === 'FINAL') && !!gNow?.thr;
  }

  // 2) ¿Quién es #2 ahora mismo?
  const secondNow =
    landings?.[0]?.name === leaderNow ? landings?.[1]?.name : null;

  // 3) UN SOLO LOOP: construir assignedOps / opsTargets
  for (const L of landings) {
    const name = L?.name;

    // lo que dijo el frontend: B#, RUNWAY_*, etc.

      const stReported = getReportedOpsState(name);

    const CRITICAL = new Set([
      'APRON_STOP',
      'TAXI_TO_RWY',
      'HOLD_SHORT',
    ]);


    // 1) Si está en estados críticos de tierra/pista: NO targets, NO assignedOps
    if (CRITICAL.has(stReported)) {
      // importante: no mandes assignedOps ni opsTargets para que el front no dibuje línea ni hable
      delete assignedOps[name];
      delete opsTargets[name];
      continue;
    }

    // 2) Si el frontend ya confirmó B1 o FINAL: NO lo vuelvas a mandar a B2/B3 jamás
// 2) Si el frontend confirmó B1:
//    - leader => FINAL
//    - no-leader => HOLD en B1 (A_TO_B1) (NO FINAL)
if (stReported === 'B1') {
  if (leaderNow && name === leaderNow && gNow?.thr) {
    assignedOps[name] = 'FINAL';
    opsTargets[name] = { fix: 'FINAL', lat: gNow.thr.lat, lon: gNow.thr.lon };
    setFinalLatched(name, true);
  } else {
    assignedOps[name] = 'A_TO_B1';
    if (asg?.b1) opsTargets[name] = { fix: 'B1', lat: asg.b1.lat, lon: asg.b1.lon };
  }
  continue;
}

// 3) Si por algún motivo el frontend reportó FINAL (no debería):
//    solo respetarlo si es líder; si no, degradarlo a B1
if (stReported === 'FINAL') {
  if (leaderNow && name === leaderNow && gNow?.thr) {
    assignedOps[name] = 'FINAL';
    opsTargets[name] = { fix: 'FINAL', lat: gNow.thr.lat, lon: gNow.thr.lon };
    setFinalLatched(name, true);
  } else {
    assignedOps[name] = 'A_TO_B1';
    if (asg?.b1) opsTargets[name] = { fix: 'B1', lat: asg.b1.lat, lon: asg.b1.lon };
  }
  continue;
}


  // ✅ FINAL LATCH: si el backend ya lo comprometió a FINAL, no mirar OPS para degradarlo
  if (isFinalLatched(name) && gNow?.thr) {
    assignedOps[name] = 'FINAL';
    opsTargets[name] = { fix: 'FINAL', lat: gNow.thr.lat, lon: gNow.thr.lon };
    continue;
  }


    if (!name) continue;

    const b1Latched = isB1Latched(name);
    
    const asg = assignBeaconsFor(name);

    // -------------------------
    // 1) LÍDER: si ya confirmó B1 (o está latcheado), backend lo guía a FINAL
    //    Si NO confirmó B1, backend lo guía a B1 (A_TO_B1)
    // -------------------------
    if (leaderNow && name === leaderNow) {
      if (leaderWillBeFinal) {
      assignedOps[name] = 'FINAL';
      opsTargets[name] = { fix: 'FINAL', lat: gNow.thr.lat, lon: gNow.thr.lon };
      setFinalLatched(name, true); // ✅ latch definitivo

      } else {
        assignedOps[name] = 'A_TO_B1';

        const lat = asg?.b1?.lat;
        const lon = asg?.b1?.lon;
        if (typeof lat === 'number' && typeof lon === 'number') {
          opsTargets[name] = { fix: 'B1', lat, lon };
        }
      }
      continue;
    }

    // ✅ PARCHE MÍNIMO:
    // Si el líder ya está en FINAL, empujar #2 a B1 YA MISMO (sin esperar RUNWAY_OCCUPIED)
    if (leaderWillBeFinal && secondNow && name === secondNow) {
      assignedOps[name] = 'A_TO_B1';

      const lat = asg?.b1?.lat;
      const lon = asg?.b1?.lon;
      if (typeof lat === 'number' && typeof lon === 'number') {
        opsTargets[name] = { fix: 'B1', lat, lon };
      }
      continue;
    }

    // -------------------------
    // 2) NO-LÍDER: tu lógica original
    // -------------------------
    if (b1Latched) {
      assignedOps[name] = 'A_TO_B1';

      const lat = asg?.b1?.lat;
      const lon = asg?.b1?.lon;
      if (typeof lat === 'number' && typeof lon === 'number') {
        opsTargets[name] = { fix: 'B1', lat, lon };
      }
      continue;
    }

    // Resto: A_TO_B2..A_TO_B30 según beaconName
    const bn = asg?.beaconName || 'B2'; // ya viene clamped a B30 por CAMBIO 1
    const lat = asg?.b2?.lat;
    const lon = asg?.b2?.lon;

    assignedOps[name] = `A_TO_${bn}`;

    if (typeof lat === 'number' && typeof lon === 'number') {
      opsTargets[name] = { fix: bn, lat, lon };
    }
  }

    function getHoldShortPointFromAirfield() {
    const g = activeRunwayGeom();
    if (!g?.thr || !g?.opp) return null;

    // Eje de pista thr->opp
    const rwyBrg = bearingDeg(g.thr.lat, g.thr.lon, g.opp.lat, g.opp.lon);

    // Punto "antes" del umbral, sobre el eje (80 m hacia afuera en la aproximación)
    // app_brg es "hacia afuera" del umbral (tu definición), así que esto lo deja "antes" de entrar a pista
    const preThr = destinationPoint(g.thr.lat, g.thr.lon, g.app_brg, 80);

    // Lateral 90° a la derecha de la pista, 80 m (quedás al costado, no sobre pista)
    const lateral = (rwyBrg + 90) % 360;
    const hs = destinationPoint(preThr.lat, preThr.lon, lateral, 80);

    return { lat: hs.lat, lon: hs.lon };
  } 

  function hasAnyArrivalInFinalLike() {
    const leader = leaderName();
    if (!leader) return false;

    const st = getReportedOpsState(leader);
    if (st === 'FINAL') return true;

    // si el backend ya lo latcheó a FINAL, cuenta como FINAL
    if (isFinalLatched(leader)) return true;

    // si por runway-state lo estabas asignando a FINAL
    const asg = runwayState.assignedOps?.[leader] || null;
    if (asg === 'FINAL') return true;

    return false;
  }

  

  // === Ground guidance: TAXI_APRON ===
  function getApronPointFromAirfield() {
    const a = lastAirfield;

    // Buscá en varios nombres típicos (sin inventar estructura)
    const candidates = [
      a?.apron,
      a?.parking,
      a?.stands,
      a?.stand,
      a?.ramp,
      a?.runways?.[0]?.apron,
      a?.runways?.[0]?.parking,
    ];

    for (const p of candidates) {
      if (p && typeof p.lat === 'number' && typeof p.lon === 'number') {
        return { lat: p.lat, lon: p.lon };
      }
      // si viene como {lng:...}
      if (p && typeof p.lat === 'number' && typeof p.lng === 'number') {
        return { lat: p.lat, lon: p.lng };
      }
    }

    // Fallback geométrico (si no hay apron explícito):
    // punto cercano al umbral activo pero “fuera” de la pista (muy simple)
  const g = activeRunwayGeom();
  if (g?.thr) {
    // lateral 90° respecto al eje de pista
    const lateral = (bearingDeg(g.thr.lat, g.thr.lon, g.opp.lat, g.opp.lon) + 90) % 360;
    const pt = destinationPoint(g.thr.lat, g.thr.lon, lateral, 180); // 180m al costado
    return { lat: pt.lat, lon: pt.lon };
  }

    return null;
  }

  // ======================
  // GROUND GUIDANCE (APRON)
  // Backend manda targets; frontend confirma OPS.
  // ======================
  const apronPt = getApronPointFromAirfield();
  if (apronPt) {
    for (const [name, v] of opsReportedByName.entries()) {
      const st = v?.state;

      // 1) Si está en pista o saliendo de pista => mandarlo al APRON
      if (st === 'RUNWAY_OCCUPIED' || st === 'RUNWAY_CLEAR' || st === 'TAXI_APRON') {
        assignedOps[name] = 'A_TO_APRON';
        opsTargets[name]  = { fix: 'APRON', lat: apronPt.lat, lon: apronPt.lon };
        continue;
      }

      // 2) Si ya está en APRON => cortar ATC (sin línea azul)
      if (st === 'APRON_STOP') {
        // no incluir assignedOps/opsTargets
        delete assignedOps[name];
        delete opsTargets[name];
        continue;
      }
    }
  }

  // ======================
  // TAKEOFF GUIDANCE (HOLD_SHORT -> RWY)opsBackendByName.clear();
  // Backend manda targets; frontend confirma OPS.
  // ======================
  const holdShortPt = getHoldShortPointFromAirfield();
  const gTk = activeRunwayGeom();

if (holdShortPt && gTk?.thr) {
  const depLeader = runwayState.takeoffs?.[0]?.name || null;
  const arrivalFinal = hasAnyArrivalInFinalLike();

  for (const t of (runwayState.takeoffs || [])) {
    const name = t?.name;
    if (!name) continue;

    const st = getReportedOpsState(name);

    // Solo guiamos al #1 de despegue (para que no se amontonen todos en hold short)
    if (depLeader && name !== depLeader) continue;

    // Si ya está airborne, no tiene sentido tenerlo en DEP
    if (st === 'AIRBORNE') continue;

    // Si está en runway occupied, ya "consumió" el slot: sacar guía
    if (st === 'RUNWAY_OCCUPIED') {
      delete assignedOps[name];
      delete opsTargets[name];
      continue;
    }

    // 1) Mientras esté en apron/taxi apron: mandarlo a HOLD_SHORT
    if (st === 'APRON_STOP' || st === 'TAXI_APRON' || st === 'RUNWAY_CLEAR') {
      assignedOps[name] = 'A_TO_HOLD_SHORT';
      opsTargets[name] = { fix: 'HOLD_SHORT', lat: holdShortPt.lat, lon: holdShortPt.lon };
      continue;
    }

    // 2) Si ya llegó a HOLD_SHORT: decidir clearance o mantener hold
    if (st === 'HOLD_SHORT') {
      const runwayFree = !runwayState.inUse;

      if (runwayFree && !arrivalFinal) {
        // ✅ clearance: ir a cabecera/umbral
        assignedOps[name] = 'A_TO_RWY';
        opsTargets[name] = { fix: 'RWY', lat: gTk.thr.lat, lon: gTk.thr.lon };
      } else {
        // ⛔️ mantener hold short (NO clearance)
        assignedOps[name] = 'A_TO_HOLD_SHORT';
        opsTargets[name] = { fix: 'HOLD_SHORT', lat: holdShortPt.lat, lon: holdShortPt.lon };
      }
      continue;
    }

    // 3) Si empezó a taxear a pista, mantener target RWY
    if (st === 'TAXI_TO_RWY') {
      assignedOps[name] = 'A_TO_RWY';
      opsTargets[name] = { fix: 'RWY', lat: gTk.thr.lat, lon: gTk.thr.lon };
      continue;
    }
  }
}

    // ✅ Guardar backend assignments en Map (para getEffectiveOpsState)
    opsBackendByName.clear();
    for (const [name, atc] of Object.entries(assignedOps)) {
      opsBackendByName.set(name, { state: atc, ts: now });
    }


        // ✅ opsStates para UI, pero sin pisar estados críticos del frontend
    const opsStates = { ...reportedOpsStates };

    const CRITICAL_FRONT = new Set([
      'RUNWAY_OCCUPIED',
      'RUNWAY_CLEAR',
      'APRON_STOP',
      'TAXI_APRON',
      'TAXI_TO_RWY',
      'HOLD_SHORT',
    ]);

    for (const [name, atc] of Object.entries(assignedOps)) {
      const r = reportedOpsStates[name];
      if (CRITICAL_FRONT.has(r)) continue;          // no pisar estados tierra/pista
      if (typeof atc === 'string' && atc) opsStates[name] = atc;  // A_TO_* o FINAL
    }


runwayState.assignedOps = assignedOps;
runwayState.opsTargets  = opsTargets;   // ✅ IMPORTANTE


  // Emit principal runway-state (lo que Radar necesita)
  io.emit('runway-state', {
    airfield,
    state: {
      // lo que reporta el frontend (B#, RUNWAY_*, etc.)
      reportedOpsStates,

      // ✅ opsStates = OPS efectivo (se ve FINAL / A_TO_* cuando el backend lo decide)
      opsStates,

      // nuevo: lo que decide el backend para navegación
      assignedOps,
      opsTargets,

      landings: runwayState.landings,
      takeoffs: runwayState.takeoffs,
      inUse: runwayState.inUse,
      timeline: timelineCompat,
      serverTime: now,
      landingStates: Object.fromEntries(
        Array.from(landingStateByName.entries()).map(([k, v]) => [k, v.state])
      ),
    },
  });

  // ===== sequence-update (tu stream avanzado) =====
  const g = activeRunwayGeom();

  let stackedBeacons = [];
  if (g) {
    const arrSlots = slots.filter(s => s.type === 'ARR');
    stackedBeacons = arrSlots.map((s, idx) => {
      const name = (s.opId || '').split('#')[1];
      const asg = assignBeaconsFor(name);
      const beaconName = asg?.beaconName || `B${idx + 2}`;
      return {
        name,
        beacon: beaconName,
        lat: asg?.b2?.lat ?? g.B2.lat,
        lon: asg?.b2?.lon ?? g.B2.lon,
      };
    });
  }

  io.emit('sequence-update', {
    serverTime: now,
    airfield,
    beacons: g ? {
      B1: g.B1,
      B2: g.B2,
      stack: stackedBeacons,
    } : null,
    slots: slots.map((s, idx) => {
      const op = lastOpsById.get(s.opId) || {};
      const prev = idx > 0 ? slots[idx - 1] : null;
      const prevOp = prev ? lastOpsById.get(prev.opId) : null;

      const rotSec = ROT_BY_CAT[op.category] ?? 100;
      const wakePrevNextSec = (prevOp ? (wakeExtraSeconds(prevOp.category, op.category) || 0) : 0);

      return {
        opId: s.opId,
        type: s.type,
        name: (s.opId || '').split('#')[1],
        startMs: s.startMs,
        endMs: s.endMs,
        frozen: s.frozen,
        category: op.category || null,
        priority: op.priority ?? null,
        etaB1: op.etaB1 ?? null,
        etaB2: op.etaB2 ?? null,
        rotSec,
        wakePrevNextSec,
        shiftAccumMs: shiftAccumMsByOpId.get(s.opId) || 0,
      };
    }),
  });
}




// ========= Ciclo principal =========
function cleanupInUseIfDone() {
  if (!runwayState.inUse) return;
  const end = runwayState.inUse.startedAt + runwayState.inUse.slotMin * 60000;
  if (Date.now() > end) runwayState.inUse = null;
}

// ✅ Consumir #1 cuando entra a RUNWAY_OCCUPIED y empujar nuevo líder a FINAL
function consumeLeaderOnRunwayOccupied(leaderNameNow) {
  const leader = leaderName(); // usa runwayState.landings[0]
  if (!leader || leader !== leaderNameNow) return false;

  const leadInfo = userLocations[leaderNameNow] || {};
  const leadCallsign = leadInfo.callsign || '';

  // (1) Marcar pista ocupada un rato (lease)
  //     (si ya existe, no la pisamos)
  if (!runwayState.inUse) {
    runwayState.inUse = {
      action: 'landing',
      name: leaderNameNow,
      callsign: leadCallsign,
      startedAt: Date.now(),
      slotMin: MIN_LDG_SEP_MIN
    };
  }

  // (2) Sacar al líder de la cola (consume turno)
  runwayState.landings = runwayState.landings.filter(l => l.name !== leaderNameNow);
runwayState.landings = runwayState.landings.filter(l => l.name !== leaderNameNow);

clearATC(leaderNameNow);
try { setFinalLatched(leaderNameNow, false); } catch {}



  // Limpiezas coherentes con tu lógica actual
  clearTurnLease(leaderNameNow);
  try { clearFinalEnter(leaderNameNow); } catch {}
  try { b1LatchByName.delete(leaderNameNow); } catch {}

  // (3) Corrimiento + replanificación
  //     (esto reordena y recalcula slots)
  try { enforceCompliance(); } catch {}
  try { planRunwaySequence(); } catch {}

  // (4) Nuevo líder => FORZAR FINAL explícito
  const newLead = leaderName();
  if (newLead) {
    const g = activeRunwayGeom();
    if (g?.thr) {
      // 🔥 instrucción explícita "ir a FINAL" (umbral activo)
      emitToUser(newLead, 'atc-instruction', {
        type: 'goto-beacon',
        beacon: 'FINAL',
        lat: g.thr.lat,
        lon: g.thr.lon,
        key: 'nav.proceedTo',
        params: { fix: 'FINAL' },
        spokenKey: 'nav.proceedToBeaconSpoken',
        spokenParams: { beacon: 'FINAL' },
      });

      // ✅ NUEVO: verdad server-side para que runway-state refleje FINAL del nuevo líder
      runwayState.assignedOps = runwayState.assignedOps || {};
      runwayState.opsTargets  = runwayState.opsTargets  || {};
      runwayState.assignedOps[newLead] = 'FINAL';
      runwayState.opsTargets[newLead]  = { fix: 'FINAL', lat: g.thr.lat, lon: g.thr.lon };


    setFinalLatched(newLead, true);

      // Server-side: lo ponemos en FINAL para que tu FSM no lo degrade
      const ph = getApproachPhase(newLead);
      if (ph !== 'CLRD') setApproachPhase(newLead, 'FINAL');
      try { setLandingStateForward(newLead, 'FINAL'); } catch {}
    }
  }

  // (5) Publicar estado actualizado
  try { publishRunwayState(); } catch {}
  return true;
}

function consumeTakeoffOnRunwayOccupied(name) {
  const depLeader = runwayState.takeoffs?.[0]?.name || null;
  if (!depLeader || depLeader !== name) return false;

  // Si hay arrivals en FINAL, no debería haber entrado; pero por robustez:
  if (hasAnyArrivalInFinalLike()) return false;

  // Si la pista ya estaba en uso, no consumir
  if (runwayState.inUse) return false;

  const cs = userLocations[name]?.callsign || '';

  runwayState.inUse = {
    action: 'takeoff',
    name,
    callsign: cs,
    startedAt: Date.now(),
    slotMin: TKOF_OCCUPY_MIN
  };

  // consumir de cola DEP
  runwayState.takeoffs = runwayState.takeoffs.filter(t => t.name !== name);

  // cortar ATC (línea azul)
  clearATC(name);

  try { planRunwaySequence(); } catch {}
  try { publishRunwayState(); } catch {}
  return true;
}

function planRunwaySequence() {
  cleanupInUseIfDone();

  // Planificar
  const { slots, opsById } = planificar(Date.now());

  const arrOrder = slots
  .filter(s => s.type === 'ARR')
  .map(s => (s.opId || '').split('#')[1]);

if (arrOrder.length) {
  runwayState.landings.sort((a, b) => {
    const ia = arrOrder.indexOf(a.name);
    const ib = arrOrder.indexOf(b.name);
    return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
  });
}


// Mensajes de turno (compatibilidad)
const newLand = runwayState.landings.map(l => l.name);
const newTk   = runwayState.takeoffs.map(t => t.name);
const oldLand = runwayState.lastOrder.landings || [];
const oldTk   = runwayState.lastOrder.takeoffs || [];

  newLand.forEach((name, idx) => {
    if (oldLand.indexOf(name) !== idx) {
    const st = getReportedOpsState(name);
    const assignedNow = runwayState.assignedOps?.[name] || null;

    const allowTurnMsg = !(
      st === 'B1' ||
      st === 'FINAL' ||
      st === 'RUNWAY_OCCUPIED' ||
      st === 'RUNWAY_CLEAR' ||
      st === 'APRON_STOP' ||
      st === 'TAXI_APRON' ||
      st === 'TAXI_TO_RWY' ||
      st === 'HOLD_SHORT' ||
      assignedNow === 'FINAL'
    );

    if (allowTurnMsg) {
      emitToUser(name, 'runway-msg', {
        key: 'runway.yourLandingTurnIsNumber',
        params: { n: idx + 1 },
        spokenKey: 'runway.yourLandingTurnIsNumber',
        spokenParams: { n: idx + 1 }
      });
    }

    }
  });

  newTk.forEach((name, idx) => {
    if (oldTk.indexOf(name) !== idx) {
      const st2 = getReportedOpsState(name);
      const allowTkMsg = !(st2 === 'RUNWAY_OCCUPIED' || st2 === 'RUNWAY_CLEAR' || st2 === 'APRON_STOP');
      if (allowTkMsg) {
        emitToUser(name, 'runway-msg', { text: `Su turno de despegue ahora es #${idx+1}`, key: 'turn-tk' });
      }
    }
  });

runwayState.lastOrder.landings = newLand;
runwayState.lastOrder.takeoffs = newTk;

  // Instrucciones ATC por llegada
  for (const s of slots) {
    if (s.type === 'ARR') maybeSendInstruction(s.opId, opsById);
  }



}

/* Recompute periódico */
setInterval(() => {
  try {
    if (runwayState.landings.length || runwayState.takeoffs.length) {
      // ✅ actualizar latch para todos los que están en la cola de aterrizaje
      for (const L of runwayState.landings) {
        updateB1LatchFor(L.name);

        // si el frontend reporta B1 o FINAL, marcamos “entró a final”
        const st = getReportedOpsState(L.name);
        if (st === 'B1' || st === 'FINAL') setFinalEnterNow(L.name);
      }
      enforceCompliance();
      planRunwaySequence();
      publishRunwayState();
    }
  } catch (e) { console.error('scheduler tick error', e); }
}, 2000);

/* =======================================================================================
   ░█▀▀░█░█░█▄█░█░█░█▀▀░█░█░█▀▀░█▀▄░█░█      FIN RUNWAY SCHEDULER (NUEVO)
   ======================================================================================= */



io.on('connection', (socket) => {
  console.log('🟢 Cliente conectado vía WebSocket:', socket.id);

  socket.on('update', (data) => {
    console.log('✈️ UPDATE recibido:', data);

    const {
      name,
      latitude,
      longitude,
      alt = 0,
      heading = 0,
      type = 'unknown',
      speed = 0,
      callsign = '',
      aircraftIcon = '2.png'
    } = data;

    if (!name || typeof latitude !== 'number' || typeof longitude !== 'number') return;

    // (4) Defenderse de cambio de nombre en vivo:
    const existing = userLocations[name];
    if (existing && existing.socketId && existing.socketId !== socket.id) {
      // 🔥 RECONNECT con mismo "name" (ExpoGo re-scan / reload)
      hardResetUser(name);
    }


    userLocations[name] = {
      name,
      latitude,
      longitude,
      alt,
      heading,
      type,
      speed,
      callsign,
      icon: aircraftIcon,
      timestamp: Date.now(),
      socketId: socket.id
    };

    socketIdToName[socket.id] = name;

    console.log('🗺️ Estado actual de userLocations:', userLocations);

 const payload = {
  name,
  lat: latitude,
  lon: longitude,
  alt,
  heading,
  type,
  speed,
  callsign,
  aircraftIcon: aircraftIcon,
  ts: Date.now(),
};

// a todos menos al emisor
socket.broadcast.emit('traffic-update', [payload]);


    

    // ►► (AGREGADO) replanificar si hay solicitudes pendientes y cambió la kinemática
    if (runwayState.landings.length || runwayState.takeoffs.length) {
      enforceCompliance();
      planRunwaySequence();
      publishRunwayState();
    }
 });

function hardResetUser(name) {
  if (!name) return;

  // 0) limpiar índices socket<->name
  try {
    for (const [sid, uname] of Object.entries(socketIdToName)) {
      if (uname === name) delete socketIdToName[sid];
    }
  } catch {}

  // 1) Sacarlo de colas
  runwayState.landings = (runwayState.landings || []).filter(x => x.name !== name);
  runwayState.takeoffs = (runwayState.takeoffs || []).filter(x => x.name !== name);

  // 2) Borrar OPS y flancos (si existen)
  try { opsStateByName?.delete(name); } catch {}
  try { lastOpsStateByName?.delete(name); } catch {}

  // 3) Borrar latches / drift / leases / fases / sticky (ACÁ estaba el bug)
  try { clearTurnLease?.(name); } catch {}
  try { turnLeaseByName?.delete(name); } catch {}       // por si existe como Map directo
  try { clearFinalEnter?.(name); } catch {}
  try { finalEnterByName?.delete(name); } catch {}      // si existe
  try { b1LatchByName?.delete(name); } catch {}
  try { driftSinceByName?.delete(name); } catch {}      // IMPORTANTE
  try { landingStateByName?.delete(name); } catch {}
  try { approachPhaseByName?.delete(name); } catch {}
  try { setFinalLatched(name, false); } catch {}


  // 4) Borrar ubicación (evita “avión fantasma”)
  try { delete userLocations[name]; } catch {}

  // 5) Si estaba ocupando la pista
  if (runwayState.inUse?.name === name) runwayState.inUse = null;

  // 6) Replanificar y publicar
  try { enforceCompliance?.(); } catch {}
  try { planRunwaySequence?.(); } catch {}
  try { publishRunwayState?.(); } catch {}

  console.log(`[OPS] hardResetUser(${name})`);
}


socket.on('leave', (msg) => {
  try {
    const name = msg?.name || socketIdToName[socket.id];
    if (name) hardResetUser(name);
    delete socketIdToName[socket.id];
  } catch (e) {
    console.error('leave error:', e);
  }
});



   // === Estado operativo reportado por el frontend ===
socket.on('ops/state', (msg) => {

  
  try {
    const { name, state, aux } = msg || {};


        // ✅ VALID dinámico: B1..B30 + estados tierra/pista
    const B_STATES = new Set(Array.from({ length: 30 }, (_, i) => `B${i + 1}`));

    const FRONTEND_ALLOWED_OPS = new Set([
      'APRON_STOP',
      'TAXI_APRON',
      'TAXI_TO_RWY',
      'HOLD_SHORT',
      'RUNWAY_OCCUPIED',
      'RUNWAY_CLEAR',
      'AIRBORNE',
      'LAND_QUEUE',
      'FINAL',              // ✅ ADD
      ...B_STATES,
    ]);


    // ⛔️ El frontend NUNCA puede mandar A_TO_*
    if (typeof state === 'string' && state.startsWith('A_TO_')) {
      return;
    }

    if (!FRONTEND_ALLOWED_OPS.has(state)) {
      return;
    }

    if (!name || !state) return;

    const acceptedState = state;
    const leader = leaderName(); // solo si lo usás en el log


        const CRITICAL = new Set([
          'RUNWAY_OCCUPIED','RUNWAY_CLEAR','APRON_STOP','TAXI_APRON','TAXI_TO_RWY','HOLD_SHORT'
        ]);

        // ✅ Diagnóstico temprano
        console.log(
          '[ops/state]',
          'name=', name,
          'state=', acceptedState,
          'leaderNow=', leader,
          'getReportedOpsState(leaderNow)=', leader ? getReportedOpsState(leader) : null,
          'aux=', aux
        );

        // 1) Si ya estaba FINAL reportado, no aceptes regresión (salvo críticos)
        const alreadyFinal = (getReportedOpsState(name) === 'FINAL');
        if (alreadyFinal && acceptedState !== 'FINAL' && !CRITICAL.has(acceptedState)) {
          return;
        }

        // 2) Si el backend lo tiene asignado a FINAL, tampoco aceptes regresión (salvo críticos)
        const assignedNow = runwayState.assignedOps?.[name] || null;
        const backendFinal =
          assignedNow === 'FINAL' ||
          getApproachPhase(name) === 'FINAL' ||
          getLandingState(name) === 'FINAL';

        if (backendFinal && acceptedState !== 'FINAL' && !CRITICAL.has(acceptedState)) {
          return;
        }

        // 3) Guardar y emitir el estado aceptado (SOLO frontend -> backend aquí)
        opsReportedByName.set(name, { state: acceptedState, ts: Date.now(), aux: aux || null });

        const prev = lastOpsStateByName.get(name) || null;
        lastOpsStateByName.set(name, acceptedState);

        // Broadcast ÚNICO del OPS reportado
        io.emit('ops/state', {
          name,
          state: acceptedState,
          ts: Date.now(),
          aux: aux || null,
        });

        // ✅ Trigger: SOLO si hubo flanco hacia RUNWAY_OCCUPIED y SOLO si es el líder actual
        if (prev !== 'RUNWAY_OCCUPIED' && acceptedState === 'RUNWAY_OCCUPIED') {
          const didConsumeLdg = consumeLeaderOnRunwayOccupied(name);
          if (didConsumeLdg) return;

          const didConsumeDep = consumeTakeoffOnRunwayOccupied(name);
          if (didConsumeDep) return;
        }



    // Ajustes suaves al scheduler
// Ajustes suaves al scheduler (NO duplicar consumo de líder)
const leaderNow = leaderName();
const isLeaderNow = !!leaderNow && leaderNow === name;

if (acceptedState === 'RUNWAY_OCCUPIED' && !runwayState.inUse && isLeaderNow) {
  runwayState.inUse = {
    action: 'landing',
    name,
    callsign: userLocations[name]?.callsign || '',
    startedAt: Date.now(),
    slotMin: MIN_LDG_SEP_MIN
  };
  try { setFinalLatched(name, false); } catch {}
}



if (acceptedState === 'RUNWAY_CLEAR' && runwayState.inUse?.name === name) {
  runwayState.inUse = null;
  try { setFinalLatched(name, false); } catch {}
}

if (acceptedState === 'RUNWAY_OCCUPIED' || acceptedState === 'RUNWAY_CLEAR') {

  // ✅ SOLO remover de la cola si es el líder actual
  try { setFinalLatched(name, false); } catch {}
}

// ✅ Si frontend vuelve a AIRBORNE => salir completamente de FINAL
if (acceptedState === 'AIRBORNE') {
  try { setFinalLatched(name, false); } catch {}

  // si estaba en cola de despegue, ya terminó
  runwayState.takeoffs = (runwayState.takeoffs || []).filter(t => t.name !== name);
  clearATC(name);
}


if (acceptedState === 'B1' || acceptedState === 'FINAL') {
  const L = runwayState.landings.find(l => l.name === name);
  if (L) L.frozenLevel = 1;
}

if (acceptedState === 'TAXI_APRON' || acceptedState === 'APRON_STOP') {
  runwayState.landings = runwayState.landings.filter(l => l.name !== name);
  setLandingStateForward(name, 'IN_STANDS');
  try { clearFinalEnter(name); } catch {}
  try { b1LatchByName.delete(name); } catch {}
  try { setFinalLatched(name, false); } catch {}
  
}


if (runwayState.landings.length || runwayState.takeoffs.length) {
  planRunwaySequence();
}

  publishRunwayState();
} catch (e) {
  console.error('ops/state error:', e);
}
});


  socket.on('get-traffic', () => {
    // (3) Normalizar a lat/lon en initial-traffic
    const activePlanes = Object.values(userLocations).map(info => ({
      name: info.name,
      lat: info.latitude,
      lon: info.longitude,
      alt: info.alt,
      heading: info.heading,
      type: info.type,
      speed: info.speed,
      callsign: info.callsign,
      aircraftIcon: info.icon
    }));

    console.log('📦 Enviando tráfico inicial por get-traffic:', activePlanes);
    socket.emit('initial-traffic', activePlanes);
  });

    // === Airfield: upsert y get ===
  socket.on('airfield-upsert', ({ airfield }) => {
    try {
      if (!airfield || typeof airfield !== 'object') return;
      lastAirfield = airfield;
      io.emit('airfield-update', { airfield: lastAirfield }); // broadcast a todos
      console.log('🛬 airfield-upsert recibido y broadcast airfield-update');

      // ►► (AGREGADO) replanificar con nueva cabecera/airfield
      if (runwayState.landings.length || runwayState.takeoffs.length) {
        planRunwaySequence();
        publishRunwayState();
      }
    } catch (e) {
      console.error('airfield-upsert error:', e);
    }
  });

  socket.on('airfield-get', () => {
    try {
      if (lastAirfield) {
        socket.emit('airfield-update', { airfield: lastAirfield }); // solo al solicitante
        console.log('📨 airfield-get → enviado airfield-update al solicitante');
      }
      // ►► (AGREGADO) también enviar estado de pista al abrir cartel
      publishRunwayState();
    } catch (e) {
      console.error('airfield-get error:', e);
    }
  });


  // === RA espejo: sólo para el par implicado. TA se ignora (solo frontend) ===
  socket.on('warning', (warningData) => {
    const sender = socketIdToName[socket.id];   // quién emite el warning
    if (!sender) return;

    const senderInfo = userLocations[sender];
    if (!senderInfo) return;

    const level =
      warningData.alertLevel ||
      (warningData.type === 'RA' && warningData.timeToImpact < 60 ? 'RA_HIGH'
       : warningData.type === 'RA' ? 'RA_LOW'
       : 'TA');

    const isRA = level === 'RA_HIGH' || level === 'RA_LOW';

    // 🟡 TA: NO se reenvía. Cada cliente maneja su propio TA local.
    if (!isRA) {
      return;
    }

    // 🔴 RA: sólo para los dos implicados
    const targetName = String(warningData.id || warningData.name || '');
    if (!targetName) return;

    const targetInfo = userLocations[targetName];
    if (!targetInfo) return;

    const timeToImpact = warningData.timeToImpact ?? 999;

    // helper: enviar a un receptor la info del "otro" avión
    function emitConflictFor(recipientName, otherName, fromName, toName) {
      const me    = userLocations[recipientName];
      const other = userLocations[otherName];
      if (!me || !other) return;

      const distance = getDistance(
        me.latitude,
        me.longitude,
        other.latitude,
        other.longitude
      );

      const payload = {
        id: otherName,
        name: otherName,
        lat: other.latitude,
        lon: other.longitude,
        alt: other.alt ?? 0,
        heading: other.heading ?? 0,
        speed: other.speed ?? 0,
        type: 'RA',                    // el frontend mira data.type === 'RA'
        alertLevel: level,             // RA_LOW o RA_HIGH
        timeToImpact,
        distanceMeters: distance,
        distance,
        aircraftIcon: other.icon || '2.png',
        callsign: other.callsign || '',
        from: fromName,
        to: toName,
      };

      emitToUser(recipientName, 'conflicto', payload);
    }

    const fromName = sender;      // el que calculó y envió el RA
    const toName   = targetName;  // el que va de frente para él

    // 1) al emisor: le mostramos al "otro"
    emitConflictFor(fromName, toName, fromName, toName);

    // 2) al objetivo: le mostramos al emisor
    emitConflictFor(toName, fromName, fromName, toName);
  });




socket.on('warning-clear', (msg) => {
  const sender = socketIdToName[socket.id];   // quién está avisando el clear
  if (!sender) return;

  const target = String(msg?.id || '');       // contra quién fue el RA original (el otro avión)
  if (!target) return;

  // Sólo los dos implicados en el RA
  const involved = [sender, target];

  for (const recvName of involved) {
    const info = userLocations[recvName];
    if (!info?.socketId) continue;

    // Para cada uno, limpiamos el RA que ve del "otro"
    const otherName = (recvName === sender) ? target : sender;

    io.to(info.socketId).emit('conflicto-clear', { id: otherName });
  }
});



  // (1) Manejar air-guardian/leave
socket.on('air-guardian/leave', () => {
  const name = socketIdToName[socket.id];
  console.log('👋 air-guardian/leave desde', socket.id, '->', name);
  if (name) {
    delete userLocations[name];
    delete socketIdToName[socket.id];
    io.emit('user-removed', name);
    console.log(`❌ Usuario ${name} eliminado por leave`);
    // 👇 limpiar estado sticky
    landingStateByName.delete(name);
    lastOpsStateByName.delete(name);
    clearTurnLease(name);


    // ✅ limpiar timers/latch (auto-go-around / B1 latch)
    try { clearFinalEnter(name); } catch {}
    try { b1LatchByName.delete(name); } catch {}
    try { setFinalLatched(name, false); } catch {}

  }

  // ►► (AGREGADO) limpiar de colas si corresponde
  runwayState.landings = runwayState.landings.filter(x => x.name !== name);
  runwayState.takeoffs = runwayState.takeoffs.filter(x => x.name !== name);
  planRunwaySequence();
  publishRunwayState();
});


  // 🔌 Cliente se desconecta físicamente (cierra app o pierde conexión)
  socket.on('disconnect', () => {
    console.log('🔌 Cliente desconectado:', socket.id);

    const name = socketIdToName[socket.id];

    // limpiar mapping del socket SIEMPRE
    delete socketIdToName[socket.id];

    if (name) {
      // ✅ limpieza TOTAL (colas + OPS + latches + drift + leases + fases + userLocations + inUse + replans)
      try { hardResetUser(name); } catch (e) { console.error('hardResetUser error:', e); }

      // Evento UI opcional (si querés que el radar saque el marker rápido)
      io.emit('user-removed', name);

      console.log(`❌ Usuario ${name} eliminado por desconexión (hard reset)`);
    } else {
      // aunque no haya name, igual replan por seguridad
      try { planRunwaySequence(); } catch {}
      try { publishRunwayState(); } catch {}
    }
  });


  // 🛑 Cliente pide ser eliminado manualmente (cambio de avión o sale de Radar)
  socket.on('remove-user', (name) => {
    console.log(`🛑 Remove-user recibido para: ${name}`);
    if (userLocations[name]) {
      delete userLocations[name];
          // 👇 limpiar estado sticky
    landingStateByName.delete(name);
    lastOpsStateByName.delete(name);
    try { setFinalLatched(name, false); } catch {}

    clearTurnLease(name);
    }
    // Buscar socketId y eliminar de la tabla inversa
    for (const [sid, uname] of Object.entries(socketIdToName)) {
      if (uname === name) {
        delete socketIdToName[sid];
        break;
      }
    }
    io.emit('user-removed', name);
    console.log(`❌ Usuario ${name} eliminado manualmente`);
    

    // ►► (AGREGADO) limpiar de colas si corresponde
    runwayState.landings = runwayState.landings.filter(x => x.name !== name);
    runwayState.takeoffs = runwayState.takeoffs.filter(x => x.name !== name);
    planRunwaySequence();
    publishRunwayState();
  });

  /* =====================  LISTENERS NUEVOS: RUNWAY  ===================== */

  // Solicitar aterrizaje o despegue / actualizar readiness
// Solicitar aterrizaje o despegue / actualizar readiness
socket.on('runway-request', (msg) => {
  try {
    const { action, name, callsign, aircraft, type, emergency, altitude, ready } = msg || {};
    if (!name || !action) return;

    if (action === 'land') {

            // ✅ RESET completo de aproximación/OPS al pedir aterrizaje (evita "FINAL fantasma")
      try { opsReportedByName.delete(name); } catch {}
      try { lastOpsStateByName.delete(name); } catch {}

      try { b1LatchByName.delete(name); } catch {}
      try { clearFinalEnter(name); } catch {}
      try { driftSinceByName.delete(name); } catch {}
      try { clearTurnLease(name); } catch {}
      try { setFinalLatched(name, false); } catch {}

      // opcional: si querés que el backend vea un estado inicial explícito:
      opsReportedByName.set(name, { state: 'LAND_QUEUE', ts: Date.now(), aux: null });
      lastOpsStateByName.set(name, 'LAND_QUEUE');
      if (!runwayState.landings.some(x => x.name === name)) {
        runwayState.landings.push({
          name, callsign, aircraft, type,
          emergency: !!emergency,
          altitude: typeof altitude === 'number' ? altitude : 999999,
          requestedAt: new Date()
        });
      }

      // Estado inicial al entrar en cola (orden de aterrizaje)
      resetLandingState(name, 'ORD');


      // 🧭 Fase inicial explícita: al pedir aterrizaje arrancamos en TO_B2
      // (no "retrocede" si ya está en una fase más avanzada)
      try { setApproachPhase(name, 'TO_B2'); } catch {}
    }
else if (action === 'takeoff') {

  // ✅ HARD RULE: solo tierra puede pedir despegue
  const TAKEOFF_ALLOWED = new Set([
    'RUNWAY_OCCUPIED',
    'RUNWAY_CLEAR',
    'TAXI_APRON',
    'APRON_STOP',
    'HOLD_SHORT',
    'TAXI_TO_RWY',
  ]);

  // 1) Obtener OPS actual del piloto
  let st = null;
  try {
    // Si ya tenés una función:
    if (typeof getOpsState === 'function') {
      st = getReportedOpsState(name);
    } else {
      // Fallback común: si guardás estados en un Map opsStateByName
      // ejemplo: opsStateByName.set(name, { state:'TAXI_APRON', ts:Date.now() })
      st = opsStateByName?.get(name)?.state ?? null;
    }
  } catch (_) {
    st = null;
  }

  // 2) Rechazar si NO está en tierra
  if (!st || !TAKEOFF_ALLOWED.has(st)) {
  io.to(socket.id).emit('runway-msg', {
    key: 'runway.mustBeOnApronOrRunwayToRequestTakeoff',
    params: {}
  });
    return; // ⛔️ NO agregar a la cola de despegue
  }

  // ✅ si pasó el guard, recién acá se permite
  const idx = runwayState.takeoffs.findIndex(x => x.name === name);
  if (idx === -1) {
    runwayState.takeoffs.push({
      name, callsign, aircraft, type,
      ready: !!ready,
      requestedAt: new Date()
    });
  } else {
    runwayState.takeoffs[idx].ready = !!ready;
  }
}


    planRunwaySequence();
    publishRunwayState();
  } catch (e) {
    console.error('runway-request error:', e);
  }
});


  // Cancelar solicitud
  socket.on('runway-cancel', (msg) => {
    try {
      const { name } = msg || {};
      if (!name) return;
      runwayState.landings = runwayState.landings.filter(x => x.name !== name);
      runwayState.takeoffs = runwayState.takeoffs.filter(x => x.name !== name);
      try { setFinalLatched(name, false); } catch {}
      planRunwaySequence();
      publishRunwayState();
    } catch (e) {
      console.error('runway-cancel error:', e);
    }
  });

  // Marcar pista ocupada (cuando inicia final corta o rueda para despegar)
socket.on('runway-occupy', (msg) => {
  try {
    const { action, name, callsign, slotMin } = msg || {};
    if (!action || !name) return;

    if (!runwayState.inUse) {
      runwayState.inUse = {
        action,
        name,
        callsign: callsign || '',
        startedAt: Date.now(),
        slotMin: slotMin || (action === 'takeoff' ? TKOF_OCCUPY_MIN : MIN_LDG_SEP_MIN)
      };

      // 🔒 Al ocupar pista durante aterrizaje, el avión está en FINAL seguro
      try {
        if (action === 'landing' && name) {
          setApproachPhase(name, 'FINAL');
          setLandingStateForward(name, 'FINAL');

        }
      } catch {}
    }

    publishRunwayState();
  } catch (e) {
    console.error('runway-occupy error:', e);
  }
});


  
  // Liberar pista
  socket.on('runway-clear', () => {
    try {
      // ⚠️ Tomar el último antes de limpiar
      const lastName = runwayState.inUse?.name;

      runwayState.inUse = null;

      // El último que ocupó pista queda como RUNWAY_CLEAR
      if (lastName) setLandingStateForward(lastName, 'RUNWAY_CLEAR');

      planRunwaySequence();
      publishRunwayState();
    } catch (e) {
      console.error('runway-clear error:', e);
    }
  });


  // Obtener estado de pista bajo demanda (al abrir el panel en Radar)
  socket.on('runway-get', () => {
    try {
      cleanupInUseIfDone();
      publishRunwayState();
    } catch (e) {
      console.error('runway-get error:', e);
    }
  });

  // Reporte de arremetida (go-around): libera slot / quita freeze y reingresa
socket.on('go-around', (msg = {}) => {
  try {
    const name = String(msg.name || socketIdToName[socket.id] || '');
    if (!name) return;

    // Quitar freeze y “reinsertar” como llegada activa
    const L = runwayState.landings.find(l => l.name === name);
    if (L) {
      L.frozenLevel = 0;           // pierde el freeze
      L.emergency = !!L.emergency; // opcional, mantené flags
      // (ETA se recalculará en planificar() con computeETAsAndFreeze)
    } else {
      // Si no estaba en cola, reingresarlo como ARR
      runwayState.landings.push({
        name,
        callsign: userLocations[name]?.callsign || '',
        aircraft: userLocations[name]?.type || '',
        type: userLocations[name]?.type || '',
        emergency: false,
        altitude: userLocations[name]?.alt || 999999,
        requestedAt: new Date(),
      });
    }

    // Si estaba ocupando pista, liberarla
    if (runwayState.inUse && runwayState.inUse.name === name) {
      runwayState.inUse = null;
    }

    // Aviso al piloto (UI/voz)
    emitToUser(name, 'runway-msg', { key: 'runway.goAroundRegistered', params: {} });
    // Reinicia a estado post-arremetida (vuelve a ordenar y luego a B1 cuando corresponda)
    resetLandingState(name, 'ORD');
    try { setFinalLatched(name, false); } catch {}
    planRunwaySequence();
    publishRunwayState();
    // 🔁 Volver a fase de aproximación (no tan agresivo como TO_B2)
    try { setApproachPhase(name, 'TO_B1'); } catch {}

  } catch (e) {
    console.error('go-around error:', e);
  }
});


  /* =================== FIN LISTENERS NUEVOS: RUNWAY  ==================== */

});

// --- RUTA DE DIAGNÓSTICO ---
app.get('/api/ping', (req, res) => {
  res.json({ pong: true });
});

// --- API para usuarios y posiciones (sólo lectura o limpieza manual) ---
app.get('/api/locations', (req, res) => {
  res.json(userLocations);
});

// === REST opcional: obtener la pista publicada ===
app.get('/api/airfield', (req, res) => {
  if (!lastAirfield) return res.status(404).json({ error: 'No airfield set' });
  res.json(lastAirfield);
});


app.delete('/api/location/:name', (req, res) => {
  const { name } = req.params;
  if (userLocations[name]) {
    delete userLocations[name];
        // 👇 limpiar estado sticky
    landingStateByName.delete(name);
    lastOpsStateByName.delete(name);

    clearTurnLease(name);
    // limpiar también la tabla inversa si existiera
    for (const [sid, uname] of Object.entries(socketIdToName)) {
      if (uname === name) {
        delete socketIdToName[sid];
        break;
      }
    }

    try { setFinalLatched(name, false); } catch {}

    io.emit('user-removed', name);
    return res.json({ status: 'deleted' });
    
  }
  res.status(404).json({ error: 'Usuario no encontrado' });
});

// (2) Purga de inactivos + emitir user-removed y limpiar tabla inversa
setInterval(() => {
  const now = Date.now();
  const INACTIVITY_LIMIT = 60000;
  for (const [name, loc] of Object.entries(userLocations)) {
    if (now - loc.timestamp > INACTIVITY_LIMIT) {
      delete userLocations[name];
      // limpiar tabla inversa
      for (const [sid, uname] of Object.entries(socketIdToName)) {
        if (uname === name) {
          delete socketIdToName[sid];
          break;
        }
      }
      try { setFinalLatched(name, false); } catch {}
      // avisar a todos
      io.emit('user-removed', name);
      console.log(`⏱️ Purga inactivo: ${name}`);
          // 👇 limpiar estado sticky
    landingStateByName.delete(name);
    lastOpsStateByName.delete(name);

      clearTurnLease(name);
      // ►► (AGREGADO) también limpiar de colas y replanificar
      runwayState.landings = runwayState.landings.filter(x => x.name !== name);
      runwayState.takeoffs = runwayState.takeoffs.filter(x => x.name !== name);
      planRunwaySequence();
      publishRunwayState();
    }
  }
}, 30000);



// --- Ruta para obtener tráfico aéreo cercano ---
app.get('/air-guardian/traffic/:name', (req, res) => {
  const { name } = req.params;
  const user = userLocations[name];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const nearby = [];
  for (const loc of Object.values(userLocations)) {
    if (loc.name === name) continue;
    const distancia = getDistance(user.latitude, user.longitude, loc.latitude, loc.longitude);
    if (distancia < 10000) {
      nearby.push({ name: loc.name, ...loc, distancia });
    }
  }

  res.json({ traffic: nearby });
});

app.get('/', (req, res) => {
  res.send('✈️ Backend Air-Guardian funcionando correctamente.');
});

app.use((err, req, res, next) => {
  console.error('💥 Error inesperado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor (con WebSocket) escuchando en http://0.0.0.0:${PORT}`);
});

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
// === FSM / sticky & compliance ===
const FINAL_LOCK_RADIUS_M = 2000;   // dentro de 2 km de B1 no reordenar más (comprometido)
const MAX_B2_TO_B1_S = 180;         // si en >180 s no progresa de B2→B1, pierde orden (vuelve a WAIT)
const FINAL_DRIFT_MAX_M = 2500;     // si en FINAL se “abre” >2.5 km de B1, pierde FINAL


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

  function getOpsState(name) {
    return opsStateByName.get(name)?.state || null;
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
  landings: [],   // { name, callsign, type, priority, etaB2, etaB1, frozenLevel, phase, phaseTs, lastAdvancementTs, committed }
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

  // B1 siempre igual para todos (fijo)
  const baseB1 = g.B1;

  // B2 base desde la geometría de pista
  const baseB2 = g.B2;

  // Distancia actual de B2 al umbral de pista
  const distB2FromThr = getDistance(g.thr.lat, g.thr.lon, baseB2.lat, baseB2.lon);

  // Índice del avión en la cola de aterrizajes (ya ordenada por planRunwaySequence)
  const idx = runwayState.landings.findIndex(l => l.name === name);
  const stackIndex = Math.max(0, idx); // 0 = primero, 1 = segundo, etc.

  // Queremos:
  //  - el 1º en la cola → B2 (distancia base)
  //  - el 2º → B3 = B2 + 1 * STACK_SPACING
  //  - el 3º → B4 = B2 + 2 * STACK_SPACING
  //
  // O sea: offset = stackIndex * STACK_SPACING
  const distOffsetM = stackIndex * STACK_SPACING_NM * NM_TO_M;
  const stackedDistM = distB2FromThr + distOffsetM;

  // Nuevo punto “Bn” sobre la misma radial de aproximación
  const stackedB2 = destinationPoint(
    g.thr.lat,
    g.thr.lon,
    g.app_brg,     // misma dirección de aproximación
    stackedDistM
  );

  // Nombre lógico del beacon para este avión: B2, B3, B4...
  const beaconOrdinal = 2 + stackIndex;    // 2,3,4,...
  const beaconName = `B${beaconOrdinal}`;

  let asg = approachAssign.get(name);
  if (!asg) {
    asg = { b1: baseB1, b2: stackedB2, beaconName, beaconIndex: beaconOrdinal };
    approachAssign.set(name, asg);
  } else {
    asg.b1 = baseB1;
    asg.b2 = stackedB2;
    asg.beaconName = beaconName;
    asg.beaconIndex = beaconOrdinal;
  }

  return asg;
}



function getLandingByName(name) {
  return runwayState.landings.find(l => l.name === name);
}

function setPhase(name, phase) {
  const L = getLandingByName(name);
  if (!L) return;
  if (L.phase !== phase) {
    L.phase = phase;
    L.phaseTs = Date.now();
  }
}

function markAdvancement(name) {
  const L = getLandingByName(name);
  if (L) L.lastAdvancementTs = Date.now();
}

// Determina si ya no debe reordenarse (comprometido a final)
function isCommitted(name) {
  const L = getLandingByName(name);
    // Si el front reporta FINAL o B1, consideramos comprometido
  const curOps = getOpsState(name);
  if (curOps === 'FINAL' || curOps === 'B1') return true;

  if (!L) return false;
  if (L.frozenLevel === 1) return true;
  if (L.phase === 'B1' || L.phase === 'FINAL') return true;

  // margen de 2 km a B1: no reordenar aunque otro tenga ETA menor
  const asg = assignBeaconsFor(name);
  const u = userLocations[name];
  if (!asg || !u) return false;
  const dB1 = getDistance(u.latitude, u.longitude, asg.b1.lat, asg.b1.lon);
  return isFinite(dB1) && dB1 <= FINAL_LOCK_RADIUS_M;
}

function updateApproachPhase(name) {
  const L = getLandingByName(name);
  if (!L) return;
  const asg = assignBeaconsFor(name);
  const u = userLocations[name];
  if (!asg || !u) return;

  const dB2 = getDistance(u.latitude, u.longitude, asg.b2.lat, asg.b2.lon);
  const dB1 = getDistance(u.latitude, u.longitude, asg.b1.lat, asg.b1.lon);

  // Llegó a B2
  if (isFinite(dB2) && dB2 <= BEACON_REACHED_M) {
    if (L.phase === 'WAIT') {
      setPhase(name, 'B2');
      markAdvancement(name);
    }
      // ➕ avance sticky (NO retrocede)
      setLandingStateForward(name, 'B2');
  }

  // Llegó a B1
  if (isFinite(dB1) && dB1 <= BEACON_REACHED_M) {
    if (L.phase !== 'FINAL') {
      setPhase(name, 'FINAL');     // entra en final
      markAdvancement(name);
      L.frozenLevel = 1;           // opcional: freeze al tocar B1
    }
      // ➕ avance sticky (NO retrocede)
      setLandingStateForward(name, 'B1');
  }

  // Commit dinámico
  L.committed = isCommitted(name);
}


function enforceCompliance() {
  const now = Date.now();
  for (const L of runwayState.landings) {
    const asg = assignBeaconsFor(L.name);
    const u = userLocations[L.name];
    if (!asg || !u) continue;

    const dB1 = getDistance(u.latitude, u.longitude, asg.b1.lat, asg.b1.lon);
    const dB2 = getDistance(u.latitude, u.longitude, asg.b2.lat, asg.b2.lon);

    // Si estaba en FINAL pero se aleja demasiado de B1, pierde FINAL
     //if (L.phase === 'FINAL' && isFinite(dB1) && dB1 > FINAL_DRIFT_MAX_M) {
     //  L.phase = 'WAIT';
     //  L.frozenLevel = 0;
     //  L.phaseTs = now;
     //  L.committed = false;
    // }
    // Evitar histéresis: NO degradar FINAL por alejarse de B1.
// (Si querés una salvaguarda de go-around, hacelo por heading contrario + gran distancia.)


    // Si estaba en B2 y no progresa a B1 en el tiempo máximo, pierde el orden
    if (L.phase === 'B2') {
      const since = now - (L.lastAdvancementTs || L.phaseTs || now);
      if (since > MAX_B2_TO_B1_S * 1000) {
        L.phase = 'WAIT';
        L.frozenLevel = 0;
        L.phaseTs = now;
        L.committed = false;
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
  const u = userLocations[l.name];
  if (u) {
    const dB1 = getDistance(u.latitude, u.longitude, asg.b1.lat, asg.b1.lon);
    if (isFinite(dB1) && dB1 <= B1_FREEZE_RADIUS_M) {
      l.frozenLevel = 1;
    }
  }
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

      // 🚦 Guardas por estado operativo reportado (front es la fuente de verdad)
    const curOps = getOpsState(op.name);
    // Nunca pedir B1/B2 si ya está en FINAL, en pista, liberando pista o en stands
    if (curOps === 'FINAL' || curOps === 'RUNWAY_OCCUPIED' || curOps === 'RUNWAY_CLEAR' || curOps === 'APRON_STOP') {
      return;
    }
    // Nunca pedir B2 si ya pasó por B1
    if (curOps === 'B1') {
      return;
    }


  // --- Auto-advance de fase por proximidad ---
  try {
    if (isFinite(dB2) && dB2 <= BEACON_REACHED_M && curPhase === 'TO_B2') {
      setApproachPhase(op.name, 'TO_B1');
      setLandingStateForward(op.name, 'B2');
    }
    if (isFinite(dB1) && dB1 <= BEACON_REACHED_M && getApproachPhase(op.name) !== 'CLRD') {
      setApproachPhase(op.name, 'FINAL');
      setLandingStateForward(op.name, 'B1'); // ya “pasó” por B1
    }
    if (isFinite(dB1) && dB1 <= B1_FREEZE_RADIUS_M && getApproachPhase(op.name) !== 'CLRD') {
      setApproachPhase(op.name, 'FINAL');
      setLandingStateForward(op.name, 'FINAL'); // congelado en final
    }
  } catch {}

  const phaseNow = getApproachPhase(op.name);

  // 0) Si ya está CLRD, nunca emitir algo que retroceda
  if (phaseNow === 'CLRD') return;

  // 1) Ir a B2/B3/B4... SOLO si aún estamos en TO_B2, no pedimos antes B1 y sticky < B1
  if (phaseNow === 'TO_B2' &&
      dB2 > BEACON_REACHED_M &&
      !stickyReachedB1 &&
      mem.phase !== 'B1') {

    const beaconName = asg.beaconName || 'B2';

    if (mem.phase !== beaconName) {
      emitToUser(op.name, 'atc-instruction', {
        type: 'goto-beacon',
        beacon: beaconName,
        lat: asg.b2.lat,
        lon: asg.b2.lon,
        text: `Proceda a ${beaconName}`
      });
      lastInstr.set(op.name, { phase: beaconName, ts: now });
    }
    return;
  }


  // 2) Ventana para B1, pero NUNCA si ya estás en FINAL/CLRD o sticky >= FINAL
  if ((phaseNow === 'TO_B2' || phaseNow === 'TO_B1') &&
      !stickyReachedFinal &&
      dt != null && dt <= 90000 &&
      dB1 > BEACON_REACHED_M) {

    if (phaseNow === 'TO_B2') setApproachPhase(op.name, 'TO_B1');

    if (getApproachPhase(op.name) === 'TO_B1' && mem.phase !== 'B1') {
      emitToUser(op.name, 'atc-instruction', {
        type: 'goto-beacon',
        beacon: 'B1',
        lat: asg.b1.lat,
        lon: asg.b1.lon,
        text: 'Proceda a B1'
      });
      lastInstr.set(op.name, { phase: 'B1', ts: now });
    }
    return;
  }

  // 3) En FINAL, cerca del slot y pista libre → CLRD
  if (getApproachPhase(op.name) === 'FINAL' && dt != null && dt <= 45000 && !runwayState.inUse) {
    if (mem.phase !== 'CLRD') {
      const rwIdent = activeRunwayGeom()?.rw?.ident || '';
      emitToUser(op.name, 'atc-instruction', { type: 'cleared-to-land', rwy: rwIdent, text: 'Autorizado a aterrizar' });
      lastInstr.set(op.name, { phase: 'CLRD', ts: now });
      setApproachPhase(op.name, 'CLRD');
      setLandingStateForward(op.name, 'FINAL');
    }
    return;
  }

  // 4) En FINAL pero faltando tiempo → silencio. Nunca retroceder a B1.
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

  io.emit('runway-state', {
    airfield,
    state: {
       // ➕ mapa simple name->opsState (reportado por frontend)
      opsStates: Object.fromEntries(
        Array.from(opsStateByName.entries()).map(([k, v]) => [k, v.state])
      ),
      landings: runwayState.landings,
      takeoffs: runwayState.takeoffs,
      inUse: runwayState.inUse,
      timeline: timelineCompat,
      serverTime: now,
       // ➕ mapa simple name->state para que la UI lo muestre si quiere
      landingStates: Object.fromEntries(
      Array.from(landingStateByName.entries()).map(([k, v]) => [k, v.state])
      
    ),
    },
  });


  // Secuencia “avanzada” + beacons para guiar
  const g = activeRunwayGeom();

  // Construir beacons “apilados” para cada llegada en orden
  let stackedBeacons = [];
  if (g) {
    const arrSlots = slots.filter(s => s.type === 'ARR');
    stackedBeacons = arrSlots.map((s, idx) => {
      const name = (s.opId || '').split('#')[1];
      const asg = assignBeaconsFor(name);
      const beaconName = asg?.beaconName || `B${idx + 2}`;
      return {
        name,               // nombre del avión
        beacon: beaconName, // 'B2','B3','B4',...
        lat: asg?.b2.lat ?? g.B2.lat,
        lon: asg?.b2.lon ?? g.B2.lon,
      };
    });
  }

  io.emit('sequence-update', {
    serverTime: now,
    airfield,
    beacons: g ? {
      B1: g.B1,
      B2: g.B2,          // base
      stack: stackedBeacons,  // 👈 NUEVO: beacons B2/B3/B4... por avión
    } : null,
    slots: slots.map((s, idx) => {
      const op = lastOpsById.get(s.opId) || {};
      const prev = idx > 0 ? slots[idx-1] : null;
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
        const st = getOpsState(name);
              const allowTurnMsg = !(
        st === 'FINAL' ||
        st === 'RUNWAY_OCCUPIED' ||
        st === 'RUNWAY_CLEAR' ||
        st === 'APRON_STOP' ||
        st === 'TAXI_APRON'
      );

        if (allowTurnMsg) {
          emitToUser(name, 'runway-msg', { text: `Su turno de aterrizaje ahora es #${idx+1}`, key: 'turn-land' });
        }
      }
    });

    newTk.forEach((name, idx) => {
      if (oldTk.indexOf(name) !== idx) {
        const st2 = getOpsState(name);
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
      // Limpiar la tabla inversa del socket anterior que estaba usando este "name"
      for (const [sid, uname] of Object.entries(socketIdToName)) {
        if (uname === name) {
          delete socketIdToName[sid];
          break;
        }
      }
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
    // ► FSM: actualizar fase con distancias reales
    updateApproachPhase(name);


    socketIdToName[socket.id] = name;

    console.log('🗺️ Estado actual de userLocations:', userLocations);

  for (const [recvName, info] of Object.entries(userLocations)) {
    if (!info?.socketId) continue;

    const list = Object.values(userLocations)
      .filter(u => u.name !== recvName) // cada uno recibe “todos menos yo”
      .map(u => ({
        name: u.name,
        lat: u.latitude,
        lon: u.longitude,
        alt: u.alt,
        heading: u.heading,
        type: u.type,
        speed: u.speed,
        callsign: u.callsign,
        aircraftIcon: u.icon
      }));
    
      io.to(info.socketId).emit('traffic-update', list);
    }

    

    // ►► (AGREGADO) replanificar si hay solicitudes pendientes y cambió la kinemática
    if (runwayState.landings.length || runwayState.takeoffs.length) {
      enforceCompliance();
      planRunwaySequence();
      publishRunwayState();
    }
 });

   // === Estado operativo reportado por el frontend ===
  socket.on('ops/state', (msg) => {
    try {
      const { name, state, aux } = msg || {};
      if (!name || !state) return;
      opsStateByName.set(name, { state, ts: Date.now(), aux });

      // ▸ Ajustes suaves al scheduler según estado
      // Si está ocupando pista, marcamos inUse (fallback por si front no llamó runway-occupy)
      if (state === 'RUNWAY_OCCUPIED' && !runwayState.inUse) {
        runwayState.inUse = { action: 'landing', name, callsign: userLocations[name]?.callsign || '', startedAt: Date.now(), slotMin: MIN_LDG_SEP_MIN };
      }

      // Si liberó pista, limpiamos inUse si era él
      if (state === 'RUNWAY_CLEAR' && runwayState.inUse?.name === name) {
        runwayState.inUse = null;
      }

    // ✅ Apenas toca pista (o la libera), ya NO pertenece más a la cola de aterrizajes.
    //    Así no sigue recibiendo cambios de turno de landing.
    if (state === 'RUNWAY_OCCUPIED' || state === 'RUNWAY_CLEAR') {
      runwayState.landings = runwayState.landings.filter(l => l.name !== name);
    }


      // Congelar reorden al tocar B1/FINAL
      if (state === 'B1' || state === 'FINAL') {
        const L = runwayState.landings.find(l => l.name === name);
        if (L) L.frozenLevel = 1;
      }

          // ✅ Si ya está taxiando al apron o detenido en él, ya terminó su aterrizaje:
    //    - sacarlo de la cola de aterrizajes
    //    - marcarlo como IN_STANDS en el estado sticky
    if (state === 'TAXI_APRON' || state === 'APRON_STOP') {
      runwayState.landings = runwayState.landings.filter(l => l.name !== name);
      setLandingStateForward(name, 'IN_STANDS');
    }

  


      // Replanificar/publicar con el nuevo estado
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

    const target = String(msg?.id || '');       // contra quién fue el RA original
    if (!target) return;

    for (const [recvName, info] of Object.entries(userLocations)) {
      if (recvName === sender || !info?.socketId) continue;

      // espejo: si el receptor es el target, debe limpiar al sender; si no, limpia al target
      const otherName = (recvName === target) ? sender : target;

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
    if (name) {
      delete userLocations[name];
      delete socketIdToName[socket.id];
      io.emit('user-removed', name);
      console.log(`❌ Usuario ${name} eliminado por desconexión`);
          // 👇 limpiar estado sticky
    landingStateByName.delete(name);
    }

    // ►► (AGREGADO) limpiar de colas si corresponde
    runwayState.landings = runwayState.landings.filter(x => x.name !== name);
    runwayState.takeoffs = runwayState.takeoffs.filter(x => x.name !== name);
    planRunwaySequence();
    publishRunwayState();
  });

  // 🛑 Cliente pide ser eliminado manualmente (cambio de avión o sale de Radar)
  socket.on('remove-user', (name) => {
    console.log(`🛑 Remove-user recibido para: ${name}`);
    if (userLocations[name]) {
      delete userLocations[name];
          // 👇 limpiar estado sticky
    landingStateByName.delete(name);
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
    emitToUser(name, 'runway-msg', { text: 'Arremetida registrada. Reingresando en secuencia.', key: 'go-around' });
    // Reinicia a estado post-arremetida (vuelve a ordenar y luego a B1 cuando corresponda)
    resetLandingState(name, 'ORD');
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
    // limpiar también la tabla inversa si existiera
    for (const [sid, uname] of Object.entries(socketIdToName)) {
      if (uname === name) {
        delete socketIdToName[sid];
        break;
      }
    }
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
      // avisar a todos
      io.emit('user-removed', name);
      console.log(`⏱️ Purga inactivo: ${name}`);
          // 👇 limpiar estado sticky
    landingStateByName.delete(name);

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

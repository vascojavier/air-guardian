const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

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

/* =======================================================================================
   ░█▀▀░█░█░█▄█░█░█░█▀▀░█░█░█▀▀░█▀▄░█░█      RUNWAY SCHEDULER (AGREGADO)
   ======================================================================================= */
const MIN_LDG_SEP_MIN = 5;      // separación mínima entre aterrizajes (min)
const TKOF_OCCUPY_MIN = 5;      // ocupación estándar de pista para despegue (min)
const TKOF_MAX_WAIT_MIN = 15;   // prioridad si esperó 15 min

// Un solo scheduler “activo” (si más adelante manejás múltiples, podés mapear por airfieldId/runwayId)
const runwayState = {
  landings: [],   // {name, callsign, aircraft, type, emergency, altitude, etaSec, holding, requestedAt}
  takeoffs: [],   // {name, callsign, aircraft, type, ready, waitedMin, requestedAt}
  inUse: null,    // {action:'landing'|'takeoff', name, callsign, startedAt, slotMin}
  timeline: [],   // próximos slots: [{action, name, at:Date, slotMin}]
};

// helper: cabecera activa (A o B) de lastAirfield
function getActiveThresholdLatLon() {
  if (!lastAirfield) return null;
  const thrKey = lastAirfield.activeThreshold === 'B' ? 'thresholdB' : 'thresholdA';
  const thr = lastAirfield[thrKey];
  if (!thr || typeof thr.lat !== 'number' || typeof thr.lon !== 'number') return null;
  return { lat: thr.lat, lon: thr.lon };
}

// estimar GS (m/s) desde userLocations; si no hay, fallback prudente
function estimateGSms(name) {
  const u = userLocations[name];
  if (!u) return 25; // ~90 km/h
  if (typeof u.speed === 'number' && u.speed > 3) return u.speed; // asumimos m/s desde GPS
  // fallback por tipo
  if ((u.type || '').toUpperCase().includes('GLIDER')) return 20; // ~72 km/h
  return 25;
}

// ETA a cabecera activa (segundos)
function computeETASeconds(name) {
  const thr = getActiveThresholdLatLon();
  const u = userLocations[name];
  if (!thr || !u) return null;
  const d = getDistance(u.latitude, u.longitude, thr.lat, thr.lon); // metros
  const gs = estimateGSms(name); // m/s
  if (!gs || !isFinite(gs) || gs <= 0) return null;
  return Math.max(1, Math.round(d / gs));
}

// prioridad: menor es mejor
function landingPriorityScore(item) {
  if (item.emergency) return 0; // Emergencia primero
  const isGlider = (item.type || '').toUpperCase().includes('GLIDER');
  if (isGlider && (item.altitude ?? 999999) < 300) return 1; // planeador bajo
  // resto por ETA
  return 1000 + (item.etaSec ?? 1e9);
}

// limpiar inUse si venció
function cleanupInUseIfDone() {
  if (!runwayState.inUse) return;
  const end = runwayState.inUse.startedAt + runwayState.inUse.slotMin * 60000;
  if (Date.now() > end) runwayState.inUse = null;
}

// (re)planificar secuencia usando lastAirfield
function planRunwaySequence() {
  cleanupInUseIfDone();
  runwayState.timeline = [];

  // enriquecer landings
  runwayState.landings.forEach(l => {
    l.etaSec = computeETASeconds(l.name);
    l.priority = landingPriorityScore(l);
  });

  // ordenar por prioridad y ETA
  runwayState.landings.sort((a, b) =>
    (a.priority - b.priority) || ((a.etaSec ?? 1e9) - (b.etaSec ?? 1e9))
  );

  // construir slots de aterrizaje con separación mínima
  let lastLandingAt = null;
  for (const l of runwayState.landings) {
    if (l.etaSec == null) continue;
    let etaAt = new Date(Date.now() + l.etaSec * 1000);

    // si colisiona con el anterior, demorar y marcar holding
    if (lastLandingAt && (etaAt - lastLandingAt) < MIN_LDG_SEP_MIN * 60000) {
      etaAt = new Date(lastLandingAt.getTime() + MIN_LDG_SEP_MIN * 60000);
      l.holding = true;
    } else {
      l.holding = false;
    }

    // si hay alguien antes y el ETA actual cae a < MIN_LDG_SEP_MIN → holding
    if (lastLandingAt && ((etaAt - Date.now()) < MIN_LDG_SEP_MIN * 60000)) {
      l.holding = true;
    }

    runwayState.timeline.push({
      action: 'landing',
      name: l.name,
      at: etaAt,
      slotMin: MIN_LDG_SEP_MIN
    });
    lastLandingAt = etaAt;
  }

  // actualizar waitedMin en despegues
  const now = new Date();
  runwayState.takeoffs.forEach(tk => {
    tk.waitedMin = Math.max(0, Math.round((now - tk.requestedAt) / 60000));
  });

  // autorizar despegue si hay hueco suficiente o mucha espera
  const nextLanding = runwayState.timeline.find(s => s.action === 'landing');
  const canSlotNow = !runwayState.inUse;
  const gapOk = nextLanding ? ((nextLanding.at - Date.now()) / 60000 >= TKOF_OCCUPY_MIN) : true;

  const readyTakeoffs = runwayState.takeoffs.filter(t => t.ready);
  readyTakeoffs.sort((a, b) => (b.waitedMin || 0) - (a.waitedMin || 0));

  if (canSlotNow && readyTakeoffs.length) {
    const first = readyTakeoffs[0];
    if (gapOk || first.waitedMin >= TKOF_MAX_WAIT_MIN) {
      runwayState.inUse = {
        action: 'takeoff',
        name: first.name,
        callsign: first.callsign,
        startedAt: Date.now(),
        slotMin: TKOF_OCCUPY_MIN
      };
      runwayState.takeoffs = runwayState.takeoffs.filter(t => t.name !== first.name);
    }
  }
}

function publishRunwayState() {
  io.emit('runway-state', {
    airfield: lastAirfield || null,
    state: {
      landings: runwayState.landings,
      takeoffs: runwayState.takeoffs,
      inUse: runwayState.inUse,
      timeline: runwayState.timeline,
      serverTime: Date.now()
    }
  });
}
/* =======================================================================================
   ░█▀▀░█░█░█▄█░█░█░█▀▀░█░█░█▀▀░█▀▄░█░█      FIN RUNWAY SCHEDULER (AGREGADO)
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

    socketIdToName[socket.id] = name;

    console.log('🗺️ Estado actual de userLocations:', userLocations);

    const trafficData = Object.values(userLocations)
      .filter(u => u.name !== name)
      .map((info) => ({
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

    console.log('📡 Emitiendo tráfico:', trafficData);
    socket.emit('traffic-update', trafficData);

    // ►► (AGREGADO) replanificar si hay solicitudes pendientes y cambió la kinemática
    if (runwayState.landings.length || runwayState.takeoffs.length) {
      planRunwaySequence();
      publishRunwayState();
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


  socket.on('warning', (warningData) => {
    const sender = socketIdToName[socket.id];
    if (!sender) return;

    const senderInfo = userLocations[sender];
    if (!senderInfo) return;

    console.log(`⚠️ Warning recibido de ${sender}:`, warningData);

    const alertLevel =
      warningData.alertLevel ||
      (warningData.type === 'RA' && warningData.timeToImpact < 60
        ? 'RA_HIGH'
        : warningData.type === 'RA'
        ? 'RA_LOW'
        : 'TA');

    const enrichedWarning = {
      id: warningData.id || warningData.name,
      name: warningData.name,
      lat: warningData.lat,
      lon: warningData.lon,
      alt: warningData.alt ?? 0,
      heading: warningData.heading ?? 0,
      speed: warningData.speed ?? 0,
      type: warningData.type || 'unknown',
      timeToImpact: warningData.timeToImpact ?? 999,
      alertLevel,
      aircraftIcon: warningData.aircraftIcon ?? senderInfo.icon ?? '2.png',
      callsign: warningData.callsign ?? senderInfo.callsign ?? '',
    };

    console.log(`📤 Enviando enrichedWarning a otros usuarios:`, enrichedWarning);

    for (const [name, info] of Object.entries(userLocations)) {
      if (name !== sender && info.socketId) {
        io.to(info.socketId).emit('conflicto', enrichedWarning);
      }
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
      } else if (action === 'takeoff') {
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
      }
      publishRunwayState();
    } catch (e) {
      console.error('runway-occupy error:', e);
    }
  });

  // Liberar pista
  socket.on('runway-clear', () => {
    try {
      runwayState.inUse = null;
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

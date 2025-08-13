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
  });

});

// --- RUTA DE DIAGNÓSTICO ---
app.get('/api/ping', (req, res) => {
  res.json({ pong: true });
});

// --- API para usuarios y posiciones (sólo lectura o limpieza manual) ---
app.get('/api/locations', (req, res) => {
  res.json(userLocations);
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

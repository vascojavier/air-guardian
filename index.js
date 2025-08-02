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

function getDistance(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
    const activePlanes = Object.values(userLocations).map(info => ({
      name: info.name,
      latitude: info.latitude,
      longitude: info.longitude,
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

    console.log(`⚠️ Warning recibido de ${sender}:`, warningData);

    for (const [name, info] of Object.entries(userLocations)) {
      if (name !== sender) {
        io.to(info.socketId).emit('conflicto', warningData);
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Cliente desconectado:', socket.id);
    const name = socketIdToName[socket.id];
    if (name) {
      delete userLocations[name];
      delete socketIdToName[socket.id];
    }
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
    return res.json({ status: 'deleted' });
  }
  res.status(404).json({ error: 'Usuario no encontrado' });
});

setInterval(() => {
  const now = Date.now();
  const INACTIVITY_LIMIT = 60000;
  for (const [name, loc] of Object.entries(userLocations)) {
    if (now - loc.timestamp > INACTIVITY_LIMIT) {
      delete userLocations[name];
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

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
let intersections = [];
let semaforos = [];
let trafficLights = [];

const PROXIMITY_RADIUS = 50;

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

function detectarConflictosAereos() {
  const entries = Object.entries(userLocations);

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [nameA, locA] = entries[i];
      const [nameB, locB] = entries[j];

      const dist = getDistance(locA.latitude, locA.longitude, locB.latitude, locB.longitude);
      const altDiff = Math.abs((locA.alt || 0) - (locB.alt || 0));

      if (dist < 1000 && altDiff < 300) {
        io.to(locA.socketId).emit('conflicto', {
          tipo: 'RA',
          con: nameB,
          distancia: Math.round(dist),
          altitudRelativa: (locB.alt || 0) - (locA.alt || 0)
        });
        io.to(locB.socketId).emit('conflicto', {
          tipo: 'RA',
          con: nameA,
          distancia: Math.round(dist),
          altitudRelativa: (locA.alt || 0) - (locB.alt || 0)
        });
      } else if (dist < 2500 && altDiff < 600) {
        io.to(locA.socketId).emit('conflicto', {
          tipo: 'TA',
          con: nameB,
          distancia: Math.round(dist),
          altitudRelativa: (locB.alt || 0) - (locA.alt || 0)
        });
        io.to(locB.socketId).emit('conflicto', {
          tipo: 'TA',
          con: nameA,
          distancia: Math.round(dist),
          altitudRelativa: (locA.alt || 0) - (locB.alt || 0)
        });
      }
    }
  }
}

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

  // Guardar con socket.id como clave interna (más robusto)
  userLocations[socket.id] = {
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

  console.log('🗺️ Estado actual de userLocations:', userLocations);

  // Emitir a todos los demás usuarios menos al emisor
  const trafficData = Object.values(userLocations).filter(u => u.socketId !== socket.id).map((info) => ({
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

  socket.emit('traffic-update', trafficData); // Emití solo a este cliente

  detectarConflictosAereos();
});

socket.on('disconnect', () => {
  console.log('🔌 Cliente desconectado:', socket.id);
  delete userLocations[socket.id];
});


// Resto del backend: rutas, lógica de semáforos, detección, etc.

// --- Resto del backend sin cambios en naming ---
// (Todo lo demás sigue igual, solo corregimos la nomenclatura en userLocations y traffic-update)

// El resto del archivo continúa como ya lo tenías y está correcto.


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

// --- CRUD Intersecciones ---
app.post('/api/intersections', (req, res) => {
  const { latitude, longitude } = req.body;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'Latitude y longitude requeridos' });
  }
  const id = Date.now().toString();
  intersections.push({ id, latitude, longitude });
  res.json({ id, latitude, longitude });
});

app.get('/api/intersections', (req, res) => {
  res.json(intersections);
});

app.delete('/api/intersections/:id', (req, res) => {
  const { id } = req.params;
  const before = intersections.length;
  intersections = intersections.filter(i => i.id !== id);
  if (intersections.length === before) {
    return res.status(404).json({ error: 'No encontrada' });
  }
  res.json({ status: 'deleted' });
});

// --- CRUD Semáforos ---
app.post('/api/semaforos', (req, res) => {
  const { latitude, longitude } = req.body;
  const id = Date.now().toString();
  semaforos.push({ id, latitude, longitude });
  res.status(201).json({ id, latitude, longitude });
});

app.get('/api/semaforos', (req, res) => {
  res.json(semaforos);
});

app.get('/api/traffic-lights', (req, res) => {
  res.json(trafficLights);
});

app.post('/api/traffic-lights', (req, res) => {
  const { latitude, longitude } = req.body;
  trafficLights.push({ latitude, longitude });
  res.status(201).json({ status: 'ok' });
});

app.delete('/api/traffic-lights', (req, res) => {
  const { latitude, longitude } = req.body;
  const prevCount = trafficLights.length;
  trafficLights = trafficLights.filter(
    (light) =>
      Math.abs(light.latitude - latitude) > 0.00001 ||
      Math.abs(light.longitude - longitude) > 0.00001
  );
  if (trafficLights.length === prevCount) {
    return res.status(404).json({ error: 'Semáforo no encontrado' });
  }
  res.json({ status: 'deleted' });
});

// --- Semáforo lógica y herramientas ---
function getBearing(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const toDeg = r => (r * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function trajectoriesCross(b1, b2) {
  const diff = Math.abs(b1 - b2);
  return (diff > 45 && diff < 135) || (diff > 225 && diff < 315);
}

function isNear(loc, inter) {
  return getDistance(loc.latitude, loc.longitude, inter.latitude, inter.longitude) <= PROXIMITY_RADIUS;
}

app.get('/api/semaphore/:name', (req, res) => {
  const userLoc = userLocations[req.params.name];
  if (!userLoc) return res.status(404).json({ error: 'Usuario no encontrado' });

  const nearby = intersections.filter(i => isNear(userLoc, i));
  if (!nearby.length) return res.json({ color: null });

  const inter = nearby[0];
  const others = Object.entries(userLocations).filter(([n, l]) =>
    n !== req.params.name && isNear(l, inter)
  );

  const userBr = getBearing(userLoc.latitude, userLoc.longitude, inter.latitude, inter.longitude);
  for (const [, oLoc] of others) {
    const oBr = getBearing(oLoc.latitude, oLoc.longitude, inter.latitude, inter.longitude);
    if (trajectoriesCross(userBr, oBr)) return res.json({ color: 'red' });
  }
  res.json({ color: 'green' });
});

app.get('/api/semaphores', (req, res) => {
  const result = {};
  for (const [name, loc] of Object.entries(userLocations)) {
    const nearby = intersections.filter(i => isNear(loc, i));
    if (!nearby.length) {
      result[name] = { color: null };
      continue;
    }

    const inter = nearby[0];
    const others = Object.entries(userLocations).filter(([n, l]) =>
      n !== name && isNear(l, inter)
    );

    let color = 'green';
    const userBr = getBearing(loc.latitude, loc.longitude, inter.latitude, inter.longitude);
    for (const [, oLoc] of others) {
      const oBr = getBearing(oLoc.latitude, oLoc.longitude, inter.latitude, inter.longitude);
      if (trajectoriesCross(userBr, oBr)) {
        color = 'red';
        break;
      }
    }
    result[name] = { color };
  }
  res.json(result);
});

// --- Ruta para obtener tráfico aéreo cercano ---
app.get('/air-guardian/traffic/:name', (req, res) => {
  const { name } = req.params;
  const user = userLocations[name];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const nearby = [];
  for (const [otherName, loc] of Object.entries(userLocations)) {
    if (otherName === name) continue;
    const distancia = getDistance(user.latitude, user.longitude, loc.latitude, loc.longitude);
    if (distancia < 10000) {
      nearby.push({ name: otherName, ...loc, distancia });
    }
  }

  res.json({ traffic: nearby });
});

app.get('/', (req, res) => {
  res.send('Backend funcionando correctamente 🚦✈️');
});

app.use((err, req, res, next) => {
  console.error('💥 Error inesperado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});
app.post('/air-guardian/update', (req, res) => {
  const { name, lat, lon, alt = 0, heading = 0, type = 'unknown', aircraftIcon = '', speed = 0, callsign = '' } = req.body;

  if (!name || typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'Datos inválidos' });
  }

userLocations[name] = {
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

  detectarConflictosAereos();
  res.json({ status: 'ok' });
});


// --- INICIO DEL SERVIDOR con WebSocket ---
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor (con WebSocket) escuchando en http://0.0.0.0:${PORT}`);
});

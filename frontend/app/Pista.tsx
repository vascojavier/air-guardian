// C:\air-guardian\frontend\app\Pista.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Button, StyleSheet, Alert, TextInput, Modal } from 'react-native';
import MapView, { Marker, Polyline, MapPressEvent, Region } from 'react-native-maps';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useUser } from '../context/UserContext';
import { useRouter } from 'expo-router';
import ioDefault from 'socket.io-client';
import { Platform } from 'react-native';
import type { Airfield, Runway } from '../types/airfield';
import { socket } from '../utils/socket';




// ---------------------- Tipos locales ----------------------
type LatLng = { latitude: number; longitude: number };

// ---------------------- Helpers ----------------------
const uuid = () =>
  `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const headingToRunwayIdent = (headingDeg: number) => {
  const h = ((headingDeg % 360) + 360) % 360;
  let num = Math.round(h / 10);
  if (num === 0) num = 36;
  if (num > 36) num = 36;
  return num.toString().padStart(2, '0');
};

const calcularRumbo = (p1: LatLng, p2: LatLng): number => {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const lat1 = toRad(p1.latitude);
  const lat2 = toRad(p2.latitude);
  const dLon = toRad(p2.longitude - p1.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

const calcularPuntoIntermedio = (p1: LatLng, p2: LatLng): LatLng => ({
  latitude: (p1.latitude + p2.latitude) / 2,
  longitude: (p1.longitude + p2.longitude) / 2,
});

const midpointToLoc = (A: LatLng, B: LatLng) => ({
  lat: (A.latitude + B.latitude) / 2,
  lng: (A.longitude + B.longitude) / 2,
});


// --- Beacons / Geodesia ---
const NM_TO_M = 1852;
const B1_DIST_NM = 3.5;    // ~3–4 NM
const B2_DIST_NM = 7.0;    // ~6–8 NM

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

function destinationPoint(start: LatLng, bearingDeg: number, distM: number): LatLng {
  const δ = distM / 6371008.8; // IUGG radius
  const θ = toRad(bearingDeg);
  const φ1 = toRad(start.latitude);
  const λ1 = toRad(start.longitude);
  const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ), cosδ = Math.cos(δ);
  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const y = Math.sin(θ) * sinδ * cosφ1;
  const x = cosδ - sinφ1 * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);
  return { latitude: toDeg(φ2), longitude: ((toDeg(λ2) + 540) % 360) - 180 };
}

function computeApproachBearing(A: LatLng, B: LatLng, active: 'A' | 'B'): number {
  const thr = active === 'A' ? A : B;
  const opp = active === 'A' ? B : A;
  const hdg_thr_to_opp = calcularRumbo(thr, opp);   // rumbo umbral -> opuesta
  return (hdg_thr_to_opp + 180) % 360;              // aproximación viene desde afuera
}

function makeDefaultBeacons(A: LatLng, B: LatLng, active: 'A'|'B') {
  const thr = active === 'A' ? A : B;
  const app = computeApproachBearing(A, B, active);
  const B1 = destinationPoint(thr, app, B1_DIST_NM * NM_TO_M);
  const B2 = destinationPoint(thr, app, B2_DIST_NM * NM_TO_M);
  return { B1, B2 };
}



// ---------------------- Socket ----------------------
// ⛔️ ELIMINÁ estas líneas (y su import):
// import ioDefault from 'socket.io-client';
// import { Platform } from 'react-native';
// type IOSocket = ReturnType<typeof ioDefault>;
// const BACKEND_URL = (process.env.EXPO_PUBLIC_BACKEND_URL as string) || (Platform.OS === 'web' ? 'http://localhost:3000' : 'http://192.168.0.10:3000');

// ✅ USÁ el socket global


export default function PistaScreen() {
  const router = useRouter();
  const { role } = useUser(); // 'pilot' o 'aeroclub'

  const [cabeceraA, setCabeceraA] = useState<LatLng | null>(null);
  const [cabeceraB, setCabeceraB] = useState<LatLng | null>(null);
  const [cabeceraActiva, setCabeceraActiva] = useState<'A' | 'B' | null>(null);
  const [rumbo, setRumbo] = useState<number>(0);
  const [modoSeteo, setModoSeteo] = useState<boolean>(false);
  const [numeroPista, setNumeroPista] = useState<string>('');
  const [showModal, setShowModal] = useState<boolean>(false);
  const [showDetails, setShowDetails] = useState(true);
  const [beaconB1, setBeaconB1] = useState<LatLng | null>(null);
  const [beaconB2, setBeaconB2] = useState<LatLng | null>(null);
  // APRON (guardado y edición)
  const [apron, setApron] = useState<LatLng | null>(null);          // pin guardado
  const [apronEdit, setApronEdit] = useState(false);                // modo edición
  const [tempApron, setTempApron] = useState<LatLng | null>(null);  // pin temporal



  // Asegurar conexión cuando entra a Pista
  useEffect(() => {
    if (!socket.connected) socket.connect();
  }, []);


  // Carga inicial: primero intentamos airfieldActive; si no hay, caemos a pistaActiva (legacy)
  useEffect(() => {
    const cargar = async () => {
      try {
        const afRaw = await AsyncStorage.getItem('airfieldActive');
        if (afRaw) {
          const af: Airfield = JSON.parse(afRaw);
          const rw = af.runways?.[0];

          // ⬇️ cargar APRON si existe
          const afApron = (af as any)?.apron;
          if (afApron && typeof afApron.lat === 'number' && typeof afApron.lng === 'number') {
            setApron({ latitude: afApron.lat, longitude: afApron.lng });
          }
          if (rw) {
            const A: LatLng = { latitude: rw.thresholdA.lat, longitude: rw.thresholdA.lng };
            const B: LatLng = { latitude: rw.thresholdB.lat, longitude: rw.thresholdB.lng };
            setCabeceraA(A);
            setCabeceraB(B);
            const active = (rw.active_end ?? 'A') as 'A' | 'B';
            setCabeceraActiva(active);
            const baseHeading = rw.heading_true_ab;
            setRumbo(active === 'A' ? baseHeading : (baseHeading + 180) % 360);
            setNumeroPista(rw.identA ?? '');

            // ==== Beacons: usar los guardados si existen, si no autogenerar ====
            const beaconsAny = (rw as any).beacons;
            if (Array.isArray(beaconsAny) && beaconsAny.length >= 2) {
              const b1 = beaconsAny.find((b: any) => (b.name || '').toUpperCase() === 'B1');
              const b2 = beaconsAny.find((b: any) => (b.name || '').toUpperCase() === 'B2');
              if (b1 && b2) {
                setBeaconB1({ latitude: b1.lat, longitude: b1.lon });
                setBeaconB2({ latitude: b2.lat, longitude: b2.lon });
              } else {
                const { B1, B2 } = makeDefaultBeacons(A, B, active);
                setBeaconB1(B1); setBeaconB2(B2);
              }
            } else {
              const { B1, B2 } = makeDefaultBeacons(A, B, active);
              setBeaconB1(B1); setBeaconB2(B2);
            }
            // ← APRON desde airfield o desde runway, si existe
              try {
                const apr: any = (af as any)?.apron || (rw as any)?.apron;
                if (apr && typeof apr.lat === 'number' && typeof apr.lng === 'number') {
                  setApron({ latitude: apr.lat, longitude: apr.lng });
                }
              } catch {}

            // dentro de cargar(), justo después de calcular y setear A/B/activa/rumbo/beacons:
            try {
              socket.emit('airfield-upsert', { airfield: af });   // 👈 re-publicar
            } catch {}

            return;
          }

        }
        // Fallback legacy
        const datos = await AsyncStorage.getItem('pistaActiva');
        if (datos) {
          const { runway, defaultActiveHeading, numero } = JSON.parse(datos);
          setCabeceraA(runway.A);
          setCabeceraB(runway.B);
          setCabeceraActiva(defaultActiveHeading);
          setNumeroPista(numero || '');
          const calcHeading = calcularRumbo(runway.A, runway.B);
          setRumbo(defaultActiveHeading === 'A' ? calcHeading : (calcHeading + 180) % 360);
        }
      } catch (error) {
        console.error('Error al cargar la pista activa:', error);
      }
    };
    cargar();
    return () => {
      // ❌ no desconectes el socket global acá
      // try { socket?.disconnect(); } catch {}
    };
  }, [socket]);

  // ---------------------- Handlers ----------------------
const handleMapPress = async (event: MapPressEvent) => {
  const coords = event.nativeEvent.coordinate;

  // 1) Modo APRON tiene prioridad
  if (apronEdit) {
    setTempApron(coords);
    return;
  }

  // 2) Modo seteo de pista (A/B)
  if (role !== 'aeroclub' || !modoSeteo) return;
  if (!cabeceraA) {
    setCabeceraA(coords);
    Alert.alert('Cabecera A definida');
  } else if (!cabeceraB) {
    setCabeceraB(coords);
    setShowModal(true);
  }
};



// Poné esto ARRIBA del componente (o justo antes de cambiarCabecera):
const BACKEND_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL as string) ||
  'https://air-guardian-backend.onrender.com'; // o tu URL local durante dev

// Helper: asegura conexión y emite de forma confiable
async function emitAirfieldUpsertReliable(af: Airfield, reuse?: ReturnType<typeof ioDefault> | null) {
  return new Promise<void>((resolve) => {
    // 1) Si nos pasaron un socket ya creado, usalo
    if (reuse) {
      const s = reuse;
      const doEmit = () => {
        try {
          s.emit('airfield-upsert', { airfield: af });
          // peguemos un pequeño delay para no cerrar antes de que viaje
          setTimeout(resolve, 200);
        } catch (_) {
          resolve();
        }
      };
      if (s.connected) return doEmit();
      s.once('connect', doEmit);
      s.connect();
      return;
    }

    // 2) One-shot: creamos un socket, esperamos "connect", emitimos y cerramos
    const s = ioDefault(BACKEND_URL, { transports: ['websocket'], autoConnect: false });
    const cleanup = () => {
      // darle tiempo a que salga por la red
      setTimeout(() => {
        try { s.disconnect(); } catch {}
        resolve();
      }, 300);
    };
    s.on('connect', () => {
      try { s.emit('airfield-upsert', { airfield: af }); }
      catch (_) {}
      cleanup();
    });
    s.on('connect_error', cleanup);
    s.connect();
  });
}

async function persistBeaconsAndEmit(b1: LatLng, b2: LatLng) {
  
  const raw = await AsyncStorage.getItem('airfieldActive');
  if (!raw) return;
  const af: Airfield = JSON.parse(raw);
  if (!af?.runways?.[0]) return;

  (af.runways[0] as any).beacons = [
    { name: 'B1', lat: b1.latitude, lon: b1.longitude },
    { name: 'B2', lat: b2.latitude, lon: b2.longitude },
  ];
  af.lastUpdated = Date.now();
  await AsyncStorage.setItem('airfieldActive', JSON.stringify(af));

  try { socket?.emit?.('airfield-upsert', { airfield: af }); } catch {}
}

async function persistApronAndEmit(p: LatLng) {
  const raw = await AsyncStorage.getItem('airfieldActive');
  if (!raw) return;
  const af: Airfield = JSON.parse(raw);
  if (!af?.runways?.[0]) return;

  // Guardar APRON a nivel airfield (recomendado)
  (af as any).apron = { lat: p.latitude, lng: p.longitude };

  af.lastUpdated = Date.now();
  await AsyncStorage.setItem('airfieldActive', JSON.stringify(af));
  try { socket?.emit?.('airfield-upsert', { airfield: af }); } catch {}
}

async function saveApronPoint() {
  if (!tempApron) return;
  setApron(tempApron);
  await persistApronAndEmit(tempApron);
  setApronEdit(false);
  setTempApron(null);
}

function cancelApronEdit() {
  setApronEdit(false);
  setTempApron(null);
}



const cambiarCabecera = async () => {
  if (!cabeceraActiva || !cabeceraA || !cabeceraB) return;

  const nueva: 'A' | 'B' = cabeceraActiva === 'A' ? 'B' : 'A';
  setCabeceraActiva(nueva);
  setRumbo((prev) => (prev + 180) % 360);

  try {
    // (1) espejo legacy
    const datosLegacy = await AsyncStorage.getItem('pistaActiva');
    if (datosLegacy) {
      const json = JSON.parse(datosLegacy);
      json.defaultActiveHeading = nueva;
      await AsyncStorage.setItem('pistaActiva', JSON.stringify(json));
    }

    // (2) actualizar airfieldActive
    const raw = await AsyncStorage.getItem('airfieldActive');
    if (!raw) return;

    const af: Airfield = JSON.parse(raw);
    if (!af?.runways?.[0]) return;

    af.runways[0].active_end = nueva;
          // Regenerar beacons según cabecera nueva (si no fueron custom movidos)
      try {
        if (cabeceraA && cabeceraB) {
          const { B1, B2 } = makeDefaultBeacons(cabeceraA, cabeceraB, nueva);
          setBeaconB1(B1); setBeaconB2(B2);
          (af.runways[0] as any).beacons = [
            { name: 'B1', lat: B1.latitude, lon: B1.longitude },
            { name: 'B2', lat: B2.latitude, lon: B2.longitude },
          ];
        }
      } catch {}

    af.lastUpdated = Date.now();
    await AsyncStorage.setItem('airfieldActive', JSON.stringify(af));

    // (3) EMITIR al backend — usa tu socket memoizado si existe; si no, one-shot robusto
    //     OJO: 'socket' es el que creaste con useMemo arriba en Pista.tsx
    await emitAirfieldUpsertReliable(af, socket);

  } catch (error) {
    console.error('Error al cambiar cabecera activa:', error);
  }
};





  const guardarPista = async () => {
    if (!cabeceraA || !cabeceraB || !numeroPista) {
      Alert.alert('Faltan datos', 'Definí A, B y el número de pista.');
      return;
    }

    const rumboAB = calcularRumbo(cabeceraA, cabeceraB);
    setRumbo(rumboAB);
    const activa: 'A' | 'B' = 'A';
    setCabeceraActiva(activa);

    // Construir Runway/Airfield unificado
    const identA = numeroPista.trim();
    const identB = headingToRunwayIdent((rumboAB + 180) % 360);

    const runway: Runway = {
      id: uuid(),
      identA,
      identB,
      thresholdA: { lat: cabeceraA.latitude, lng: cabeceraA.longitude },
      thresholdB: { lat: cabeceraB.latitude, lng: cabeceraB.longitude },
      heading_true_ab: rumboAB,
      active_end: activa,
    };

        // Agregar beacons al runway
    const { B1, B2 } = makeDefaultBeacons(cabeceraA, cabeceraB, activa);
    (runway as any).beacons = [
      { name: 'B1', lat: B1.latitude, lon: B1.longitude },
      { name: 'B2', lat: B2.latitude, lon: B2.longitude },
    ];
    setBeaconB1(B1); setBeaconB2(B2);


    const airfield: Airfield = {
      id: uuid(),
      location: midpointToLoc(cabeceraA, cabeceraB),
      runways: [runway],
      lastUpdated: Date.now(),
      source: 'manual',
      ...(apron
        ? { apron: { lat: apron.latitude, lng: apron.longitude } }
        : {}),
    };

    if (apron) (airfield as any).apron = { lat: apron.latitude, lng: apron.longitude };

    try {
      // Guardar NUEVO modelo
      await AsyncStorage.setItem('airfieldActive', JSON.stringify(airfield));

      // (Temporal) Espejo legacy
      const pistaLegacy = {
        runway: { A: cabeceraA, B: cabeceraB },
        defaultActiveHeading: activa,
        numero: identA,
      };
      await AsyncStorage.setItem('pistaActiva', JSON.stringify(pistaLegacy));

      // Emitir WS
      try { socket?.emit?.('airfield-upsert', { airfield }); } catch {}

      // Cerrar modal / salir de modo seteo
      setModoSeteo(false);
      setShowModal(false);

      // Ir a completar opcionales
      router.push('/AirfieldDetails');
    } catch (e) {
      console.error('Error guardando pista/airfield:', e);
      Alert.alert('Error', 'No se pudo guardar la pista.');
    }
  };

  const onRegionChangeComplete = (region: Region) => {
    const threshold = 0.2; // ≈10 km
    setShowDetails(region.latitudeDelta < threshold && region.longitudeDelta < threshold);
  };

  // ---------------------- Render ----------------------
  return (
    <View style={{ flex: 1 }}>
      <MapView
        style={{ flex: 1 }}
        initialRegion={{
          latitude: cabeceraA?.latitude || 51.956,
          longitude: cabeceraA?.longitude || 4.437,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01,
        }}
        onPress={handleMapPress}
        onRegionChangeComplete={onRegionChangeComplete}
      >
        {cabeceraA && showDetails && (
          <Marker coordinate={cabeceraA} title={`Cabecera A ${numeroPista}`}>
            <View style={styles.marker}><Text style={styles.markerText}>A</Text></View>
          </Marker>
        )}
        {cabeceraB && showDetails && (
          <Marker coordinate={cabeceraB} title={`Cabecera B ${numeroPista}`}>
            <View style={styles.marker}><Text style={styles.markerText}>B</Text></View>
          </Marker>
        )}
        {cabeceraA && cabeceraB && (
          <Polyline coordinates={[cabeceraA, cabeceraB]} strokeColor="black" strokeWidth={2} />
        )}
        {/* Línea guía B2 -> B1 -> Umbral activo */}


        {beaconB1 && beaconB2 && cabeceraA && cabeceraB && cabeceraActiva && (
          <Polyline
            coordinates={[
              beaconB2,
              beaconB1,
              cabeceraActiva === 'A' ? cabeceraA : cabeceraB
            ]}
            strokeColor="green"
            strokeWidth={2}
          />
        )}
        {/* B2 (draggable) */}


        {beaconB2 && (
          <Marker
            coordinate={beaconB2}
            draggable
            onDragEnd={async (e) => {
              const c = e.nativeEvent.coordinate;
              setBeaconB2(c);
              if (beaconB1) await persistBeaconsAndEmit(beaconB1, c);
            }}
            title="B2"
            description="Punto de pre-secuencia"
          >
            <View style={[styles.marker, { backgroundColor: '#673AB7' }]}>
              <Text style={styles.markerText}>B2</Text>
            </View>
          </Marker>
        )}
        {/* B1 (draggable) */}


        {beaconB1 && (
          <Marker
            coordinate={beaconB1}
            draggable
            onDragEnd={async (e) => {
              const c = e.nativeEvent.coordinate;
              setBeaconB1(c);
              if (beaconB2) await persistBeaconsAndEmit(c, beaconB2);
            }}
            title="B1"
            description="Freeze point (final)"
          >
            <View style={[styles.marker, { backgroundColor: '#4CAF50' }]}>
              <Text style={styles.markerText}>B1</Text>
            </View>
          </Marker>
        )}

        {/* APRON definitivo */}
        {apron && (
          <Marker coordinate={apron} title="APRON">
            <View style={{ backgroundColor: '#FF9800', padding: 4, borderRadius: 10 }}>
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 10 }}>APRON</Text>
            </View>
          </Marker>
        )}

        {/* APRON temporal (cuando estás marcando) */}
        {apronEdit && tempApron && (
          <Marker coordinate={tempApron} title="APRON (nuevo)">
            <View style={{ backgroundColor: '#FFC107', padding: 4, borderRadius: 10 }}>
              <Text style={{ color: '#333', fontWeight: '700', fontSize: 10 }}>APRON*</Text>
            </View>
          </Marker>
        )}



        {cabeceraA && cabeceraB && cabeceraActiva && (
          <Marker
            coordinate={calcularPuntoIntermedio(cabeceraA, cabeceraB)}
            title={`${numeroPista}`}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
            rotation={rumbo}
          >
            <View style={{ alignItems: 'center' }}>
              <View style={styles.arrow} />
            </View>
          </Marker>
        )}
      </MapView>

      <Modal visible={showModal} transparent animationType="slide">
        <View style={styles.modalContainer}>
          <View style={styles.modalBox}>
            <Text style={styles.text}>Ingresá el número de pista:</Text>
            <TextInput
              style={styles.input}
              placeholder="Ej: 18L"
              value={numeroPista}
              onChangeText={setNumeroPista}
            />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Button title="Cancelar" onPress={() => setShowModal(false)} />
              <Button title="Guardar" onPress={guardarPista} />
            </View>
          </View>
        </View>
      </Modal>

      <View style={styles.panel}>
        {cabeceraActiva && (
          <Text style={styles.text}>Cabecera activa: {cabeceraActiva}</Text>
        )}

        {role === 'aeroclub' && (
          <>
            <Button title="Cambiar cabecera activa" onPress={cambiarCabecera} />

            <Button
              title="Autogenerar B1/B2"
              disabled={!cabeceraA || !cabeceraB || !cabeceraActiva}
              onPress={async () => {
                if (!cabeceraA || !cabeceraB || !cabeceraActiva) return;
                const { B1, B2 } = makeDefaultBeacons(cabeceraA, cabeceraB, cabeceraActiva);
                setBeaconB1(B1);
                setBeaconB2(B2);
                await persistBeaconsAndEmit(B1, B2);
              }}
            />

            <Button
              title={apronEdit ? 'Cancelar marcado de APRON' : '📍 Marcar APRON'}
              onPress={() => {
                setApronEdit(!apronEdit);
                setTempApron(null);
              }}
            />


            <Button
              title={modoSeteo ? 'Cancelar Seteo de Pista' : 'Setear nueva pista'}
              onPress={() => {
                setCabeceraA(null);
                setCabeceraB(null);
                setCabeceraActiva(null);
                setBeaconB1(null);            // ← limpiar beacons también
                setBeaconB2(null);            // ← limpiar beacons también
                setModoSeteo(!modoSeteo);
                setNumeroPista('');
              }}
            />
          </>
        )}




      </View>

      {apronEdit && tempApron && (
  <View style={styles.toolbar}>
    <Text style={{ fontWeight: '700', marginBottom: 8 }}>
      Nueva posición de APRON seleccionada
    </Text>
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Button title="Guardar" onPress={saveApronPoint} />
      <Button title="Cancelar" onPress={cancelApronEdit} />
    </View>
  </View>
)}


    </View>
  );
}

// ---------------------- Styles ----------------------
const styles = StyleSheet.create({
  panel: {
    padding: 10,
    paddingBottom: 30,
    backgroundColor: '#fff',
  },
  text: {
    fontWeight: 'bold',
    marginBottom: 10,
  },
  arrow: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderLeftWidth: 10,
    borderRightWidth: 10,
    borderBottomWidth: 20,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: 'green',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 5,
    padding: 8,
    marginBottom: 10,
  },
  marker: {
    backgroundColor: '#2196F3',
    padding: 2,
    borderRadius: 10,
    minWidth: 20,
    alignItems: 'center',
  },
  markerText: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 10,
  },
  runwayNumber: {
    backgroundColor: '#2196F3',
    padding: 4,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalBox: {
    width: '80%',
    backgroundColor: 'white',
    borderRadius: 10,
    padding: 20,
    elevation: 5,
  },
  toolbar: {
  position: 'absolute',
  left: 10,
  right: 10,
  bottom: 120,
  backgroundColor: 'white',
  borderRadius: 12,
  padding: 10,
  elevation: 4,
  shadowColor: '#000',
  shadowOpacity: 0.1,
  shadowRadius: 4,
},

});

import React, { useEffect, useState, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  Image as RNImage,
  Alert,
  Platform,
  AppState,
  ScrollView,
} from 'react-native';

//                                             ^^^^^^^^^^^^^^  agrega esto

import MapView, { Marker, PROVIDER_GOOGLE, Polyline } from 'react-native-maps';
import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';
import { useUser } from '../context/UserContext';
import { getOwnPlaneIcon } from '../utils/getOwnPlaneIcon';
import { getRemotePlaneIcon } from '../utils/getRemotePlaneIcon';
import { normalizeModelToIcon } from '../utils/normalizeModelToIcon';
import TrafficWarningCard from './components/TrafficWarningCard';
import { Plane } from '../types/Plane';
export const BACKEND_URL = 'https://air-guardian-backend.onrender.com';
export const SERVER_URL  = BACKEND_URL; // aliass
import io from "socket.io-client";
import { socket } from '../utils/socket';
//import { calcularWarningLocalMasPeligroso } from '../data/WarningSelector';
import { Warning } from '../data/FunctionWarning';
import { useFocusEffect } from "@react-navigation/native";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Airfield } from '../types/airfield';
import * as Speech from 'expo-speech';
import { useLocalSearchParams } from 'expo-router';

import { iconMap } from '../utils/iconMap';


function iconKeyFor(aircraftIcon?: string, alert?: 'none'|'TA'|'RA_LOW'|'RA_HIGH') {
  // normaliza: saca .png si viene como '2.png'
  const base = (aircraftIcon || '2').replace(/\.png$/i, '');
  if (alert === 'RA_HIGH') return `${base}red`;
  if (alert === 'RA_LOW')  return `${base}orange`;
  if (alert === 'TA')      return `${base}yellow`;
  return base; // none
}

// === PlaneIcon: rota el bitmap en su centro (arregla descentrado en tablet/rotación) ===
const ICON_SIZE = 56;

const PlaneIcon = ({ source, heading = 0 }: { source: any; heading?: number }) => {
  const hdg = Number.isFinite(heading) ? heading : 0;

  let ok = false;
  try {
    ok = !!RNImage.resolveAssetSource(source);
  } catch {
    ok = false;
  }

  if (!ok) {
    // fallback visible SIEMPRE
    return (
      <View
        style={{
          width: ICON_SIZE,
          height: ICON_SIZE,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        collapsable={false}
        pointerEvents="none"
      >
        <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#2979FF' }} />
      </View>
    );
  }

  return (
    <View
      style={{
        width: ICON_SIZE,
        height: ICON_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      collapsable={false}
      pointerEvents="none"
    >
      <RNImage
        source={source}
        style={{
          width: ICON_SIZE,
          height: ICON_SIZE,
          transform: [
            { rotate: `${hdg}deg` },
            { scale: 0.4 },             // ⬅️ hace el avión más chico dentro de esos 40 px
          ],
          backfaceVisibility: 'hidden',
        }}

        resizeMode="contain"
      />

      {/* 🔴 PUNTO MAGENTA EN EL CENTRO DEL PNG */}
      <View
        style={{
          position: 'absolute',
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: 'magenta',
        }}
      />
    </View>
  );
};






type OpsState =
  | 'APRON_STOP' | 'TAXI_APRON' | 'TAXI_TO_RWY' | 'HOLD_SHORT'
  | 'RUNWAY_OCCUPIED' | 'RUNWAY_CLEAR' | 'AIRBORNE'
  | 'LAND_QUEUE' | 'B2' | 'B1' | 'FINAL';




interface LatLon {
  latitude: number;
  longitude: number;
}

// === Distancia Haversine unificada (metros) ===
const EARTH_RADIUS_M = 6371008.8; // IUGG mean Earth radius
const toRad = (d: number) => (d * Math.PI) / 180;

const getDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  // Manejo simple de nulos/NaN para evitar NaN cascada
  if (
    typeof lat1 !== 'number' || typeof lon1 !== 'number' ||
    typeof lat2 !== 'number' || typeof lon2 !== 'number'
  ) return NaN;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
};

function movePoint(lat: number, lon: number, headingDeg: number, distanceM: number): LatLon {
  // reutiliza la lógica de getFuturePosition
  const speedKmh = (distanceM * 3.6);  // 1 segundo de vuelo a esta “velocidad” = distanceM
  return getFuturePosition(lat, lon, headingDeg, speedKmh, 1);
}

// bearing entre dos puntos (en grados)
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  const b = (Math.atan2(y, x) * 180) / Math.PI;
  return (b + 360) % 360;
}


const getFuturePosition = (lat: number, lon: number, heading: number, speedKmh: number, timeSec: number): LatLon => {
  const distanceMeters = (speedKmh * 1000 / 3600) * timeSec; // km/h -> m/s
  const deltaLat = (distanceMeters / 111320) * Math.cos((heading * Math.PI) / 180);
  const denom = 40075000 * Math.cos((lat * Math.PI) / 180) / 360;
  const deltaLon = (distanceMeters / denom) * Math.sin((heading * Math.PI) / 180);
  return { latitude: lat + deltaLat, longitude: lon + deltaLon };
};

// --- Parámetros de RA ajustables ---
const RA_CONE_DEG = 28;       // antes 15°
const RA_MIN_DIST_M = 2000;   // antes 1500 m
const RA_VSEP_MAX_M = 300;    // igual que antes
const RA_HIGH_TTI_S = 60;
const RA_LOW_TTI_S  = 180;
// --- Parámetros de TA ---
const TA_RADIUS_M = 2000; // antes se usaban 3000m hardcodeados

// TA extra
const TA_HYPER_M = 300;    // hiper-cercanía: siempre importante, aunque se aleje
const TA_VSEP_MAX_M = 400; // máx diferencia vertical para considerar TA


// --- Touch & Go / pegajosidad de tierra ---
const TOUCHGO_AGL_M = 12;          // margen por error GPS (~10–15 m)
const TOUCHGO_HYST_MS = 3000;      // sostener AGL>umbral 3 s
const TOUCHGO_MIN_SPEED_KMH = 70;  // velocidad mínima “de vuelo”
const GROUND_STICK_MS = 12000;     // no “volver a volar” dentro de 12 s tras estar en tierra

const lightMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#f5f5f5' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#f5f5f5' }] },

  {
    featureType: 'poi',
    elementType: 'geometry',
    stylers: [{ color: '#eeeeee' }],
  },
  {
    featureType: 'poi.park',
    elementType: 'geometry',
    stylers: [{ color: '#e5f5e0' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry',
    stylers: [{ color: '#ffffff' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry',
    stylers: [{ color: '#dadada' }],
  },
  {
    featureType: 'transit',
    elementType: 'geometry',
    stylers: [{ color: '#e5e5e5' }],
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#c9e6ff' }],
  },
];


const Radar = () => {


  const { username, aircraftModel, aircraftIcon, callsign } = useUser();
  const [simMode, setSimMode] = useState(true);
  const [selected, setSelected] = useState<Plane | null>(null);
  const [conflict, setConflict] = useState<Plane | null>(null);
  const [followMe, setFollowMe] = useState(true);
  const hideSelectedTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guarda la última vez (ms) que enviamos un warning por avión
  const lastWarningTimeRef = useRef<Record<string, number>>({});
  const backendDistanceRef = useRef<Record<string, number>>({});
  const selectedHoldUntilRef = useRef<number>(0);
  const groundRefAltMSLRef = useRef<number | null>(null);
  const lastGroundAtRef = useRef<number>(0);
  const airborneCandidateSinceRef = useRef<number | null>(null);
  const lastGroundSeenAtRef = useRef<number>(Date.now());


  



  const refreshPinnedDistance = () => {
  setPrioritizedWarning(prev => {
    if (!prev) return prev;

    // 1) ¿tenemos distancia “oficial” del backend (emisor)?
    const backendDist = backendDistanceRef.current[prev.id];

    let freshDist: number | undefined = undefined;
    if (typeof backendDist === 'number') {
      freshDist = backendDist;
    } else {
      // 2) si no hay backendDist, calculamos localmente contra el ícono en pantalla
      const p = planes.find(pl => pl.id === prev.id);
      if (p && myPlane) {
        freshDist = getDistance(myPlane.lat, myPlane.lon, p.lat, p.lon);
      }
    }

    // si logramos una distancia nueva, sólo actualizamos ese campo
    return (typeof freshDist === 'number')
      ? { ...prev, distanceMeters: freshDist }
      : prev;
      });
    };


    

  // único timer
  const holdTimerRef = useRef<NodeJS.Timeout | null>(null);
  // debounce solo para TA
  const taDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const TA_DEBOUNCE_MS = 400;
  const snoozeUntilRef = useRef<number>(0);
  const snoozeIdRef = useRef<string | null>(null);



  const [warnings, setWarnings] = useState<{ [id: string]: Warning }>({});
  const [selectedWarning, setSelectedWarning] = useState<Warning | null>(null);
  const [localWarning, setLocalWarning] = useState<Warning | null>(null);
  const [backendWarning, setBackendWarning] = useState<Warning | null>(null);
  const [prioritizedWarning, setPrioritizedWarning] = useState<Warning | null>(null);
  // === RUNWAY: estado del panel y del estado de pista ===
  const [runwayState, setRunwayState] = useState<null | {
    airfield?: any;
    state?: {
      landings?: any[];
      takeoffs?: any[];
      inUse?: any | null;
      timeline?: any[];
      serverTime?: number;
    }
    
  }>(null);
  
    function randomOffsetAround(
      lat: number,
      lon: number,
      radiusM = 10000
    ): { latitude: number; longitude: number } {
      const r = Math.random() * radiusM;          // radio [0, radiusM]
      const theta = Math.random() * 2 * Math.PI;  // ángulo [0, 2π)

      const dLat = (r * Math.cos(theta)) / 111320; // m → grados aprox
      const denom = 111320 * Math.cos((lat * Math.PI) / 180) || 1;
      const dLon = (r * Math.sin(theta)) / denom;

      return {
        latitude: lat + dLat,
        longitude: lon + dLon,
      };
    }


  // === Helper: forzar emisión inmediata de OPS ===
function emitOpsNow(next: OpsState) {
  const now = Date.now();
  if (lastOpsStateRef.current !== next) {
    lastOpsStateRef.current = next;
    lastOpsStateTsRef.current = now;
    socketRef.current?.emit('ops/state', {
      name: username,
      state: next,
      aux: {
        airportId: (airfield as any)?.icao || (airfield as any)?.id || (airfield as any)?.name || '',
        rwyIdent: (rw?.active_end === 'B' ? (rw?.identB ?? '') : (rw?.identA ?? '')) || '',
        aglM: getAGLmeters(),
        onRunway: isOnRunwayStrip(),
        nearHoldShort: isNearThreshold((rw?.active_end === 'B' ? 'B' : 'A') as any, 100),
      },
    });
    console.log('[OPS] Forced emit', next);
  }
}



  const [zoom, setZoom] = useState({ latitudeDelta: 0.1, longitudeDelta: 0.1 });
  const [planes, setPlanes] = useState<Plane[]>([]);
  const [myPlane, setMyPlane] = useState<Plane>({
    id: username,
    name: 'Mi avión',
    lat: 51.95,
    lon: 4.45,
    alt: 300,
    heading: 90,
    speed: 40,
  });

  const initialRandomizedRef = useRef(false);

  useEffect(() => {
    if (initialRandomizedRef.current) return;
    initialRandomizedRef.current = true;

    setMyPlane(prev => {
      const baseLat = prev.lat ?? 51.95;
      const baseLon = prev.lon ?? 4.45;
      const p = randomOffsetAround(baseLat, baseLon, 10000); // 10 km
          const randomHeading = Math.floor(Math.random() * 360); // 0–359°
          const randomAltitudeMeters = () => {
          const min = 300;
          const max = 3000;
          return Math.floor(min + Math.random() * (max - min));
           };


          return {
            ...prev,
            lat: p.latitude,
            lon: p.longitude,
            alt: randomAltitudeMeters(),   // 👈 ahora es random entre 300 y 3000
            heading: randomHeading,
          };
    });
  }, []);


  const lastSentWarningRef = useRef<{ sig: string; t: number } | null>(null);
  const lastRAIdRef = useRef<string | null>(null);
  // Hold por RA de 6s por avión (evita que TA local “pise” al RA backend)
  const raHoldUntilRef = useRef<Record<string, number>>({});
    // RA actual emitido por *este* avión (mi avión)
  const activeRAIdRef = useRef<string | null>(null);



  

const maybeEmitWarning = (w: Warning) => {
  // ⚠️ Nunca mandamos TA al backend: sólo RA
  if (w.alertLevel === 'TA') {
    return;
  }

  // a partir de acá, sólo RA_LOW / RA_HIGH
  const socket = socketRef.current;
  if (!socket) return;

  // lo que ya tengas para throttle / evitar duplicados, etc.
  // (ejemplo genérico)
  const payload = {
    id: w.id,
    name: w.name,
    lat: w.lat,
    lon: w.lon,
    alt: w.alt,
    heading: w.heading,
    speed: w.speed,
    alertLevel: w.alertLevel,  // RA_LOW / RA_HIGH
    timeToImpact: w.timeToImpact,
    aircraftIcon: w.aircraftIcon,
    callsign: w.callsign,
    type: 'RA',                // 👈 importante: marcamos RA
  };

  socket.emit('warning', payload);
};


// Debajo de los imports, donde ya lo tenés:
const { isMotorized: isMotorizedParam } = useLocalSearchParams<{
  isMotorized?: string;   // 👈 solo string acá
}>();



const isMotorizedBool = (() => {
  if (Array.isArray(isMotorizedParam)) {
    const v = isMotorizedParam[0];
    return v === '1' || v === 'true';
  }
  if (typeof isMotorizedParam === 'string') {
    return isMotorizedParam === '1' || isMotorizedParam === 'true';
  }
  if (typeof isMotorizedParam === 'boolean') {
    return isMotorizedParam;
  }
  return true; // 🔥 fallback seguro = asumimos A MOTOR si no sabemos
})();

  const clearWarningFor = (planeId: string) => {
  // 1) sacá el warning del diccionario
  setWarnings(prev => {
    const { [planeId]: _omit, ...rest } = prev;
    return rest;
  });

    // 2) poné el avión en estado visual “sin alerta”
    setPlanes(prev =>
      prev.map(p =>
        p.id === planeId
          ? { ...p, alertLevel: 'none', timeToImpact: undefined }
          : p
      )
    );

    setTraffic(prev =>
      prev.map(t =>
        t.id === planeId
          ? { ...t, alertLevel: 'none', timeToImpact: undefined }
          : t
      )
    );




    // 3) si justo ese avión estaba seleccionado/priorizado, limpiá tarjetas
    setSelected(s => (s && s.id === planeId ? null : s));
    setConflict(c => (c && c.id === planeId ? null : c));
    setPrioritizedWarning(w => (w && w.id === planeId ? null : w));
  };
// Cuando cambia el username (p. ej., elegís otro avión), sincroniza myPlane.id
useEffect(() => {
  if (!username) return;
  setMyPlane(prev => ({ ...prev, id: username, name: username }));
}, [username]);

const [track, setTrack] = useState<LatLon[]>([]);
const [traffic, setTraffic] = useState<Plane[]>([]);


// Secuencia/slots (de sequence-update)
const [slots, setSlots] = useState<Array<{opId:string; type:'ARR'|'DEP'; name:string; startMs:number; endMs:number; frozen:boolean;}>>([]);
// Target de navegación que llega por ATC (o por tu lógica local)
const [navTarget, setNavTarget] = useState<LatLon | null>(null);
const mapRef = useRef<MapView | null>(null);
const socketRef = useRef<ReturnType<typeof io> | null>(null);
const isFocusedRef = useRef(false);
const lastDistanceRef = useRef<Record<string, number>>({});
const serverATCRef = useRef(false);
// Candado de turno cuando paso por B1 (FINAL)
// Se suelta solo si el líder es EMERGENCIA
const finalLockedRef = useRef(false);
const lastOpsStateRef = useRef<OpsState | null>(null);
const lastOpsStateTsRef = useRef<number>(0);
const OPS_DWELL_MS = 4000; // permanecer 4s antes de anunciar cambio
// Mantener visible el APRON hasta volver a volar
const apronLatchRef = useRef(false);
const lastOnRunwayAtRef = useRef<number>(0);







// === Airfield (pista) ===
const [airfield, setAirfield] = useState<Airfield | null>(null);

// Derivados de la runway activa (si existe)
const rw = airfield?.runways?.[0];
const A_runway = rw ? { latitude: rw.thresholdA.lat, longitude: rw.thresholdA.lng } : null;
const B_runway = rw ? { latitude: rw.thresholdB.lat, longitude: rw.thresholdB.lng } : null;
const activeIdent = useMemo<string | null>(() => {
  if (!rw) return null;
  return rw.active_end === 'B' ? (rw.identB ?? null) : (rw.identA ?? null);
}, [rw]);

const runwayHeading = rw
  ? (rw.active_end === 'A' ? rw.heading_true_ab : (rw.heading_true_ab + 180) % 360)
  : 0;
const runwayMid = (A_runway && B_runway)
  ? { latitude: (A_runway.latitude + B_runway.latitude) / 2, longitude: (A_runway.longitude + B_runway.longitude) / 2 }
  : null;

    // === Beacons desde airfield (si existen) ===
  const beaconB1 = useMemo<LatLon | null>(() => {
    const arr = (rw as any)?.beacons as Array<{name:string; lat:number; lon:number}> | undefined;
    const b1 = arr?.find(b => (b.name || '').toUpperCase() === 'B1');
    return b1 ? { latitude: b1.lat, longitude: b1.lon } : null;
  }, [rw]);

  const beaconB2 = useMemo<LatLon | null>(() => {
    const arr = (rw as any)?.beacons as Array<{name:string; lat:number; lon:number}> | undefined;
    const b2 = arr?.find(b => (b.name || '').toUpperCase() === 'B2');
    return b2 ? { latitude: b2.lat, longitude: b2.lon } : null;
  }, [rw]);

// === Beacons extra B3, B4... generados extendiendo la línea B2 -> "hacia afuera" ===
const extraBeacons = useMemo<LatLon[]>(() => {
  if (!beaconB1 || !beaconB2) return [];

  const d = getDistance(
    beaconB1.latitude, beaconB1.longitude,
    beaconB2.latitude, beaconB2.longitude
  );
  if (!Number.isFinite(d) || d <= 0) return [];

  // rumbo de B2 hacia B1 (entrada a circuito)
  const inbound = bearingDeg(
    beaconB2.latitude, beaconB2.longitude,
    beaconB1.latitude, beaconB1.longitude
  );
  // para colocar B3/B4 "detrás" de B2, nos vamos al rumbo contrario
  const outbound = (inbound + 180) % 360;

  const result: LatLon[] = [];

  // B3 = B2 + d
  const b3 = movePoint(beaconB2.latitude, beaconB2.longitude, outbound, d);
  result.push(b3);

  // B4 = B3 + d
  const b4 = movePoint(b3.latitude, b3.longitude, outbound, d);
  result.push(b4);

  return result; // [B3, B4]
}, [beaconB1, beaconB2]);




  const activeThreshold = useMemo<LatLon | null>(() => {
    if (!rw) return null;
    return rw.active_end === 'B' ? B_runway : A_runway;
  }, [rw, A_runway, B_runway]);

    // === APRON/MANGA: punto objetivo para liberar pista/taxiar ===
  function getApronPoint() : LatLon | null {
    // 1) Preferencia: runway.apron si existe
    const apr = (rw as any)?.apron;
    if (apr && typeof apr.lat === 'number' && typeof apr.lng === 'number') {
      return { latitude: apr.lat, longitude: apr.lng };
    }
    // 2) Alternativa: airfield.apron
    const afApr = (airfield as any)?.apron;
    if (afApr && typeof afApr.lat === 'number' && typeof afApr.lng === 'number') {
      return { latitude: afApr.lat, longitude: afApr.lng };
    }
    // 3) Fallback: pequeño offset lateral desde la cabecera activa
    if (activeThreshold) {
      return {
        latitude: activeThreshold.latitude + 0.001, // ~110 m
        longitude: activeThreshold.longitude + 0.001
      };
    }
    return null;
  }

  // === Helper: distancia a APRON (m) ===
function apronDistanceM(p:{lat:number; lon:number}): number {
  const apr = getApronPoint();
  if (!apr) return Infinity;
  return getDistance(p.lat, p.lon, apr.latitude, apr.longitude);
}

// === Gate lateral para planeadores (derecha de cabecera activa) ===
const gliderGatePoint = useMemo<LatLon | null>(() => {
  if (!rw || !activeThreshold) return null;

  // Rumbo de aterrizaje (hacia la cabecera activa)
  const landingHeading =
    rw.active_end === 'B'
      ? rw.heading_true_ab
      : (rw.heading_true_ab + 180) % 360;

  // Derecha respecto al rumbo de aterrizaje
  const rightBearing = (landingHeading + 90) % 360;

  // Distancias ajustables
  const lateralDistM = 200; // a la derecha de la pista
  const backDistM    = 300; // "antes" del umbral

  // 1) desde cabecera → derecha
  const p1 = movePoint(
    activeThreshold.latitude,
    activeThreshold.longitude,
    rightBearing,
    lateralDistM
  );

  // 2) desde ahí → hacia atrás en el eje de pista
  const opposite = (landingHeading + 180) % 360;
  const p2 = movePoint(p1.latitude, p1.longitude, opposite, backDistM);

  return p2;
}, [rw, activeThreshold]);

// === Info de planeo de *mi* avión para la UI ===
const myGlideInfo = computeMyGlideInfo();
const myIsGlider  = isGliderType(myPlane.type);
const myCantReach =
  myIsGlider && myGlideInfo.klass === 'NO_REACH';

// Mostrar APRON sólo en cabecera o al liberar pista, y mantenerlo (latch) hasta despegar
const shouldShowApronMarker = useMemo(() => {
  if (!rw) return false;

  // 1) Estados de tierra visibles
  const st = lastOpsStateRef.current as OpsState | null;
  if (st === 'RUNWAY_CLEAR' || st === 'TAXI_APRON' || st === 'APRON_STOP') return true;

  // 2) Liberando pista (sobre pista y lento)
  const freeingRunway = isOnRunwayStrip() && (myPlane?.speed ?? 0) < 40;
  if (freeingRunway) return true;

  // 3) Latch activo → mantener visible hasta despegar/taxiar a cabecera
  if (apronLatchRef.current) return true;

  return false;
}, [rw, myPlane.lat, myPlane.lon, myPlane.speed, runwayState]);



  // --- NAV: anti-histeresis ---
const navPhaseRef = useRef<'B2'|'B1'|'FINAL'|null>(null);
const lastPhaseSwitchRef = useRef(0);
const prevIdxRef = useRef<number | null>(null); // idx anterior (# en cola)
const NAV_MIN_DWELL_MS = 8000;   // permanecer al menos 8 s en cada fase

// Histeresis de distancia a B1 (m)
const B1_ENTER_M = 950;  // si estoy más lejos que esto → B1
const B1_EXIT_M  = 800;  // si me alejo por encima de esto desde FINAL → volver a B1
const FINAL_ENTER_M = 550; // si estoy más cerca que esto → FINAL

function maybeSwitchPhase(newPhase:'B2'|'B1'|'FINAL') {
  const now = Date.now();
  if (navPhaseRef.current !== newPhase && (now - lastPhaseSwitchRef.current) >= NAV_MIN_DWELL_MS) {
    navPhaseRef.current = newPhase;
    lastPhaseSwitchRef.current = now;
    return true;
  }
  return false;
}


// === AG: helper para avisar que salimos ===
const emitLeave = () => {
  try {
    const s = socketRef.current;
    if (s && (s as any).connected) {
      (s as any).emit('air-guardian/leave');
      console.log('👋 Enviado air-guardian/leave');
    }
  } catch (_) {}
};
// === AG: fin helper ===

const priorizarWarningManual = (warning: Warning) => {
  setPrioritizedWarning(warning);
  setSelectedWarning(warning);
};

// === RUNWAY UI EFÍMERA (labels + banners 6s) ===
const [runwayTapEnd, setRunwayTapEnd] = useState<'A'|'B'|null>(null);     // qué cabecera tocaste
const [runwayLabelUntil, setRunwayLabelUntil] = useState<number>(0);      // expira a los 6s
const [banner, setBanner] = useState<{ text: string; key?: string } | null>(null); // avisos 6s

// flags de flujo
const takeoffRequestedRef = useRef(false);
const landingRequestedRef = useRef(false);
const iAmOccupyingRef = useRef<null | 'landing' | 'takeoff'>(null); // sé si marqué occupy

// cooldown anti-spam para banners
const lastBannerAtRef = useRef<Record<string, number>>({});
const landClearShownRef = useRef(false);


// estimar velocidad de pérdida (km/h) por tipo
function estimateStallKmh(t: string|undefined) {
  const up = (t||'').toUpperCase();
  if (up.includes('GLIDER') || up.includes('PLANEADOR')) return 55;
  if (up.includes('JET') || up.includes('LINEA')) return 180;
  if (up.includes('TWIN') || up.includes('BIMOTOR')) return 110;
  return 80; // monomotor liviano
}

// radio de medio giro (m) por tipo
function halfTurnRadiusM(t: string|undefined) {
  const up = (t||'').toUpperCase();
  if (up.includes('GLIDER') || up.includes('PLANEADOR')) return 50;
  if (up.includes('TWIN') || up.includes('BIMOTOR')) return 100;
  if (up.includes('JET') || up.includes('LINEA')) return 500;
  return 50; // monomotor liviano
}

// promedio entre velocidad actual y pérdida -> m/s
function avgApproachSpeedMps(speedKmh: number, type?: string) {
  const stall = estimateStallKmh(type);
  const avgKmh = (Math.max(30, speedKmh) + stall) / 2;
  return (avgKmh * 1000) / 3600;
}



// distancia punto–segmento (m) para saber si estás sobre la pista (eje)
function distancePointToSegmentM(
  p:{lat:number;lon:number},
  a:{lat:number;lon:number},
  b:{lat:number;lon:number}
) {
  const ax=a.lat, ay=a.lon, bx=b.lat, by=b.lon, px=p.lat, py=p.lon;
  const abx=bx-ax, aby=by-ay;
  const apx=px-ax, apy=py-ay;
  const ab2 = abx*abx + aby*aby;
  const u = Math.max(0, Math.min(1, ab2 ? ((apx*abx + apy*aby)/ab2) : 0));
  const q = { lat: ax + u*abx, lon: ay + u*aby };
  return getDistance(px, py, q.lat, q.lon);
}

function isOnRunwayStrip(): boolean {
  if (!A_runway || !B_runway) return false;
  const d = distancePointToSegmentM(
    { lat: myPlane.lat, lon: myPlane.lon },
    { lat: A_runway.latitude, lon: A_runway.longitude },
    { lat: B_runway.latitude, lon: B_runway.longitude }
  );
  // ancho de pista + margen (aprox 40m)
// ancho de pista + margen (ajustado a 30 m para menos falsos positivos)
  return d <= 30;

}

function isNearThreshold(end:'A'|'B', radiusM=60): boolean {
  const thr = end==='A' ? A_runway : B_runway;
  if (!thr) return false;
  return getDistance(myPlane.lat, myPlane.lon, thr.latitude, thr.longitude) <= radiusM;
}

function getAGLmeters(): number {
  const elevFromField =
    (airfield as any)?.elevation ??
    (runwayState?.airfield?.elevation ?? null);

  const altMSL = myPlane?.alt ?? 0;

  // Estimación actual de referencia de suelo
  const refExisting = elevFromField ?? groundRefAltMSLRef.current;
  const approxAGL =
    refExisting != null ? (altMSL - refExisting) : Number.POSITIVE_INFINITY;

  // Sólo recalibrar suelo si:
  //  - estamos sobre la pista en planta
  //  - velocidad baja
  //  - y YA estamos relativamente bajos (ej. < 60 m AGL)
  if (
    isOnRunwayStrip() &&
    (myPlane?.speed ?? 0) < 80 &&
    Math.abs(approxAGL) < 60
  ) {
    groundRefAltMSLRef.current = altMSL;
  }

  const ref = elevFromField ?? groundRefAltMSLRef.current;
  const agl = ref != null ? (altMSL - ref) : altMSL; // fallback: MSL si no hay ref

  return Math.max(0, agl);
}



function isStopped(): boolean {
  // velocidad del estado está en km/h
  return (myPlane?.speed ?? 0) < 5; // <5 km/h = detenido
}


// ETA a la cabecera activa (segundos), con penalidad por medio giro si venís por la opuesta
function etaToActiveThresholdSec(): number | null {
  if (!rw) return null;
  const end = rw.active_end === 'B' ? 'B' : 'A';
  const thr = end==='A' ? A_runway : B_runway;
  if (!thr) return null;
  const d = getDistance(myPlane.lat, myPlane.lon, thr.latitude, thr.longitude); // m
  const v = avgApproachSpeedMps(myPlane.speed, myPlane.type);
  if (!v) return null;

  // penalidad si estás más cerca del umbral opuesto
  const other = end==='A' ? B_runway : A_runway;
  let extra = 0;
  if (other) {
    const dOther = getDistance(myPlane.lat, myPlane.lon, other.latitude, other.longitude);
    if (dOther < d) {
      extra = Math.PI * halfTurnRadiusM(myPlane.type);
    }
  }
  return Math.round((d + extra) / v);
}

// banner 6s con anti-spam por key
function flashBanner(text: string, key?: string) {
  const now = Date.now();
  if (key) {
    const last = lastBannerAtRef.current[key] || 0;
    if (now - last < 2500) return; // no repetir en <2.5s
    lastBannerAtRef.current[key] = now;
  }
  setBanner({ text, key });
  setTimeout(() => setBanner(null), 6000);
}

// al tocar la pista/cabecera -> abrir label 6s y sugerir alineamiento si vienes por contraria
function showRunwayLabel(end:'A'|'B') {
  setRunwayTapEnd(end);
  setRunwayLabelUntil(Date.now() + 6000);
  socketRef.current?.emit('runway-get'); // refresco al abrir

  if (rw) {
    const active = rw.active_end === 'B' ? 'B' : 'A';
    const other = active==='A' ? 'B' : 'A';
    const nearOther = isNearThreshold(other as 'A'|'B', 500); // del lado opuesto
    if (nearOther) flashBanner('Por favor alinéese con la pista por la derecha', 'align-right');
  }
}

// --- PERMISO DE ATERRIZAJE SEGÚN DISTANCIA ---
type Cat = 'GLIDER_HELI' | 'PROP' | 'BIZJET' | 'AIRLINER';

function aircraftCategory(t?: string): Cat {
  const up = (t || '').toUpperCase();
  if (up.includes('GLIDER') || up.includes('PLANEADOR') || up.includes('HELI')) return 'GLIDER_HELI';
  // Airliners (heurística)
  if (
    up.includes('AIRBUS') || up.includes('BOEING') || up.includes('A3') || up.includes('B7') ||
    up.includes('E19') || up.includes('E17') || up.includes('E-JET') || up.includes('A32') || up.includes('A33')
  ) return 'AIRLINER';
  // Jets no comerciales (bizjets)
  if (up.includes('JET')) return 'BIZJET';
  // Turboprop y hélice
  if (up.includes('TURBOPROP') || up.includes('HELICES') || up.includes('HÉLICE') || up.includes('HÉLICE') || up.includes('PROP')) return 'PROP';
  return 'PROP';
}

// === GLIDE / PLANEADORES ===
const GLIDE_RATIO = 30;          // 30:1 → 30 m horizontales por 1 m de altura
const GLIDE_SAFETY = 0.8;        // margen de seguridad (solo usamos 80% del glide teórico)

type GlideClass = 'NO_REACH' | 'CRITICAL' | 'TIGHT' | 'COMFY';

function isGliderType(t?: string): boolean {
  const up = (t || '').toUpperCase();
  return up.includes('GLIDER') || up.includes('PLANEADOR') || up.includes('VENTUS') || up.includes('DISCUSS') || up.includes('ASW');
}

// Info de planeo para *mi* avión
function computeMyGlideInfo(): {
  aglM: number;
  dThrM: number | null;
  dMaxM: number;
  margin: number | null;
  klass: GlideClass;
} {
  const agl = getAGLmeters();
  const dThr = distToActiveThresholdM();
  const dMax = Math.max(0, agl * GLIDE_RATIO * GLIDE_SAFETY);

  if (!dThr || !Number.isFinite(dThr) || dMax <= 0) {
    return { aglM: agl, dThrM: dThr ?? null, dMaxM: dMax, margin: null, klass: 'NO_REACH' };
  }

  const margin = dThr / dMax;

  let klass: GlideClass;
  if (dThr > dMax) {
    klass = 'NO_REACH';
  } else if (margin > 0.7) {
    klass = 'CRITICAL';   // llega muy justo
  } else if (margin > 0.5) {
    klass = 'TIGHT';      // llega, pero sin tanto margen
  } else {
    klass = 'COMFY';      // llega sobrado
  }

  return { aglM: agl, dThrM: dThr, dMaxM: dMax, margin, klass };
}


// Distancias de permiso (en metros)
// (Si querés ajustar airliners, cambiá 8000 por el valor que prefieras)
const PERMIT_RADIUS_M: Record<Cat, number> = {
  GLIDER_HELI: 500,    // planeadores y helicópteros
  PROP:        2000,   // aviones a hélice
  BIZJET:      5000,   // jets no comerciales
  AIRLINER:    8000,   // línea (sugerencia)
};

  // ⬇️ PEGAR DEBAJO de const PERMIT_RADIUS_M
  const GROUND_OPS = new Set<OpsState>([
    'RUNWAY_CLEAR',
    'TAXI_APRON',
    'APRON_STOP',
    'RUNWAY_OCCUPIED',
    'TAXI_TO_RWY',
    'HOLD_SHORT'
  ]);


function iAmGroundish(): boolean {
  const ops = lastOpsStateRef.current as OpsState | null;
  if (ops && GROUND_OPS.has(ops)) return true;

  const agl = getAGLmeters();
  // Sólo considerar tierra por geometría de pista + AGL bajo
  if (isOnRunwayStrip() && agl < 30) return true;

  return false;
}



function getOpsOf(name: string): OpsState | null {
  // El backend manda un mapa opsStates opcional dentro de runwayState.state
  const map = (runwayState as any)?.state?.opsStates || {};
  const st = map?.[name];
  return (typeof st === 'string') ? (st as OpsState) : null;
}

function inferOpsForDisplay(p: Plane): OpsState | null {
  const fieldElev = (airfield as any)?.elevation ?? (runwayState?.airfield?.elevation ?? 0);
  const aglP = Math.max(0, (p.alt ?? 0) - fieldElev);
  const nearApron = apronDistanceM({ lat: p.lat, lon: p.lon }) <= 30;

  // Para "onRunway" sólo podemos inferirlo bien para MI avión
  const onRunwayApprox = isOnRunwayStrip() && p.id === (myPlane?.id || username);

  if (onRunwayApprox && aglP < 10) return 'RUNWAY_OCCUPIED';
  if (nearApron) return 'APRON_STOP';
  if (!onRunwayApprox && aglP < 30 && (p.speed ?? 0) >= 5) return 'TAXI_APRON';
  return null;
}


function distToActiveThresholdM(): number | null {
  if (!rw) return null;
  const end = rw.active_end === 'B' ? 'B' : 'A';
  const thr = end === 'A' ? A_runway : B_runway;
  if (!thr) return null;
  return getDistance(myPlane.lat, myPlane.lon, thr.latitude, thr.longitude); // metros
}


// === RUNWAY: acción por defecto según altura relativa ===
// Usamos function declaration para que se hoistee y pueda usarse antes.
function defaultActionForMe(): 'land' | 'takeoff' {
  const planeAlt = myPlane?.alt ?? 0;
  const fieldElev =
    (airfield as any)?.elevation ??
    (runwayState?.airfield?.elevation ?? 0); // si no hay, usamos 0
  const altRel = Math.max(0, planeAlt - fieldElev);
  return altRel > 10 ? 'land' : 'takeoff';
}


// === RUNWAY: pedidos al backend ===
const requestLanding = () => {
  const payload = {
    action: 'land',
    name: myPlane?.id || username,
    callsign: callsign || '',
    aircraft: aircraftModel || '',
    type: aircraftModel || '',
    emergency: !!(myPlane as any)?.emergency,
    altitude: myPlane?.alt ?? 0,
  };
  console.log('[RUNWAY] requestLanding →', payload);
  socketRef.current?.emit('runway-request', payload);
  socketRef.current?.emit('runway-get');
  setTimeout(() => socketRef.current?.emit('runway-get'), 300);
};

const requestTakeoff = (ready: boolean) => {
  const payload = {
    action: 'takeoff',
    name: myPlane?.id || username,
    callsign: callsign || '',
    aircraft: aircraftModel || '',
    type: aircraftModel || '',
    ready: !!ready,
  };
  console.log('[RUNWAY] requestTakeoff →', payload);
  socketRef.current?.emit('runway-request', payload);
  socketRef.current?.emit('runway-get');
  setTimeout(() => socketRef.current?.emit('runway-get'), 300);
};

const cancelMyRequest = () => {
  const payload = { name: myPlane?.id || username };
  console.log('[RUNWAY] cancel →', payload);
  socketRef.current?.emit('runway-cancel', payload);
  socketRef.current?.emit('runway-get');
};

const markRunwayOccupy = (action: 'landing' | 'takeoff' | any) => {
  socketRef.current?.emit('runway-occupy', {
    action,
    name: myPlane?.id || username,
    callsign: callsign || '',
  });
  socketRef.current?.emit('runway-get');
};

const markRunwayClear = () => {
  socketRef.current?.emit('runway-clear');
  socketRef.current?.emit('runway-get');
};


  // === RUNWAY: wrappers para setear flags y banners ===
  const requestLandingLabel = () => {
    // 🔓 soltar APRON al iniciar aproximación
    apronLatchRef.current = false;

    // “romper” cualquier pegajosidad de tierra por AGL ruidoso
    lastGroundSeenAtRef.current = 0;
    airborneCandidateSinceRef.current = Date.now();

    requestLanding();
    landingRequestedRef.current = true;
  };


const requestTakeoffLabel = () => {
  requestTakeoff(false);
  takeoffRequestedRef.current = true;
  flashBanner('Ir a cabecera de pista', 'go-threshold');
};

const cancelRunwayLabel = () => {
  cancelMyRequest();
  landingRequestedRef.current = false;
  takeoffRequestedRef.current = false;
};

// ---- Focus hook #1: registro de socket / tráfico al enfocar Radar
useFocusEffect(
  React.useCallback(() => {
    // al entrar a Radar
    isFocusedRef.current = true;

    // si ya tenemos socket y username, pedimos tráfico y nos registramos
    const s = socketRef.current;
    if (s) {
      if (!s.connected) s.connect(); // 🔌 asegurar conexión antes de emitir
      if (username) {
        s.emit('get-traffic');
        s.emit('airfield-get');// 👉 pedir pista actual al backend
        s.emit('runway-get'); // 👉 sincronizar estado de pista al conectar


        // envía un update inmediato con el nuevo id (username)
        s.emit('update', {
          name: username,
          latitude: myPlane.lat,
          longitude: myPlane.lon,
          alt: myPlane.alt,
          heading: myPlane.heading,
          type: aircraftModel,
          speed: myPlane.speed,
          callsign: callsign || '',
          aircraftIcon: aircraftIcon || '2.png',
          isMotorized: isMotorizedBool,   // 👈 aquí
        });
      }
    }

    // al salir de Radar
    return () => {
      isFocusedRef.current = false;
      // opcional: si querés “limpiar vista” solo localmente
      // setSelected(null); setConflict(null); setPrioritizedWarning(null);
      // (NO borres traffic/planes acá; eso ya lo maneja el backend con remove-user)
    };
  }, [
    username,
    myPlane.lat,
    myPlane.lon,
    myPlane.alt,
    myPlane.heading,
    myPlane.speed,
    aircraftModel,
    aircraftIcon,
    callsign,
  ])
);

// ---- Focus hook #2: leer airfieldActive (pista) al enfocar Radar
useFocusEffect(
  React.useCallback(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('airfieldActive');
        if (!cancelled && raw) {
          const af: Airfield = JSON.parse(raw);
          setAirfield(af);
          // 👇 reenvía la pista activa al backend si hay socket conectado
          const s = socketRef.current;
          if (s && (s as any).connected) {
            s.emit('airfield-upsert', { airfield: af });
          }

        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [])
);



const toggleFollowMe = () => setFollowMe(prev => !prev);
const hasWarning = !!(prioritizedWarning || selected || conflict);

const getDistanceTo = (plane: Plane): number => {
  if (
    plane?.lat == null || plane?.lon == null ||
    myPlane?.lat == null || myPlane?.lon == null
  ) {
    return NaN;
  }
  return getDistance(myPlane.lat, myPlane.lon, plane.lat, plane.lon);
};

const blockUpdateUntil = useRef<number>(0);

useEffect(() => {
  if (!myPlane) return;

  const trafficWithoutMe = traffic.filter(p => p.id !== myPlane.id);
  if (trafficWithoutMe.length === 0) {
    setPlanes([]);
    return;
  }

  const timeSteps = Array.from({ length: 36 }, (_, i) => (i + 1) * 5);
  let selectedConflict: Plane | null = null;
  let selectedConflictLevel: 'RA_HIGH' | 'RA_LOW' | undefined = undefined;

  let minTimeToImpact = Infinity;
  let bestTA: {
    plane: Plane;
    distance: number;
    tauSec: number;
    score: number;
  } | null = null;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const angleBetween = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  };
  const angleDiff = (a: number, b: number) => {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  };

  // Guard: si ya estoy en tierra/taxi, no calcules TA/RA y limpia UI
  {
    const myOps = lastOpsStateRef.current as OpsState | null;
    if (myOps && GROUND_OPS.has(myOps)) {
      if (prioritizedWarning) setPrioritizedWarning(null);
      if (conflict) setConflict(null);
      if (selected) setSelected(null);
      setPlanes(prev =>
        prev.map(p => ({ ...p, alertLevel: 'none', timeToImpact: undefined }))
      );
      return;
    }
  }

  for (const plane of trafficWithoutMe) {
    const distanceNow = getDistance(myPlane.lat, myPlane.lon, plane.lat, plane.lon);

    // ⛔️ No consideres TA/RA contra aviones que ya están fuera de pista (en tierra)
    const otherOps = getOpsOf(plane.id);
    if (otherOps && GROUND_OPS.has(otherOps)) {
      continue;
    }

    // === TA: tráfico cercano con prioridad tipo TCAS ===
    {
      const myAgl = getAGLmeters();
      const otherOps2 = getOpsOf(plane.id);
      const otherIsGround = otherOps2 && GROUND_OPS.has(otherOps2);

      const fieldElev =
        (airfield as any)?.elevation ?? (runwayState?.airfield?.elevation ?? 0);
      const otherAgl = Math.max(0, (plane.alt ?? 0) - fieldElev);

      const vertSep = Math.abs((plane.alt ?? 0) - (myPlane.alt ?? 0));
      const hyperClose = distanceNow <= TA_HYPER_M;
      const withinVertical = vertSep <= TA_VSEP_MAX_M;

      // Estimación de tau (tiempo hasta mínima distancia) usando las mismas muestras que RA
      const futureDistancesTA: number[] = [];
      for (const t of timeSteps) {
        const myF = getFuturePosition(
          myPlane.lat,
          myPlane.lon,
          myPlane.heading,
          myPlane.speed,
          t
        );
        const thF = getFuturePosition(
          plane.lat,
          plane.lon,
          plane.heading || 0,
          plane.speed || 0,
          t
        );
        futureDistancesTA.push(
          getDistance(myF.latitude, myF.longitude, thF.latitude, thF.longitude)
        );
      }
      const minDistTA = Math.min(...futureDistancesTA);
      const idxMinTA  = futureDistancesTA.indexOf(minDistTA);
      const tauSec    = timeSteps[idxMinTA]; // tiempo hasta la mínima separación

      const distance5s = futureDistancesTA[0] ?? distanceNow;
      const approaching = distance5s < (distanceNow - 15); // se acerca si en 5s está sensiblemente más cerca

      // Condición de TA: en rango, separación vertical razonable y ambos "en vuelo"
      const TAeligible =
        distanceNow < TA_RADIUS_M &&
        withinVertical &&
        (plane.speed ?? 0) > 30 &&
        myAgl > 50 &&                  // yo "en vuelo"
        !otherIsGround &&              // el otro no marcado en tierra
        (otherOps2 ? true : otherAgl > 50); // si no hay ops, exigimos también AGL>50 m

      // Sólo consideramos:
      // - los que se acercan, o
      // - los hiper-cercanos (< TA_HYPER_M) aunque se alejen
      if (TAeligible && (approaching || hyperClose)) {
        let score =
          (TA_RADIUS_M - distanceNow) * 1.2 +   // más cerca = más prioridad
          (approaching ? 800 : -200);           // bonus si se acerca

        if (Number.isFinite(tauSec) && tauSec > 0) {
          score += (1 / tauSec) * 200_000;      // tau chico = mucha prioridad
        }

        if (hyperClose) {
          score += 1_000_000;                   // hiper-cercanía domina la lista
        }

        if (!bestTA || score > bestTA.score) {
          bestTA = {
            plane,
            distance: distanceNow,
            tauSec: tauSec ?? Infinity,
            score,
          };
        }
      }
    }

// === RA: trayectorias convergentes (versión “vieja buena”) ===
    // === RA: trayectorias convergentes (corregido) ===

    // 1) Distancia futura en 5..180 s
    const futureDistances: number[] = [];
    for (const t of timeSteps) {
      const myF = getFuturePosition(
        myPlane.lat,
        myPlane.lon,
        myPlane.heading,
        myPlane.speed,
        t
      );
      const thF = getFuturePosition(
        plane.lat,
        plane.lon,
        plane.heading || 0,
        plane.speed || 0,
        t
      );
      futureDistances.push(
        getDistance(myF.latitude, myF.longitude, thF.latitude, thF.longitude)
      );
    }

    const minDistance = Math.min(...futureDistances);
    const idxMin      = futureDistances.indexOf(minDistance);
    const timeOfMin   = timeSteps[idxMin];

    const futureAltDelta = Math.abs((myPlane.alt ?? 0) - (plane.alt ?? 0));

    // 2) “Acercamiento” simple: distancia a 5s menor que ahora
    const currentDistance = getDistance(
      myPlane.lat,
      myPlane.lon,
      plane.lat,
      plane.lon
    );
    const distance5s  = futureDistances[0] ?? distanceNow;
    const closingSoon = distance5s < (distanceNow - 15); // 👉 solo si se ACERCA

    // 3) Cono de RA: bearing ahora y en el punto de mínimo
    const bearingDeg = (lat1: number, lon1: number, lat2: number, lon2: number) => {
      const dLon = toRad(lon2 - lon1);
      const y = Math.sin(dLon) * Math.cos(toRad(lat2));
      const x =
        Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
      const b = (Math.atan2(y, x) * 180) / Math.PI;
      return (b + 360) % 360;
    };

    const myAtMin    = getFuturePosition(
      myPlane.lat,
      myPlane.lon,
      myPlane.heading,
      myPlane.speed,
      timeOfMin
    );
    const theirAtMin = getFuturePosition(
      plane.lat,
      plane.lon,
      plane.heading || 0,
      plane.speed || 0,
      timeOfMin
    );

    const diffNow = (() => {
      const bNow = bearingDeg(myPlane.lat, myPlane.lon, plane.lat, plane.lon);
      const d = Math.abs(((myPlane.heading - bNow + 540) % 360) - 180);
      return d;
    })();

    const diffAtMin = (() => {
      const bMin = bearingDeg(
        myAtMin.latitude,
        myAtMin.longitude,
        theirAtMin.latitude,
        theirAtMin.longitude
      );
      const d = Math.abs(((myPlane.heading - bMin + 540) % 360) - 180);
      return d;
    })();

    // 👉 Cono frontal (ej. RA_CONE_DEG = 25)
    const withinCone = diffNow <= RA_CONE_DEG || diffAtMin <= RA_CONE_DEG;

    // 4) Criterio RA final (idéntico al viejo)
    if (
      minDistance < RA_MIN_DIST_M &&
      futureAltDelta <= RA_VSEP_MAX_M &&
      closingSoon &&          // 👈 clave: solo si en 5 s está más cerca
      withinCone              // 👈 y solo si entra en el cono frontal
    ) {
      if (timeOfMin < RA_HIGH_TTI_S && timeOfMin < minTimeToImpact) {
        selectedConflict = plane;
        selectedConflictLevel = 'RA_HIGH';
        minTimeToImpact = timeOfMin;
      } else if (
        timeOfMin < RA_LOW_TTI_S &&
        selectedConflictLevel !== 'RA_HIGH'
      ) {
        selectedConflict = plane;
        selectedConflictLevel = 'RA_LOW';
        minTimeToImpact = timeOfMin;
      }
    }
    // 👇 OJO: NO pongas aquí una llave de cierre extra; el for sigue después
    // y justo después de esto va:
    // lastDistanceRef.current[plane.id] = currentDistance;

  // 🟢 Guardar distancia actual para comparación en el próximo tick
  lastDistanceRef.current[plane.id] = currentDistance;
}

  let nuevoWarningLocal: Warning | null = null;

  if (selectedConflict && selectedConflictLevel) {
    setConflict({
      ...selectedConflict,
      alertLevel: selectedConflictLevel,
      timeToImpact: minTimeToImpact,
    });
    setSelected({
      ...selectedConflict,
      alertLevel: selectedConflictLevel,
      timeToImpact: minTimeToImpact,
    });

    const distSel = getDistance(
      myPlane.lat,
      myPlane.lon,
      selectedConflict.lat,
      selectedConflict.lon
    );

    nuevoWarningLocal = {
      id: selectedConflict.id,
      name: selectedConflict.name,
      lat: selectedConflict.lat,
      lon: selectedConflict.lon,
      alt: selectedConflict.alt,
      heading: selectedConflict.heading,
      speed: selectedConflict.speed,
      alertLevel: selectedConflictLevel,
      timeToImpact: minTimeToImpact,
      distanceMeters: distSel,
      type: selectedConflict.type,
      aircraftIcon: selectedConflict.aircraftIcon || '2.png',
      callsign: selectedConflict.callsign || '',
    };
  } else if (bestTA) {
    const p = bestTA.plane;
    setSelected({ ...p, alertLevel: 'TA' as 'TA' });
    setConflict(null);

    const distTa = bestTA.distance;
    const ttiTa  = Number.isFinite(bestTA.tauSec) ? bestTA.tauSec : undefined;

    nuevoWarningLocal = {
      id: p.id,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      alt: p.alt,
      heading: p.heading,
      speed: p.speed,
      alertLevel: 'TA',
      timeToImpact: ttiTa,
      distanceMeters: distTa,
      type: p.type,
      aircraftIcon: p.aircraftIcon || '2.png',
      callsign: p.callsign || '',
    };
  } else {
    setConflict(null);
    setSelected(prev =>
      Date.now() < selectedHoldUntilRef.current ? prev : null
    );
  }

    setLocalWarning(nuevoWarningLocal);

  // === Ciclo de vida del RA emitido por ESTE avión ===
  {
    const prevId =
      activeRAIdRef.current; // avión contra el que yo estaba emitiendo RA antes

    const currentId =
      nuevoWarningLocal &&
      (nuevoWarningLocal.alertLevel === 'RA_LOW' ||
       nuevoWarningLocal.alertLevel === 'RA_HIGH')
        ? nuevoWarningLocal.id
        : null;

    // Si antes había RA y ahora cambió de avión o desapareció → warning-clear
    if (prevId && prevId !== currentId) {
      try {
        socketRef.current?.emit('warning-clear', { id: prevId });
        console.log('[RA] warning-clear emitido para', prevId);
      } catch (e) {
        console.warn('[RA] error emitiendo warning-clear', e);
      }
    }

    // Actualizar el RA activo (o null si ya no hay RA)
    activeRAIdRef.current = currentId;
  }

  // ⬇️ recordar el último RA local (opcional, si aún lo querés)
  if (
    nuevoWarningLocal &&
    (nuevoWarningLocal.alertLevel === 'RA_LOW' || nuevoWarningLocal.alertLevel === 'RA_HIGH')
  ) {
    lastRAIdRef.current = nuevoWarningLocal.id;
  }

  // ⬇️ salir si está corriendo el hold de RA o el bloqueador temporal
  if (holdTimerRef.current || Date.now() < blockUpdateUntil.current) return;


  // ⬇️ recordar el último RA local
    // ⬇️ recordar el último RA local
    if (
      nuevoWarningLocal &&
      (nuevoWarningLocal.alertLevel === 'RA_LOW' || nuevoWarningLocal.alertLevel === 'RA_HIGH')
    ) {
      lastRAIdRef.current = nuevoWarningLocal.id;
    }

    // ⬇️ salir si está corriendo el hold de RA o el bloqueador temporal
    if (holdTimerRef.current || Date.now() < blockUpdateUntil.current) return;

    // ⬇️ evita re-mostrar el mismo avión mientras dura el snooze
    const candId = (nuevoWarningLocal?.id) || (backendWarning?.id);
    if (snoozeIdRef.current && Date.now() < snoozeUntilRef.current && candId === snoozeIdRef.current) {
      return;
    }

    // 🟥 PRIORIDAD: si ya tengo un RA en hold, un TA NO puede pisarlo
    if (
      holdTimerRef.current &&                     // hay hold activo
      prioritizedWarning &&                       // hay algo en pantalla
      (prioritizedWarning.alertLevel === 'RA_LOW' ||
       prioritizedWarning.alertLevel === 'RA_HIGH')
    ) {
      // Solo permitimos reemplazarlo por otro RA, nunca por TA
      const candidato = nuevoWarningLocal || backendWarning;
      const candidatoEsRA =
        candidato &&
        (candidato.alertLevel === 'RA_LOW' || candidato.alertLevel === 'RA_HIGH');

      if (!candidatoEsRA) {
        // candidato es TA (o nada) → NO tocar el RA actual
        return;
      }
    }

    const prioridades = { RA_HIGH: 3, RA_LOW: 2, TA: 1 };


  // Si no hay warnings, limpiamos
  if (!nuevoWarningLocal && !backendWarning) {
    setPrioritizedWarning(null);
    // ⚠️ Aun así actualizamos los planes visualmente con alertLevel 'none'
  } else if (nuevoWarningLocal && !backendWarning) {
    // Solo local
    if (nuevoWarningLocal.alertLevel === 'TA') {
      setPrioritizedWarning(nuevoWarningLocal);
      maybeEmitWarning(nuevoWarningLocal);
    } else {
      if (holdTimerRef.current && nuevoWarningLocal.alertLevel.startsWith('RA')) {
        // no pisar RA en hold
      } else {
        setPrioritizedWarning(nuevoWarningLocal);
        maybeEmitWarning(nuevoWarningLocal);
      }
    }
  } else if (!nuevoWarningLocal && backendWarning) {
    // Solo backend
    if (backendWarning.alertLevel === 'TA') {
      setPrioritizedWarning(backendWarning);
      maybeEmitWarning(backendWarning);
    } else {
      if (holdTimerRef.current && backendWarning.alertLevel.startsWith('RA')) {
        // no pisar RA en hold
      } else {
        setPrioritizedWarning(backendWarning);
        maybeEmitWarning(backendWarning);
      }
    }
  } else if (nuevoWarningLocal && backendWarning) {
    // 🚫 Silenciar TA/RA cuando ya liberé pista o estoy taxiando
    {
      const ops = lastOpsStateRef.current as OpsState | null;
      if (ops && GROUND_OPS.has(ops)) {
        if (prioritizedWarning) setPrioritizedWarning(null);
        if (conflict) setConflict(null);
        if (selected) setSelected(null);
        // igual después actualizamos planes
      }
    }

    // Si llegamos aquí, ambos existen
    const localPriority = prioridades[nuevoWarningLocal!.alertLevel];
    const backendPriority = prioridades[backendWarning!.alertLevel];

    if (localPriority > backendPriority) {
      // Gana el LOCAL → sí emitimos (respetando hold/TA)
      if (nuevoWarningLocal!.alertLevel === 'TA' || !holdTimerRef.current) {
        setPrioritizedWarning(nuevoWarningLocal!);
        maybeEmitWarning(nuevoWarningLocal!);
      }
    } else if (backendPriority > localPriority) {
      // Gana el BACKEND → NO re-emitir
      if (backendWarning!.alertLevel === 'TA' || !holdTimerRef.current) {
        setPrioritizedWarning(backendWarning!);
        // (no maybeEmitWarning aquí)
      }
    } else {
      // Empate: decidir por menor TTI y solo emitir si el ganador es local
      const localTime   = nuevoWarningLocal!.timeToImpact || Infinity;
      const backendTime = backendWarning!.timeToImpact || Infinity;
      const ganador = localTime < backendTime ? nuevoWarningLocal! : backendWarning!;

      if (ganador.alertLevel === 'TA' || !holdTimerRef.current) {
        if (ganador === backendWarning) {
          setPrioritizedWarning(ganador);           // NO re-emitir
        } else {
          setPrioritizedWarning(ganador);           // Sí emitir si ganó el local
          maybeEmitWarning(ganador);
        }
      }
    }
  }

  // === ACTUALIZACIÓN VISUAL: traffic (backend) → planes (mapa) ===
  const taPlaneId = bestTA?.plane.id ?? null;

  const updatedTraffic: Plane[] = trafficWithoutMe.map((plane) => {
    let alertLevel: Plane['alertLevel'] = 'none';
    let timeToImpact: number | undefined = undefined;

    // RA local
    if (selectedConflict && selectedConflictLevel && plane.id === selectedConflict.id) {
      alertLevel = selectedConflictLevel;
      timeToImpact = minTimeToImpact;
    }
    // TA local elegido (bestTA)
    else if (taPlaneId && plane.id === taPlaneId) {
      alertLevel = 'TA';
      timeToImpact =
        bestTA && Number.isFinite(bestTA.tauSec) ? bestTA.tauSec : undefined;
    }
    // RA/TA que vienen del backend para ese avión (si no hay override local)
    else if (backendWarning && plane.id === backendWarning.id) {
      const lvl = backendWarning.alertLevel;
      if (lvl === 'RA_HIGH' || lvl === 'RA_LOW' || lvl === 'TA') {
        alertLevel = lvl;
        timeToImpact = backendWarning.timeToImpact;
      }
    }

    return {
      ...plane,
      alertLevel,
      timeToImpact,
    };
  });

  setPlanes(updatedTraffic);
}, [traffic, myPlane, backendWarning]);


  useEffect(() => {
    if (!username) return;

    socketRef.current = socket;
    const s = socketRef.current;
    // Si el socket está desconectado (porque saliste de Radar antes), reconectalo
    if (s && !s.connected) {
      s.connect();
    }


    s.on('connect', async () => {
      console.log('🔌 Conectado al servidor WebSocket');
      s.emit('get-traffic');
      s.emit('airfield-get');
      s.emit('runway-get');

      // === NUEVO: secuencia y beacons desde el backend
      s.on('sequence-update', (msg: any) => {
        try {
          if (Array.isArray(msg?.slots)) setSlots(msg.slots);
          // Si el backend manda beacons, podés pintarlos aquí también:
          // const b1 = msg?.beacons?.B1; const b2 = msg?.beacons?.B2;
          // (si querés mostrarlos, convertí a {latitude,longitude} y dibujalos)
        } catch {}
      });

      // === NUEVO: instrucciones dirigidas (ATC) ===
s.on('atc-instruction', (instr: any) => {
  serverATCRef.current ||= true;
  if (!instr?.type) return;

  // ¿Soy planeador?
  const modelStr = aircraftModel || (myPlane as any)?.type || '';
  const iAmGlider = !isMotorizedBool || isGliderType(modelStr);

  // Para planeadores: ignorar instrucciones de beacons de avión
  if (iAmGlider) {
    if (instr.type === 'goto-beacon' || instr.type === 'turn-to-B1') {
      // no cambiamos navTarget, sólo podemos dejar texto/voz si quisieras
      return;
    }

    if (instr.type === 'cleared-to-land') {
      // Autorización a aterrizar sí la anunciamos, pero sin tocar navTarget
      const msg =
        (instr.text || 'Autorizado a aterrizar') +
        (instr.rwy ? ` pista ${instr.rwy}` : '');
      flashBanner(msg, 'atc-clr');
      try {
        Speech.stop();
        Speech.speak(msg, { language: 'es-ES' });
      } catch {}
      return;
    }
  }

  // ✈️ Aviones a motor: comportamiento actual
  if (
    instr.type === 'goto-beacon' &&
    typeof instr.lat === 'number' &&
    typeof instr.lon === 'number'
  ) {
    setNavTarget({ latitude: instr.lat, longitude: instr.lon });
    flashBanner(instr.text || 'Proceda al beacon', 'atc-goto');
    try {
      Speech.stop();
      Speech.speak('Proceda al beacon', { language: 'es-ES' });
    } catch {}
  }

  if (instr.type === 'turn-to-B1') {
    flashBanner(instr.text || 'Vire hacia B1', 'atc-b1');
    try {
      Speech.stop();
      Speech.speak('Vire hacia be uno', { language: 'es-ES' });
    } catch {}
  }

  if (instr.type === 'cleared-to-land') {
    const msg =
      (instr.text || 'Autorizado a aterrizar') +
      (instr.rwy ? ` pista ${instr.rwy}` : '');
    flashBanner(msg, 'atc-clr');
    try {
      Speech.stop();
      Speech.speak(msg, { language: 'es-ES' });
    } catch {}
  }
});



      // 👇 si el server no tiene pista cargada, reinyectala desde AsyncStorage
      try {
        const raw = await AsyncStorage.getItem('airfieldActive');
        if (raw) {
          const af = JSON.parse(raw);
          s.emit('airfield-upsert', { airfield: af });
        }
      } catch {}
    });


s.on('conflicto', (data: any) => {
  console.log('⚠️ Conflicto recibido vía WebSocket:', data);

  const me = myPlane?.id || username;

  // 1) Detectar si es RA
  const isRAEvent =
    data.alertLevel === 'RA_HIGH' ||
    data.alertLevel === 'RA_LOW' ||
    data.type === 'RA';

  const from = String(data.from || '');
  const to   = String(data.to   || '');

  // 2) Si es RA y yo no soy ni from ni to → ignorar
  if (isRAEvent && from && to && from !== me && to !== me) {
    return;
  }

  // 3) Si YO estoy en tierra/pista, ignorar conflictos entrantes
  if (iAmGroundish()) {
    return;
  }

  // 4) Si el otro ya está en RUNWAY_CLEAR / TAXI_APRON / APRON_STOP, ignorá el conflicto
  const otherNameRaw = String(data?.id || data?.name || '');
  if (otherNameRaw) {
    const otherOps = getOpsOf(otherNameRaw);
    if (otherOps && GROUND_OPS.has(otherOps)) {
      clearWarningFor(otherNameRaw);
      setBackendWarning(prev => (prev && prev.id === otherNameRaw) ? null : prev);
      setPrioritizedWarning(prev => (prev && prev.id === otherNameRaw) ? null : prev);
      return;
    }
  }

  // 5) Determinar quién es "el otro" avión del par
  const otherId =
    from && to
      ? (from === me ? to : (to === me ? from : null))
      : null;

  // 6) Buscar en planes usando preferentemente otherId
  const match =
    planes.find(p =>
      (otherId && p.id === otherId) ||
      p.id === data.id ||
      p.id === data.name ||
      p.name === data.name
    ) || null;

  const effectiveId = String(otherId || match?.id || data.id || data.name || '');

  const distNow =
    typeof data.distanceMeters === 'number' ? data.distanceMeters :
    typeof data.distance === 'number'       ? data.distance :
    (match && myPlane
      ? getDistance(myPlane.lat, myPlane.lon, match.lat, match.lon)
      : NaN);

  if (match && effectiveId) {
    backendDistanceRef.current[effectiveId] = distNow;
  }

  // Si la tarjeta pinneada es este mismo avión, refrescá la distancia
  setPrioritizedWarning(prev =>
    prev && prev.id === effectiveId
      ? { ...prev, distanceMeters: distNow }
      : prev
  );

  const level =
    (data.alertLevel === 'RA_HIGH' || data.alertLevel === 'RA_LOW' || data.alertLevel === 'TA')
      ? data.alertLevel
      : (data.type === 'RA' ? 'RA_LOW' : 'TA');

  // ID para hold por RA
  if (level === 'RA_LOW' || level === 'RA_HIGH') {
    raHoldUntilRef.current[effectiveId] = Date.now() + 6000;
  }

  const enrichedWarning: Warning = {
    id: effectiveId,
    name: match?.name ?? effectiveId,
    lat: match?.lat ?? data.lat,
    lon: match?.lon ?? data.lon,
    alt: match?.alt ?? data.alt,
    heading: match?.heading ?? data.heading,
    speed: match?.speed ?? data.speed,
    alertLevel: level,
    timeToImpact: typeof data.timeToImpact === 'number' ? data.timeToImpact : 999,
    distanceMeters: distNow,
    aircraftIcon: match?.aircraftIcon ?? data.aircraftIcon ?? '2.png',
    callsign: match?.callsign ?? data.callsign ?? '',
    type: match?.type ?? data.type,
  };

  setWarnings(prev => ({ ...prev, [enrichedWarning.id]: enrichedWarning }));
  setBackendWarning(enrichedWarning);

  // TTL backendWarning (esto lo dejas igual que ya tenías)
  const BW_TTL_MS = 4000;
  if ((s as any).__bwTtlTimer) clearTimeout((s as any).__bwTtlTimer);
  (s as any).__bwTtlTimer = setTimeout(() => {
    const holdUntil = raHoldUntilRef.current[effectiveId] ?? 0;
    if (Date.now() < holdUntil) return;

    setBackendWarning(prev => (prev && prev.id === effectiveId) ? null : prev);
    setPrioritizedWarning(prev => (prev && prev.id === effectiveId) ? null : prev);
  }, BW_TTL_MS);
});


  // ⬇️ PEGAR ESTO JUSTO AQUÍ
  s.on('conflicto-clear', (msg: any) => {
    const id = String(msg?.id || '');
    if (!id) return;
    clearWarningFor(id);
    setBackendWarning(prev => (prev && prev.id === id) ? null : prev);
    setPrioritizedWarning(prev => (prev && prev.id === id) ? null : prev);
  });




    s.on('traffic-update', (data: any) => {
      if (Array.isArray(data)) {
        console.log('✈️ Tráfico recibido:', data);

        setTraffic(() => {
          // ids presentes en este batch
          const ids = new Set<string>(data.map((t: any) => String(t.name)));

          // 1) si el priorizado ya no está, limpiar tarjeta
          setPrioritizedWarning(prev => {
            if (prev && !ids.has(prev.id)) {
              // si el avión que estaba priorizado ya no está, limpiamos el bloqueo de envío
              if (lastWarningTimeRef.current[prev.id]) {
                delete lastWarningTimeRef.current[prev.id];
              }
              return null;
            }
            return prev;
          });


          // 2) podar selected/conflict si desaparecieron
          setSelected(prev => (prev && !ids.has(prev.id) ? null : prev));
          setConflict(prev => (prev && !ids.has(prev.id) ? null : prev));

          // 3) podar warnings que ya no correspondan a ningún id presente
          setWarnings(prev => {
            const next: { [k: string]: Warning } = {};
            for (const [id, w] of Object.entries(prev)) {
              if (ids.has(id)) next[id] = w;
            }
            return next;
          });

          // 4) devolver el nuevo tráfico normalizado
          return data.map((info: any) => ({
            id: info.name,
            name: info.name,
            lat: info.lat,
            lon: info.lon,
            alt: info.alt,
            heading: info.heading,
            speed: info.speed,
            type: info.type,
            callsign: info.callsign,
            aircraftIcon: info.aircraftIcon || '2.png',
          }));
        });
      }
    });




    // ✅ NUEVO: tráfico inicial al entrar (mapea latitude/longitude)
    s.on('initial-traffic', (data: any) => {
      if (Array.isArray(data)) {
        console.log('📦 initial-traffic:', data);
        setTraffic(data.map((info: any) => ({
          id: info.name,
          name: info.name,
          // initial-traffic viene con latitude/longitude (del backend)
          lat: typeof info.lat === 'number' ? info.lat : info.latitude,
          lon: typeof info.lon === 'number' ? info.lon : info.longitude,
          alt: info.alt,
          heading: info.heading,
          speed: info.speed,
          type: info.type,
          callsign: info.callsign,
          aircraftIcon: info.aircraftIcon || info.icon || '2.png',
        })));
      }
    });

    // 👉 actualizar airfield en tiempo real
    s.on('airfield-update', async ({ airfield: af }: { airfield: Airfield }) => {
      try {
        setAirfield(af);
        await AsyncStorage.setItem('airfieldActive', JSON.stringify(af));
      } catch {}
    });

    // --- RUNWAY: estado de pista en tiempo real ---
    s.on('runway-state', (payload: any) => {
      try { console.log('[RUNWAY] state ←', JSON.stringify(payload)); } catch {}
      setRunwayState(payload);
    });


    // Banner de turno + VOZ (6 s con anti-spam)
    s.on('runway-msg', (m: any) => {
      if (!m?.text) return;

      // 1) Banner en UI
      flashBanner(m.text, `srv:${m.key || m.text}`);

      // 2) Texto a voz (castellano). Ej: “#3” -> “número 3”
      try {
        const spoken = String(m.text)
          .replace(/#\s*(\d+)/g, 'número $1')
          .replace(/^Tu /i, 'Su ');
        Speech.stop();
        Speech.speak(spoken, { language: 'es-ES', rate: 1.0, pitch: 1.0 });
      } catch {}
    });




    // 👇 NUEVO: si otro usuario se desconecta, eliminamos su avión
    s.on('user-removed', (name: string) => {
      console.log('🗑️ user-removed:', name);
      setTraffic(prev => prev.filter(p => p.id !== name));
      setPlanes(prev => prev.filter(p => p.id !== name));

      // 💥 limpiar warnings/selecciones si apuntaban al eliminado
      setWarnings(prev => {
        const copy = { ...prev };
        delete copy[name];
        return copy;
      });
      setPrioritizedWarning(prev => (prev?.id === name ? null : prev));
      setSelected(prev => (prev?.id === name ? null : prev));
      setConflict(prev => (prev?.id === name ? null : prev));

      // (opcional) limpiar distancia cacheada
      // ⬇️ ver 2.b para poder usar lastDistanceRef acá
      try { delete lastDistanceRef.current[name]; } catch (_) {}
    });



    s.on('disconnect', () => {
      console.log('🔌 Desconectado del WebSocket');
      serverATCRef.current = false; // si perdemos ATC servidor, reactivamos guía local

    });

    let intervalId: NodeJS.Timeout;

    intervalId = setInterval(async () => {
      let data;

    if (simMode) {
      setMyPlane(prev => {
        // prev.speed está en km/h -> convertir a m/s para 1 segundo de paso
        const v_ms = (prev.speed * 1000) / 3600;
        const distanceMeters = v_ms * 1; // 1s por tick

        const deltaLat =
          (distanceMeters / 111320) * Math.cos((prev.heading * Math.PI) / 180);

        const metersPerDegLon =
          40075000 * Math.cos((prev.lat * Math.PI) / 180) / 360;

        const deltaLon =
          (distanceMeters / metersPerDegLon) *
          Math.sin((prev.heading * Math.PI) / 180);

        const newLat = prev.lat + deltaLat;
        const newLon = prev.lon + deltaLon;

        const glide = computeMyGlideInfo();

        const data = {
          name: username,
          latitude: newLat,
          longitude: newLon,
          alt: prev.alt,
          heading: prev.heading,
          type: aircraftModel,
          speed: prev.speed,              // km/h
          callsign: callsign || '',
          aircraftIcon: aircraftIcon || '2.png',
          aglM: glide.aglM,
          glideMaxM: glide.dMaxM,
          glideMargin: glide.margin,
          glideClass: glide.klass,
          isMotorized: isMotorizedBool,

        };


        s.emit('update', data);

        return { ...prev, lat: newLat, lon: newLon };
      });
    } else {
      (async () => {
        try {
          const { coords } = await Location.getCurrentPositionAsync({});
          const speedKmh = coords.speed ? coords.speed * 3.6 : 0;

          const glide = computeMyGlideInfo();

          const data = {
            name: username,
            latitude: coords.latitude,
            longitude: coords.longitude,
            alt: coords.altitude || 0,
            heading: coords.heading || 0,
            type: aircraftModel,
            speed: speedKmh,
            callsign,
            aircraftIcon: aircraftIcon || '2.png',
            aglM: glide.aglM,
            glideMaxM: glide.dMaxM,
            glideMargin: glide.margin,
            glideClass: glide.klass,
            isMotorized: isMotorizedBool,

          };


          s.emit('update', data);

          setMyPlane(prev => ({
            ...prev,
            lat: coords.latitude,
            lon: coords.longitude,
            alt: coords.altitude || 0,
            heading: coords.heading || 0,
            speed: speedKmh, // km/h en estado
            
          }));
        } catch (err) {
          console.warn('📍 Error obteniendo ubicación:', err);
        }
      })();
    }

    // 🔹 refrescar la distancia en vivo del warning “pinneado”
    refreshPinnedDistance();

      // ==== OPS STATE EMITTER (front = fuente de verdad) ====
  (() => {
    const now = Date.now();

    // Señales de contexto
    const agl = getAGLmeters();              // m sobre aeródromo
    // ⚠️ NO me digas “sobre pista” si estoy por encima de 10 m AGL
    const onRunway = isOnRunwayStrip() && agl < 10;
    const activeEnd = rw?.active_end === 'B' ? 'B' : 'A';
    const nearHold = isNearThreshold(activeEnd as 'A'|'B', 100); // 100 m cabecera activa
    const stopped  = isStopped();
    const speedKmh = myPlane?.speed ?? 0;


          // ⛳️ Si tengo latch hacia APRON y no estoy en pista, me mantengo en tierra
      if (apronLatchRef.current && !onRunway) {
        const forced: OpsState = stopped ? 'APRON_STOP' : 'TAXI_APRON';
        if (lastOpsStateRef.current !== forced) {
          lastOpsStateRef.current = forced;
          lastOpsStateTsRef.current = now;
          socketRef.current?.emit('ops/state', {
            name: username,
            state: forced,
            aux: {
              airportId: (airfield as any)?.icao || (airfield as any)?.id || (airfield as any)?.name || '',
              rwyIdent: activeIdent ?? (rw?.identA ?? rw?.identB ?? ''),
              aglM: agl,
              onRunway,
              nearHoldShort: nearHold,
            }
          });
          console.log('[OPS] Forced by APRON latch →', forced);
        }
        return; // 📌 No dejamos que este tick evalúe “AIRBORNE”
      }


        // --- Gating de AIRBORNE / FINAL por AGL ruidoso (pegajosidad de tierra) ---
   
    const fastEnough = speedKmh >= TOUCHGO_MIN_SPEED_KMH;

    // 1) Si estoy en pista o muy bajo o muy lento → registro “vi tierra recién”
    if (onRunway || agl < (TOUCHGO_AGL_M / 2) || speedKmh < 10) {
      lastGroundSeenAtRef.current = now;
    }

    // 2) “Candidato a vuelo”: sólo si estoy fuera de pista, rápido y AGL supera umbral
    if (!onRunway && fastEnough && agl > TOUCHGO_AGL_M) {
      if (!airborneCandidateSinceRef.current) {
        airborneCandidateSinceRef.current = now;
      }
    } else {
      // reset por histéresis: si bajo mucho, vuelvo a pista o me quedo lento
      if (agl < (TOUCHGO_AGL_M / 2) || onRunway || speedKmh < 40) {
        airborneCandidateSinceRef.current = null;
      }
    }

    // 3) Ventana OK para “de verdad” estar volando
    const airborneWindowOk =
      airborneCandidateSinceRef.current != null &&
      (now - airborneCandidateSinceRef.current) >= TOUCHGO_HYST_MS;

    // 4) Pegajosidad de tierra tras haber estado en piso hace poco
    const groundSticky = (now - lastGroundSeenAtRef.current) < GROUND_STICK_MS;


    // ⏱️ timestamp de última vez sobre pista + flag “acabo de salir de pista”
    if (onRunway) {
      lastOnRunwayAtRef.current = Date.now();
    }
    const justLeftRunway = !onRunway && (Date.now() - lastOnRunwayAtRef.current < 15000); // 15 s


    // Estados sticky de aproximación que ya tenés en front
    const inFinalLock = finalLockedRef.current === true;

// Cercanía a APRON (más tolerante)
const aprDist = apronDistanceM({ lat: myPlane.lat, lon: myPlane.lon });
const nearApron120 = aprDist <= 120;   // antes 30m — subimos para que detecte mejor
const nearApron60  = aprDist <= 60;    // “muy cerca”
const nearApron50  = aprDist <= 50; // radio de APRON “parado”




    // Candidatos (prioridad por “más específicos” primero)
      let next: OpsState | null = null;

    // --- ORDEN DE PRIORIDAD ---
    if (onRunway && agl < 10) {
      if (finalLockedRef.current) finalLockedRef.current = false; // 🔓 al tocar pista
      next = 'RUNWAY_OCCUPIED';
    } else if (justLeftRunway) {
      next = 'RUNWAY_CLEAR';
    } else if (!onRunway && nearApron50 && agl < 10 && speedKmh <= 1) {
      // ✅ dentro de 50 m del APRON, a muy baja altura y virtualmente detenido
      next = 'APRON_STOP';
    } else if (!onRunway && nearApron120 && speedKmh > 1) {
      // ✅ cerca del APRON pero con movimiento → TAXI_APRON
      next = 'TAXI_APRON';
    } else if (!onRunway && agl < 30 && speedKmh >= 5) {
      // rodando fuera de pista, lejos del APRON
      next = 'TAXI_APRON';
    } else if (stopped && !onRunway) {
      // detenido en tierra fuera de la pista (fuera del radio de 50 m del APRON)
      next = 'APRON_STOP';
    } else if (nearHold && agl < 20 && speedKmh < 35 && !onRunway) {
      next = 'HOLD_SHORT';
    } else if (airborneWindowOk && !groundSticky && speedKmh >= TOUCHGO_MIN_SPEED_KMH) {
      // Sólo pasamos a vuelo si:
      // - superé el AGL umbral sostenido (histéresis), y
      // - no “vengo de tierra” en los últimos GROUND_STICK_MS
      next = inFinalLock ? 'FINAL' : 'AIRBORNE';
    }



    // Estados de aproximación si pediste aterrizaje (opcional, conservamos sticky)
    if (!next && landingRequestedRef.current) {
      const me = myPlane?.id || username;
      const idx = (runwayState?.state?.landings || []).findIndex((x:any)=>x?.name===me);
      if (idx > 0) next = 'LAND_QUEUE';
      else if (inFinalLock) next = 'FINAL';
      else {
        if (beaconB1 && getDistance(myPlane.lat, myPlane.lon, beaconB1.latitude, beaconB1.longitude) < 800) next = 'B1';
        else if (beaconB2 && getDistance(myPlane.lat, myPlane.lon, beaconB2.latitude, beaconB2.longitude) < 800) next = 'B2';
      }
    }

    if (!next) return;

    // Dwell 4s salvo tierra (RUNWAY_CLEAR/TAXI_APRON/APRON_STOP deben salir YA)
    const last = lastOpsStateRef.current;
    const instant = next === 'RUNWAY_CLEAR' || next === 'TAXI_APRON' || next === 'APRON_STOP';
    if (last !== next && !instant) {
      if (now - lastOpsStateTsRef.current < OPS_DWELL_MS) return;
    }


    // Cambió (o confirmó) estado → emitimos
    if (last !== next) {
      // 📌 efectos de transición
      if (next === 'RUNWAY_CLEAR') {
        // salir definitivamente del modo aproximación
        landingRequestedRef.current = false;
        finalLockedRef.current = false;

        // guía y latch hacia APRON
        const apr = getApronPoint();
        if (apr) { setNavTarget(apr); apronLatchRef.current = true; }

        // limpiar TA/RA inmediatamente
        setPrioritizedWarning(null);
        setConflict(null);
        setSelected(null);
      }

      // si entro a cualquier estado "de tierra", limpio alertas
      if (GROUND_OPS.has(next)) {
        setPrioritizedWarning(null);
        setConflict(null);
        setSelected(null);
      }

      lastOpsStateRef.current = next;
      lastOpsStateTsRef.current = now;

      socketRef.current?.emit('ops/state', {
        name: username,
        state: next,
        aux: {
          airportId: (airfield as any)?.icao || (airfield as any)?.id || (airfield as any)?.name || '',
          rwyIdent: activeIdent ?? (rw?.identA ?? rw?.identB ?? ''),
          aglM: agl,
          onRunway,
          nearHoldShort: nearHold,
        }
      });
      console.log('[OPS] Emitted', next);
    }


  })();

    

    // 👇👇 FALTABA cerrar el setInterval
    }, 1000);


    

    // 👇👇 Y el cleanup + cierre del useEffect
    return () => {
      try {
        if (s && myPlane?.id) {
          s.emit('remove-user', myPlane.id);
        }
      } catch (_) {}

      clearInterval(intervalId);
      s.off('connect');
      s.off('conflicto');
      s.off('traffic-update');
      s.off('initial-traffic');
      s.off('user-removed');
      s.off('disconnect');
      s.off('airfield-update');
      s.off('runway-state');
      s.off('runway-msg');
      s.off('sequence-update');
      s.off('atc-instruction');
      s.off('conflicto-clear');
      serverATCRef.current = false;
      finalLockedRef.current = false;


      // si compartís un socket global, NO lo desconectes aquí
      // s.disconnect(); // <- dejalo comentado
      socketRef.current = null;
    };
}, [username, simMode, aircraftModel, aircraftIcon, callsign, myPlane?.id]);

  // === AG: NUEVO — avisar si la app va a background ===
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
    if (state === 'background' || state === 'inactive') {
      if (socketRef.current && myPlane?.id) {
        socketRef.current.emit('remove-user', myPlane.id); // 👈 NUEVO
      }
      //emitLeave(); // lo que ya tenías
    }

    });
    return () => sub.remove();
  }, []);
  // === AG: fin background ===




  const centerMap = (lat = myPlane.lat, lon = myPlane.lon) => {
    if (mapRef.current) {
      mapRef.current.animateToRegion({
        latitude: lat,
        longitude: lon,
        latitudeDelta: zoom.latitudeDelta,
        longitudeDelta: zoom.longitudeDelta,
      });
    }
  };

  useEffect(() => {
    if (followMe) centerMap();
  }, [myPlane]);

  // Mantener cualquier prioritizedWarning durante 6s y bloquear recálculos
useEffect(() => {
  if (!prioritizedWarning) return;

  // Duración del warning en pantalla: 6s para RA Y para TA
  const isRA =
    prioritizedWarning.alertLevel === 'RA_LOW' ||
    prioritizedWarning.alertLevel === 'RA_HIGH';

  if (
    prioritizedWarning.alertLevel === 'RA_LOW' ||
    prioritizedWarning.alertLevel === 'RA_HIGH' ||
    prioritizedWarning.alertLevel === 'TA'
  ) {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    blockUpdateUntil.current = Date.now() + 6000;

    const pwId = prioritizedWarning.id; // capturamos el id y si era RA

    holdTimerRef.current = setTimeout(() => {
      setSelectedWarning(null);
      setPrioritizedWarning(null);

      // ⬇️ además oculto conflict/selected si son el mismo avión
      setConflict(prev => (prev && prev.id === pwId ? null : prev));
      setSelected(prev => (prev && prev.id === pwId ? null : prev));

      // ⬇️ snooze 3s para no re-mostrar inmediatamente al siguiente tick
      snoozeIdRef.current = pwId;
      snoozeUntilRef.current = Date.now() + 3000;

      // reset internos
      holdTimerRef.current = null;
      lastSentWarningRef.current = null;


    }, 6000);
  }
}, [prioritizedWarning?.id, prioritizedWarning?.alertLevel]);



    // Mantener visible el APRON hasta volver a volar (despegar)
  useEffect(() => {
    if (!rw) return;

    const st = lastOpsStateRef.current as OpsState | null;
    const activeEnd = rw.active_end === 'B' ? 'B' : 'A';

    // ✅ Encender latch SOLO al liberar pista (rodando lento sobre la pista)
    const freeingRunway = isOnRunwayStrip() && (myPlane?.speed ?? 0) < 40;
    if (freeingRunway) {
      apronLatchRef.current = true;
    }

// 🔓 Apagar latch al volver a volar o cuando estoy taxiando a cabecera para despegar

    // Se apaga el latch cuando:
    // - vuelvo a estar en vuelo (despegue)
    // - estoy taxiando hacia cabecera para despegar
    if (st === 'AIRBORNE' || st === 'TAXI_TO_RWY') {
      apronLatchRef.current = false;
    }
  }, [rw, myPlane.lat, myPlane.lon, myPlane.speed, runwayState]);

// Silenciar/limpiar TA/RA cuando ya liberé pista o estoy taxiando al APRON
useEffect(() => {
  const ops = lastOpsStateRef.current as OpsState | null;
  if (ops && GROUND_OPS.has(ops)) {
    setPrioritizedWarning(null);
    setConflict(null);
    setSelected(null);
    setPlanes(prev =>
      prev.map(p => ({ ...p, alertLevel: 'none', timeToImpact: undefined }))
    );
  }

}, [runwayState, myPlane.lat, myPlane.lon, myPlane.speed]);


  // === RUNWAY: Automatismos de avisos y ocupación/liberación ===
useEffect(() => {
  if (!rw) return;

// 1) "Liberar pista" solo si voy lento sobre la pista (< 50 km/h)
if (isOnRunwayStrip() && ((myPlane && typeof myPlane.speed === 'number' ? myPlane.speed : 0) < 50)) {
  flashBanner('¡Liberar pista!', 'free-runway');

  // Guía al APRON inmediatamente (línea azul cambia YA)
  const apr = getApronPoint();
  if (apr) { setNavTarget(apr); apronLatchRef.current = true; }

  // Forzar OPS a RUNWAY_OCCUPIED si aún estaba en FINAL
  emitOpsNow('RUNWAY_OCCUPIED');

  // Si estoy aterrizando y aún no marqué occupy, marcar
  if (landingRequestedRef.current && iAmOccupyingRef.current !== 'landing' && defaultActionForMe() === 'land') {
    markRunwayOccupy('landing');
    iAmOccupyingRef.current = 'landing';

    // 🚨 En el touchdown pierdo el turno de aterrizaje
    try { cancelMyRequest(); } catch {}
    landingRequestedRef.current = false;
    finalLockedRef.current = false;
    socketRef.current?.emit('runway-get'); // refresco estado del server
  }
} else {
  // Versión conservadora: hacer "clear" solo si venías ocupando
  // o si estás en un estado de tierra real cerca de la cabecera activa
  let activeEnd: 'A' | 'B' | null = null;
  if (rw && (rw as any).active_end === 'B') activeEnd = 'B';
  else if (rw) activeEnd = 'A';

  const nearActiveThreshold =
    activeEnd ? isNearThreshold(activeEnd, 200) : false;

  if (iAmOccupyingRef.current || (iAmGroundish() && nearActiveThreshold)) {
    markRunwayClear();

    // Reset de aproximación y OPS visible
    landingRequestedRef.current = false;
    finalLockedRef.current = false;
    emitOpsNow('RUNWAY_CLEAR');

    // Guía a APRON al salir de pista / tierra real
    const apr2 = getApronPoint();
    if (apr2) { setNavTarget(apr2); apronLatchRef.current = true; }

    iAmOccupyingRef.current = null;
  }
  // Si no se cumple la condición conservadora, NO limpies nada.
}


  // 2) Permisos según turno y huecos
  const me = myPlane?.id || username;
  const st = runwayState?.state;
  if (!st) return;

// permiso de aterrizar: sólo si soy #1, pista libre y estoy dentro del radio según tipo
const firstLanding = (st.landings || [])[0];
if (firstLanding?.name === me && !st.inUse && defaultActionForMe() === 'land') {
  const distM = distToActiveThresholdM();
  const cat = aircraftCategory(aircraftModel || (myPlane as any)?.type);
  const radius = PERMIT_RADIUS_M[cat];

  if (typeof distM === 'number') {
    if (distM <= radius) {
      if (!landClearShownRef.current) {
        flashBanner('Tiene permiso para aterrizar', 'clr-land');
        landClearShownRef.current = true; // mostrar una vez por “aproximación”
      }
    } else {
      // si te volviste a alejar, reseteamos para poder volver a mostrar al reingresar
      landClearShownRef.current = false;
    }
  }
} else {
  // si dejaste de ser #1 o la pista se ocupó, resetea
  landClearShownRef.current = false;
}


  // solicitud despegue: guiar a cabecera, ocupar, y despegar
  if (takeoffRequestedRef.current && defaultActionForMe()==='takeoff') {
    const activeEnd = rw.active_end==='B'?'B':'A';
    const nearThr = isNearThreshold(activeEnd, 80);
    const nextLanding = (st.timeline||[]).find((x:any)=>x.action==='landing' && new Date(x.at).getTime() > Date.now());
    const gapMin = nextLanding ? Math.round((new Date(nextLanding.at).getTime()-Date.now())/60000) : 999;

    if (nearThr) {
      const meTk = (st.takeoffs||[]).find((t:any)=>t.name===me);
      const waited = meTk?.waitedMin ?? 0;
      const can = (!st.inUse && (gapMin >= 5 || waited >= 15));
      if (can && iAmOccupyingRef.current !== 'takeoff') {
        flashBanner('Ocupe cabecera de pista', 'lineup');
        // cuando te vemos entrar a pista cerca de cabecera -> occupy + "puede despegar"
        if (isOnRunwayStrip()) {
          markRunwayOccupy('takeoff');
          iAmOccupyingRef.current = 'takeoff';
          flashBanner('Puede despegar', 'cleared-tko');
        }
      }
    }
  }

  // 3) Separación <5 min entre dos aterrizajes => al segundo: giro 360 por derecha
   /*
  const myETA = etaToActiveThresholdSec();
  if (landingRequestedRef.current && typeof myETA === 'number') {
    const others = (st.landings||[]).filter((l:any)=>l.name!==me && typeof l.etaSec==='number');
    const lead = others.sort((a:any,b:any)=>a.etaSec-b.etaSec)[0];
    if (lead && (myETA - lead.etaSec) < 5*60) {
      flashBanner('Haga un giro de 360° por derecha en espera', 'orbit-right');
    }
  }
      */
}, [myPlane.lat, myPlane.lon, myPlane.alt, myPlane.speed, runwayState, rw]);

  // === NAV: guía simple con B2 → B1 → Umbral, según turno en cola (con voz) ===
  useEffect(() => {
    // ⛳️ Si el latch al APRON está activo, fijamos SIEMPRE el navTarget al APRON
    {
      const apr = getApronPoint();
      if (apronLatchRef.current && apr) {
        setNavTarget(apr);
        return; // no dejes que el resto del efecto pise el target
      }
    }

    // 👉 Si estoy en RUNWAY_CLEAR / TAXI_APRON / APRON_STOP: guiar a APRON (aunque no haya latch)
    {
      const myOps = lastOpsStateRef.current as OpsState | null;
      if (!landingRequestedRef.current && myOps && GROUND_OPS.has(myOps)) {
        const apr = getApronPoint();
        setNavTarget(apr ?? null);
        return;
      }
    }



    if (serverATCRef.current) { setNavTarget(null); return; }   // ⬅️ INSERTAR AQUÍ
    if (!rw || !beaconB1 || !beaconB2) { setNavTarget(null); return; }
    // Sólo guiamos si pediste aterrizaje y estás “volando”

    // Sólo guiamos si pediste aterrizaje y estás “volando”
    if (!landingRequestedRef.current || defaultActionForMe() !== 'land') {
      setNavTarget(null);
      // reset de máquina cuando dejo de necesitar guía
      navPhaseRef.current = null;
      prevIdxRef.current = null;
      return;
    }
    const modelStr = aircraftModel || (myPlane as any)?.type || '';
    const isGlider = isGliderType(modelStr);
    const myGlide  = computeMyGlideInfo();


    const me = myPlane?.id || username;
    const landings = runwayState?.state?.landings || [];
    let idx = landings.findIndex((x:any) => x?.name === me);
    if (idx === -1) { setNavTarget(null); return; }

    // 🆘 ¿Soy emergencia?
    const myLanding = landings.find((x:any) => x?.name === me);
    const isEmergency = !!myLanding?.emergency;
    const isPrimaryEmergency = !!myLanding?.isPrimaryEmergency;



    // ⬇️ NUEVO: si tengo candado (ya pasé B1 → FINAL), fuerzo mi idx a 0,
    // salvo que el líder real sea EMERGENCIA (entonces cedo).
    if (finalLockedRef.current) {
      const leader = landings[0];
      const leaderIsEmergency = !!leader?.emergency;
      if (!leaderIsEmergency || leader?.name === me) {
        idx = 0; // me mantengo #1 aunque el server reordene por ETA
      } else {
        // Cede solo ante emergencia adelantada
        finalLockedRef.current = false; // suelto candado si me pasaron por emergencia
      }
    }


    // 👉 Reinicio suave cuando paso de #>0 a #0 (habilita cambio inmediato de fase)
    if (prevIdxRef.current != null && prevIdxRef.current > 0 && idx === 0) {
      lastPhaseSwitchRef.current = 0;     // quita “dwell” mínimo
      navPhaseRef.current = null;         // re-evaluo fase inicial como #1
    }
    prevIdxRef.current = idx;


// 🆘 EMERGENCIA PRIMARIA: ir directo a FINAL, sin B1/B2/B3/B4
if (isPrimaryEmergency) {
  // Si no tenemos umbral activo, no podemos guiar
  if (!activeThreshold) {
    setNavTarget(null);
    return;
  }

  // Fijar fase en FINAL y candado para que el server no me mueva de posición
  navPhaseRef.current = 'FINAL';
  finalLockedRef.current = true;
  lastPhaseSwitchRef.current = Date.now();

  // Congelar secuencia en el backend (coherente con planRunwaySequence)
  socketRef.current?.emit('sequence-freeze', {
    name: me,
    reason: 'primary-emergency-final',
  });

  // Poner navTarget en el umbral activo
  if (
    !navTarget ||
    navTarget.latitude !== activeThreshold.latitude ||
    navTarget.longitude !== activeThreshold.longitude
  ) {
    setNavTarget(activeThreshold);
    flashBanner('Continúe directo a final (EMERGENCIA)', 'emg-final');
    try {
      Speech.stop();
      Speech.speak('Continúe directo a final, emergencia', {
        language: 'es-ES',
      });
    } catch {}
  }

  // Nada de B1/B2/B3/B4 para la emergencia primaria
  return;
}




// === Modo #>0 → B2/B3/B4... según posición en la cola (sin spam) ===
// === Modo #>0 → esperas según tipo y glide ===
// === Modo #>0 → esperas según tipo y glide ===
if (idx > 0) {
  // 🪂 CASO PLANEADOR: nunca usar B2/B3/B4
  if (isGlider) {
    // 0) Si NO LLEGA, avisar y no dar ningún beacon
    if (myGlide.klass === 'NO_REACH') {
      setNavTarget(null);
      flashBanner(
        '⚠️ Con este planeo no llegás a la pista. Buscá campo alternativo.',
        'glide-no-reach'
      );
      try {
        Speech.stop();
        Speech.speak(
          'Con este planeo no llegás a la pista. Buscá campo alternativo.',
          { language: 'es-ES' }
        );
      } catch {}
      return;
    }

    // 1) Gate lateral para planeadores (#>0)
    const gate = gliderGatePoint || activeThreshold || null;
    if (!gate) {
      setNavTarget(null);
      return;
    }

    if (
      !navTarget ||
      navTarget.latitude !== gate.latitude ||
      navTarget.longitude !== gate.longitude
    ) {
      setNavTarget(gate);

      // Sólo anunciar una vez cuando cambiamos a ese gate
      const label = gliderGatePoint ? 'Gate planeador' : 'cabecera';
      flashBanner(
        'Planeador: espere a la derecha de cabecera',
        'glid-gate'
      );
      try {
        Speech.stop();
        Speech.speak('Planeador, espere a la derecha de cabecera', {
          language: 'es-ES',
        });
      } catch {}
    }

    // ⛔️ IMPORTANTE: nunca pasar a B2/B3/B4 si soy planeador
    return;
  }

  // ✈️ CASO AVIÓN A MOTOR → B2/B3/B4 como siempre
  const beaconsChain: LatLon[] = [
    beaconB2!,
    ...extraBeacons, // [B3, B4...]
  ].filter(Boolean as any);

  if (!beaconsChain.length) {
    if (beaconB2) {
      if (
        !navTarget ||
        navTarget.latitude !== beaconB2.latitude ||
        navTarget.longitude !== beaconB2.longitude
      ) {
        setNavTarget(beaconB2);
      }
    } else {
      setNavTarget(null);
    }
    return;
  }

  // idx = 1 → B2; idx = 2 → B3; etc.
  const slotIndex = Math.min(idx - 1, beaconsChain.length - 1);
  const targetBeacon = beaconsChain[slotIndex];

  if (
    !navTarget ||
    navTarget.latitude !== targetBeacon.latitude ||
    navTarget.longitude !== targetBeacon.longitude
  ) {
    setNavTarget(targetBeacon);

    const label =
      slotIndex === 0 ? 'B2' :
      slotIndex === 1 ? 'B3' :
      slotIndex === 2 ? 'B4' :
      `B${slotIndex + 2}`;

    flashBanner(`Proceda a ${label}`, `goto-${label.toLowerCase()}`);
    try {
      Speech.stop();
      Speech.speak(
        `Proceda a ${label.replace('B', 'be ')}`,
        { language: 'es-ES' }
      );
    } catch {}
  }
  return;
}


// 🎯 Soy #1 en la cola (idx === 0)
// Para planeadores: SIEMPRE ir directo a FINAL, sin B1
if (isGlider) {
  // Si no hay umbral activo no podemos guiar
  if (!activeThreshold) {
    setNavTarget(null);
    // reinicio la fase para que cuando haya pista se reevalúe
    navPhaseRef.current = null;
    return;
  }

  // Fijamos la fase en FINAL y la "congelamos"
  navPhaseRef.current = 'FINAL';
  finalLockedRef.current = true;
  lastPhaseSwitchRef.current = Date.now();

  // Opcional: avisar al servidor que congele la secuencia (igual que B1 lock)
  socketRef.current?.emit('sequence-freeze', {
    name: me,
    reason: 'glider-direct-final',
  });

  // Solo actualizamos navTarget si cambió
  if (
    !navTarget ||
    navTarget.latitude !== activeThreshold.latitude ||
    navTarget.longitude !== activeThreshold.longitude
  ) {
    setNavTarget(activeThreshold);
    flashBanner('Planeador: continúe directo a final', 'glid-final');
    try {
      Speech.stop();
      Speech.speak('Planeador, continúe directo a final', {
        language: 'es-ES',
      });
    } catch {}
  }

  // Muy importante: no seguir con la lógica de B1/B2/FINAL
  return;
}


    // === Soy #1 — histéresis + dwell
    const dToB1 = getDistance(myPlane.lat, myPlane.lon, beaconB1.latitude, beaconB1.longitude);

    // Fase inicial por proximidad si aún no hay fase
    if (!navPhaseRef.current) {
      navPhaseRef.current = dToB1 > B1_ENTER_M ? 'B1' : 'FINAL';
      lastPhaseSwitchRef.current = Date.now();
    }

    if (dToB1 <= FINAL_ENTER_M && maybeSwitchPhase('FINAL')) {
      // ⬇️ NUEVO: candado local + freeze al server
      finalLockedRef.current = true;
      socketRef.current?.emit('sequence-freeze', { name: me, reason: 'locked-at-B1' });

      if (activeThreshold) {
        setNavTarget(activeThreshold);
        flashBanner('Continúe a final', 'continue-final');
        try { Speech.stop(); Speech.speak('Continúe a final', { language: 'es-ES' }); } catch {}
      }
    }


    // B1 → FINAL si entro por debajo de FINAL_ENTER_M (banner/voz SOLO al cambiar)
    if (navPhaseRef.current === 'B1') {
      if (dToB1 <= FINAL_ENTER_M) {
        if (maybeSwitchPhase('FINAL') && activeThreshold) {
          setNavTarget(activeThreshold);
          flashBanner('Continúe a final', 'continue-final');
          try { Speech.stop(); Speech.speak('Continúe a final', { language: 'es-ES' }); } catch {}
        }
      } else {
        // Mantener B1 sin re-banners
        if (!navTarget || navTarget.latitude !== beaconB1.latitude || navTarget.longitude !== beaconB1.longitude) {
          setNavTarget(beaconB1);
          // 👇 IMPORTANTE: no volver a llamar flashBanner/voz aquí
        }
      }
} else {
  // FINAL → (posible) B1: solo si NO está candado y realmente te abriste bastante
  // Evita histéresis tras “Continúe a final”.
  if (!finalLockedRef.current && dToB1 >= B1_ENTER_M) {
    if (maybeSwitchPhase('B1')) {
      setNavTarget(beaconB1);
      flashBanner('Vire hacia B1', 'turn-b1');
      try { Speech.stop(); Speech.speak('Vire hacia be uno', { language: 'es-ES' }); } catch {}
    }
  } else if (activeThreshold) {
    // Mantener FINAL sin re-banners
    if (!navTarget || navTarget.latitude !== activeThreshold.latitude || navTarget.longitude !== activeThreshold.longitude) {
      setNavTarget(activeThreshold);
    }
  }
}



  }, [
    rw,
    runwayState,          // cambia cuando se replanifica la cola
    beaconB1, beaconB2,
    activeThreshold,
    myPlane.lat, myPlane.lon,
    username,
    navTarget
  ]);



  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (taDebounceRef.current) clearTimeout(taDebounceRef.current);
    };
  }, []);

    const shouldShowBeaconGuide = (() => {
    const st = lastOpsStateRef.current as OpsState | null;
    return !(st === 'RUNWAY_CLEAR' || st === 'TAXI_APRON' || st === 'APRON_STOP');
    })();



  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
          mapType="standard"
          customMapStyle={lightMapStyle}

        style={styles.map}
        initialRegion={{
          latitude: myPlane.lat,
          longitude: myPlane.lon,
          latitudeDelta: zoom.latitudeDelta,
          longitudeDelta: zoom.longitudeDelta,
        }}
        onRegionChangeComplete={region => setZoom({ latitudeDelta: region.latitudeDelta, longitudeDelta: region.longitudeDelta })}
        onPress={() => {
          setSelected(null);
          if (hideSelectedTimeout.current) {
            clearTimeout(hideSelectedTimeout.current);
            hideSelectedTimeout.current = null;
          }
        }}
      >
{/* === MI AVIÓN — RENDERIZACIÓN PROFESIONAL SIN RECORTES === */}
<Marker
  key={"my-aircraft"}
  coordinate={{
    latitude: myPlane.lat,
    longitude: myPlane.lon,
  }}
  anchor={{ x: 0.5, y: 0.5 }}               // centro exacto del PNG
  flat                                     // pega el ícono al mapa
  rotation={myPlane.heading || 0}          // rotación nativa (sin View)
  image={getOwnPlaneIcon(aircraftIcon)}    // PNG nativo con require()
  tracksViewChanges={false}                // performance óptima
/>






{planes
  .filter(plane => plane.id !== username)
  .map((plane) => {
    console.log('plane', plane.id, 'alertLevel', plane.alertLevel);
    return (
      <Marker
        key={plane.id}
        coordinate={{ latitude: plane.lat, longitude: plane.lon }}
        anchor={{ x: 0.5, y: 0.5 }}
        flat
        rotation={plane.heading || 0}
        tracksViewChanges={false}
        image={getRemotePlaneIcon(
          plane.aircraftIcon || plane.type || '2.png',
          plane.alertLevel
        )}
        onPress={() => {
          let ops = getOpsOf(plane.id) as OpsState | null;
          ops = ops || inferOpsForDisplay(plane);
          setSelected({ ...plane, ops } as any);
          const warning = warnings[plane.id];
          const isPureInfo =
            !warning &&
            (plane.alertLevel === 'none' || !plane.alertLevel);
          selectedHoldUntilRef.current = isPureInfo ? Date.now() + 5000 : 0;
          if (warning) {
            const w = { ...warning, ops } as any;
            priorizarWarningManual(w);
            maybeEmitWarning(w);
          } else if (
            plane.alertLevel === 'TA' ||
            plane.alertLevel === 'RA_LOW' ||
            plane.alertLevel === 'RA_HIGH'
          ) {
            priorizarWarningManual({
              alertLevel: plane.alertLevel as any,
              timeToImpact: plane.timeToImpact || Infinity,
              distanceMeters: getDistance(myPlane.lat, myPlane.lon, plane.lat, plane.lon),
              id: plane.id,
              name: plane.name,
              lat: plane.lat,
              lon: plane.lon,
              alt: plane.alt,
              heading: plane.heading,
              speed: plane.speed,
              type: plane.type,
              callsign: plane.callsign,
              aircraftIcon: plane.aircraftIcon,
              ops,
            } as any);
          }
          if (hideSelectedTimeout.current) {
            clearTimeout(hideSelectedTimeout.current);
          }
          hideSelectedTimeout.current = setTimeout(() => {
            setSelected(null);
          }, 6000);
          if (isPureInfo) {
            hideSelectedTimeout.current = setTimeout(() => {
              setSelected(null);
              selectedHoldUntilRef.current = 0;
              hideSelectedTimeout.current = null;
            }, 5000);
          }
        }}
      />
    );
  })}



                  {/* === RUNWAY (Airfield) === */}
          {A_runway && B_runway && (
            <Polyline coordinates={[A_runway, B_runway]} strokeColor="black" strokeWidth={3} />
          )}
          {A_runway && (
            <Marker coordinate={A_runway} title={`Cabecera A ${rw?.identA || ''}`} onPress={() => showRunwayLabel('A')}>
              <View style={{ backgroundColor: '#2196F3', padding: 2, borderRadius: 10, minWidth: 20, alignItems: 'center' }}>
                <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 10 }}>A</Text>
              </View>
            </Marker>
          )}
          {B_runway && (
            <Marker coordinate={B_runway} title={`Cabecera B ${rw?.identB || ''}`} onPress={() => showRunwayLabel('B')}>
              <View style={{ backgroundColor: '#E53935', padding: 2, borderRadius: 10, minWidth: 20, alignItems: 'center' }}>
                <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 10 }}>B</Text>
              </View>
            </Marker>
          )}
          {runwayMid && (
            <Marker
              coordinate={runwayMid}
              title={`${rw?.identA ?? 'RWY'}`}
              onPress={() => showRunwayLabel(rw?.active_end === 'B' ? 'B' : 'A')}
              anchor={{ x: 0.5, y: 0.5 }}
              flat
              rotation={runwayHeading}
            >
              <View style={{ alignItems: 'center' }}>
                <View style={{
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
                }} />
              </View>
            </Marker>
          )}

          {/* === APRON marker: solo si estoy en cabecera o liberando pista === */}
          {shouldShowApronMarker && (() => {
            const apr = getApronPoint();
            if (!apr) return null;
            return (
              <Marker coordinate={apr} title="APRON">
                <View style={{ backgroundColor: '#FF9800', padding: 4, borderRadius: 10 }}>
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 10 }}>APRON</Text>
                </View>
              </Marker>
            );
          })()}

          {/* === FIN RUNWAY === */}

        <Polyline coordinates={track} strokeColor="blue" strokeWidth={2} />

        {/* === BEACONS: Línea guía B2 -> B1 -> Umbral activo (oculta si ya vas a manga) === */}
        {shouldShowBeaconGuide && beaconB1 && beaconB2 && (
          <Polyline
            coordinates={[
              beaconB2,
              beaconB1,
              activeThreshold || beaconB1
            ]}
            strokeColor="green"
            strokeWidth={2}
          />
        )}

        {/* B2 */}
        {beaconB2 && (
          <Marker coordinate={beaconB2} title="B2">
            <View style={{ backgroundColor: '#673AB7', padding: 2, borderRadius: 10, minWidth: 24, alignItems: 'center' }}>
              <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 10 }}>B2</Text>
            </View>
          </Marker>
        )}

        {/* B1 */}
        {beaconB1 && (
          <Marker coordinate={beaconB1} title="B1">
            <View style={{ backgroundColor: '#4CAF50', padding: 2, borderRadius: 10, minWidth: 24, alignItems: 'center' }}>
              <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 10 }}>B1</Text>
            </View>
          </Marker>
        )}

        {/* B3, B4... (beacons extra) */}
        {extraBeacons.map((b, index) => {
          const label = `B${index + 3}`; // B3, B4...
          const bg = index === 0 ? '#3F51B5' : '#1E88E5';

          return (
            <Marker key={label} coordinate={b} title={label}>
              <View style={{ backgroundColor: bg, padding: 2, borderRadius: 10, minWidth: 24, alignItems: 'center' }}>
                <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 10 }}>{label}</Text>
              </View>
            </Marker>
          );
        })}



        {/* Mi pierna hacia el target (B2/B1/Umbral) */}
        {navTarget && !myCantReach && (
          <Polyline
            coordinates={[
              { latitude: myPlane.lat, longitude: myPlane.lon },
              navTarget,
            ]}
            strokeWidth={3}
            strokeColor="blue"
          />
        )}







      </MapView>

        <View style={styles.controlsBox}>
          <Text style={styles.label}>✈️ heading: {myPlane.heading.toFixed(0)}°</Text>
          <Slider minimumValue={0} maximumValue={359} step={1} value={myPlane.heading} onValueChange={val => setMyPlane(prev => ({ ...prev, heading: val }))} />

          <Text style={styles.label}>🛫 Altitud: {myPlane.alt.toFixed(0)} m</Text>
          {/* 👇 AGL visible en B2/B1/FINAL */}
          {(() => {
            const st = lastOpsStateRef.current as OpsState | null;
            const showAGL = st === 'B2' || st === 'B1' || st === 'FINAL';
            if (!showAGL) return null;
            const agl = Math.round(getAGLmeters());
            return <Text style={styles.label}>📏 Altura sobre suelo: {agl} m AGL</Text>;
          })()}

          <Slider minimumValue={0} maximumValue={2000} step={10} value={myPlane.alt} onValueChange={val => setMyPlane(prev => ({ ...prev, alt: val }))} />
          <Text style={styles.label}>💨 Velocidad: {myPlane.speed.toFixed(0)} km/h</Text>
          <Slider minimumValue={0} maximumValue={400} step={5} value={myPlane.speed} onValueChange={val => setMyPlane(prev => ({ ...prev, speed: val }))} />
        </View>


      {prioritizedWarning ? (
        // prioritizedWarning es Warning: tiene distanceMeters ✅
        <TrafficWarningCard
          aircraft={prioritizedWarning}
          distance={prioritizedWarning.distanceMeters}
        />
      ) : conflict ? (
        // conflict es Plane: calculá on-the-fly
        <TrafficWarningCard
          aircraft={conflict}
          distance={getDistanceTo(conflict)}
        />
      ) : selected ? (
        // selected es Plane: calculá on-the-fly
        <TrafficWarningCard
          aircraft={selected}
          distance={getDistanceTo(selected)}
        />
      ) : null}




      <TouchableOpacity onPress={toggleFollowMe} style={[
          styles.followBtn,
          hasWarning && { bottom: Platform.OS === 'android' ? 170 : 140 }
        ]}


      >


        <Text style={styles.followText}>{followMe ? '✈️ No seguir avión' : '📍 Centrado automático'}</Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => setSimMode(prev => !prev)}
        style={[
          styles.followBtn,
          { bottom: Platform.OS === 'android' ? 110 : 80 },
          hasWarning && { bottom: Platform.OS === 'android' ? 170 + 50 : 140 + 50 }
        ]}
      >
        <Text style={styles.followText}>
          {simMode ? '🛰️ Usar GPS real' : '🛠️ Usar modo simulación'}
        </Text>
      </TouchableOpacity>

{/* === RUNWAY: Label efímero al tocar pista (6s) === */}
{runwayTapEnd && Date.now() < runwayLabelUntil && (
    <View style={{
      position:'absolute', left:10, right:10, bottom: Platform.OS==='android'? 210 : 180,
      backgroundColor:'#fff', borderRadius:14, padding:12, elevation:4
    }}>

  {/* Turno propio en rojo (usa la cola donde REALMENTE estoy) */}
  <Text style={{color:'#C62828', fontWeight:'700', marginBottom:6}}>
    {(() => {
      const me = myPlane?.id || username;
      const ls = runwayState?.state?.landings || [];
      const ts = runwayState?.state?.takeoffs || [];

      const iL = ls.findIndex((x:any)=>x?.name===me);
      const iT = ts.findIndex((x:any)=>x?.name===me);

      const activeList =
        iL >= 0 ? ls :
        iT >= 0 ? ts :
        (defaultActionForMe()==='land' ? ls : ts);

      const idx = activeList.findIndex((x:any)=>x?.name===me);

      // 🔒 Ocultar "Turno #" si estoy bloqueado en FINAL/B1 o estoy ocupando pista, o si la pista está en uso
      const stNow = lastOpsStateRef.current;
      const hideTurno =
        finalLockedRef.current ||
        stNow === 'FINAL' || stNow === 'B1' || stNow === 'RUNWAY_OCCUPIED' ||
        !!runwayState?.state?.inUse;

      return (idx >= 0 && !hideTurno) ? `Turno #${idx+1}` : ' ';
    })()}
  </Text>
  {/* Estado OPS visible aparte */}
  <Text style={{fontSize:12, marginTop:4}}>
    Estado OPS: {lastOpsStateRef.current ?? '—'}
  </Text>

  {/* Estado de planeo (si soy planeador) */}
    {(() => {
      const model = aircraftModel || (myPlane as any)?.type || '';
      if (!isGliderType(model)) return null;
      const g = computeMyGlideInfo();
      const txt =
        g.klass === 'NO_REACH' ? 'NO LLEGA' :
        g.klass === 'CRITICAL' ? 'Llega MUY justo' :
        g.klass === 'TIGHT' ? 'Llega justo' :
        'Llega cómodo';

      return (
        <Text style={{fontSize:12, marginTop:2, color:'#00695C'}}>
          Glide: {txt} (AGL {Math.round(g.aglM)} m, alcance ≈ {Math.round(g.dMaxM/1000)} km)
        </Text>
      );
    })()}


    {/* 🆘 Aviso explícito si YO estoy marcado como EMERGENCIA en la cola */}
{(() => {
  const me = myPlane?.id || username;
  const ls = runwayState?.state?.landings || [];
  const myL = ls.find((x:any)=>x?.name === me);

  const isEmergency = !!myL?.emergency;
  const isPrimary   = !!myL?.isPrimaryEmergency;

  // Sólo mostrar este mensaje si soy la EMERGENCIA PRINCIPAL
  if (!isPrimary) return null;

  return (
    <Text
      style={{
        color: '#B71C1C',
        fontWeight: '700',
        marginTop: 4,
        marginBottom: 4,
      }}
    >
      🆘 EMERGENCIA prioritaria en secuencia de aterrizaje
    </Text>
  );
})()}



    {/* Quién está en uso */}
    <Text style={{fontWeight:'700', marginBottom:4}}>
      {runwayState?.state?.inUse
        ? `${runwayState.state.inUse.action==='landing'?'Aterrizando':'Despegando'} — `
          + `${runwayState.state.inUse.name} (${runwayState.state.inUse.callsign||'—'})`
        : 'Pista libre'}
    </Text>

{(() => { const me=myPlane?.id||username; const s=slots.find(x=>x.name===me); return s?.frozen ? <Text style={{marginBottom:4}}>🔒 Posición congelada (B1)</Text> : null; })()}

{(() => { const me=myPlane?.id||username; const s=slots.find(x=>x.name===me); return s ? <Text style={{marginBottom:2}}>ETA a slot: {Math.max(0, Math.round((s.startMs - Date.now())/1000))} s</Text> : null; })()}

{(() => { const me=myPlane?.id||username; const s=slots.find(x=>x.name===me) as any; const sh=Math.round((s?.shiftAccumMs||0)/1000); return s&&sh>0 ? <Text style={{marginBottom:8}}>Desvío aplicado: +{sh}s</Text> : null; })()}


    {/* Acciones según estado (volando/tierra) */}
    <View style={{flexDirection:'row', gap:10, flexWrap:'wrap', marginBottom:6}}>
      {(() => {
        const action = defaultActionForMe();
        const already =
          (action==='land' && landingRequestedRef.current) ||
          (action==='takeoff' && takeoffRequestedRef.current);

        if (already) {
          return (
            <TouchableOpacity onPress={cancelRunwayLabel}
              style={{backgroundColor:'#eee', paddingHorizontal:12, paddingVertical:8, borderRadius:10}}>
              <Text>Cancelar {action==='land'?'aterrizaje':'despegue'}</Text>
            </TouchableOpacity>
          );
        }

        if (action==='land') {
          return (
            <>
              <TouchableOpacity onPress={requestLandingLabel}
                style={{backgroundColor:'#111', paddingHorizontal:12, paddingVertical:8, borderRadius:10}}>
                <Text style={{color:'#fff', fontWeight:'600'}}>Solicitar Aterrizaje</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={()=>{
                  socketRef.current?.emit('runway-request',{
                    action:'land', name: myPlane?.id||username,
                    callsign: callsign||'', aircraft: aircraftModel||'',
                    type: aircraftModel||'', emergency:true, altitude: myPlane?.alt??0
                  });
                  landingRequestedRef.current = true;
                  flashBanner('EMERGENCIA declarada', 'emg');
                }}
                style={{backgroundColor:'#b71c1c', paddingHorizontal:12, paddingVertical:8, borderRadius:10}}
              >
                <Text style={{color:'#fff', fontWeight:'700'}}>EMERGENCIA</Text>
              </TouchableOpacity>
            </>
          );
        }

        // en tierra: solo despegue
        return (
          <TouchableOpacity onPress={requestTakeoffLabel}
            style={{backgroundColor:'#111', paddingHorizontal:12, paddingVertical:8, borderRadius:10}}>
            <Text style={{color:'#fff', fontWeight:'600'}}>Solicitar Despegue</Text>
          </TouchableOpacity>
        );
      })()}
    </View>

{/* Cola completa (scrolleable si es larga) */}
<Text style={{fontWeight:'600', marginTop:4, marginBottom:4}}>
  {defaultActionForMe()==='land' ? 'Cola de aterrizajes' : 'Cola de despegues'}
</Text>

<View style={{maxHeight: 180}}>
  <ScrollView>
    {(() => {
      const me = myPlane?.id||username;
      const action = defaultActionForMe();
      const list = action==='land'
        ? (runwayState?.state?.landings||[])
        : (runwayState?.state?.takeoffs||[]);

      if (!list.length) return <Text style={{fontSize:12}}>(vacío)</Text>;

      const opsMap = (runwayState as any)?.state?.opsStates || {};
      return list.map((x:any, i:number) => {
        const mine   = x?.name === me;
        const etaMin = typeof x?.etaSec === 'number' ? Math.round(x.etaSec/60) : null;
        const waited = typeof x?.waitedMin === 'number' ? x.waitedMin : null;
        const tags = [
          x?.emergency ? 'EMERGENCIA' : null,
          (action==='land'    && x?.holding) ? 'HOLD'  : null,
          (action==='takeoff' && x?.ready)   ? 'LISTO' : null,
          (action==='takeoff' && waited!=null) ? `+${waited}m` : null,
        ].filter(Boolean).join(' · ');

        const opsStr = opsMap[x?.name] ? ` · OPS: ${opsMap[x.name]}` : '';

        return (
          <Text
            key={x?.name || i}
            style={{
              fontSize:12,
              marginBottom:2,
              ...(mine ? { fontWeight:'700', color:'#C62828' } : {})
            }}
          >
            #{i+1} {x?.name}{x?.callsign ? ` (${x.callsign})` : ''}
            {etaMin!=null ? ` — ETA ${etaMin} min` : ''}
            {tags ? ` — [${tags}]` : ''}{opsStr}
          </Text>
        );
      });


    })()}
  </ScrollView>
</View>

        {/* OPS pill fija (estado del propio avión) */}
        <View style={{
          position:'absolute',
          right: 10,
          bottom: Platform.OS === 'android' ? 120 : 90,
          backgroundColor:'#FFFFFF',
          borderRadius:12,
          paddingHorizontal:12,
          paddingVertical:6,
          elevation:3,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: '#ddd'
        }}>
          <Text style={{fontWeight:'700'}}>OPS: {lastOpsStateRef.current ?? '—'}</Text>
        </View>



  </View>
)}

{/* === RUNWAY: Banner efímero 6s === */}
{banner && (
  <View style={{
    position:'absolute', left:10, right:10, bottom: Platform.OS==='android'? 270 : 240,
    backgroundColor:'#263238', borderRadius:12, padding:10, elevation:4
  }}>
    <Text
        style={{
          color: '#C62828',      // rojo
          textAlign: 'center',
          fontWeight: '900',
          fontSize: 22,          // más grande
        }}
      >
        {banner.text}
    </Text>
  </View>
)}







    </View>
  );
};

export default Radar;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingBottom: Platform.OS === 'android' ? 30 : 0,
  },
  map: {
    flex: 1,
  },
  controlsBox: {
    backgroundColor: 'white',
    padding: 10,
    margin: 10,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    marginTop: 10,
  },
  followBtn: {
    position: 'absolute',
    bottom: Platform.OS === 'android' ? 60 : 30,
    alignSelf: 'center',
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    elevation: 3,
  },
  followText: {
    color: 'white',
    fontWeight: '600',
  },
  legendBox: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    backgroundColor: 'white',
    borderRadius: 8,
    padding: 8,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  legendText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
  },
});

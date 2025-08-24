import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, Dimensions, TouchableOpacity, Image, Alert, Platform, AppState } from 'react-native'; // === AG: import AppState ===
import MapView, { Marker, PROVIDER_GOOGLE, Polyline } from 'react-native-maps';
import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';
import { useUser } from '../context/UserContext';
import { getOwnPlaneIcon } from '../utils/getOwnPlaneIcon';
import { getRemotePlaneIcon } from '../utils/getRemotePlaneIcon';
import { normalizeModelToIcon } from '../utils/normalizeModelToIcon';
import TrafficWarningCard from './components/TrafficWarningCard';
import { Plane } from '../types/Plane';
import { SERVER_URL } from '../utils/config'; // ajustá la ruta si es distinta
import io from "socket.io-client";
import { socket } from '../utils/socket';
//import { calcularWarningLocalMasPeligroso } from '../data/WarningSelector';
import { Warning } from '../data/FunctionWarning';
import { useFocusEffect } from "@react-navigation/native";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Airfield } from '../types/airfield';






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
  const [runwayPanelOpen, setRunwayPanelOpen] = useState(false);


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

  const lastSentWarningRef = useRef<{ sig: string; t: number } | null>(null);
  

  const maybeEmitWarning = (w: Warning) => {
    // solo emitimos TA/RA válidos
    if (!w || !['TA','RA_LOW','RA_HIGH'].includes(w.alertLevel)) return;
    const s = socketRef.current;
    if (!s) return;

    const sig = `${w.id}|${w.alertLevel}`;
    const now = Date.now();
    // re-emití si cambia la firma o pasaron 3s desde el último envío
    if (
      !lastSentWarningRef.current ||
      lastSentWarningRef.current.sig !== sig ||
      now - lastSentWarningRef.current.t > 3000
    ) {
      s.emit('warning', w);
      lastSentWarningRef.current = { sig, t: now };
      console.log('📡 Enviado warning (forzado):', w);
    }
  };


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
const mapRef = useRef<MapView | null>(null);
const socketRef = useRef<ReturnType<typeof io> | null>(null);
const isFocusedRef = useRef(false);
const lastDistanceRef = useRef<Record<string, number>>({});

// === Airfield (pista) ===
const [airfield, setAirfield] = useState<Airfield | null>(null);

// Derivados de la runway activa (si existe)
const rw = airfield?.runways?.[0];
const A_runway = rw ? { latitude: rw.thresholdA.lat, longitude: rw.thresholdA.lng } : null;
const B_runway = rw ? { latitude: rw.thresholdB.lat, longitude: rw.thresholdB.lng } : null;
const runwayHeading = rw
  ? (rw.active_end === 'A' ? rw.heading_true_ab : (rw.heading_true_ab + 180) % 360)
  : 0;
const runwayMid = (A_runway && B_runway)
  ? { latitude: (A_runway.latitude + B_runway.latitude) / 2, longitude: (A_runway.longitude + B_runway.longitude) / 2 }
  : null;

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

// === RUNWAY: acción por defecto según altura relativa ===
const defaultActionForMe = () => {
  const planeAlt = (myPlane?.alt ?? 0);
  const fieldElev =
    (airfield as any)?.elevation ??
    (runwayState?.airfield?.elevation ?? 0); // si no hay, usamos 0
  const altRel = Math.max(0, planeAlt - fieldElev);
  return altRel > 10 ? 'land' : 'takeoff';
};

// === RUNWAY: pedidos al backend ===
const requestLanding = () => {
  socketRef.current?.emit('runway-request', {
    action: 'land',
    name: myPlane?.id || username,
    callsign: callsign || '',
    aircraft: aircraftModel || '',
    type: aircraftModel || '',
    emergency: !!(myPlane as any)?.emergency,
    altitude: myPlane?.alt ?? 0,
  });
};

const requestTakeoff = (ready: boolean) => {
  socketRef.current?.emit('runway-request', {
    action: 'takeoff',
    name: myPlane?.id || username,
    callsign: callsign || '',
    aircraft: aircraftModel || '',
    type: aircraftModel || '',
    ready: !!ready,
  });
};

const cancelMyRequest = () => {
  socketRef.current?.emit('runway-cancel', {
    name: myPlane?.id || username,
  });
};

// === RUNWAY: ocupar / liberar pista ===
const markRunwayOccupy = (action: 'landing' | 'takeoff' | any) => {
  socketRef.current?.emit('runway-occupy', {
    action,
    name: myPlane?.id || username,
    callsign: callsign || '',
    // slotMin opcional (si no, el server usa 5)
    // slotMin: action === 'takeoff' ? 5 : 5,
  });
};

const markRunwayClear = () => {
  socketRef.current?.emit('runway-clear');
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
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [])
);

//   useEffect(() => {
//     if (
//       prioritizedWarning &&
//       socketRef.current &&
//       ['TA', 'RA_LOW', 'RA_HIGH'].includes(prioritizedWarning.alertLevel)
//     ) {
//       socketRef.current.emit('warning', prioritizedWarning);
//       console.log('📡 Warning enviado al backend:', prioritizedWarning);
//     }
//   }, [prioritizedWarning]);

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
  const trafficWithoutMe = planes.filter(p => p.id !== myPlane?.id);
  if (!myPlane || trafficWithoutMe.length === 0) return;

  const timeSteps = Array.from({ length: 36 }, (_, i) => (i + 1) * 5);
  let selectedConflict: Plane | null = null;
  let selectedConflictLevel: 'RA_HIGH' | 'RA_LOW' | undefined = undefined;

  let selectedNearby: Plane | null = null;
  let minTimeToImpact = Infinity;
  let minProxDist = Infinity;

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

  for (const plane of trafficWithoutMe) {
    const distanceNow = getDistance(myPlane.lat, myPlane.lon, plane.lat, plane.lon);

    // TA: tráfico cercano
    if (distanceNow < 3000 && plane.speed > 30) {
      if (distanceNow < minProxDist) {
        selectedNearby = plane;
        minProxDist = distanceNow;
      }
    }

    // RA: trayectorias convergentes
    // === RA: trayectorias convergentes (más sensible y robusto) ===

    // 1) Distancia futura en 5..180 s
    const futureDistances: number[] = [];
    for (const t of timeSteps) {
      const myF = getFuturePosition(myPlane.lat, myPlane.lon, myPlane.heading, myPlane.speed, t);
      const thF = getFuturePosition(plane.lat, plane.lon, plane.heading || 0, plane.speed || 0, t);
      futureDistances.push(getDistance(myF.latitude, myF.longitude, thF.latitude, thF.longitude));
    }
    const minDistance = Math.min(...futureDistances);
    const idxMin      = futureDistances.indexOf(minDistance);
    const timeOfMin   = timeSteps[idxMin];

    const futureAltDelta = Math.abs(myPlane.alt - plane.alt);

    // 2) “Acercamiento” simple: distancia a 5s menor que ahora
    const currentDistance = getDistance(myPlane.lat, myPlane.lon, plane.lat, plane.lon);
    const distance5s  = futureDistances[0] ?? distanceNow;
    const closingSoon = distance5s < (distanceNow - 15); // margen 15 m

    // 3) Cono de RA: bearing ahora y en el punto de mínimo
    const bearingDeg = (lat1:number, lon1:number, lat2:number, lon2:number) => {
      const dLon = toRad(lon2 - lon1);
      const y = Math.sin(dLon) * Math.cos(toRad(lat2));
      const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
                Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
      const b = (Math.atan2(y, x) * 180) / Math.PI;
      return (b + 360) % 360;
    };
    const myAtMin    = getFuturePosition(myPlane.lat, myPlane.lon, myPlane.heading, myPlane.speed, timeOfMin);
    const theirAtMin = getFuturePosition(plane.lat, plane.lon, plane.heading || 0, plane.speed || 0, timeOfMin);

    const diffNow = (() => {
      const bNow = bearingDeg(myPlane.lat, myPlane.lon, plane.lat, plane.lon);
      const d = Math.abs(((myPlane.heading - bNow + 540) % 360) - 180);
      return d;
    })();
    const diffAtMin = (() => {
      const bMin = bearingDeg(myAtMin.latitude, myAtMin.longitude, theirAtMin.latitude, theirAtMin.longitude);
      const d = Math.abs(((myPlane.heading - bMin + 540) % 360) - 180);
      return d;
    })();
    const withinCone = (diffNow <= RA_CONE_DEG) || (diffAtMin <= RA_CONE_DEG);

    // 4) Criterio RA final
    if (
      minDistance < RA_MIN_DIST_M &&
      futureAltDelta <= RA_VSEP_MAX_M &&
      closingSoon &&
      withinCone
    ) {
      if (timeOfMin < RA_HIGH_TTI_S && timeOfMin < minTimeToImpact) {
        selectedConflict = plane;
        selectedConflictLevel = 'RA_HIGH';
        minTimeToImpact = timeOfMin;
      } else if (timeOfMin < RA_LOW_TTI_S && selectedConflictLevel !== 'RA_HIGH') {
        selectedConflict = plane;
        selectedConflictLevel = 'RA_LOW';
        minTimeToImpact = timeOfMin;
      }
    }


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

      const distSel = getDistance(myPlane.lat, myPlane.lon, selectedConflict.lat, selectedConflict.lon);


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
        distanceMeters: distSel,   // ✅ agregado
        type: selectedConflict.type,            // 👈 AÑADIR
        aircraftIcon: selectedConflict.aircraftIcon || '2.png',
        callsign: selectedConflict.callsign || '',
      };
    } else if (selectedNearby) {
      setSelected({ ...selectedNearby, alertLevel: 'TA' as 'TA' });
      setConflict(null);
      const distTa = getDistance(myPlane.lat, myPlane.lon, selectedNearby.lat, selectedNearby.lon);

      nuevoWarningLocal = {
        id: selectedNearby.id,
        name: selectedNearby.name,
        lat: selectedNearby.lat,
        lon: selectedNearby.lon,
        alt: selectedNearby.alt,
        heading: selectedNearby.heading,
        speed: selectedNearby.speed,
        alertLevel: 'TA',
        timeToImpact: undefined,
        distanceMeters: distTa,
        type: selectedNearby.type,  
        aircraftIcon: selectedNearby.aircraftIcon || '2.png',
        callsign: selectedNearby.callsign || '',
      };
    } else {
      setConflict(null);
       setSelected(prev =>
      Date.now() < selectedHoldUntilRef.current ? prev : null
      );
    }

    setLocalWarning(nuevoWarningLocal);

    if (holdTimerRef.current || Date.now() < blockUpdateUntil.current) return;


    const prioridades = { RA_HIGH: 3, RA_LOW: 2, TA: 1 };

    // Si no hay warnings, limpiamos
    if (!nuevoWarningLocal && !backendWarning) {
      setPrioritizedWarning(null);
      return;
    }

    // Si solo hay local
    if (nuevoWarningLocal && !backendWarning) {
      if (nuevoWarningLocal.alertLevel === 'TA') {
        setPrioritizedWarning(nuevoWarningLocal);
        maybeEmitWarning(nuevoWarningLocal);
        return;
      }
      if (holdTimerRef.current && nuevoWarningLocal.alertLevel.startsWith('RA')) return;
      setPrioritizedWarning(nuevoWarningLocal);
      maybeEmitWarning(nuevoWarningLocal);
      return;
    }

    // Si solo hay backend
    if (!nuevoWarningLocal && backendWarning) {
      if (backendWarning.alertLevel === 'TA') {
        setPrioritizedWarning(backendWarning);
        maybeEmitWarning(backendWarning);
        return;
      }
      if (holdTimerRef.current && backendWarning.alertLevel.startsWith('RA')) return;
      setPrioritizedWarning(backendWarning);
      maybeEmitWarning(backendWarning);
      return;
    }

    // Si llegamos aquí, ambos existen
    const localPriority = prioridades[nuevoWarningLocal!.alertLevel];
    const backendPriority = prioridades[backendWarning!.alertLevel];

    if (localPriority > backendPriority) {
      if (nuevoWarningLocal!.alertLevel === 'TA' || !holdTimerRef.current) {
        setPrioritizedWarning(nuevoWarningLocal!);
        maybeEmitWarning(nuevoWarningLocal!);   // ⬅️ AÑADIDO
      }
    } else if (backendPriority > localPriority) {
      if (backendWarning!.alertLevel === 'TA' || !holdTimerRef.current) {
        setPrioritizedWarning(backendWarning!);
        maybeEmitWarning(backendWarning!);      // ⬅️ AÑADIDO
      }
    } else {
      const localTime = nuevoWarningLocal!.timeToImpact || Infinity;
      const backendTime = backendWarning!.timeToImpact || Infinity;
      const ganador = localTime < backendTime ? nuevoWarningLocal! : backendWarning!;
      if (ganador.alertLevel === 'TA' || !holdTimerRef.current) {
        setPrioritizedWarning(ganador);
        maybeEmitWarning(ganador);              // ya lo tenías acá ✅
      }
    }



    // Visual update
    const updatedTraffic = trafficWithoutMe.map((plane) => {
      if (selectedConflict && plane.id === selectedConflict.id) {
        return { ...plane, alertLevel: selectedConflictLevel as 'RA_LOW' | 'RA_HIGH' };
      } else if (selectedNearby && plane.id === selectedNearby.id) {
        return { ...plane, alertLevel: 'TA' as 'TA'};
      } else {
        return { ...plane, alertLevel: 'none' as 'none' };
      }
    });

    const isEqual = JSON.stringify(updatedTraffic) === JSON.stringify(trafficWithoutMe);
    if (!isEqual) {
      setPlanes([...updatedTraffic]);
    }
  }, [planes, myPlane, backendWarning]);

  useEffect(() => {
    if (!username) return;

    socketRef.current = socket;
    const s = socketRef.current;
    // Si el socket está desconectado (porque saliste de Radar antes), reconectalo
    if (s && !s.connected) {
      s.connect();
    }


    s.on('connect', () => {
      console.log('🔌 Conectado al servidor WebSocket');
      s.emit('get-traffic'); // <-- pedir tráfico ni bien conecta
      s.emit('airfield-get');// 👉 pedir pista actual al backend
      s.emit('runway-get'); // 👉 sincronizar estado de pista al conectar

    });

    s.on('conflicto', (data: any) => {
      console.log('⚠️ Conflicto recibido vía WebSocket:', data);
      const matchingPlane = planes.find(p => p.id === data.name || p.name === data.name);
      if (!matchingPlane) return;

      const distNow =
      typeof data.distance === 'number'
      ? data.distance
      : getDistance(myPlane.lat, myPlane.lon, matchingPlane.lat, matchingPlane.lon);

      // persistí la última distancia “oficial” que viene del emisor
      backendDistanceRef.current[matchingPlane.id] = distNow;

            // si el warning fijado es este mismo avión, refrescar al toque
      setPrioritizedWarning(prev =>
        prev && prev.id === matchingPlane.id
          ? { ...prev, distanceMeters: distNow }
          : prev
      );

      const enrichedWarning: Warning = {
        id: matchingPlane.id,
        name: matchingPlane.name,
        lat: matchingPlane.lat,
        lon: matchingPlane.lon,
        alt: matchingPlane.alt,
        heading: matchingPlane.heading,
        speed: matchingPlane.speed,
        alertLevel: data.type === 'RA' ? 'RA_LOW' : 'TA',
        timeToImpact: data.timeToImpact ?? 999,  // ✅ usar lo que vino del avión emisor
        distanceMeters: distNow, // ← usa lo que mandó el emisor
        aircraftIcon: matchingPlane.aircraftIcon,
        callsign: matchingPlane.callsign,
      };


      setWarnings(prev => ({
        ...prev,
        [enrichedWarning.id]: enrichedWarning,
      }));

      setBackendWarning(enrichedWarning);

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
      setRunwayState(payload);
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

        const data = {
          name: username,
          latitude: newLat,
          longitude: newLon,
          alt: prev.alt,
          heading: prev.heading,
          type: aircraftModel,
          // 👇 mantenemos km/h al enviar (consistente con el resto del sistema)
          speed: prev.speed,
          callsign: callsign || '',
          aircraftIcon: aircraftIcon || '2.png',
        };

        s.emit('update', data);

        return { ...prev, lat: newLat, lon: newLon };
      });
    } else {
      (async () => {
        try {
          const { coords } = await Location.getCurrentPositionAsync({});
          const speedKmh = coords.speed ? coords.speed * 3.6 : 0;

          const data = {
            name: username,
            latitude: coords.latitude,
            longitude: coords.longitude,
            alt: coords.altitude || 0,
            heading: coords.heading || 0,
            type: aircraftModel,
            // 👇 enviamos en km/h para ser consistentes
            speed: speedKmh,
            callsign,
            aircraftIcon: aircraftIcon || '2.png',
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


  useEffect(() => {
    if (!myPlane || traffic.length === 0) return;

    const trafficWithoutMe = traffic.filter(p => p.id !== myPlane.id);

    const timeSteps = Array.from({ length: 36 }, (_, i) => (i + 1) * 5);
    let selectedConflict: Plane | null = null;
    let selectedConflictLevel: 'RA_HIGH' | 'RA_LOW' | undefined = undefined;

    let selectedNearby: Plane | null = null;
    let minTimeToImpact = Infinity;
    let minProxDist = Infinity;

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

    for (const plane of trafficWithoutMe) {
      const distanceNow = getDistance(myPlane.lat, myPlane.lon, plane.lat, plane.lon);

      // TA: tráfico cercano
      if (distanceNow < 3000 && plane.speed > 30) {
        if (distanceNow < minProxDist) {
          selectedNearby = plane;
          minProxDist = distanceNow;
        }
      }

      // RA: trayectorias convergentes
// === RA: trayectorias convergentes (más sensible y robusto) ===

// 1) Distancia futura en 5..180 s
const futureDistances: number[] = [];
for (const t of timeSteps) {
  const myF = getFuturePosition(myPlane.lat, myPlane.lon, myPlane.heading, myPlane.speed, t);
  const thF = getFuturePosition(plane.lat, plane.lon, plane.heading || 0, plane.speed || 0, t);
  futureDistances.push(getDistance(myF.latitude, myF.longitude, thF.latitude, thF.longitude));
}
const minDistance = Math.min(...futureDistances);
const idxMin      = futureDistances.indexOf(minDistance);
const timeOfMin   = timeSteps[idxMin];

const futureAltDelta = Math.abs(myPlane.alt - plane.alt);

// 2) “Acercamiento” simple: distancia a 5s menor que ahora
const currentDistance = getDistance(myPlane.lat, myPlane.lon, plane.lat, plane.lon);
const distance5s  = futureDistances[0] ?? distanceNow;
const closingSoon = distance5s < (distanceNow - 15); // margen 15 m

// 3) Cono de RA: bearing ahora y en el punto de mínimo
const bearingDeg = (lat1:number, lon1:number, lat2:number, lon2:number) => {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  const b = (Math.atan2(y, x) * 180) / Math.PI;
  return (b + 360) % 360;
};
const myAtMin    = getFuturePosition(myPlane.lat, myPlane.lon, myPlane.heading, myPlane.speed, timeOfMin);
const theirAtMin = getFuturePosition(plane.lat, plane.lon, plane.heading || 0, plane.speed || 0, timeOfMin);

const diffNow = (() => {
  const bNow = bearingDeg(myPlane.lat, myPlane.lon, plane.lat, plane.lon);
  const d = Math.abs(((myPlane.heading - bNow + 540) % 360) - 180);
  return d;
})();
const diffAtMin = (() => {
  const bMin = bearingDeg(myAtMin.latitude, myAtMin.longitude, theirAtMin.latitude, theirAtMin.longitude);
  const d = Math.abs(((myPlane.heading - bMin + 540) % 360) - 180);
  return d;
})();
const withinCone = (diffNow <= RA_CONE_DEG) || (diffAtMin <= RA_CONE_DEG);

// 4) Criterio RA final
if (
  minDistance < RA_MIN_DIST_M &&
  futureAltDelta <= RA_VSEP_MAX_M &&
  closingSoon &&
  withinCone
) {
  if (timeOfMin < RA_HIGH_TTI_S && timeOfMin < minTimeToImpact) {
    selectedConflict = plane;
    selectedConflictLevel = 'RA_HIGH';
    minTimeToImpact = timeOfMin;
  } else if (timeOfMin < RA_LOW_TTI_S && selectedConflictLevel !== 'RA_HIGH') {
    selectedConflict = plane;
    selectedConflictLevel = 'RA_LOW';
    minTimeToImpact = timeOfMin;
  }
}


      // 🟢 Guardar distancia actual para la próxima iteración
      lastDistanceRef.current[plane.id] = currentDistance;
    }

    // Limpiar conflictos si no hay ninguno nuevo
    if (!selectedConflict && !selectedNearby) {
      if (conflict !== null) setConflict(null);
        setSelected(prev =>
         Date.now() < selectedHoldUntilRef.current ? prev : null
      );
    } else if (selectedConflict && selectedConflictLevel) {
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
    } else if (selectedNearby) {
      setSelected({ ...selectedNearby, alertLevel: 'TA' });
        setSelected(prev =>
      Date.now() < selectedHoldUntilRef.current ? prev : null
      );
    }

    // Estado visual (marcar los íconos)
    const updatedTraffic = trafficWithoutMe.map((plane) => {
      if (selectedConflict && plane.id === selectedConflict.id) {
        return { ...plane, alertLevel: selectedConflictLevel as 'RA_LOW' | 'RA_HIGH' };
      } else if (selectedNearby && plane.id === selectedNearby.id) {
        return { ...plane, alertLevel: 'TA' as 'TA' };
      } else {
        return { ...plane, alertLevel: 'none' as 'none' };
      }
    });

    const isEqual = JSON.stringify(updatedTraffic) === JSON.stringify(trafficWithoutMe);
    if (!isEqual) {
      setPlanes([...updatedTraffic]);
    }
  }, [myPlane, traffic]);

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

  // Solo RA tiene hold de 6s
  if (prioritizedWarning.alertLevel === 'RA_LOW' || prioritizedWarning.alertLevel === 'RA_HIGH') {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    blockUpdateUntil.current = Date.now() + 6000;

    holdTimerRef.current = setTimeout(() => {
      setSelectedWarning(null);
      setPrioritizedWarning(null);
      holdTimerRef.current = null;
      lastSentWarningRef.current = null; // <-- reset
    }, 6000);
  }
  // TA no setea hold (puede ser preempted por RA)
  }, [prioritizedWarning?.id, prioritizedWarning?.alertLevel]);

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (taDebounceRef.current) clearTimeout(taDebounceRef.current);
    };
  }, []);


  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
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
        <Marker
          coordinate={{ latitude: myPlane.lat, longitude: myPlane.lon }}
          anchor={{ x: 0.5, y: 1 }}
          rotation={myPlane.heading}
          flat
        >
          <Image
            source={getOwnPlaneIcon(aircraftIcon)}
            style={{ width: 35, height: 40, marginRight: 1 }}
            resizeMode="contain" //
          />
        </Marker>

        {planes
          .filter(plane => plane.id !== username)
          .map((plane) => {
            console.log('plane', plane.id, 'alertLevel', plane.alertLevel);
            return (
              <Marker
                key={plane.id}
                coordinate={{ latitude: plane.lat, longitude: plane.lon }}
                anchor={{ x: 0.5, y: 0.5 }}
                rotation={plane.heading}
                flat
                onPress={() => {
                  setSelected(plane);

                  const warning = warnings[plane.id];

                  const isPureInfo =
                  !warning &&
                  (plane.alertLevel === 'none' || !plane.alertLevel);
                  // si el tap es informativo, holdeamos 5s
                  selectedHoldUntilRef.current = isPureInfo ? Date.now() + 5000 : 0;
                                  
                  if (warning) {
                    priorizarWarningManual(warning);
                    maybeEmitWarning(warning);       // suma
                  } else if (
                    plane.alertLevel === 'TA' ||
                    plane.alertLevel === 'RA_LOW' ||
                    plane.alertLevel === 'RA_HIGH'
                  ) {
                    priorizarWarningManual({
                      
                      alertLevel: plane.alertLevel,
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
                    });
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
                  }, 5000); // ⬅️ 5s
                  }


                }}
              >
                <Image
                  source={getRemotePlaneIcon(
                    plane.aircraftIcon || plane.type || '2.png',
                    plane.alertLevel
                  )}
                  style={{ width: 30, height: 30 }}
                  resizeMode="contain"
                />
              </Marker>
            );
          })}

                  {/* === RUNWAY (Airfield) === */}
          {A_runway && B_runway && (
            <Polyline coordinates={[A_runway, B_runway]} strokeColor="black" strokeWidth={3} />
          )}
          {A_runway && (
            <Marker coordinate={A_runway} title={`Cabecera A ${rw?.identA || ''}`}>
              <View style={{ backgroundColor: '#2196F3', padding: 2, borderRadius: 10, minWidth: 20, alignItems: 'center' }}>
                <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 10 }}>A</Text>
              </View>
            </Marker>
          )}
          {B_runway && (
            <Marker coordinate={B_runway} title={`Cabecera B ${rw?.identB || ''}`}>
              <View style={{ backgroundColor: '#E53935', padding: 2, borderRadius: 10, minWidth: 20, alignItems: 'center' }}>
                <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 10 }}>B</Text>
              </View>
            </Marker>
          )}
          {runwayMid && (
            <Marker
              coordinate={runwayMid}
              title={`${rw?.identA ?? 'RWY'}`}
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
          {/* === FIN RUNWAY === */}

        <Polyline coordinates={track} strokeColor="blue" strokeWidth={2} />
      </MapView>

      <View style={styles.controlsBox}>
        <Text style={styles.label}>✈️ heading: {myPlane.heading.toFixed(0)}°</Text>
        <Slider minimumValue={0} maximumValue={359} step={1} value={myPlane.heading} onValueChange={val => setMyPlane(prev => ({ ...prev, heading: val }))} />
        <Text style={styles.label}>🛫 Altitud: {myPlane.alt.toFixed(0)} m</Text>
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

        {/* === RUNWAY: botón para abrir el panel === */}
        <TouchableOpacity
          onPress={() => {
            setRunwayPanelOpen(true);
            // sincronizamos al abrir
            socketRef.current?.emit('airfield-get');
            socketRef.current?.emit('runway-get');
          }}
          style={{
            position: 'absolute',
            bottom: Platform.OS === 'android' ? 170 : 140, // por encima de tus botones
            right: 18,
            paddingHorizontal: 14,
            paddingVertical: 10,
            backgroundColor: 'white',
            borderRadius: 12,
            elevation: 3,
            zIndex: 9999
          }}
        >
          <Text style={{fontWeight:'600'}}>Pista</Text>
        </TouchableOpacity>


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



{/* === RUNWAY: Cartel de Pista (sheet) === */}
{runwayPanelOpen && (
  <View
    pointerEvents="box-none"
    style={{
      position:'absolute', left:0, right:0, bottom:0,
      backgroundColor:'#fff',
      borderTopLeftRadius:16, borderTopRightRadius:16,
      padding:14, elevation:8, zIndex:9999
    }}
  >
    <View style={{flexDirection:'row', justifyContent:'space-between', alignItems:'center', marginBottom:8}}>
      <Text style={{fontSize:16, fontWeight:'700'}}>
        {(runwayState?.airfield?.ident ?? rw?.identA ?? 'Pista')}
        {` — ${runwayState?.airfield?.runwayIdent ?? airfield?.runways?.[0]?.identA ?? ''}`}
      </Text>
      <TouchableOpacity onPress={() => setRunwayPanelOpen(false)}>
        <Text style={{fontSize:18}}>✕</Text>
      </TouchableOpacity>
    </View>

    {/* Estado actual */}
    {runwayState?.state?.inUse ? (
      <Text style={{marginBottom:6}}>
        En uso: {runwayState.state.inUse.action === 'landing' ? 'Aterrizando' : 'Despegando'} — {runwayState.state.inUse.name} ({runwayState.state.inUse.callsign || '—'})
      </Text>
    ) : (
      <Text style={{marginBottom:6}}>Pista libre</Text>
    )}

    {/* Acciones */}
    <View style={{flexDirection:'row', gap:10, marginBottom:8, flexWrap:'wrap'}}>
      <TouchableOpacity
        onPress={defaultActionForMe() === 'land' ? requestLanding : () => requestTakeoff(false)}
        style={{backgroundColor:'#111', paddingHorizontal:12, paddingVertical:10, borderRadius:10}}
      >
        <Text style={{color:'#fff', fontWeight:'600'}}>
          Solicitar {defaultActionForMe() === 'land' ? 'Aterrizaje' : 'Despegue'}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={cancelMyRequest}
        style={{backgroundColor:'#eee', paddingHorizontal:12, paddingVertical:10, borderRadius:10}}
      >
        <Text>Cancelar</Text>
      </TouchableOpacity>
    </View>

    {/* Despegue: listo en cabecera + ocupar/liberar */}
    <View style={{flexDirection:'row', gap:10, marginBottom:10, flexWrap:'wrap'}}>
      <TouchableOpacity
        onPress={() => requestTakeoff(true)}
        style={{borderWidth:1, borderColor:'#ccc', paddingHorizontal:12, paddingVertical:10, borderRadius:10}}
      >
        <Text>Estoy en cabecera (listo)</Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => markRunwayOccupy('takeoff')}
        style={{borderWidth:1, borderColor:'#ccc', paddingHorizontal:12, paddingVertical:10, borderRadius:10}}
      >
        <Text>Ocupar pista (despegue)</Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => markRunwayOccupy('landing')}
        style={{borderWidth:1, borderColor:'#ccc', paddingHorizontal:12, paddingVertical:10, borderRadius:10}}
      >
        <Text>Ocupar pista (aterrizaje)</Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={markRunwayClear}
        style={{borderWidth:1, borderColor:'#ccc', paddingHorizontal:12, paddingVertical:10, borderRadius:10}}
      >
        <Text>Liberar pista</Text>
      </TouchableOpacity>
    </View>

    {/* Turnos de aterrizaje */}
    <Text style={{fontWeight:'600', marginBottom:4}}>Turnos de aterrizaje (ETA / holding):</Text>
    {(runwayState?.state?.landings ?? []).map((l:any, i:number) => (
      <Text key={l.name ?? i}>
        {i+1}. {l.name} {l.emergency ? '[EMERGENCIA] ' : ''}{(l.type||'').toUpperCase().includes('GLIDER') && (l.altitude<300 ? '[GLIDER<300m] ' : '[GLIDER] ')}
        — ETA {l.etaSec ? Math.round(l.etaSec/60)+' min' : '—'} {l.holding ? '(HOLD)' : ''}
      </Text>
    ))}

    {/* Despegues */}
    <Text style={{fontWeight:'600', marginTop:10, marginBottom:4}}>Despegues:</Text>
    {(runwayState?.state?.takeoffs ?? []).map((t:any, i:number) => (
      <Text key={t.name ?? i}>
        {i+1}. {t.name} — {t.ready ? 'Listo en cabecera' : 'En rodaje'} — espera {t.waitedMin ?? 0} min
      </Text>
    ))}

    {/* Próximos slots */}
    <Text style={{fontWeight:'600', marginTop:10, marginBottom:4}}>Próximos slots:</Text>
    {(runwayState?.state?.timeline ?? []).slice(0,5).map((s:any, i:number) => (
      <Text key={i}>
        {s.action === 'landing' ? 'Aterrizaje' : 'Despegue'} — {s.name} a las {new Date(s.at).toLocaleTimeString()}
      </Text>
    ))}

    {/* Instrucción estándar */}
    <View style={{marginTop:12, padding:10, backgroundColor:'#f3f3f3', borderRadius:12}}>
      <Text style={{fontWeight:'600', marginBottom:4}}>Instrucciones de espera</Text>
      <Text>Si su aterrizaje no es el primero y su ETA cae dentro de 5 min del anterior, haga un círculo a la derecha y alinéese con el lado derecho de la pista antes del giro final.</Text>
    </View>
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

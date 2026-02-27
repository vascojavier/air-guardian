import React, { useEffect, useState, useRef, useMemo } from 'react';
import type { Socket } from "socket.io-client";
import { useTranslation } from "react-i18next";

import { useSettings } from "../context/SettingsContext";
import { router } from "expo-router";
import type { OpsState } from '../types/OpsState';

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
import { socket } from '../utils/socket';
//import { calcularWarningLocalMasPeligroso } from '../data/WarningSelector';
import { Warning } from '../data/FunctionWarning';
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Airfield } from '../types/airfield';
import * as Speech from 'expo-speech';
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
            { scale: 0.4 },
          ],
          backfaceVisibility: 'hidden',
        }}
        resizeMode="contain"
      />

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

function inRadiusM(
  p: { lat: number; lon: number },
  t: { latitude: number; longitude: number } | null,
  r: number
) {
  if (!t) return false;
  const d = getDistance(p.lat, p.lon, t.latitude, t.longitude);
  return Number.isFinite(d) && d <= r;
}


function formatDistance(meters: number, settings: any) {
  if (!Number.isFinite(meters)) return "—";

  const unit = settings?.distanceUnit ?? "m"; // "m" | "km" | "nm" | "mi"
  switch (unit) {
    case "km": return `${(meters / 1000).toFixed(meters < 1000 ? 2 : 1)} km`;
    case "nm": return `${(meters / 1852).toFixed(1)} NM`;
    case "mi": return `${(meters / 1609.344).toFixed(1)} mi`;
    default:   return `${Math.round(meters)} m`;
  }
}

function formatAltitude(metersMSL: number, settings: any) {
  if (!Number.isFinite(metersMSL)) return "—";

  const unit = settings?.altitudeUnit ?? "m"; // "m" | "ft"
  if (unit === "ft") return `${Math.round(metersMSL * 3.28084)} ft`;
  return `${Math.round(metersMSL)} m`;
}

function formatSpeed(kmh: number, settings: any) {
  if (!Number.isFinite(kmh)) return "—";

  const unit = settings?.speedUnit ?? "kmh"; // "kmh" | "kt" | "mph"
  switch (unit) {
    case "kt":  return `${Math.round(kmh / 1.852)} kt`;
    case "mph": return `${Math.round(kmh / 1.609344)} mph`;
    default:    return `${Math.round(kmh)} km/h`;
  }
}


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
  const didRandomizeOnEnterRef = useRef(false);
  const sendIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isFocusedRef = useRef(false);
  const [opsStates, setOpsStates] = useState<Record<string, OpsState>>({});
  const arrivedSinceRef = useRef<Record<string, number>>({});
  const ARRIVE_DWELL_MS = 1500; // 1.5s estable dentro del radio
  const ARRIVE_R_M = 500;       // radio para "llegué" (ajustable)
  const B_STATES = Array.from({ length: 30 }, (_, i) => `B${i + 1}` as OpsState);
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || "en").toLowerCase();
  const ttsLang =
    lang.startsWith("es") ? "es-ES" :
    lang.startsWith("en") ? "en-US" :
    // fallback: dejá que el sistema elija
    undefined;
  const { settings } = useSettings();
  const zoomDebounceRef = useRef<NodeJS.Timeout|null>(null);
  const gpsWatchRef = useRef<Location.LocationSubscription | null>(null);
  const gpsBusyRef = useRef(false);
  const isProgrammaticMoveRef = useRef(false);
  const lastCenterAtRef = useRef(0);
  const lastCenterPosRef = useRef<{lat:number; lon:number} | null>(null);
  // ✅ evita setState repetidos cuando el “winner” es el mismo
  const lastWinnerRef = useRef<string>("");
  const lastPlanesSigRef = useRef<string>(""); // para setPlanes
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const socketRef = useRef<ReturnType<typeof io> | null>(null);
  const freezeBeaconEngineRef = useRef<boolean>(false);
  const lastSentOpsRef = useRef<string | null>(null);
  const assignedRef = useRef<string | null>(null);
  const opsTargetsRef = useRef<Record<string, { fix:string; lat:number; lon:number }> | null>(null);
  const lastApronStopSentRef = useRef(0);
  const runwayOccupiedSentRef = useRef(false);
  




  // (opcional) si querés permitir update SOLO de distancia sin re-render grande
  const lastWinnerDistanceRef = useRef<number>(NaN);


  // === SETTINGS -> constantes locales (evita "settings is not defined") ===
  const RA_HIGH_TTI_S_LOCAL =
    typeof settings?.ra1TimeSec === "number" && settings.ra1TimeSec > 0
      ? settings.ra1TimeSec
      : RA_HIGH_TTI_S;

  const RA_LOW_TTI_S_LOCAL =
    typeof settings?.ra3TimeSec === "number" && settings.ra3TimeSec > 0
      ? settings.ra3TimeSec
      : RA_LOW_TTI_S;

  const RA_MIN_DIST_M_LOCAL =
    typeof settings?.raMinDistMeters === "number" && settings.raMinDistMeters > 0
      ? settings.raMinDistMeters
      : RA_MIN_DIST_M;

  const TA_RADIUS_M_LOCAL =
    typeof settings?.nearbyTrafficMeters === "number" && settings.nearbyTrafficMeters > 0
      ? settings.nearbyTrafficMeters
      : TA_RADIUS_M;

  const isMotorized = useMemo(() => {
    const t = String(aircraftModel || '').toUpperCase();

    // Si tu lista real usa otras palabras, agregalas acá
    if (
      t.includes('GLIDER') ||
      t.includes('PLANEADOR') ||
      t.includes('SAILPLANE') ||
      t.includes('SIN MOTOR')
    ) return false;

    return true;
  }, [aircraftModel]);

const refreshPinnedDistance = () => {
  setPrioritizedWarning((prev: Warning | null) => {
    if (!prev) return prev;

    const backendDist = backendDistanceRef.current[prev.id];
    let freshDist: number | undefined;

    if (typeof backendDist === 'number' && Number.isFinite(backendDist)) {
      freshDist = backendDist;
    } else {
      const p = planesRef.current.find(pl => pl.id === prev.id);
      const mp = myPlaneRef.current;
      if (p && mp) {
        freshDist = getDistance(mp.lat, mp.lon, p.lat, p.lon);
      }
    }

    if (typeof freshDist !== 'number' || !Number.isFinite(freshDist)) return prev;

    const last = lastPinnedDistRef.current;
    if (last != null && Math.abs(freshDist - last) < 10) return prev; // ✅ evita re-render

    lastPinnedDistRef.current = freshDist;
    return { ...prev, distanceMeters: freshDist };
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

  const [runwayState, setRunwayState] = useState<null | {
    airfield?: any;
    state?: {
      landings?: any[];
      takeoffs?: any[];
      inUse?: any | null;
      timeline?: any[];
      serverTime?: number;

      // ✅ NUEVO (backend truth)
      assignedOps?: Record<string, string>;
      opsTargets?: Record<string, { fix?: string; lat: number; lon: number }>;
    };
  }>(null);

function canConfirmRunwayOccupiedNow(): boolean {
  const assigned = getBackendAssignedForMe();   // 'FINAL'|'B1'|'A_TO_Bx'|...

  // Si estás en flujo takeoff, no confirmes occupied por touchdown-like
  if (takeoffRequestedRef.current) return false;

  // Si vos pediste aterrizar, OK
  if (landingRequestedRef.current) return true;

  // Si el backend te asignó FINAL o B1, OK
  if (assigned === 'FINAL' || assigned === 'B1') return true;

  return false;
}


function getBackendAssignedForMe(): string | null {
  return getBackendAssignedForMe2();
}


function distanceMeters(lat1:number, lon1:number, lat2:number, lon2:number) {
  // Haversine rápido (o usá el tuyo si ya existe)
  const R = 6371000;
  const toRad = (d:number) => d * Math.PI / 180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function myNameKeysFirstMatch<T>(obj: Record<string,T> | null | undefined): T | null {
  if (!obj) return null;
  for (const k of keysForMe()) {
    const v = obj[k];
    if (v) return v;
  }
  return null;
}

function maybeConfirmApronStop(socket:any) {
  const me = myPlaneRef.current;
  if (!me) return;

  const targets = opsTargetsRef.current;
  const t = myNameKeysFirstMatch(targets);
  if (!t || t.fix !== 'APRON') return;

  const d = distanceMeters(me.lat, me.lon, t.lat, t.lon);
  const speed = me.speed ?? 0;

  const ARRIVE_APRON_M = 60;   // ✅ GPS realista
  const STOP_SPEED_KMH = 5;    // ✅ “casi detenido”
  const now = Date.now();
  if (now - lastApronStopSentRef.current < 5000) return;

  if (d <= ARRIVE_APRON_M && speed <= STOP_SPEED_KMH) {
    console.log('[OPS] arrived APRON → sending APRON_STOP', { d, speed });
    socket.emit('ops/state', { name: me.name, state: 'APRON_STOP' });
    lastApronStopSentRef.current = now;
  }
}


function maybeConfirmHoldShort(socket: any) {
  const me = myPlaneRef.current;
  if (!me) return;

  const targets = opsTargetsRef.current;
  const t = myNameKeysFirstMatch(targets);
  if (!t || t.fix !== 'HOLD_SHORT') return;

  const d = distanceMeters(me.lat, me.lon, t.lat, t.lon);
  const speed = me.speed ?? 0;

  const ARRIVE_HS_M = 40;     // 30–60m
  const SLOW_KMH = 10;        // “llegando / frenando”
  if (d <= ARRIVE_HS_M && speed <= SLOW_KMH) {
    // IMPORTANTE: misma key que update
    socket.emit('ops/state', { name: username, state: 'HOLD_SHORT' });
  }
}

function canConfirmBeaconNow(fix: string): boolean {
  // fix = 'B2','B17',...
  const assigned = getBackendAssignedForMe(); // 'A_TO_B17' etc

  if (!/^B\d+$/.test(fix)) return false;

    // ✅ si el backend ya te asignó FINAL, no confirmes beacons
  if (assigned === 'FINAL') return false;

  // Debe haber asignación tipo A_TO_Bx
  if (!assigned || !assigned.startsWith('A_TO_')) return false;

  const assignedFix = assigned.replace('A_TO_', ''); // 'B17'
  if (assignedFix !== fix) return false;

  return true;
}



const isBeaconOps = (s: any): s is OpsState =>
typeof s === 'string' && /^B\d+$/.test(s);


function emitOpsNow(next: OpsState, source: string = 'UNKNOWN', extra?: Record<string, any>) {
  const now = Date.now();

  

  // ✅ UNA sola identidad consistente (la misma que usa el backend en assignedOps)
  const meKey = (myPlaneRef.current?.id || myPlane?.id || username) as string;

  const stAny: any = runwayState?.state;
  const assigned2 = stAny?.assignedOps?.[meKey]; // 'FINAL' | 'A_TO_Bx' | ...

  // ✅ Si backend asignó FINAL, frontend NO puede cambiar OPS
  //    ÚNICA excepción: RUNWAY_OCCUPIED (touchdown)
  if (assigned2 === 'FINAL' && next !== 'RUNWAY_OCCUPIED') {
    console.log('[OPS] BLOCKED by FINAL lock (backend).', { next, source, assigned2, meKey });
    return;
  }

  // ❌ Nunca confirmar FINAL desde frontend (backend-only)
  if (FRONTEND_FORBIDDEN_OPS.has(next)) {
    console.log('[OPS] Ignored FINAL (backend-only).', { next, source });
    return;
  }

  if (!FRONTEND_ALLOWED_OPS.has(next) && !isBeaconOps(next)) {
    console.log('[OPS] Ignored (not allowed):', { next, source });
    return;
  }

  if (
    lastOpsStateRef.current === next &&
    (now - (lastOpsStateTsRef.current || 0)) < 2000
  ) {
    return;
  }

  lastOpsStateRef.current = next;
  lastOpsStateTsRef.current = now;

  const st = runwayState?.state as any;
  const assigned = st?.assignedOps?.[meKey];
  const reported = st?.reportedOpsStates?.[meKey];
  const backendOps = st?.opsStates?.[meKey];

  const ctx = {
    t: new Date(now).toISOString(),
    next,
    source,
    meKey,
    assigned,
    reported,
    backendOps,
    ...(extra || {}),
  };

  console.log('[OPS] emit →', ctx);

  socketRef.current?.emit('ops/state', {
    // ✅ IMPORTANTÍSIMO: emitir con la misma key
    name: meKey,
    state: next,
    aux: {
      source,
      ...(extra || {}),
      id: myPlane?.id,
      callsign: myPlane?.callsign,
      planeName: myPlane?.name,
    },
  });
}



  function emitOpsBeacon(label: `B${number}`, phase: 'TO' | 'AT') {
  const st = (phase === 'TO') ? (`A_TO_${label}` as OpsState) : (label as OpsState);
  emitOpsNow(st);
  }


  const [zoom, setZoom] = useState({ latitudeDelta: 0.1, longitudeDelta: 0.1 });
  const [planes, setPlanes] = useState<Plane[]>([]);
  const [myPlane, setMyPlane] = useState<Plane>({
    id: username,
    name: username, // estable
    lat: 51.95,
    lon: 4.45,
    alt: 300,
    heading: 90,
    speed: 40,
  });

  useEffect(() => {
  planesRef.current = planes;
  }, [planes]);


  // ✅ Ref para leer el último myPlane SIN depender del re-render
    const myPlaneRef = useRef<Plane | null>(null);
    useEffect(() => {
      myPlaneRef.current = myPlane;
    }, [myPlane]);


    // ✅ Tick de cálculo (desacopla cálculo pesado del tick de movimiento)
    const [calcTick, setCalcTick] = useState(0);
    useEffect(() => {
      const id = setInterval(() => setCalcTick(t => t + 1), 2500); // 2–3s
      return () => clearInterval(id);
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
      type: 'RA',
    };

    socket.emit('warning', payload);
  };


useFocusEffect(
  useCallback(() => {
    isFocusedRef.current = true;

    return () => {
      isFocusedRef.current = false;

      // 0) GPS watch (MUY importante)
      try { gpsWatchRef.current?.remove?.(); } catch {}
      gpsWatchRef.current = null;
      gpsBusyRef.current = false;

      // 1) Frenar timers / intervalos
      try { if (sendIntervalRef.current) clearInterval(sendIntervalRef.current as any); } catch {}
      sendIntervalRef.current = null;

      try { if (intervalRef.current) clearInterval(intervalRef.current as any); } catch {}
      intervalRef.current = null;

      try { if (holdTimerRef.current) clearTimeout(holdTimerRef.current as any); } catch {}
      holdTimerRef.current = null;

      try { if (taDebounceRef.current) clearTimeout(taDebounceRef.current as any); } catch {}
      taDebounceRef.current = null;

      // 2) Limpiar timeouts
      try { if (hideSelectedTimeout.current) clearTimeout(hideSelectedTimeout.current as any); } catch {}
      hideSelectedTimeout.current = null;

      // 3) Reset TOTAL de refs “pegadas” (incluye TIERRA)
      landingRequestedRef.current = false;
      takeoffRequestedRef.current = false;
      finalLockedRef.current = false;

      apronLatchRef.current = false;
      runwayOccupiedSentRef.current = false;   // 👈 clave para que no quede “latcheado”
      lastApronStopSentRef.current = 0;

      iAmOccupyingRef.current = null;
      landClearShownRef.current = false;

      lastOpsStateRef.current = null;
      lastOpsStateTsRef.current = 0;

      selectedHoldUntilRef.current = 0;

      assignedRef.current = null;
      opsTargetsRef.current = null;
      freezeBeaconEngineRef.current = false;
      lastSentOpsRef.current = null;

      arrivedSinceRef.current = {};
      lastDistanceRef.current = {};
      backendDistanceRef.current = {};
      lastWarningTimeRef.current = {};
      raHoldUntilRef.current = {};
      activeRAIdRef.current = null;

      // 4) Reset TOTAL de UI local
      try { setSelected(null); } catch {}
      try { setConflict(null); } catch {}
      try { setBackendWarning(null); } catch {}
      try { setLocalWarning(null); } catch {}
      try { setPrioritizedWarning(null); } catch {}
      try { setWarnings({}); } catch {}
      try { setTraffic([]); } catch {}
      try { setBanner(null); } catch {}

      // 5) Reset runway-state local (clave para que NO redibuje línea al re-entrar)
      try { setRunwayState(null as any); } catch {}
      try { setSlots([]); } catch {}
      try { setNavTargetSafe(null); } catch {}

      // 6) Avisar al backend + limpiar socket para NO duplicar handlers al volver
      const s = socketRef.current;
      if (s) {
        try { s.emit('leave', { name: username }); } catch {}

        // evita “handlers duplicados” al reentrar
        try { s.off('runway-state'); } catch {}
        try { s.off('traffic-update'); } catch {}
        try { s.off('conflicto'); } catch {}
        try { s.off('initial-traffic'); } catch {}
        try { s.off('sequence-update'); } catch {}

        // recomendado si ExpoGo se cuelga: desconectar y reconectar al entrar
        try { s.disconnect(); } catch {}
      }
      socketRef.current = null;
    };
  }, [username])
);


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
      hardResetRadar();
    }, [username]);

  const [track, setTrack] = useState<LatLon[]>([]);
  const [traffic, setTraffic] = useState<Plane[]>([]);

    useEffect(() => {
    const ids = new Set(traffic.map(t => t.id));

    // 1) si el priorizado ya no está, limpiar tarjeta + limpiar bloqueo
    setPrioritizedWarning(prev => {
      if (prev && !ids.has(prev.id)) {
        delete lastWarningTimeRef.current[prev.id];
        return null;
      }
      return prev;
    });

    // 2) podar selected/conflict si desaparecieron
    setSelected(prev => (prev && !ids.has(prev.id) ? null : prev));
    setConflict(prev => (prev && !ids.has(prev.id) ? null : prev));

    // 3) podar warnings que ya no correspondan
    setWarnings(prev => {
      let changed = false;
      const next: { [k: string]: Warning } = {};
      for (const [id, w] of Object.entries(prev)) {
        if (ids.has(id)) next[id] = w;
        else changed = true;
      }
      return changed ? next : prev; // evita re-render si no cambió nada
    });
  }, [traffic]);


  // Secuencia/slots (de sequence-update)
  const [slots, setSlots] = useState<Array<{opId:string; type:'ARR'|'DEP'; name:string; startMs:number; endMs:number; frozen:boolean;}>>([]);
  // Target de navegación que llega por ATC (o por tu lógica local)
  const [navTarget, setNavTarget] = useState<LatLon | null>(null);
  const mapRef = useRef<MapView | null>(null);
 
  // ======================
// Emisor único de updates
// ======================
type PosUpdate = {
  lat: number;
  lon: number;
  alt?: number;
  heading?: number;
  speed?: number; // km/h
};

const emitUpdate = (p: PosUpdate) => {
  const s = socketRef.current;
  if (!s || !(s as any).connected) return;
  if (!username) return;

  s.emit('update', {
    name: username,
    latitude: p.lat,
    longitude: p.lon,
    alt: typeof p.alt === 'number' ? p.alt : (myPlaneRef.current?.alt ?? 0),
    heading: typeof p.heading === 'number' ? p.heading : (myPlaneRef.current?.heading ?? 0),
    type: aircraftModel,
    speed: typeof p.speed === 'number' ? p.speed : (myPlaneRef.current?.speed ?? 0),
    callsign: callsign || '',
    aircraftIcon: aircraftIcon || '2.png',
    isMotorized,
  });
  maybeConfirmApronStop(s);
};

  //const isFocusedRef = useRef(false);
  const lastDistanceRef = useRef<Record<string, number>>({});
  const serverATCRef = useRef(false);
  // Candado de turno cuando paso por B1 (FINAL)
  // Se suelta solo si el líder es EMERGENCIA
  const finalLockedRef = useRef(false);
  const lastOpsStateRef = useRef<OpsState | null>(null);
  const lastOpsStateTsRef = useRef<number>(0);
  
  // ✅ Estados que el FRONTEND tiene permitido CONFIRMAR al backend
// ✅ Estados que el FRONTEND tiene permitido CONFIRMAR al backend (sin beacons hardcodeados)
const FRONTEND_ALLOWED_OPS = new Set<OpsState>([
      'APRON_STOP',
      'TAXI_APRON',
      'TAXI_TO_RWY',
      'HOLD_SHORT',
      'RUNWAY_OCCUPIED',
      'RUNWAY_CLEAR',
      'AIRBORNE',
      'LAND_QUEUE',
      ...B_STATES,
]);


// ⚠️ El frontend NO confirma FINAL nunca (backend-only asignación/slot)
const FRONTEND_FORBIDDEN_OPS = new Set<OpsState>(['FINAL']);

  const OPS_DWELL_MS = 4000; // permanecer 4s antes de anunciar cambio
  // Mantener visible el APRON hasta volver a volar
  const apronLatchRef = useRef(false);
  const lastOnRunwayAtRef = useRef<number>(0);
  const planesRef = useRef<Plane[]>([]);
  const lastPinnedDistRef = useRef<number | null>(null);


const navTargetRef = useRef<{ latitude: number; longitude: number } | null>(null);

function setNavTargetSafe(next: { latitude: number; longitude: number } | null) {
  const prev = navTargetRef.current;

  const same =
    (!!prev && !!next &&
      Math.abs(prev.latitude - next.latitude) < 1e-6 &&
      Math.abs(prev.longitude - next.longitude) < 1e-6) ||
    (!prev && !next);

  if (same) return;

  navTargetRef.current = next;
  setNavTarget(next);
}




// === Airfield (pista) ===
const [airfield, setAirfield] = useState<Airfield | null>(null);

// Derivados de la runway activa (si existe)
const rw = airfield?.runways?.[0];

const getLon = (o: any) =>
  typeof o?.lng === "number" ? o.lng :
  typeof o?.lon === "number" ? o.lon :
  typeof o?.longitude === "number" ? o.longitude :
  undefined;

const ftToM = (ft: number) => ft * 0.3048;

const getFieldElevationM = (): number | null => {
  // Preferir airfield (local) y después runwayState (server)
  const af: any = airfield;
  const rsAf: any = runwayState?.airfield;

  const elevM =
    (typeof af?.elevation === "number" ? af.elevation : null) ??
    (typeof af?.elevation_m === "number" ? af.elevation_m : null) ??
    (typeof af?.elevation_ft === "number" ? ftToM(af.elevation_ft) : null) ??
    (typeof rsAf?.elevation === "number" ? rsAf.elevation : null) ??
    (typeof rsAf?.elevation_m === "number" ? rsAf.elevation_m : null) ??
    (typeof rsAf?.elevation_ft === "number" ? ftToM(rsAf.elevation_ft) : null);

  return (typeof elevM === "number" && Number.isFinite(elevM)) ? elevM : null;
};



const A_runway = useMemo(() => {
  const thr = (rw as any)?.thresholdA;
  const lon = getLon(thr);
  return (thr && typeof thr.lat === "number" && typeof lon === "number")
    ? { latitude: thr.lat, longitude: lon }
    : null;
}, [rw]);



const B_runway = useMemo(() => {
  const thr = (rw as any)?.thresholdB;
  const lon = getLon(thr);
  return (thr && typeof thr.lat === "number" && typeof lon === "number")
    ? { latitude: thr.lat, longitude: lon }
    : null;
}, [rw]);

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
  const arr = (rw as any)?.beacons as Array<{name:string; lat:number; lon?:number; lng?:number}> | undefined;
  const b1 = arr?.find(b => (b.name || '').toUpperCase() === 'B1');
  const lon = b1?.lng ?? b1?.lon;
  return (b1 && typeof b1.lat === 'number' && typeof lon === 'number')
    ? { latitude: b1.lat, longitude: lon }
    : null;
}, [rw]);

const beaconB2 = useMemo<LatLon | null>(() => {
  const arr = (rw as any)?.beacons as Array<{name:string; lat:number; lon?:number; lng?:number}> | undefined;
  const b2 = arr?.find(b => (b.name || '').toUpperCase() === 'B2');
  const lon = b2?.lng ?? b2?.lon;
  return (b2 && typeof b2.lat === 'number' && typeof lon === 'number')
    ? { latitude: b2.lat, longitude: lon }
    : null;
}, [rw]);


// === Beacons extra B3, B4... generados extendiendo la línea B2 -> "hacia afuera" ===
// === Beacons extra B3..B30 generados extendiendo la línea B2 -> "hacia afuera" ===
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

  // para colocar B3/B4/... "detrás" de B2, nos vamos al rumbo contrario
  const outbound = (inbound + 180) % 360;

  const result: LatLon[] = [];

  // Queremos B3..B30 => 28 beacons extra
  const MAX_B = 30;
  const count = Math.max(0, MAX_B - 2); // B3..BMAX => MAX-2 items

  let prev = { latitude: beaconB2.latitude, longitude: beaconB2.longitude };

  for (let i = 0; i < count; i++) {
    const next = movePoint(prev.latitude, prev.longitude, outbound, d);
    result.push(next);
    prev = next;
  }

  return result; // index 0 = B3, index 1 = B4, ... index 27 = B30
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

useEffect(() => {
  const me = myPlane?.id || username;
  if (!me) return;

  const st = (runwayState as any)?.state;
  if (!st) return;

  if (freezeBeaconEngineRef.current) return;

  const assigned = getBackendAssignedForMe2() || undefined;   // 'A_TO_B2'|'A_TO_B3'|'B1'|'FINAL'
  const target = getBackendTargetForMe() || undefined;                        // {fix, lat, lon}

  if (!assigned) return;

  // Si el backend ya te ve en B1/FINAL, no “auto-reportes” más aquí.
  // (El backend puede latchear B1 por stReported === 'B1')
  if (assigned === 'B1' || assigned === 'FINAL') return;

  // Sólo reportamos llegada para A_TO_Bx
  if (!assigned.startsWith('A_TO_')) return;

  // Resolvemos el fix (por assigned o por opsTargets)
  const fix =
    (typeof target?.fix === 'string' ? target.fix : null) ??
    (assigned.replace('A_TO_', '') as string); // 'B2','B3','B1'

  // Coordenada del fix (preferir opsTargets; si no, local)
  let fixLL: LatLon | null = null;

  if (typeof target?.lat === 'number' && typeof target?.lon === 'number') {
    fixLL = { latitude: target.lat, longitude: target.lon };
  } else {
    if (fix === 'B1') fixLL = beaconB1;
    else if (fix === 'B2') fixLL = beaconB2;
    else if (fix.startsWith('B')) {
      const n = parseInt(fix.slice(1), 10);
      if (Number.isFinite(n) && n >= 3) {
        fixLL = extraBeacons[n - 3] ?? beaconB2 ?? null;
      }
    }
  }

  if (!fixLL) return;

  // Check dentro de radio + dwell
  const inside = inRadiusM({ lat: myPlane.lat, lon: myPlane.lon }, fixLL, ARRIVE_R_M);
  const key = `${me}:${fix}`;

  if (!inside) {
    delete arrivedSinceRef.current[key];
    return;
  }

  const now = Date.now();
  const since = arrivedSinceRef.current[key] ?? now;
  arrivedSinceRef.current[key] = since;

  if (now - since < ARRIVE_DWELL_MS) return;

  // ✅ Llegué: reportar OPS como 'B#' SOLO si el backend me asignó A_TO_B#
  const report = fix as OpsState; // 'B1'|'B2'|'B3'...

  if (canConfirmBeaconNow(String(report))) {
    emitOpsNow(report, 'ARRIVE_DWELL', { fix });
  } else {
    console.log('[OPS] Skip beacon confirm (not assigned by backend):', {
      report,
      assigned: getBackendAssignedForMe(),
    });
  }

  // Limpieza para no re-disparar
  delete arrivedSinceRef.current[key];

  }, [
    runwayState,
    username,
    myPlane?.id,
    myPlane.lat,
    myPlane.lon,
    beaconB1,
    beaconB2,
    extraBeacons,
  ]);


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

const hardResetRadar = () => {
  // 1) timers
  try {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
    if (taDebounceRef.current) { clearTimeout(taDebounceRef.current); taDebounceRef.current = null; }
  } catch {}

  // 2) bloqueadores / snooze
  blockUpdateUntil.current = 0;
  snoozeUntilRef.current = 0;
  snoozeIdRef.current = null;

  // 3) limpiar caches/refs de warnings
  lastWarningTimeRef.current = {};
  backendDistanceRef.current = {};
  lastDistanceRef.current = {};
  raHoldUntilRef.current = {};
  activeRAIdRef.current = null;
  lastRAIdRef.current = null;
  lastSentWarningRef.current = null;

  // 4) limpiar UI state (lo importante para que no “pegue”)
  setWarnings({});
  setBackendWarning(null);
  setPrioritizedWarning(null);
  setSelectedWarning(null);
  setLocalWarning(null);
  setSelected(null);
  setConflict(null);
  // opcional: si querés limpiar los otros aviones visuales al salir:
  // setPlanes([]);
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
  const altMSL = myPlane?.alt ?? 0;

  // ✅ Elevación del aeródromo en METROS (acepta elevation_ft)
  const elevFromFieldM = getFieldElevationM();

  // si estoy sobre la pista y a baja velocidad, "calibro" referencia de suelo (MSL)
  if (isOnRunwayStrip() && (myPlane?.speed ?? 0) < 80) {
    groundRefAltMSLRef.current = altMSL;
  }

  // Prioridad: elevación del aeródromo (m) → si no, usar ref de suelo calibrada (MSL)
  const refMSL =
    elevFromFieldM != null
      ? elevFromFieldM
      : (groundRefAltMSLRef.current != null ? groundRefAltMSLRef.current : null);

  const agl = refMSL != null ? (altMSL - refMSL) : altMSL; // fallback: MSL si no hay ref
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
    if (nearOther) flashBanner(t("runway.alignRight"), 'align-right');
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

function isPlaneInAssignedOps(p: Plane): boolean {
  const st: any = runwayState?.state;
  const map = st?.assignedOps as Record<string, string> | undefined;
  if (!map) return false;

  for (const k of keysForPlane(p)) {
    if (typeof map[k] === 'string' && map[k]) return true;
  }
  return false;
}

function isPlaneInQueues(p: Plane): boolean {
  const st: any = runwayState?.state;
  const land = Array.isArray(st?.landings) ? st.landings : [];
  const tk   = Array.isArray(st?.takeoffs) ? st.takeoffs : [];

  // landings/takeoffs suelen ser [{name, ...}] — matcheamos por keys
  const names = new Set<string>([
    ...land.map((x: any) => String(x?.name || '')).filter(Boolean),
    ...tk.map((x: any) => String(x?.name || '')).filter(Boolean),
  ]);

  for (const k of keysForPlane(p)) {
    if (names.has(String(k))) return true;
  }
  return false;
}



function getOpsOf(name: string): OpsState | null {
  return opsStates[name] ?? null;
}

type AtcAssigned = string | null; // 'A_TO_Bx' | 'FINAL' | null
type AtcTarget = { fix?: string; lat: number; lon: number } | null;

function keysForMe(): string[] {
  const p = myPlaneRef.current;
  const keys = [
    p?.id,
    p?.name,
    p?.callsign,
    username,
    callsign,
  ].filter(Boolean) as string[];
  return Array.from(new Set(keys.map(String)));
}

function getBackendTargetForMe(): { fix?: string; lat: number; lon: number } | null {
  const st: any = runwayState?.state;
  const map = st?.opsTargets as Record<string, any> | undefined;
  if (!map) return null;

  for (const k of keysForMe()) {
    const v = map[k];
    const lon =
      typeof v?.lon === 'number' ? v.lon :
      typeof v?.lng === 'number' ? v.lng :
      typeof v?.longitude === 'number' ? v.longitude :
      null;

    if (v && typeof v.lat === 'number' && typeof lon === 'number') {
      return { fix: v.fix, lat: v.lat, lon };
    }
  }
  return null;
}

function getBackendAssignedForMe2(): string | null {
  const st: any = runwayState?.state;
  const map = st?.assignedOps as Record<string, string> | undefined;
  if (!map) return null;

  for (const k of keysForMe()) {
    const v = map[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}


function keysForPlane(p: Plane): string[] {
  const keys = [p.id, p.name, p.callsign].filter(Boolean) as string[];
  // único + estable
  return Array.from(new Set(keys.map(String)));
}

// OPS (frontend) que viene dentro de runway-state (reportedOpsStates)


function planeIsInQueue(p: Plane): boolean {
  const st: any = runwayState?.state;
  const land = Array.isArray(st?.landings) ? st.landings : [];
  const tk   = Array.isArray(st?.takeoffs) ? st.takeoffs : [];

  // comparo por keys (id/name/callsign), porque tu sistema usa mezcla
  const keys = new Set(keysForPlane(p));

  const inLand = land.some((x: any) => x?.name && keys.has(String(x.name)));
  if (inLand) return true;

  const inTk = tk.some((x: any) => x?.name && keys.has(String(x.name)));
  return inTk;
}

function planeHasAssignedOps(p: Plane): boolean {
  const st: any = runwayState?.state;
  const asg = st?.assignedOps || null;
  if (!asg) return false;

  for (const k of keysForPlane(p)) {
    if (typeof asg[k] === 'string' && asg[k]) return true;
  }
  return false;
}

/**
 * Regla final: la línea solo existe si:
 * - está en cola (landing/takeoff)  Y
 * - el backend todavía lo tiene asignado (assignedOps)
 */
function shouldShowNavForPlane(p: Plane): boolean {
  return planeIsInQueue(p) && planeHasAssignedOps(p);
}


// ATC (backend) asignación A_TO_Bx / FINAL
function getAssignedOpsOfPlane(p: Plane): AtcAssigned {
  const st: any = runwayState?.state;
  const map = st?.assignedOps as Record<string, string> | undefined;
  if (!map) return null;

  for (const k of keysForPlane(p)) {
    const v = map[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

// Target (backend) fix + lat/lon
function getOpsTargetOfPlane(p: Plane): AtcTarget {
  const st: any = runwayState?.state;
  const map = st?.opsTargets as Record<string, any> | undefined;
  if (!map) return null;

  for (const k of keysForPlane(p)) {
    const v = map[k];
    const lon =
      typeof v?.lon === 'number' ? v.lon :
      typeof v?.lng === 'number' ? v.lng :
      typeof v?.longitude === 'number' ? v.longitude :
      null;

    if (v && typeof v.lat === 'number' && typeof lon === 'number') {
      return { fix: v.fix, lat: v.lat, lon };
    }
  }
  return null;
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

    finalLockedRef.current = false;
    navPhaseRef.current = null;
    prevIdxRef.current = null;


    // “romper” cualquier pegajosidad de tierra por AGL ruidoso
    lastGroundSeenAtRef.current = 0;
    airborneCandidateSinceRef.current = Date.now();

    requestLanding();
    landingRequestedRef.current = true;
  };


    const requestTakeoffLabel = () => {
      // ✅ cortar guía/latch al APRON
      apronLatchRef.current = false;

      // ✅ guiar a cabecera activa
      const end = rw?.active_end === 'B' ? 'B' : 'A';
      const thr = end === 'B' ? B_runway : A_runway;
      if (thr) setNavTarget(thr);

      // ✅ estado OPS explícito (camino a pista)
      emitOpsNow('TAXI_TO_RWY', 'UI_REQUEST_TAKEOFF');

      // ✅ pedir al backend
      requestTakeoff(false);

      takeoffRequestedRef.current = true;
      flashBanner(t("runway.goToThreshold"), 'go-threshold');
    };


const cancelRunwayLabel = () => {
  cancelMyRequest();
  landingRequestedRef.current = false;
  takeoffRequestedRef.current = false;
  finalLockedRef.current = false;
  navPhaseRef.current = null;
  prevIdxRef.current = null;
  setNavTargetSafe(null);

};

// ---- Focus hook #1: registro de socket / tráfico al enfocar Radar
useFocusEffect(
  React.useCallback(() => {
    // al entrar a Radar
    isFocusedRef.current = true;

    const s = socketRef.current;

    // helper: registra y pide tráfico
    const register = (payload: any) => {
      if (!s) return;

      if (!s.connected) s.connect();
      if (!username) return;

      s.emit('get-traffic');
      s.emit('airfield-get');
      s.emit('runway-get');

      s.emit('update', payload);
    };

    // ✅ Randomizar SOLO una vez por entrada a Radar (simMode)
    if (simMode && !didRandomizeOnEnterRef.current) {
      didRandomizeOnEnterRef.current = true;

      setMyPlane(prev => {
        const baseLat = prev.lat;
        const baseLon = prev.lon;

        const randBearing = Math.random() * 360;
        const randDist = Math.random() * 10_000; // 0..10 km
        const p = movePoint(baseLat, baseLon, randBearing, randDist);

        const randHeading = Math.floor(Math.random() * 360);

        const randSpeed = isMotorized
          ? 70 + Math.random() * 140   // 70..210
          : 60 + Math.random() * 80;   // 60..140

        const randAlt = isMotorized
          ? 150 + Math.random() * 450  // 150..600
          : 150 + Math.random() * 850; // 150..1000

        const next = {
          ...prev,
          lat: p.latitude,
          lon: p.longitude,
          heading: randHeading,
          speed: randSpeed,
          alt: randAlt,
        };

        // ✅ IMPORTANTE: emitimos con NEXT (no con myPlane viejo)
        register({
          name: username,
          latitude: next.lat,
          longitude: next.lon,
          alt: next.alt,
          heading: next.heading,
          type: aircraftModel,
          speed: next.speed,
          callsign: callsign || '',
          aircraftIcon: aircraftIcon || '2.png',
          isMotorized,
        });

        return next;
      });
    } else {
      // ✅ No randomiza → registra con estado actual (myPlane), pero sin depender de myPlane.*
      // Usamos refs/estado "lo que haya en ese render"
      register({
        name: username,
        latitude: myPlane.lat,
        longitude: myPlane.lon,
        alt: myPlane.alt,
        heading: myPlane.heading,
        type: aircraftModel,
        speed: myPlane.speed,
        callsign: callsign || '',
        aircraftIcon: aircraftIcon || '2.png',
        isMotorized,
      });
    }

    // al salir de Radar
    return () => {
      didRandomizeOnEnterRef.current = false;
      isFocusedRef.current = false;
        // 2) avisar backend (si lo usás)
          emitLeave();

        // 3) limpieza fuerte de warnings/timers
        hardResetRadar();
    };
  }, [
    username,
    simMode,
    aircraftModel,
    aircraftIcon,
    callsign,
    isMotorized,
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
  const mp = myPlaneRef.current;
  if (!mp) return;

  const trafficWithoutMe = traffic.filter(p => p.id !== mp.id);
  if (trafficWithoutMe.length === 0) {
    // ✅ guard: evitar setPlanes([]) repetido
    if (lastPlanesSigRef.current !== 'EMPTY') {
      lastPlanesSigRef.current = 'EMPTY';
      setPlanes([]);
    }
    return;
  }

  const timeSteps = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180];
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

      // ✅ guard: evitar setPlanes(...) si ya está igual
      const groundSig =
        'GROUND|' +
        
        ''; // firma real abajo usando trafficWithoutMe

      const mapped: Plane[] = trafficWithoutMe.map(p => ({
        ...p,
        alertLevel: 'none' as const,
        timeToImpact: undefined,
      }));

      const sig =
        'GROUND|' +
        mapped.map(p => `${p.id}:none`).join(',');

      if (lastPlanesSigRef.current !== sig) {
        lastPlanesSigRef.current = sig;
        setPlanes(mapped);
      }

      return;
    }
  }

  for (const plane of trafficWithoutMe) {
    const distanceNow = getDistance(mp.lat, mp.lon, plane.lat, plane.lon);

    // ⛔️ No consideres TA/RA contra aviones que ya están fuera de pista (en tierra)
    const otherOps = getOpsOf(plane.id) || getOpsOf(plane.name) || (plane.callsign ? getOpsOf(plane.callsign) : null);

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

      const vertSep = Math.abs((plane.alt ?? 0) - (mp.alt ?? 0));
      const hyperClose = distanceNow <= TA_HYPER_M;
      const withinVertical = vertSep <= TA_VSEP_MAX_M;

      // Estimación de tau (tiempo hasta mínima distancia) usando las mismas muestras que RA
      const futureDistancesTA: number[] = [];
      for (const t of timeSteps) {
        const myF = getFuturePosition(
          mp.lat,
          mp.lon,
          mp.heading,
          mp.speed,
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
        distanceNow < TA_RADIUS_M_LOCAL &&
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
        mp.lat,
        mp.lon,
        mp.heading,
        mp.speed,
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

    const futureAltDelta = Math.abs((mp.alt ?? 0) - (plane.alt ?? 0));

    // 2) “Acercamiento” simple: distancia a 5s menor que ahora
    const currentDistance = getDistance(
      mp.lat,
      mp.lon,
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
      mp.lat,
      mp.lon,
      mp.heading,
      mp.speed,
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
      const bNow = bearingDeg(mp.lat, mp.lon, plane.lat, plane.lon);
      const d = Math.abs(((mp.heading - bNow + 540) % 360) - 180);
      return d;
    })();

    const diffAtMin = (() => {
      const bMin = bearingDeg(
        myAtMin.latitude,
        myAtMin.longitude,
        theirAtMin.latitude,
        theirAtMin.longitude
      );
      const d = Math.abs(((mp.heading - bMin + 540) % 360) - 180);
      return d;
    })();

    // 👉 Cono frontal (ej. RA_CONE_DEG = 25)
    const withinCone = diffNow <= RA_CONE_DEG || diffAtMin <= RA_CONE_DEG;

    // 4) Criterio RA final (idéntico al viejo)
if (
  minDistance < RA_MIN_DIST_M_LOCAL &&
  futureAltDelta <= RA_VSEP_MAX_M &&
  closingSoon &&
  withinCone
) {
  if (timeOfMin < RA_HIGH_TTI_S_LOCAL && timeOfMin < minTimeToImpact) {
    selectedConflict = plane;
    selectedConflictLevel = 'RA_HIGH';
    minTimeToImpact = timeOfMin;
  } else if (
    timeOfMin < RA_LOW_TTI_S_LOCAL &&
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

  // ✅ NUEVO: “next states” para no spamear setState si no cambió
  let nextConflict: any = conflict;
  let nextSelected: any = selected;

  if (selectedConflict && selectedConflictLevel) {
    nextConflict = {
      ...selectedConflict,
      alertLevel: selectedConflictLevel,
      timeToImpact: minTimeToImpact,
    };
    nextSelected = {
      ...selectedConflict,
      alertLevel: selectedConflictLevel,
      timeToImpact: minTimeToImpact,
    };

    const distSel = getDistance(
      mp.lat,
      mp.lon,
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
    nextSelected = { ...p, alertLevel: 'TA' as 'TA' };
    nextConflict = null;

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
    nextConflict = null;
    nextSelected =
      Date.now() < selectedHoldUntilRef.current ? selected : null;
  }

  // ✅ Winner signature: si no cambia, NO seteamos conflict/selected/localWarning
  const sig = nuevoWarningLocal
    ? `${nuevoWarningLocal.id}|${nuevoWarningLocal.alertLevel}|${Math.round(nuevoWarningLocal.timeToImpact ?? 999)}`
    : `none|${backendWarning?.id ?? 'none'}|${backendWarning?.alertLevel ?? 'none'}`;

  if (sig !== lastWinnerRef.current) {
    lastWinnerRef.current = sig;

    // ✅ reemplaza tus setConflict / setSelected / setLocalWarning originales
    setConflict(prev => {
      const pid = prev?.id ?? null;
      const nid = nextConflict?.id ?? null;
      return pid === nid ? prev : nextConflict;
    });

    setSelected(prev => {
      const pid = prev?.id ?? null;
      const nid = nextSelected?.id ?? null;
      return pid === nid ? prev : nextSelected;
    });

    setLocalWarning(nuevoWarningLocal);
  }

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

  // ✅ guard: evitar setPlanes si no cambió alertLevel/tti por id
const planesSig =
  updatedTraffic.length +
  '|' +
  updatedTraffic
    .map(p => {
      const lat = Math.round((p.lat ?? 0) * 1e5);
      const lon = Math.round((p.lon ?? 0) * 1e5);
      const alt = Math.round((p.alt ?? 0) / 5); // opcional
      const lvl = p.alertLevel ?? 'none';
      const tti = Math.round(((p.timeToImpact ?? 999) as number) * 10) / 10;
      return `${p.id}:${lat},${lon},${alt}:${lvl}:${tti}`;
    })
    .join(',');

if (planesSig !== lastPlanesSigRef.current) {
  lastPlanesSigRef.current = planesSig;
  setPlanes(updatedTraffic);
}

}, [traffic, backendWarning, calcTick]);





useEffect(() => {
  if (!username) return;

  socketRef.current = socket;
  const s = socketRef.current;

  // Si el socket está desconectado (porque saliste de Radar antes), reconectalo
  if (s && !s.connected) s.connect();

  // ✅ Evitar duplicación: antes de registrar, apagamos y volvemos a prender
  s.off('connect');
  s.off('conflicto');
  s.off('conflicto-clear');
  s.off('traffic-update');
  s.off('initial-traffic');
  s.off('airfield-update');
  s.off('runway-state');
  s.off('runway-msg');
  s.off('user-removed');
  s.off('disconnect');
  s.off('sequence-update');
  s.off('atc-instruction');

  // ✅ CONNECT
  s.on('connect', async () => {
    console.log('🔌 Conectado al servidor WebSocket');
    s.emit('get-traffic');
    s.emit('airfield-get');
    s.emit('runway-get');



    // 👇 si el server no tiene pista cargada, reinyectala desde AsyncStorage
    try {
      const raw = await AsyncStorage.getItem('airfieldActive');
      if (raw) {
        const af = JSON.parse(raw);
        s.emit('airfield-upsert', { airfield: af });
      }
    } catch {}
  });

      // === NUEVO: secuencia y beacons desde el backend
    s.on('sequence-update', (msg: any) => {
      try {
        if (Array.isArray(msg?.slots)) setSlots(msg.slots);
      } catch {}
    });

    // === NUEVO: instrucciones dirigidas (ATC) ===
s.on('atc-instruction', (instr: any) => {
  (serverATCRef.current ||= true);
  if (!instr?.type) return;

  const asString = (v: any) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));

  // Helpers: si viene key/params, usamos i18n; si no, usamos text; si no, fallback
  const resolveText = (fallbackKey: string, fallbackParams: any = {}): string => {
    if (instr?.key) return asString(t(String(instr.key), instr.params || {}));
    if (typeof instr?.text === 'string' && instr.text.trim()) return instr.text;
    return asString(t(fallbackKey, fallbackParams));
  };

  const resolveSpoken = (fallbackKey: string, fallbackParams: any = {}): string => {
    if (instr?.spokenKey) return asString(t(String(instr.spokenKey), instr.spokenParams || instr.params || {}));
    if (typeof instr?.spoken === 'string' && instr.spoken.trim()) return instr.spoken;
    return asString(t(fallbackKey, fallbackParams));
  };

  if (instr.type === 'goto-beacon' && typeof instr.lat === 'number' && typeof instr.lon === 'number') {
    if (finalLockedRef.current) return;  // ✅ no pisar FINAL
    setNavTargetSafe({ latitude: instr.lat, longitude: instr.lon });

    const bannerText = resolveText('nav.proceedToBeaconGeneric');
    const spokenText = resolveSpoken('nav.proceedToBeaconGenericSpoken');

    flashBanner(bannerText, 'atc-goto');
    try { Speech.stop(); Speech.speak(String(spokenText), { language: String(ttsLang) }); } catch {}
  }

  if (instr.type === 'turn-to-B1') {
    const bannerText = resolveText('nav.turnToB1');
    const spokenText = resolveSpoken('nav.turnToB1Spoken');

    flashBanner(bannerText, 'atc-b1');
    try { Speech.stop(); Speech.speak(String(spokenText), { language: String(ttsLang) }); } catch {}
  }

  if (instr.type === 'cleared-to-land') {
    const bannerBase = resolveText('runway.clearedToLand', { rwy: instr.rwy || '' });
    const bannerText = bannerBase + (instr.rwy ? ` pista ${instr.rwy}` : '');

    const spokenText =
      instr?.spokenKey
        ? asString(t(String(instr.spokenKey), instr.spokenParams || instr.params || {}))
        : asString(t('runway.clearedToLandSpoken', { rwy: instr.rwy || '' }));

    // ✅ NO tocar OPS aquí
    // ✅ NO setNavTarget aquí
    // finalLockedRef, si querés, úsalo solo para UI (opcional)
    finalLockedRef.current = true;

    flashBanner(bannerText, 'atc-clr');
    try { Speech.stop(); Speech.speak(String(spokenText), { language: String(ttsLang) }); } catch {}
  }

});



  // ✅ CONFLICTO (tu lógica intacta)
  s.on('conflicto', (data: any) => {
    console.log('⚠️ Conflicto recibido vía WebSocket:', data);

    const me = myPlane?.id || username;

    const isRAEvent =
      data.alertLevel === 'RA_HIGH' ||
      data.alertLevel === 'RA_LOW' ||
      data.type === 'RA';

    const from = String(data.from || '');
    const to   = String(data.to   || '');

    if (isRAEvent && from && to && from !== me && to !== me) return;
    if (iAmGroundish()) return;

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

    const otherId =
      from && to
        ? (from === me ? to : (to === me ? from : null))
        : null;

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

    if (match && effectiveId) backendDistanceRef.current[effectiveId] = distNow;

    setPrioritizedWarning(prev =>
      prev && prev.id === effectiveId
        ? { ...prev, distanceMeters: distNow }
        : prev
    );

    const level =
      (data.alertLevel === 'RA_HIGH' || data.alertLevel === 'RA_LOW' || data.alertLevel === 'TA')
        ? data.alertLevel
        : (data.type === 'RA' ? 'RA_LOW' : 'TA');

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

    const BW_TTL_MS = 4000;
    if ((s as any).__bwTtlTimer) clearTimeout((s as any).__bwTtlTimer);
    (s as any).__bwTtlTimer = setTimeout(() => {
      const holdUntil = raHoldUntilRef.current[effectiveId] ?? 0;
      if (Date.now() < holdUntil) return;

      setBackendWarning(prev => (prev && prev.id === effectiveId) ? null : prev);
      setPrioritizedWarning(prev => (prev && prev.id === effectiveId) ? null : prev);
    }, BW_TTL_MS);
  });

  // ✅ conflicto-clear
  s.on('conflicto-clear', (msg: any) => {
    const id = String(msg?.id || '');
    if (!id) return;
    clearWarningFor(id);
    setBackendWarning(prev => (prev && prev.id === id) ? null : prev);
    setPrioritizedWarning(prev => (prev && prev.id === id) ? null : prev);
  });


  


s.on('ops/state', (msg: any) => {
  const name = String(msg?.name || '');
  const st = msg?.state;

  if (!name || typeof st !== 'string') return;

  const stRaw = String(st);

  // ✅ Permitimos patrones dinámicos:
  const isBeacon = /^B\d+$/.test(stRaw);         // B1, B2, B12...
  const isToBeacon = /^A_TO_B\d+$/.test(stRaw);  // A_TO_B2, A_TO_B17...

  // ✅ Estados "no-pattern" válidos:
  const VALID_BASE = new Set<OpsState>([
    'APRON_STOP','TAXI_APRON','TAXI_TO_RWY','HOLD_SHORT',
    'RUNWAY_OCCUPIED','RUNWAY_CLEAR',
    'AIRBORNE','LAND_QUEUE','FINAL',
  ] as OpsState[]);

  if (!VALID_BASE.has(stRaw as OpsState) && !isBeacon && !isToBeacon) return;

  const next = stRaw as OpsState;


  // ✅ si es mi avión, actualizo el ref “rápido”
  const me = (myPlaneRef.current?.id || username);
  if (name === me) {
    lastOpsStateRef.current = next;
    lastOpsStateTsRef.current = Date.now();
  }


  // (1) fuente de verdad en mapa
  setOpsStates(prev => (prev[name] === next ? prev : { ...prev, [name]: next }));

  // (2) espejo dentro del Plane (para UI/tap/markers)
  setTraffic(prev => {
    let changed = false;
    const out = prev.map(p => {
      if (p.id !== name) return p;
      if (p.ops === next) return p;
      changed = true;
      return { ...p, ops: next };
    });
    return changed ? out : prev;
  });
});

// ---- helpers ----
const nowMs = () => Date.now();

function pickLatLon(info: any): { lat: number; lon: number } | null {
  const lat =
    typeof info.lat === 'number' ? info.lat :
    typeof info.latitude === 'number' ? info.latitude :
    null;

  const lon =
    typeof info.lon === 'number' ? info.lon :
    typeof info.longitude === 'number' ? info.longitude :
    typeof info.lng === 'number' ? info.lng :
    null;

  if (lat == null || lon == null) return null;
  return { lat, lon };
}

function normalizeKinematics(info: any): Omit<Plane, 'ops'> & { lastSeenTs: number } | null {
  const ll = pickLatLon(info);
  if (!ll) return null;

  return {
    id: String(info.name),
    name: String(info.name),
    lat: ll.lat,
    lon: ll.lon,
    alt: typeof info.alt === 'number' ? info.alt : 0,
    heading: typeof info.heading === 'number' ? info.heading : 0,
    speed: typeof info.speed === 'number' ? info.speed : 0,
    type: info.type,
    callsign: info.callsign,
    aircraftIcon: info.aircraftIcon || info.icon || '2.png',
    lastSeenTs: nowMs(),
  };
}

// ---- initial-traffic ----
s.on('initial-traffic', (data: any) => {
  if (!Array.isArray(data)) return;

  const normalized = data
    .map(normalizeKinematics)
    .filter((p): p is NonNullable<ReturnType<typeof normalizeKinematics>> => p !== null);

  // Cargar base inicial (sin OPS acá)
  setTraffic(normalized as any); // si Plane no tiene lastSeenTs, cambia el type o casteá
});

// ---- traffic-update ----
s.on('traffic-update', (data: any) => {
  if (!Array.isArray(data)) return;

  const now = Date.now();

  const normalized = data
    .map((info: any) => {
      const lat =
        typeof info.lat === 'number'
          ? info.lat
          : typeof info.latitude === 'number'
          ? info.latitude
          : null;

      const lon =
        typeof info.lon === 'number'
          ? info.lon
          : typeof info.longitude === 'number'
          ? info.longitude
          : typeof info.lng === 'number'
          ? info.lng
          : null;

      if (lat == null || lon == null) return null;

      const p: Plane = {
        id: String(info.name),
        name: String(info.name),
        lat,
        lon,
        alt: typeof info.alt === 'number' ? info.alt : 0,
        heading: typeof info.heading === 'number' ? info.heading : 0,
        speed: typeof info.speed === 'number' ? info.speed : 0,
        type: info.type,
        callsign: info.callsign,
        aircraftIcon: info.aircraftIcon || '2.png',
        lastSeenTs: now, // ✅ nuevo
      };

      return p;
    })
    .filter((p): p is Plane => p !== null);

  const STALE_MS = 10_000;

  setTraffic(prev => {
    const byId = new Map(prev.map(p => [p.id, p]));

    for (const p of normalized) {
      const prevP = byId.get(p.id);
      byId.set(p.id, { ...prevP, ...p }); // ✅ mantiene fields que no vienen por traffic-update
    }

    const merged = Array.from(byId.values());

    // ✅ limpia los congelados
    return merged.filter(p => (now - (p.lastSeenTs ?? 0)) <= STALE_MS);
  });
});






// ✅ runway-state
// ✅ runway-state
// arriba del archivo


s.on('runway-state', (payload: any) => {
  try { console.log('[RUNWAY] state ←', JSON.stringify(payload)); } catch {}

  setRunwayState(payload);

  try {
    const map = payload?.state?.assignedOps as Record<string,string> | undefined;
    const targets = payload?.state?.opsTargets as Record<string, {fix:string; lat:number; lon:number}> | undefined;

    opsTargetsRef.current = targets || null;

    let assigned: string | null = null;

    if (map) {
      for (const k of keysForMe()) {
        const v = map[k];
        if (typeof v === 'string' && v) { assigned = v; break; }
      }
    }

    assignedRef.current = assigned;

    if (assigned === 'FINAL') {
      if (lastSentOpsRef.current !== 'FINAL') {
        console.log('[OPS] backend assigned FINAL → freezing beacon engine');
        lastSentOpsRef.current = 'FINAL';
      }
      freezeBeaconEngineRef.current = true;
    } else {
      freezeBeaconEngineRef.current = false;
      lastSentOpsRef.current = null;
    }
  } catch (e) {
    console.log('[RUNWAY FINAL guard error]', e);
  }
});





  // ✅ runway-msg
 s.on('runway-msg', (m: any) => {
  // 1) Resolver texto (i18n si viene key, si no texto plano)
  const bannerText =
    m?.key
      ? t(String(m.key), m.params || {})
      : (typeof m?.text === 'string' ? m.text : '');

  if (!bannerText) return;

  flashBanner(bannerText, `srv:${m.key || bannerText}`);

  // 2) Resolver voz (si viene spokenKey, usarlo; si no, usar bannerText tal cual)
  try {
    const spoken =
      m?.spokenKey
        ? t(String(m.spokenKey), m.spokenParams || m.params || {})
        : bannerText;

    Speech.stop();
    Speech.speak(spoken, { language: ttsLang, rate: 1.0, pitch: 1.0 });
  } catch {}
});


  // ✅ user-removed
// ✅ user-removed (DEBE ESTAR ACÁ, junto con el resto de s.on)
s.on('user-removed', (name: string) => {
  console.log('🗑️ user-removed:', name);

  setTraffic(prev => prev.filter(p => p.name !== name && p.id !== String(name)));
  setPlanes(prev => prev.filter(p => p.name !== name && p.id !== String(name)));

  setWarnings(prev => {
    const copy = { ...prev };
    delete copy[String(name)];
    return copy;
  });

  setPrioritizedWarning(prev => (prev?.id === String(name) ? null : prev));
  setSelected(prev => (prev?.id === String(name) ? null : prev));
  setConflict(prev => (prev?.id === String(name) ? null : prev));

  delete lastDistanceRef.current[String(name)];
});


  // ✅ disconnect
  s.on('disconnect', () => {
    console.log('🔌 Desconectado del WebSocket');
    serverATCRef.current = false;
  });

  // ✅ FIN: setup de listeners del socket
  return () => {
    // ✅ avisar salida (sin romper compatibilidad)
    try { s.emit('leave', { name: username }); } catch {}
    try { s.emit('remove-user', username); } catch {}

    // apagar listeners
    s.off('connect');
    s.off('conflicto');
    s.off('conflicto-clear');
    s.off('traffic-update');
    s.off('initial-traffic');
    s.off('airfield-update');
    s.off('runway-state');
    s.off('runway-msg');
    s.off('user-removed');
    s.off('disconnect');
    s.off('sequence-update');
    s.off('atc-instruction');
    s.off('ops/state');

    serverATCRef.current = false;
    finalLockedRef.current = false;

    // si compartís un socket global, NO lo desconectes aquí
    socketRef.current = null;
  };
}, [username, simMode, aircraftModel, aircraftIcon, callsign, isMotorized]);


 

// 🔥 Éste es el SIM SIM MODE
useEffect(() => {
  // SOLO simulación
  if (!username) return;
  if (!simMode) {
    // si apagaron sim, asegurá cortar interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return;
  }

  // simMode === true
  if (intervalRef.current) {
    clearInterval(intervalRef.current);
    intervalRef.current = null;
  }

  intervalRef.current = setInterval(() => {
    if (!isFocusedRef.current) return;

    // ✅ mover avión simulado + emitir update
    setMyPlane(prev => {
      const v_ms = (prev.speed * 1000) / 3600;
      const distanceMeters = v_ms * 1;

      const deltaLat =
        (distanceMeters / 111320) * Math.cos((prev.heading * Math.PI) / 180);

      const metersPerDegLon =
        (40075000 * Math.cos((prev.lat * Math.PI) / 180)) / 360;

      const deltaLon =
        (distanceMeters / metersPerDegLon) *
        Math.sin((prev.heading * Math.PI) / 180);

      const newLat = prev.lat + deltaLat;
      const newLon = prev.lon + deltaLon;

      // ✅ único emisor
      emitUpdate({
        lat: newLat,
        lon: newLon,
        alt: prev.alt,
        heading: prev.heading,
        speed: prev.speed,
      });

      return { ...prev, lat: newLat, lon: newLon };
    });

    // ✅ refrescar distancia warning pinneado (no toca TA/RA)
    refreshPinnedDistance();

    // ✅ tu bloque OPS (lo dejás EXACTO como está hoy)
    // Copiá y pegá acá el mismo IIFE OPS que ya tenés dentro del interval:
    // (() => { ... OPS ... })();
  }, 1000);

  return () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };
}, [simMode, username]);


useEffect(() => {
  // cada vez que cambia simMode: apagá lo opuesto ANTES de arrancar lo nuevo
  if (simMode) {
    // voy a SIM → mato GPS
    try { gpsWatchRef.current?.remove?.(); } catch {}
    gpsWatchRef.current = null;
  } else {
    // voy a GPS real → mato SIM
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }
}, [simMode]);




// ================= GPS REAL (watchPositionAsync) =================
useEffect(() => {
  let sub: Location.LocationSubscription | null = null;

  const start = async () => {
    if (simMode) return;
    if (!isFocusedRef.current) return;

    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return;

    sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, timeInterval: 1000, distanceInterval: 3 },
      (loc) => {
        const { latitude, longitude, altitude, heading, speed } = loc.coords;
        const speedKmh = speed ? speed * 3.6 : 0;

      emitUpdate({
        lat: latitude,
        lon: longitude,
        alt: altitude || 0,
        heading: heading || 0,
        speed: speedKmh,
      });


        setMyPlane(prev => {
          const d = getDistance(prev.lat, prev.lon, latitude, longitude);
          if (Number.isFinite(d) && d < 2 &&
              Math.abs((prev.alt ?? 0) - (altitude ?? 0)) < 1) {
            return prev;
          }
          return { ...prev, lat: latitude, lon: longitude, alt: altitude || 0, heading: heading || 0, speed: speedKmh };
        });
      }
    );

    gpsWatchRef.current = sub; // ✅
  };

  start();

  return () => {
    try { sub?.remove(); } catch {}
    try { gpsWatchRef.current?.remove(); } catch {}
    gpsWatchRef.current = null;
  };
}, [simMode, username, aircraftModel, aircraftIcon, callsign]);




const centerMap = (lat = myPlane.lat, lon = myPlane.lon) => {
  const now = Date.now();

  // throttle: no más de 2 veces por segundo
  if (now - lastCenterAtRef.current < 500) return;

  // no recentrar si no te moviste "nada" (ej. < 15m)
  const last = lastCenterPosRef.current;
  if (last) {
    const d = getDistance(last.lat, last.lon, lat, lon);
    if (Number.isFinite(d) && d < 15) return;
  }

  lastCenterAtRef.current = now;
  lastCenterPosRef.current = { lat, lon };

  if (mapRef.current) {
    isProgrammaticMoveRef.current = true;
    mapRef.current.animateToRegion({
      latitude: lat,
      longitude: lon,
      latitudeDelta: zoom.latitudeDelta,
      longitudeDelta: zoom.longitudeDelta,
    });

    // liberar flag después de un ratito
    setTimeout(() => { isProgrammaticMoveRef.current = false; }, 350);
  }
};

useEffect(() => {
  if (!followMe) return;
  centerMap(myPlane.lat, myPlane.lon);
}, [followMe, myPlane.lat, myPlane.lon]);


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
      lastPinnedDistRef.current = null;


    }, 6000);
  }
}, [prioritizedWarning?.id, prioritizedWarning?.alertLevel]);

useEffect(() => {
  const ids = new Set(traffic.map(t => t.id));

  // 1) si el priorizado ya no está, limpiar tarjeta + limpiar bloqueo
  setPrioritizedWarning(prev => {
    if (prev && !ids.has(prev.id)) {
      delete lastWarningTimeRef.current[prev.id];
      return null;
    }
    return prev;
  });

  // 2) podar selected/conflict si desaparecieron
  setSelected(prev => (prev && !ids.has(prev.id) ? null : prev));
  setConflict(prev => (prev && !ids.has(prev.id) ? null : prev));

  // 3) podar warnings que ya no correspondan
  setWarnings(prev => {
    let changed = false;
    const next: { [k: string]: Warning } = {};
    for (const [id, w] of Object.entries(prev)) {
      if (ids.has(id)) next[id] = w;
      else changed = true;
    }
    return changed ? next : prev; // ✅ evita re-render si no cambió nada
  });

}, [traffic]);


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
    setPlanes((prev: Plane[]) =>
      prev.map(p => ({ ...p, alertLevel: 'none' as const, timeToImpact: undefined }))
    );

  }

}, [runwayState, myPlane.lat, myPlane.lon, myPlane.speed]);


function reportIfDwellInside(
  key: string,
  inside: boolean,
  dwellMs: number,
  onArrive: () => void
) {
  const now = Date.now();

  if (!inside) {
    delete arrivedSinceRef.current[key];
    return;
  }

  const since = arrivedSinceRef.current[key] ?? now;
  arrivedSinceRef.current[key] = since;

  if (now - since < dwellMs) return;

  delete arrivedSinceRef.current[key];
  onArrive();
}


  // === RUNWAY: Automatismos de avisos y ocupación/liberación ===
useEffect(() => {
  if (!rw) return;

  // 1) "Liberar pista" solo si voy lento sobre la pista (< 50 km/h)
  const agl = getAGLmeters();
  const speedKmh =
    (myPlane && typeof myPlane.speed === 'number') ? myPlane.speed : 0;

  const touchdownLike =
    isOnRunwayStrip() &&
    agl < 8 &&
    speedKmh < 80;

  // ✅ antes era: isOnRunwayStrip() && speed < 50
  // ahora: sólo si realmente parece touchdown + rollout lento
// reset del latch cuando ya estás en RUNWAY_CLEAR (confirmado por ops)
if (lastOpsStateRef.current === 'RUNWAY_CLEAR') {
  runwayOccupiedSentRef.current = false;
}

if (touchdownLike && speedKmh < 50) {
  flashBanner(t("runway.vacateRunway"), 'free-runway');

  // ✅ NO setNavTarget acá (lo hace el NAV único vía apronLatchRef)
  apronLatchRef.current = true;

  // --- LATCH: emitir RUNWAY_OCCUPIED solo una vez por aterrizaje ---
  const me = myPlane?.id || username;

  // debug rápido (opcional, borralo luego)
  console.log('[TD DEBUG]', { touchdownLike, agl, speedKmh, assigned: getBackendAssignedForMe() });

  if (!runwayOccupiedSentRef.current) {
    // bypass de gates: el frontend debe confirmar RUNWAY_OCCUPIED en touchdown
    console.log('[OPS] touchdown → RUNWAY_OCCUPIED (latch)');
    emitOpsNow('RUNWAY_OCCUPIED', 'TOUCHDOWN_LATCH', { touchdownLike, agl, speedKmh });
    runwayOccupiedSentRef.current = true;
    // marca el latch para la navegación a apron cuando backend lo mande
    apronLatchRef.current = true;
  }

  // Si estoy aterrizando y aún no marqué occupy en la lógica local, marcar
  if (
    landingRequestedRef.current &&
    iAmOccupyingRef.current !== 'landing' &&
    defaultActionForMe() === 'land'
  ) {
    markRunwayOccupy('landing');
    iAmOccupyingRef.current = 'landing';

    // ✅ ya aterrizaste, podés cancelar la “request”
    try { cancelMyRequest(); } catch {}
    landingRequestedRef.current = false;
    finalLockedRef.current = false;
    socketRef.current?.emit('runway-get'); // refresco estado del server
  }

} else {
  // Versión conservadora: hacer "clear" solo si venías ocupando
  // o si estás en un estado de tierra real cerca de la cabecera activa
  let activeEnd: 'A' | 'B' | null = null;
  if ((rw as any).active_end === 'B') activeEnd = 'B';
  else activeEnd = 'A';

  const nearActiveThreshold =
    activeEnd ? isNearThreshold(activeEnd, 200) : false;

  if (iAmOccupyingRef.current || (iAmGroundish() && nearActiveThreshold)) {
    markRunwayClear();

    // Reset de aproximación y OPS visible
    finalLockedRef.current = false;
    emitOpsNow('RUNWAY_CLEAR', 'AUTOCLEAR');

    // ✅ NO setNavTarget acá (lo hace el NAV único vía apronLatchRef)
    apronLatchRef.current = true;

    iAmOccupyingRef.current = null;
  }
  // Si no se cumple la condición conservadora, NO limpies nada.
}

  // 2) Permisos según turno y huecos
  const me = myPlane?.id || username;
  const st = (runwayState as any)?.state as any;

  console.log('[DYN]', {
    me,
    assigned: st?.assignedOps?.[me],
    target: st?.opsTargets?.[me],
    reported: st?.reportedOpsStates?.[me],
  });

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
          flashBanner(t("runway.clearedToLand"), 'clr-land');
          landClearShownRef.current = true; // mostrar una vez por “aproximación”
        }

        if (activeThreshold) {
          // ✅ lock final, pero NO setNavTarget acá
          finalLockedRef.current = true;
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
  if (takeoffRequestedRef.current && defaultActionForMe() === 'takeoff') {
    const activeEnd = (rw as any).active_end === 'B' ? 'B' : 'A';
    const nearThr = isNearThreshold(activeEnd, 80);
    const nextLanding = (st.timeline || []).find((x: any) =>
      x.action === 'landing' && new Date(x.at).getTime() > Date.now()
    );
    const gapMin = nextLanding
      ? Math.round((new Date(nextLanding.at).getTime() - Date.now()) / 60000)
      : 999;

    if (nearThr) {
      const meTk = (st.takeoffs || []).find((tt: any) => tt.name === me);
      const waited = meTk?.waitedMin ?? 0;
      const opsMap = (runwayState as any)?.state?.opsStates || {};
      const landings = st.landings || [];
      const leaderL = landings[0];

      // 🚫 si hay alguien en FINAL/B1 (o tocando pista) no hay despegue
      const leaderOps = leaderL?.name ? (opsMap[leaderL.name] as OpsState | undefined) : undefined;
      const landingOnShortFinal =
        !!leaderL &&
        (leaderOps === 'FINAL' || leaderOps === 'B1' || leaderOps === 'RUNWAY_OCCUPIED');

      // 🚫 si la pista está en uso por aterrizaje/despegue, tampoco
      const runwayBusy = !!st.inUse;

      // gapMin viene de tu timeline (lo dejás)
      const can =
        !runwayBusy &&
        !landingOnShortFinal &&
        (gapMin >= 5 || waited >= 15);

      if (can && iAmOccupyingRef.current !== 'takeoff') {
        flashBanner(t("runway.lineUp"), 'lineup');

        if (isOnRunwayStrip()) {
          markRunwayOccupy('takeoff');
          iAmOccupyingRef.current = 'takeoff';
          flashBanner(t("runway.clearedToTakeoff"), 'cleared-tko');
        }
      } else {
        if (landingOnShortFinal) flashBanner(t("runway.trafficOnFinalWait"), 'tko-wait-final');
      }
    }
  }

}, [myPlane.lat, myPlane.lon, myPlane.alt, myPlane.speed, runwayState, rw]);


  // ===============================
  // NAV (ÚNICO): backend → ATC → takeoff → apron/ground → landing(ASSIGNED)
  // ===============================
  useEffect(() => {
    const me = myPlane?.id || username;
    if (!me) return;

    const st = runwayState?.state;

    // ✅ verdad local solo para GROUND
    const myFact = (lastOpsStateRef.current as OpsState | null);

    // ✅ orden backend (ATC) para landing fallback
    const assigned = getBackendAssignedForMe2() || undefined;


    // 1) PRIORIDAD ABSOLUTA: backend opsTargets
    const backendTarget = getBackendTargetForMe();
    if (backendTarget) {
      setNavTargetSafe({ latitude: backendTarget.lat, longitude: backendTarget.lon });
      return;
    }

    // 2) Si ATC dirigido está activo, no tocar navTarget (lo maneja atc-instruction)
    if (serverATCRef.current) return;

    // 3) TAKEOFF: siempre a cabecera activa
    if (takeoffRequestedRef.current && defaultActionForMe() === 'takeoff') {
      const end = rw?.active_end === 'B' ? 'B' : 'A';
      const thr = end === 'B' ? B_runway : A_runway;
      setNavTargetSafe(thr ?? null);
      return;
    }

    // 4) APRON latch → apron
    if (apronLatchRef.current) {
      setNavTargetSafe(getApronPoint() ?? null);
      return;
    }

    // 4b) GROUND OPS (solo fact local) → apron
    if (myFact && GROUND_OPS.has(myFact)) {
      setNavTargetSafe(getApronPoint() ?? null);
      return;
    }

    // 5) Si no pedí aterrizaje, no guiar
    if (!landingRequestedRef.current || defaultActionForMe() !== 'land') {
      setNavTargetSafe(null);
      return;
    }

    // 6) LANDING fallback por ORDEN BACKEND (assignedOps)
    //    (Si no hay assigned, no tocamos navTarget)
    if (!assigned) return;

    // opcional: si backend manda B1 como orden
    if (assigned === 'B1') {
      setNavTargetSafe(beaconB1 ?? null);
      return;
    }

    // backend-only FINAL (orden) → umbral activo
    if (assigned === 'FINAL') {
      setNavTargetSafe(activeThreshold ?? null);
      return;
    }

    // A_TO_B2 / A_TO_B3 / A_TO_B4...
    if (typeof assigned === 'string' && assigned.startsWith('A_TO_B')) {
      const n = Number(assigned.replace('A_TO_B', '')); // 2,3,4...
      if (n === 2) { setNavTargetSafe(beaconB2 ?? null); return; }
      if (n >= 3) {
        const idx = n - 3; // B3 -> 0
        const b = extraBeacons[idx];
        setNavTargetSafe(b ?? beaconB2 ?? null);
        return;
      }
    }

    // fallback: no tocar
  }, [
    username,
    runwayState,
    rw,
    beaconB1,
    beaconB2,
    activeThreshold,
    extraBeacons,
    myPlane?.id,
    myPlane.lat,
    myPlane.lon,
    myPlane.speed,
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
            <TouchableOpacity
        onPress={() => router.push("/settings")}        
        style={{
          position: "absolute",
          top: 50,
          right: 14,
          backgroundColor: "white",
          borderRadius: 18,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderWidth: 1,
          borderColor: "#ddd",
          elevation: 4,
        }}
      >
        <Text style={{ fontWeight: "800" }}>⚙️</Text>
      </TouchableOpacity>

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
        

        onRegionChangeComplete={(region) => {
          if (isProgrammaticMoveRef.current) return; // ✅ clave

          if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current);
          zoomDebounceRef.current = setTimeout(() => {
            setZoom({ latitudeDelta: region.latitudeDelta, longitudeDelta: region.longitudeDelta });
          }, 250);
        }}

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
          // 1) OPS que ves hoy en mapa (socket 'ops/state') + fallback inferido
          let ops = (getOpsOf(plane.id) ||
            getOpsOf(plane.name) ||
            (plane.callsign ? getOpsOf(plane.callsign) : null)) as OpsState | null;

          ops = ops || inferOpsForDisplay(plane);


          // 3) ATC (backend / assigned) A_TO_Bx / FINAL desde runway-state
          const atcAssigned = getAssignedOpsOfPlane(plane);

          // ✅ Si perdió turno: o ya no está en assignedOps, o ya no está en colas => borrar nav
          const stillHasTurn = isPlaneInAssignedOps(plane) && isPlaneInQueues(plane);

          // 4) Target (backend) fix + lat/lon desde runway-state
          const atcTarget = stillHasTurn ? getOpsTargetOfPlane(plane) : null;


          setSelected({
            ...plane,
            ops,          // compat con tu UI actual
            atcAssigned,  // BACKEND (assignedOps)
            atcTarget,    // BACKEND (opsTargets)
          } as any);

          const warning = warnings[plane.id];
          const isPureInfo =
            !warning &&
            (plane.alertLevel === 'none' || !plane.alertLevel);
          selectedHoldUntilRef.current = isPureInfo ? Date.now() + 5000 : 0;
          if (warning) {
            const w = { ...warning, ops, atcAssigned, atcTarget } as any;
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
              atcAssigned,
              atcTarget,
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
            <Marker coordinate={A_runway} title={`${t("runway.threshold")} A ${rw?.identA || ""}`} onPress={() => showRunwayLabel('A')}>
              <View style={{ backgroundColor: '#2196F3', padding: 2, borderRadius: 10, minWidth: 20, alignItems: 'center' }}>
                <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 10 }}>A</Text>
              </View>
            </Marker>
          )}
          {B_runway && (
            <Marker coordinate={B_runway} title={`${t("runway.threshold")} B ${rw?.identB || ""}`} onPress={() => showRunwayLabel('B')}>
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
              <Marker coordinate={apr} title={t("runway.apron")}>
                <View style={{ backgroundColor: '#FF9800', padding: 4, borderRadius: 10 }}>
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 10 }}>{t("runway.apronShort")}</Text>
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
        {navTarget && (
          <Polyline
            coordinates={[
              { latitude: myPlane.lat, longitude: myPlane.lon },
              navTarget
            ]}
            strokeColor="blue"
            strokeWidth={2}
          />
          
        )}






      </MapView>

        <View style={styles.controlsBox}>
          <Text style={styles.label}>✈️ {t("radar.heading")}: {myPlane.heading.toFixed(0)}°</Text>
          <Slider minimumValue={0} maximumValue={359} step={1} value={myPlane.heading} onValueChange={val => setMyPlane(prev => ({ ...prev, heading: val }))} />
            <Text style={styles.label}>
              🛫 {t("radar.altitude")}: {formatAltitude(myPlane.alt, settings)}
            </Text>
          {/* 👇 AGL visible en B2/B1/FINAL */}
          {(() => {
            const st = lastOpsStateRef.current as OpsState | null;
            const showAGL = st === 'B2' || st === 'B1' || st === 'FINAL';
            if (!showAGL) return null;
            const agl = Math.round(getAGLmeters());
            return (
            <Text style={styles.label}>
              📏 {t("radar.agl")}: {formatAltitude(agl, settings)} AGL
            </Text>
          );
          })()}

          <Slider minimumValue={0} maximumValue={2000} step={10} value={myPlane.alt} onValueChange={val => setMyPlane(prev => ({ ...prev, alt: val }))} />
          <Text style={styles.label}>
            💨 {t("radar.speed")}: {formatSpeed(myPlane.speed, settings)}
          </Text>
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


        <Text style={styles.followText}>
        {followMe ? t("radar.followOff") : t("radar.followOn")}
        </Text>

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
          {simMode ? t("radar.useRealGps") : t("radar.useSimMode")}
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

      return (idx >= 0 && !hideTurno) ? t("runway.turnNumber", { n: idx + 1 }) : " ";
    })()}
  </Text>
  {/* Estado OPS visible aparte */}
  <Text style={{fontSize:12, marginTop:4}}>
    {t("runway.opsState")}: {lastOpsStateRef.current ?? "—"}
  </Text>

    {/* 🆘 Aviso explícito si YO estoy marcado como EMERGENCIA en la cola */}
    {(() => {
      const me = myPlane?.id || username;
      const ls = runwayState?.state?.landings || [];
      const myL = ls.find((x:any)=>x?.name === me);
      if (!myL?.emergency) return null;

      return (
        <Text
          style={{
            color: '#B71C1C',
            fontWeight: '700',
            marginTop: 4,
            marginBottom: 4,
          }}
        >
          {t("runway.emergencyPriority")}
        </Text>
      );
    })()}


    {/* Quién está en uso */}
    <Text style={{fontWeight:'700', marginBottom:4}}>
    {runwayState?.state?.inUse
    ? `${t(runwayState.state.inUse.action === "landing" ? "runway.landing" : "runway.takeoff")} — ${runwayState.state.inUse.name} (${runwayState.state.inUse.callsign || "—"})`
    : t("runway.clear")}
    </Text>

{(() => { const me=myPlane?.id||username; const s=slots.find(x=>x.name===me); return s?.frozen ?<Text>{t("runway.positionFrozenB1")}</Text> : null; })()}

{(() => { const me=myPlane?.id||username; const s=slots.find(x=>x.name===me); return s ? <Text>{t("runway.etaToSlotSec", { s: Math.max(0, Math.round((s.startMs - Date.now())/1000)) })}</Text> : null; })()}

{(() => { const me=myPlane?.id||username; const s=slots.find(x=>x.name===me) as any; const sh=Math.round((s?.shiftAccumMs||0)/1000); return s&&sh>0 ? <Text>{t("runway.shiftAppliedSec", { s: sh })}</Text> : null; })()}


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
              <Text>
              {t("runway.cancelAction", { action: t(action === "land" ? "runway.landingLower" : "runway.takeoffLower") })}
              </Text>

            </TouchableOpacity>
          );
        }

        if (action==='land') {
          return (
            <>
              <TouchableOpacity onPress={requestLandingLabel}
                style={{backgroundColor:'#111', paddingHorizontal:12, paddingVertical:8, borderRadius:10}}>
                <Text style={{color:'#fff', fontWeight:'600'}}>{t("runway.requestLanding")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={()=>{
                  socketRef.current?.emit('runway-request',{
                    action:'land', name: myPlane?.id||username,
                    callsign: callsign||'', aircraft: aircraftModel||'',
                    type: aircraftModel||'', emergency:true, altitude: myPlane?.alt??0
                  });
                  landingRequestedRef.current = true;
                  flashBanner(t("runway.emergencyDeclared"), 'emg');
                }}
                style={{backgroundColor:'#b71c1c', paddingHorizontal:12, paddingVertical:8, borderRadius:10}}
              >
                <Text style={{color:'#fff', fontWeight:'700'}}>{t("runway.emergency")}</Text>
              </TouchableOpacity>
            </>
          );
        }

        // en tierra: solo despegue
          // en tierra: solo despegue (con guard por OPS)
          const myOps = lastOpsStateRef.current as OpsState | null;

          const canRequestTakeoff =
            myOps === 'RUNWAY_OCCUPIED' ||
            myOps === 'TAXI_APRON' ||
            myOps === 'APRON_STOP';

          if (!canRequestTakeoff) {
            // Opcional: mostrar nada o un texto gris informativo
            return (
            <Text style={{ color: '#999', fontSize: 12 }}>
              {t("runway.mustBeOnApronOrRunwayToRequestTakeoff")}
            </Text>
            );
          }

        return (
          <TouchableOpacity onPress={requestTakeoffLabel}
            style={{backgroundColor:'#111', paddingHorizontal:12, paddingVertical:8, borderRadius:10}}>
            <Text style={{color:'#fff', fontWeight:'600'}}>{t("runway.requestTakeoff")}</Text>
          </TouchableOpacity>
        );
      })()}
    </View>

{/* Cola completa (scrolleable si es larga) */}
<Text style={{fontWeight:'600', marginTop:4, marginBottom:4}}>
  {defaultActionForMe()==='land' ? t("runway.landingQueue") : t("runway.takeoffQueue")}
</Text>

<View style={{maxHeight: 180}}>
  <ScrollView>
    {(() => {
      const me = myPlane?.id||username;
      const action = defaultActionForMe();
      const list = action==='land'
        ? (runwayState?.state?.landings||[])
        : (runwayState?.state?.takeoffs||[]);

      if (!list.length) return <Text style={{fontSize:12}}>{t("common.empty")}</Text>;

      const opsMap = (runwayState as any)?.state?.opsStates || {};
      return list.map((x:any, i:number) => {
        const mine   = x?.name === me;
        const etaMin = typeof x?.etaSec === 'number' ? Math.round(x.etaSec/60) : null;
        const waited = typeof x?.waitedMin === 'number' ? x.waitedMin : null;
        const tags = [
          x?.emergency ? t("runway.emergency") : null,
          (action==='land'    && x?.holding) ? t("runway.hold")  : null,
          (action==='takeoff' && x?.ready)   ? t("runway.ready") : null,
          (action==='takeoff' && waited!=null) ? `+${waited}m` : null,
        ].filter(Boolean).join(' · ');

        const opsStr = opsMap[x?.name]
        ? ` · ${t("runway.ops")}: ${opsMap[x.name]}`
        : "";



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

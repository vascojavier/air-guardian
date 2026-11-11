// C:\air-guardian\frontend\app\Pista.tsx
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, TextInput, Modal, Linking, ScrollView, KeyboardAvoidingView, Platform, Switch } from 'react-native';
import MapView, { Marker, Polyline, MapPressEvent, Region } from 'react-native-maps';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useUser } from '../context/UserContext';
import { useFocusEffect, useRouter } from 'expo-router';
import type { Airfield, AssignmentMode, Runway, RunwayBeacon, RunwayEndId, RunwayUse } from '../types/airfield';
import { socket } from '../utils/socket';
import { Picker } from '@react-native-picker/picker';
import { BACKEND_URL } from '../utils/config';
import { useTranslation } from 'react-i18next';

// ---------------------- Tipos locales ----------------------
type LatLng = { latitude: number; longitude: number };
type PendingRunway = { name: string; callsign?: string; operation: 'arrival' | 'departure' };
const RUNWAY_USES: RunwayUse[] = ['closed', 'arrival', 'departure', 'mixed'];

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
const B1_DIST_NM = 3.5; // ~3–4 NM
const B2_DIST_NM = 7.0; // ~6–8 NM

const DEFAULT_ATC_SETTINGS = {
  B1_LATCH_ON_M: 3500,
  B1_LATCH_OFF_M: 6000,
  B1_LATCH_OFF_SUSTAIN_MS: 20000,
  FINAL_TIMEOUT_MS: 360000,
  GOAROUND_DRIFT_M: 9000,
  GOAROUND_DRIFT_SUSTAIN_MS: 20000,
  FINAL_LOCK_RADIUS_M: 2000,
  MAX_B2_TO_B1_S: 180,
  FINAL_DRIFT_MAX_M: 2500,
};


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
  const hdg_thr_to_opp = calcularRumbo(thr, opp); // rumbo umbral -> opuesta
  return (hdg_thr_to_opp + 180) % 360; // aproximación viene desde afuera
}

function makeDefaultBeacons(A: LatLng, B: LatLng, active: 'A' | 'B') {
  const thr = active === 'A' ? A : B;
  const app = computeApproachBearing(A, B, active);
  const B1 = destinationPoint(thr, app, B1_DIST_NM * NM_TO_M);
  const B2 = destinationPoint(thr, app, B2_DIST_NM * NM_TO_M);
  return { B1, B2 };
}

function reciprocalIdent(ident: string): string {
  const reciprocal = ((Number(ident.slice(0, 2)) + 17) % 36) + 1;
  const suffix = ident[2] === 'L' ? 'R' : ident[2] === 'R' ? 'L' : ident[2] ?? '';
  return String(reciprocal).padStart(2, '0') + suffix;
}

function runwayBeacons(B1: LatLng, B2: LatLng): RunwayBeacon[] {
  return [
    { name: 'B1', lat: B1.latitude, lon: B1.longitude },
    { name: 'B2', lat: B2.latitude, lon: B2.longitude },
  ];
}

function changeRunwayEnd(runway: Runway, end: RunwayEndId): Runway {
  const currentEnd = runway.active_end ?? 'A';
  const byEnd = { ...runway.beaconsByEnd };
  if (runway.beacons?.length === 2) byEnd[currentEnd] = runway.beacons;
  const A = { latitude: runway.thresholdA.lat, longitude: runway.thresholdA.lng };
  const B = { latitude: runway.thresholdB.lat, longitude: runway.thresholdB.lng };
  if (!byEnd[end]) {
    const { B1, B2 } = makeDefaultBeacons(A, B, end);
    byEnd[end] = runwayBeacons(B1, B2);
  }
  return { ...runway, active_end: end, beacons: byEnd[end], beaconsByEnd: byEnd };
}

function chooseOperativeRunway(airport: Airfield, id: string): Airfield | null {
  const runway = airport.runways.find(item => item.id === id);
  if (!runway) return null;
  const useSuggestion = !airport.apron || airport.apronSource === 'openstreetmap';
  return {
    ...airport,
    runways: [runway, ...airport.runways.filter(item => item.id !== id)],
    apron: useSuggestion ? runway.apronSuggestion : airport.apron,
    apronSource: useSuggestion && runway.apronSuggestion ? 'openstreetmap' : undefined,
  };
}

function thresholdPosition(point: Runway['thresholdA']): LatLng {
  return { latitude: point.lat, longitude: point.lng };
}

function previewHoldShort(A: LatLng, B: LatLng, apron: LatLng, end: RunwayEndId) {
  const axis = calcularRumbo(A, B);
  const distance = 111195 * Math.hypot(apron.latitude - A.latitude,
    (apron.longitude - A.longitude) * Math.cos(toRad(A.latitude)));
  const lateral = distance * Math.sin(toRad(calcularRumbo(A, apron) - axis));
  const side = axis + (lateral < -1 ? -90 : 90);
  const approach = computeApproachBearing(A, B, end);
  return destinationPoint(destinationPoint(end === 'A' ? A : B, approach, 80), side, 80);
}

function RunwayButton({ title, onPress, disabled = false, primary = false }: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary && styles.buttonPrimary,
        pressed && (primary ? styles.buttonPrimaryPressed : styles.buttonPressed),
        disabled && styles.buttonDisabled,
      ]}
    >
      <Text style={[
        styles.buttonLabel,
        primary && styles.buttonPrimaryLabel,
        disabled && styles.buttonDisabledLabel,
      ]}>{title}</Text>
    </Pressable>
  );
}

export default function PistaScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { role } = useUser(); // 'pilot' o 'aeroclub'

  const [cabeceraA, setCabeceraA] = useState<LatLng | null>(null);
  const [cabeceraB, setCabeceraB] = useState<LatLng | null>(null);
  const [cabeceraActiva, setCabeceraActiva] = useState<'A' | 'B' | null>(null);
  const [rumbo, setRumbo] = useState<number>(0);
  const [modoSeteo, setModoSeteo] = useState<boolean>(false);
  const [numeroPista, setNumeroPista] = useState<string>('');
  const [showDetails, setShowDetails] = useState(true);
  const [beaconB1, setBeaconB1] = useState<LatLng | null>(null);
  const [beaconB2, setBeaconB2] = useState<LatLng | null>(null);

  // APRON (guardado y edición)
  const [apron, setApron] = useState<LatLng | null>(null); // pin guardado
  const [apronSource, setApronSource] = useState<Airfield['apronSource']>();
  const [apronEdit, setApronEdit] = useState(false); // modo edición
  const [tempApron, setTempApron] = useState<LatLng | null>(null); // pin temporal

  const [editing, setEditing] = useState(false);
  const [draftAirport, setDraftAirport] = useState<Airfield | null>(null);
  const [selectedRunwayId, setSelectedRunwayId] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [showRunwayPicker, setShowRunwayPicker] = useState(false);
  const [multiConfig, setMultiConfig] = useState<{ value: Airfield; expected: Airfield } | null>(null);
  const [multiAdminKey, setMultiAdminKey] = useState('');
  const [multiUnlocked, setMultiUnlocked] = useState(false);
  const [unlockingMulti, setUnlockingMulti] = useState(false);
  const [pendingRunways, setPendingRunways] = useState<PendingRunway[]>([]);
  const [assigningRunway, setAssigningRunway] = useState<PendingRunway | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    airfield: Airfield;
    expected: Airfield | null;
  } | null>(null);
  const [airportQuery, setAirportQuery] = useState('');
  const [airportSearch, setAirportSearch] = useState<{
    query: string;
    matches: { icao: string; iata?: string; name: string; city?: string }[];
    failed?: boolean;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const importRequestRef = useRef<AbortController | null>(null);
  const [live, setLive] = useState(false);
  const [current, setCurrent] = useState<Airfield | null>(null);
  const [publishing, setPublishing] = useState(false);
  const currentRef = useRef<Airfield | null>(null);
  const editingRef = useRef(false);
  const draftBaseRef = useRef<Airfield | null>(null);
  const publishingRef = useRef(false);
  const mapRef = useRef<MapView | null>(null);
  const [mapReady, setMapReady] = useState(false);

  function showAirfield(airfield: Airfield | null) {
    const runway = airfield?.runways?.[0];
    if (!runway) {
      setCabeceraA(null);
      setCabeceraB(null);
      setCabeceraActiva(null);
      setNumeroPista('');
      setBeaconB1(null);
      setBeaconB2(null);
      setApron(null);
      setApronSource(undefined);
      return;
    }
    const A = { latitude: runway.thresholdA.lat, longitude: runway.thresholdA.lng };
    const B = { latitude: runway.thresholdB.lat, longitude: runway.thresholdB.lng };
    const end = runway.active_end ?? 'A';
    const points = makeDefaultBeacons(A, B, end);
    const b1 = runway.beacons?.find(beacon => beacon.name === 'B1');
    const b2 = runway.beacons?.find(beacon => beacon.name === 'B2');
    setCabeceraA(A);
    setCabeceraB(B);
    setCabeceraActiva(end);
    setNumeroPista(runway.identA);
    setRumbo((runway.heading_true_ab + (end === 'B' ? 180 : 0)) % 360);
    setBeaconB1(b1 ? { latitude: b1.lat, longitude: b1.lon } : points.B1);
    setBeaconB2(b2 ? { latitude: b2.lat, longitude: b2.lon } : points.B2);
    setApron(airfield?.apron ? { latitude: airfield.apron.lat, longitude: airfield.apron.lng } : null);
    setApronSource(airfield?.apronSource);
  }

  useFocusEffect(React.useCallback(() => {
    let disposed = false;
    let remoteReceived = false;
    const receive = ({ airfield }: { airfield?: Airfield }) => {
      if (!airfield?.runways?.[0]?.thresholdA || !airfield.runways[0].thresholdB) return;
      remoteReceived = true;
      currentRef.current = airfield;
      setCurrent(airfield);
      setLive(true);
      if (!editingRef.current) showAirfield(airfield);
      if (role === 'aeroclub') {
        void AsyncStorage.setItem('airfieldActive', JSON.stringify(airfield)).catch(() => {});
      }
    };
    const request = () => socket.emit('airfield-get');
    const resetMultiAccess = () => {
      setMultiUnlocked(false);
      setPendingRunways([]);
      setAssigningRunway(null);
    };
    const receivePendingRunways = (items: PendingRunway[]) => {
      if (role === 'aeroclub' && Array.isArray(items)) setPendingRunways(items);
    };
    socket.on('disconnect', resetMultiAccess);
    socket.on('multi-runway-pending', receivePendingRunways);
    socket.on('airfield-update', receive);
    socket.on('connect', request);
    if (socket.connected) request();
    else socket.connect();

    void (async () => {
      try {
        const values = await AsyncStorage.multiGet(['airfieldActive', 'pistaActiva']);
        if (disposed || remoteReceived) return;
        const raw = values[0][1];
        let saved: Airfield | null = raw ? JSON.parse(raw) : null;
        if (!saved?.runways?.[0] && values[1][1]) {
          const legacy = JSON.parse(values[1][1]);
          const { A, B } = legacy.runway ?? {};
          if (!A || !B) return;
          const heading = calcularRumbo(A, B);
          const identA = legacy.numero || headingToRunwayIdent(heading);
          saved = {
            id: uuid(), source: 'manual', lastUpdated: Date.now(), location: midpointToLoc(A, B),
            runways: [{
              id: uuid(), identA, identB: headingToRunwayIdent(heading + 180),
              thresholdA: { lat: A.latitude, lng: A.longitude },
              thresholdB: { lat: B.latitude, lng: B.longitude },
              heading_true_ab: heading,
              active_end: legacy.defaultActiveHeading === 'B' ? 'B' : 'A',
            }],
          };
        }
        if (!saved?.runways?.[0]) return;
        currentRef.current = saved;
        setCurrent(saved);
        setLive(false);
        if (!editingRef.current) showAirfield(saved);
      } catch (error) {
        console.warn('Could not read saved runway:', error);
      }
    })();

    return () => {
      disposed = true;
      socket.off('airfield-update', receive);
      socket.off('connect', request);
      socket.off('disconnect', resetMultiAccess);
      socket.off('multi-runway-pending', receivePendingRunways);
      importRequestRef.current?.abort();
      importRequestRef.current = null;
    };
  }, [role]));

  const currentRunway = current?.runways?.[0];
  const mapAirport = editing ? draftAirport : current;
  const mapRunway = editing ? draftAirport?.runways.find(runway => runway.id === selectedRunwayId) : currentRunway;
  const endA = mapRunway?.endA ? thresholdPosition(mapRunway.endA) : cabeceraA;
  const endB = mapRunway?.endB ? thresholdPosition(mapRunway.endB) : cabeceraB;
  const otherRunways = (mapAirport?.runways ?? []).filter(runway =>
    runway.id !== (editing ? selectedRunwayId : currentRunway?.id)
  );

  useEffect(() => {
    if (!mapReady || !mapAirport?.runways.length) return;
    mapRef.current?.fitToCoordinates(
      mapAirport.runways.flatMap(runway => [
        thresholdPosition(runway.endA ?? runway.thresholdA), thresholdPosition(runway.endB ?? runway.thresholdB),
      ]),
      { edgePadding: { top: 60, left: 50, bottom: 60, right: 50 }, animated: true }
    );
  }, [mapReady, mapAirport?.id, mapAirport?.runways.length]);

  const searchQuery = airportQuery.trim();
  const searchResult = airportSearch?.query === searchQuery ? airportSearch : null;
  const exactIcao = /^[A-Z]{4}$/i.test(searchQuery);

  useEffect(() => {
    if (!showImport || importing || !searchQuery) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(BACKEND_URL + '/api/airports?query=' + encodeURIComponent(searchQuery),
          { signal: controller.signal });
        if (!response.ok) throw new Error('Airport search failed');
        const matches = await response.json();
        if (!controller.signal.aborted) setAirportSearch({ query: searchQuery, matches });
      } catch {
        if (!controller.signal.aborted) setAirportSearch({ query: searchQuery, matches: [], failed: true });
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [showImport, importing, searchQuery]);

  async function importAirport(icao: string) {
    const code = icao.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code) || role !== 'aeroclub' || importRequestRef.current) return;
    const controller = new AbortController();
    importRequestRef.current = controller;
    setImporting(true);
    try {
      const response = await fetch(BACKEND_URL + '/api/airports/' + code, { signal: controller.signal });
      if (!response.ok) {
        Alert.alert(t(response.status === 404 ? 'pistaAdmin.airportNotFound' : 'pistaAdmin.catalogError'));
        return;
      }
      const airport: Airfield = await response.json();
      if (controller.signal.aborted) return;
      const firstRunway = airport.runways?.[0];
      const draft = firstRunway ? chooseOperativeRunway(airport, firstRunway.id) : null;
      if (!draft || !firstRunway) {
        Alert.alert(t('pistaAdmin.noUsableRunways'));
        return;
      }
      startEdit(true);
      setModoSeteo(false);
      setDraftAirport(draft);
      setSelectedRunwayId(firstRunway.id);
      showAirfield(draft);
      setShowImport(false);
    } catch {
      if (!controller.signal.aborted) Alert.alert(t('pistaAdmin.catalogError'));
    } finally {
      if (importRequestRef.current === controller) importRequestRef.current = null;
      setImporting(false);
    }
  }

  function selectDraftRunway(id: string) {
    if (!draftAirport || !id || id === selectedRunwayId || publishingRef.current) return;
    const existingDraft = selectedRunwayId ? buildDraftAirfield() : draftAirport;
    if (!existingDraft) return;
    const next = chooseOperativeRunway(existingDraft, id);
    if (!next) return;
    setDraftAirport(next);
    setSelectedRunwayId(id);
    setApronEdit(false);
    setTempApron(null);
    showAirfield(next);
  }

  function chooseDraftEnd(end: RunwayEndId) {
    if (!cabeceraA || !cabeceraB || end === cabeceraActiva) return;
    const draft = buildDraftAirfield();
    if (!draft) return;
    const runway = changeRunwayEnd(draft.runways[0], end);
    const next = { ...draft, runways: [runway, ...draft.runways.slice(1)] };
    if (draftAirport) setDraftAirport(next);
    showAirfield(next);
  }

  function startEdit(newRunway = false, runwayId?: string) {
    draftBaseRef.current = currentRef.current;
    editingRef.current = true;
    setEditing(true);
    const currentAirport = currentRef.current;
    const draft = newRunway ? null : currentAirport && runwayId
      ? chooseOperativeRunway(currentAirport, runwayId) : currentAirport;
    setDraftAirport(draft);
    setSelectedRunwayId(draft?.runways[0]?.id ?? '');
    setModoSeteo(newRunway);
    setApronEdit(false);
    setTempApron(null);
    showAirfield(draft);
  }

  function cancelEdit() {
    editingRef.current = false;
    setEditing(false);
    setDraftAirport(null);
    setSelectedRunwayId('');
    setModoSeteo(false);
    setApronEdit(false);
    setTempApron(null);
    showAirfield(currentRef.current);
  }

  function handleMapPress(event: MapPressEvent) {
    if (role !== 'aeroclub' || !editing || publishing) return;
    const point = event.nativeEvent.coordinate;
    if (apronEdit) {
      setTempApron(point);
      return;
    }
    if (!modoSeteo) return;
    if (!cabeceraA) {
      setCabeceraA(point);
    } else if (!cabeceraB && (point.latitude !== cabeceraA.latitude || point.longitude !== cabeceraA.longitude)) {
      setCabeceraB(point);
      setCabeceraActiva('A');
      const heading = calcularRumbo(cabeceraA, point);
      setRumbo(heading);
      setNumeroPista(headingToRunwayIdent(heading));
      const { B1, B2 } = makeDefaultBeacons(cabeceraA, point, 'A');
      setBeaconB1(B1);
      setBeaconB2(B2);
    }
  }

  function moveThreshold(end: RunwayEndId, point: LatLng) {
    if (!editingRef.current || publishingRef.current || !cabeceraA || !cabeceraB || !cabeceraActiva) return;
    const A = end === 'A' ? point : cabeceraA;
    const B = end === 'B' ? point : cabeceraB;
    if (A.latitude === B.latitude && A.longitude === B.longitude) return;
    setCabeceraA(A);
    setCabeceraB(B);
    setRumbo((calcularRumbo(A, B) + (cabeceraActiva === 'B' ? 180 : 0)) % 360);
  }

  async function publishAirfield(next: Airfield, expected: Airfield | null) {
    if (role !== 'aeroclub' || publishingRef.current) return;
    const latest = currentRef.current;
    if (latest?.id !== expected?.id || latest?.lastUpdated !== expected?.lastUpdated) {
      Alert.alert(t('pistaAdmin.changed'));
      return;
    }
    if (!socket.connected) {
      Alert.alert(t('pistaAdmin.publishError'));
      return;
    }
    publishingRef.current = true;
    setPublishing(true);
    const value = { ...next, lastUpdated: Math.max(Date.now(), (latest?.lastUpdated ?? 0) + 1) };
    try {
      await new Promise<void>((resolve, reject) => {
        const receive = ({ airfield }: { airfield?: Airfield }) => {
          if (airfield?.id === value.id && airfield.lastUpdated === value.lastUpdated) {
            clearTimeout(timeout);
            socket.off('airfield-update', receive);
            resolve();
          }
        };
        const timeout = setTimeout(() => {
          socket.off('airfield-update', receive);
          reject(new Error('Airfield publication was not confirmed'));
        }, 5000);
        socket.on('airfield-update', receive);
        socket.emit('airfield-upsert', { airfield: value }, (result?: { error?: string }) => {
          if (!result?.error) return;
          clearTimeout(timeout);
          socket.off('airfield-update', receive);
          reject(new Error(result.error));
        });
      });
      cancelEdit();
    } catch (error) {
      Alert.alert(t(error instanceof Error && error.message === 'runway-busy'
        ? 'pistaAdmin.runwayBusy' : error instanceof Error && error.message === 'admin-required'
          ? 'pistaAdmin.multiAccess' : 'pistaAdmin.publishError'));
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  }

  function openMultiConfig() {
    if (!current) return;
    const value = {
      ...current,
      runways: current.runways.map((runway, index) => ({
        ...runway,
        active_end: runway.active_end ?? 'A',
        operationUse: runway.operationUse ?? (index === 0 ? 'mixed' : 'closed'),
      })),
    } satisfies Airfield;
    setMultiConfig({ value, expected: current });
  }

  function sendMultiRunwayAction(
    event: 'multi-runway-admin' | 'multi-runway-assign',
    payload: string | { name: string; runwayId: string; end: RunwayEndId },
    onResult: (ok: boolean) => void
  ) {
    if (!socket.connected) {
      onResult(false);
      return;
    }
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      onResult(false);
    }, 5000);
    socket.emit(event, payload, (result?: { ok: boolean }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      onResult(result?.ok === true);
    });
  }

  function unlockMultiRunway() {
    if (unlockingMulti) return;
    setUnlockingMulti(true);
    sendMultiRunwayAction('multi-runway-admin', multiAdminKey, ok => {
      setUnlockingMulti(false);
      setMultiAdminKey('');
      if (!ok) {
        Alert.alert(t('pistaAdmin.multiAccess'));
        return;
      }
      setMultiUnlocked(true);
    });
  }

  function updateMultiRunway(id: string, patch: Partial<Runway>) {
    setMultiConfig(draft => draft && {
      ...draft,
      value: {
        ...draft.value,
        runways: draft.value.runways.map(runway => runway.id === id ? { ...runway, ...patch } : runway),
      },
    });
  }

  function assignPendingRunway(runwayId: string, end: RunwayEndId) {
    if (!assigningRunway) return;
    sendMultiRunwayAction('multi-runway-assign', {
      name: assigningRunway.name, runwayId, end,
    }, ok => {
      if (!ok) Alert.alert(t('pistaAdmin.assignmentError'));
      else setAssigningRunway(null);
    });
  }

  function confirmEndChange() {
    if (!current || !currentRunway) return;
    const end = currentRunway.active_end === 'B' ? 'A' : 'B';
    const ident = end === 'A' ? currentRunway.identA : currentRunway.identB;
    setConfirmation({
      title: t('pistaAdmin.activate', { ident }),
      message: t('pistaAdmin.confirmEnd'),
      airfield: {
        ...current,
        runways: [changeRunwayEnd(currentRunway, end), ...current.runways.slice(1)],
      },
      expected: current,
    });
  }

  function buildDraftAirfield(): Airfield | null {
    if (!cabeceraA || !cabeceraB || !cabeceraActiva || !beaconB1 || !beaconB2) return null;
    const identA = numeroPista.trim().toUpperCase().padStart(2, '0');
    const original = draftAirport;
    const previousRunway = original?.runways?.[0];
    if (identA !== previousRunway?.identA && !/^(0[1-9]|[12][0-9]|3[0-6])[LCR]?$/.test(identA)) {
      Alert.alert(t('pistaAdmin.invalidIdent'));
      return null;
    }
    const identB = previousRunway?.identA === identA ? previousRunway.identB : reciprocalIdent(identA);
    const beacons = runwayBeacons(beaconB1, beaconB2);
    const sameThresholds = previousRunway?.thresholdA.lat === cabeceraA.latitude &&
      previousRunway.thresholdA.lng === cabeceraA.longitude &&
      previousRunway.thresholdB.lat === cabeceraB.latitude &&
      previousRunway.thresholdB.lng === cabeceraB.longitude;
    const runway: Runway = {
      ...previousRunway,
      id: previousRunway?.id ?? uuid(),
      identA, identB,
      thresholdA: { lat: cabeceraA.latitude, lng: cabeceraA.longitude },
      thresholdB: { lat: cabeceraB.latitude, lng: cabeceraB.longitude },
      heading_true_ab: sameThresholds ? previousRunway.heading_true_ab : calcularRumbo(cabeceraA, cabeceraB),
      active_end: cabeceraActiva,
      beacons,
      beaconsByEnd: { ...(sameThresholds ? previousRunway?.beaconsByEnd : {}), [cabeceraActiva]: beacons },
    };
    return {
      ...original,
      id: original?.id ?? uuid(),
      source: original?.source ?? 'manual',
      lastUpdated: Date.now(),
      location: original?.location ?? midpointToLoc(cabeceraA, cabeceraB),
      runways: [runway, ...(original?.runways.slice(1) ?? [])],
      apron: apron ? { lat: apron.latitude, lng: apron.longitude } : undefined,
      apronSource: apron ? apronSource : undefined,
      atcSettings: original?.atcSettings ?? DEFAULT_ATC_SETTINGS,
    };
  }

  function reviewDraft() {
    const value = buildDraftAirfield();
    if (!value) return;
    if (value.source === 'ourairports' && !value.apron) {
      Alert.alert(t('pistaAdmin.apronRequired'));
      return;
    }
    const expected = draftBaseRef.current;
    const { identA, identB, active_end } = value.runways[0];
    const summary = t('pistaAdmin.summary', {
      a: identA, b: identB, active: active_end === 'B' ? identB : identA,
    });
    const apronSummary = t(apron ? 'pistaAdmin.apronSet' : 'pistaAdmin.apronUnset');
    setConfirmation({
      title: t('pistaAdmin.review'),
      message: [summary, apronSummary, t('pistaAdmin.confirmEnd')].join('\n'),
      airfield: value,
      expected,
    });
  }

  const onRegionChangeComplete = (region: Region) => {
    const threshold = 0.2; // ≈10 km
    setShowDetails(region.latitudeDelta < threshold && region.longitudeDelta < threshold);
  };

  // ---------------------- Render ----------------------
  return (
    <View style={{ flex: 1 }}>
      <MapView
        ref={mapRef}
        onMapReady={() => setMapReady(true)}
        style={{ flex: 1 }}
        initialRegion={{
          latitude: cabeceraA?.latitude ?? 51.956,
          longitude: cabeceraA?.longitude ?? 4.437,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01,
        }}
        onPress={handleMapPress}
        onRegionChangeComplete={onRegionChangeComplete}
      >
        {otherRunways.map(runway => {
          const A = thresholdPosition(runway.endA ?? runway.thresholdA);
          const B = thresholdPosition(runway.endB ?? runway.thresholdB);
          return (
            <React.Fragment key={runway.id}>
              <Polyline coordinates={[A, B]} strokeColor="#607D8B" strokeWidth={2} />
              <Marker coordinate={calcularPuntoIntermedio(A, B)}
                title={runway.identA + '/' + runway.identB}
                onPress={() => { if (editing && !apronEdit) selectDraftRunway(runway.id); }}>
                <View style={[styles.marker, { backgroundColor: '#607D8B' }]}>
                  <Text style={styles.markerText}>{runway.identA}/{runway.identB}</Text>
                </View>
              </Marker>
            </React.Fragment>
          );
        })}
        {editing && endA && endB && apron && (['A', 'B'] as const).map(end => (
          <Marker key={'hold-' + end} coordinate={previewHoldShort(endA, endB, apron, end)}
            title={t('runway.hold') + ' ' + end}>
            <View style={[styles.marker, { backgroundColor: '#8D6015' }]}>
              <Text style={styles.markerText}>{t('runway.hold')} {end}</Text>
            </View>
          </Marker>
        ))}
        {cabeceraA && (showDetails || editing) && (
          <Marker coordinate={cabeceraA} title={t('pista.thresholdA', { num: numeroPista })}
            draggable={editing && !!cabeceraB && !publishing}
            onDragEnd={event => moveThreshold('A', event.nativeEvent.coordinate)}>
            <View style={styles.marker}><Text style={styles.markerText}>A</Text></View>
          </Marker>
        )}

        {cabeceraB && (showDetails || editing) && (
          <Marker coordinate={cabeceraB} title={t('pista.thresholdB', { num: draftAirport?.runways[0]?.identA === numeroPista ? draftAirport.runways[0].identB : !editing && currentRunway?.identA === numeroPista ? currentRunway.identB : numeroPista ? reciprocalIdent(numeroPista) : '' })}
            draggable={editing && !publishing}
            onDragEnd={event => moveThreshold('B', event.nativeEvent.coordinate)}>
            <View style={styles.marker}><Text style={styles.markerText}>B</Text></View>
          </Marker>
        )}

        {endA && endB && (
          <Polyline coordinates={[endA, endB]} strokeColor="black" strokeWidth={2} />
        )}

        {beaconB1 && beaconB2 && cabeceraA && cabeceraB && cabeceraActiva && (
          <Polyline
            coordinates={[
              beaconB2,
              beaconB1,
              cabeceraActiva === 'A' ? cabeceraA : cabeceraB,
            ]}
            strokeColor="green"
            strokeWidth={2}
          />
        )}

        {beaconB2 && (
          <Marker
            coordinate={beaconB2}
            draggable={editing && !publishing}
            onDragEnd={e => { if (editingRef.current && !publishingRef.current) setBeaconB2(e.nativeEvent.coordinate); }}
            title={t('pista.b2Title')}
            description={t('pista.b2Desc')}
          >
            <View style={[styles.marker, { backgroundColor: '#673AB7' }]}>
              <Text style={styles.markerText}>B2</Text>
            </View>
          </Marker>
        )}

        {beaconB1 && (
          <Marker
            coordinate={beaconB1}
            draggable={editing && !publishing}
            onDragEnd={e => { if (editingRef.current && !publishingRef.current) setBeaconB1(e.nativeEvent.coordinate); }}
            title={t('pista.b1Title')}
            description={t('pista.b1Desc')}
          >
            <View style={[styles.marker, { backgroundColor: '#4CAF50' }]}>
              <Text style={styles.markerText}>B1</Text>
            </View>
          </Marker>
        )}

        {apron && (
          <Marker coordinate={apron} title={t('pista.apron')}>
            <View style={{ backgroundColor: '#FF9800', padding: 4, borderRadius: 10 }}>
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 10 }}>
                {t('pista.apron')}
              </Text>
            </View>
          </Marker>
        )}

        {apronEdit && tempApron && (
          <Marker coordinate={tempApron} title={t('pista.apronNew')}>
            <View style={{ backgroundColor: '#FFC107', padding: 4, borderRadius: 10 }}>
              <Text style={{ color: '#333', fontWeight: '700', fontSize: 10 }}>
                {t('pista.apronTemp')}
              </Text>
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

      <View style={styles.panel}>
        {editing ? (
          <>
            <Text style={styles.text}>{t('pistaAdmin.draft')}{draftAirport?.name ? ' · ' + draftAirport.name : ''}</Text>
            {draftAirport && (
              <>
                <Text style={styles.step}>{t('pistaAdmin.summary', {
                  a: draftAirport.runways[0].identA,
                  b: draftAirport.runways[0].identB,
                  active: cabeceraActiva === 'B' ? draftAirport.runways[0].identB : draftAirport.runways[0].identA,
                })}</Text>
                {draftAirport.runways.length > 1 && (
                  <RunwayButton title={t(draftAirport.multiRunway ? 'pistaAdmin.edit' : 'pistaAdmin.chooseRunway')} disabled={publishing || apronEdit}
                    onPress={() => setShowRunwayPicker(true)} />
                )}
                {!!draftAirport.incompleteRunways && (
                  <Text style={styles.step}>{t('pistaAdmin.incompleteRunways', { n: draftAirport.incompleteRunways })}</Text>
                )}
              </>
            )}
            {modoSeteo && (!cabeceraA || !cabeceraB) && (
              <Text style={styles.step}>{t(cabeceraA ? 'pistaAdmin.tapB' : 'pistaAdmin.tapA')}</Text>
            )}
            {cabeceraA && cabeceraB && (
              <>
                <Text>{t('pista.modalTitle')}</Text>
                <TextInput
                  style={styles.input}
                  value={numeroPista}
                  onChangeText={setNumeroPista}
                  autoCapitalize="characters"
                  maxLength={3}
                  editable={!publishing}
                  placeholder={t('pista.modalPlaceholder')}
                />
                {draftAirport && cabeceraActiva && (
                  <RunwayButton primary title={t('pistaAdmin.activate', {
                    ident: cabeceraActiva === 'A' ? draftAirport.runways[0].identB : numeroPista,
                  })} disabled={publishing || apronEdit}
                    onPress={() => chooseDraftEnd(cabeceraActiva === 'A' ? 'B' : 'A')} />
                )}
                <View style={styles.actions}>
                  <RunwayButton title={t('pista.markApron')} disabled={publishing || apronEdit} onPress={() => setApronEdit(true)} />
                  <RunwayButton title={t('pista.autoGenerateB1B2')} disabled={publishing} onPress={() => {
                    if (!cabeceraActiva) return;
                    const { B1, B2 } = makeDefaultBeacons(cabeceraA, cabeceraB, cabeceraActiva);
                    setBeaconB1(B1);
                    setBeaconB2(B2);
                  }} />
                </View>
                {apronEdit ? (
                  <>
                    <Text style={styles.step}>{t('pistaAdmin.tapApron')}</Text>
                    <View style={styles.actions}>
                      <RunwayButton primary title={t('common.save')} disabled={!tempApron} onPress={() => {
                        setApron(tempApron);
                        setApronSource(undefined);
                        setTempApron(null);
                        setApronEdit(false);
                      }} />
                      <RunwayButton title={t('common.cancel')} onPress={() => { setApronEdit(false); setTempApron(null); }} />
                    </View>
                  </>
                ) : (
                  <Text style={styles.step}>{t('pistaAdmin.adjustBeacons')}</Text>
                )}
              </>
            )}
            <RunwayButton primary title={t('pistaAdmin.review')} disabled={publishing || apronEdit || !cabeceraB} onPress={reviewDraft} />
            <View style={styles.actions}>
              <RunwayButton title={t('common.cancel')} disabled={publishing} onPress={cancelEdit} />
              {!modoSeteo && <RunwayButton primary title={t('pista.setNewRunway')} disabled={publishing} onPress={() => startEdit(true)} />}
            </View>
          </>
        ) : (
          <>
            <Text style={styles.text}>{t(live ? 'pistaAdmin.published' : currentRunway ? 'pistaAdmin.local' : 'pistaAdmin.empty')}</Text>
            {current?.name && <Text style={styles.step}>{current.name} {current.icao}</Text>}
            {currentRunway && (
              <Text style={styles.step}>{t('pistaAdmin.summary', {
                a: currentRunway.identA, b: currentRunway.identB,
                active: currentRunway.active_end === 'B' ? currentRunway.identB : currentRunway.identA,
              })}</Text>
            )}
            {role === 'aeroclub' && (
              <>
                {currentRunway && !current.multiRunway && current.runways.length > 1 && (
                  <RunwayButton title={t('pistaAdmin.chooseRunway')} disabled={publishing}
                    onPress={() => setShowRunwayPicker(true)} />
                )}
                {current && (
                  <RunwayButton title={t('pistaAdmin.multiTitle')} disabled={publishing} onPress={openMultiConfig} />
                )}
                {current?.multiRunway && pendingRunways.length > 0 && (
                  <ScrollView style={styles.pendingRunways} contentContainerStyle={styles.modalActions}>
                    {pendingRunways.map(item => (
                      <RunwayButton key={item.name} primary title={t('pistaAdmin.requestRunway', {
                        name: item.callsign || item.name,
                        operation: t('pistaAdmin.use_' + item.operation),
                      })} onPress={() => setAssigningRunway(item)} />
                    ))}
                  </ScrollView>
                )}
                {currentRunway && !current?.multiRunway && (
                  <RunwayButton primary title={t('pistaAdmin.activate', { ident: currentRunway.active_end === 'B' ? currentRunway.identA : currentRunway.identB })}
                    disabled={publishing} onPress={confirmEndChange} />
                )}
                <View style={styles.actions}>
                  <RunwayButton primary title={t('pistaAdmin.importAirport')} disabled={publishing} onPress={() => setShowImport(true)} />
                  <RunwayButton primary title={t(currentRunway ? 'pistaAdmin.edit' : 'pista.setNewRunway')}
                    disabled={publishing} onPress={() => startEdit(!currentRunway)} />
                  {currentRunway && (
                    <RunwayButton title={t('pistaAdmin.advanced')} disabled={publishing}
                      onPress={() => router.push('/AirfieldDetails?tab=atc')} />
                  )}
                </View>
              </>
            )}
          </>
        )}
        {apronSource === 'openstreetmap' && (
          <Text accessibilityRole="link" style={styles.apronAttribution}
            onPress={() => { void Linking.openURL('https://www.openstreetmap.org/copyright').catch(() => {}); }}>
            © OpenStreetMap contributors
          </Text>
        )}
      </View>
      <Modal visible={!!multiConfig} transparent animationType="fade"
        onRequestClose={() => setMultiConfig(null)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.modalCard} accessibilityViewIsModal>
            <Text style={styles.text}>{t('pistaAdmin.multiTitle')}</Text>
            {multiConfig && !multiUnlocked && (
              <View style={styles.modalActions}>
                <TextInput style={styles.input} value={multiAdminKey} onChangeText={setMultiAdminKey}
                  placeholder={t('pistaAdmin.serverKey')} accessibilityLabel={t('pistaAdmin.serverKey')}
                  secureTextEntry autoCapitalize="none" autoCorrect={false} />
                <RunwayButton primary title={t('welcome.continueAsAdmin')}
                  disabled={unlockingMulti || !multiAdminKey} onPress={unlockMultiRunway} />
              </View>
            )}
            {multiConfig && multiUnlocked && (
              <>
                <ScrollView style={styles.multiOptions} keyboardShouldPersistTaps="handled">
                  <View style={styles.actions}>
                    <Text style={styles.step}>{t('pistaAdmin.enableMulti')}</Text>
                    <Switch accessibilityLabel={t('pistaAdmin.enableMulti')}
                      value={!!multiConfig.value.multiRunway} onValueChange={enabled => setMultiConfig(draft =>
                        draft && { ...draft, value: {
                          ...draft.value,
                          multiRunway: enabled ? { arrival: 'automatic', departure: 'automatic' } : undefined,
                        } })} />
                  </View>
                  {multiConfig.value.multiRunway && (
                    <>
                      {(['arrival', 'departure'] as const).map(operation => (
                        <View key={operation}>
                          <Text>{t('pistaAdmin.use_' + operation)}</Text>
                          <Picker selectedValue={multiConfig.value.multiRunway?.[operation]}
                            onValueChange={(mode: AssignmentMode) => setMultiConfig(draft => draft?.value.multiRunway
                              ? { ...draft, value: { ...draft.value, multiRunway: { ...draft.value.multiRunway, [operation]: mode } } }
                              : draft)}>
                            <Picker.Item value="automatic" label={t('pistaAdmin.modeAutomatic')} />
                            <Picker.Item value="manual" label={t('pistaAdmin.modeManual')} />
                          </Picker>
                        </View>
                      ))}
                      {multiConfig.value.runways.map(runway => (
                        <View key={runway.id} style={styles.runwayConfigRow}>
                          <Text style={styles.text}>{runway.identA}/{runway.identB}</Text>
                          <Picker accessibilityLabel={t('pistaAdmin.runwayUse')}
                            selectedValue={runway.operationUse}
                            onValueChange={(operationUse: RunwayUse) => updateMultiRunway(runway.id, { operationUse })}>
                            {RUNWAY_USES.map(use => <Picker.Item key={use} value={use} label={t('pistaAdmin.use_' + use)} />)}
                          </Picker>
                          <Picker accessibilityLabel={t('pistaAdmin.chooseEnd')} selectedValue={runway.active_end}
                            onValueChange={(end: RunwayEndId) => updateMultiRunway(runway.id, changeRunwayEnd(runway, end))}>
                            <Picker.Item value="A" label={runway.identA} />
                            <Picker.Item value="B" label={runway.identB} />
                          </Picker>
                          {!!(runway.apronSuggestion || multiConfig.value.apron) && (
                            <Picker accessibilityLabel={t('pista.apron')} selectedValue={runway.apron ? 'specific' : 'shared'}
                              onValueChange={value => updateMultiRunway(runway.id, {
                                apron: value === 'specific' ? runway.apron ?? runway.apronSuggestion ?? multiConfig.value.apron : undefined,
                              })}>
                              <Picker.Item value="shared" label={t('pistaAdmin.apronShared')} />
                              <Picker.Item value="specific" label={t('pistaAdmin.apronSpecific')} />
                            </Picker>
                          )}
                        </View>
                      ))}
                    </>
                  )}
                </ScrollView>
                <RunwayButton primary title={t('pistaAdmin.publish')}
                  disabled={!!multiConfig.value.multiRunway && multiConfig.value.runways.every(runway => runway.operationUse === 'closed')}
                  onPress={() => {
                    setConfirmation({
                      title: t('pistaAdmin.multiTitle'),
                      message: t('pistaAdmin.confirmEnd'),
                      airfield: multiConfig.value,
                      expected: multiConfig.expected,
                    });
                    setMultiConfig(null);
                  }} />
              </>
            )}
            <RunwayButton title={t('common.cancel')} onPress={() => setMultiConfig(null)} />
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <Modal visible={!!assigningRunway} transparent animationType="fade"
        onRequestClose={() => setAssigningRunway(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} accessibilityViewIsModal>
            <Text style={styles.text}>{assigningRunway?.callsign || assigningRunway?.name}</Text>
            <ScrollView style={styles.runwayOptions} contentContainerStyle={styles.modalActions}>
              {current?.runways.filter(runway => runway.operationUse === 'mixed' ||
                runway.operationUse === assigningRunway?.operation).flatMap(runway =>
                (['A', 'B'] as const).map(end => (
                  <RunwayButton key={runway.id + end} title={t('pistaAdmin.assignEnd', {
                    ident: end === 'A' ? runway.identA : runway.identB,
                  })} onPress={() => assignPendingRunway(runway.id, end)} />
                ))
              )}
            </ScrollView>
            <RunwayButton title={t('common.cancel')} onPress={() => setAssigningRunway(null)} />
          </View>
        </View>
      </Modal>
      <Modal visible={showRunwayPicker} transparent animationType="fade"
        onRequestClose={() => setShowRunwayPicker(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} accessibilityViewIsModal>
            <Text style={styles.text}>{t(draftAirport?.multiRunway ? 'pistaAdmin.edit' : 'pistaAdmin.chooseRunway')}</Text>
            <ScrollView style={styles.runwayOptions} contentContainerStyle={styles.modalActions}>
              {(mapAirport?.runways ?? []).map(runway => {
                const selected = runway.id === (editing ? selectedRunwayId : currentRunway?.id);
                return (
                  <RunwayButton key={runway.id} primary={selected}
                    title={runway.identA + '/' + runway.identB} onPress={() => {
                      setShowRunwayPicker(false);
                      if (selected) return;
                      if (editing) selectDraftRunway(runway.id);
                      else startEdit(false, runway.id);
                    }} />
                );
              })}
            </ScrollView>
            <RunwayButton title={t('common.cancel')} onPress={() => setShowRunwayPicker(false)} />
          </View>
        </View>
      </Modal>
      <Modal visible={showImport} transparent animationType="fade"
        onRequestClose={() => { if (!importing) setShowImport(false); }}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.modalCard}>
            <Text style={styles.text}>{t('pistaAdmin.importAirport')}</Text>
            <TextInput
              style={styles.input}
              placeholder={t('pistaAdmin.airportSearch')}
              accessibilityLabel={t('pistaAdmin.airportSearch')}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={100}
              editable={!importing}
              value={airportQuery}
              onChangeText={value => {
                setAirportQuery(value);
                setAirportSearch(null);
              }}
            />
            {!importing && searchResult && (
              searchResult.matches.length ? (
                <ScrollView keyboardShouldPersistTaps="handled" style={styles.runwayOptions}
                  contentContainerStyle={styles.modalActions}>
                  {searchResult.matches.map(airport => (
                    <RunwayButton key={airport.icao}
                      title={airport.name + '\n' + [airport.icao, airport.iata, airport.city].filter(Boolean).join(' · ')}
                      onPress={() => void importAirport(airport.icao)} />
                  ))}
                </ScrollView>
              ) : (
                <Text style={styles.step}>{t(searchResult.failed ? 'pistaAdmin.catalogError' : 'pistaAdmin.airportNotFound')}</Text>
              )
            )}
            <View style={styles.modalActions}>
              {(importing || exactIcao) && (
                <RunwayButton primary title={t(importing ? 'pistaAdmin.importing' : 'pistaAdmin.lookupAirport')}
                  disabled={importing} onPress={() => void importAirport(searchQuery)} />
              )}
              <RunwayButton title={t('common.cancel')} disabled={importing} onPress={() => setShowImport(false)} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <Modal visible={!!confirmation} transparent animationType="fade"
        onRequestClose={() => setConfirmation(null)}>
        {confirmation && (
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard} accessibilityViewIsModal>
              <Text style={styles.text}>{confirmation.title}</Text>
              <Text style={styles.step}>{confirmation.message}</Text>
              <View style={styles.modalActions}>
                <RunwayButton primary title={t('pistaAdmin.publish')} onPress={() => {
                  setConfirmation(null);
                  void publishAirfield(confirmation.airfield, confirmation.expected);
                }} />
                <RunwayButton title={t('common.cancel')} onPress={() => setConfirmation(null)} />
              </View>
            </View>
          </View>
        )}
      </Modal>
    </View>
  );
}

// ---------------------- Styles ----------------------
const styles = StyleSheet.create({
  modalBackdrop: { flex: 1, justifyContent: "center", padding: 32, backgroundColor: "rgba(0,0,0,0.45)" },
  modalCard: { padding: 20, borderRadius: 12, backgroundColor: "#fff" },
  modalActions: { gap: 8 },
  runwayOptions: { maxHeight: 300, marginBottom: 8 },
  multiOptions: { maxHeight: 460, flexShrink: 1, marginBottom: 8 },
  pendingRunways: { maxHeight: 120 },
  runwayConfigRow: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#aab1ba', paddingTop: 8 },
  apronAttribution: { color: '#35465C', fontSize: 11, textDecorationLine: 'underline' },
  button: {
    minHeight: 48,
    flexShrink: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#21242A',
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  buttonLabel: { color: '#17191E', fontWeight: '700', textAlign: 'center' },
  buttonPrimary: { backgroundColor: '#111318', borderColor: '#111318' },
  buttonPrimaryLabel: { color: '#FF777E' },
  buttonPressed: { backgroundColor: '#E8EEFA' },
  buttonPrimaryPressed: { backgroundColor: '#322127', borderColor: '#322127' },
  buttonDisabled: { backgroundColor: '#EFF0F2', borderColor: '#D5D8DE' },
  buttonDisabledLabel: { color: '#626974' },
  panel: {
    padding: 10,
    gap: 6,
    paddingBottom: 30,
    backgroundColor: '#fff',
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 6 },
  step: { marginBottom: 8 },
  text: {
    color: '#17191E',
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
});

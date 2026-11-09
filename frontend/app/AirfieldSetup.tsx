// C:\air-guardian\frontend\app\AirfieldSetup.tsx
import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, Button, StyleSheet, Alert, TextInput, Platform } from 'react-native';
import MapView, { Marker, Polyline, LatLng } from 'react-native-maps';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ioDefault from 'socket.io-client'; // ✅ default import (compat v2/v3)
//import type { Socket } from "socket.io-client";
import { Redirect, useRouter } from 'expo-router';
import { useUser } from '../context/UserContext';


type IOSocket = ReturnType<typeof ioDefault>;

/** =========================================================
 *  Tipos unificados
 *  ========================================================= */
type Meteo = {
  windDirection?: number | null;
  windSpeed?: number | null;
  visibility?: number | null;
  cloudCover?: number | null;
  temperature?: number | null;
  pressure?: number | null;
};

type Runway = {
  id: string;
  identA: string;
  identB: string;
  thresholdA: { lat: number; lng: number };
  thresholdB: { lat: number; lng: number };
  heading_true_ab: number;
  length_m?: number;
  width_m?: number;
  surface?: string;
  active_end?: 'A' | 'B';
  notes?: string;
};

type Airfield = {
  id: string;
  name?: string;
  icao?: string;
  iata?: string;
  country?: string;
  elevation_ft?: number;
  location?: { lat: number; lng: number };
  runways: Runway[];
  meteo?: Meteo;
  lastUpdated: number;
  source: 'manual' | 'ourairports' | 'mixed';
};

/** =========================================================
 *  Helpers
 *  ========================================================= */
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
  const y = Math.sin(dLon) * cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  function cos(v: number) { return Math.cos(v); }
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

const midpoint = (a: LatLng, b: LatLng) => ({
  lat: (a.latitude + b.latitude) / 2,
  lng: (a.longitude + b.longitude) / 2,
});

const diffAngle = (a: number, b: number) =>
  Math.abs(((a - b + 540) % 360) - 180);

/** =========================================================
 *  Socket (opcional)
 *  ========================================================= */
const BACKEND_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL as string) ||
  (Platform.OS === 'web' ? 'http://localhost:3000' : 'http://192.168.0.10:3000');

export default function AirfieldSetup() {
  const { role } = useUser();
  return role === 'aeroclub' ? <AirfieldSetupEditor /> : <Redirect href="/welcome" />;
}

function AirfieldSetupEditor() {
  const router = useRouter();

  // Estado cabeceras
  const [cabeceraA, setCabeceraA] = useState<LatLng | null>(null);
  const [cabeceraB, setCabeceraB] = useState<LatLng | null>(null);
  const [fase, setFase] = useState<'A' | 'B'>('A');

  // Meteo
  const [viento, setViento] = useState<number | null>(null);
  const [velocidadViento, setVelocidadViento] = useState<number | null>(null);
  const [visibilidad, setVisibilidad] = useState<number | null>(null);
  const [nubosidad, setNubosidad] = useState<number | null>(null);
  const [temperatura, setTemperatura] = useState<number | null>(null);
  const [presion, setPresion] = useState<number | null>(null);

  // Cabecera activa
  const [cabeceraActiva, setCabeceraActiva] = useState<'A' | 'B' | null>(null);

  // Identificador ingresado por el admin (lado A)
  const [identIngresado, setIdentIngresado] = useState<string>('');

  // Socket opcional
// ✅ Después
    const socket: IOSocket | null = useMemo(() => {
      try {
        const s = ioDefault(BACKEND_URL, { transports: ['websocket'], autoConnect: true });
        s.on('connect_error', () => {});
        return s;
      } catch {
        return null;
      }
    }, []);


  useEffect(() => {
    const lat = -31.4;
    const lon = -62.1;
    const obtenerDatosMeteo = async () => {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=wind_direction,wind_speed,cloud_cover,visibility,temperature_2m,surface_pressure`;
        const response = await fetch(url);
        const data = await response.json();
        const c = data.current ?? {};
        if (c.wind_direction !== undefined) setViento(c.wind_direction);
        if (c.wind_speed !== undefined) setVelocidadViento(c.wind_speed);
        if (c.visibility !== undefined) setVisibilidad(c.visibility);
        if (c.cloud_cover !== undefined) setNubosidad(c.cloud_cover);
        if (c.temperature_2m !== undefined) setTemperatura(c.temperature_2m);
        if (c.surface_pressure !== undefined) setPresion(c.surface_pressure);
      } catch (error) {
        console.error('Error al obtener datos meteorológicos:', error);
      }
    };
    obtenerDatosMeteo();
    return () => { try { socket?.disconnect(); } catch {} };
  }, [socket]);

  const manejarToqueMapa = (e: any) => {
    const punto: LatLng = e.nativeEvent.coordinate;
    if (fase === 'A') {
      setCabeceraA(punto);
      setFase('B');
    } else {
      setCabeceraB(punto);
    }
  };

  const elegirCabeceraPorViento = () => {
    if (!cabeceraA || !cabeceraB || viento === null) {
      Alert.alert('Faltan datos', 'Definí las cabeceras y asegurate de que el viento esté disponible.');
      return;
    }
    const rumboAB = calcularRumbo(cabeceraA, cabeceraB);
    const difA = diffAngle(viento, rumboAB);
    const difB = diffAngle(viento, (rumboAB + 180) % 360);
    const activa = difA < difB ? 'A' : 'B';
    setCabeceraActiva(activa);
    Alert.alert('Cabecera activa', `La cabecera ${activa} tiene viento en contra.`);
  };

  const buildAirfield = (): Airfield | null => {
    if (!cabeceraA || !cabeceraB) {
      Alert.alert('Faltan datos', 'Debes definir ambas cabeceras A y B.');
      return null;
    }
    const rumboAB = calcularRumbo(cabeceraA, cabeceraB);
    const identA = identIngresado?.trim() || headingToRunwayIdent(rumboAB);
    const identB = headingToRunwayIdent((rumboAB + 180) % 360);
    const active_end: 'A' | 'B' = (cabeceraActiva || 'A');

    const meteo: Meteo = {
      windDirection: viento ?? undefined,
      windSpeed: velocidadViento ?? undefined,
      visibility: visibilidad ?? undefined,
      cloudCover: nubosidad ?? undefined,
      temperature: temperatura ?? undefined,
      pressure: presion ?? undefined,
    };

    const rw: Runway = {
      id: uuid(),
      identA,
      identB,
      thresholdA: { lat: cabeceraA.latitude, lng: cabeceraA.longitude },
      thresholdB: { lat: cabeceraB.latitude, lng: cabeceraB.longitude },
      heading_true_ab: rumboAB,
      active_end,
    };

    const af: Airfield = {
      id: uuid(),
      location: midpoint(cabeceraA, cabeceraB),
      runways: [rw],
      meteo,
      lastUpdated: Date.now(),
      source: 'manual',
    };
    return af;
  };

  const persistAndBroadcast = async (airfield: Airfield) => {
    await AsyncStorage.setItem('airfieldActive', JSON.stringify(airfield));
    const legacy = {
      runway: {
        A: { latitude: airfield.runways[0].thresholdA.lat, longitude: airfield.runways[0].thresholdA.lng },
        B: { latitude: airfield.runways[0].thresholdB.lat, longitude: airfield.runways[0].thresholdB.lng },
      },
      defaultActiveHeading: airfield.runways[0].active_end || 'A',
      numero: airfield.runways[0].identA,
      meteo: {
        windDirection: airfield.meteo?.windDirection,
        windSpeed: airfield.meteo?.windSpeed,
        visibility: airfield.meteo?.visibility,
        cloudCover: airfield.meteo?.cloudCover,
        temperature: airfield.meteo?.temperature,
        pressure: airfield.meteo?.pressure,
      },
    };
    await AsyncStorage.setItem('pistaActiva', JSON.stringify(legacy));
    try { socket?.emit?.('airfield-upsert', { airfield }); } catch {}
  };

  const guardarPista = async () => {
    if (!cabeceraA || !cabeceraB) {
      Alert.alert('Faltan datos', 'Debes definir ambas cabeceras A y B.');
      return;
    }
    const airfield = buildAirfield();
    if (!airfield) return;

    await persistAndBroadcast(airfield);

    // 👉 Navegar automáticamente al screen de detalles para completar datos
    router.push('/AirfieldDetails');
  };

  return (
    <View style={{ flex: 1 }}>
      <MapView
        style={{ flex: 1 }}
        onPress={manejarToqueMapa}
        initialRegion={{
          latitude: -31.4,
          longitude: -62.1,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01,
        }}
      >
        {cabeceraA && <Marker coordinate={cabeceraA} title="Cabecera A" pinColor="blue" />}
        {cabeceraB && <Marker coordinate={cabeceraB} title="Cabecera B" pinColor="red" />}
        {cabeceraA && cabeceraB && (
          <Polyline coordinates={[cabeceraA, cabeceraB]} strokeColor="black" strokeWidth={2} />
        )}
      </MapView>

      <View style={styles.panel}>
        <Text style={styles.text}>Toque el mapa para marcar cabecera {fase}</Text>

        <Text style={styles.label}>Número/Identificador de pista (lado A)</Text>
        <TextInput
          value={identIngresado}
          onChangeText={setIdentIngresado}
          placeholder="Ej: 18L (opcional, se puede autocalcular)"
          style={styles.input}
          autoCapitalize="characters"
        />

        {viento !== null && <Text style={styles.textSmall}>Viento actual: {viento}°</Text>}
        {velocidadViento !== null && <Text style={styles.textSmall}>Velocidad del viento: {velocidadViento} km/h</Text>}
        {visibilidad !== null && <Text style={styles.textSmall}>Visibilidad: {visibilidad} m</Text>}
        {nubosidad !== null && <Text style={styles.textSmall}>Nubosidad: {nubosidad}%</Text>}
        {temperatura !== null && <Text style={styles.textSmall}>Temperatura: {temperatura} °C</Text>}
        {presion !== null && <Text style={styles.textSmall}>Presión atmosférica: {presion} hPa</Text>}

        <View style={styles.row}>
          <Button title="Cabecera con viento en contra" onPress={elegirCabeceraPorViento} />
        </View>
        <View style={styles.row}>
          <Button title="Guardar pista activa" onPress={guardarPista} color="green" />
        </View>
        {cabeceraActiva && <Text style={styles.textSmall}>Cabecera activa seleccionada: {cabeceraActiva}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { padding: 12, backgroundColor: '#fff' },
  row: { marginVertical: 6 },
  text: { marginBottom: 10, fontWeight: 'bold', fontSize: 16 },
  textSmall: { marginBottom: 6 },
  label: { fontWeight: '600', marginBottom: 6 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 10, marginBottom: 10 },
});

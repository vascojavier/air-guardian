// C:\air-guardian\frontend\app\AirfieldDetails.tsx
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Button,
  StyleSheet,
  ScrollView,
  Alert,
  Platform,
  KeyboardAvoidingView,
  TouchableWithoutFeedback,
  Keyboard,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Airfield, Runway } from '../types/airfield';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { socket } from '../utils/socket';

export default function AirfieldDetails() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [airfield, setAirfield] = useState<Airfield | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('airfieldActive');
        if (raw) setAirfield(JSON.parse(raw));
      } catch (e) {
        console.warn('No pude leer airfieldActive:', e);
      }
    })();
  }, []);

  const update = (patch: Partial<Airfield>) => {
    if (!airfield) return;
    setAirfield({ ...airfield, ...patch, lastUpdated: Date.now() });
  };

  const updateRunway = (patch: Partial<Runway>) => {
    if (!airfield) return;
    const rw = { ...airfield.runways[0], ...patch };
    setAirfield({ ...airfield, runways: [rw], lastUpdated: Date.now() });
  };

  const ensureSocketConnected = () =>
    new Promise<void>((resolve, reject) => {
      if (socket.connected) return resolve();
      const onConnect = () => {
        socket.off('connect_error', onError);
        resolve();
      };
      const onError = (err: any) => {
        socket.off('connect', onConnect);
        reject(err);
      };
      socket.once('connect', onConnect);
      socket.once('connect_error', onError);
      socket.connect();
    });

  const save = async () => {
    if (!airfield) return;

    // 1) Guardar local
    await AsyncStorage.setItem('airfieldActive', JSON.stringify(airfield));

    // 2) Publicar por WS (asegurando conexión)
    try {
      await ensureSocketConnected();
      socket.emit('airfield-upsert', { airfield });
      Alert.alert('Publicado', 'La pista fue publicada y se enviará a todos.');
    } catch (e) {
      console.warn('airfield-upsert falló:', e);
      Alert.alert(
        'Aviso',
        'Se guardó localmente, pero no pude publicarla al servidor.'
      );
    }

    // 3) Ir a Radar
    router.push('/Radar');
  };

  const cancel = () => {
    router.back();
  };

  if (!airfield) {
    return (
      <View style={styles.center}>
        <Text>Cargando…</Text>
      </View>
    );
  }

  const rw = airfield.runways[0];

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={styles.flex}>
            <ScrollView
              style={styles.flex}
              contentContainerStyle={[
                styles.content,
                { paddingBottom: (insets.bottom || 16) + 100 }, // espacio para el footer fijo
              ]}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.h1}>Detalles de Aeródromo</Text>

              <Text style={styles.label}>Nombre</Text>
              <TextInput
                style={styles.input}
                value={airfield.name ?? ''}
                onChangeText={(v) => update({ name: v })}
                placeholder="Nombre (opcional)"
              />

              <View style={styles.row}>
                <View style={styles.col}>
                  <Text style={styles.label}>ICAO</Text>
                  <TextInput
                    style={styles.input}
                    value={airfield.icao ?? ''}
                    onChangeText={(v) => update({ icao: v })}
                    autoCapitalize="characters"
                    placeholder="Ej: SAEZ"
                  />
                </View>
                <View style={styles.col}>
                  <Text style={styles.label}>IATA</Text>
                  <TextInput
                    style={styles.input}
                    value={airfield.iata ?? ''}
                    onChangeText={(v) => update({ iata: v })}
                    autoCapitalize="characters"
                    placeholder="Ej: EZE"
                  />
                </View>
              </View>

              <View style={styles.row}>
                <View style={styles.col}>
                  <Text style={styles.label}>País (ISO)</Text>
                  <TextInput
                    style={styles.input}
                    value={airfield.country ?? ''}
                    onChangeText={(v) => update({ country: v })}
                    autoCapitalize="characters"
                    placeholder="AR, NL, etc."
                  />
                </View>
                <View style={styles.col}>
                  <Text style={styles.label}>Elevación (ft)</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="numeric"
                    value={airfield.elevation_ft?.toString() ?? ''}
                    onChangeText={(v) =>
                      update({ elevation_ft: v ? Number(v) : undefined })
                    }
                    placeholder="Ej: 1500"
                  />
                </View>
              </View>

              <Text style={[styles.h1, { marginTop: 16 }]}>Pista</Text>

              <View style={styles.row}>
                <View style={styles.col}>
                  <Text style={styles.label}>Ident A</Text>
                  <TextInput
                    style={styles.input}
                    value={rw.identA}
                    onChangeText={(v) => updateRunway({ identA: v })}
                    autoCapitalize="characters"
                    placeholder="Ej: 18"
                  />
                </View>
                <View style={styles.col}>
                  <Text style={styles.label}>Ident B</Text>
                  <TextInput
                    style={styles.input}
                    value={rw.identB}
                    onChangeText={(v) => updateRunway({ identB: v })}
                    autoCapitalize="characters"
                    placeholder="Ej: 36"
                  />
                </View>
              </View>

              <View style={styles.row}>
                <View style={styles.col}>
                  <Text style={styles.label}>Longitud (m)</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="numeric"
                    value={rw.length_m?.toString() ?? ''}
                    onChangeText={(v) =>
                      updateRunway({ length_m: v ? Number(v) : undefined })
                    }
                    placeholder="Ej: 1200"
                  />
                </View>
                <View style={styles.col}>
                  <Text style={styles.label}>Ancho (m)</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="numeric"
                    value={rw.width_m?.toString() ?? ''}
                    onChangeText={(v) =>
                      updateRunway({ width_m: v ? Number(v) : undefined })
                    }
                    placeholder="Ej: 30"
                  />
                </View>
              </View>

              <Text style={styles.label}>Superficie</Text>
              <TextInput
                style={styles.input}
                value={rw.surface ?? ''}
                onChangeText={(v) => updateRunway({ surface: v })}
                placeholder="Asfalto, Tierra, Pasto…"
              />

              <Text style={styles.label}>Notas</Text>
              <TextInput
                style={[styles.input, { height: 90 }]}
                value={rw.notes ?? ''}
                onChangeText={(v) => updateRunway({ notes: v })}
                multiline
                placeholder="Información adicional (opcional)"
              />

              <Text style={styles.label}>Cabecera activa (A/B)</Text>
              <TextInput
                style={styles.input}
                value={rw.active_end ?? 'A'}
                onChangeText={(v) =>
                  updateRunway({ active_end: v === 'B' ? 'B' : 'A' })
                }
                placeholder="A o B"
              />
            </ScrollView>

            {/* Footer fijo con safe area */}
            <View
              style={[
                styles.footer,
                { paddingBottom: (insets.bottom || 8) + 6 },
              ]}
            >
              <View style={styles.footerInner}>
                <View style={styles.footerBtn}>
                  <Button title="Cancelar" color="#666" onPress={cancel} />
                </View>
                <View style={styles.footerBtn}>
                  <Button title="Confirmar y publicar" onPress={save} />
                </View>
              </View>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  flex: { flex: 1 },
  content: { padding: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 18, fontWeight: 'bold', marginBottom: 8 },
  label: { fontWeight: '600', marginTop: 8, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    padding: 10,
    backgroundColor: '#fff',
  },
  row: { flexDirection: 'row', gap: 12 },
  col: { flex: 1 },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0, // se respeta safe area con paddingBottom dinámico
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ddd',
  },
  footerInner: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
    flexDirection: 'row',
    gap: 10,
  },
  footerBtn: { flex: 1 },
});

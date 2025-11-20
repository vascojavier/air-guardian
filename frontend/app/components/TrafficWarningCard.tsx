import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Plane } from '../../types/Plane';

type Props = {
  // Permitimos que el objeto traiga opcionalmente "ops"
  aircraft: Plane & { ops?: string };
  distance: number;
};

export default function TrafficWarningCard({ aircraft, distance }: Props) {
  if (!aircraft) return null;

  // Estilos y título según alerta
  let bgColor = '#ffffff';
  let borderColor = '#cccccc';
  let textColor = '#333333';
  let title = aircraft.name || 'Avión seleccionado';

  if (aircraft.alertLevel === 'TA') {
    bgColor = '#fff3cd';
    borderColor = '#ffeeba';
    textColor = '#856404';
    title = '⚠️ Tráfico cercano (TA)';
  } else if (aircraft.alertLevel === 'RA_LOW') {
    bgColor = '#ffe5b4';
    borderColor = '#ffbb66';
    textColor = '#7a3e00';
    title = '⚠️ Conflicto potencial (RA < 3 min)';
  } else if (aircraft.alertLevel === 'RA_HIGH') {
    bgColor = '#f8d7da';
    borderColor = '#f5c6cb';
    textColor = '#721c24';
    title = '🚨 Riesgo inminente (RA < 1 min)';
  }

  return (
    <View style={[styles.container, { backgroundColor: bgColor, borderColor }]}>
      <Text style={[styles.warning, { color: textColor }]}>{title}</Text>

      <Text style={[styles.label, { color: textColor }]}>
        Tipo: <Text style={styles.value}>{aircraft.type || 'Desconocido'}</Text>{'   '}
        Matrícula: <Text style={styles.value}>{aircraft.callsign || 'N/A'}</Text>
      </Text>

      <Text style={[styles.label, { color: textColor }]}>
        Piloto: <Text style={styles.value}>{aircraft.name}</Text>
      </Text>

      {/* ✅ NUEVO: línea con el estado OPS si viene disponible */}
      {aircraft.ops ? (
        <Text style={[styles.label, { color: textColor }]}>
          OPS: <Text style={styles.value}>{aircraft.ops}</Text>
        </Text>
      ) : null}

      <Text style={[styles.label, { color: textColor }]}>
        Distancia: <Text style={styles.value}>{Math.round(distance)} m</Text>
      </Text>

      <Text style={[styles.label, { color: textColor }]}>
        Altitud: <Text style={styles.value}>{aircraft.alt} m</Text>{'   '}
        Rumbo: <Text style={styles.value}>{aircraft.heading}°</Text>{'   '}
        Velocidad: <Text style={styles.value}>{aircraft.speed} km/h</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    margin: 10,
    elevation: 3,
  },
  warning: {
    fontWeight: 'bold',
    fontSize: 16,
    marginBottom: 5,
  },
  label: {
    fontSize: 14,
    marginBottom: 2,
  },
  value: {
    fontWeight: 'bold',
  },
});

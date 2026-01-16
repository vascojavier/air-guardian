import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Plane } from '../../types/Plane';
import { useUnits } from '../../src/units/UnitsContext';
import { useUser } from '../../context/UserContext';

type Props = {
  aircraft: Plane & { ops?: string };
  distance: number; // metros
};

export default function TrafficWarningCard({ aircraft, distance }: Props) {
  const { t } = useTranslation();
  const { formatDistance, formatAltitude, formatSpeed } = useUnits();
  const { username } = useUser();

  if (!aircraft) return null;

  let bgColor = '#ffffff';
  let borderColor = '#cccccc';
  let textColor = '#333333';
  let title = aircraft.name || t('common.selectedAircraft');

  if (aircraft.alertLevel === 'TA') {
    bgColor = '#fff3cd';
    borderColor = '#ffeeba';
    textColor = '#856404';
    title = `⚠️ ${t('warnings.ta')}`;
  } else if (aircraft.alertLevel === 'RA_LOW') {
    bgColor = '#ffe5b4';
    borderColor = '#ffbb66';
    textColor = '#7a3e00';
    title = `⚠️ ${t('warnings.raLow')}`;
  } else if (aircraft.alertLevel === 'RA_HIGH') {
    bgColor = '#f8d7da';
    borderColor = '#f5c6cb';
    textColor = '#721c24';
    title = `🚨 ${t('warnings.raHigh')}`;
  }

  const pilotName =
    aircraft.id === username
      ? t('aircraft.yourAircraft')
      : (aircraft.name || t('common.unknown'));

  return (
    <View style={[styles.container, { backgroundColor: bgColor, borderColor }]}>
      <Text style={[styles.warning, { color: textColor }]}>{title}</Text>

      <Text style={[styles.label, { color: textColor }]}>
        {t('aircraft.type')}: <Text style={styles.value}>{aircraft.type || t('common.unknown')}</Text>{'   '}
        {t('aircraft.callsign')}: <Text style={styles.value}>{aircraft.callsign || 'N/A'}</Text>
      </Text>

      <Text style={[styles.label, { color: textColor }]}>
        {t('aircraft.pilot')}: <Text style={styles.value}>{pilotName}</Text>
      </Text>

      {aircraft.ops && (
        <Text style={[styles.label, { color: textColor }]}>
          OPS: <Text style={styles.value}>{aircraft.ops}</Text>
        </Text>
      )}

      <Text style={[styles.label, { color: textColor }]}>
        {t('warnings.distance')}: <Text style={styles.value}>{formatDistance(distance)}</Text>
      </Text>

      <Text style={[styles.label, { color: textColor }]}>
        {t('radar.altitude')}: <Text style={styles.value}>{formatAltitude(aircraft.alt)}</Text>{'   '}
        {t('radar.heading')}: <Text style={styles.value}>{aircraft.heading}°</Text>{'   '}
        {t('radar.speed')}: <Text style={styles.value}>{formatSpeed(aircraft.speed)}</Text>
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

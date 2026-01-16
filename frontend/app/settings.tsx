import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Switch,
  TextInput,
  Button,
  Alert,
  ScrollView,
} from "react-native";
import { Picker } from "@react-native-picker/picker";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";

import {
  useSettings,
  AppLanguage,
  DistanceUnit,
  AltitudeUnit,
  SpeedUnit,
} from "../context/SettingsContext";

// ✅ Ajustá este path si tu UnitsContext está en otro lado
import { useUnits, UnitSystem } from "../src/units/UnitsContext";

export default function SettingsScreen() {
  const { t } = useTranslation();
  const { settings, setSetting, resetSettings } = useSettings();
  const { prefs, setSystem, isLoaded: unitsLoaded } = useUnits();

  // Inputs locales (evitan escribir storage en cada tecla)
  const [nearbyTrafficMeters, setNearbyTrafficMeters] = useState(
    String(settings.nearbyTrafficMeters)
  );

  // Si cambian settings desde storage/reset, reflejar en input
  useEffect(() => {
    setNearbyTrafficMeters(String(settings.nearbyTrafficMeters));
  }, [settings.nearbyTrafficMeters]);

  const saveThresholds = async () => {
    const v = Number(nearbyTrafficMeters);
    if (!Number.isFinite(v) || v < 50 || v > 50000) {
      Alert.alert("Error", "Nearby traffic debe estar entre 50 y 50000 metros.");
      return;
    }
    await setSetting("nearbyTrafficMeters", v);
    Alert.alert("OK", "Settings guardados.");
  };

  // ✅ Map “UnitSystem” -> unidades finas coherentes
  const applySystemDefaults = async (system: UnitSystem) => {
    if (system === "aviation") {
      await setSetting("distanceUnit", "nm" as DistanceUnit);
      await setSetting("altitudeUnit", "ft" as AltitudeUnit);
      await setSetting("speedUnit", "kt" as SpeedUnit);
      return;
    }

    if (system === "metric") {
      await setSetting("distanceUnit", "km" as DistanceUnit);
      await setSetting("altitudeUnit", "m" as AltitudeUnit);
      await setSetting("speedUnit", "kmh" as SpeedUnit);
      return;
    }

    if (system === "imperial") {
      await setSetting("distanceUnit", "mi" as DistanceUnit);
      await setSetting("altitudeUnit", "ft" as AltitudeUnit);
      await setSetting("speedUnit", "mph" as SpeedUnit);
      return;
    }
  };

  const onChangeSystem = async (system: UnitSystem) => {
    setSystem(system); // UnitsContext
    await applySystemDefaults(system); // SettingsContext (unidades finas)
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>⚙️ {t("settings.title")}</Text>

      {/* ========== IDIOMA ========== */}
      <Text style={styles.section}>{t("settings.language")}</Text>
      <View style={styles.card}>
        <Picker
          selectedValue={settings.language}
          onValueChange={(v) => setSetting("language", v as AppLanguage)}
        >
          <Picker.Item label={t("settings.system")} value="system" />
          <Picker.Item label={t("settings.english")} value="en" />
          <Picker.Item label={t("settings.spanish")} value="es" />
        </Picker>
      </View>

      {/* ========== UNIDADES ========== */}
      <Text style={styles.section}>Units</Text>
      <View style={styles.card}>
        {/* ✅ Units system (UnitsContext) */}
        <Text style={styles.label}>Units system</Text>
        <Picker
          enabled={unitsLoaded}
          selectedValue={prefs.system}
          onValueChange={(v) => onChangeSystem(v as UnitSystem)}
        >
          <Picker.Item label="Aviation (nm / ft / kt)" value="aviation" />
          <Picker.Item label="Metric (km / m / km/h)" value="metric" />
          <Picker.Item label="Imperial (mi / ft / mph)" value="imperial" />
        </Picker>

        <View style={{ height: 10 }} />

        {/* ✅ Unidades finas (SettingsContext) */}
        <Text style={styles.label}>Distance</Text>
        <Picker
          selectedValue={settings.distanceUnit}
          onValueChange={(v) => setSetting("distanceUnit", v as DistanceUnit)}
        >
          <Picker.Item label="meters (m)" value="m" />
          <Picker.Item label="kilometers (km)" value="km" />
          <Picker.Item label="nautical miles (nm)" value="nm" />
          <Picker.Item label="miles (mi)" value="mi" />
        </Picker>

        <Text style={styles.label}>Altitude</Text>
        <Picker
          selectedValue={settings.altitudeUnit}
          onValueChange={(v) => setSetting("altitudeUnit", v as AltitudeUnit)}
        >
          <Picker.Item label="meters (m)" value="m" />
          <Picker.Item label="feet (ft)" value="ft" />
        </Picker>

        <Text style={styles.label}>Speed</Text>
        <Picker
          selectedValue={settings.speedUnit}
          onValueChange={(v) => setSetting("speedUnit", v as SpeedUnit)}
        >
          <Picker.Item label="km/h" value="kmh" />
          <Picker.Item label="knots (kt)" value="kt" />
          <Picker.Item label="mph" value="mph" />
        </Picker>
      </View>

      {/* ========== AUDIO ========== */}
      <Text style={styles.section}>Audio</Text>
      <View style={styles.card}>
        <Row
          label="Warning sounds"
          value={settings.warningSoundsEnabled}
          onChange={(v) => setSetting("warningSoundsEnabled", v)}
        />
        <Row
          label="Voice (TTS)"
          value={settings.ttsEnabled}
          onChange={(v) => setSetting("ttsEnabled", v)}
        />
      </View>

      {/* ========== WARNINGS ========== */}
      <Text style={styles.section}>Warnings</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Nearby traffic distance (meters)</Text>
        <TextInput
          style={styles.input}
          keyboardType="numeric"
          value={nearbyTrafficMeters}
          onChangeText={setNearbyTrafficMeters}
          placeholder="1500"
        />

        <Button title="Save thresholds" onPress={saveThresholds} />
      </View>

      <View style={{ height: 20 }} />

      <View style={styles.rowButtons}>
        <Button title="⬅ Back" onPress={() => router.back()} />
        <Button
          title="Reset"
          color="#b00020"
          onPress={() =>
            Alert.alert("Reset", "Reset all settings?", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Reset",
                style: "destructive",
                onPress: async () => {
                  // Reset SettingsContext
                  await resetSettings();

                  // Reset UnitsContext + aplicar defaults coherentes
                  setSystem("aviation");
                  await applySystemDefaults("aviation");

                  Alert.alert("OK", "Settings reseteados.");
                },
              },
            ])
          }
        />
      </View>
    </ScrollView>
  );
}

function Row({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 40,
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
    marginBottom: 12,
  },
  section: {
    marginTop: 16,
    marginBottom: 8,
    fontSize: 16,
    fontWeight: "800",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ddd",
    padding: 12,
  },
  label: {
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  rowButtons: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
});

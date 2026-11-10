import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { useUser } from "../context/UserContext";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ADMIN_KEY_STORAGE, resolveAdminKey } from "../utils/adminKey";

export default function WelcomeScreen() {
  const { t } = useTranslation();
  const { admin } = useLocalSearchParams<{ admin?: string }>();
  const { setUser, setAircraft, username, callsign, aircraftType, aircraftModel, aircraftIcon } = useUser();
  const bullets = useMemo(
    () => [
      "Radar + alerts estilo TCAS para aviación general y planeadores",
      "Secuenciación de aterrizajes y despegues con pista compartida",
      "Airfield & runway en tiempo real (ideal para aeroclubes)",
    ],
    []
  );

  const [adminMode, setAdminMode] = useState(admin === "1");
  const [adminPass, setAdminPass] = useState("");

  const goPilot = () => router.replace("/");

  const continueAdmin = async () => {
    let configuredKey: string;
    try {
      configuredKey = resolveAdminKey(await AsyncStorage.getItem(ADMIN_KEY_STORAGE)).toLowerCase();
    } catch {
      Alert.alert(t("index.restrictedTitle"), t("index.restrictedBody"));
      return;
    }
    const pass = adminPass.trim().toLowerCase();
    const valid = pass === configuredKey;
    if (!valid) {
      Alert.alert(t("auth.wrongPasswordTitle"), t("auth.wrongPasswordBody"));
      return;
    }

    setAdminPass("");
    setUser(username || "Admin", "aeroclub", callsign || "ADM");
    setAircraft(aircraftType || "motor", aircraftModel || t("index.genericAircraft"), aircraftIcon || "2", callsign || "ADM");
    router.replace("/Pista");
  };

  const cancelAdmin = () => {
    setAdminMode(false);
    setAdminPass("");
    if (admin === "1" && router.canGoBack()) router.back();
  };

  if (adminMode) {
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.adminPage}>
          <View style={styles.adminBox}>
            <Text style={styles.adminTitle}>{t("pistaAdmin.title")}</Text>
            <Text style={styles.adminLabel}>{t("auth.adminPassword")}</Text>
            <TextInput
              value={adminPass}
              onChangeText={setAdminPass}
              accessibilityLabel={t("auth.adminPassword")}
              placeholder={t("auth.passwordPlaceholder")}
              placeholderTextColor="rgba(255,255,255,0.45)"
              style={styles.adminInput}
              secureTextEntry
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={() => void continueAdmin()}
            />
            <View style={styles.adminButtonsRow}>
              <TouchableOpacity onPress={continueAdmin} style={styles.adminGoBtn}>
                <Text style={styles.adminGoText}>{t("welcome.continueAsAdmin")}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={cancelAdmin} style={styles.adminCancelBtn}>
                <Text style={styles.adminCancelText}>{t("common.cancel")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        {/* Logo (si no existe, comentá este bloque) */}
        <Image
          source={require("../assets/logo.png")}
          style={styles.logo}
          resizeMode="contain"
        />

        <Text style={styles.title}>Air-Guardian</Text>
        <Text style={styles.subtitle}>
          Ordená el tráfico. Reducí riesgo. Coordiná la pista.
        </Text>

        <View style={styles.bullets}>
          {bullets.map((b, i) => (
            <View key={i} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{b}</Text>
            </View>
          ))}
        </View>

        <View style={styles.buttons}>
          <TouchableOpacity onPress={goPilot} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Pilot</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setAdminMode(true)} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>{t("pistaAdmin.title")}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footer}>
          Primero valor (Radar + Airfield + Warnings). Después suscripción.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0B1220", justifyContent: "center" },
  card: {
    marginHorizontal: 16,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 22,
    paddingVertical: 26,
    paddingHorizontal: 18,
  },
  logo: { width: 110, height: 110, alignSelf: "center", marginBottom: 14 },
  title: {
    color: "white",
    fontSize: 34,
    fontWeight: "900",
    textAlign: "center",
    marginBottom: 6,
  },
  subtitle: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 18,
    lineHeight: 18,
  },
  bullets: {
    gap: 10,
    paddingHorizontal: 8,
    marginBottom: 18,
  },
  bulletRow: { flexDirection: "row", alignItems: "flex-start" },
  bulletDot: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 18,
    marginRight: 8,
    lineHeight: 20,
  },
  bulletText: {
    flex: 1,
    color: "rgba(255,255,255,0.85)",
    fontSize: 13,
    lineHeight: 18,
  },
  buttons: { gap: 10, marginTop: 6 },

  primaryBtn: {
    backgroundColor: "#2F6BFF",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
  },
  primaryBtnText: { color: "white", fontWeight: "900", fontSize: 16 },

  secondaryBtn: {
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
  },
  secondaryBtnText: { color: "white", fontWeight: "800", fontSize: 16 },

  adminPage: { flexGrow: 1, justifyContent: "center", padding: 16 },
  adminTitle: { color: "white", fontSize: 20, fontWeight: "800" },
  adminBox: {
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: 14,
    padding: 12,
    gap: 10,
  },
  adminLabel: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 13,
    fontWeight: "700",
  },
  adminInput: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: "white",
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  adminButtonsRow: { flexDirection: "row", gap: 10 },
  adminGoBtn: {
    flex: 1,
    backgroundColor: "#6C63FF",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  adminGoText: { color: "white", fontWeight: "900" },
  adminCancelBtn: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  adminCancelText: { color: "white", fontWeight: "800" },

  footer: {
    marginTop: 14,
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
    textAlign: "center",
    lineHeight: 16,
  },
});

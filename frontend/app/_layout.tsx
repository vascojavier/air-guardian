import React, { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { View, Text } from "react-native";

import "../src/i18n";
import { loadAppLanguageOnStart } from "../src/i18n/language"; // ✅ tu helper

import { UserProvider } from "../context/UserContext";
import { SettingsProvider } from "../context/SettingsContext";
import { UnitsProvider } from "../src/units/UnitsContext";

export default function RootLayout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await loadAppLanguageOnStart();
      } catch (e) {
        // si falla, no bloqueamos la app
        console.warn("loadAppLanguageOnStart failed:", e);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>Loading…</Text>
      </View>
    );
  }

  return (
    <SettingsProvider>
      <UnitsProvider>
        <UserProvider>
          <Stack initialRouteName="welcome" />
        </UserProvider>
      </UnitsProvider>
    </SettingsProvider>
  );
}

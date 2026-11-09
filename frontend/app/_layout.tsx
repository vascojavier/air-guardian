import React from "react";
import { Stack } from "expo-router";
import { View, Text } from "react-native";

import "../src/i18n";

import { UserProvider } from "../context/UserContext";
import { SettingsProvider, useSettings } from "../context/SettingsContext";
import { UnitsProvider } from "../src/units/UnitsContext";

function AppNavigator() {
  const { isLoaded } = useSettings();

  if (!isLoaded) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>Loading…</Text>
      </View>
    );
  }

  return <Stack initialRouteName="welcome" />;
}

export default function RootLayout() {
  return (
    <SettingsProvider>
      <UnitsProvider>
        <UserProvider>
          <AppNavigator />
        </UserProvider>
      </UnitsProvider>
    </SettingsProvider>
  );
}

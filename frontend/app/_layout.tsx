import React from "react";
import { Stack } from "expo-router";

import "../src/i18n";
import { UserProvider } from "../context/UserContext";
import { SettingsProvider } from "../context/SettingsContext";
import { UnitsProvider } from "../src/units/UnitsContext";

export default function RootLayout() {
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

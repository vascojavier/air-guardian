// frontend/context/SettingsContext.tsx
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import i18n from "i18next";
import * as Localization from "expo-localization";

export type AppLanguage = "system" | "en" | "es";
export type DistanceUnit = "m" | "km" | "nm" | "mi";
export type AltitudeUnit = "m" | "ft";
export type SpeedUnit = "kmh" | "kt" | "mph";

export type AppSettings = {
  language: AppLanguage;

  // Units
  distanceUnit: DistanceUnit;
  altitudeUnit: AltitudeUnit;
  speedUnit: SpeedUnit;

  // Audio / Voice
  warningSoundsEnabled: boolean;
  ttsEnabled: boolean;

  // Warning thresholds (unidades internas: metros / segundos)
  nearbyTrafficMeters: number;
  taTimeSec: number;
  ra3TimeSec: number;
  ra1TimeSec: number;

  // RA params
  raMinDistMeters: number;
};

type SettingsContextValue = {
  settings: AppSettings;
  isLoaded: boolean;
  setSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  resetSettings: () => Promise<void>;
};

const STORAGE_KEY = "airguardian:settings:v1";

const defaultSettings: AppSettings = {
  language: "system",

  distanceUnit: "m",
  altitudeUnit: "m",
  speedUnit: "kmh",

  warningSoundsEnabled: true,
  ttsEnabled: true,

  nearbyTrafficMeters: 1500,
  taTimeSec: 180,
  ra3TimeSec: 180,
  ra1TimeSec: 60,

  raMinDistMeters: 2000,
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);

        if (raw) {
          const parsed = JSON.parse(raw) as Partial<AppSettings>;

          const merged: AppSettings = { ...defaultSettings, ...parsed };

          // Sanitizar números mínimos
          merged.nearbyTrafficMeters = clampNum(
            merged.nearbyTrafficMeters,
            50,
            50000,
            defaultSettings.nearbyTrafficMeters
          );
          merged.taTimeSec = clampNum(merged.taTimeSec, 5, 3600, defaultSettings.taTimeSec);
          merged.ra3TimeSec = clampNum(merged.ra3TimeSec, 5, 3600, defaultSettings.ra3TimeSec);
          merged.ra1TimeSec = clampNum(merged.ra1TimeSec, 5, 3600, defaultSettings.ra1TimeSec);

          merged.raMinDistMeters = clampNum(
            merged.raMinDistMeters,
            100,
            50000,
            defaultSettings.raMinDistMeters
          );

          setSettings(merged);

          // ✅ Aplicar idioma (incluyendo system)
          await applyLanguage(merged.language);
        } else {
          // ✅ Primer arranque: si default es system, aplicamos locale del device igual
          await applyLanguage(defaultSettings.language);
        }
      } catch (e) {
        console.warn("Settings load error:", e);
        // Incluso si hay error, intentá aplicar system al menos
        try {
          await applyLanguage(defaultSettings.language);
        } catch {}
      } finally {
        setIsLoaded(true);
      }
    })();
  }, []);

  const setSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    // ✅ evita stale state
    let next: AppSettings | null = null;

    setSettings((prev) => {
      next = { ...prev, [key]: value } as AppSettings;
      return next!;
    });

    try {
      // Si cambia idioma, aplicarlo en vivo (incluye system)
      if (key === "language") {
        await applyLanguage(value as AppLanguage);
      }

      // Persistir
      if (next) {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      }
    } catch (e) {
      console.warn("Settings save/apply error:", e);
    }
  };

  const resetSettings = async () => {
    setSettings(defaultSettings);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(defaultSettings));
    } catch {}

    try {
      await applyLanguage(defaultSettings.language);
    } catch {}
  };

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, isLoaded, setSetting, resetSettings }),
    [settings, isLoaded]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

// ---- helpers ----
function clampNum(v: any, min: number, max: number, fallback: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function resolveDeviceLanguage(): "en" | "es" {
  const locales = Localization.getLocales?.() ?? [];
  const first = locales[0];

  // Preferimos languageTag si existe (ej: "es-AR", "en-US")
  const tag = (first?.languageTag || "").toLowerCase();
  if (tag.startsWith("es")) return "es";
  if (tag.startsWith("en")) return "en";

  // Fallback: languageCode (ej: "es", "en")
  const code = (first?.languageCode || "").toLowerCase();
  if (code === "es") return "es";
  if (code === "en") return "en";

  // Último fallback
  return "en";
}

async function applyLanguage(lang: AppLanguage) {
  try {
    if (lang === "system") {
      const deviceLang = resolveDeviceLanguage();
      await i18n.changeLanguage(deviceLang);
    } else {
      await i18n.changeLanguage(lang);
    }
  } catch {
    // no-op
  }
}

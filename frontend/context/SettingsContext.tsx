// frontend/context/SettingsContext.tsx
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import i18n from "../src/i18n";
import { AppLanguage, readLanguagePreference, resolveLanguage } from "../src/i18n/language";
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
  const settingsRef = useRef(defaultSettings);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);

        const parsed = raw ? JSON.parse(raw) as Partial<AppSettings> : {};
        const legacy = await AsyncStorage.getItem("airguardian.language");

        const merged: AppSettings = {
          ...defaultSettings,
          ...parsed,
          language: readLanguagePreference(parsed.language) ?? readLanguagePreference(legacy) ?? "system",
        };

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

        settingsRef.current = merged;
        setSettings(merged);

        // ✅ Aplicar idioma (incluyendo system)
        await applyLanguage(merged.language);
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

  useEffect(() => {
    if (!isLoaded || settings.language !== "system") return;

    const subscription = AppState.addEventListener("change", state => {
      if (state === "active" && i18n.resolvedLanguage !== resolveLanguage("system")) {
        void applyLanguage("system").catch(console.warn);
      }
    });
    return () => subscription.remove();
  }, [isLoaded, settings.language]);

  const setSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = { ...settingsRef.current, [key]: value };
    settingsRef.current = next;
    setSettings(next);

    try {
      const save = AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      if (key === "language") await Promise.all([save, applyLanguage(next.language)]);
      else await save;
    } catch (e) {
      console.warn("Settings save/apply error:", e);
    }
  };

  const resetSettings = async () => {
    settingsRef.current = defaultSettings;
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

function applyLanguage(language: AppLanguage) {
  return i18n.changeLanguage(resolveLanguage(language));
}

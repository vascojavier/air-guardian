// frontend/src/units/UnitsContext.tsx
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type UnitSystem = "metric" | "imperial" | "aviation";
export type UnitPrefs = { system: UnitSystem };

const DEFAULT_PREFS: UnitPrefs = { system: "aviation" };
const KEY = "airguardian.unitPrefs";

type UnitsContextValue = {
  prefs: UnitPrefs;
  setSystem: (system: UnitSystem) => void;
  isLoaded: boolean;

  // ✅ Formatters (para UI)
  formatDistance: (meters: number) => string; // input SIEMPRE en metros
  formatAltitude: (meters: number) => string; // input SIEMPRE en metros (MSL/AGL según tu dato)
  formatSpeed: (kmh: number) => string;       // input SIEMPRE en km/h
};

const UnitsContext = createContext<UnitsContextValue | null>(null);

export function UnitsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<UnitPrefs>(DEFAULT_PREFS);
  const [isLoaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<UnitPrefs>;
          if (parsed?.system === "metric" || parsed?.system === "imperial" || parsed?.system === "aviation") {
            setPrefs({ system: parsed.system });
          }
        }
      } catch {}
      setLoaded(true);
    })();
  }, []);

  const setSystem = async (system: UnitSystem) => {
    const next: UnitPrefs = { system };
    setPrefs(next);
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify(next));
    } catch {}
  };

  // =========================
  // ✅ FORMATTERS (memoizados)
  // =========================
  const formatDistance = useMemo(() => {
    return (meters: number) => {
      if (!Number.isFinite(meters)) return "—";
      const sys = prefs.system;

      if (sys === "aviation") {
        const nm = metersToNm(meters);
        // 0–9.9 NM: 1 decimal, si no: entero
        return `${fmt(nm, nm < 10 ? 1 : 0)} NM`;
      }

      if (sys === "imperial") {
        const mi = metersToMi(meters);
        return `${fmt(mi, mi < 10 ? 1 : 0)} mi`;
      }

      // metric
      if (meters < 1000) return `${Math.round(meters)} m`;
      const km = metersToKm(meters);
      return `${fmt(km, km < 10 ? 1 : 0)} km`;
    };
  }, [prefs.system]);

  const formatAltitude = useMemo(() => {
    return (meters: number) => {
      if (!Number.isFinite(meters)) return "—";
      const sys = prefs.system;

      // Aviation e imperial normalmente usan ft
      if (sys === "aviation" || sys === "imperial") {
        const ft = metersToFt(meters);
        return `${Math.round(ft)} ft`;
      }

      return `${Math.round(meters)} m`;
    };
  }, [prefs.system]);

  const formatSpeed = useMemo(() => {
    return (kmh: number) => {
      if (!Number.isFinite(kmh)) return "—";
      const sys = prefs.system;

      if (sys === "aviation") {
        const kt = kmhToKt(kmh);
        return `${Math.round(kt)} kt`;
      }

      if (sys === "imperial") {
        const mph = kmhToMph(kmh);
        return `${Math.round(mph)} mph`;
      }

      // metric
      return `${Math.round(kmh)} km/h`;
    };
  }, [prefs.system]);

  const value = useMemo<UnitsContextValue>(
    () => ({
      prefs,
      setSystem,
      isLoaded,
      formatDistance,
      formatAltitude,
      formatSpeed,
    }),
    [prefs, isLoaded, formatDistance, formatAltitude, formatSpeed]
  );

  return <UnitsContext.Provider value={value}>{children}</UnitsContext.Provider>;
}

export function useUnits() {
  const ctx = useContext(UnitsContext);
  if (!ctx) throw new Error("useUnits must be used within UnitsProvider");
  return ctx;
}

// =========================
// Helpers de conversión/format
// =========================

function fmt(n: number, digits = 0) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function metersToNm(m: number) {
  return m / 1852;
}
function metersToMi(m: number) {
  return m / 1609.344;
}
function metersToKm(m: number) {
  return m / 1000;
}
function metersToFt(m: number) {
  return m * 3.280839895;
}

function kmhToKt(kmh: number) {
  return kmh / 1.852;
}
function kmhToMph(kmh: number) {
  return kmh / 1.609344;
}

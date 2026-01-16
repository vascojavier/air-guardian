export type UnitSystem = "metric" | "imperial" | "aviation";

export type UnitPrefs = {
  system: UnitSystem;
  // opcional: precisión, umbrales, etc.
};

export const defaultUnitPrefs: UnitPrefs = { system: "aviation" };

const M_TO_FT = 3.280839895;
const MPS_TO_KT = 1.943844492;   // si tu speed viene en m/s
const KMH_TO_KT = 0.539956803;   // si tu speed viene en km/h
const M_TO_NM = 0.000539956803;  // 1 m = 0.0005399 NM
const M_TO_MI = 0.000621371;

function round(n: number, digits = 0) {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

export function formatAltitude(meters: number, prefs: UnitPrefs) {
  if (!Number.isFinite(meters)) return "—";
  switch (prefs.system) {
    case "metric":
      return `${round(meters, 0)} m`;
    case "imperial":
    case "aviation":
      return `${round(meters * M_TO_FT, 0)} ft`;
  }
}

export function formatDistance(meters: number, prefs: UnitPrefs) {
  if (!Number.isFinite(meters)) return "—";

  // Para aviation, queda lindo: cerca en meters, lejos en NM
  if (prefs.system === "aviation") {
    if (meters < 1200) return `${round(meters, 0)} m`;
    return `${round(meters * M_TO_NM, 2)} NM`;
  }

  if (prefs.system === "metric") {
    if (meters < 1000) return `${round(meters, 0)} m`;
    return `${round(meters / 1000, 2)} km`;
  }

  // imperial
  const miles = meters * M_TO_MI;
  if (miles < 0.2) return `${round(meters * M_TO_FT, 0)} ft`;
  return `${round(miles, 2)} mi`;
}

/**
 * speedValue: número
 * speedUnit: "mps" | "kmh" | "kt"
 * (Elegí UNA en tu app; si ya lo tenés en km/h, dejá speedUnit="kmh")
 */
export function formatSpeed(
  speedValue: number,
  prefs: UnitPrefs,
  speedUnit: "mps" | "kmh" | "kt" = "kmh"
) {
  if (!Number.isFinite(speedValue)) return "—";

  // normalizamos primero a km/h por comodidad (o a m/s)
  let kmh = speedValue;
  if (speedUnit === "mps") kmh = speedValue * 3.6;
  if (speedUnit === "kt") kmh = speedValue / KMH_TO_KT;

  switch (prefs.system) {
    case "metric":
      return `${round(kmh, 0)} km/h`;
    case "imperial":
      return `${round(kmh * 0.621371, 0)} mph`;
    case "aviation":
      return `${round(kmh * KMH_TO_KT, 0)} kt`;
  }
}

export function formatVerticalSpeed(mps: number, prefs: UnitPrefs) {
  if (!Number.isFinite(mps)) return "—";
  // metric: m/s, aviation: ft/min
  if (prefs.system === "metric") return `${round(mps, 1)} m/s`;
  const fpm = mps * M_TO_FT * 60;
  return `${round(fpm, 0)} ft/min`;
}

export function formatTimeToCPA(seconds: number) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${round(seconds, 0)} s`;
  return `${round(seconds / 60, 1)} min`;
}

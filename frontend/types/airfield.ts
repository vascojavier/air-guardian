// C:\air-guardian\frontend\types\airfield.ts

export type Meteo = {
  windDirection?: number | null;
  windSpeed?: number | null;
  visibility?: number | null;
  cloudCover?: number | null;
  temperature?: number | null;
  pressure?: number | null;
};



// Identificador de cabecera
export type RunwayEndId = 'A' | 'B';

// Beacons de secuenciación (B1 = freeze / final, B2 = pre-secuencia)
export type RunwayBeacon = {
  name: 'B1' | 'B2';
  lat: number;
  lon: number;
};

// ✅ NUEVO: settings ATC (persistidos en el airfield)
export type AtcSettings = {
  FINAL_LOCK_RADIUS_M: number;
  MAX_B2_TO_B1_S: number;
  FINAL_DRIFT_MAX_M: number;

  B1_LATCH_ON_M: number;
  B1_LATCH_OFF_M: number;
  B1_LATCH_OFF_SUSTAIN_MS: number;

  FINAL_TIMEOUT_MS: number;
  GOAROUND_DRIFT_M: number;
  GOAROUND_DRIFT_SUSTAIN_MS: number;
};


export type Runway = {
  id: string;
  identA: string; // "09", "18L", etc.
  identB: string; // "27", "36R", etc.
  thresholdA: { lat: number; lng: number };
  thresholdB: { lat: number; lng: number };
  heading_true_ab: number;  // grados (A → B)
  length_m?: number;
  width_m?: number;
  surface?: string;         // "asphalt" | "grass" | ...
  active_end?: RunwayEndId; // cabecera activa ('A' | 'B')
  beacons?: RunwayBeacon[]; // <<< NUEVO: B1 y B2 para aproximación
  notes?: string;
};

export type Airfield = {
  id: string;
  name?: string;
  icao?: string;
  iata?: string;
  country?: string;
  elevation_ft?: number;
  location?: { lat: number; lng: number };
  runways: Runway[];
  meteo?: Meteo;
  apron?: { lat: number; lng: number };
  lastUpdated: number;
  source: 'manual' | 'ourairports' | 'mixed' | 'openaip';

  // ✅ settings del scheduler/ATC
  atcSettings?: Partial<AtcSettings>;
};


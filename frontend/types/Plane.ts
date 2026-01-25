import type { OpsState } from "./OpsState";

export interface Plane {
  id: string;
  name: string;
  lat: number;
  lon: number;
  alt: number;
  heading: number;
  speed: number;
  type?: string;
  callsign?: string;
  aircraftIcon?: string;  // ✅ <--- AÑADÍ ESTA LÍNEA
    alertLevel?: 'TA' | 'RA_LOW' | 'RA_HIGH' | 'none';
  timeToImpact?: number; // ⏱️ nuevo
  ops?: OpsState | null; // ✅ agregado
  lastSeenTs?: number;
  
}

export type Warning = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  alt: number;
  heading: number;
  speed: number;
  alertLevel: 'RA_HIGH' | 'RA_LOW' | 'TA';
  timeToImpact?: number;
  distanceMeters: number,                   // ⬅️ NUEVO
  aircraftIcon?: string;
  callsign?: string;
  type?: string;
  ops?: string; 
};

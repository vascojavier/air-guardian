// types/OpsState.ts
export type OpsState =
  | 'APRON_STOP' | 'TAXI_APRON' | 'TAXI_TO_RWY' | 'HOLD_SHORT'
  | 'RUNWAY_OCCUPIED' | 'RUNWAY_CLEAR' | 'AIRBORNE'
  | 'LAND_QUEUE' | 'B1' | 'FINAL'
  | `B${number}`
  | `A_TO_B${number}`;


  
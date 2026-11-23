/** Respuesta de GET /api/night-validation (ventanas nocturnas de 5 min frente a Polar). */
export interface NightPairStats {
  n: number;
  r: number | null;
  r2: number | null;
  mae: number | null;
  bias: number | null;
  slope: number | null;
  intercept: number | null;
}

export interface NightMeanPoint {
  session_id: string;
  origin_utc: number | null;
  reference: number | null;
  device: number | null;
}

export interface NightSeries {
  session_id: string;
  origin_utc: number | null;
  time: number[];
  reference: (number | null)[];
  device: (number | null)[];
  windows: number;
}

export interface NightKindSummary extends NightPairStats {
  nights: number;
  windows: number;
  coverage: number | null;
  nightly: NightPairStats & { points: NightMeanPoint[] };
  series: NightSeries[];
}

export interface NightValidationDevice {
  device_id: string;
  name: string;
  reference: string;
  hr: NightKindSummary;
  rmssd: NightKindSummary;
}

export interface NightValidationResponse {
  version: string;
  window_seconds: number;
  reference: string;
  metrics: string[];
  devices: NightValidationDevice[];
}

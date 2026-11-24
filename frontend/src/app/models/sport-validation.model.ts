/** Respuesta de GET /api/sport-validation (FC de entrenamiento frente a Polar H10, segundos agrupados). */
export type SportKey = 'running' | 'gym' | 'cycling';
export type SportViewKey = SportKey | 'combined';

/** Estadísticos de pares (mismo formato que la validación nocturna). */
export interface SportPairStats {
  n: number; r: number | null; r2: number | null; mae: number | null; bias: number | null;
  slope: number | null; intercept: number | null;
}

/** Media de una sesión: un punto por sesión. */
export interface SportSessionPoint {
  session_id: string;
  date: string | null;
  name: string;
  sport: SportKey;
  reference: number;
  device: number;
}

/** Curva de FC de una sesión frente a Polar (medias por tramos, segundos desde el inicio). */
export interface SportSessionSeries {
  session_id: string;
  date: string | null;
  name: string;
  time: number[];
  reference: (number | null)[];
  device: (number | null)[];
}

export interface SportValidationDevice {
  device_id: string;
  name: string;
  sessions: number;
  /** Solo en «combined»: sesiones de cada deporte. */
  sessions_by_sport?: Partial<Record<SportKey, number>>;
  n: number;
  r: number | null;
  r2: number | null;
  mae: number | null;
  bias: number | null;
  slope: number | null;
  intercept: number | null;
  /** Muestra regular de pares [Polar, dispositivo] en bpm (como mucho sample_max). */
  sample: [number, number][];
  /** Un punto por sesión con sus estadísticos (r solo con 3 o más sesiones). */
  session_means?: SportPairStats & { points: SportSessionPoint[] };
  /** Solo por deporte (no en «combined»). */
  series?: SportSessionSeries[];
}

export interface SportValidationResponse {
  version: string;
  reference: string;
  metrics: string[];
  sport_labels: Record<SportViewKey, string>;
  sample_max: number;
  series_max?: number;
  sports: Record<SportViewKey, SportValidationDevice[]>;
}

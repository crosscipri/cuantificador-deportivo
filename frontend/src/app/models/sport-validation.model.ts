/** Respuesta de GET /api/sport-validation (FC de entrenamiento frente a Polar H10, segundos agrupados). */
export type SportKey = 'running' | 'gym' | 'cycling';
export type SportViewKey = SportKey | 'combined';

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
}

export interface SportValidationResponse {
  version: string;
  reference: string;
  metrics: string[];
  sport_labels: Record<SportViewKey, string>;
  sample_max: number;
  sports: Record<SportViewKey, SportValidationDevice[]>;
}

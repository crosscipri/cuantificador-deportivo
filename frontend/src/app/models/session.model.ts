export interface Zone {
  zone: string;
  range: string;
  n: number;
  pct_time: number;
  mae: number | null;
  mape: number | null;
  bias: number | null;
}

export interface Metrics {
  mae: number;
  mape: number;
  rmse: number;
  bias: number;
  loa_u: number;
  loa_l: number;
  ccc: number;
  icc: number;
  r: number;
  p: number;
  slope: number;
  intercept: number;
  n: number;
  media_ref: number;
  media_dev: number;
}

export interface Charts {
  temporal: string;   // base64 PNG
  validation: string; // base64 PNG
}

export interface TrainingTypeSummary {
  name: string;
  count: number;
  last_date: string;
  avg_mae: number | null;
  avg_ccc: number | null;
}

export interface Device {
  id: string;
  name: string;
  reference_name: string;
  description: string;
  created_at: string;
  session_count: number;
  training_types: TrainingTypeSummary[];
}

export type SportType       = 'running' | 'cycling' | 'gym';
export type SessionDifficulty = 'z2' | 'tempo' | 'series';

export const SPORT_TYPE_LABELS: Record<SportType, string> = {
  running: 'Running',
  cycling: 'Ciclismo',
  gym:     'Gym',
};

export const DIFFICULTY_LABELS: Record<SessionDifficulty, string> = {
  z2:     'Z2 — Aeróbico',
  tempo:  'Tempo / Z3',
  series: 'Series / Intervalos',
};

export interface Session {
  id: string;
  device_id: string;
  training_type: string;
  session_name: string;
  device_name: string;
  reference_name: string;
  created_at: string;
  sport_type: SportType;
  session_difficulty: SessionDifficulty;
  metrics: Metrics;
  zones: Zone[];
  lag: number;
  fcmax: number;
  duration_seconds: number;
  charts: Charts;
}

export interface AggregateResult {
  metrics: Metrics;
  zones: Zone[];
  fcmax: number;
  n_sessions: number;
  total_samples: number;
  chart: string; // base64 PNG
}

export type MetricQuality = 'good' | 'warn' | 'orange' | 'bad';

// ─────────────────────────────────────────────────────────────────────────────
// WEIGHTED GLOBAL SCORE
// ─────────────────────────────────────────────────────────────────────────────

export interface WeightedScore {
  mae_global:  number;   // MAE relativo ponderado (%)
  bias_global: number;   // bias ponderado con signo (bpm)
  r_global:    number;   // correlación Fisher-ponderada
  n_sessions:  number;   // sesiones con datos completos
}

const DIFFICULTY_WEIGHTS: Record<SessionDifficulty, number> = {
  z2:     1.0,
  tempo:  1.5,
  series: 2.5,
};

export function computeWeightedScore(sessions: Session[]): WeightedScore | null {
  const valid = sessions.filter(s =>
    s.session_difficulty &&
    s.metrics?.mae  != null &&
    s.metrics?.media_ref != null && s.metrics.media_ref > 0 &&
    s.metrics?.bias != null &&
    s.metrics?.r    != null,
  );
  if (valid.length === 0) return null;

  let W = 0, maeSum = 0, biasSum = 0, zSum = 0;

  for (const s of valid) {
    const w      = DIFFICULTY_WEIGHTS[s.session_difficulty] ?? 1.0;
    const maeRel = s.metrics.mae / s.metrics.media_ref * 100;
    const rClip  = Math.min(Math.max(s.metrics.r, -0.9999), 0.9999);
    const z      = 0.5 * Math.log((1 + rClip) / (1 - rClip));

    W       += w;
    maeSum  += maeRel * w;
    biasSum += s.metrics.bias * w;
    zSum    += z * w;
  }

  const zMean   = zSum / W;
  const rGlobal = (Math.exp(2 * zMean) - 1) / (Math.exp(2 * zMean) + 1);

  return {
    mae_global:  Math.round(maeSum  / W * 100) / 100,
    bias_global: Math.round(biasSum / W * 100) / 100,
    r_global:    Math.round(rGlobal * 10000)   / 10000,
    n_sessions:  valid.length,
  };
}

/** Calidad del score global por deporte basada en r_global */
export function scoreQuality(score: WeightedScore): MetricQuality {
  return metricQuality('r', score.r_global);
}

/**
 * Returns a 4-level CSS class for a metric badge.
 *
 * Special keys beyond keyof Metrics:
 *  - 'bias_abs'     : pass Math.abs(bias)   → |bias| ≤1 / 1–3 / 3–5 / >5
 *  - 'loa_semiancho': pass max(|loa_l|, |loa_u|) → ±≤6 / 6–10 / 10–15 / >15
 */
export function metricQuality(
  metric: keyof Metrics | 'bias_abs' | 'loa_semiancho',
  value: number
): MetricQuality {
  type Threshold = { g: number; w: number; o: number; higher?: boolean };
  const T: Record<string, Threshold> = {
    // FC PPG vs banda — error absoluto
    mae:          { g: 3,    w: 5,    o: 10   },
    // |bias| Bland–Altman
    bias_abs:     { g: 1,    w: 3,    o: 5    },
    // LoA semiancho = max(|loa_l|, |loa_u|)
    loa_semiancho:{ g: 6,    w: 10,   o: 15   },
    // Correlación Pearson
    r:            { g: 0.95, w: 0.90, o: 0.80, higher: true },
    // Métricas secundarias (umbrales previos mantenidos)
    mape: { g: 5,    w: 10,   o: 20   },
    ccc:  { g: 0.95, w: 0.90, o: 0.80, higher: true },
    icc:  { g: 0.90, w: 0.70, o: 0.50, higher: true },
  };
  const t = T[metric];
  if (!t) return 'good';
  if (t.higher) {
    return value >= t.g ? 'good' : value >= t.w ? 'warn' : value >= t.o ? 'orange' : 'bad';
  }
  return value <= t.g ? 'good' : value <= t.w ? 'warn' : value <= t.o ? 'orange' : 'bad';
}

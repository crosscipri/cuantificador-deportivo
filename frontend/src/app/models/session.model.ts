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

export interface FcData {
  reference: number[];
  device:    number[];
  time:      number[];  // seconds from session start
  step:      number;    // downsampling step applied by backend
}

export interface SparkData {
  device:    number[];
  reference: number[];
}

export interface BalancedBySession {
  pearson_fisher:             number | null;
  valid_correlation_sessions: number;
  mae:                        number | null;
  mae_between_session_sd:     number | null;
  mae_min:                    number | null;
  mae_max:                    number | null;
  mape:                       number | null;
  rmse:                       number | null;
  bias:                       number | null;
  ccc:                        number | null;
  icc:                        number | null;
  lag_mean_seconds:           number | null;
  within_3_bpm:               number | null;
  within_5_bpm:               number | null;
  within_10_bpm:              number | null;
}

export interface OverviewEntry {
  // Flat aliases (backward compat — derived from balanced_by_session)
  name:           string;
  reference_name: string;
  r_global:       number;
  ccc_global:     number;
  lag_mean:       number;
  mae_global:     number;
  bias_global:    number;
  session_count:  number;
  total_weight:   number;
  // New nested structure
  device_id:              string;
  device_name:            string;
  sport_type:             string;
  total_samples:          number;
  balanced_by_session:    BalancedBySession;
  weighted_by_samples:    Record<string, number> | null;
  difficulty_weighted_score: Record<string, number | string> | null;
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
  last_spark?: SparkData;
  // AI verdict metadata (lightweight)
  has_ai_verdict?:   boolean;
  ai_verdict_at?:    string;
  ai_verdict_model?: string;
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

/** Default difficulty assigned automatically to gym sessions (no selector shown). */
export const GYM_DIFFICULTY: SessionDifficulty = 'z2';

/** Sports that require the user to pick a difficulty. Gym uses GYM_DIFFICULTY by default. */
export const SPORT_HAS_DIFFICULTY: Record<SportType, boolean> = {
  running: true,
  cycling: true,
  gym:     false,
};

export const TRAINING_TYPES_BY_SPORT: Record<SportType, string[]> = {
  running: [
    'Regenerativo',
    'Rodaje suave',
    'Fondo largo',
    'Progresivo',
    'Tempo / Umbral',
    'Fartlek',
    'Series cortas',
    'Series largas',
    'Cross / Trail',
  ],
  cycling: [
    'Rodaje suave',
    'Fondo largo',
    'Sweet spot',
    'Tempo / Umbral',
    'Subida',
    'Intervalos VO2max',
    'Sprints / Potencia',
  ],
  gym: [
    'Cardio máquina',
    'HIIT',
    'Circuito funcional',
    'Fuerza + cardio',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// AI ANALYSIS TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type AiCalificacion = 'excelente' | 'bueno' | 'moderado' | 'deficiente';

export interface AiAnnotation {
  tiempo_inicio:    number;
  tiempo_fin:       number;
  tipo:             'lag' | 'overshooting' | 'cadence_lock' | 'alta_discrepancia' | 'recuperacion_lenta';
  num_serie?:       number;
  descripcion:      string;
  severidad:        'leve' | 'moderada' | 'severa';
  causa?:           string;
  frase_para_video?: string;
}

export interface AiBlandAltman {
  descripcion_visual:   string;
  interpretacion_canal: string;
  sesgo_proporcional:   string;
}

export interface AiZoneData {
  mae:              number | null;
  valoracion:       string;
  explicacion_canal: string;
}

export interface AiLagAnalisis {
  lag_estimado_segundos: number | null;
  es_problematico:       boolean;
  explicacion_canal:     string;
}

export interface AiSeriesTemporales {
  descripcion_visual:       string;
  fenomenos_identificados:  string;
  interpretacion_canal:     string;
}

export interface AiScatterPlot {
  descripcion_visual: string;
  patron_error:       string;
}

export interface AiReport {
  resumen_ejecutivo:      string;
  validez_general:        string;
  bland_altman:           any;
  error_por_zonas:        any;
  lag_analisis:           any;
  diagnostico_causas?:    string;
  fenomenos_detectados?:  string;
  series_temporales?:     AiSeriesTemporales;
  scatter_plot?:          AiScatterPlot;
  recomendacion_practica: string;
}

export interface AiAnalysis {
  report: {
    informe:                 AiReport;
    anotaciones_temporales:  AiAnnotation[];
    veredicto_sesion: {
      calificacion:        AiCalificacion;
      etiqueta:            string;
      para_quien:          string;
      NO_recomendado_para?: string;
    };
  };
  annotated_charts: {
    temporal:    string;
    validation?: string;
  };
  generated_at: string;
  model:        string;
}

export interface AiVerdictData {
  veredicto_general:       string;
  calificacion_final:      AiCalificacion;
  etiqueta_final:          string;
  fortalezas:              string[];
  debilidades:             string[];
  por_tipo_entrenamiento:  Record<string, string>;
  perfil_deportista_ideal: string;
  no_recomendado_para:     string;
  comparativa_literatura:  string;
  recomendacion_final:     string;
}

export interface AiVerdict {
  verdict:           AiVerdictData;
  generated_at:      string;
  model:             string;
  sessions_analyzed: number;
}

export interface Session {
  id: string;
  device_id: string;
  training_type: string;
  session_name: string;
  device_name: string;
  reference_name: string;
  created_at: string;
  activity_date?: string;
  sport_type: SportType;
  session_difficulty: SessionDifficulty;
  metrics: Metrics;
  zones: Zone[];
  lag: number;
  fcmax: number;
  duration_seconds: number;
  /** Original-source bounds used when this session was permanently cropped. */
  interval_start_sec?: number;
  interval_end_sec?: number;
  source_duration_seconds?: number;
  interval_updated_at?: string;
  charts: Charts;
  fc_data?: FcData;    // only present in GET /api/sessions/:id
  spark_data?: SparkData; // 20-point sparkline, present in list responses
  // AI analysis metadata (lightweight — full payload via /ai-analysis endpoint)
  has_ai_analysis?:   boolean;
  ai_analysis_at?:    string;
  ai_analysis_model?: string;
}

export interface IntervalAnalysis {
  metrics: Metrics;
  zones: Zone[];
  lag: number;
  fcmax: number;
  duration_seconds: number;
  source_duration_seconds: number;
  fc_data: FcData;
}

export interface AggregateResult {
  metrics: Metrics;
  zones: Zone[];
  fcmax: number;
  n_sessions: number;
  total_samples: number;
  chart: string; // base64 PNG
}

export interface SportSessionPoints {
  label:  string;
  points: { x: number; y: number }[];
  bias:   number | null;
  mae:    number | null;
}

export interface SportGlobalStats {
  bias:      number | null;
  loa_u:     number | null;
  loa_l:     number | null;
  pearson_r: number | null;
  slope:     number | null;
  intercept: number | null;
}

export interface SportAggregateCharts {
  device_name:         string;
  reference_name:      string;
  sport_type:          string;
  session_count:       number;
  sessions_with_data:  number;
  sessions:            SportSessionPoints[];
  global_stats:        SportGlobalStats | null;
  balanced_by_session: BalancedBySession | null;
  per_session:         any[];
}

export type MetricQuality = 'good' | 'warn' | 'orange' | 'bad';

// ─────────────────────────────────────────────────────────────────────────────
// WEIGHTED GLOBAL SCORE
// ─────────────────────────────────────────────────────────────────────────────

export interface WeightedScore {
  mae_global:  number;   // MAE relativo ponderado (%)
  bias_global: number;   // bias ponderado con signo (bpm)
  r_global:    number;   // correlación Fisher-ponderada
  ccc_global:  number;   // CCC de Lin ponderado (media directa)
  lag_mean:    number;   // lag medio ponderado (segundos)
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

  let W = 0, maeSum = 0, biasSum = 0, zSum = 0, cccSum = 0, lagSum = 0;

  for (const s of valid) {
    const w      = DIFFICULTY_WEIGHTS[s.session_difficulty] ?? 1.0;
    const maeRel = s.metrics.mae / s.metrics.media_ref * 100;
    const rClip  = Math.min(Math.max(s.metrics.r, -0.9999), 0.9999);
    const z      = 0.5 * Math.log((1 + rClip) / (1 - rClip));

    W       += w;
    maeSum  += maeRel * w;
    biasSum += s.metrics.bias * w;
    zSum    += z * w;
    cccSum  += (s.metrics.ccc ?? 0) * w;
    lagSum  += (s.lag ?? 0) * w;
  }

  const zMean   = zSum / W;
  const rGlobal = (Math.exp(2 * zMean) - 1) / (Math.exp(2 * zMean) + 1);

  return {
    mae_global:  Math.round(maeSum  / W * 100) / 100,
    bias_global: Math.round(biasSum / W * 100) / 100,
    r_global:    Math.round(rGlobal * 10000)   / 10000,
    ccc_global:  Math.round(cccSum  / W * 10000) / 10000,
    lag_mean:    Math.round(lagSum  / W * 10)    / 10,
    n_sessions:  valid.length,
  };
}

/** Calidad del score global por deporte basada en ccc_global */
export function scoreQuality(score: WeightedScore): MetricQuality {
  return metricQuality('ccc', score.ccc_global);
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

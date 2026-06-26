export interface NocturnalHrvSummary {
  id: string;
  device_id: string;
  session_name: string;
  created_at: string;
  polar_rr_filename?: string;
  polar_hr_filename?: string;
  fitbit_hrv_filename?: string;
  fitbit_hr_filename?: string;
  summary?: {
    polarRmssdMean: number | null;
    polarRmssdSd: number | null;
    fitbitRmssdMean: number | null;
    fitbitRmssdSd: number | null;
    biasMean: number | null;
    biasPct: number | null;
    pearsonR: number | null;
    rmssdMAE: number | null;
    polarHRMean: number | null;
    polarHRMin: number | null;
    fitbitHRMean: number | null;
    fitbitHRMin: number | null;
    hrMAE: number | null;
    blandSd: number | null;
    upperLoa: number | null;
    lowerLoa: number | null;
  };
  settings?: {
    artifact_threshold_pct: number;
    min_beats_per_window: number;
  };
}

export interface AggregatedHrvStats {
  n: number;
  polarMean: number;
  fitbitMean: number;
  bias: number;
  sd: number;
  upperLoa: number;
  lowerLoa: number;
  mae: number;
  pearsonR: number | null;
  slope: number | null;
  intercept: number | null;
}

export interface AggregatedHrvSession {
  session_id: string;
  session_name: string;
  points: { x: number; y: number }[];
}

export interface NocturnalHrvAggregated {
  n_sessions: number;
  rmssd: { stats: AggregatedHrvStats | null; by_session: AggregatedHrvSession[] };
  hr:    { stats: AggregatedHrvStats | null; by_session: AggregatedHrvSession[] };
}

export interface NocturnalHrvGlobalAiReport {
  resumen_ejecutivo: string;
  calificacion_hrv: 'excelente' | 'bueno' | 'moderado' | 'deficiente';
  calificacion_fc:  'excelente' | 'bueno' | 'moderado' | 'deficiente';
  analisis_rmssd_global: {
    correlacion: string;
    error_absoluto: string;
    sesgo_sistematico: string;
    limites_acuerdo_global: string;
  };
  analisis_fc_global: {
    error_absoluto: string;
    correlacion: string;
  };
  consistencia_entre_sesiones: string;
  causas_tecnicas: string;
  utilidad_practica: {
    tracking_tendencias: string;
    recovery_score: string;
    deteccion_sobreentrenamiento: string;
  };
  comparacion_literatura: string;
  veredicto_final: {
    calificacion: 'excelente' | 'bueno' | 'moderado' | 'deficiente';
    etiqueta: string;
    recomendacion: string;
  };
}

export interface NocturnalHrvGlobalAiAnalysis {
  report: NocturnalHrvGlobalAiReport;
  generated_at: string;
  model: string;
  n_sessions: number;
}

export interface NocturnalHrvAiReport {
  resumen_ejecutivo: string;
  calificacion_hrv: 'excelente' | 'bueno' | 'moderado' | 'deficiente';
  calificacion_fc: 'excelente' | 'bueno' | 'moderado' | 'deficiente';
  analisis_rmssd: {
    correlacion: string;
    error_absoluto: string;
    sesgo_sistematico: string;
    limites_acuerdo: string;
    descripcion_visual_bland_altman: string;
  };
  analisis_fc: {
    error_absoluto: string;
    correlacion: string;
    relevancia_clinica: string;
  };
  variacion_nocturna: string;
  causas_tecnicas: string;
  utilidad_practica: {
    tracking_tendencias: string;
    recovery_score: string;
    deteccion_estres: string;
  };
  comparacion_literatura: string;
  veredicto_final: {
    calificacion: 'excelente' | 'bueno' | 'moderado' | 'deficiente';
    etiqueta: string;
    recomendacion: string;
  };
}

export interface NocturnalHrvAiAnalysis {
  report: NocturnalHrvAiReport;
  generated_at: string;
  model: string;
}

export interface HrvOverviewEntry {
  device_id:  string;
  name:       string;
  hrv_score:  number | null;  // pearsonR_rmssd × 100  (0–100)
  hr_score:   number | null;  // pearsonR_hr    × 100  (0–100)
  n_sessions: number;
}

export interface NocturnalHrvDetail extends NocturnalHrvSummary {
  windows: Array<{
    tStart: string;
    label: string;
    tsMs: number;
    rmssdPolar: number | null;
    rmssdFitbit: number | null;
    hrPolar: number | null;
    hrFitbit: number | null;
    sdnnPolar: number | null;
    pnn50Polar: number | null;
    breathingPolar: number | null;
    beatsInWindow: number;
  }>;
}

export type ComparisonMode = 'DIRECT' | 'BENCHMARK';
export type ComparisonChartType = 'hr' | 'error' | 'gps' | 'metric' | 'scatter' | 'bland_altman' | 'ecdf';
export interface WorkspaceChart {id:string;comparison_id:string;name:string;mode:ComparisonMode;chart_type:ComparisonChartType;}
export interface ComparisonWorkspace {id:string;name:string;charts:WorkspaceChart[];created_at:string;}
export interface ComparisonVisualization {
  chart_type?: ComparisonChartType;
  hidden: string[]; tab: 'hr' | 'gps'; error_band: 0 | 3 | 5 | 10; benchmark_metric: string;
  layout?: 'OVERLAY' | 'SMALL_MULTIPLES'; diagnostic?: 'scatter' | 'bland_altman' | 'ecdf';
  error_view?:'SIGNED'|'ABSOLUTE';
}
export interface ComparisonInterval {name:string;start_sec:number;end_sec:number;reason?:string;}
export interface ComparisonDiagnostic {session_id:string;n:number;display_n:number;scatter:{x:number;y:number}[];bland_altman:{x:number;y:number}[];ecdf:{x:number;y:number}[];}
export interface ComparisonSelection {
  name: string;
  mode: ComparisonMode;
  session_ids: string[];
  reference_session_id: string | null;
  gps_reference_session_id: string | null;
  gps_enabled?:boolean;
  assume_same_workout: boolean;
  offsets: Record<string, number>;
  interpolation: 'NONE' | 'LINEAR';
  source_resolution?:'EPOCH_SECOND_MEAN'|'NATIVE';sampling_hz?:1|2|5|10;
  max_interpolation_gap: number;
  start_sec: number | null;
  end_sec: number | null;
  protocol_id: string | null;
  protocol_version: number | null;
  benchmark_method: 'LEGACY' | 'CURRENT';
  visualization?: ComparisonVisualization;
  exclusions: ComparisonInterval[];
  intervals: ComparisonInterval[];
  advanced: {enabled:boolean;gps_geometry?:boolean;lag_max_seconds:number;intensity_bounds:number[];transient_min_change_bpm?:number;transient_dwell_seconds?:number};
  aggregation:'SESSION'|'DURATION'|'VALID_PAIRS'|'MANUAL';
  manual_weights:Record<string,number>;
  uncertainty:{enabled:boolean;repetitions:number;seed:number;confidence:number};
  storage_mode:'SNAPSHOT'|'LIVE';selection_policy:'EXPLICIT'|'ALL_COMPATIBLE';
  filters:{device_ids:string[];sport_type:string|null;session_difficulty:string|null;date_from:string|null;date_to:string|null;firmware:string|null;participant_id:string|null};
}
export interface ComparisonSession {
  id: string; device_id: string; device_name: string; reference_name: string;
  session_name: string; activity_date?: string; sport_type?: string;
  session_difficulty?: string; training_type?: string; duration_seconds?: number;
  experiment_id?: string; protocol_id?: string; protocol_version?: number;
  firmware?:string;participant_id?:string;
}
export interface StatisticDefinition { id: string; name: string; description: string; unit: string; }
export interface SessionEvidence {
  session_id: string; device_id: string; device_name: string; session_name: string;
  reference_name: string; source_url: string; processing_version: string;
  analysis_revision_id: string; metrics: Record<string, number | null>;
  original_duration_seconds?: number; outside_selected_window_seconds?: number;
  unmasked_metrics?:Record<string,number|null>;
  intervals?:{name:string;start_sec:number;end_sec:number;metrics:Record<string,number|null>}[];
  intensities?:{lower_bpm:number|null;upper_bpm:number|null;metrics:Record<string,number|null>}[];
  lag_diagnostic?:{lag_seconds:number|null;r_zero:number|null;r_max:number|null;n:number;reason?:string|null;boundary_peak?:boolean};
  transients?:{name:string;delay_50_seconds:number|null;delay_90_seconds:number|null;overshoot_bpm:number|null;end_undershoot_bpm:number|null;reason:string|null}[];
  trends?:{state:string;metrics:Record<string,number|null>}[];
}
export interface AggregateStatistic {
  n: number; mean: number | null; median: number | null; sd: number | null;
  q1: number | null; q3: number | null; iqr: number | null; min: number | null; max: number | null;
  estimate?:number|null;weighted_n?:number;weight_sum?:number;weight_missing_or_zero_n?:number;
  ci?:{lower:number|null;upper:number|null;clusters:number;unit:string;reason?:string|null}|null;
}
export interface ComparisonSeries {
  id: string; device_id?: string; name: string; role: 'reference' | 'device';
  values: (number | null)[]; errors?: (number | null)[];
}
export interface GpsPoint { t: number | null; lat: number; lon: number;geometry_distance_m?:number; }
export interface ComparisonGpsTrack {
  id: string; device_id?: string | null; name: string; role: string; segments: GpsPoint[][];
}
export interface ComparisonResult {
  mode: ComparisonMode; configuration: ComparisonSelection; processing_version: string;
  compatibility: string; reference_status?: string; warnings: string[];
  rows: SessionEvidence[]; time?: number[]; series?: ComparisonSeries[];
  window?: { start_utc: number; end_utc: number; full_start_utc: number; duration_seconds: number; analytical_points: number; display_points: number;sampling_comparison_hz:number; };
  groups?: { device_id: string; device_name: string; session_count: number; metrics: Record<string, AggregateStatistic>; }[];
  gps?: { tracks: ComparisonGpsTrack[]; reference_available: boolean; rows: Record<string, any>[];time?:number[]; };
  diagnostics?:ComparisonDiagnostic[];
  heatmap?:{category:string;protocol_version:number|null;device_id:string;session_ids:string[];metrics:Record<string,AggregateStatistic>}[];
}
export interface SavedComparison { id: string; configuration: ComparisonSelection; created_at: string; }
export interface Experiment {
  id: string; name: string; session_ids: string[]; reference_session_id: string;
  gps_reference_session_id?: string; protocol_id?: string; protocol_version?: number;
  references?:Record<string,{quality:string|null}>;
}
export const DEVICE_COLORS = ['#2563eb', '#d97706', '#9333ea', '#059669', '#e11d48', '#0891b2', '#78350f', '#4338ca'];
export function deviceColor(id: string): string {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return DEVICE_COLORS[hash % DEVICE_COLORS.length];
}

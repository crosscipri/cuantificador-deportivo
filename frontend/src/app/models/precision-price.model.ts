export interface PrecisionPriceFormula {
  version: string;
  weights: { mae: number; r: number };
  r0: number;
  mae_max: { sport_hr_bpm: number; rest_hr_bpm: number; rmssd_ms: number };
  night_weights: { rest_hr: number; hrv: number };
  description: string;
}

export interface PrecisionPriceDevice {
  device_id: string;
  name: string;
  score: number;
  price: number;
  shop: string | null;
  label: string | null;
  checked_at: string | null;
  source: string | null;
  value_index: number | null;
  frontier: boolean;
  few: boolean;
  sessions?: number | null;
  n?: number | null;
  mae?: number | null;
  r?: number | null;
  nights?: number | null;
  hr_mae?: number | null;
  hr_r?: number | null;
  hr_score?: number | null;
  rmssd_mae?: number | null;
  rmssd_r?: number | null;
  rmssd_score?: number | null;
  sport_score?: number | null;
  sport_mae?: number | null;
  sport_r?: number | null;
  sport_sessions?: number | null;
  night_score?: number | null;
  night_nights?: number | null;
  price_match?: string | null;
}

export interface PrecisionPriceMissing {
  device_id: string;
  name: string;
}

export interface PrecisionPriceLeftOut {
  device_id: string;
  name: string;
  reasons: string[];
}

export interface PrecisionPriceNeedsPrice {
  device_id: string;
  name: string;
  has_data: boolean;
}

export interface PrecisionPriceDiagnostics {
  devices_in_db: number;
  duplicate_names: string[][];
  sessions_unlinked?: number;
  sessions_without_valid_sport?: Record<string, number>;
}

export interface PrecisionPriceResponse {
  version: string;
  formula: PrecisionPriceFormula;
  few_threshold: number;
  price_rule: string | null;
  price_checked_at: string | null;
  price_source: { file?: string; note?: string } | null;
  reference: { sport: string; night: string };
  sports: PrecisionPriceDevice[];
  night: PrecisionPriceDevice[];
  final: PrecisionPriceDevice[];
  missing_price: PrecisionPriceMissing[];
  missing_night: PrecisionPriceMissing[];
  missing_sport: PrecisionPriceMissing[];
  /** Quién queda fuera de cada gráfica y por qué (una versión antigua del backend no lo envía). */
  left_out?: Record<PrecisionPriceView, PrecisionPriceLeftOut[]>;
  needs_price?: PrecisionPriceNeedsPrice[];
  diagnostics?: PrecisionPriceDiagnostics;
}

export type PrecisionPriceView = 'sports' | 'night' | 'final';

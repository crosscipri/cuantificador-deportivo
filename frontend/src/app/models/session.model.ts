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

export interface Session {
  id: string;
  training_type: string;
  session_name: string;
  device_name: string;
  reference_name: string;
  created_at: string;
  metrics: Metrics;
  zones: Zone[];
  lag: number;
  fcmax: number;
  duration_seconds: number;
  charts: Charts;
}

export interface TrainingType {
  name: string;
  count: number;
}

export interface AggregateResult {
  metrics: Metrics;
  zones: Zone[];
  fcmax: number;
  n_sessions: number;
  total_samples: number;
  chart: string; // base64 PNG
}

/** Helper: returns 'good' | 'warn' | 'bad' CSS class for a metric badge */
export function metricQuality(
  metric: keyof Metrics,
  value: number
): 'good' | 'warn' | 'bad' {
  const thresholds: Partial<Record<keyof Metrics, { good: number; bad: number; higher?: boolean }>> = {
    mae:  { good: 3,   bad: 5   },
    mape: { good: 5,   bad: 10  },
    ccc:  { good: 0.95, bad: 0.9, higher: true },
    icc:  { good: 0.9,  bad: 0.7, higher: true },
    r:    { good: 0.95, bad: 0.9, higher: true },
  };
  const t = thresholds[metric];
  if (!t) return 'good';
  if (t.higher) {
    return value >= t.good ? 'good' : value >= t.bad ? 'warn' : 'bad';
  }
  return value <= t.good ? 'good' : value <= t.bad ? 'warn' : 'bad';
}

/** Point-level stats and es-ES formatting for the total-correlation panel. */

export interface TotalCorrPoint { x: number; y: number; }

export interface TotalCorrStats {
  r: number | null;
  mae: number | null;
  rmse: number | null;
  bias: number | null;
  loaL: number | null;
  loaU: number | null;
  slope: number | null;
  intercept: number | null;
  n: number;
}

export interface TotalCorrRow {
  id: string;
  name: string;
  error?: string;
  points: TotalCorrPoint[];
  stats?: Partial<TotalCorrStats>;
}

export interface SportCorrSport {
  id: string;
  label: string;
  r: number | null;
  sessionRs: number[];
  perc?: number | null;
}

export interface SportCorrDevice {
  id: string;
  name: string;
  sports: SportCorrSport[];
}

const FINITE = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A stored r of exactly 0 with a high CCC is the old calculate_metrics fallback
 * (pearsonr raised on a NaN and was saved as 0.0). Do not plot or use it for Perc.
 */
export function usableCorrelation(r: number | null | undefined, ccc?: number | null): r is number {
  if (!FINITE(r)) return false;
  if (r === 0 && FINITE(ccc) && Math.abs(ccc) >= 0.5) return false;
  return true;
}

export function percentAtLeast(values: number[], threshold = 0.95): number | null {
  if (!values.length) return null;
  return 100 * values.filter((value) => value >= threshold).length / values.length;
}

export function boxPlotStats(values: number[]): {q1: number; median: number; q3: number; whiskerLow: number; whiskerHigh: number} | null {
  if (!values.length) return null;
  const xs = [...values].sort((a, b) => a - b);
  const quantile = (p: number) => {
    const idx = (xs.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
  };
  const q1 = quantile(0.25);
  const median = quantile(0.5);
  const q3 = quantile(0.75);
  const iqr = q3 - q1;
  const lowFence = q1 - 1.5 * iqr;
  const highFence = q3 + 1.5 * iqr;
  const inside = xs.filter((v) => v >= lowFence && v <= highFence);
  return {
    q1, median, q3,
    whiskerLow: inside.length ? inside[0] : xs[0],
    whiskerHigh: inside.length ? inside[inside.length - 1] : xs[xs.length - 1],
  };
}

export function statsFromPoints(points: TotalCorrPoint[]): TotalCorrStats {
  const valid = (points || []).filter((p) => FINITE(p?.x) && FINITE(p?.y));
  const n = valid.length;
  const empty: TotalCorrStats = {
    r: null, mae: null, rmse: null, bias: null, loaL: null, loaU: null, slope: null, intercept: null, n,
  };
  if (n < 2) return empty;
  const diffs = valid.map((p) => p.y - p.x);
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const bias = mean(diffs);
  const mae = mean(diffs.map((d) => Math.abs(d)));
  const rmse = Math.sqrt(mean(diffs.map((d) => d * d)));
  const variance = diffs.reduce((s, d) => s + (d - bias) * (d - bias), 0) / (n - 1);
  const sd = Math.sqrt(Math.max(0, variance));
  const xs = valid.map((p) => p.x);
  const ys = valid.map((p) => p.y);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; denX += dx * dx; denY += dy * dy;
  }
  const r = denX > 0 && denY > 0 ? num / Math.sqrt(denX * denY) : null;
  const slope = denX > 0 ? num / denX : null;
  const intercept = slope != null ? my - slope * mx : null;
  return {
    r, mae, rmse, bias,
    loaL: bias - 1.96 * sd,
    loaU: bias + 1.96 * sd,
    slope, intercept, n,
  };
}

export function mergeStats(points: TotalCorrPoint[], provided?: Partial<TotalCorrStats> | null): TotalCorrStats {
  const computed = statsFromPoints(points);
  if (!provided) return computed;
  const pick = (key: keyof TotalCorrStats): number | null => {
    const value = provided[key];
    return FINITE(value) ? value : computed[key];
  };
  return {
    r: pick('r'),
    mae: pick('mae'),
    rmse: pick('rmse'),
    bias: pick('bias'),
    loaL: pick('loaL'),
    loaU: pick('loaU'),
    slope: pick('slope'),
    intercept: pick('intercept'),
    n: computed.n,
  };
}

export function formatEs(value: number | null | undefined, digits: number): string {
  if (!FINITE(value)) return 'Sin datos';
  return value.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

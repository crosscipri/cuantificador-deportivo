/** Pure helpers for the nocturnal Comparativa RMSSD. No Angular imports. */

export const FIVE_MIN_MS = 5 * 60 * 1000;
export const MIN_RR_MS = 300;
export const MAX_RR_MS = 2000;
export const MEDIAN_HALF = 5; // centered window of 11 beats
export const ARTIFACT_FRACTION = 0.2;
export const CLEAN_PASSES = 2;
export const MIN_BEATS_PER_WINDOW = 100;
export const LOW_QUALITY_PCT = 5;
export const MAX_LAG_MS = 3 * 60 * 60 * 1000;
export const LAG_IMPROVEMENT = 0.15;
export const PAIR_TOLERANCE_MS = 2.5 * 60 * 1000;

export type TimeZoneMode = 'utc' | 'local' | 'other';

export interface TimeZoneSetting {
  mode: TimeZoneMode;
  /** IANA name (Europe/Madrid) or offset (+01:00, -5, UTC+1) when mode is 'other'. */
  other?: string;
}

export interface TimedValue {
  t: number;
  v: number;
}

export interface RrBeat {
  t: number;
  rr: number;
}

export function mean(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

export function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return NaN;
  const ma = mean(a);
  const mb = mean(b);
  const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / n;
  const sa = Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0) / n);
  const sb = Math.sqrt(b.reduce((s, v) => s + (v - mb) ** 2, 0) / n);
  return sa * sb > 0 ? cov / (sa * sb) : NaN;
}

export function mae(pairs: Array<[number, number]>): number {
  if (!pairs.length) return NaN;
  return mean(pairs.map(([a, b]) => Math.abs(b - a)));
}

export function rmssdOf(rr: number[]): number {
  if (rr.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < rr.length; i++) sum += (rr[i] - rr[i - 1]) ** 2;
  return Math.sqrt(sum / (rr.length - 1));
}

export function parseOffsetMs(raw: string): number | null {
  const t = raw.trim();
  const m = t.match(/^(?:UTC|GMT)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number(m[2]);
  const minutes = Number(m[3] || '0');
  if (hours > 14 || minutes > 59) return null;
  return sign * (hours * 3600 + minutes * 60) * 1000;
}

export function isValidIanaTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` at `utcMs`: zoned_wall_as_utc - utcMs. */
export function offsetMsAt(utcMs: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
  );
  return asUtc - utcMs;
}

export function naiveWallToUtcMs(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number, ms: number,
  tz: TimeZoneSetting,
): number {
  if (tz.mode === 'utc') {
    return Date.UTC(year, month - 1, day, hour, minute, second, ms);
  }
  if (tz.mode === 'local') {
    return new Date(year, month - 1, day, hour, minute, second, ms).getTime();
  }
  const other = (tz.other ?? '').trim();
  const offset = parseOffsetMs(other);
  if (offset != null) {
    return Date.UTC(year, month - 1, day, hour, minute, second, ms) - offset;
  }
  if (!other || !isValidIanaTimeZone(other)) {
    return NaN;
  }
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const off1 = offsetMsAt(guess, other);
  const instant = guess - off1;
  const off2 = offsetMsAt(instant, other);
  return guess - off2;
}

const ISO_NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;
const ISO_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse a timestamp to a UTC epoch Date.
 * - Unix epoch (seconds or milliseconds) is always UTC, regardless of `tz`.
 * - ISO with Z or an explicit offset is respected.
 * - ISO without offset uses `tz` (default UTC).
 * - Excel/Garmin serial wall times also use `tz`.
 */
export function parseTimestamp(raw: string, tz: TimeZoneSetting = { mode: 'utc' }): Date {
  const s = (raw ?? '').trim();
  if (!s) return new Date(NaN);

  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!isFinite(n)) return new Date(NaN);
    // Garmin/Excel serial: days since 1899-12-30, fraction = time of day.
    if (n >= 20_000 && n < 100_000) {
      const serial = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000);
      const utcMs = naiveWallToUtcMs(
        serial.getUTCFullYear(), serial.getUTCMonth() + 1, serial.getUTCDate(),
        serial.getUTCHours(), serial.getUTCMinutes(), serial.getUTCSeconds(),
        serial.getUTCMilliseconds(),
        tz,
      );
      return new Date(utcMs);
    }
    return new Date(n < 1e12 ? n * 1000 : n);
  }

  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s)
    ? s.replace(/\s+/, 'T')
    : s;

  const withOffset = ISO_OFFSET.exec(normalized);
  if (withOffset) {
    const iso = normalized.includes('T') ? normalized : normalized.replace(' ', 'T');
    return new Date(iso);
  }

  const naive = ISO_NAIVE.exec(normalized);
  if (naive) {
    const year = Number(naive[1]);
    const month = Number(naive[2]);
    const day = Number(naive[3]);
    const hour = Number(naive[4]);
    const minute = Number(naive[5]);
    const second = Number(naive[6] || '0');
    const frac = naive[7] || '0';
    const ms = Number(frac.padEnd(3, '0').slice(0, 3));
    return new Date(naiveWallToUtcMs(year, month, day, hour, minute, second, ms, tz));
  }

  const fallback = new Date(normalized);
  return fallback;
}

export interface CleanRrResult {
  beats: RrBeat[];
  discarded: number;
  corrected: number;
  correctedPct: number;
}

/**
 * Drop intervals outside 300–2000 ms, then run two passes of a centered
 * 11-beat rolling-median filter. Flagged beats are replaced by that median;
 * timestamps and beat count of the remaining series are kept.
 */
export function cleanRrIntervals(
  beats: RrBeat[],
  artifactFraction = ARTIFACT_FRACTION,
  passes = CLEAN_PASSES,
): CleanRrResult {
  const sorted = [...beats].filter(b => isFinite(b.t) && isFinite(b.rr)).sort((a, b) => a.t - b.t);
  const kept: RrBeat[] = [];
  let discarded = 0;
  for (const b of sorted) {
    if (b.rr < MIN_RR_MS || b.rr > MAX_RR_MS) {
      discarded++;
      continue;
    }
    kept.push({ t: b.t, rr: b.rr });
  }
  const flagged = new Array(kept.length).fill(false);
  let values = kept.map(b => b.rr);
  for (let pass = 0; pass < passes; pass++) {
    const next = values.slice();
    for (let i = 0; i < values.length; i++) {
      const lo = Math.max(0, i - MEDIAN_HALF);
      const hi = Math.min(values.length - 1, i + MEDIAN_HALF);
      const med = median(values.slice(lo, hi + 1));
      if (med > 0 && Math.abs(values[i] - med) > artifactFraction * med) {
        next[i] = med;
        flagged[i] = true;
      }
    }
    values = next;
  }
  const corrected = flagged.filter(Boolean).length;
  const out = kept.map((b, i) => ({ t: b.t, rr: values[i] }));
  return {
    beats: out,
    discarded,
    corrected,
    correctedPct: out.length ? (corrected / out.length) * 100 : 0,
  };
}

export interface RmssdWindow {
  t: number;
  rmssd: number;
  beats: number;
}

/** 5-minute windows on a UTC grid aligned to whole 5-minute marks. */
export function windowedRmssd(
  beats: RrBeat[],
  minBeats = MIN_BEATS_PER_WINDOW,
  range?: { start: number; end: number },
): RmssdWindow[] {
  if (!beats.length) return [];
  const times = beats.map(b => b.t);
  let start = range?.start ?? Math.min(...times);
  let end = range?.end ?? Math.max(...times);
  start = Math.floor(start / FIVE_MIN_MS) * FIVE_MIN_MS;
  end = Math.ceil(end / FIVE_MIN_MS) * FIVE_MIN_MS;
  if (end <= start) return [];
  const windows: RmssdWindow[] = [];
  for (let t = start; t < end; t += FIVE_MIN_MS) {
    const tEnd = t + FIVE_MIN_MS;
    const inWin = beats.filter(b => b.t >= t && b.t < tEnd);
    if (inWin.length < minBeats) continue;
    windows.push({ t, rmssd: rmssdOf(inWin.map(b => b.rr)), beats: inWin.length });
  }
  return windows;
}

export interface PairedPoint {
  t: number;
  ref: number;
  dev: number;
}

/** Pair each reference point with the nearest device value within tolerance. */
export function pairNearest(
  ref: TimedValue[],
  dev: TimedValue[],
  toleranceMs = PAIR_TOLERANCE_MS,
): PairedPoint[] {
  const pairs: PairedPoint[] = [];
  for (const r of ref) {
    let best: TimedValue | null = null;
    let bestDt = Infinity;
    for (const d of dev) {
      const dt = Math.abs(d.t - r.t);
      if (dt < bestDt && dt <= toleranceMs) {
        bestDt = dt;
        best = d;
      }
    }
    if (best) pairs.push({ t: r.t, ref: r.v, dev: best.v });
  }
  return pairs;
}

export interface LagResult {
  r0: number;
  pairCount0: number;
  bestLagMin: number;
  bestR: number;
  pairCountBest: number;
  warn: boolean;
  message: string | null;
}

/**
 * Cross-correlation of two series from -3 h to +3 h in 5-minute steps.
 * `lag` is applied to the device timestamps: r(ref(t), dev(t + lag)).
 * Warns when the best lag is not 0 and improves r by more than 0.15.
 */
export function findBestLag(ref: TimedValue[], dev: TimedValue[]): LagResult {
  const empty: LagResult = {
    r0: NaN, pairCount0: 0, bestLagMin: 0, bestR: NaN, pairCountBest: 0, warn: false, message: null,
  };
  if (!ref.length || !dev.length) return empty;

  const atLag = (lagMs: number) => {
    const shifted = dev.map(d => ({ t: d.t + lagMs, v: d.v }));
    const pairs = pairNearest(ref, shifted);
    const r = pairs.length >= 3 ? pearson(pairs.map(p => p.ref), pairs.map(p => p.dev)) : NaN;
    return { pairs, r };
  };

  const zero = atLag(0);
  let bestLagMin = 0;
  let bestR = zero.r;
  let pairCountBest = zero.pairs.length;

  for (let lagMs = -MAX_LAG_MS; lagMs <= MAX_LAG_MS; lagMs += FIVE_MIN_MS) {
    if (lagMs === 0) continue;
    const { pairs, r } = atLag(lagMs);
    if (!isFinite(r)) continue;
    if (!isFinite(bestR) || r > bestR) {
      bestR = r;
      bestLagMin = lagMs / 60000;
      pairCountBest = pairs.length;
    }
  }

  const r0 = zero.r;
  const warn = bestLagMin !== 0
    && isFinite(bestR)
    && isFinite(r0)
    && bestR - r0 > LAG_IMPROVEMENT;
  return {
    r0,
    pairCount0: zero.pairs.length,
    bestLagMin,
    bestR,
    pairCountBest,
    warn,
    message: warn ? `Posible desfase horario de ${bestLagMin} min` : null,
  };
}

export function formatUtcRange(startMs: number, endMs: number): { start: string; end: string } {
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
  };
  return { start: fmt(startMs), end: fmt(endMs) };
}

export const RR_COLUMN_ALIASES = ['rr_ms', 'rr', 'r-r', 'interval', 'intervalo'];
export const RMSSD_COLUMN_ALIASES = ['rmssd_ms', 'hrv_ms', 'rmssd', 'hrv', 'vfc'];

export function columnLooksLikeRr(cols: string[]): boolean {
  return cols.some(col => RR_COLUMN_ALIASES.some(alias => col === alias || col.includes(alias)));
}

export function columnLooksLikeRmssd(cols: string[]): boolean {
  return cols.some(col => RMSSD_COLUMN_ALIASES.some(alias => col === alias || col.includes(alias)));
}

/** When the only value column is generic, guess from the magnitude of the numbers. */
export function valuesLookLikeRr(values: number[]): boolean {
  if (!values.length) return false;
  const asRr = values.filter(v => (v > 0 && v < 10) || (v >= MIN_RR_MS && v <= MAX_RR_MS)).length;
  const asRmssd = values.filter(v => v >= 10 && v < MIN_RR_MS).length;
  return asRr >= asRmssd && asRr >= values.length * 0.5;
}

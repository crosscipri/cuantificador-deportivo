import {
  parseTimestamp, parseOffsetMs, isValidIanaTimeZone,
  cleanRrIntervals, windowedRmssd, pairNearest, findBestLag,
  pearson, mae, rmssdOf, formatUtcRange, valuesLookLikeRr,
  FIVE_MIN_MS, MIN_BEATS_PER_WINDOW,
  type RrBeat, type TimedValue,
} from '../src/app/pages/nocturnal-hrv/rmssd-comparison';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function almost(a: number, b: number, eps = 1e-6, msg?: string) {
  assert(isFinite(a) && isFinite(b) && Math.abs(a - b) <= eps, msg ?? `${a} ≉ ${b}`);
}

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}

console.log('parse timestamps and time zones');

test('epoch seconds are always UTC', () => {
  const d = parseTimestamp('1731794400', { mode: 'local' });
  assert(d.getTime() === 1731794400 * 1000, 'epoch seconds');
});

test('epoch milliseconds are always UTC', () => {
  const d = parseTimestamp('1731794400000', { mode: 'other', other: 'America/New_York' });
  assert(d.getTime() === 1731794400000, 'epoch ms');
});

test('ISO with Z is respected', () => {
  const d = parseTimestamp('2026-11-16T22:00:00Z', { mode: 'local' });
  assert(d.toISOString() === '2026-11-16T22:00:00.000Z', d.toISOString());
});

test('ISO with explicit offset is respected', () => {
  const d = parseTimestamp('2026-11-16T22:00:00+01:00', { mode: 'utc' });
  assert(d.toISOString() === '2026-11-16T21:00:00.000Z', d.toISOString());
});

test('naive ISO defaults to UTC', () => {
  const d = parseTimestamp('2026-11-16T22:00:00');
  assert(d.toISOString() === '2026-11-16T22:00:00.000Z', d.toISOString());
});

test('naive ISO with a space is treated like T', () => {
  const d = parseTimestamp('2026-11-16 22:00:00', { mode: 'utc' });
  assert(d.toISOString() === '2026-11-16T22:00:00.000Z', d.toISOString());
});

test('naive ISO in local mode uses the host zone', () => {
  const d = parseTimestamp('2026-11-16T22:00:00', { mode: 'local' });
  assert(d.getTime() === new Date(2026, 10, 16, 22, 0, 0).getTime(), 'local wall time');
});

test('naive ISO in Europe/Madrid (CET, UTC+1 in November)', () => {
  assert(isValidIanaTimeZone('Europe/Madrid'), 'IANA');
  const d = parseTimestamp('2026-11-16T22:00:00', { mode: 'other', other: 'Europe/Madrid' });
  assert(d.toISOString() === '2026-11-16T21:00:00.000Z', d.toISOString());
});

test('numeric offset +01:00', () => {
  assert(parseOffsetMs('+01:00') === 3600000, 'offset');
  const d = parseTimestamp('2026-11-16T22:00:00', { mode: 'other', other: '+01:00' });
  assert(d.toISOString() === '2026-11-16T21:00:00.000Z', d.toISOString());
});

test('numeric offset UTC-5', () => {
  const d = parseTimestamp('2026-11-16T22:00:00', { mode: 'other', other: 'UTC-5' });
  assert(d.toISOString() === '2026-11-17T03:00:00.000Z', d.toISOString());
});

test('invalid IANA zone yields an invalid date', () => {
  const d = parseTimestamp('2026-11-16T22:00:00', { mode: 'other', other: 'Not/AZone' });
  assert(isNaN(d.getTime()), 'invalid zone');
});

console.log('RR artifact cleaning');

test('intervals outside 300–2000 ms are discarded', () => {
  const t0 = Date.UTC(2026, 10, 16, 22, 0, 0);
  const beats: RrBeat[] = [
    { t: t0, rr: 250 },
    { t: t0 + 1000, rr: 800 },
    { t: t0 + 2000, rr: 2100 },
    { t: t0 + 3000, rr: 900 },
  ];
  const r = cleanRrIntervals(beats);
  assert(r.discarded === 2, 'discarded ' + r.discarded);
  assert(r.beats.length === 2, 'kept ' + r.beats.length);
  assert(r.beats[0].rr === 800 && r.beats[1].rr === 900, 'values kept');
});

test('a spike is replaced, not deleted, and timestamps stay', () => {
  const t0 = Date.UTC(2026, 10, 16, 22, 0, 0);
  const beats: RrBeat[] = [];
  for (let i = 0; i < 15; i++) beats.push({ t: t0 + i * 1000, rr: 800 });
  beats[7] = { t: t0 + 7 * 1000, rr: 1600 }; // +100% vs 800
  const r = cleanRrIntervals(beats);
  assert(r.beats.length === 15, 'count preserved');
  assert(r.beats[7].t === t0 + 7 * 1000, 'timestamp kept');
  almost(r.beats[7].rr, 800, 1e-6, 'replaced with median');
  assert(r.corrected === 1, 'one correction');
  almost(r.correctedPct, 1 / 15 * 100, 1e-6);
});

test('two passes clean a leftover spike after the first substitution', () => {
  const t0 = 0;
  const rr = [800, 800, 800, 800, 1600, 1600, 800, 800, 800, 800, 800];
  const beats = rr.map((v, i) => ({ t: t0 + i * 1000, rr: v }));
  const one = cleanRrIntervals(beats, 0.2, 1);
  const two = cleanRrIntervals(beats, 0.2, 2);
  assert(two.corrected >= one.corrected, 'second pass can correct more');
  assert(two.beats.length === rr.length, 'count preserved');
  // After two passes both spikes should be pulled toward the local median.
  assert(two.beats[4].rr < 1600 && two.beats[5].rr < 1600, 'spikes reduced');
});

console.log('windowed RMSSD');

test('RMSSD is sqrt of the mean of squared successive differences', () => {
  almost(rmssdOf([800, 1000, 800]), Math.sqrt(((200) ** 2 + (-200) ** 2) / 2));
});

test('a window needs at least 100 valid beats', () => {
  const start = Date.UTC(2026, 10, 16, 22, 0, 0);
  const ninetyNine: RrBeat[] = [];
  for (let i = 0; i < 99; i++) ninetyNine.push({ t: start + i * 1000, rr: 800 });
  assert(windowedRmssd(ninetyNine).length === 0, '99 beats skipped');
  ninetyNine.push({ t: start + 99 * 1000, rr: 800 });
  const wins = windowedRmssd(ninetyNine);
  assert(wins.length === 1, '100 beats accepted');
  assert(wins[0].t === start, 'aligned to the UTC 5-min mark');
  almost(wins[0].rmssd, 0);
  assert(wins[0].beats === MIN_BEATS_PER_WINDOW, 'beat count');
});

test('windows sit on a UTC grid of whole 5-minute marks', () => {
  const start = Date.UTC(2026, 10, 16, 22, 2, 0); // 22:02, not aligned
  const beats: RrBeat[] = [];
  // Cover 22:00–22:10 with enough beats in 22:05–22:10 only
  for (let i = 0; i < 100; i++) beats.push({ t: Date.UTC(2026, 10, 16, 22, 5, 0) + i * 1000, rr: 900 });
  const wins = windowedRmssd(beats);
  assert(wins.every(w => w.t % FIVE_MIN_MS === 0), 'grid alignment');
  assert(wins.length === 1 && wins[0].t === Date.UTC(2026, 10, 16, 22, 5, 0), '22:05 window');
});

console.log('pairing, r, MAE, lag');

test('pairs only overlapping nearest windows and reports the count', () => {
  const ref: TimedValue[] = [
    { t: 0, v: 40 },
    { t: FIVE_MIN_MS, v: 50 },
    { t: 2 * FIVE_MIN_MS, v: 60 },
  ];
  const dev: TimedValue[] = [
    { t: 30_000, v: 42 }, // nearest to t=0
    { t: 2 * FIVE_MIN_MS + 10_000, v: 70 },
    { t: 10 * FIVE_MIN_MS, v: 999 }, // outside overlap
  ];
  const pairs = pairNearest(ref, dev);
  assert(pairs.length === 2, 'pair count ' + pairs.length);
  almost(pairs[0].ref, 40);
  almost(pairs[0].dev, 42);
  almost(pairs[1].ref, 60);
  almost(pairs[1].dev, 70);
  almost(mae(pairs.map(p => [p.ref, p.dev] as [number, number])), (2 + 10) / 2);
});

test('identical series have lag 0 and no warning', () => {
  const series: TimedValue[] = [];
  for (let i = 0; i < 20; i++) series.push({ t: i * FIVE_MIN_MS, v: 40 + Math.sin(i / 2) * 8 });
  const lag = findBestLag(series, series);
  assert(lag.bestLagMin === 0, 'lag ' + lag.bestLagMin);
  assert(lag.warn === false, 'no warning');
  almost(lag.r0, 1, 1e-9);
  assert(lag.pairCount0 === 20, 'pairs');
});

test('a 60-minute shift is reported and not auto-corrected', () => {
  const ref: TimedValue[] = [];
  for (let i = 0; i < 36; i++) ref.push({ t: i * FIVE_MIN_MS, v: 40 + Math.sin(i / 3) * 10 });
  const dev = ref.map(p => ({ t: p.t - 60 * 60 * 1000, v: p.v })); // device clock 60 min behind
  const lag = findBestLag(ref, dev);
  assert(lag.bestLagMin === 60, 'expected +60 min, got ' + lag.bestLagMin);
  assert(lag.warn === true, 'should warn');
  assert(lag.message === 'Posible desfase horario de 60 min', String(lag.message));
  assert(lag.bestR - lag.r0 > 0.15, 'improvement');
});

test('UTC range formatting', () => {
  const r = formatUtcRange(Date.UTC(2026, 10, 16, 22, 0, 0), Date.UTC(2026, 10, 17, 6, 30, 0));
  assert(r.start === '2026-11-16 22:00:00 UTC', r.start);
  assert(r.end === '2026-11-17 06:30:00 UTC', r.end);
});

test('value heuristic distinguishes RR from precomputed RMSSD', () => {
  assert(valuesLookLikeRr([0.92, 0.88, 1.01, 0.95]));
  assert(valuesLookLikeRr([800, 820, 790, 810]));
  assert(!valuesLookLikeRr([42, 48, 51, 39, 44]));
});

test('pearson of a perfect line is 1', () => {
  almost(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1, 1e-9);
});

test('re-parsing a naive ISO file under a new zone shifts timestamps and the windows', () => {
  const rows = [
    'timestamp,rmssd_ms',
    '2026-11-16T22:00:00,40',
    '2026-11-16T22:05:00,45',
    '2026-11-16T22:10:00,50',
  ];
  const parse = (tz: { mode: 'utc' | 'other'; other?: string }) =>
    rows.slice(1).map(line => {
      const [ts, v] = line.split(',');
      return { t: parseTimestamp(ts, tz).getTime(), v: Number(v) };
    });
  const utc = parse({ mode: 'utc' });
  const madrid = parse({ mode: 'other', other: 'Europe/Madrid' });
  assert(utc.every((p, i) => p.t - madrid[i].t === 3600000), 'Madrid is 1 h behind UTC in November');
  assert(utc[0].t === Date.UTC(2026, 10, 16, 22, 0, 0), 'UTC parse');
  assert(madrid[0].t === Date.UTC(2026, 10, 16, 21, 0, 0), 're-parse shifts the series');
  // A 60 min lag between the two readings of the same file is exactly the zone change.
  const lag = findBestLag(utc, madrid);
  assert(lag.bestLagMin === 60, 'lag ' + lag.bestLagMin);
  almost(lag.bestR, 1, 1e-9);
});

console.log(`\n${passed} tests passed`);

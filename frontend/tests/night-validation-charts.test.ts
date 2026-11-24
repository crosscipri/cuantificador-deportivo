import {
  BRAND_COLORS, FEW_NIGHTS, LEADERBOARDS, UNITS, brandOf, brandColor, fmt, kindPairs, leaderboardChart,
  nightCurve, nightLabel, nightlyPairs, pointLabelsPlugin, scatterVsReference, squareBounds, statLines,
} from '../src/app/pages/night-validation/night-validation-charts';
import type { NightKindSummary, NightValidationDevice } from '../src/app/models/night-validation.model';

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; }

function summary(over: Partial<NightKindSummary> = {}): NightKindSummary {
  return {
    n: 3, r: 0.9, r2: 0.81, mae: 1.2, bias: 0.3, slope: 1.1, intercept: -2, nights: 2, windows: 4, coverage: 0.75,
    nightly: { n: 2, r: null, r2: null, mae: 0.5, bias: 0.1, slope: 1, intercept: 0,
      points: [{ session_id: 'a', origin_utc: 1, reference: 50, device: 51 }, { session_id: 'b', origin_utc: 2, reference: null, device: 40 }] },
    series: [{ session_id: 'a', origin_utc: 1788123600, time: [0, 300, 600, 900], reference: [50, 51, null, 53], device: [50, null, 52, 54], windows: 4 }],
    ...over,
  };
}
function device(name: string, hr: Partial<NightKindSummary> = {}, rmssd: Partial<NightKindSummary> = {}): NightValidationDevice {
  return { device_id: name, name, reference: 'Polar', hr: summary(hr), rmssd: summary(rmssd) };
}

test('marcas y colores: los Garmin comparten rojo', () => {
  assert(brandOf('Garmin Forerunner 70') === 'Garmin' && brandOf('garmin Cirqa') === 'Garmin', 'brand');
  assert(brandColor('Garmin') === BRAND_COLORS['Garmin'], 'garmin red');
  assert(brandColor('Nueva', ['Nueva']) !== brandColor('Garmin'), 'fallback color');
});

test('unidades en bpm y ms', () => {
  assert(UNITS.hr === 'bpm' && UNITS.rmssd === 'ms', 'units');
  assert(LEADERBOARDS.hr.xTitle === 'FC: MAE / bpm' && LEADERBOARDS.mae.xTitle.includes('bpm'), 'axis units');
  assert(!JSON.stringify(LEADERBOARDS).includes('ppm'), 'no ppm');
});

test('formato español y recuadro sin límites de acuerdo', () => {
  assert(fmt(0.937, 2) === '0,94' && fmt(null) === '—', 'fmt');
  const lines = statLines({ n: 3, r: 0.9, r2: 0.81, mae: 1.2, bias: -0.3, slope: 1.1, intercept: -2 }, 'bpm');
  assert(lines.join('|') === 'n = 3|r = 0,90|R² = 0,81|MAE = 1,20 bpm|Sesgo = -0,30 bpm|y = 1,10x − 2,00', lines.join('|'));
  assert(!lines.some(l => /LoA|acuerdo|CCC/i.test(l)), 'only pearson');
});

test('clasificación: un dataset por marca, ejes invertidos y sin dispositivos sin dato', () => {
  const devs = [device('Garmin Cirqa'), device('Garmin Forerunner 70'), device('Fitbit Air'), device('Sin dato', { mae: null })];
  const c = leaderboardChart(devs, LEADERBOARDS.mae);
  assert(c.data.datasets.length === 2, 'two brands');
  const garmin = c.data.datasets.find((d: any) => d.label === 'Garmin');
  assert(garmin.pointLabels.length === 2 && garmin.backgroundColor === BRAND_COLORS['Garmin'], 'garmin dataset');
  assert(c.options.scales.x.reverse === true && c.options.scales.y.reverse === true, 'reversed');
  assert(leaderboardChart(devs, LEADERBOARDS.r).options.scales.x.reverse === false, 'r not reversed');
});

test('scatter frente a referencia: identidad, regresión y ejes cuadrados', () => {
  const s = summary();
  const pairs = kindPairs(s);
  assert(pairs.length === 2 && pairs[0][0] === 50 && pairs[1][1] === 54, 'pairs skip nulls');
  const c = scatterVsReference(pairs, s, 'bpm', 'x', 'y');
  assert(c.data.datasets.length === 3, 'points + identity + regression');
  assert(c.options.scales.x.min === c.options.scales.y.min && c.options.scales.x.max === c.options.scales.y.max, 'square');
  const noReg = scatterVsReference([[50, 51]], { ...s, slope: null, intercept: null }, 'bpm', 'x', 'y');
  assert(noReg.data.datasets.length === 2, 'no regression without slope');
});

test('medias por noche se muestran aunque haya pocas noches', () => {
  const s = summary();
  assert(nightlyPairs(s).length === 1, 'nightly pairs skip nulls');
  assert(s.nights < FEW_NIGHTS, 'few nights flag threshold');
});

test('curva: referencia roja, dispositivo turquesa, horas', () => {
  const c = nightCurve(summary().series[0], 'Fitbit Air', 'FC / bpm');
  assert(c.data.datasets[0].label === 'Polar (referencia)' && c.data.datasets[1].label === 'Fitbit Air', 'labels');
  assert(c.data.datasets[0].data[2].y === null && c.data.datasets[1].data[3].x === 0.25, 'gaps + hours');
});

test('límites redondos y fecha en Madrid', () => {
  const b = squareBounds([41, 79]);
  assert(b.min === 40 && b.max === 80 && b.step === 10, JSON.stringify(b));
  assert(nightLabel(1788123600) === '30/08/2026', nightLabel(1788123600));
  assert(nightLabel(null) === 'sin fecha', 'null date');
});

test('las etiquetas no se montan sobre los números del eje y', () => {
  const placed: { t: string; x: number }[] = [];
  const ctx: any = { save() {}, restore() {}, measureText: (t: string) => ({ width: t.length * 6 }),
    fillText: (t: string, x: number) => placed.push({ t, x }), beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} };
  const chart: any = {
    ctx, chartArea: { left: 60, right: 500, top: 0, bottom: 400 }, isDatasetVisible: () => true,
    data: { datasets: [{ pointLabels: ['Garmin Forerunner 265', 'Samsung Galaxy Watch 9', 'Fitbit Air'], backgroundColor: '#e3262b' }] },
    getDatasetMeta: () => ({ data: [{ x: 64, y: 200 }, { x: 72, y: 210 }, { x: 66, y: 190 }] }),
  };
  pointLabelsPlugin.afterDatasetsDraw(chart);
  assert(placed.length === 3 && placed.every(p => p.x >= 62), JSON.stringify(placed));
});

console.log(`night-validation-charts: ${passed} tests OK`);

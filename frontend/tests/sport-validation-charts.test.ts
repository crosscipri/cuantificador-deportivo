import { BRAND_COLORS, pointLabelsPlugin } from '../src/app/pages/night-validation/night-validation-charts';
import {
  FEW_SESSIONS, SPORT_LABELS, byMae, fewSessions, headGroup, medianMae, sessionsBreakdown, sportLeaderboard,
  sportLeaderboards, sportScatter,
} from '../src/app/pages/sport-validation/sport-validation-charts';
import type { SportValidationDevice } from '../src/app/models/sport-validation.model';

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
let passed = 0;
function test(name: string, fn: () => void) { try { fn(); passed++; } catch (e) { console.error(`✗ ${name}`); throw e; } }

function dev(name: string, mae: number | null, r: number | null, sessions = 6, over: Partial<SportValidationDevice> = {}): SportValidationDevice {
  return {
    device_id: name, name, sessions, n: 1000, r, r2: r == null ? null : r * r, mae, bias: 0.1, slope: 0.99, intercept: 1.2,
    sample: [[100, 101], [120, 119], [140, 141]], ...over,
  };
}

// Valores reales de carrera (maqueta validada).
const running = [
  dev('Garmin Forerunner 170', 1.07, 0.9961, 3), dev('Huawei Watch Fit 5 Pro', 1.23, 0.9959, 3),
  dev('Garmin Forerunner 265', 1.38, 0.9898, 7), dev('Fitbit Air', 1.48, 0.9936, 9), dev('Garmin Cirqa', 1.51, 0.9943, 6),
  dev('Samsung Galaxy Watch 9', 1.52, 0.9887, 3), dev('Garmin Forerunner 70', 2.33, 0.9623, 3),
  dev('Ultrahuman Ring Air', 10.38, 0.7766, 5), dev('Realme Watch 5', 14.70, 0.4189, 4),
];

test('etiquetas en castellano y umbral de pocas sesiones', () => {
  assert(SPORT_LABELS.running === 'Carrera' && SPORT_LABELS.gym === 'Fuerza' && SPORT_LABELS.cycling === 'Ciclismo', 'labels');
  assert(SPORT_LABELS.combined === 'Los 3 deportes combinados', 'combined label');
  assert(FEW_SESSIONS === 5 && fewSessions(dev('a', 1, 1, 4)) && !fewSessions(dev('a', 1, 1, 5)), 'few');
});

test('orden por MAE y grupo de cabeza (MAE ≤ 2 × mediana)', () => {
  assert(byMae([dev('b', 2, 0.9), dev('a', 1, 0.9), dev('x', null, 0.9)]).map(d => d.name).join() === 'a,b', 'byMae');
  assert(medianMae(running) === 1.51, String(medianMae(running)));
  const head = headGroup(running);
  assert(Math.abs((head.limit as number) - 3.02) < 1e-9 && head.devices.length === 7, JSON.stringify(head.limit));
  assert(!head.devices.some(d => d.name.startsWith('Ultrahuman') || d.name.startsWith('Realme')), 'outliers out');
  assert(medianMae([]) === null && headGroup([]).devices.length === 0, 'empty');
});

test('clasificación: un dataset por marca, colores aprobados y MAE invertido', () => {
  const c = sportLeaderboard(running);
  const colors = Object.fromEntries(c.data.datasets.map((d: any) => [d.label, d.backgroundColor]));
  assert(colors['Garmin'] === BRAND_COLORS['Garmin'] && colors['Fitbit'] === '#16b46c' && colors['Huawei'] === '#f08a00', 'colors');
  assert(colors['Ultrahuman'] === '#7a3fc4' && colors['Samsung'] === '#1f5fd1' && colors['Realme'] === '#8c6d00', 'colors 2');
  const garmin = c.data.datasets.find((d: any) => d.label === 'Garmin');
  assert(garmin.data.length === 4, 'all garmins in one red dataset');
  assert(c.options.scales.x.reverse === true && c.options.scales.y.reverse !== true && c.options.scales.y.max === 1, 'axes');
  assert(c.options.scales.x.title.text === 'FC: MAE / bpm' && c.options.scales.y.title.text === 'FC: correlación / r', 'titles');
  assert(garmin.pointLabels.includes('Garmin Forerunner 70 ⚠') && garmin.pointLabels.includes('Garmin Cirqa'), 'few marker');
});

test('vista general con recuadro sin nombres + detalle del grupo de cabeza', () => {
  const b = sportLeaderboards(running);
  assert(b.zoom !== null && b.head.length === 7, 'zoom');
  const labels = b.all.data.datasets.flatMap((d: any) => d.pointLabels);
  assert(labels.filter((l: string) => !l).length === 7, 'head unlabeled in overview');
  assert(labels.includes('Realme Watch 5 ⚠') && b.all.options.plugins.svClusterBox.enabled, 'outliers labeled + box');
  assert(b.zoom!.data.datasets.flatMap((d: any) => d.pointLabels).every((l: string) => !!l), 'zoom labeled');
  const tight = sportLeaderboards([dev('Garmin A', 1, 0.99), dev('Fitbit B', 1.2, 0.98)]);
  assert(tight.zoom === null && !tight.all.options.plugins.svClusterBox.enabled, 'no zoom when nobody is out');
});

test('dispersión frente a Polar: identidad, regresión, recuadro solo Pearson', () => {
  const s = sportScatter(dev('Fitbit Air', 1.48, 0.9936, 9, { n: 21815, r2: 0.9873, bias: -0.22, slope: 0.986, intercept: 1.8 }));
  assert(s.data.datasets.length === 3, 'points + identity + regression');
  assert(s.options.scales.x.min === s.options.scales.y.min && s.options.scales.x.max === s.options.scales.y.max, 'square');
  const lines: string[] = s.options.plugins.nvStatBox.lines;
  assert(lines[0] === 'n = 21.815 pares (9 sesiones)' && lines.includes('MAE = 1,48 bpm') && lines.includes('r = 0,994') && lines.includes('R² = 0,987') && lines.includes('y = 0,986x + 1,80'), lines.join('|'));
  assert(lines.some(l => l.startsWith('y = ')) && lines.some(l => l.startsWith('R² =')) && lines.some(l => l.startsWith('Sesgo')), 'box');
  assert(!JSON.stringify(s).match(/LoA|loa_|Bland|CCC|ppm/i), 'no agreement limits / ppm');
  const noReg = sportScatter(dev('x', 1, null, 3, { slope: null, intercept: null }));
  assert(noReg.data.datasets.length === 2, 'no regression without slope');
});

test('desglose de sesiones de la vista combinada', () => {
  const d = dev('Fitbit Air', 3, 0.95, 24, { sessions_by_sport: { running: 9, gym: 9, cycling: 6 } });
  assert(sessionsBreakdown(d) === 'Carrera 9 · Fuerza 9 · Ciclismo 6', sessionsBreakdown(d));
  assert(sessionsBreakdown(dev('x', 1, 1)) === '', 'no breakdown');
});

test('las etiquetas vacías no se dibujan', () => {
  const texts: string[] = [];
  const ctx: any = { save() {}, restore() {}, measureText: (t: string) => ({ width: t.length * 5 }), fillText: (t: string) => texts.push(t),
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} };
  const chart: any = {
    ctx, chartArea: { left: 0, right: 500, top: 0, bottom: 400 }, isDatasetVisible: () => true,
    data: { datasets: [{ pointLabels: ['', 'Garmin Cirqa'], backgroundColor: '#e3262b' }] },
    getDatasetMeta: () => ({ data: [{ x: 100, y: 100 }, { x: 300, y: 200 }] }),
  };
  pointLabelsPlugin.afterDatasetsDraw(chart);
  assert(texts.length === 1 && texts[0] === 'Garmin Cirqa', JSON.stringify(texts));
});

console.log(`sport-validation-charts: ${passed} tests OK`);

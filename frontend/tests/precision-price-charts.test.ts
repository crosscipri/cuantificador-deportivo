import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrecisionPriceDevice, PrecisionPriceView } from '../src/app/models/precision-price.model';
import {
  PRICE_MAX, SHORT_LABELS, VIEW_COPY, chartLabel, euro, formatDate, insideLabelsPlugin,
  priceScoreChart, shortLabel, tooltipLines,
} from '../src/app/pages/precision-price/precision-price-charts';

let passed = 0;
function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
  passed += 1;
}
function test(name: string, fn: () => void) {
  fn();
}

const air: PrecisionPriceDevice = {
  device_id: 'air', name: 'Fitbit Air', score: 88.47, price: 99.99,
  shop: 'Google Store', label: 'Google Store · Fitbit Air', checked_at: '2026-10-14',
  source: 'content/shop-offers/verified-offers.json', value_index: 88.5, frontier: true, few: false,
  sessions: 24, n: 59758, mae: 2.9359, r: 0.9826,
  nights: 5, hr_mae: 0.9788, hr_r: 0.9373, rmssd_mae: 6.9307, rmssd_r: 0.9659,
  sport_score: 88.47, sport_mae: 2.9359, sport_r: 0.9826, sport_sessions: 24,
  night_score: 84.49, night_nights: 5,
};
const huawei: PrecisionPriceDevice = {
  device_id: 'huawei', name: 'Huawei Watch Fit 5 Pro', score: 73.24, price: 299,
  shop: 'PcComponentes', label: 'PcComponentes · Fit 5 Pro blanco', checked_at: '2026-10-14',
  source: 'x', value_index: 24.5, frontier: false, few: true,
  nights: 4, hr_mae: 1.3764, hr_r: 0.9724, rmssd_mae: 13.4379, rmssd_r: 0.854,
};

test('eje X invertido y título de más caro a más barato', () => {
  const cfg = priceScoreChart([air, huawei], 'sports');
  assert(cfg.options.scales.x.reverse === true, 'x reversed');
  assert(cfg.options.scales.x.min === 0 && cfg.options.scales.x.max === PRICE_MAX, 'x domain');
  assert(cfg.options.scales.y.min === 0 && cfg.options.scales.y.max === 100, 'y 0-100');
  const title = cfg.options.scales.x.title.text as string;
  assert(title.includes('más caro') && title.includes('más barato') && title.includes('←') && title.includes('→'), title);
  assert(VIEW_COPY.sports.subtitle.includes('arriba a la derecha'), 'copy');
});

test('frontera de Pareto como línea y puntos destacados', () => {
  const mid: PrecisionPriceDevice = { ...huawei, device_id: 'mid', name: 'Garmin Cirqa', score: 88.92, price: 199.99, frontier: true, few: false };
  const cfg = priceScoreChart([air, mid, huawei], 'sports');
  const line = cfg.data.datasets.find((d: any) => d.label === 'Frontera de Pareto');
  assert(line && line.type === 'line' && line.data.length === 2, JSON.stringify(line?.data));
  assert(line.data[0].x === 99.99 && line.data[1].x === 199.99, 'sorted by price');
  const airDs = cfg.data.datasets.find((d: any) => d.items?.some((x: PrecisionPriceDevice) => x.name === 'Fitbit Air'));
  const airIdx = airDs.items.findIndex((x: PrecisionPriceDevice) => x.name === 'Fitbit Air');
  assert(airDs.pointStyle[airIdx] === 'rectRot' && airDs.pointLabels[airIdx].includes('★'), airDs.pointLabels[airIdx]);
});

test('tooltip incluye nota, MAE, r, precio, tienda, fecha y pocas', () => {
  const sport = tooltipLines(air, 'sports');
  assert(sport.some(l => l.startsWith('Nota: 88,5')), sport.join('|'));
  assert(sport.some(l => l.includes('MAE: 2,94 lpm') && l.includes('r: 0,983')), sport.join('|'));
  assert(sport.some(l => l.includes('99,99 €')), sport.join('|'));
  assert(sport.some(l => l.includes('Google Store') && l.includes('2026')), sport.join('|'));
  const night = tooltipLines(huawei, 'night');
  assert(night.some(l => l.includes('⚠ Pocas noches')), night.join('|'));
  assert(night.some(l => l.includes('FC en reposo') && l.includes('1,38')), night.join('|'));
  assert(chartLabel(huawei).includes('⚠') && chartLabel(huawei).includes('Fit 5 Pro'), chartLabel(huawei));
  assert(euro(99.99) === '99,99 €', euro(99.99));
  assert(formatDate('2026-10-14').includes('2026'), formatDate('2026-10-14'));
  assert(shortLabel('Garmin Forerunner 170') === 'Forerunner 170' && SHORT_LABELS['Fitbit Air'] === 'Fitbit Air', 'labels');
});

test('las etiquetas se recortan al área del gráfico (no tapan el eje y)', () => {
  const texts: { x: number; t: string }[] = [];
  const area = { left: 40, right: 500, top: 20, bottom: 400 };
  const ctx: any = {
    save() {}, restore() {},
    measureText: (t: string) => ({ width: t.length * 5 }),
    fillText: (t: string, x: number) => texts.push({ x, t }),
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  };
  const chart: any = {
    ctx, chartArea: area, isDatasetVisible: () => true,
    data: { datasets: [{ pointLabels: ['Fitbit Air ★'], borderColor: '#16b46c', backgroundColor: '#16b46c' }] },
    getDatasetMeta: () => ({ data: [{ x: 45, y: 30 }] }), // cerca del eje y
  };
  insideLabelsPlugin.afterDatasetsDraw(chart);
  assert(texts.length === 1, JSON.stringify(texts));
  assert(texts[0].x >= area.left, `label x=${texts[0].x} covers y-axis`);
});

test('la página no incluye tablas de datos', () => {
  const html = readFileSync(join(process.cwd(), 'src/app/pages/precision-price/precision-price.component.html'), 'utf8');
  assert(!/<table\b/i.test(html), 'found a table in the template');
  const views: PrecisionPriceView[] = ['sports', 'night', 'final'];
  views.forEach(v => assert(VIEW_COPY[v].subtitle.includes('arriba a la derecha'), v));
});

console.log(`precision-price-charts: ${passed} tests OK`);

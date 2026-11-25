import type { PrecisionPriceDevice } from '../src/app/models/precision-price.model';
import type { SportValidationDevice, SportValidationResponse } from '../src/app/models/sport-validation.model';
import type { NightKindSummary, NightValidationResponse } from '../src/app/models/night-validation.model';
import { PRICE_MAX, priceAxisMax, priceScoreChart } from '../src/app/pages/precision-price/precision-price-charts';
import {
  DETAIL_GRIDS, DETAIL_TOP, SCATTER_POINTS_MAX, buildDetailGrids, decimate, selectSource, topDevices,
} from '../src/app/pages/precision-price/precision-price-details';

let passed = 0;
function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

const dev = (id: string, name: string, price: number, extra: Partial<PrecisionPriceDevice> = {}): PrecisionPriceDevice => ({
  device_id: id, name, score: 80, price, shop: null, label: null, checked_at: null, source: null,
  value_index: null, frontier: false, few: false, ...extra,
});

const sample = (n: number): [number, number][] => Array.from({ length: n }, (_, i) => [100 + (i % 60), 101 + (i % 60)]);
const sportDev = (id: string, name: string, sessions: number, series?: any[]): SportValidationDevice => ({
  device_id: id, name, sessions, n: 4000, r: 0.98, r2: 0.96, mae: 2, bias: 0, slope: 1, intercept: 0,
  sample: sample(4000), series,
});
const serie = (name: string, points: number) => ({
  session_id: name, date: '2026-06-06', name,
  time: Array.from({ length: points }, (_, i) => i * 10),
  reference: Array.from({ length: points }, () => 120), device: Array.from({ length: points }, () => 121),
});

const sport = {
  version: 'x', reference: 'Polar H10', metrics: [], sample_max: 4000,
  sport_labels: {} as any,
  sports: {
    combined: [sportDev('a', 'Fitbit Air', 24), sportDev('b', 'Garmin Cirqa', 3)],
    running: [sportDev('a', 'Fitbit Air', 12, [serie('corta', 10), serie('larga', 50)]), sportDev('b', 'Garmin Cirqa', 3, [serie('r', 5)])],
    gym: [sportDev('a', 'Fitbit Air', 6, [serie('gym grande', 500)])],
    cycling: [],
  },
} as unknown as SportValidationResponse;

const kind = (nights: number, series: any[]): NightKindSummary => ({
  n: 100, r: 0.95, r2: 0.9, mae: 1, bias: 0, slope: 1, intercept: 0, nights, windows: 100, coverage: 1,
  nightly: { n: 0, r: null, r2: null, mae: null, bias: null, slope: null, intercept: null, points: [] }, series,
});
const nseries = (windows: number) => ({
  session_id: `n${windows}`, origin_utc: 1788000000, time: Array.from({ length: windows }, (_, i) => i * 300),
  reference: Array.from({ length: windows }, () => 55), device: Array.from({ length: windows }, () => 56), windows,
});
const night = {
  version: 'x', window_seconds: 300, reference: 'Polar', metrics: [],
  devices: [
    { device_id: 'a', name: 'Fitbit Air', reference: 'Polar', hr: kind(6, [nseries(20), nseries(90)]), rmssd: kind(6, [nseries(20)]) },
    { device_id: 'b', name: 'Garmin Cirqa', reference: 'Polar', hr: kind(2, [nseries(30)]), rmssd: { ...kind(2, []), n: 0 } },
  ],
} as unknown as NightValidationResponse;

const a = dev('a', 'Fitbit Air', 99.99);
const b = dev('b', 'Garmin Cirqa', 199.99);
const ghost = dev('ghost', 'Sin datos de detalle', 120);

// eje de precio: nunca recorta un dispositivo caro
assert(priceAxisMax([a, b]) === PRICE_MAX, 'mínimo 450');
assert(priceAxisMax([dev('w', 'Galaxy Watch Ultra 2', 699)]) === 750, String(priceAxisMax([dev('w', 'x', 699)])));
assert(priceAxisMax([dev('w', 'x', 425)]) === 450, 'cabe justo');
assert(priceAxisMax([dev('w', 'x', 430)]) === 500, 'margen de 25 €');
assert(priceScoreChart([dev('w', 'x', 699)], 'sports').options.scales.x.max === 750, 'x.max dinámico');
assert(priceAxisMax([dev('w', 'Samsung Galaxy Watch Ultra 2', 750)]) === 800, '750 € entra en el eje (máximo 800)');
assert(priceScoreChart([dev('w', 'Samsung Galaxy Watch Ultra 2', 750)], 'sports').options.scales.x.max === 800, 'x.max 750');

// decimación
assert(decimate(sample(4000)).length <= SCATTER_POINTS_MAX, 'decimate max');
assert(decimate(sample(10)).length === 10, 'decimate no toca lo pequeño');

// deportes: correlación + curva por dispositivo
const sports = buildDetailGrids('sports', [a, b, ghost], sport, null);
assert(sports.map(g => g.key).join() === DETAIL_GRIDS.sports.join(), sports.map(g => g.key).join());
const corr = sports[0];
assert(corr.cards.map(c => c.deviceId).join() === 'a,b', 'solo dispositivos con datos');
assert(corr.cards[0].chart!.data.datasets[0].data.length <= SCATTER_POINTS_MAX, 'muestra reducida');
assert(corr.cards[0].few === false && corr.cards[1].few === true, '⚠ pocas con menos de 5 sesiones');
const lines: string[] = corr.cards[0].chart!.options.plugins.nvStatBox.lines;
assert(lines.some(l => l.startsWith('r = ')), lines.join('|'));
assert(!JSON.stringify(corr.cards[0].chart).match(/Bland|loa|límites de acuerdo/i), 'sin Bland-Altman');
const curves = sports[1];
const ca = curves.cards[0];
assert(ca.sources!.length === 3, String(ca.sources!.length));
assert(ca.sources![ca.index!].label.includes('Carrera') && ca.sources![ca.index!].label.includes('larga'), ca.sources![ca.index!].label);
assert(ca.chart!.options.plugins.legend.position === 'bottom', 'leyenda compacta');
selectSource(ca, 2);
assert(ca.index === 2 && ca.chart!.data.datasets[0].data.length === 500, 'cambia de sesión');

// noche: FC, HRV y curva; Cirqa no tiene HRV
const nightGrids = buildDetailGrids('night', [a, b], null, night);
assert(nightGrids.map(g => g.key).join() === DETAIL_GRIDS.night.join(), nightGrids.map(g => g.key).join());
assert(nightGrids[0].cards.length === 2 && nightGrids[1].cards.length === 1, 'HRV solo con datos');
assert(nightGrids[0].cards[1].few === true && nightGrids[0].cards[0].few === false, 'pocas noches');
const nc = nightGrids[2].cards[0];
assert(nc.sources![nc.index!].weight === 90, 'noche con más ventanas por defecto');

// final: ambas fuentes
const fin = buildDetailGrids('final', [a, b], sport, night);
assert(fin.map(g => g.key).join() === DETAIL_GRIDS.final.join(), fin.map(g => g.key).join());

// sin datos de una fuente no revienta
assert(buildDetailGrids('final', [a], null, null).length === 0, 'sin fuentes, sin rejillas');

// Solo los 6 con mejor nota (rejilla 3×2), por la nota de esa comparativa
assert(DETAIL_TOP === 6, 'límite 6');
const crowd: PrecisionPriceDevice[] = Array.from({ length: 9 }, (_, i) =>
  dev(`id${i}`, `Dispositivo ${i}`, 100 + i, { score: 50 + i }));
const top = topDevices(crowd);
assert(top.length === 6, String(top.length));
assert(top.map(d => d.device_id).join() === 'id8,id7,id6,id5,id4,id3', top.map(d => d.device_id).join());
assert(topDevices(crowd.slice(0, 4)).length === 4, 'si hay menos de 6, salen todos');
// empate: desempate por nombre
const tied = [dev('z', 'Zeta', 1, { score: 90 }), dev('a', 'Alfa', 1, { score: 90 }), dev('m', 'Mid', 1, { score: 80 })];
assert(topDevices(tied, 2).map(d => d.name).join() === 'Alfa,Zeta', 'desempate por nombre');

const sportCrowd = {
  version: 'x', reference: 'Polar H10', metrics: [], sample_max: 4000,
  sport_labels: {} as any,
  sports: {
    combined: crowd.map(d => sportDev(d.device_id, d.name, 8)),
    running: crowd.map(d => sportDev(d.device_id, d.name, 8, [serie('r', 10)])),
    gym: [], cycling: [],
  },
} as unknown as SportValidationResponse;
const limited = buildDetailGrids('sports', crowd, sportCrowd, null);
assert(limited[0].cards.length === 6 && limited[1].cards.length === 6, '6 tarjetas por bloque');
assert(limited[0].cards.map(c => c.deviceId).join() === 'id8,id7,id6,id5,id4,id3', limited[0].cards.map(c => c.deviceId).join());

console.log(`precision-price-details: ${passed} comprobaciones OK`);

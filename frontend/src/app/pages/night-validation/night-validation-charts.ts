/**
 * Gráficas de validación nocturna al estilo de The Quantified Scientist:
 * clasificaciones (un punto por dispositivo), dispositivo frente a referencia
 * ventana a ventana, medias por noche y curva de la noche.
 * Solo r de Pearson; sin límites de acuerdo ni Bland-Altman.
 */
import type { NightKindSummary, NightPairStats, NightSeries, NightValidationDevice } from '../../models/night-validation.model';

export type NightKind = 'hr' | 'rmssd';
export const UNITS: Record<NightKind, string> = { hr: 'bpm', rmssd: 'ms' };
export const REFERENCE_COLOR = '#F8766D';
export const DEVICE_COLOR = '#00BFC4';
export const FEW_NIGHTS = 5;

/** Un color por marca; todos los Garmin comparten rojo. */
export const BRAND_COLORS: Record<string, string> = {
  Fitbit: '#16b46c', Garmin: '#e3262b', Huawei: '#f08a00', Ultrahuman: '#7a3fc4',
  Samsung: '#1f5fd1', Apple: '#12b5d6', Polar: '#b8860b', Oura: '#d6249f',
  Amazfit: '#0f8f8f', Realme: '#8c6d00', Suunto: '#4b2f91', Whoop: '#333333',
  Coros: '#a0522d', Xiaomi: '#ff6f61', Google: '#4285f4', Withings: '#6b7280',
};
const EXTRA_COLORS = ['#8b5a2b', '#2f855a', '#b83280', '#2b6cb0', '#975a16', '#553c9a'];

export function brandOf(name: string): string {
  const first = (name || '').trim().split(/\s+/)[0] ?? '';
  const known = Object.keys(BRAND_COLORS).find(b => b.toLowerCase() === first.toLowerCase());
  return known ?? (first ? first[0].toUpperCase() + first.slice(1) : 'Otros');
}

export function brandColor(brand: string, allBrands: string[] = []): string {
  if (BRAND_COLORS[brand]) return BRAND_COLORS[brand];
  const unknown = allBrands.filter(b => !BRAND_COLORS[b]);
  return EXTRA_COLORS[Math.max(0, unknown.indexOf(brand)) % EXTRA_COLORS.length];
}

export function fmt(value: number | null | undefined, digits = 2): string {
  return value == null || !isFinite(value) ? '—' : value.toFixed(digits).replace('.', ',');
}

export function nightLabel(originUtc: number | null): string {
  if (originUtc == null) return 'sin fecha';
  return new Date(originUtc * 1000).toLocaleDateString('es-ES', {
    timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

export function statLines(stats: NightPairStats, unit: string): string[] {
  const lines = [
    `n = ${stats.n}`,
    `r = ${fmt(stats.r)}`,
    `R² = ${fmt(stats.r2)}`,
    `MAE = ${fmt(stats.mae)} ${unit}`,
    `Sesgo = ${fmt(stats.bias)} ${unit}`,
  ];
  if (stats.slope != null && stats.intercept != null) {
    lines.push(`y = ${fmt(stats.slope)}x ${stats.intercept < 0 ? '−' : '+'} ${fmt(Math.abs(stats.intercept))}`);
  }
  return lines;
}

/** Límites y paso «redondos» compartidos por los dos ejes (gráfica cuadrada con identidad). */
export function squareBounds(values: number[]): { min: number; max: number; step: number } {
  const finite = values.filter(v => isFinite(v));
  if (!finite.length) return { min: 0, max: 1, step: 1 };
  let lo = Math.min(...finite), hi = Math.max(...finite);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / 6;
  const step = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200].find(s => s >= raw) ?? 500;
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}

// ── Plugins ───────────────────────────────────────────────────────────────────

interface Rect { x0: number; x1: number; y0: number; y1: number; }
const overlaps = (a: Rect, b: Rect) => !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1);

/** Nombre junto a cada punto, evitando solapes, con una pequeña línea guía hasta el punto. */
export const pointLabelsPlugin: any = {
  id: 'nvPointLabels',
  afterDatasetsDraw(chart: any) {
    const ctx = chart.ctx as CanvasRenderingContext2D;
    const area = chart.chartArea;
    if (!area) return;
    ctx.save();
    ctx.font = '11px "Inter Tight", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'top';
    const pts: { x: number; y: number; text: string; color: string }[] = [];
    chart.data.datasets.forEach((ds: any, i: number) => {
      if (!ds.pointLabels || !chart.isDatasetVisible(i)) return;
      chart.getDatasetMeta(i).data.forEach((p: any, j: number) =>
        pts.push({ x: p.x, y: p.y, text: ds.pointLabels[j], color: ds.backgroundColor }));
    });
    const placed: Rect[] = pts.map(p => ({ x0: p.x - 7, x1: p.x + 7, y0: p.y - 7, y1: p.y + 7 }));
    const h = 11, g = 14;
    [...pts].sort((a, b) => a.y - b.y).forEach(p => {
      const w = ctx.measureText(p.text).width;
      const cands: [number, number][] = [
        [p.x - w / 2, p.y - g - h], [p.x - w / 2, p.y + g], [p.x + g, p.y - h / 2], [p.x - g - w, p.y - h / 2],
        [p.x + g, p.y - g - h], [p.x - g - w, p.y - g - h], [p.x + g, p.y + g], [p.x - g - w, p.y + g],
        [p.x - w / 2, p.y - 2 * g - h], [p.x - w / 2, p.y + 2 * g],
      ];
      let rect: Rect | null = null;
      for (const [x, y] of cands) {
        const r = { x0: x, x1: x + w, y0: y, y1: y + h };
        if (x < area.left - 30 || x + w > area.right + 30 || y < area.top - 16 || y + h > area.bottom + 4) continue;
        if (!placed.some(q => overlaps(r, q))) { rect = r; break; }
      }
      rect ??= { x0: cands[0][0], x1: cands[0][0] + w, y0: cands[0][1], y1: cands[0][1] + h };
      placed.push(rect);
      // Línea guía: del borde del punto al punto más cercano de la etiqueta.
      const ax = Math.min(Math.max(p.x, rect.x0), rect.x1);
      const ay = Math.min(Math.max(p.y, rect.y0 - 1), rect.y1 + 1);
      const dx = ax - p.x, dy = ay - p.y, d = Math.hypot(dx, dy);
      if (d > 8) {
        ctx.strokeStyle = p.color; ctx.lineWidth = 0.9; ctx.globalAlpha = 0.8;
        ctx.beginPath(); ctx.moveTo(p.x + dx / d * 6.5, p.y + dy / d * 6.5); ctx.lineTo(ax, ay); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, rect.x0, rect.y0);
    });
    ctx.restore();
  },
};

/** Recuadro de estadísticos arriba a la izquierda (n, r, R², MAE, sesgo, recta). */
export const statBoxPlugin: any = {
  id: 'nvStatBox',
  afterDraw(chart: any) {
    const lines: string[] | undefined = chart.options?.plugins?.nvStatBox?.lines;
    if (!lines?.length || !chart.chartArea) return;
    const ctx = chart.ctx as CanvasRenderingContext2D, a = chart.chartArea;
    ctx.save();
    ctx.font = '12px "Inter Tight", Helvetica, Arial, sans-serif';
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 12;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(a.left + 18, a.top + 6, w, lines.length * 16 + 8);
    ctx.fillStyle = '#111';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, a.left + 24, a.top + 11 + i * 16));
    ctx.restore();
  },
};

// ── Configuraciones ──────────────────────────────────────────────────────────

const FONT = '"Inter Tight", Helvetica, Arial, sans-serif';
function axis(title: string, extra: any = {}): any {
  const { ticks, ...rest } = extra;
  return {
    title: { display: true, text: title, font: { weight: 'bold', size: 13, family: FONT }, color: '#111' },
    grid: { display: false },
    border: { color: '#111', width: 1.2 },
    ticks: { color: '#222', font: { size: 11, family: FONT }, ...(ticks ?? {}) },
    ...rest,
  };
}

export interface LeaderboardSpec {
  x: (d: NightValidationDevice) => number | null;
  y: (d: NightValidationDevice) => number | null;
  xTitle: string;
  yTitle: string;
  xReverse: boolean;
  yReverse: boolean;
  digits: [number, number];
}

export const LEADERBOARDS: Record<'hr' | 'rmssd' | 'mae' | 'r', LeaderboardSpec & { title: string; subtitle: string }> = {
  hr: {
    title: 'FC nocturna: MAE frente a correlación',
    subtitle: 'Un punto por dispositivo; ventanas de 5 min de todas las noches frente a Polar. Mejor rendimiento arriba a la derecha.',
    x: d => d.hr.mae, y: d => d.hr.r, xTitle: 'FC: MAE / bpm', yTitle: 'FC: correlación / r',
    xReverse: true, yReverse: false, digits: [2, 3],
  },
  rmssd: {
    title: 'HRV nocturna (RMSSD): MAE frente a correlación',
    subtitle: 'Un punto por dispositivo; ventanas de 5 min de todas las noches frente a Polar. Mejor rendimiento arriba a la derecha.',
    x: d => d.rmssd.mae, y: d => d.rmssd.r, xTitle: 'HRV: MAE / ms', yTitle: 'HRV: correlación / r',
    xReverse: true, yReverse: false, digits: [2, 3],
  },
  mae: {
    title: 'FC nocturna MAE frente a HRV MAE',
    subtitle: 'Un punto por dispositivo. Mejor rendimiento arriba a la derecha.',
    x: d => d.hr.mae, y: d => d.rmssd.mae, xTitle: 'FC: MAE / bpm', yTitle: 'HRV: MAE / ms',
    xReverse: true, yReverse: true, digits: [2, 2],
  },
  r: {
    title: 'FC nocturna: correlación frente a HRV: correlación',
    subtitle: 'Un punto por dispositivo. Valores más altos son mejores.',
    x: d => d.hr.r, y: d => d.rmssd.r, xTitle: 'FC: correlación / r', yTitle: 'HRV: correlación / r',
    xReverse: false, yReverse: false, digits: [3, 3],
  },
};

export function leaderboardChart(devices: NightValidationDevice[], spec: LeaderboardSpec): { data: any; options: any } {
  const usable = devices.filter(d => spec.x(d) != null && spec.y(d) != null);
  const brands = [...new Set(usable.map(d => brandOf(d.name)))].sort((a, b) => a.localeCompare(b, 'es'));
  const datasets = brands.map(brand => {
    const list = usable.filter(d => brandOf(d.name) === brand);
    const color = brandColor(brand, brands);
    return {
      label: brand,
      data: list.map(d => ({ x: spec.x(d) as number, y: spec.y(d) as number })),
      pointLabels: list.map(d => d.name),
      backgroundColor: color, borderColor: color, pointRadius: 6, pointHoverRadius: 7,
    };
  });
  return {
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      layout: { padding: { top: 16, right: 12, left: 4 } },
      plugins: {
        legend: { position: 'right', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, color: '#111', font: { size: 11, family: FONT } } },
        tooltip: { callbacks: { label: (t: any) => `${t.dataset.pointLabels[t.dataIndex]}: ${fmt(t.parsed.x, spec.digits[0])} · ${fmt(t.parsed.y, spec.digits[1])}` } },
      },
      scales: {
        x: axis(spec.xTitle, { type: 'linear', reverse: spec.xReverse, grace: '10%' }),
        y: axis(spec.yTitle, { type: 'linear', reverse: spec.yReverse, grace: '10%' }),
      },
    },
  };
}

export function scatterVsReference(pairs: [number, number][], stats: NightPairStats, unit: string, xTitle: string, yTitle: string): { data: any; options: any } {
  const b = squareBounds(pairs.flat());
  const datasets: any[] = [
    { type: 'scatter', label: 'Pares', data: pairs.map(([x, y]) => ({ x, y })), backgroundColor: 'rgba(30,30,30,0.55)', borderColor: 'rgba(0,0,0,0.8)', pointRadius: 3, order: 2 },
    { type: 'line', label: 'Identidad (y = x)', data: [{ x: b.min, y: b.min }, { x: b.max, y: b.max }], borderColor: '#000', borderWidth: 1.2, pointRadius: 0, order: 1 },
  ];
  if (stats.slope != null && stats.intercept != null && pairs.length >= 2) {
    const xs = pairs.map(p => p[0]); const x0 = Math.min(...xs), x1 = Math.max(...xs);
    datasets.push({ type: 'line', label: 'Regresión', data: [{ x: x0, y: stats.slope * x0 + stats.intercept }, { x: x1, y: stats.slope * x1 + stats.intercept }], borderColor: '#2a5bd7', borderWidth: 2, pointRadius: 0, order: 0 });
  }
  const ticks = { stepSize: b.step };
  return {
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false }, nvStatBox: { lines: statLines(stats, unit) } },
      scales: {
        x: axis(xTitle, { type: 'linear', min: b.min, max: b.max, ticks }),
        y: axis(yTitle, { type: 'linear', min: b.min, max: b.max, ticks }),
      },
    },
  };
}

export function kindPairs(summary: NightKindSummary): [number, number][] {
  const out: [number, number][] = [];
  for (const s of summary.series) {
    s.reference.forEach((r, i) => { const d = s.device[i]; if (r != null && d != null) out.push([r, d]); });
  }
  return out;
}

export function nightlyPairs(summary: NightKindSummary): [number, number][] {
  return summary.nightly.points.filter(p => p.reference != null && p.device != null).map(p => [p.reference as number, p.device as number]);
}

export function nightCurve(series: NightSeries, deviceName: string, yTitle: string): { data: any; options: any } {
  const mk = (values: (number | null)[]) => values.map((v, i) => ({ x: series.time[i] / 3600, y: v }));
  const line = (label: string, values: (number | null)[], color: string) => ({
    label, data: mk(values), borderColor: color, backgroundColor: color, pointRadius: 2, borderWidth: 1.3, spanGaps: false,
  });
  return {
    data: { datasets: [line('Polar (referencia)', series.reference, REFERENCE_COLOR), line(deviceName, series.device, DEVICE_COLOR)] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8, color: '#111', font: { size: 11, family: FONT } } } },
      scales: {
        x: axis('Tiempo desde el inicio / h', { type: 'linear', min: 0, ticks: { stepSize: 1 } }),
        y: axis(yTitle, { type: 'linear' }),
      },
    },
  };
}

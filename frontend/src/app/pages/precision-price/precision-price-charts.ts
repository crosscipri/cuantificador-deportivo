/**
 * Gráficas precisión-precio: precio en el eje X (invertido: caro a la izquierda,
 * barato a la derecha) y nota 0-100 en el vertical. Mejor relación arriba a la
 * derecha. Frontera de Pareto, colores de marca y etiquetas con línea guía.
 * Sin tablas ni Bland-Altman.
 */
import type { PrecisionPriceDevice, PrecisionPriceView } from '../../models/precision-price.model';
import { FONT, axis, brandColor, brandOf, fmt } from '../night-validation/night-validation-charts';

/** Eje de precio mínimo; se amplía de 50 en 50 € si algún dispositivo cuesta más (no se recorta ninguno). */
export const PRICE_MAX = 450;

export function priceAxisMax(list: { price: number | null | undefined }[]): number {
  const top = Math.max(0, ...list.map(d => d.price ?? 0));
  return Math.max(PRICE_MAX, Math.ceil((top + 25) / 50) * 50);
}
export const SHORT_LABELS: Record<string, string> = {
  'Garmin Forerunner 170': 'Forerunner 170',
  'Garmin Forerunner 265': 'Forerunner 265',
  'Garmin Forerunner 70': 'Forerunner 70',
  'Garmin Cirqa': 'Cirqa',
  'Huawei Watch Fit 5 Pro': 'Fit 5 Pro',
  'Samsung Galaxy Watch 9': 'Galaxy Watch 9',
  'Samsung Galaxy Watch Ultra 2': 'Ultra 2',
  'Galaxy Watch Ultra 2': 'Ultra 2',
  'Galaxy Watch Ultra': 'Ultra 2',
  'Galaxy Ultra 2': 'Ultra 2',
  'Samsung Ultra 2': 'Ultra 2',
  'Watch Ultra 2': 'Ultra 2',
  'Samsung Galaxy Ultra 2': 'Ultra 2',
  'Galaxy Watch Ultra 2 LTE': 'Ultra 2',
  'Galaxy Watch Ultra (2025)': 'Ultra 2',
  'Fitbit Edge': 'Fitbit Edge',
  'Google Fitbit Edge': 'Fitbit Edge',
  'Fitbit Air': 'Fitbit Air',
  'Realme Watch 5': 'Realme Watch 5',
  'Ultrahuman Ring Air': 'Ring Air',
  'Whoop': 'Whoop',
  'Whoop 5.0': 'Whoop',
  'WHOOP 5.0/MG': 'Whoop',
  'Whoop 5.0/MG': 'Whoop',
};

export const VIEW_COPY: Record<PrecisionPriceView, { title: string; subtitle: string }> = {
  sports: {
    title: 'Deportes: nota de precisión frente al precio',
    subtitle: 'FC de entrenamiento, los 3 deportes juntos. Mejor relación: arriba a la derecha (más barato y más preciso).',
  },
  night: {
    title: 'Noche: nota de precisión frente al precio',
    subtitle: 'Media de la nota de FC en reposo y de la de HRV. Mejor relación: arriba a la derecha (más barato y más preciso).',
  },
  final: {
    title: 'Final: nota combinada frente al precio',
    subtitle: 'Media de deporte y noche, solo si hay ambas. Mejor relación: arriba a la derecha (más barato y más preciso).',
  },
};

export const shortLabel = (name: string) => SHORT_LABELS[name] ?? name;
export const chartLabel = (d: PrecisionPriceDevice) =>
  shortLabel(d.name) + (d.few ? ' ⚠' : '') + (d.frontier ? ' ★' : '');

export function euro(value: number | null | undefined): string {
  return value == null || !isFinite(value) ? 'sin precio' : `${fmt(value, 2)} €`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'long', year: 'numeric' });
}

/** Texto del tooltip: nota, MAE, r, precio, tienda y fecha; ⚠ si hay pocas noches. */
export function tooltipLines(d: PrecisionPriceDevice, view: PrecisionPriceView): string[] {
  const lines = [chartLabel(d)];
  if (d.few) lines.push(view === 'sports' ? '⚠ Pocas sesiones (menos de 5)' : '⚠ Pocas noches (menos de 5)');
  lines.push(`Nota: ${fmt(d.score, 1)}`);
  if (view === 'sports') {
    lines.push(`MAE: ${fmt(d.mae)} lpm · r: ${fmt(d.r, 3)}`);
  } else if (view === 'night') {
    lines.push(`FC en reposo: MAE ${fmt(d.hr_mae)} lpm · r ${fmt(d.hr_r, 3)}`);
    lines.push(`HRV (RMSSD): MAE ${fmt(d.rmssd_mae)} ms · r ${fmt(d.rmssd_r, 3)}`);
  } else {
    lines.push(`Deporte: nota ${fmt(d.sport_score, 1)} · MAE ${fmt(d.sport_mae)} lpm · r ${fmt(d.sport_r, 3)}`);
    lines.push(`Noche: nota ${fmt(d.night_score, 1)} · ${d.night_nights ?? '—'} noches`);
  }
  lines.push(`Precio: ${euro(d.price)}`);
  const shop = [d.shop || d.label, formatDate(d.checked_at)].filter(Boolean).join(' · ');
  if (shop) lines.push(shop);
  if (d.frontier) lines.push('Frontera de Pareto');
  return lines;
}

const overlaps = (a: { x0: number; x1: number; y0: number; y1: number }, b: typeof a) =>
  !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1);

/** Etiquetas siempre dentro del área del gráfico, sin tapar los ejes, con línea guía. */
export const insideLabelsPlugin: any = {
  id: 'ppInsideLabels',
  afterDatasetsDraw(chart: any) {
    const ctx = chart.ctx as CanvasRenderingContext2D;
    const area = chart.chartArea;
    if (!area) return;
    ctx.save();
    ctx.font = `11px ${FONT}`;
    ctx.textBaseline = 'top';
    const pts: { x: number; y: number; text: string; color: string }[] = [];
    chart.data.datasets.forEach((ds: any, i: number) => {
      if (!ds.pointLabels || !chart.isDatasetVisible(i)) return;
      chart.getDatasetMeta(i).data.forEach((p: any, j: number) => {
        if (ds.pointLabels[j]) pts.push({ x: p.x, y: p.y, text: ds.pointLabels[j], color: ds.borderColor || ds.backgroundColor });
      });
    });
    const placed = pts.map(p => ({ x0: p.x - 8, x1: p.x + 8, y0: p.y - 8, y1: p.y + 8 }));
    const h = 12, g = 16, pad = 4;
    [...pts].sort((a, b) => a.y - b.y).forEach(p => {
      const w = ctx.measureText(p.text).width;
      const cands: [number, number][] = [
        [p.x - w / 2, p.y - g - h], [p.x - w / 2, p.y + g],
        [p.x + g, p.y - h / 2], [p.x - g - w, p.y - h / 2],
        [p.x + g, p.y - g - h], [p.x - g - w, p.y - g - h], [p.x + g, p.y + g], [p.x - g - w, p.y + g],
        [p.x - w / 2, p.y - 2 * g - h], [p.x - w / 2, p.y + 2 * g],
        [p.x + 2 * g, p.y - 2 * g - h], [p.x - 2 * g - w, p.y - 2 * g - h],
        [p.x + 2 * g, p.y + 2 * g], [p.x - 2 * g - w, p.y + 2 * g],
        [p.x + 2 * g, p.y - h / 2], [p.x - 2 * g - w, p.y - h / 2],
      ];
      let rect: { x0: number; x1: number; y0: number; y1: number } | null = null;
      for (const [x, y] of cands) {
        const r = { x0: x, x1: x + w, y0: y, y1: y + h };
        if (x < area.left + pad || x + w > area.right - pad || y < area.top + pad || y + h > area.bottom - pad) continue;
        if (!placed.some(q => overlaps(r, q))) { rect = r; break; }
      }
      if (!rect) {
        const x0 = Math.min(Math.max(p.x - w / 2, area.left + pad), area.right - pad - w);
        const y0 = Math.min(Math.max(p.y - g - h, area.top + pad), area.bottom - pad - h);
        rect = { x0, x1: x0 + w, y0, y1: y0 + h };
      }
      placed.push(rect);
      const ax = Math.min(Math.max(p.x, rect.x0), rect.x1);
      const ay = Math.min(Math.max(p.y, rect.y0 - 1), rect.y1 + 1);
      const dx = ax - p.x, dy = ay - p.y, dist = Math.hypot(dx, dy);
      if (dist > 8) {
        ctx.strokeStyle = p.color; ctx.lineWidth = 0.9; ctx.globalAlpha = 0.8;
        ctx.beginPath(); ctx.moveTo(p.x + dx / dist * 6.5, p.y + dy / dist * 6.5); ctx.lineTo(ax, ay); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, rect.x0, rect.y0);
    });
    ctx.restore();
  },
};

/** Pie de gráfica, abajo a la izquierda (no tapa la esquina de mejor compra). */
export const paretoCaptionPlugin: any = {
  id: 'ppParetoCaption',
  afterDraw(chart: any) {
    const text: string | undefined = chart.options?.plugins?.ppParetoCaption?.text;
    if (!text || !chart.chartArea) return;
    const ctx = chart.ctx as CanvasRenderingContext2D, a = chart.chartArea;
    ctx.save();
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = '#444';
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, a.left + 8, a.bottom - 8);
    ctx.restore();
  },
};

export function priceScoreChart(list: PrecisionPriceDevice[], view: PrecisionPriceView): { data: any; options: any } {
  const plotted = list.filter(d => d.price != null && d.score != null);
  const frontier = [...plotted.filter(d => d.frontier)].sort((a, b) => a.price - b.price);
  const brands = [...new Set(plotted.map(d => brandOf(d.name)))].sort((a, b) => a.localeCompare(b, 'es'));
  const datasets: any[] = [];
  if (frontier.length >= 2) {
    datasets.push({
      type: 'line', label: 'Frontera de Pareto',
      data: frontier.map(d => ({ x: d.price, y: d.score })),
      borderColor: '#333', borderWidth: 1.5, borderDash: [5, 4],
      pointRadius: 0, pointHoverRadius: 0, order: 0, tension: 0,
      pointLabels: frontier.map(() => ''),
    });
  }
  brands.forEach(brand => {
    const items = plotted.filter(d => brandOf(d.name) === brand);
    const color = brandColor(brand, brands);
    datasets.push({
      type: 'scatter', label: brand,
      data: items.map(d => ({ x: d.price, y: d.score })),
      pointLabels: items.map(chartLabel),
      items,
      backgroundColor: color, borderColor: color,
      pointRadius: items.map(d => d.frontier ? 8 : 6.5),
      pointHoverRadius: 9,
      pointStyle: items.map(d => d.frontier ? 'rectRot' : 'circle'),
      order: 1,
    });
  });
  const caption = frontier.length === 1
    ? '★ Único en la frontera de Pareto: no hay otro más barato y más preciso a la vez'
    : 'Línea discontinua y ★: frontera de Pareto (nadie más barato y más preciso a la vez)';
  return {
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      layout: { padding: { top: 8, right: 8, bottom: 4, left: 4 } },
      plugins: {
        ppParetoCaption: { text: caption },
        legend: {
          position: 'right',
          labels: {
            usePointStyle: true, pointStyle: 'circle', boxWidth: 8, color: '#111',
            font: { size: 11, family: FONT },
            filter: (item: any) => item.text !== 'Frontera de Pareto',
          },
        },
        tooltip: {
          callbacks: {
            title: () => '',
            label: (t: any) => {
              const d: PrecisionPriceDevice | undefined = t.dataset.items?.[t.dataIndex];
              return d ? tooltipLines(d, view) : '';
            },
          },
        },
      },
      scales: {
        x: axis('Precio (€)  ← más caro  ·  más barato →', {
          type: 'linear', min: 0, max: priceAxisMax(plotted), reverse: true, ticks: { stepSize: 50 },
        }),
        y: axis('Nota de precisión / 0–100', { type: 'linear', min: 0, max: 100, ticks: { stepSize: 10 } }),
      },
    },
  };
}

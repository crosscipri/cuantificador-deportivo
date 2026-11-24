/**
 * Gráficas de validación por deporte (FC de entrenamiento frente a Polar H10),
 * con el mismo estilo que la validación nocturna. Solo r de Pearson; sin límites
 * de acuerdo ni Bland-Altman.
 */
import type { SportKey, SportValidationDevice, SportViewKey } from '../../models/sport-validation.model';
import { FONT, axis, brandColor, brandOf, fmt, squareBounds, statLines } from '../night-validation/night-validation-charts';

export const FEW_SESSIONS = 5;
export const SPORTS: SportKey[] = ['running', 'gym', 'cycling'];
export const SPORT_LABELS: Record<SportViewKey, string> = {
  running: 'Carrera', gym: 'Fuerza', cycling: 'Ciclismo', combined: 'Los 3 deportes combinados',
};
export const HEAD_FACTOR = 2;

export const fewSessions = (d: SportValidationDevice) => d.sessions < FEW_SESSIONS;
export const withStats = (list: SportValidationDevice[]) => list.filter(d => d.mae != null && d.r != null);

export function byMae(list: SportValidationDevice[]): SportValidationDevice[] {
  return [...withStats(list)].sort((a, b) => (a.mae as number) - (b.mae as number) || a.name.localeCompare(b.name, 'es'));
}

/** Mediana de los MAE (con número par, el valor superior del centro, como en la maqueta). */
export function medianMae(list: SportValidationDevice[]): number | null {
  const v = withStats(list).map(d => d.mae as number).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

/** Grupo de cabeza: MAE ≤ 2 × la mediana. */
export function headGroup(list: SportValidationDevice[]): { limit: number | null; devices: SportValidationDevice[] } {
  const med = medianMae(list);
  if (med == null) return { limit: null, devices: [] };
  const limit = HEAD_FACTOR * med;
  return { limit, devices: byMae(list).filter(d => (d.mae as number) <= limit) };
}

const label = (d: SportValidationDevice) => d.name + (fewSessions(d) ? ' ⚠' : '');

/** Recuadro discontinuo alrededor de los puntos sin etiqueta («ver detalle»). */
export const clusterBoxPlugin: any = {
  id: 'svClusterBox',
  afterDatasetsDraw(chart: any) {
    const opts = chart.options?.plugins?.svClusterBox;
    if (!opts?.enabled || !chart.chartArea) return;
    const xs: number[] = [], ys: number[] = [];
    chart.data.datasets.forEach((ds: any, i: number) => chart.getDatasetMeta(i).data.forEach((p: any, j: number) => {
      if (ds.pointLabels && !ds.pointLabels[j]) { xs.push(p.x); ys.push(p.y); }
    }));
    if (!xs.length) return;
    const ctx = chart.ctx as CanvasRenderingContext2D, pad = 12;
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    ctx.save();
    ctx.setLineDash([4, 3]); ctx.strokeStyle = '#666'; ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
    ctx.font = `11px ${FONT}`; ctx.fillStyle = '#444'; ctx.textBaseline = 'top';
    const text = `${xs.length} dispositivos · ver detalle →`, w = ctx.measureText(text).width;
    ctx.fillText(text, Math.max(chart.chartArea.left, Math.min(x1 - w, chart.chartArea.right - w)), y1 + 4);
    ctx.restore();
  },
};

/**
 * MAE (eje invertido) frente a r, un punto por dispositivo y un dataset por marca.
 * Los dispositivos de ``unlabeled`` se dibujan sin nombre dentro de un recuadro.
 */
export function sportLeaderboard(list: SportValidationDevice[], unlabeled: Set<string> = new Set()): { data: any; options: any } {
  const usable = withStats(list);
  const brands = [...new Set(usable.map(d => brandOf(d.name)))].sort((a, b) => a.localeCompare(b, 'es'));
  const datasets = brands.map(brand => {
    const items = usable.filter(d => brandOf(d.name) === brand);
    const color = brandColor(brand, brands);
    return {
      label: brand,
      data: items.map(d => ({ x: d.mae as number, y: d.r as number })),
      pointLabels: items.map(d => unlabeled.has(d.device_id) ? '' : label(d)),
      names: items.map(d => d.name),
      backgroundColor: color, borderColor: color, pointRadius: 6.5, pointHoverRadius: 7,
    };
  });
  return {
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      layout: { padding: { top: 16, right: 12, left: 4 } },
      plugins: {
        svClusterBox: { enabled: unlabeled.size > 0 },
        legend: { position: 'right', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, color: '#111', font: { size: 11, family: FONT } } },
        tooltip: { callbacks: { label: (t: any) => `${t.dataset.names[t.dataIndex]}: MAE ${fmt(t.parsed.x)} bpm · r ${fmt(t.parsed.y, 3)}` } },
      },
      scales: {
        x: axis('FC: MAE / bpm', { type: 'linear', reverse: true, grace: '10%' }),
        y: axis('FC: correlación / r', { type: 'linear', grace: '6%', max: 1 }),
      },
    },
  };
}

/** Todos los dispositivos (grupo de cabeza sin nombre, en un recuadro) + detalle del grupo de cabeza. */
export function sportLeaderboards(list: SportValidationDevice[]) {
  const head = headGroup(list);
  const all = withStats(list);
  const zoomUseful = head.devices.length >= 2 && head.devices.length < all.length;
  const unlabeled = zoomUseful ? new Set(head.devices.map(d => d.device_id)) : new Set<string>();
  return {
    limit: head.limit,
    head: head.devices,
    all: sportLeaderboard(all, unlabeled),
    zoom: zoomUseful ? sportLeaderboard(head.devices) : null,
  };
}

/** Dispositivo frente a Polar H10, segundo a segundo, con identidad, regresión y recuadro. */
export function sportScatter(d: SportValidationDevice): { data: any; options: any } {
  const pts = d.sample;
  const b = squareBounds(pts.flat());
  const datasets: any[] = [
    { type: 'scatter', label: 'Pares', data: pts.map(([x, y]) => ({ x, y })), backgroundColor: 'rgba(30,30,30,0.18)', borderWidth: 0, pointRadius: 1.6, order: 2 },
    { type: 'line', label: 'Identidad (y = x)', data: [{ x: b.min, y: b.min }, { x: b.max, y: b.max }], borderColor: '#000', borderWidth: 1.2, pointRadius: 0, order: 1 },
  ];
  if (d.slope != null && d.intercept != null && pts.length >= 2) {
    const xs = pts.map(p => p[0]); const x0 = Math.min(...xs), x1 = Math.max(...xs);
    datasets.push({ type: 'line', label: 'Regresión', data: [{ x: x0, y: d.slope * x0 + d.intercept }, { x: x1, y: d.slope * x1 + d.intercept }], borderColor: '#2a5bd7', borderWidth: 2.2, pointRadius: 0, order: 0 });
  }
  // Mismo recuadro que la validación nocturna, con r, R² y pendiente a 3 decimales (con miles de pares, 2 se quedan cortos).
  const lines = statLines(d, 'bpm');
  lines[0] = `n = ${d.n.toLocaleString('es-ES')} pares (${d.sessions} sesiones)`;
  lines[1] = `r = ${fmt(d.r, 3)}`;
  lines[2] = `R² = ${fmt(d.r2, 3)}`;
  if (d.slope != null && d.intercept != null) {
    lines[5] = `y = ${fmt(d.slope, 3)}x ${d.intercept < 0 ? '−' : '+'} ${fmt(Math.abs(d.intercept), 2)}`;
  }
  const ticks = { stepSize: b.step };
  return {
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false }, nvStatBox: { lines } },
      scales: {
        x: axis('Polar H10: FC / bpm', { type: 'linear', min: b.min, max: b.max, ticks }),
        y: axis(`${d.name}: FC / bpm`, { type: 'linear', min: b.min, max: b.max, ticks }),
      },
    },
  };
}

/** «C 9 · F 9 · Ci 6» para la tabla combinada. */
export function sessionsBreakdown(d: SportValidationDevice): string {
  const by = d.sessions_by_sport ?? {};
  const short: Record<SportKey, string> = { running: 'Carrera', gym: 'Fuerza', cycling: 'Ciclismo' };
  return SPORTS.filter(s => by[s]).map(s => `${short[s]} ${by[s]}`).join(' · ');
}

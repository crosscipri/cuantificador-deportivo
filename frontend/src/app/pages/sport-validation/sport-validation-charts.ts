/**
 * Gráficas de validación por deporte (FC de entrenamiento frente a Polar H10),
 * con el mismo estilo que la validación nocturna. Solo r de Pearson; sin límites
 * de acuerdo ni Bland-Altman.
 */
import type { SportKey, SportSessionPoint, SportSessionSeries, SportValidationDevice, SportViewKey } from '../../models/sport-validation.model';
import {
  DEVICE_COLOR, FONT, REFERENCE_COLOR, axis, brandColor, brandOf, fmt, scatterVsReference, squareBounds, statLines,
} from '../night-validation/night-validation-charts';

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

/** MAE (eje invertido) frente a r: un punto por dispositivo, un dataset por marca y el nombre de todos. */
export function sportLeaderboard(list: SportValidationDevice[]): { data: any; options: any } {
  const usable = withStats(list);
  const brands = [...new Set(usable.map(d => brandOf(d.name)))].sort((a, b) => a.localeCompare(b, 'es'));
  const datasets = brands.map(brand => {
    const items = usable.filter(d => brandOf(d.name) === brand);
    const color = brandColor(brand, brands);
    return {
      label: brand,
      data: items.map(d => ({ x: d.mae as number, y: d.r as number })),
      pointLabels: items.map(label),
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
        nvPointLabels: { inside: true },
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

/**
 * Gráfica de todos los dispositivos (con todos los nombres, sin recuadro) y, si hace falta,
 * un zoom del grupo de cabeza (MAE ≤ 2 × la mediana), también con todos sus nombres.
 */
export function sportLeaderboards(list: SportValidationDevice[]) {
  const head = headGroup(list);
  const all = withStats(list);
  const zoomUseful = head.devices.length >= 2 && head.devices.length < all.length;
  return {
    limit: head.limit,
    head: head.devices,
    all: sportLeaderboard(all),
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

/** «06/06/2026» en hora de Madrid; sin fecha si no hay. */
export function sessionDate(date: string | null): string {
  if (!date) return 'sin fecha';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(date) ? date : `${date}Z`);
  if (isNaN(d.getTime())) return 'sin fecha';
  return d.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function sessionLabel(s: { date: string | null; name: string }): string {
  return `${sessionDate(s.date)} · ${s.name}`;
}

/** Medias por sesión (un punto por sesión) frente a Polar H10, como las medias por noche. */
export function sessionMeansChart(d: SportValidationDevice): { data: any; options: any } | null {
  const m = d.session_means;
  if (!m || !m.points.length) return null;
  const pairs = m.points.map((p: SportSessionPoint) => [p.reference, p.device] as [number, number]);
  const chart = scatterVsReference(pairs, m, 'bpm', 'Polar H10: FC media de la sesión / bpm', `${d.name}: FC media / bpm`);
  // r y R² a 3 decimales: con medias de sesión casi perfectas, 2 decimales muestran «1,00».
  const lines: string[] = chart.options.plugins.nvStatBox.lines;
  lines[1] = `r = ${fmt(m.r, 3)}`;
  lines[2] = `R² = ${fmt(m.r2, 3)}`;
  return chart;
}

/** Curva de la sesión: Polar en rojo, dispositivo en turquesa, eje X en minutos. */
export function sessionCurve(series: SportSessionSeries, deviceName: string): { data: any; options: any } {
  const mk = (values: (number | null)[]) => values.map((v, i) => ({ x: series.time[i] / 60, y: v }));
  const line = (label: string, values: (number | null)[], color: string) => ({
    label, data: mk(values), borderColor: color, backgroundColor: color, pointRadius: 0, borderWidth: 1.4, spanGaps: false,
  });
  return {
    data: { datasets: [line('Polar H10 (referencia)', series.reference, REFERENCE_COLOR), line(deviceName, series.device, DEVICE_COLOR)] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8, color: '#111', font: { size: 11, family: FONT } } } },
      scales: {
        x: axis('Tiempo desde el inicio / min', { type: 'linear', min: 0 }),
        y: axis('Frecuencia cardiaca / bpm', { type: 'linear' }),
      },
    },
  };
}

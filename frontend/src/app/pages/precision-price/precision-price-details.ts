/**
 * Gráficas por dispositivo bajo cada comparativa de precisión-precio: correlación
 * (dispositivo frente a Polar) y FC frente a la Polar. Reutiliza los constructores de
 * sport-validation y night-validation; no calcula nada nuevo (solo r de Pearson, sin
 * Bland-Altman ni límites de acuerdo).
 */
import type { PrecisionPriceDevice, PrecisionPriceView } from '../../models/precision-price.model';
import type { SportKey, SportValidationDevice, SportValidationResponse } from '../../models/sport-validation.model';
import type { NightKindSummary, NightValidationDevice, NightValidationResponse } from '../../models/night-validation.model';
import { FEW_NIGHTS, UNITS, kindPairs, nightCurve, nightLabel, scatterVsReference, type NightKind } from '../night-validation/night-validation-charts';
import { SPORTS, SPORT_LABELS, fewSessions, sessionCurve, sessionLabel, sportScatter } from '../sport-validation/sport-validation-charts';
import { shortLabel } from './precision-price-charts';

export type DetailKey = 'sport-corr' | 'sport-curve' | 'night-hr-corr' | 'night-hrv-corr' | 'night-hr-curve';
export type ChartCfg = { data: any; options: any };

export const SCATTER_POINTS_MAX = 1500;

export const DETAIL_GRIDS: Record<PrecisionPriceView, DetailKey[]> = {
  sports: ['sport-corr', 'sport-curve'],
  night: ['night-hr-corr', 'night-hrv-corr', 'night-hr-curve'],
  final: ['sport-corr', 'night-hr-corr', 'sport-curve', 'night-hr-curve'],
};

export const DETAIL_COPY: Record<DetailKey, { title: string; note: string; kind: 'corr' | 'curve' }> = {
  'sport-corr': {
    kind: 'corr',
    title: 'Correlación frente a la Polar H10 (deporte)',
    note: 'FC segundo a segundo de los 3 deportes juntos. Línea negra: y = x; línea azul: regresión. Muestra reducida para que la página vaya ligera.',
  },
  'sport-curve': {
    kind: 'curve',
    title: 'FC frente a la Polar H10 (una sesión)',
    note: 'Polar H10 en rojo y el dispositivo en turquesa. Elige la sesión en cada tarjeta; por defecto, la más larga de carrera.',
  },
  'night-hr-corr': {
    kind: 'corr',
    title: 'Correlación frente a la Polar: FC nocturna',
    note: 'Ventanas de 5 min de todas las noches.',
  },
  'night-hrv-corr': {
    kind: 'corr',
    title: 'Correlación frente a la Polar: HRV (RMSSD) nocturna',
    note: 'Ventanas de 5 min de todas las noches.',
  },
  'night-hr-curve': {
    kind: 'curve',
    title: 'FC nocturna frente a la Polar (una noche)',
    note: 'Polar en rojo y el dispositivo en turquesa. Elige la noche en cada tarjeta; por defecto, la que tiene más ventanas.',
  },
};

export interface CurveSource { label: string; weight: number; build: () => ChartCfg; }

export interface DetailCard {
  deviceId: string;
  name: string;
  subtitle: string;
  /** «⚠ pocas» (menos de 5 sesiones o noches). */
  few: boolean;
  chart: ChartCfg | null;
  sources?: CurveSource[];
  index?: number;
}

export interface DetailGrid { key: DetailKey; title: string; note: string; kind: 'corr' | 'curve'; cards: DetailCard[]; }

/** Muestra regular de como mucho ``max`` elementos. */
export function decimate<T>(list: T[], max = SCATTER_POINTS_MAX): T[] {
  if (list.length <= max) return list;
  const step = Math.ceil(list.length / max);
  return list.filter((_, i) => i % step === 0).slice(0, max);
}

/** Curvas compactas: leyenda debajo para dejar todo el ancho al gráfico. */
export function compactCurve(cfg: ChartCfg): ChartCfg {
  const legend = cfg.options.plugins.legend;
  legend.position = 'bottom';
  legend.labels = { ...legend.labels, font: { ...legend.labels.font, size: 10 }, padding: 8 };
  return cfg;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function sportDeviceById(res: SportValidationResponse | null, sport: 'combined' | SportKey, id: string): SportValidationDevice | undefined {
  return res?.sports?.[sport]?.find(d => d.device_id === id);
}

export function sportCorrelationCards(devices: PrecisionPriceDevice[], res: SportValidationResponse | null): DetailCard[] {
  const out: DetailCard[] = [];
  for (const dev of devices) {
    const d = sportDeviceById(res, 'combined', dev.device_id);
    if (!d || !d.sample?.length) continue;
    const shown: SportValidationDevice = { ...d, name: shortLabel(d.name), sample: decimate(d.sample) };
    out.push({
      deviceId: dev.device_id, name: dev.name,
      subtitle: plural(d.sessions, 'sesión', 'sesiones'),
      few: fewSessions(d), chart: sportScatter(shown),
    });
  }
  return out;
}

export function sportCurveCards(devices: PrecisionPriceDevice[], res: SportValidationResponse | null): DetailCard[] {
  const out: DetailCard[] = [];
  for (const dev of devices) {
    const sources: CurveSource[] = [];
    for (const sport of SPORTS) {
      const d = sportDeviceById(res, sport, dev.device_id);
      for (const series of d?.series ?? []) {
        const pts = series.time.length;
        sources.push({
          label: `${SPORT_LABELS[sport]} · ${sessionLabel(series)}`,
          weight: (sport === 'running' ? 1e6 : 0) + pts,
          build: () => compactCurve(sessionCurve(series, shortLabel(dev.name))),
        });
      }
    }
    if (!sources.length) continue;
    const comb = sportDeviceById(res, 'combined', dev.device_id);
    out.push(curveCard(dev, sources, comb ? fewSessions(comb) : false, plural(comb?.sessions ?? sources.length, 'sesión', 'sesiones')));
  }
  return out;
}

function nightDeviceById(res: NightValidationResponse | null, id: string): NightValidationDevice | undefined {
  return res?.devices?.find(d => d.device_id === id);
}

const NIGHT_AXIS: Record<NightKind, string> = { hr: 'FC', rmssd: 'RMSSD' };

export function nightCorrelationCards(devices: PrecisionPriceDevice[], res: NightValidationResponse | null, kind: NightKind): DetailCard[] {
  const out: DetailCard[] = [];
  const unit = UNITS[kind];
  for (const dev of devices) {
    const d = nightDeviceById(res, dev.device_id);
    const s: NightKindSummary | undefined = d?.[kind];
    if (!d || !s || s.n <= 0) continue;
    const pairs = decimate(kindPairs(s));
    out.push({
      deviceId: dev.device_id, name: dev.name,
      subtitle: `${plural(s.nights, 'noche', 'noches')} · ventanas de 5 min`,
      few: s.nights < FEW_NIGHTS,
      chart: scatterVsReference(pairs, s, unit, `Polar: ${NIGHT_AXIS[kind]} / ${unit}`, `${shortLabel(d.name)}: ${NIGHT_AXIS[kind]} / ${unit}`),
    });
  }
  return out;
}

export function nightCurveCards(devices: PrecisionPriceDevice[], res: NightValidationResponse | null): DetailCard[] {
  const out: DetailCard[] = [];
  for (const dev of devices) {
    const d = nightDeviceById(res, dev.device_id);
    const series = d?.hr?.series ?? [];
    if (!d || !series.length) continue;
    const sources: CurveSource[] = series.map((s, i) => ({
      label: `Noche ${i + 1} · ${nightLabel(s.origin_utc)}`,
      weight: s.windows,
      build: () => compactCurve(nightCurve(s, shortLabel(d.name), 'Frecuencia cardiaca / bpm')),
    }));
    out.push(curveCard(dev, sources, d.hr.nights < FEW_NIGHTS, plural(d.hr.nights, 'noche', 'noches')));
  }
  return out;
}

function curveCard(dev: PrecisionPriceDevice, sources: CurveSource[], few: boolean, subtitle: string): DetailCard {
  let best = 0;
  sources.forEach((s, i) => { if (s.weight > sources[best].weight) best = i; });
  return { deviceId: dev.device_id, name: dev.name, subtitle, few, sources, index: best, chart: sources[best].build() };
}

export function selectSource(card: DetailCard, index: number | string): void {
  const i = Number(index);
  if (!card.sources?.[i]) return;
  card.index = i;
  card.chart = card.sources[i].build();
}

export function buildDetailGrids(
  view: PrecisionPriceView, devices: PrecisionPriceDevice[],
  sport: SportValidationResponse | null, night: NightValidationResponse | null,
): DetailGrid[] {
  const make = (key: DetailKey): DetailCard[] => {
    switch (key) {
      case 'sport-corr': return sportCorrelationCards(devices, sport);
      case 'sport-curve': return sportCurveCards(devices, sport);
      case 'night-hr-corr': return nightCorrelationCards(devices, night, 'hr');
      case 'night-hrv-corr': return nightCorrelationCards(devices, night, 'rmssd');
      case 'night-hr-curve': return nightCurveCards(devices, night);
    }
  };
  return DETAIL_GRIDS[view].map(key => ({ key, ...DETAIL_COPY[key], cards: make(key) })).filter(g => g.cards.length);
}

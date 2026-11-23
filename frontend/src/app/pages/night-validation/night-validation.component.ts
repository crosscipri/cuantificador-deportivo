import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { BaseChartDirective } from 'ng2-charts';
import { ApiService } from '../../services/api.service';
import { NightValidationDevice, NightValidationResponse } from '../../models/night-validation.model';
import {
  FEW_NIGHTS, LEADERBOARDS, NightKind, UNITS, kindPairs, leaderboardChart, nightCurve, nightLabel,
  nightlyPairs, pointLabelsPlugin, scatterVsReference, statBoxPlugin,
} from './night-validation-charts';

interface ChartCard { title: string; subtitle: string; warn?: string; data: any; options: any; }
interface CurveCard { device: NightValidationDevice; kind: NightKind; index: number; nights: string[]; chart: ChartCard | null; }

const KIND_LABEL: Record<NightKind, string> = { hr: 'FC', rmssd: 'HRV (RMSSD)' };
const AXIS_LABEL: Record<NightKind, string> = { hr: 'FC', rmssd: 'RMSSD' };

@Component({
  selector: 'app-night-validation',
  standalone: true,
  imports: [CommonModule, RouterLink, BaseChartDirective],
  templateUrl: './night-validation.component.html',
  styleUrls: ['./night-validation.component.scss'],
})
export class NightValidationComponent implements OnInit {
  loading = true;
  error = '';
  response: NightValidationResponse | null = null;
  readonly kinds: NightKind[] = ['hr', 'rmssd'];
  readonly kindLabel = KIND_LABEL;
  readonly labelPlugins = [pointLabelsPlugin];
  readonly statPlugins = [statBoxPlugin];

  leaderboards: (ChartCard & { rob: string })[] = [];
  scatters: Record<NightKind, ChartCard[]> = { hr: [], rmssd: [] };
  nightly: Record<NightKind, ChartCard[]> = { hr: [], rmssd: [] };
  curves: Record<NightKind, CurveCard[]> = { hr: [], rmssd: [] };

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.api.getNightValidation().subscribe({
      next: res => { this.response = res; this.build(res.devices); this.loading = false; },
      error: err => {
        this.error = err?.status === 401 ? 'Necesitas iniciar sesión para ver los datos.' : 'No se han podido cargar las noches guardadas.';
        this.loading = false;
      },
    });
  }

  get devices(): NightValidationDevice[] { return this.response?.devices ?? []; }

  private build(devices: NightValidationDevice[]): void {
    const rob: Record<string, string> = { hr: '0:55', rmssd: '9:40', mae: '17:53', r: '15:20' };
    this.leaderboards = (Object.keys(LEADERBOARDS) as (keyof typeof LEADERBOARDS)[]).map(key => {
      const spec = LEADERBOARDS[key];
      return { title: spec.title, subtitle: spec.subtitle, rob: rob[key], ...leaderboardChart(devices, spec) };
    });
    for (const kind of this.kinds) {
      const unit = UNITS[kind];
      this.scatters[kind] = devices.filter(d => d[kind].n > 0).map(d => {
        const s = d[kind];
        const coverage = kind === 'rmssd' && s.coverage != null ? ` · ${Math.round(s.coverage * 100)} % de ventanas con dato` : '';
        return {
          title: `${d.name}: ${AXIS_LABEL[kind] === 'FC' ? 'FC' : 'HRV'} frente a Polar`,
          subtitle: `ventanas de 5 min · ${s.nights} noche${s.nights === 1 ? '' : 's'}${coverage}`,
          ...scatterVsReference(kindPairs(s), s, unit, `Polar: ${AXIS_LABEL[kind]} / ${unit} (ventana 5 min)`, `${d.name}: ${AXIS_LABEL[kind]} / ${unit}`),
        };
      });
      this.nightly[kind] = devices.filter(d => d[kind].nightly.points.length > 0).map(d => {
        const s = d[kind];
        return {
          title: `${d.name}: medias por noche de ${KIND_LABEL[kind]}`,
          subtitle: `${s.nights} noche${s.nights === 1 ? '' : 's'}`,
          warn: s.nights < FEW_NIGHTS ? 'pocas noches' : undefined,
          ...scatterVsReference(nightlyPairs(s), s.nightly, unit, `Polar: media nocturna / ${unit}`, `${d.name}: media nocturna / ${unit}`),
        };
      });
      this.curves[kind] = devices.filter(d => d[kind].series.length > 0).map(d => {
        const card: CurveCard = { device: d, kind, index: 0, nights: d[kind].series.map(s => nightLabel(s.origin_utc)), chart: null };
        this.renderCurve(card);
        return card;
      });
    }
  }

  selectNight(card: CurveCard, index: string | number): void {
    card.index = Number(index);
    this.renderCurve(card);
  }

  private renderCurve(card: CurveCard): void {
    const series = card.device[card.kind].series[card.index];
    const yTitle = card.kind === 'hr' ? 'Frecuencia cardiaca / bpm' : 'RMSSD / ms';
    card.chart = {
      title: `${card.device.name}: ${AXIS_LABEL[card.kind]} en ventanas de 5 min frente a Polar`,
      subtitle: `noche del ${card.nights[card.index]}`,
      ...nightCurve(series, card.device.name, yTitle),
    };
  }

  trackByTitle(_: number, c: { title: string }): string { return c.title; }
}

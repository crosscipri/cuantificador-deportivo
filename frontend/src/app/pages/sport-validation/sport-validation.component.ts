import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { BaseChartDirective } from 'ng2-charts';
import { ApiService } from '../../services/api.service';
import { SportKey, SportValidationDevice, SportValidationResponse } from '../../models/sport-validation.model';
import { fmt, pointLabelsPlugin, statBoxPlugin } from '../night-validation/night-validation-charts';
import {
  FEW_SESSIONS, SPORTS, SPORT_LABELS, byMae, fewSessions, sessionCurve, sessionLabel, sessionMeansChart,
  sessionsBreakdown, sportLeaderboard, sportScatter,
} from './sport-validation-charts';

interface Chart { data: any; options: any; }
/** Tarjeta por dispositivo (dispersión o medias por sesión). */
interface DeviceCard { device: SportValidationDevice; title: string; subtitle: string; few: boolean; chart: Chart; }
/** Curva de una sesión con selector de sesión, como la curva de la noche. */
interface CurveCard { device: SportValidationDevice; index: number; sessions: string[]; few: boolean; chart: Chart | null; }

@Component({
  selector: 'app-sport-validation',
  standalone: true,
  imports: [CommonModule, RouterLink, BaseChartDirective],
  templateUrl: './sport-validation.component.html',
  styleUrls: ['../night-validation/night-validation.component.scss', './sport-validation.component.scss'],
})
export class SportValidationComponent implements OnInit {
  loading = true;
  error = '';
  response: SportValidationResponse | null = null;

  readonly sports = SPORTS;
  readonly labels = SPORT_LABELS;
  readonly fewLimit = FEW_SESSIONS;
  readonly labelPlugins = [pointLabelsPlugin];
  readonly statPlugins = [statBoxPlugin];
  readonly fmt = fmt;
  readonly isFew = fewSessions;
  readonly breakdown = sessionsBreakdown;

  sport: SportKey = 'running';
  ranking: SportValidationDevice[] = [];
  board: Chart | null = null;
  scatters: DeviceCard[] = [];
  means: DeviceCard[] = [];
  curves: CurveCard[] = [];

  combinedRanking: SportValidationDevice[] = [];
  combinedBoard: Chart | null = null;
  combinedScatters: DeviceCard[] = [];
  combinedMeans: DeviceCard[] = [];

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.api.getSportValidation().subscribe({
      next: res => {
        this.response = res;
        this.combinedRanking = byMae(res.sports.combined ?? []);
        this.combinedBoard = this.combinedRanking.length ? sportLeaderboard(this.combinedRanking) : null;
        this.combinedScatters = this.scatterCards(this.combinedRanking, SPORT_LABELS.combined);
        this.combinedMeans = this.meanCards(this.combinedRanking, SPORT_LABELS.combined);
        this.selectSport(this.sport);
        this.loading = false;
      },
      error: err => {
        this.error = err?.status === 401 ? 'Necesitas iniciar sesión para ver los datos.' : 'No se han podido cargar las sesiones guardadas.';
        this.loading = false;
      },
    });
  }

  get hasData(): boolean { return !!this.response && SPORTS.some(s => (this.response!.sports[s] ?? []).length); }
  get few(): SportValidationDevice[] { return this.ranking.filter(fewSessions); }
  get combinedFew(): SportValidationDevice[] { return this.combinedRanking.filter(fewSessions); }
  count(sport: SportKey): number { return (this.response?.sports[sport] ?? []).length; }

  selectSport(sport: SportKey): void {
    this.sport = sport;
    const list = this.response?.sports[sport] ?? [];
    this.ranking = byMae(list);
    this.board = this.ranking.length ? sportLeaderboard(this.ranking) : null;
    const label = SPORT_LABELS[sport];
    this.scatters = this.scatterCards(this.ranking, label);
    this.means = this.meanCards(this.ranking, label);
    this.curves = this.ranking.filter(d => d.series?.length).map(d => {
      const card: CurveCard = { device: d, index: 0, sessions: d.series!.map(sessionLabel), few: fewSessions(d), chart: null };
      this.renderCurve(card);
      return card;
    });
  }

  selectSession(card: CurveCard, index: string | number): void {
    card.index = Number(index);
    this.renderCurve(card);
  }

  private renderCurve(card: CurveCard): void {
    const series = card.device.series?.[card.index];
    card.chart = series ? sessionCurve(series, card.device.name) : null;
  }

  private scatterCards(list: SportValidationDevice[], label: string): DeviceCard[] {
    return list.filter(d => d.sample.length).map(d => ({
      device: d, few: fewSessions(d),
      title: `${d.name}: FC frente a Polar H10 · ${label}`,
      subtitle: `segundo a segundo · ${d.sessions} sesion${d.sessions === 1 ? '' : 'es'}`,
      chart: sportScatter(d),
    }));
  }

  private meanCards(list: SportValidationDevice[], label: string): DeviceCard[] {
    return list.map(d => ({ d, chart: sessionMeansChart(d) })).filter(x => x.chart).map(({ d, chart }) => ({
      device: d, few: fewSessions(d), chart: chart as Chart,
      title: `${d.name}: medias por sesión · ${label}`,
      subtitle: `${d.session_means!.points.length} sesion${d.session_means!.points.length === 1 ? '' : 'es'}`,
    }));
  }

  fewText(list: SportValidationDevice[]): string { return list.map(d => `${d.name} (${d.sessions})`).join(', '); }
  trackById(_: number, d: SportValidationDevice): string { return d.device_id; }
  trackByCard(_: number, c: { device: SportValidationDevice }): string { return c.device.device_id; }
}

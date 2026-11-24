import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { BaseChartDirective } from 'ng2-charts';
import { ApiService } from '../../services/api.service';
import { SportKey, SportValidationDevice, SportValidationResponse } from '../../models/sport-validation.model';
import { fmt, pointLabelsPlugin, statBoxPlugin } from '../night-validation/night-validation-charts';
import {
  FEW_SESSIONS, SPORTS, SPORT_LABELS, byMae, fewSessions, sessionsBreakdown, sportLeaderboard, sportScatter,
} from './sport-validation-charts';

interface Chart { data: any; options: any; }

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
  deviceId = '';
  scatter: Chart | null = null;

  combinedRanking: SportValidationDevice[] = [];
  combinedBoard: Chart | null = null;

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.api.getSportValidation().subscribe({
      next: res => {
        this.response = res;
        this.combinedRanking = byMae(res.sports.combined ?? []);
        this.combinedBoard = this.combinedRanking.length ? sportLeaderboard(this.combinedRanking) : null;
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
  get selected(): SportValidationDevice | undefined { return this.ranking.find(d => d.device_id === this.deviceId); }
  count(sport: SportKey): number { return (this.response?.sports[sport] ?? []).length; }

  selectSport(sport: SportKey): void {
    this.sport = sport;
    const list = this.response?.sports[sport] ?? [];
    this.ranking = byMae(list);
    this.board = this.ranking.length ? sportLeaderboard(this.ranking) : null;
    const keep = this.ranking.find(d => d.device_id === this.deviceId);
    this.selectDevice(keep ? keep.device_id : this.ranking[0]?.device_id ?? '');
  }

  selectDevice(deviceId: string): void {
    this.deviceId = deviceId;
    const d = this.selected;
    this.scatter = d && d.sample.length ? sportScatter(d) : null;
  }

  fewText(list: SportValidationDevice[]): string { return list.map(d => `${d.name} (${d.sessions})`).join(', '); }
  trackById(_: number, d: SportValidationDevice): string { return d.device_id; }
}

import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';
import { NgxChartsModule } from '@swimlane/ngx-charts';

import { ApiService } from '../../services/api.service';
import { OverviewEntry, SportType, SPORT_TYPE_LABELS } from '../../models/session.model';

function hexForR(r: number): string {
  if (r >= 0.95) return '#16a34a';
  if (r >= 0.90) return '#d97706';
  if (r >= 0.80) return '#ea580c';
  return '#dc2626';
}

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [
    CommonModule, RouterModule, FormsModule,
    MatCardModule, MatButtonModule, MatButtonToggleModule, MatIconModule,
    MatProgressSpinnerModule,
    NgxChartsModule,
  ],
  templateUrl: './overview.component.html',
  styleUrls: ['./overview.component.scss'],
})
export class OverviewComponent implements OnInit {
  loading = false;
  error   = '';

  selectedSport: SportType = 'running';
  readonly sportTypes = Object.entries(SPORT_TYPE_LABELS) as [SportType, string][];

  entries: OverviewEntry[] = [];

  // ngx-charts data
  ngxChartData:    { name: string; value: number }[] = [];
  ngxCustomColors: { name: string; value: string }[] = [];
  ngxRefLines = [
    { name: 'Excelente 0.95', value: 0.95 },
    { name: 'Bueno 0.90',     value: 0.90 },
    { name: 'Mínimo 0.80',    value: 0.80 },
  ];
  ngxYMin = 0.3;

  // Map name → full entry for tooltip
  ngxEntryMap = new Map<string, OverviewEntry>();

  constructor(private api: ApiService) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    this.error   = '';
    this.entries = [];

    this.api.getOverviewData(this.selectedSport).subscribe({
      next: (data) => {
        this.entries = data;
        this._buildChart(data);
        this.loading = false;
      },
      error: (err) => {
        this.error   = err.error?.detail || 'Error al cargar datos';
        this.loading = false;
      },
    });
  }

  private _buildChart(entries: OverviewEntry[]): void {
    if (!entries.length) return;

    const sorted = [...entries].sort((a, b) => a.r_global - b.r_global);
    const minR   = Math.min(...sorted.map(e => e.r_global));

    this.ngxYMin        = Math.max(0.3, minR - 0.04);
    this.ngxChartData   = sorted.map(e => ({ name: e.name, value: e.r_global }));
    this.ngxCustomColors = sorted.map(e => ({ name: e.name, value: hexForR(e.r_global) }));

    this.ngxEntryMap.clear();
    sorted.forEach(e => this.ngxEntryMap.set(e.name, e));
  }

  tooltipEntry(name: string): OverviewEntry | undefined {
    return this.ngxEntryMap.get(name);
  }

  get refLabel(): string {
    return this.entries[0]?.reference_name ?? '';
  }
}

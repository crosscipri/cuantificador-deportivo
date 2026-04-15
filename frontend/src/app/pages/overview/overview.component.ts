import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';
import { BaseChartDirective } from 'ng2-charts';
import type { ChartData, ChartOptions } from 'chart.js';

import { ApiService } from '../../services/api.service';
import { OverviewEntry, SportType, SPORT_TYPE_LABELS } from '../../models/session.model';

function colorForR(r: number): string {
  if (r >= 0.95) return 'rgba(22,163,74,0.80)';
  if (r >= 0.90) return 'rgba(217,119,6,0.80)';
  if (r >= 0.80) return 'rgba(234,88,12,0.80)';
  return 'rgba(220,38,38,0.80)';
}

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [
    CommonModule, RouterModule, FormsModule,
    MatCardModule, MatButtonModule, MatButtonToggleModule, MatIconModule,
    MatProgressSpinnerModule,
    BaseChartDirective,
  ],
  templateUrl: './overview.component.html',
  styleUrls: ['./overview.component.scss'],
})
export class OverviewComponent implements OnInit {
  loading = false;
  error   = '';

  selectedSport: SportType = 'running';
  readonly sportTypes = Object.entries(SPORT_TYPE_LABELS) as [SportType, string][];

  readonly Math = Math;
  entries: OverviewEntry[] = [];
  chartData:    ChartData<'bar'>    = { labels: [], datasets: [] };
  chartOptions: ChartOptions<'bar'> = {};

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
    const labels = entries.map(e => e.name);
    const rVals  = entries.map(e => e.r_global);
    const bgColors = rVals.map(r => colorForR(r));

    this.chartData = {
      labels,
      datasets: [{
        label: 'r global',
        data: rVals,
        backgroundColor: bgColors,
        borderColor:     bgColors.map(c => c.replace('0.80', '1')),
        borderWidth: 0,
        borderRadius: 4,
        barThickness: 28,
      }],
    };

    const maxR = Math.max(...rVals, 0.8);
    const stored = entries; // reference for tooltip closure

    this.chartOptions = {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#ffffff',
          borderColor: '#e2e5ec',
          borderWidth: 1,
          titleColor: '#111827',
          bodyColor: '#374151',
          padding: 12,
          callbacks: {
            title: (items) => stored[items[0].dataIndex]?.name ?? '',
            label: (item) => {
              const e = stored[item.dataIndex];
              if (!e) return '';
              const sign = e.bias_global > 0 ? '+' : '';
              return [
                ` r global:  ${e.r_global.toFixed(4)}`,
                ` MAE:       ${e.mae_global.toFixed(1)} %`,
                ` Bias:      ${sign}${e.bias_global.toFixed(1)} bpm`,
                ` Sesiones:  ${e.session_count}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          min: Math.max(0.5, Math.min(...rVals) - 0.05),
          max: Math.min(1.0, maxR + 0.02),
          ticks: {
            callback: (v) => Number(v).toFixed(2),
            color: '#6b7280', font: { size: 11 },
          },
          grid: { color: '#e5e8ef' },
          title: { display: true, text: 'Correlación de Pearson r (ponderada por dificultad)', color: '#6b7280', font: { size: 11 } },
        },
        y: {
          ticks: { color: '#111827', font: { size: 13, weight: 600 } },
          grid: { display: false },
        },
      },
    };
  }

  get refLabel(): string {
    return this.entries[0]?.reference_name ?? '';
  }
}

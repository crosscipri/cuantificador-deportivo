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
import type { ChartOptions } from 'chart.js';

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

  entries: OverviewEntry[] = [];
  chartData:    any = { datasets: [] };
  chartOptions: ChartOptions<'scatter'> = {};
  chartPlugins: any[] = [];

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

    // Ascending sort → worst at left (index 0), best at right (index n-1)
    const sorted = [...entries].sort((a, b) => a.r_global - b.r_global);
    const n      = sorted.length;
    const yMin   = Math.max(0.3, Math.min(...sorted.map(e => e.r_global)) - 0.04);

    // ── One dataset per device: vertical stem + dot at top ───────────────────
    const deviceDatasets = sorted.map((e, i) => {
      const c = colorForR(e.r_global);
      return {
        label:   e.name,
        data:    [{ x: i, y: yMin }, { x: i, y: e.r_global }],
        showLine: true,
        borderColor:          c,
        borderWidth:          2,
        pointRadius:          [0, 8],
        pointHoverRadius:     [0, 10],
        pointBackgroundColor: [c, c],
        pointBorderColor:     ['transparent', '#ffffff'],
        pointBorderWidth:     [0, 2],
      };
    });

    // ── Threshold horizontal lines ────────────────────────────────────────────
    const hLine = (y: number, color: string) => ({
      label:       '',
      data:        [{ x: -0.5, y }, { x: n - 0.5, y }],
      showLine:    true,
      borderColor: color,
      borderWidth: 1,
      borderDash:  [4, 3],
      pointRadius: 0,
      tooltip:     { enabled: false } as any,
    });

    this.chartData = {
      datasets: [
        ...deviceDatasets,
        hLine(0.95, 'rgba(22,163,74,0.5)'),
        hLine(0.90, 'rgba(217,119,6,0.5)'),
        hLine(0.80, 'rgba(234,88,12,0.5)'),
      ],
    } as any;

    // ── Inline plugin: device name above each dot ────────────────────────────
    this.chartPlugins = [{
      id: 'dotLabels',
      afterDatasetsDraw(chart: any) {
        const ctx: CanvasRenderingContext2D = chart.ctx;
        ctx.save();
        ctx.font = '500 11px Inter, system-ui, sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'bottom';
        sorted.forEach((entry, i) => {
          const meta = chart.getDatasetMeta(i);
          if (!meta?.data?.length) return;
          const dot = meta.data[1];   // second point = the filled circle
          if (!dot) return;
          const c = colorForR(entry.r_global);
          ctx.fillStyle = c;
          ctx.fillText(entry.name, dot.x, dot.y - 10);
        });
        ctx.restore();
      },
    }];

    // ── Options ───────────────────────────────────────────────────────────────
    const stored = sorted;
    this.chartOptions = {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 350 },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter:          (item: any) => item.dataIndex === 1 && item.datasetIndex < n,
          backgroundColor: '#ffffff',
          borderColor:     '#e2e5ec',
          borderWidth:     1,
          titleColor:      '#111827',
          bodyColor:       '#374151',
          padding:         12,
          callbacks: {
            title: (items: any[]) => stored[items[0].datasetIndex]?.name ?? '',
            label: (item: any) => {
              const e = stored[item.datasetIndex];
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
          type:  'linear',
          min:   -0.5,
          max:   n - 0.5,
          ticks: {
            stepSize:  1,
            callback:  (val: any) => stored[val as number]?.name ?? '',
            color:     '#111827',
            font:      { size: 12, weight: 600 },
          },
          grid: { display: false },
        },
        y: {
          type:  'linear',
          min:   yMin,
          max:   1.005,
          ticks: {
            callback:      (v: any) => Number(v).toFixed(2),
            color:         '#6b7280',
            font:          { size: 11 },
            maxTicksLimit: 8,
          },
          grid:  { color: '#e5e8ef' },
          title: {
            display: true,
            text:    'Correlación (r) — ponderada por dificultad de sesión',
            color:   '#6b7280',
            font:    { size: 11 },
          },
        },
      },
    } as any;
  }

  get refLabel(): string {
    return this.entries[0]?.reference_name ?? '';
  }
}

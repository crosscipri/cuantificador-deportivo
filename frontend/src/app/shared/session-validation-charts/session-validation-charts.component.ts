import { Component, Input, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTabsModule } from '@angular/material/tabs';
import { BaseChartDirective } from 'ng2-charts';
import type { ChartOptions } from 'chart.js';
import { Session, FcData, Metrics, Zone } from '../../models/session.model';

// ─── Zone helpers ────────────────────────────────────────────────────────────
const ZONE_RANGES: [number, number][] = [
  [0, 130], [130, 145], [145, 151], [151, 161], [161, 9999],
];
const ZONE_LABELS = ['Z1', 'Z2 Aeróbico', 'Z3 Tempo', 'Z4 Subumbral', 'Z5 Máximo'];
const ZONE_COLORS = ['#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444'];

function zoneIndex(ref: number): number {
  for (let i = 0; i < ZONE_RANGES.length; i++) {
    const [lo, hi] = ZONE_RANGES[i];
    if (ref >= lo && ref < hi) return i;
  }
  return ZONE_RANGES.length - 1;
}

// Subsample array keeping max N points
function subsample<T>(arr: T[], max = 1000): T[] {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length / max);
  return arr.filter((_, i) => i % step === 0);
}

// ─────────────────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-session-validation-charts',
  standalone: true,
  imports: [CommonModule, MatTabsModule, BaseChartDirective],
  templateUrl: './session-validation-charts.component.html',
  styleUrls: ['./session-validation-charts.component.scss'],
})
export class SessionValidationChartsComponent implements OnChanges {
  @Input() session!: Session;

  // ── Correlation ──────────────────────────────────────────────────────────
  corrData: any = { datasets: [] };
  corrOptions: ChartOptions<'scatter'> = this._buildCorrOptions();

  // ── Bland-Altman ─────────────────────────────────────────────────────────
  baData:    any = { datasets: [] };
  baOptions: ChartOptions<'scatter'> = this._buildBAOptions();

  // ── Zone bars ─────────────────────────────────────────────────────────────
  zoneData:    any = { datasets: [] };
  zoneOptions: ChartOptions<'bar'> = this._buildZoneOptions();

  ngOnChanges(): void {
    if (!this.session) return;
    const fc = this.session.fc_data;

    if (fc?.reference?.length) {
      this._buildCorr(fc, this.session.metrics);
      this._buildBA(fc, this.session.metrics);
    }
    this._buildZone(this.session.zones, this.session.fcmax);
  }

  // ── Build correlation scatter ──────────────────────────────────────────────
  private _buildCorr(fc: FcData, m: Metrics): void {
    const ref = fc.reference;
    const dev = fc.device;

    // Group into zone datasets (subsampled)
    const groups: { x: number; y: number }[][] = ZONE_RANGES.map(() => []);
    for (let i = 0; i < ref.length; i++) {
      groups[zoneIndex(ref[i])].push({ x: ref[i], y: dev[i] });
    }

    const scatterSets = ZONE_LABELS.map((label, zi) => ({
      type: 'scatter' as const,
      label,
      data: subsample(groups[zi], 300),
      backgroundColor: ZONE_COLORS[zi] + '55',
      borderColor:     ZONE_COLORS[zi] + 'aa',
      pointRadius: 2.5,
      pointHoverRadius: 4,
    }));

    // Identity line y = x
    const lo = Math.min(...ref, ...dev) - 2;
    const hi = Math.max(...ref, ...dev) + 2;
    const identityLine = {
      type: 'line' as const,
      label: 'y = x  (perfecto)',
      data: [{ x: lo, y: lo }, { x: hi, y: hi }],
      borderColor: '#dc2626',
      borderWidth: 1.5,
      borderDash: [6, 3],
      pointRadius: 0,
      fill: false,
    };

    // Regression line
    const yLo = m.slope * lo + m.intercept;
    const yHi = m.slope * hi + m.intercept;
    const regrLine = {
      type: 'line' as const,
      label: `y = ${m.slope}x + ${m.intercept}`,
      data: [{ x: lo, y: yLo }, { x: hi, y: yHi }],
      borderColor: '#d97706',
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
    };

    this.corrData = { datasets: [identityLine, regrLine, ...scatterSets] };
  }

  // ── Build Bland-Altman scatter ─────────────────────────────────────────────
  private _buildBA(fc: FcData, m: Metrics): void {
    const ref = fc.reference;
    const dev = fc.device;

    const groups: { x: number; y: number }[][] = ZONE_RANGES.map(() => []);
    for (let i = 0; i < ref.length; i++) {
      const mean = (ref[i] + dev[i]) / 2;
      const diff = dev[i] - ref[i];
      groups[zoneIndex(ref[i])].push({ x: mean, y: diff });
    }

    const allX = groups.flat().map(p => p.x);
    const xMin = Math.min(...allX) - 2;
    const xMax = Math.max(...allX) + 2;

    const hLine = (y: number, color: string, label: string, dash?: number[]) => ({
      type: 'line' as const,
      label,
      data: [{ x: xMin, y }, { x: xMax, y }],
      borderColor: color,
      borderWidth: dash ? 1.5 : 2,
      borderDash: dash,
      pointRadius: 0,
      fill: false,
    });

    const scatterSets = ZONE_LABELS.map((label, zi) => ({
      type: 'scatter' as const,
      label,
      data: subsample(groups[zi], 300),
      backgroundColor: ZONE_COLORS[zi] + '55',
      borderColor:     ZONE_COLORS[zi] + 'aa',
      pointRadius: 2.5,
      pointHoverRadius: 4,
    }));

    this.baData = {
      datasets: [
        hLine(m.bias,  '#d97706', `Bias = ${m.bias} ppm`),
        hLine(m.loa_u, '#dc2626', `+LoA = ${m.loa_u} ppm`, [6, 3]),
        hLine(m.loa_l, '#2563eb', `−LoA = ${m.loa_l} ppm`, [6, 3]),
        ...scatterSets,
      ],
    };
  }

  // ── Build zone bar chart ───────────────────────────────────────────────────
  private _buildZone(zones: Zone[], fcmax: number): void {
    const names = zones.map(z => z.zone.split(' ').slice(0, 2).join(' '));
    this.zoneData = {
      labels: names,
      datasets: [
        {
          label: 'MAE (ppm)',
          data: zones.map(z => z.mae ?? 0),
          backgroundColor: ZONE_COLORS.slice(0, zones.length).map(c => c + 'cc'),
          borderWidth: 0,
          yAxisID: 'y',
        },
        {
          label: 'MAPE (%)',
          data: zones.map(z => z.mape ?? 0),
          backgroundColor: ZONE_COLORS.slice(0, zones.length).map(c => c + '55'),
          borderWidth: 0,
          yAxisID: 'y1',
        },
      ],
    };
    // Update title dynamically
    (this.zoneOptions as any).plugins.title.text = `Error por zona  —  FCmax ${fcmax} ppm`;
  }

  // ── Options builders (defined once, not on every change) ──────────────────
  private _baseScatterOptions(): ChartOptions<'scatter'> {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#374151', font: { size: 11 }, boxWidth: 12, padding: 10 },
        },
        tooltip: {
          backgroundColor: '#ffffff',
          borderColor: '#e2e5ec',
          borderWidth: 1,
          titleColor: '#111827',
          bodyColor: '#374151',
        },
      },
      scales: {
        x: {
          ticks: { color: '#6b7280', font: { size: 11 } },
          grid:  { color: '#e5e8ef' },
        },
        y: {
          ticks: { color: '#6b7280', font: { size: 11 } },
          grid:  { color: '#e5e8ef' },
        },
      },
    };
  }

  private _buildCorrOptions(): ChartOptions<'scatter'> {
    const opts = this._baseScatterOptions();
    opts.scales!['x']!.title = { display: true, text: 'FC Referencia (ppm)', color: '#6b7280' };
    opts.scales!['y']!.title = { display: true, text: 'FC Dispositivo (ppm)', color: '#6b7280' };
    opts.plugins!.title = {
      display: true, text: 'Correlación',
      color: '#111827', font: { size: 13, weight: 'bold' }, padding: { bottom: 8 },
    };
    return opts;
  }

  private _buildBAOptions(): ChartOptions<'scatter'> {
    const opts = this._baseScatterOptions();
    opts.scales!['x']!.title = { display: true, text: 'Media de los dos sensores (ppm)', color: '#6b7280' };
    opts.scales!['y']!.title = { display: true, text: 'Diferencia: dispositivo − referencia (ppm)', color: '#6b7280' };
    opts.plugins!.title = {
      display: true, text: 'Bland-Altman',
      color: '#111827', font: { size: 13, weight: 'bold' }, padding: { bottom: 8 },
    };
    return opts;
  }

  private _buildZoneOptions(): ChartOptions<'bar'> {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { color: '#374151', font: { size: 11 }, boxWidth: 14 },
        },
        title: {
          display: true, text: 'Error por zona',
          color: '#111827', font: { size: 13, weight: 'bold' }, padding: { bottom: 8 },
        },
        tooltip: {
          backgroundColor: '#ffffff',
          borderColor: '#e2e5ec',
          borderWidth: 1,
          titleColor: '#111827',
          bodyColor: '#374151',
        },
      },
      scales: {
        x: { ticks: { color: '#374151', font: { size: 11 } }, grid: { color: '#e5e8ef' } },
        y: {
          type: 'linear', position: 'left',
          ticks: { color: '#6b7280', font: { size: 11 } }, grid: { color: '#e5e8ef' },
          title: { display: true, text: 'MAE (ppm)', color: '#6b7280' },
        },
        y1: {
          type: 'linear', position: 'right',
          ticks: { color: '#6b7280', font: { size: 11 } },
          grid: { drawOnChartArea: false },
          title: { display: true, text: 'MAPE (%)', color: '#6b7280' },
        },
      },
    };
  }
}

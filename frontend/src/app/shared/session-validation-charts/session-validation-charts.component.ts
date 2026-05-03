import { Component, Input, OnChanges, ViewChildren, QueryList, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BaseChartDirective } from 'ng2-charts';
import type { ChartOptions } from 'chart.js';
import { Session, FcData, Metrics, Zone } from '../../models/session.model';
import { DrawingCanvasComponent, DrawTool } from '../drawing-canvas/drawing-canvas.component';

// ─── Zone helpers ────────────────────────────────────────────────────────────
const ZONE_RANGES: [number, number][] = [
  [0, 130], [130, 145], [145, 151], [151, 161], [161, 9999],
];
const ZONE_LABELS = ['Z1', 'Z2 Aeróbico', 'Z3 Tempo', 'Z4 Subumbral', 'Z5 Máximo'];
const ZONE_COLORS = ['#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444'];
const TAB_FILENAMES = ['correlacion', 'bland-altman', 'error-zonas'];

function zoneIndex(ref: number): number {
  for (let i = 0; i < ZONE_RANGES.length; i++) {
    const [lo, hi] = ZONE_RANGES[i];
    if (ref >= lo && ref < hi) return i;
  }
  return ZONE_RANGES.length - 1;
}

function subsample<T>(arr: T[], max = 1000): T[] {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length / max);
  return arr.filter((_, i) => i % step === 0);
}

// ─────────────────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-session-validation-charts',
  standalone: true,
  imports: [CommonModule, MatTabsModule, MatButtonModule, MatIconModule,
            MatTooltipModule, BaseChartDirective, DrawingCanvasComponent],
  templateUrl: './session-validation-charts.component.html',
  styleUrls: ['./session-validation-charts.component.scss'],
})
export class SessionValidationChartsComponent implements OnChanges {
  @Input() session!: Session;

  @ViewChildren(BaseChartDirective)    charts!:      QueryList<BaseChartDirective>;
  @ViewChildren(DrawingCanvasComponent) drawCanvases!: QueryList<DrawingCanvasComponent>;

  activeTab   = 0;
  fullscreen  = false;
  drawingMode = false;
  drawColor   = '#e53e3e';
  drawStroke  = 3;
  drawTool: DrawTool = 'pen';

  readonly STROKES = [2, 5, 10];

  // ── Chart data ────────────────────────────────────────────────────────────
  corrData: any = { datasets: [] };
  corrOptions: ChartOptions<'scatter'> = this._buildCorrOptions();

  baData:    any = { datasets: [] };
  baOptions: ChartOptions<'scatter'> = this._buildBAOptions();

  zoneData:    any = { datasets: [] };
  zoneOptions: ChartOptions<'bar'> = this._buildZoneOptions();

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  ngOnChanges(): void {
    if (!this.session) return;
    const fc = this.session.fc_data;
    if (fc?.reference?.length) {
      this._buildCorr(fc, this.session.metrics);
      this._buildBA(fc, this.session.metrics);
    }
    this._buildZone(this.session.zones, this.session.fcmax);
  }

  // ── Fullscreen ────────────────────────────────────────────────────────────
  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    if (!this.fullscreen) this.drawingMode = false;
    document.body.style.overflow = this.fullscreen ? 'hidden' : '';
    setTimeout(() => this.charts.forEach(c => c.chart?.resize()), 50);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void { if (this.fullscreen) this.toggleFullscreen(); }

  // ── Drawing ───────────────────────────────────────────────────────────────
  setColor(e: Event): void {
    this.drawColor = (e.target as HTMLInputElement).value;
  }

  clearDrawing(): void {
    this.drawCanvases.toArray()[this.activeTab]?.clear();
  }

  // ── Download ──────────────────────────────────────────────────────────────
  download(): void {
    const chartList  = this.charts.toArray();
    const drawList   = this.drawCanvases.toArray();
    const chartCanvas = chartList[this.activeTab]?.chart?.canvas;
    if (!chartCanvas) return;

    const dc = drawList[this.activeTab];
    const dataUrl = dc ? dc.composite(chartCanvas) : chartCanvas.toDataURL('image/png');

    const name = `${this.session?.device_name ?? 'session'}-${TAB_FILENAMES[this.activeTab]}.png`;
    const a = document.createElement('a');
    a.href = dataUrl; a.download = name; a.click();
  }

  // ── Chart builders ────────────────────────────────────────────────────────
  private _buildCorr(fc: FcData, m: Metrics): void {
    const ref = fc.reference, dev = fc.device;
    const groups: { x: number; y: number }[][] = ZONE_RANGES.map(() => []);
    for (let i = 0; i < ref.length; i++)
      groups[zoneIndex(ref[i])].push({ x: ref[i], y: dev[i] });

    const lo = Math.min(...ref, ...dev) - 2;
    const hi = Math.max(...ref, ...dev) + 2;

    this.corrData = {
      datasets: [
        { type: 'line' as const, label: 'y = x  (perfecto)',
          data: [{ x: lo, y: lo }, { x: hi, y: hi }],
          borderColor: '#dc2626', borderWidth: 1.5, borderDash: [6, 3],
          pointRadius: 0, fill: false },
        { type: 'line' as const, label: `y = ${m.slope}x + ${m.intercept}`,
          data: [{ x: lo, y: m.slope*lo+m.intercept }, { x: hi, y: m.slope*hi+m.intercept }],
          borderColor: '#d97706', borderWidth: 2, pointRadius: 0, fill: false },
        ...ZONE_LABELS.map((label, zi) => ({
          type: 'scatter' as const, label,
          data: subsample(groups[zi], 300),
          backgroundColor: ZONE_COLORS[zi] + '55',
          borderColor: ZONE_COLORS[zi] + 'aa',
          pointRadius: 2.5, pointHoverRadius: 4,
        })),
      ],
    };
  }

  private _buildBA(fc: FcData, m: Metrics): void {
    const ref = fc.reference, dev = fc.device;
    const groups: { x: number; y: number }[][] = ZONE_RANGES.map(() => []);
    for (let i = 0; i < ref.length; i++) {
      groups[zoneIndex(ref[i])].push({ x: (ref[i]+dev[i])/2, y: dev[i]-ref[i] });
    }
    const allX = groups.flat().map(p => p.x);
    const xMin = Math.min(...allX) - 2, xMax = Math.max(...allX) + 2;
    const hLine = (y: number, color: string, label: string, dash?: number[]) => ({
      type: 'line' as const, label,
      data: [{ x: xMin, y }, { x: xMax, y }],
      borderColor: color, borderWidth: dash ? 1.5 : 2,
      borderDash: dash, pointRadius: 0, fill: false,
    });
    this.baData = {
      datasets: [
        hLine(m.bias,  '#d97706', `Bias = ${m.bias} ppm`),
        hLine(m.loa_u, '#dc2626', `+LoA = ${m.loa_u} ppm`, [6, 3]),
        hLine(m.loa_l, '#2563eb', `−LoA = ${m.loa_l} ppm`, [6, 3]),
        ...ZONE_LABELS.map((label, zi) => ({
          type: 'scatter' as const, label,
          data: subsample(groups[zi], 300),
          backgroundColor: ZONE_COLORS[zi] + '55',
          borderColor: ZONE_COLORS[zi] + 'aa',
          pointRadius: 2.5, pointHoverRadius: 4,
        })),
      ],
    };
  }

  private _buildZone(zones: Zone[], fcmax: number): void {
    this.zoneData = {
      labels: zones.map(z => z.zone.split(' ').slice(0, 2).join(' ')),
      datasets: [
        { label: 'MAE (ppm)', data: zones.map(z => z.mae ?? 0),
          backgroundColor: ZONE_COLORS.slice(0, zones.length).map(c => c + 'cc'),
          borderWidth: 0, yAxisID: 'y' },
        { label: 'MAPE (%)', data: zones.map(z => z.mape ?? 0),
          backgroundColor: ZONE_COLORS.slice(0, zones.length).map(c => c + '55'),
          borderWidth: 0, yAxisID: 'y1' },
      ],
    };
    (this.zoneOptions as any).plugins.title.text = `Error por zona  —  FCmax ${fcmax} ppm`;
  }

  private _baseScatterOptions(): ChartOptions<'scatter'> {
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { position: 'bottom',
          labels: { color: '#374151', font: { size: 11 }, boxWidth: 12, padding: 10 } },
        tooltip: { backgroundColor: '#ffffff', borderColor: '#e2e5ec', borderWidth: 1,
          titleColor: '#111827', bodyColor: '#374151' },
      },
      scales: {
        x: { ticks: { color: '#6b7280', font: { size: 11 } }, grid: { color: '#e5e8ef' } },
        y: { ticks: { color: '#6b7280', font: { size: 11 } }, grid: { color: '#e5e8ef' } },
      },
    };
  }

  private _buildCorrOptions(): ChartOptions<'scatter'> {
    const opts = this._baseScatterOptions();
    opts.scales!['x']!.title = { display: true, text: 'FC Referencia (ppm)', color: '#6b7280' };
    opts.scales!['y']!.title = { display: true, text: 'FC Dispositivo (ppm)', color: '#6b7280' };
    opts.plugins!.title = { display: true, text: 'Correlación',
      color: '#111827', font: { size: 13, weight: 'bold' }, padding: { bottom: 8 } };
    return opts;
  }

  private _buildBAOptions(): ChartOptions<'scatter'> {
    const opts = this._baseScatterOptions();
    opts.scales!['x']!.title = { display: true, text: 'Media de los dos sensores (ppm)', color: '#6b7280' };
    opts.scales!['y']!.title = { display: true, text: 'Diferencia: dispositivo − referencia (ppm)', color: '#6b7280' };
    opts.plugins!.title = { display: true, text: 'Bland-Altman',
      color: '#111827', font: { size: 13, weight: 'bold' }, padding: { bottom: 8 } };
    return opts;
  }

  private _buildZoneOptions(): ChartOptions<'bar'> {
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { position: 'top',
          labels: { color: '#374151', font: { size: 11 }, boxWidth: 14 } },
        title: { display: true, text: 'Error por zona',
          color: '#111827', font: { size: 13, weight: 'bold' }, padding: { bottom: 8 } },
        tooltip: { backgroundColor: '#ffffff', borderColor: '#e2e5ec', borderWidth: 1,
          titleColor: '#111827', bodyColor: '#374151' },
      },
      scales: {
        x: { ticks: { color: '#374151', font: { size: 11 } }, grid: { color: '#e5e8ef' } },
        y: { type: 'linear', position: 'left',
          ticks: { color: '#6b7280', font: { size: 11 } }, grid: { color: '#e5e8ef' },
          title: { display: true, text: 'MAE (ppm)', color: '#6b7280' } },
        y1: { type: 'linear', position: 'right',
          ticks: { color: '#6b7280', font: { size: 11 } }, grid: { drawOnChartArea: false },
          title: { display: true, text: 'MAPE (%)', color: '#6b7280' } },
      },
    };
  }
}

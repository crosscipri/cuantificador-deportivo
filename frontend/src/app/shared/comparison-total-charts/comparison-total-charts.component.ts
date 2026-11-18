import { CommonModule } from '@angular/common';
import { Component, Input, OnChanges, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { ComparisonService } from '../../services/comparison.service';
import { orderedDeviceColor, orderedDevicePointStyle } from '../../models/comparison.model';
import {
  SportCorrDevice, TotalCorrPoint, TotalCorrRow, TotalCorrStats,
  boxPlotStats, formatEs, mergeStats, percentAtLeast,
} from './comparison-total-charts';

export interface TotalCorrTimeSession { id: string; label: string; deviceId: string; }

interface BoxColumn {
  label: string;
  r: number | null;
  perc: number | null;
  values: number[];
  box: ReturnType<typeof boxPlotStats>;
  jitter: {x: number; y: number}[];
}

interface SportChartView {
  id: string;
  name: string;
  color: string;
  shape: string;
  badge: string;
  columns: BoxColumn[];
}

@Component({
  selector: 'app-comparison-total-charts',
  standalone: true,
  imports: [CommonModule, FormsModule, BaseChartDirective],
  templateUrl: './comparison-total-charts.component.html',
  styleUrls: ['./comparison-total-charts.component.scss'],
})
export class ComparisonTotalChartsComponent implements OnChanges {
  @Input() rows: TotalCorrRow[] = [];
  @Input() unit = 'bpm';
  @Input() xLabel = 'FC de referencia (bpm)';
  @Input() yLabel = 'FC del dispositivo (bpm)';
  @Input() timeSessions: TotalCorrTimeSession[] = [];
  @Input() sportDevices: SportCorrDevice[] = [];
  @Input() featuredSport = 'running';

  scatterData: ChartConfiguration<'scatter'>['data'] = { datasets: [] };
  scatterOptions: ChartOptions<'scatter'> = this.baseOptions('Referencia', 'Dispositivo');
  tableRows: { id: string; name: string; error?: string; color: string; stats: TotalCorrStats }[] = [];
  sportCharts: SportChartView[] = [];

  selectedSessionId = '';
  timeLoading = false;
  timeError = '';
  timeData: ChartConfiguration<'line'>['data'] = { datasets: [] };
  timeOptions: ChartOptions<'line'> = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { boxWidth: 16, boxHeight: 2, padding: 12, font: { size: 11 } } },
      tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatEs(ctx.parsed.y, 1)} ${this.unit}` } },
    },
    scales: {
      x: { type: 'linear', title: { display: true, text: 'Tiempo (s)' } },
      y: { title: { display: true, text: `FC (${this.unit})` } },
    },
  };

  private deviceOrder: string[] = [];
  private api = inject(ComparisonService, { optional: true });

  readonly plot = { left: 48, right: 16, top: 28, bottom: 28, width: 640, height: 320, yMin: 0, yMax: 1.08 };
  readonly percNote = 'Cada punto es la correlación de una sesión. La caja resume la distribución por deporte. La marca roja es la correlación global de todos los puntos de ese deporte. Perc = porcentaje de sesiones con r ≥ 0,95.';

  ngOnChanges(): void { this.rebuild(); }

  formatR(v: number | null | undefined): string { return formatEs(v, 3); }
  formatVal(v: number | null | undefined): string { return formatEs(v, 1); }
  color(id: string): string { return orderedDeviceColor(id, this.deviceOrder); }
  pointStyle(id: string) { return orderedDevicePointStyle(id, this.deviceOrder); }
  tickLabel(tick: number): string { return formatEs(tick, 1); }
  corrCaption(col: BoxColumn): string {
    return `Corr: ${formatEs(col.r, 2)}  ·  Perc: ${formatEs(col.perc, 0)} %`;
  }
  boxTop(box: NonNullable<BoxColumn['box']>): number { return this.yPos(box.q3); }
  boxHeight(box: NonNullable<BoxColumn['box']>): number {
    return Math.max(this.yPos(box.q1) - this.yPos(box.q3), 1);
  }

  onSessionChange(id: string): void {
    this.selectedSessionId = id;
    this.loadTimeSeries();
  }

  yPos(value: number): number {
    const {top, height, bottom, yMin, yMax} = this.plot;
    const usable = height - top - bottom;
    return top + (yMax - value) / (yMax - yMin) * usable;
  }
  xPos(index: number, count: number): number {
    const {left, width, right} = this.plot;
    const usable = width - left - right;
    return left + usable * (index + 0.5) / Math.max(count, 1);
  }
  ticks(): number[] { return [0, 0.2, 0.4, 0.6, 0.8, 1]; }
  boxWidth(): number {
    const usable = this.plot.width - this.plot.left - this.plot.right;
    return Math.min(70, usable / 4);
  }
  pointPath(shape: string, x: number, y: number): string {
    const s = 4.2;
    if (shape === 'triangle') return `M ${x} ${y - s} L ${x + s} ${y + s} L ${x - s} ${y + s} Z`;
    if (shape === 'rect') return `M ${x - s} ${y - s} h ${2 * s} v ${2 * s} h ${-2 * s} Z`;
    if (shape === 'rectRot') return `M ${x} ${y - s} L ${x + s} ${y} L ${x} ${y + s} L ${x - s} ${y} Z`;
    return '';
  }
  isCircle(shape: string): boolean { return shape === 'circle' || !['triangle', 'rect', 'rectRot'].includes(shape); }

  private refreshDeviceOrder(): void {
    const ids: string[] = [];
    const add = (id?: string) => { if (id && !ids.includes(id)) ids.push(id); };
    for (const row of this.rows || []) add(row.id);
    for (const device of this.sportDevices || []) add(device.id);
    for (const session of this.timeSessions || []) add(session.deviceId);
    this.deviceOrder = ids;
  }

  private rebuild(): void {
    this.refreshDeviceOrder();
    this.tableRows = (this.rows || []).map((row) => ({
      id: row.id,
      name: row.name,
      error: row.error,
      color: this.color(row.id),
      stats: mergeStats(row.points || [], row.stats),
    }));
    this.buildScatter();
    this.buildSportCharts();
    const sessions = this.timeSessions || [];
    if (!sessions.length) {
      this.selectedSessionId = '';
      this.timeData = { datasets: [] };
    } else if (!sessions.some((item) => item.id === this.selectedSessionId) || !this.timeData.datasets.length) {
      this.selectedSessionId = sessions[0].id;
      this.loadTimeSeries();
    }
    this.timeOptions = {
      ...this.timeOptions,
      scales: {
        x: { type: 'linear', title: { display: true, text: 'Tiempo (s)' } },
        y: { title: { display: true, text: `FC (${this.unit})` } },
      },
    };
  }

  private buildScatter(): void {
    const datasets: ChartConfiguration<'scatter'>['data']['datasets'] = [];
    const series: {row: TotalCorrRow; points: TotalCorrPoint[]; color: string}[] = [];
    let min = Infinity, max = -Infinity;
    for (const row of this.rows || []) {
      const points = (row.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (!points.length) continue;
      const color = this.color(row.id);
      series.push({row, points, color});
      for (const p of points) { min = Math.min(min, p.x, p.y); max = Math.max(max, p.x, p.y); }
    }
    // Draw the smaller cloud last so it is not buried under the larger one.
    series.sort((a, b) => b.points.length - a.points.length);
    for (const item of series) {
      datasets.push({
        label: item.row.name,
        data: item.points,
        backgroundColor: item.color + '61',
        borderColor: 'transparent',
        pointBackgroundColor: item.color + '61',
        pointBorderColor: 'transparent',
        pointRadius: 3,
        pointHoverRadius: 5.5,
        pointStyle: this.pointStyle(item.row.id),
      });
    }
    for (const item of series) {
      const stats = mergeStats(item.points, item.row.stats);
      if (stats.slope != null && stats.intercept != null && Number.isFinite(min) && Number.isFinite(max)) {
        datasets.push({
          label: `Regresión · ${item.row.name}`,
          data: [
            { x: min, y: stats.slope * min + stats.intercept },
            { x: max, y: stats.slope * max + stats.intercept },
          ],
          showLine: true,
          pointRadius: 0,
          borderColor: item.color,
          borderWidth: 1.5,
          backgroundColor: 'transparent',
        } as any);
      }
    }
    if (Number.isFinite(min) && Number.isFinite(max)) {
      const pad = (max - min) * 0.04 + 1;
      min -= pad; max += pad;
      datasets.push({
        label: 'Identidad (y = x)',
        data: [{ x: min, y: min }, { x: max, y: max }],
        showLine: true,
        pointRadius: 0,
        borderColor: '#111827',
        borderWidth: 1.6,
        borderDash: [6, 4],
        backgroundColor: 'transparent',
      } as any);
    }
    this.scatterData = { datasets };
    this.scatterOptions = this.baseOptions(this.xLabel, this.yLabel, (x, y) =>
      `referencia ${formatEs(x, 1)}, dispositivo ${formatEs(y, 1)} ${this.unit}`);
  }

  private buildSportCharts(): void {
    this.sportCharts = (this.sportDevices || []).filter((device) => device.sports?.some((s) => s.sessionRs.length || s.r != null)).map((device) => {
      const columns: BoxColumn[] = device.sports.map((sport, index, all) => {
        const values = sport.sessionRs || [];
        const perc = sport.perc ?? percentAtLeast(values);
        const box = boxPlotStats(values);
        const cx = this.xPos(index, all.length);
        const jitter = values.map((y, i) => ({
          x: cx + this.stableJitter(device.id + sport.id + i),
          y,
        }));
        return { label: sport.label, r: sport.r, perc, values, box, jitter };
      });
      const featured = columns.find((col, i) => device.sports[i].id === this.featuredSport) || columns[0];
      const badge = featured
        ? `${device.name} / Corr: ${formatEs(featured.r, 2)}  ·  Perc: ${formatEs(featured.perc, 0)} %`
        : device.name;
      return {
        id: device.id,
        name: device.name,
        color: this.color(device.id),
        shape: this.pointStyle(device.id),
        badge,
        columns,
      };
    });
  }

  private stableJitter(seed: string): number {
    let hash = 0;
    for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return ((hash % 1000) / 1000 - 0.5) * 18;
  }

  private loadTimeSeries(): void {
    const id = this.selectedSessionId;
    const session = this.timeSessions?.find((item) => item.id === id);
    if (!id || !session || !this.api) { this.timeData = { datasets: [] }; return; }
    this.timeLoading = true; this.timeError = '';
    this.api.historicalChart(id).subscribe({
      next: (chart) => {
        if (this.selectedSessionId !== id) return;
        const color = this.color(session.deviceId);
        const datasets = (chart.series || []).map((series) => {
          const isRef = series.role === 'reference';
          return {
            label: isRef ? 'Referencia' : (series.name || session.label.split(' · ')[0]),
            data: (chart.time || []).map((x, i) => ({ x, y: series.values[i] ?? NaN })),
            borderColor: isRef ? '#111827' : color,
            backgroundColor: 'transparent',
            borderWidth: isRef ? 2 : 1.6,
            borderDash: isRef ? [5, 3] : [],
            pointRadius: 0,
            spanGaps: false,
          };
        });
        this.timeData = { datasets };
        this.timeLoading = false;
      },
      error: () => {
        if (this.selectedSessionId !== id) return;
        this.timeLoading = false;
        this.timeError = 'No se ha podido cargar la curva de esta sesión.';
        this.timeData = { datasets: [] };
      },
    });
  }

  private baseOptions(
    xTitle: string,
    yTitle: string,
    tooltip?: (x: number, y: number) => string,
  ): ChartOptions<'scatter'> {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          labels: {
            boxWidth: 12,
            boxHeight: 12,
            padding: 10,
            font: { size: 11 },
            filter: (item) => !!item.text && !item.text.startsWith('Regresión'),
          },
        },
        tooltip: {
          filter: (item) => !String(item.dataset.label || '').startsWith('Regresión') && item.dataset.label !== 'Identidad (y = x)',
          callbacks: {
            label: (ctx) => tooltip ? `${ctx.dataset.label}: ${tooltip(ctx.parsed.x ?? NaN, ctx.parsed.y ?? NaN)}` : `${ctx.dataset.label}`,
          },
        },
      },
      scales: {
        x: { title: { display: true, text: xTitle, font: { size: 11 } } },
        y: { title: { display: true, text: yTitle, font: { size: 11 } } },
      },
    };
  }
}

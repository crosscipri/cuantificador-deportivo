import { Component, Input, OnChanges, ViewChild, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BaseChartDirective } from 'ng2-charts';
import type { ChartConfiguration, ChartOptions } from 'chart.js';
import { FcData } from '../../models/session.model';
import { DrawingCanvasComponent, DrawTool } from '../drawing-canvas/drawing-canvas.component';

function secToMmss(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const ZONE_BANDS = [
  { lo: 44,  hi: 134, color: 'rgba(99,102,241,0.045)' },
  { lo: 134, hi: 154, color: 'rgba(34,197,94,0.04)'   },
  { lo: 154, hi: 167, color: 'rgba(234,179,8,0.05)'   },
  { lo: 167, hi: 176, color: 'rgba(249,115,22,0.055)' },
  { lo: 176, hi: 999, color: 'rgba(239,68,68,0.055)'  },
];

const gradientPlugin: any = {
  id: 'gradientFill',
  beforeUpdate(chart: any) {
    const { ctx, chartArea } = chart;
    if (!chartArea) return;
    const { top, bottom } = chartArea;

    const g0 = ctx.createLinearGradient(0, top, 0, bottom);
    g0.addColorStop(0, 'rgba(99,102,241,0.20)');
    g0.addColorStop(0.6, 'rgba(99,102,241,0.05)');
    g0.addColorStop(1, 'rgba(99,102,241,0.0)');

    const g1 = ctx.createLinearGradient(0, top, 0, bottom);
    g1.addColorStop(0, 'rgba(16,185,129,0.18)');
    g1.addColorStop(0.6, 'rgba(16,185,129,0.04)');
    g1.addColorStop(1, 'rgba(16,185,129,0.0)');

    if (chart.data.datasets[0]) chart.data.datasets[0].backgroundColor = g0;
    if (chart.data.datasets[1]) chart.data.datasets[1].backgroundColor = g1;
  },
};

const zoneBandsPlugin: any = {
  id: 'zoneBands',
  beforeDatasetsDraw(chart: any) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales['y']) return;
    const yScale = scales['y'];
    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
    ctx.clip();
    ZONE_BANDS.forEach(z => {
      const yTop = Math.min(yScale.getPixelForValue(z.hi), chartArea.bottom);
      const yBot = Math.max(yScale.getPixelForValue(z.lo), chartArea.top);
      if (yBot <= yTop) return;
      ctx.fillStyle = z.color;
      ctx.fillRect(chartArea.left, yTop, chartArea.width, yBot - yTop);
    });
    ctx.restore();
  },
};

@Component({
  selector: 'app-fc-temporal-chart',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatTooltipModule,
            BaseChartDirective, DrawingCanvasComponent],
  templateUrl: './fc-temporal-chart.component.html',
  styleUrls: ['./fc-temporal-chart.component.scss'],
})
export class FcTemporalChartComponent implements OnChanges {
  @Input() fcData!: FcData;
  @Input() refName = 'Referencia';
  @Input() devName = 'Dispositivo';

  @ViewChild(BaseChartDirective)     chartRef?:   BaseChartDirective;
  @ViewChild(DrawingCanvasComponent) drawCanvas?: DrawingCanvasComponent;

  chartData: ChartConfiguration<'line'>['data'] = { datasets: [] };
  chartPlugins = [gradientPlugin, zoneBandsPlugin];

  fullscreen  = false;
  drawingMode = false;
  drawColor   = '#e53e3e';
  drawStroke  = 3;
  drawTool: DrawTool = 'pen';

  hoverVisible = false;
  hoverTime    = '';
  hoverRef     = 0;
  hoverDev     = 0;
  hoverDiff    = 0;

  readonly STROKES = [2, 5, 10];

  readonly chartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 500, easing: 'easeOutQuart' } as any,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      tooltip: { enabled: false },
      legend: {
        position: 'top',
        align: 'end',
        labels: {
          color: '#6b7280',
          font: { size: 12 },
          boxWidth: 24,
          boxHeight: 3,
          padding: 20,
          usePointStyle: false,
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        ticks: {
          callback: (val) => secToMmss(val as number),
          maxTicksLimit: 10,
          color: '#9ca3af',
          font: { size: 11 },
        },
        grid: { color: 'rgba(229,232,239,0.7)' },
        border: { display: false },
      },
      y: {
        ticks: { color: '#9ca3af', font: { size: 11 }, padding: 8 },
        grid: { color: 'rgba(229,232,239,0.7)' },
        border: { display: false },
        title: { display: true, text: 'ppm', color: '#9ca3af', font: { size: 10 } },
      },
    },
  };

  ngOnChanges(): void {
    if (!this.fcData?.time?.length) return;
    const { time, reference, device } = this.fcData;

    const refPts = time.map((t, i) => ({ x: t, y: reference[i] }));
    const devPts = time.map((t, i) => ({ x: t, y: device[i] }));

    this.chartData = {
      datasets: [
        {
          label: this.refName,
          data: refPts,
          borderColor: '#818cf8',
          backgroundColor: 'rgba(99,102,241,0.15)',
          fill: 'origin',
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: '#818cf8',
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
          borderWidth: 2.5,
          tension: 0.55,
        } as any,
        {
          label: this.devName,
          data: devPts,
          borderColor: '#34d399',
          backgroundColor: 'rgba(16,185,129,0.12)',
          fill: 'origin',
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: '#34d399',
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
          borderWidth: 2.5,
          tension: 0.55,
        } as any,
      ],
    };
  }

  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    if (!this.fullscreen) this.drawingMode = false;
    document.body.style.overflow = this.fullscreen ? 'hidden' : '';
    setTimeout(() => this.chartRef?.chart?.resize(), 50);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void { if (this.fullscreen) this.toggleFullscreen(); }

  download(): void {
    const chartCanvas = this.chartRef?.chart?.canvas;
    if (!chartCanvas) return;
    const dataUrl = this.drawCanvas
      ? this.drawCanvas.composite(chartCanvas)
      : chartCanvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href     = dataUrl;
    a.download = `${this.devName}-vs-${this.refName}-fc-temporal.png`;
    a.click();
  }

  setColor(e: Event): void { this.drawColor = (e.target as HTMLInputElement).value; }
  clearDrawing(): void { this.drawCanvas?.clear(); }

  onChartMouseMove(event: MouseEvent): void {
    const chart = this.chartRef?.chart;
    if (!chart) return;
    const rect    = chart.canvas.getBoundingClientRect();
    const x       = event.clientX - rect.left;
    const xScale  = chart.scales['x'];
    if (!xScale || x < chart.chartArea.left || x > chart.chartArea.right) {
      this.hoverVisible = false;
      return;
    }
    const time    = xScale.getValueForPixel(x) as number;
    const refData = chart.data.datasets[0]?.data as {x: number, y: number}[];
    const devData = chart.data.datasets[1]?.data as {x: number, y: number}[];
    if (!refData?.length || !devData?.length) return;
    const idx     = this._nearestIdx(refData, time);
    this.hoverRef     = Math.round(refData[idx].y);
    this.hoverDev     = Math.round(devData[idx].y);
    this.hoverDiff    = Math.abs(this.hoverRef - this.hoverDev);
    this.hoverTime    = secToMmss(Math.round(refData[idx].x));
    this.hoverVisible = true;
  }

  onChartMouseLeave(): void { this.hoverVisible = false; }

  private _nearestIdx(data: {x: number, y: number}[], time: number): number {
    let lo = 0, hi = data.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (data[mid].x < time) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(data[lo - 1].x - time) < Math.abs(data[lo].x - time)) return lo - 1;
    return lo;
  }
}

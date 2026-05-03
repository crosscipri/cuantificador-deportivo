import { Component, Input, OnChanges, ViewChild, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BaseChartDirective } from 'ng2-charts';
import type { ChartConfiguration, ChartOptions } from 'chart.js';
import { FcData } from '../../models/session.model';

function secToMmss(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

@Component({
  selector: 'app-fc-temporal-chart',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatTooltipModule, BaseChartDirective],
  templateUrl: './fc-temporal-chart.component.html',
  styleUrls: ['./fc-temporal-chart.component.scss'],
})
export class FcTemporalChartComponent implements OnChanges {
  @Input() fcData!: FcData;
  @Input() refName = 'Referencia';
  @Input() devName = 'Dispositivo';

  @ViewChild(BaseChartDirective) chartRef?: BaseChartDirective;

  chartData: ChartConfiguration<'line'>['data'] = { datasets: [] };
  fullscreen = false;

  readonly chartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'top',
        labels: { color: '#374151', font: { size: 12 }, boxWidth: 16 },
      },
      tooltip: {
        backgroundColor: '#ffffff',
        borderColor: '#e2e5ec',
        borderWidth: 1,
        titleColor: '#111827',
        bodyColor: '#374151',
        callbacks: {
          title: (items) => `Tiempo: ${secToMmss(Math.round(items[0].parsed.x ?? 0))}`,
          label: (item) => ` ${item.dataset.label}: ${(item.parsed.y ?? 0).toFixed(0)} ppm`,
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        ticks: {
          callback: (val) => secToMmss(val as number),
          maxTicksLimit: 10,
          color: '#6b7280',
          font: { size: 11 },
        },
        grid: { color: '#e5e8ef' },
        title: { display: true, text: 'Tiempo', color: '#6b7280', font: { size: 11 } },
      },
      y: {
        ticks: { color: '#6b7280', font: { size: 11 } },
        grid: { color: '#e5e8ef' },
        title: { display: true, text: 'FC (ppm)', color: '#6b7280', font: { size: 11 } },
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
          label: `${this.refName} (referencia)`,
          data: refPts,
          borderColor: '#1d4ed8',
          backgroundColor: 'rgba(29,78,216,0.07)',
          fill: { target: 1, above: 'rgba(29,78,216,0.08)', below: 'rgba(220,38,38,0.08)' } as any,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.3,
        },
        {
          label: this.devName,
          data: devPts,
          borderColor: '#dc2626',
          backgroundColor: 'rgba(220,38,38,0.07)',
          fill: false,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.3,
        },
      ],
    };
  }

  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    document.body.style.overflow = this.fullscreen ? 'hidden' : '';
    // Allow chart to resize after layout change
    setTimeout(() => this.chartRef?.chart?.resize(), 50);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.fullscreen) this.toggleFullscreen();
  }

  download(): void {
    const canvas = this.chartRef?.chart?.canvas;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `${this.devName}-vs-${this.refName}-fc-temporal.png`;
    a.click();
  }
}

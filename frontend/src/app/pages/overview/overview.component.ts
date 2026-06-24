import { Component, OnInit } from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

import { ApiService } from '../../services/api.service';
import { OverviewEntry, SportType, SPORT_TYPE_LABELS } from '../../models/session.model';
import { GpsOverviewEntry } from '../../models/gps-analysis.model';

// ── Colour thresholds ─────────────────────────────────────────────
export function colorForR(r: number): string {
  if (r >= 0.95) return 'var(--good)';
  if (r >= 0.90) return 'var(--warn)';
  if (r >= 0.80) return 'var(--orange)';
  return 'var(--bad)';
}
export function qualityR(r: number): string {
  if (r >= 0.95) return 'good';
  if (r >= 0.90) return 'warn';
  if (r >= 0.80) return 'orange';
  return 'bad';
}
export function qualityMAE(m: number): string {
  if (m <= 3)  return 'good';
  if (m <= 5)  return 'warn';
  if (m <= 10) return 'orange';
  return 'bad';
}
export function qualityCCC(c: number): string {
  if (c >= 0.95) return 'good';
  if (c >= 0.90) return 'warn';
  if (c >= 0.80) return 'orange';
  return 'bad';
}

// ── Types ─────────────────────────────────────────────────────────
export interface LollipopItem {
  entry:   OverviewEntry;
  color:   string;
  quality: string;
  cx:      number;
  cy:      number;
  x0:      number;
  labelX:  number;
}

export interface GpsLollipopItem {
  entry:   GpsOverviewEntry;
  color:   string;
  cx:      number;
  cy:      number;
  x0:      number;
  labelX:  number;
}

export type VizMode = 'lollipop' | 'bars' | 'radar' | 'table';

// ── SVG layout constants (design spec: rowH=56, ML=220, MR=90, W=1080) ────
const ML =  220; // margin left  (device name area)
const MR =   90; // margin right (r label + padding)
const MT =   30; // margin top
const MB =   44; // margin bottom (x-axis)
const RH =   56; // row height
const SW = 1080; // SVG viewBox width (matches design reference)

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [
    CommonModule, RouterModule, FormsModule, DecimalPipe, MatIconModule,
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

  // ── Chart state ──────────────────────────────────────────────────
  items:    LollipopItem[] = [];
  svgHeight = 0;
  xMin      = 0.7;
  xMax      = 1.0;
  xTicks:   number[] = [];
  refLines: { r: number; label: string; x: number }[] = [];
  chartW    = SW - ML - MR;

  // ── Viz switcher ─────────────────────────────────────────────────
  viz: VizMode = 'lollipop';

  // ── GPS lollipop ─────────────────────────────────────────────────
  gpsItems:     GpsLollipopItem[] = [];
  gpsSvgHeight  = 0;
  gpsChartW     = SW - ML - MR;


  // Expose layout to template
  readonly ML = ML;
  readonly MT = MT;
  readonly MB = MB;
  readonly SW = SW;

  constructor(private api: ApiService) {}

  ngOnInit(): void { this.load(); this.loadGps(); }

  load(): void {
    this.loading = true;
    this.error   = '';
    this.entries = [];

    this.api.getOverviewData(this.selectedSport).subscribe({
      next:  data  => { this.entries = data; this._build(data); this.loading = false; },
      error: err   => { this.error = err.error?.detail || 'Error al cargar datos'; this.loading = false; },
    });
  }

  loadGps(): void {
    this.api.getOverviewGpsScores().subscribe({
      next:  data => this._buildGps(data),
      error: ()   => {},  // no GPS scores yet — silent
    });
  }

  // ── Private ───────────────────────────────────────────────────────
  private _buildGps(entries: GpsOverviewEntry[]): void {
    if (!entries.length) { this.gpsItems = []; return; }
    this.gpsSvgHeight = entries.length * RH + MT + MB;
    this.gpsItems = entries.map((entry, i) => {
      const cy = MT + i * RH + RH / 2;
      const cx = (entry.global_score / 100) * this.gpsChartW;
      const x0 = 0;
      return { entry, color: this._gpsColor(entry.global_score), cx, cy, x0, labelX: cx + 14 };
    });
  }

  private _gpsColor(v: number): string {
    if (v >= 85) return 'var(--good)';
    if (v >= 70) return 'var(--warn)';
    if (v >= 50) return 'var(--orange)';
    return 'var(--bad)';
  }

  gpsTickPx(v: number): number { return (v / 100) * this.gpsChartW; }
  readonly gpsTicks = [0, 20, 40, 60, 70, 80, 85, 90, 100];
  readonly gpsRefLines = [
    { v: 70, label: '70' },
    { v: 85, label: '85' },
  ];

  private _build(entries: OverviewEntry[]): void {
    if (!entries.length) return;

    const sorted = [...entries].sort((a, b) => a.ccc_global - b.ccc_global); // worst → best by CCC

    const minC = Math.min(...sorted.map(e => e.ccc_global));
    this.xMin  = Math.max(0.0, Math.floor((minC - 0.05) * 20) / 20);
    this.xMax  = 1.02;

    const range = this.xMax - this.xMin;

    // X ticks every 0.05
    this.xTicks = [];
    let t = Math.ceil(this.xMin * 20) / 20;
    while (t <= 1.0 + 1e-9) { this.xTicks.push(+t.toFixed(2)); t = +(t + 0.05).toFixed(2); }

    // Reference lines at 0.80, 0.90, 0.95
    this.refLines = [
      { r: 0.80, label: '0.80', x: this._xPx(0.80, range) },
      { r: 0.90, label: '0.90', x: this._xPx(0.90, range) },
      { r: 0.95, label: '0.95', x: this._xPx(0.95, range) },
    ].filter(l => l.r > this.xMin);

    this.svgHeight = sorted.length * RH + MT + MB;

    const x0 = this._xPx(this.xMin, range);

    this.items = sorted.map((entry, i) => {
      const cy = MT + i * RH + RH / 2;
      const cx = this._xPx(entry.ccc_global, range);
      return {
        entry,
        color:   colorForR(entry.ccc_global),
        quality: qualityCCC(entry.ccc_global),
        cx,
        cy,
        x0,
        labelX:  cx + 14,
      };
    });
  }

  private _xPx(r: number, range = this.xMax - this.xMin): number {
    return (r - this.xMin) / range * this.chartW;
  }

  xTickPx(r: number): number { return this._xPx(r); }

  /** Sorted best-first (for bars + table views) */
  get itemsBestFirst(): LollipopItem[] {
    return [...this.items].reverse();
  }

  /** Bar width as % (0–100) for the bars view */
  barWidth(v: number): number {
    const range = this.xMax - this.xMin;
    return Math.max(0, (v - this.xMin) / range * 100);
  }

  /** Verdict for the #1 device (best CCC) */
  get topItem(): LollipopItem | null {
    return this.items.length ? this.items[this.items.length - 1] : null;
  }

  get refLabel(): string { return this.entries[0]?.reference_name ?? ''; }
  biasSign(v: number): string { return v > 0 ? '+' : ''; }
  qualityMAEClass(v: number): string { return qualityMAE(v); }
  qualityRClass(v: number): string { return qualityR(v); }
  qualityCCCClass(v: number): string { return qualityCCC(v); }
  lagLabel(s: number | null | undefined): string {
    if (s == null || isNaN(s) || s === 0) return '0 s';
    return (s > 0 ? '+' : '') + s.toFixed(1) + ' s';
  }

  // ── Radar chart ───────────────────────────────────────────────────

  readonly RADAR_COLORS = [
    'oklch(52% 0.14 240)',
    'oklch(58% 0.13 155)',
    'oklch(65% 0.16 45)',
  ];

  /** Top-3 devices for the radar chart (best CCC first) */
  get radarTop3(): OverviewEntry[] {
    return [...this.entries].sort((a, b) => b.ccc_global - a.ccc_global).slice(0, 3);
  }

  /** Normalise a metric to [0,1] for radar plotting */
  radarNorm(entry: OverviewEntry, axis: string): number {
    const maxSessions = Math.max(...this.entries.map(e => e.session_count), 1);
    switch (axis) {
      case 'CCC':      return Math.max(0, (entry.ccc_global - 0.7) / 0.3);
      case 'mae':      return Math.max(0, 1 - entry.mae_global / 12);
      case 'bias':     return Math.max(0, 1 - Math.abs(entry.bias_global) / 8);
      case 'sesiones': return Math.min(1, entry.session_count / Math.max(maxSessions, 1));
      default:         return 0;
    }
  }

  /** SVG polygon points string for one radar entry */
  radarPoints(entry: OverviewEntry): string {
    const axes = ['CCC', 'mae', 'bias', 'sesiones'];
    const cx = 210, cy = 195, R = 130;
    return axes.map((axis, i) => {
      const angle = -Math.PI / 2 + (i / axes.length) * Math.PI * 2;
      const v = this.radarNorm(entry, axis);
      return `${cx + Math.cos(angle) * R * v},${cy + Math.sin(angle) * R * v}`;
    }).join(' ');
  }

  /** SVG polygon points for a grid ring */
  radarGrid(scale: number): string {
    const axes = 4;
    const cx = 210, cy = 195, R = 130;
    return Array.from({ length: axes }, (_, i) => {
      const angle = -Math.PI / 2 + (i / axes) * Math.PI * 2;
      return `${cx + Math.cos(angle) * R * scale},${cy + Math.sin(angle) * R * scale}`;
    }).join(' ');
  }

  /** Axis label positions for radar */
  radarAxes(): { label: string; x: number; y: number }[] {
    const labels = ['CCC', 'MAE', '|bias|', 'sesiones'];
    const cx = 210, cy = 195, R = 148;
    return labels.map((label, i) => {
      const angle = -Math.PI / 2 + (i / labels.length) * Math.PI * 2;
      return { label, x: cx + Math.cos(angle) * R, y: cy + Math.sin(angle) * R };
    });
  }

  /** Axis spoke endpoints for radar */
  radarSpoke(i: number): { x: number; y: number } {
    const cx = 210, cy = 195, R = 130;
    const angle = -Math.PI / 2 + (i / 4) * Math.PI * 2;
    return { x: cx + Math.cos(angle) * R, y: cy + Math.sin(angle) * R };
  }

  readonly radarCx = 210;
  readonly radarCy = 195;
}

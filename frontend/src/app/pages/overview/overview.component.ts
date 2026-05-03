import { Component, OnInit, ElementRef } from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';

import { ApiService } from '../../services/api.service';
import { OverviewEntry, SportType, SPORT_TYPE_LABELS } from '../../models/session.model';

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

export type VizMode = 'lollipop' | 'bars' | 'table';

// ── SVG layout constants (design spec: rowH=56, ML=220, MR=90) ────
const ML = 220; // margin left  (device name area)
const MR =  90; // margin right (r label + padding)
const MT =  30; // margin top
const MB =  44; // margin bottom (x-axis)
const RH =  56; // row height
const SW = 860; // SVG viewBox width

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [
    CommonModule, RouterModule, FormsModule, DecimalPipe,
    MatCardModule, MatButtonModule, MatButtonToggleModule, MatIconModule,
    MatProgressSpinnerModule,
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

  // ── Tooltip ──────────────────────────────────────────────────────
  hovered: LollipopItem | null = null;
  tooltipX = 0;
  tooltipY = 0;

  // Expose layout to template
  readonly ML = ML;
  readonly MT = MT;
  readonly MB = MB;
  readonly SW = SW;

  constructor(private api: ApiService, private elRef: ElementRef) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    this.error   = '';
    this.entries = [];
    this.hovered = null;

    this.api.getOverviewData(this.selectedSport).subscribe({
      next:  data  => { this.entries = data; this._build(data); this.loading = false; },
      error: err   => { this.error = err.error?.detail || 'Error al cargar datos'; this.loading = false; },
    });
  }

  // ── Private ───────────────────────────────────────────────────────
  private _build(entries: OverviewEntry[]): void {
    if (!entries.length) return;

    const sorted = [...entries].sort((a, b) => a.r_global - b.r_global); // worst → best

    const minR = Math.min(...sorted.map(e => e.r_global));
    this.xMin  = Math.max(0.50, Math.floor((minR - 0.05) * 20) / 20);
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
      const cy  = MT + (sorted.length - 1 - i) * RH + RH / 2;
      const cx  = this._xPx(entry.r_global, range);
      return {
        entry,
        color:   colorForR(entry.r_global),
        quality: qualityR(entry.r_global),
        cx,
        cy,
        x0,
        labelX: cx + 14,
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
  barWidth(r: number): number {
    const range = this.xMax - this.xMin;
    return Math.max(0, (r - this.xMin) / range * 100);
  }

  /** Verdict for the #1 device */
  get topItem(): LollipopItem | null {
    return this.items.length ? this.items[this.items.length - 1] : null;
  }

  // ── Tooltip handlers ──────────────────────────────────────────────
  onLollipopEnter(event: MouseEvent, item: LollipopItem): void {
    this.hovered = item;
    this._positionTooltip(event);
  }
  onLollipopMove(event: MouseEvent): void {
    if (this.hovered) this._positionTooltip(event);
  }
  onLollipopLeave(): void { this.hovered = null; }

  private _positionTooltip(event: MouseEvent): void {
    const rect = this.elRef.nativeElement.getBoundingClientRect();
    this.tooltipX = event.clientX - rect.left + 14;
    this.tooltipY = event.clientY - rect.top  - 10;
  }

  get refLabel(): string { return this.entries[0]?.reference_name ?? ''; }
  biasSign(v: number): string { return v > 0 ? '+' : ''; }
  qualityMAEClass(v: number): string { return qualityMAE(v); }
  qualityRClass(v: number): string { return qualityR(v); }
}

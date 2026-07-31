import { Component, OnInit } from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

import { ApiService } from '../../services/api.service';
import { OverviewEntry, SportType, SPORT_TYPE_LABELS } from '../../models/session.model';
import { GpsOverviewEntry } from '../../models/gps-analysis.model';
import { HrvOverviewEntry } from '../../models/hrv-analysis.model';

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

export interface HrvLollipopItem {
  entry: HrvOverviewEntry;
  score: number | null;
  color: string;
  cx: number;
  cy: number;
  labelX: number;
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

  // ── Device visibility filter ─────────────────────────────────────
  hiddenDeviceIds = new Set<string>();

  toggleDevice(id: string): void {
    if (this.hiddenDeviceIds.has(id)) {
      this.hiddenDeviceIds.delete(id);
    } else {
      this.hiddenDeviceIds.add(id);
    }
  }

  isHidden(id: string): boolean { return this.hiddenDeviceIds.has(id); }

  /** Items filtered by visibility, with Y positions recomputed (no gaps). */
  get visibleItems(): LollipopItem[] {
    const filtered = this.items.filter(it => !this.hiddenDeviceIds.has(it.entry.device_id));
    return filtered.map((item, i) => ({ ...item, cy: MT + i * RH + RH / 2 }));
  }

  get svgHeightVisible(): number {
    const n = this.items.filter(it => !this.hiddenDeviceIds.has(it.entry.device_id)).length;
    return n * RH + MT + MB;
  }

  // ── GPS lollipop ─────────────────────────────────────────────────
  gpsItems:     GpsLollipopItem[] = [];
  gpsSvgHeight  = 0;
  gpsChartW     = SW - ML - MR;

  // ── HRV global comparison ───────────────────────────────────────
  hrvScores: HrvOverviewEntry[] = [];
  hrvItems: HrvLollipopItem[] = [];
  restHrItems: HrvLollipopItem[] = [];
  hrvSvgHeight = 0;
  restHrSvgHeight = 0;
  hrvChartW = SW - ML - MR;


  // Expose layout to template
  readonly ML = ML;
  readonly MT = MT;
  readonly MB = MB;
  readonly SW = SW;

  constructor(private api: ApiService) {}

  ngOnInit(): void { this.load(); this.loadGps(); this.loadHrv(); }

  refreshAll(): void {
    this.load();
    this.loadGps();
    this.loadHrv();
  }

  load(): void {
    this.loading = true;
    this.error   = '';
    this.entries = [];
    this.hiddenDeviceIds.clear();

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

  loadHrv(): void {
    this.api.getOverviewHrvScores().subscribe({
      next:  data => this._buildHrv(data),
      error: ()   => {
        this.hrvScores = [];
        this.hrvItems = [];
        this.restHrItems = [];
        this.hrvSvgHeight = 0;
        this.restHrSvgHeight = 0;
      },
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

  private _buildHrv(entries: HrvOverviewEntry[]): void {
    this.hrvScores = entries;
    this.hrvItems = this._buildHrvMetric(entries, 'hrv_score');
    this.restHrItems = this._buildHrvMetric(entries, 'hr_score');
    this.hrvSvgHeight = this.hrvItems.length * RH + MT + MB;
    this.restHrSvgHeight = this.restHrItems.length * RH + MT + MB;
  }

  private _buildHrvMetric(entries: HrvOverviewEntry[], metric: 'hrv_score' | 'hr_score'): HrvLollipopItem[] {
    return [...entries]
      .filter(entry => entry[metric] != null)
      .sort((a, b) => (a[metric] ?? -1) - (b[metric] ?? -1))
      .map((entry, i) => {
        const score = entry[metric];
        const cx = this.hrvTickPx(score ?? 0);
        return {
          entry,
          score,
          color: this.scoreColor(score),
          cx,
          cy: MT + i * RH + RH / 2,
          labelX: cx + 14,
        };
      });
  }

  scoreLabel(v: number | null): string {
    return v != null ? v.toFixed(1) : '—';
  }

  scoreQuality(v: number | null): string {
    if (v == null) return 'empty';
    if (v >= 95) return 'good';
    if (v >= 90) return 'warn';
    if (v >= 80) return 'orange';
    return 'bad';
  }

  scoreColor(v: number | null): string {
    if (v == null) return 'var(--ink-4)';
    if (v >= 95) return 'var(--good)';
    if (v >= 90) return 'var(--warn)';
    if (v >= 80) return 'var(--orange)';
    return 'var(--bad)';
  }

  hrvTickPx(v: number): number {
    return Math.max(0, Math.min(100, v)) / 100 * this.hrvChartW;
  }

  readonly hrvTicks = [0, 20, 40, 60, 80, 90, 95, 100];
  readonly hrvRefLines = [
    { v: 80, label: '80' },
    { v: 90, label: '90' },
    { v: 95, label: '95' },
  ];

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

  // ── Export ───────────────────────────────────────────────────────

  exportHrvChart(metric: 'hrv' | 'restHr'): void {
    const items = metric === 'hrv' ? this.hrvItems : this.restHrItems;
    if (!items.length) return;

    const isHrv = metric === 'hrv';
    const title = isHrv ? 'Ranking HRV global' : 'Ranking FC reposo global';
    const metricLabel = isHrv ? 'Puntuación VFC nocturna' : 'Puntuación FC reposo';
    const filename = isHrv ? 'ranking-hrv-global' : 'ranking-fc-reposo-global';
    const date = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });

    const LML = ML;
    const LMT = MT;
    const LMB = MB;
    const LRH = RH;
    const LCW = this.hrvChartW;
    const LSW = SW;
    const n = items.length;
    const LSH = n * LRH + LMT + LMB;
    const pH = 80;
    const pF = 60;
    const TH = LSH + pH + pF;
    const dpr = 4;

    const cv = document.createElement('canvas');
    cv.width = LSW * dpr;
    cv.height = TH * dpr;
    const c = cv.getContext('2d')!;
    c.scale(dpr, dpr);

    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, LSW, TH);

    c.fillStyle = '#6366f1';
    c.fillRect(0, 0, 4, pH);

    c.fillStyle = '#111827';
    c.font = '700 17px "Inter Tight", system-ui, sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText(title, 16, 14);

    c.fillStyle = '#6b7280';
    c.font = '12px "Inter Tight", system-ui, sans-serif';
    c.fillText(`${n} dispositivo${n !== 1 ? 's' : ''}  ·  ${metricLabel} guardada  ·  0-100`, 16, 36);

    c.fillStyle = '#9ca3af';
    c.font = '10px "Inter Tight", system-ui, sans-serif';
    c.fillText('Eje X: puntuación global  ·  ordenado de peor a mejor', 16, 56);

    c.textAlign = 'right';
    c.fillStyle = '#9ca3af';
    c.font = '10px "Inter Tight", system-ui, sans-serif';
    c.fillText(date, LSW - 16, 14);

    c.strokeStyle = '#e5e7eb';
    c.lineWidth = 1;
    c.setLineDash([]);
    c.beginPath(); c.moveTo(0, pH - 1); c.lineTo(LSW, pH - 1); c.stroke();

    c.save();
    c.translate(0, pH);

    for (const ref of this.hrvRefLines) {
      const x = LML + this._scoreXPx(ref.v);
      c.strokeStyle = '#e5e7eb';
      c.lineWidth = 1;
      c.setLineDash([3, 4]);
      c.beginPath(); c.moveTo(x, LMT); c.lineTo(x, LSH - LMB); c.stroke();
      c.setLineDash([]);
      c.fillStyle = '#9ca3af';
      c.font = '11px "Inter Tight", system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'alphabetic';
      c.fillText(ref.label, x, LMT - 8);
    }

    c.strokeStyle = '#d1d5db';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(LML, LSH - LMB); c.lineTo(LML + LCW, LSH - LMB); c.stroke();

    c.fillStyle = '#9ca3af';
    c.font = '10px "Inter Tight", system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText(`${metricLabel} global · 0-100`, LML + LCW / 2, LSH - 8);

    for (const tick of this.hrvTicks) {
      const x = LML + this._scoreXPx(tick);
      c.strokeStyle = '#d1d5db';
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, LSH - LMB); c.lineTo(x, LSH - LMB + 5); c.stroke();
      c.fillStyle = '#9ca3af';
      c.font = '11px "Inter Tight", system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'top';
      c.fillText(String(tick), x, LSH - LMB + 8);
    }

    for (const item of items) {
      const col = this.scoreHexColor(item.score);
      const dotX = LML + this._scoreXPx(item.score ?? 0);
      const dotY = item.cy;

      c.strokeStyle = '#f3f4f6';
      c.lineWidth = 1;
      c.setLineDash([]);
      c.beginPath(); c.moveTo(LML, dotY); c.lineTo(LML + LCW, dotY); c.stroke();

      c.strokeStyle = col;
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(LML, dotY); c.lineTo(dotX, dotY); c.stroke();

      c.fillStyle = col;
      c.beginPath(); c.arc(dotX, dotY, 6, 0, Math.PI * 2); c.fill();

      c.fillStyle = col;
      c.font = '600 12px "Inter Tight", system-ui, sans-serif';
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillText(this.scoreLabel(item.score), dotX + 14, dotY);

      c.fillStyle = '#111827';
      c.font = '13px "Inter Tight", system-ui, sans-serif';
      c.textAlign = 'right';
      c.textBaseline = 'alphabetic';
      c.fillText(item.entry.name, LML - 14, dotY + 4);

      c.fillStyle = '#9ca3af';
      c.font = '10px "Inter Tight", system-ui, sans-serif';
      c.fillText(`${item.entry.n_sessions} sesión${item.entry.n_sessions !== 1 ? 'es' : ''}`, LML - 14, dotY + 17);
    }

    c.restore();

    c.strokeStyle = '#e5e7eb';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, pH + LSH + 1); c.lineTo(LSW, pH + LSH + 1); c.stroke();

    const sorted = [...items].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const best = sorted[0];
    const avg = items.reduce((s, item) => s + (item.score ?? 0), 0) / items.length;
    const fTop = pH + LSH;
    const fCy = fTop + pF / 2;
    const stats = [
      { label: 'Mejor dispositivo', value: best.entry.name, color: this.scoreHexColor(best.score) },
      { label: 'Puntuación mejor', value: this.scoreLabel(best.score), color: this.scoreHexColor(best.score) },
      { label: 'Promedio', value: avg.toFixed(1), color: this.scoreHexColor(avg) },
      { label: 'Dispositivos', value: `${items.length}` },
    ];
    const slotW = LSW / stats.length;

    stats.forEach((st, i) => {
      const cx = i * slotW + slotW / 2;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = '#9ca3af';
      c.font = '9px "Inter Tight", system-ui, sans-serif';
      c.fillText(st.label.toUpperCase(), cx, fCy - 12);
      c.fillStyle = st.color ?? '#111827';
      c.font = '600 13px "Inter Tight", system-ui, sans-serif';
      c.fillText(st.value, cx, fCy + 8);
      if (i > 0) {
        c.strokeStyle = '#e5e7eb';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(i * slotW, fTop + 12);
        c.lineTo(i * slotW, fTop + pF - 12);
        c.stroke();
      }
    });

    this.downloadCanvas(cv, `${filename}-${date.replace(/ /g, '-')}.png`);
  }

  exportOverviewChart(): void {
    const visible = this.visibleItems;
    if (!visible.length) return;

    // Colors hardcoded to avoid unresolvable CSS variables in canvas
    const colorFn = (ccc: number): string => {
      if (ccc >= 0.95) return '#10b981';
      if (ccc >= 0.90) return '#d97706';
      if (ccc >= 0.80) return '#f97316';
      return '#ef4444';
    };

    const SPORT_LBL: Record<string, string> = { running: 'Running', cycling: 'Ciclismo', gym: 'Gimnasio' };
    const sportLbl = SPORT_LBL[this.selectedSport] ?? this.selectedSport;
    const ref      = this.refLabel;
    const date     = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });

    // Layout constants (match SVG design)
    const LML  = ML;   // left margin = 220
    const LMR  = MR;   // right margin = 90
    const LMT  = MT;   // top margin = 30
    const LMB  = MB;   // bottom margin = 44
    const LRH  = RH;   // row height = 56
    const LCW  = this.chartW;   // = 770
    const LSW  = SW;             // = 1080
    const n    = visible.length;
    const LSH  = n * LRH + LMT + LMB;  // chart SVG height

    const pH  = 80;   // header logical px
    const pF  = 60;   // footer logical px
    const TH  = LSH + pH + pF;  // total logical height

    // Match the high-resolution PNGs exported by nocturnal HRV and Chart.js views.
    const dpr = 4;
    const cv  = document.createElement('canvas');
    cv.width  = LSW * dpr;
    cv.height = TH  * dpr;
    const c   = cv.getContext('2d')!;
    c.scale(dpr, dpr);

    // ── Background ───────────────────────────────────────────────
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, LSW, TH);

    // ── Accent bar ───────────────────────────────────────────────
    c.fillStyle = '#6366f1';
    c.fillRect(0, 0, 4, pH);

    // ── Title ────────────────────────────────────────────────────
    c.fillStyle = '#111827';
    c.font = '700 17px "Inter Tight", system-ui, sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText(`Ranking de wearables · ${sportLbl}`, 16, 14);

    c.fillStyle = '#6b7280';
    c.font = '12px "Inter Tight", system-ui, sans-serif';
    c.fillText(`${n} dispositivo${n !== 1 ? 's' : ''}  ·  referencia: ${ref}  ·  CCC de Lin`, 16, 36);

    c.fillStyle = '#9ca3af';
    c.font = '10px "Inter Tight", system-ui, sans-serif';
    c.fillText('Eje X: CCC de Lin ponderado por dificultad de sesión  ·  ordenado de peor a mejor', 16, 56);

    c.textAlign = 'right';
    c.fillStyle = '#9ca3af';
    c.font = '10px "Inter Tight", system-ui, sans-serif';
    c.fillText(date, LSW - 16, 14);

    // ── Header divider ────────────────────────────────────────────
    c.strokeStyle = '#e5e7eb';
    c.lineWidth = 1;
    c.setLineDash([]);
    c.beginPath(); c.moveTo(0, pH - 1); c.lineTo(LSW, pH - 1); c.stroke();

    // ── Chart area ────────────────────────────────────────────────
    c.save();
    c.translate(0, pH);

    // Reference lines
    for (const rl of this.refLines) {
      const x = LML + rl.x;
      c.strokeStyle = '#e5e7eb';
      c.lineWidth = 1;
      c.setLineDash([3, 4]);
      c.beginPath(); c.moveTo(x, LMT); c.lineTo(x, LSH - LMB); c.stroke();
      c.setLineDash([]);
      c.fillStyle = '#9ca3af';
      c.font = '11px "Inter Tight", system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'alphabetic';
      c.fillText(rl.label, x, LMT - 8);
    }

    // X axis
    c.strokeStyle = '#d1d5db';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(LML, LSH - LMB); c.lineTo(LML + LCW, LSH - LMB); c.stroke();

    // X axis label
    c.fillStyle = '#9ca3af';
    c.font = '10px "Inter Tight", system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText('CCC de Lin · ponderado por dificultad de sesión', LML + LCW / 2, LSH - 8);

    // X ticks
    for (const tick of this.xTicks) {
      const x = LML + (tick - this.xMin) / (this.xMax - this.xMin) * LCW;
      c.strokeStyle = '#d1d5db';
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, LSH - LMB); c.lineTo(x, LSH - LMB + 5); c.stroke();
      c.fillStyle = '#9ca3af';
      c.font = '11px "Inter Tight", system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'top';
      c.fillText(tick.toFixed(2), x, LSH - LMB + 8);
    }

    // Lollipops
    for (const item of visible) {
      const col = colorFn(item.entry.ccc_global);
      const dotX = LML + item.cx;
      const dotY = item.cy;

      // Track line (light grey)
      c.strokeStyle = '#f3f4f6';
      c.lineWidth = 1;
      c.setLineDash([]);
      c.beginPath(); c.moveTo(LML, dotY); c.lineTo(LML + LCW, dotY); c.stroke();

      // Stem
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(LML, dotY); c.lineTo(dotX, dotY); c.stroke();

      // Dot
      c.fillStyle = col;
      c.beginPath(); c.arc(dotX, dotY, 6, 0, Math.PI * 2); c.fill();

      // CCC value
      c.fillStyle = col;
      c.font = '600 12px "Inter Tight", system-ui, sans-serif';
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillText(item.entry.ccc_global.toFixed(3), dotX + 14, dotY);

      // Device name
      c.fillStyle = '#111827';
      c.font = '13px "Inter Tight", system-ui, sans-serif';
      c.textAlign = 'right';
      c.textBaseline = 'alphabetic';
      c.fillText(item.entry.name, LML - 14, dotY + 4);

      // Session count & lag (smaller, grey)
      c.fillStyle = '#9ca3af';
      c.font = '10px "Inter Tight", system-ui, sans-serif';
      const sub: string[] = [`${item.entry.session_count} ses.`];
      if (item.entry.lag_mean) sub.push(`lag ${this.lagLabel(item.entry.lag_mean)}`);
      c.fillText(sub.join(' · '), LML - 14, dotY + 17);
    }

    c.restore();

    // ── Footer divider ────────────────────────────────────────────
    c.strokeStyle = '#e5e7eb';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, pH + LSH + 1); c.lineTo(LSW, pH + LSH + 1); c.stroke();

    // ── Footer stats ──────────────────────────────────────────────
    const sorted  = [...visible].sort((a, b) => b.entry.ccc_global - a.entry.ccc_global);
    const best    = sorted[0];
    const worst   = sorted[sorted.length - 1];
    const avgCCC  = visible.reduce((s, it) => s + it.entry.ccc_global, 0) / visible.length;

    type Stat = { label: string; value: string; color?: string };
    const stats: Stat[] = [
      { label: 'Mejor dispositivo', value: best.entry.name,                   color: colorFn(best.entry.ccc_global) },
      { label: 'CCC mejor',         value: best.entry.ccc_global.toFixed(3),  color: colorFn(best.entry.ccc_global) },
      { label: 'CCC promedio',      value: avgCCC.toFixed(3),                 color: colorFn(avgCCC) },
      { label: 'MAE mejor',         value: `${best.entry.mae_global?.toFixed(1) ?? '—'}%` },
      { label: 'Dispositivos',      value: `${visible.length}` },
    ];

    const fTop  = pH + LSH;
    const fCy   = fTop + pF / 2;
    const slotW = LSW / stats.length;

    stats.forEach((st, i) => {
      const cx = i * slotW + slotW / 2;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = '#9ca3af';
      c.font = '9px "Inter Tight", system-ui, sans-serif';
      c.fillText(st.label.toUpperCase(), cx, fCy - 12);
      c.fillStyle = st.color ?? '#111827';
      c.font = '600 13px "Inter Tight", system-ui, sans-serif';
      c.fillText(st.value, cx, fCy + 8);
      if (i > 0) {
        c.strokeStyle = '#e5e7eb';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(i * slotW, fTop + 12);
        c.lineTo(i * slotW, fTop + pF - 12);
        c.stroke();
      }
    });

    // ── Download ──────────────────────────────────────────────────
    const a = document.createElement('a');
    a.href     = cv.toDataURL('image/png');
    a.download = `ranking-${this.selectedSport}-${date.replace(/ /g, '-')}.png`;
    a.click();
  }

  private _scoreXPx(v: number): number {
    return Math.max(0, Math.min(100, v)) / 100 * this.hrvChartW;
  }

  scoreHexColor(v: number | null): string {
    if (v == null) return '#9ca3af';
    if (v >= 95) return '#10b981';
    if (v >= 90) return '#d97706';
    if (v >= 80) return '#f97316';
    return '#ef4444';
  }

  private downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = filename;
    a.click();
  }

  /** Sorted best-first, visibility filtered (for bars + table + radar views) */
  get itemsBestFirst(): LollipopItem[] {
    return [...this.items]
      .filter(it => !this.hiddenDeviceIds.has(it.entry.device_id))
      .reverse();
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

  /** Top-3 visible devices for the radar chart (best CCC first) */
  get radarTop3(): OverviewEntry[] {
    return [...this.entries]
      .filter(e => !this.hiddenDeviceIds.has(e.device_id))
      .sort((a, b) => b.ccc_global - a.ccc_global)
      .slice(0, 3);
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

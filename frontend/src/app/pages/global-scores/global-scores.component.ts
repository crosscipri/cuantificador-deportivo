import { Component, OnInit } from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { ApiService } from '../../services/api.service';
import { Device, OverviewEntry } from '../../models/session.model';
import { GpsOverviewEntry } from '../../models/gps-analysis.model';
import { HrvOverviewEntry } from '../../models/hrv-analysis.model';

export interface DeviceScoreRow {
  deviceId:   string;
  name:       string;
  fcScore:    number | null;
  gpsScore:   number | null;
  hrvScore:   number | null;
  hrScore:    number | null;
  totalScore: number | null;
  isCurrent:  boolean;
}

// ── SVG chart layout constants ─────────────────────────────────────────────
const ML  = 180;   // left margin (device name)
const MR  = 54;    // right margin
const MT  = 24;    // top margin
const MB  = 20;    // bottom margin
const RH  = 24;    // row height per metric band
const GH  = 48;    // total height per device (2 rows + gap)
const SW  = 900;   // SVG viewBox width
const CW  = SW - ML - MR;

const METRIC_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#0ea5e9'] as const;
const METRIC_LABELS = ['FC Global', 'GPS', 'VFC', 'FC Reposo'] as const;

@Component({
  selector: 'app-global-scores',
  standalone: true,
  imports: [CommonModule, RouterModule, DecimalPipe],
  templateUrl: './global-scores.component.html',
  styleUrls: ['./global-scores.component.scss'],
})
export class GlobalScoresComponent implements OnInit {
  deviceId = '';
  device: Device | null = null;
  loading = true;
  error = '';

  currentScores: DeviceScoreRow | null = null;
  allScores: DeviceScoreRow[] = [];

  // Expose to template
  readonly ML = ML;
  readonly MT = MT;
  readonly MB = MB;
  readonly GH = GH;
  readonly SW = SW;
  readonly CW = CW;
  readonly METRIC_COLORS = METRIC_COLORS;
  readonly METRIC_LABELS = METRIC_LABELS;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ApiService,
  ) {}

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get('deviceId') || '';
    if (!this.deviceId) { this.router.navigate(['/devices']); return; }
    this.load();
  }

  load(): void {
    this.loading = true;
    this.error = '';

    forkJoin({
      device:  this.api.getDevice(this.deviceId),
      running: this.api.getOverviewData('running').pipe(catchError(() => of([]))),
      cycling: this.api.getOverviewData('cycling').pipe(catchError(() => of([]))),
      gym:     this.api.getOverviewData('gym').pipe(catchError(() => of([]))),
      gps:     this.api.getOverviewGpsScores().pipe(catchError(() => of([]))),
      hrv:     this.api.getOverviewHrvScores().pipe(catchError(() => of([]))),
    }).subscribe({
      next: ({ device, running, cycling, gym, gps, hrv }) => {
        this.device = device;
        this._computeScores(running, cycling, gym, gps, hrv);
        this.loading = false;
      },
      error: () => {
        this.error = 'Error al cargar los datos';
        this.loading = false;
      },
    });
  }

  private _computeScores(
    running: OverviewEntry[], cycling: OverviewEntry[], gym: OverviewEntry[],
    gps: GpsOverviewEntry[], hrv: HrvOverviewEntry[],
  ): void {
    const allDeviceIds = new Set([
      ...running.map(e => e.device_id),
      ...cycling.map(e => e.device_id),
      ...gym.map(e => e.device_id),
      ...gps.map(e => e.device_id),
      ...hrv.map(e => e.device_id),
    ]);

    const rows: DeviceScoreRow[] = [];

    for (const devId of allDeviceIds) {
      const rEntry   = running.find(e => e.device_id === devId);
      const cEntry   = cycling.find(e => e.device_id === devId);
      const gEntry   = gym.find(e => e.device_id === devId);
      const gpsEntry = gps.find(e => e.device_id === devId);
      const hrvEntry = hrv.find(e => e.device_id === devId);

      // FC Global: average of available sport ccc_global values × 100
      const cccVals = [rEntry?.ccc_global, cEntry?.ccc_global, gEntry?.ccc_global]
        .filter((v): v is number => v != null && v > 0);
      const fcScore = cccVals.length > 0
        ? Math.round(cccVals.reduce((a, b) => a + b, 0) / cccVals.length * 1000) / 10
        : null;

      const gpsScore = gpsEntry?.global_score ?? null;
      const hrvScore = hrvEntry?.hrv_score    ?? null;
      const hrScore  = hrvEntry?.hr_score     ?? null;

      const scores = [fcScore, gpsScore, hrvScore, hrScore].filter((v): v is number => v != null);
      const totalScore = scores.length > 0
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10
        : null;

      const name = rEntry?.name ?? cEntry?.name ?? gEntry?.name ?? gpsEntry?.name ?? hrvEntry?.name ?? devId;

      rows.push({
        deviceId: devId, name,
        fcScore, gpsScore, hrvScore, hrScore, totalScore,
        isCurrent: devId === this.deviceId,
      });
    }

    this.allScores = rows.sort((a, b) => (b.totalScore ?? -1) - (a.totalScore ?? -1));
    this.currentScores = rows.find(r => r.isCurrent) ?? null;
  }

  // ── Score badge helpers ───────────────────────────────────────────────────

  /** Thresholds for FC / VFC / FC reposo (match r/CCC correlation scale × 100) */
  scoreClass(v: number | null): string {
    if (v == null) return '';
    if (v >= 95) return 'q-good';
    if (v >= 90) return 'q-warn';
    if (v >= 80) return 'q-orange';
    return 'q-bad';
  }

  scoreLabel(v: number | null): string {
    if (v == null) return '—';
    if (v >= 95) return 'Excelente';
    if (v >= 90) return 'Bueno';
    if (v >= 80) return 'Moderado';
    return 'Deficiente';
  }

  /** GPS-specific thresholds (identical to device-detail gpsScoreColor) */
  gpsScoreClass(v: number | null): string {
    if (v == null) return '';
    if (v >= 85) return 'q-good';
    if (v >= 70) return 'q-warn';
    if (v >= 50) return 'q-orange';
    return 'q-bad';
  }

  gpsScoreLabel(v: number | null): string {
    if (v == null) return '—';
    if (v >= 85) return 'Excelente';
    if (v >= 70) return 'Bueno';
    if (v >= 50) return 'Moderado';
    return 'Deficiente';
  }

  /** Returns the right class depending on which dimension the score belongs to */
  anyScoreClass(v: number | null, dim: 'fc' | 'gps' | 'hrv' | 'hr'): string {
    return dim === 'gps' ? this.gpsScoreClass(v) : this.scoreClass(v);
  }

  formatScore(v: number | null): string {
    return v != null ? v.toFixed(1) : '—';
  }

  // ── SVG comparison chart ──────────────────────────────────────────────────

  get svgChartHeight(): number {
    return this.allScores.length * GH + MT + MB;
  }

  deviceY(i: number): number { return MT + i * GH; }

  barX(score: number | null): number {
    if (score == null) return 0;
    return Math.round((score / 100) * CW);
  }

  metricBars(row: DeviceScoreRow): { color: string; label: string; score: number | null; y: number }[] {
    const metrics: [string, string, number | null][] = [
      [METRIC_COLORS[0], METRIC_LABELS[0], row.fcScore],
      [METRIC_COLORS[1], METRIC_LABELS[1], row.gpsScore],
      [METRIC_COLORS[2], METRIC_LABELS[2], row.hrvScore],
      [METRIC_COLORS[3], METRIC_LABELS[3], row.hrScore],
    ];
    const BH = 8;
    const GAP = 3;
    const totalH = metrics.length * BH + (metrics.length - 1) * GAP;
    const startY = (GH - totalH) / 2;
    return metrics.map(([color, label, score], i) => ({
      color, label, score,
      y: startY + i * (BH + GAP),
    }));
  }

  readonly xTicks = [0, 20, 40, 60, 80, 90, 95, 100];

  xTickPx(v: number): number { return (v / 100) * CW; }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('es-ES', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  }
}

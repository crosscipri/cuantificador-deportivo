import { Component, OnInit, OnDestroy, ChangeDetectorRef, QueryList, ViewChildren } from '@angular/core';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatSelectModule } from '@angular/material/select';

import { ApiService } from '../../services/api.service';
import { Device, Session, AggregateResult, SportAggregateCharts,
         SportType, SessionDifficulty,
         SPORT_TYPE_LABELS, DIFFICULTY_LABELS,
         TRAINING_TYPES_BY_SPORT, SPORT_HAS_DIFFICULTY, GYM_DIFFICULTY,
         WeightedScore, computeWeightedScore, scoreQuality,
         MetricQuality } from '../../models/session.model';
import { GpsTrackModeScore, GpsUrbanModeScore, GpsStoredScores } from '../../models/gps-analysis.model';
import { BaseChartDirective } from 'ng2-charts';
import { ChartViewerComponent } from '../../shared/chart-viewer/chart-viewer.component';
import { MetricsTableComponent } from '../../shared/metrics-table/metrics-table.component';
import { downloadCanvasPng, withHighResolutionChartExport } from '../../shared/chart-export';

interface GpsScoreRow {
  name: string; color: string;
  trackScore: number | null;
  distScore: number | null; pathScore: number | null;
  rmseTrack: number | null; mapeTrack: number | null;
  urbanScore: number | null;
  consistencyScore: number | null;
  rmseUrban: number | null; speedJitter: number | null;
  globalScore: number | null;
}

export interface SessionGroup {
  type: string;
  sessions: Session[];
  expanded: boolean;
  selectedIds: Set<string>;
  aggregate: AggregateResult | null;
  loadingAggregate: boolean;
}

export interface SportTab {
  sportType: SportType;
  label: string;
  icon: string;
  groups: SessionGroup[];
  score: WeightedScore | null;
  scoreQuality: MetricQuality | null;
  sportAggregate: SportAggregateCharts | null;
  loadingSportAggregate: boolean;
  corrData: any;
  baData: any;
}

interface CorrSportPoint { r: number; cx: number; cy: number; }
interface CorrSportCol {
  label: string; cx: number;
  points: CorrSportPoint[];
  hasBox: boolean;
  boxX1: number; boxX2: number; boxY1: number; boxY2: number;
  medianY: number; medianR: number; pct: number; n: number;
}

const SPORT_ICONS: Record<SportType, string> = {
  running: 'directions_run',
  cycling: 'directions_bike',
  gym:     'fitness_center',
};

@Component({
  selector: 'app-device-detail',
  standalone: true,
  imports: [
    CommonModule, RouterModule, ReactiveFormsModule,
    MatInputModule, MatFormFieldModule, MatSnackBarModule, MatSelectModule,
    BaseChartDirective, ChartViewerComponent, MetricsTableComponent,
  ],
  templateUrl: './device-detail.component.html',
  styleUrls: ['./device-detail.component.scss'],
})
export class DeviceDetailComponent implements OnInit, OnDestroy {
  @ViewChildren(BaseChartDirective) sportCharts!: QueryList<BaseChartDirective>;

  device: Device | null = null;
  deviceId = '';
  sportTabs: SportTab[] = [];
  loading = true;

  private readonly SESSION_COLORS = [
    'rgba(99,102,241,0.65)', 'rgba(16,185,129,0.65)', 'rgba(245,158,11,0.65)',
    'rgba(239,68,68,0.65)',  'rgba(139,92,246,0.65)', 'rgba(14,165,233,0.65)',
    'rgba(249,115,22,0.65)', 'rgba(236,72,153,0.65)', 'rgba(20,184,166,0.65)',
    'rgba(234,179,8,0.65)',  'rgba(168,85,247,0.65)', 'rgba(59,130,246,0.65)',
  ];
  private readonly SESSION_COLORS_SOLID = [
    '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9',
    '#f97316', '#ec4899', '#14b8a6', '#eab308', '#a855f7', '#3b82f6',
  ];

  /** Chart.js plugin: draws per-session bias ticks + numbers in the right margin */
  readonly sportBaBiasPlugin: any = {
    id: 'sportBaBias',
    afterDraw(chart: any) {
      const { ctx, chartArea, scales } = chart;
      const biases: { bias: number; color: string }[] = (chart.data as any)._sessionBiases;
      if (!biases?.length || !scales['y']) return;
      const yScale = scales['y'];
      const xTick  = chartArea.right;
      const xText  = chartArea.right + 8;
      ctx.save();
      ctx.font = '600 10px "Inter Tight", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      // compute pixel position + de-overlap (push overlapping labels apart)
      const pts = biases
        .map(b => ({ ...b, yPx: yScale.getPixelForValue(b.bias) }))
        .filter(b => b.yPx >= chartArea.top - 2 && b.yPx <= chartArea.bottom + 2);
      pts.sort((a, b) => a.yPx - b.yPx);
      const minGap = 14;
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].yPx - pts[i - 1].yPx < minGap) {
          pts[i].yPx = pts[i - 1].yPx + minGap;
        }
      }

      pts.forEach(({ bias, color, yPx }) => {
        const sign = bias >= 0 ? '+' : '';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(xTick, yPx);
        ctx.lineTo(xTick + 5, yPx);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText(`${sign}${bias.toFixed(1)}`, xText, yPx);
      });
      ctx.restore();
    },
  };

  gpsTrackData: GpsStoredScores<GpsTrackModeScore> | null = null;
  gpsUrbanData: GpsStoredScores<GpsUrbanModeScore> | null = null;

  showUpload = false;
  uploadForm = this.fb.group({
    sportType:         ['' as SportType,         Validators.required],
    sessionDifficulty: ['' as SessionDifficulty, Validators.required],
    trainingType:      ['',                      Validators.required],
    sessionName:       [''],
  });
  deviceFile:    File | null = null;
  referenceFile: File | null = null;
  uploading = false;

  readonly sportTypes   = Object.entries(SPORT_TYPE_LABELS) as [SportType, string][];
  readonly difficulties = Object.entries(DIFFICULTY_LABELS) as [SessionDifficulty, string][];
  readonly difficultyLabels = DIFFICULTY_LABELS;

  private sportSub?: Subscription;

  get uploadHasDifficulty(): boolean {
    const sport = this.uploadForm.get('sportType')?.value as SportType;
    return sport ? SPORT_HAS_DIFFICULTY[sport] : true;
  }

  get uploadAvailableTrainingTypes(): string[] {
    const sport = this.uploadForm.get('sportType')?.value as SportType;
    return sport ? TRAINING_TYPES_BY_SPORT[sport] : [];
  }

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ApiService,
    private fb: FormBuilder,
    private snack: MatSnackBar,
    private cdRef: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get('deviceId') || '';
    if (!this.deviceId) { this.router.navigate(['/devices']); return; }
    this.loadDevice();
    this.loadGpsScores();

    this.sportSub = this.uploadForm.get('sportType')!.valueChanges.subscribe(sport => {
      this.uploadForm.get('trainingType')!.reset('');
      if (sport === 'gym') {
        this.uploadForm.get('sessionDifficulty')!.setValue(GYM_DIFFICULTY);
      } else {
        this.uploadForm.get('sessionDifficulty')!.reset(null);
      }
    });
  }

  ngOnDestroy(): void { this.sportSub?.unsubscribe(); }

  loadDevice(): void {
    this.loading = true;
    this.api.getDevice(this.deviceId).subscribe({
      next: dev => {
        this.device = dev;
        this.loadSessions();
      },
      error: () => this.router.navigate(['/devices']),
    });
  }

  loadSessions(): void {
    this.api.listDeviceSessions(this.deviceId).subscribe({
      next: sessions => {
        this.buildSportTabs(sessions);
        this.loading = false;
      },
      error: () => { this.loading = false; },
    });
  }

  buildSportTabs(sessions: Session[]): void {
    const sportOrder: SportType[] = ['running', 'cycling', 'gym'];

    // Preserve existing group state across reloads
    const existingGroupMap = new Map<string, SessionGroup>();
    for (const tab of this.sportTabs) {
      for (const g of tab.groups) existingGroupMap.set(`${tab.sportType}::${g.type}`, g);
    }

    this.sportTabs = sportOrder.map(sport => {
      const sportSessions = sessions.filter(s => s.sport_type === sport);

      // Running groups by session_difficulty; others by training_type
      const groupKey = (s: Session) =>
        sport === 'running' ? (s.session_difficulty ?? 'z2') : s.training_type;

      const typeMap = new Map<string, Session[]>();
      for (const s of sportSessions) {
        const k = groupKey(s);
        if (!typeMap.has(k)) typeMap.set(k, []);
        typeMap.get(k)!.push(s);
      }

      // For running, enforce difficulty order
      const orderedKeys = sport === 'running'
        ? (['z2', 'tempo', 'series'] as SessionDifficulty[]).filter(k => typeMap.has(k))
        : Array.from(typeMap.keys());

      const groups: SessionGroup[] = orderedKeys.map(type => {
        const sList = typeMap.get(type)!;
        const key   = `${sport}::${type}`;
        const prev  = existingGroupMap.get(key);
        return {
          type,
          sessions:         sList,
          expanded:         prev?.expanded         ?? true,
          selectedIds:      prev?.selectedIds       ?? new Set(sList.map(s => s.id)),
          aggregate:        prev?.aggregate         ?? null,
          loadingAggregate: prev?.loadingAggregate  ?? false,
        };
      });

      const score    = computeWeightedScore(sportSessions);
      const prevTab  = this.sportTabs.find(t => t.sportType === sport);
      return {
        sportType:             sport,
        label:                 SPORT_TYPE_LABELS[sport],
        icon:                  SPORT_ICONS[sport],
        groups,
        score,
        scoreQuality:          score ? scoreQuality(score) : null,
        sportAggregate:        prevTab?.sportAggregate        ?? null,
        loadingSportAggregate: prevTab?.loadingSportAggregate ?? false,
        corrData:              prevTab?.corrData              ?? { datasets: [] },
        baData:                prevTab?.baData                ?? { datasets: [] },
      };
    });
  }

  /** Display label for a session group header. */
  groupLabel(sport: SportType, type: string): string {
    if (sport === 'running') {
      return DIFFICULTY_LABELS[type as SessionDifficulty] ?? type;
    }
    return type;
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  toggleUpload(): void {
    this.showUpload = !this.showUpload;
    if (!this.showUpload) this.resetUpload();
  }

  onDeviceFile(e: Event): void {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) this.deviceFile = f;
  }

  onReferenceFile(e: Event): void {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) this.referenceFile = f;
  }

  onDrop(e: DragEvent, which: 'device' | 'ref'): void {
    e.preventDefault();
    const f = e.dataTransfer?.files[0];
    if (!f) return;
    if (which === 'device') this.deviceFile = f;
    else this.referenceFile = f;
  }

  onDragOver(e: DragEvent): void { e.preventDefault(); }

  canUpload(): boolean {
    return this.uploadForm.valid && !!this.deviceFile && !!this.referenceFile && !this.uploading;
  }

  submitUpload(): void {
    if (!this.canUpload()) return;
    const v = this.uploadForm.value;
    this.uploading = true;

    this.api.uploadSession(
      this.deviceId,
      this.deviceFile!,
      this.referenceFile!,
      v.trainingType!,
      v.sessionName || '',
      v.sportType! as SportType,
      v.sessionDifficulty! as SessionDifficulty,
    ).subscribe({
      next: () => {
        this.snack.open('Sesión analizada y guardada', 'OK', { duration: 3000 });
        this.resetUpload();
        this.showUpload = false;
        this.uploading = false;
        this.loadDevice();
      },
      error: err => {
        this.uploading = false;
        const msg = err.error?.detail || 'Error al procesar los archivos';
        this.snack.open(msg, 'Cerrar', { duration: 5000 });
      },
    });
  }

  resetUpload(): void {
    this.deviceFile    = null;
    this.referenceFile = null;
    this.uploadForm.reset();
  }

  // ── Session actions ───────────────────────────────────────────────────────

  toggleSession(group: SessionGroup, id: string): void {
    if (group.selectedIds.has(id)) group.selectedIds.delete(id);
    else group.selectedIds.add(id);
  }

  deleteSession(session: Session, group: SessionGroup): void {
    if (!confirm(`¿Eliminar "${session.session_name}"?`)) return;
    this.api.deleteSession(session.id).subscribe({
      next: () => {
        this.snack.open('Sesión eliminada', 'OK', { duration: 2000 });
        this.loadDevice();
      },
      error: () => this.snack.open('Error al eliminar', 'Cerrar', { duration: 3000 }),
    });
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────

  runAggregate(group: SessionGroup): void {
    const ids = Array.from(group.selectedIds);
    if (ids.length === 0) {
      this.snack.open('Selecciona al menos una sesión', 'OK', { duration: 2500 });
      return;
    }
    group.loadingAggregate = true;
    group.aggregate = null;
    this.api.aggregate(ids, group.type).subscribe({
      next: result => {
        group.aggregate = result;
        group.loadingAggregate = false;
      },
      error: err => {
        group.loadingAggregate = false;
        this.snack.open(err.error?.detail || 'Error en el análisis agregado', 'Cerrar', { duration: 5000 });
      },
    });
  }

  // ── Sport-level aggregate charts ─────────────────────────────────────────

  runSportAggregate(tab: SportTab): void {
    tab.loadingSportAggregate = true;
    tab.sportAggregate = null;
    tab.corrData = { datasets: [] };
    tab.baData   = { datasets: [] };
    this.api.getSportAggregateCharts(this.deviceId, tab.sportType).subscribe({
      next: result => {
        tab.sportAggregate = result;
        tab.loadingSportAggregate = false;
        this._buildSportCharts(tab, result);
        this.cdRef.markForCheck();
      },
      error: err => {
        tab.loadingSportAggregate = false;
        this.snack.open(
          err.error?.detail || 'Error al generar el análisis por deporte',
          'Cerrar', { duration: 5000 }
        );
      },
    });
  }

  private _buildSportCharts(tab: SportTab, sa: SportAggregateCharts): void {
    const sessions = sa.sessions;
    const gs       = sa.global_stats;
    if (!sessions.length) return;

    // ── Correlation scatter ──────────────────────────────────────────
    const allX = sessions.flatMap(s => s.points.map(p => p.x));
    const allY = sessions.flatMap(s => s.points.map(p => p.y));
    const allV = [...allX, ...allY];
    const pad  = (Math.max(...allV) - Math.min(...allV)) * 0.04 + 2;
    const vMin = Math.min(...allV) - pad;
    const vMax = Math.max(...allV) + pad;

    const num = (v: number | null | undefined, dec = 1): string => v != null && Number.isFinite(v) ? v.toFixed(dec) : '—';

    const corrScatter = sessions.map((s, i) => ({
      type: 'scatter',
      label: `${s.label}  MAE ${num(s.mae)}`,
      data:  s.points,
      backgroundColor: this.SESSION_COLORS[i % this.SESSION_COLORS.length],
      borderColor: 'transparent',
      pointRadius: 1.5, pointHoverRadius: 4,
    }));

    // Global regression/BA lines need every field finite — a single bad
    // session upstream can otherwise poison one field and, left unguarded,
    // throw mid-build and leave both charts blank even though the raw
    // per-session scatter data (built above) is perfectly fine.
    const slope     = gs?.slope;
    const intercept = gs?.intercept;
    const hasReg = slope != null && Number.isFinite(slope) && intercept != null && Number.isFinite(intercept);
    const regLabel = hasReg
      ? `Regresión  y = ${slope.toFixed(3)}x ${intercept >= 0 ? '+' : ''}${intercept.toFixed(1)}`
      : 'Regresión';

    tab.corrData = {
      datasets: [
        ...corrScatter,
        { type: 'line', label: 'Identidad (y = x)',
          data: [{ x: vMin, y: vMin }, { x: vMax, y: vMax }],
          borderColor: 'rgba(150,150,150,0.5)', borderWidth: 1.5,
          borderDash: [4, 4], pointRadius: 0, fill: false },
        ...(hasReg ? [{
          type: 'line', label: regLabel,
          data: [{ x: vMin, y: slope * vMin + intercept },
                 { x: vMax, y: slope * vMax + intercept }],
          borderColor: '#6366f1', borderWidth: 2,
          borderDash: [5, 3], pointRadius: 0, fill: false,
        }] : []),
      ],
    };

    // ── Bland-Altman ────────────────────────────────────────────────
    const baMeans = sessions.flatMap(s => s.points.map(p => (p.x + p.y) / 2));
    const xPad    = (Math.max(...baMeans) - Math.min(...baMeans)) * 0.08 + 3;
    const xMin    = Math.min(...baMeans) - xPad;
    const xMax    = Math.max(...baMeans) + xPad;
    const sign    = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2);

    // scatter per session
    const baScatter = sessions.map((s, i) => ({
      type: 'scatter',
      label: `${s.label}  sesgo ${s.bias != null && s.bias >= 0 ? '+' : ''}${num(s.bias)}`,
      data:  s.points.map(p => ({ x: (p.x + p.y) / 2, y: p.y - p.x })),
      backgroundColor: this.SESSION_COLORS[i % this.SESSION_COLORS.length],
      borderColor: 'transparent',
      pointRadius: 1.5, pointHoverRadius: 4,
    }));

    // per-session biases stored as metadata for the plugin (not as chart datasets)
    const sessionBiases = sessions.map((s, i) => ({
      bias:  s.bias,
      color: this.SESSION_COLORS_SOLID[i % this.SESSION_COLORS_SOLID.length],
    }));

    const baLines: any[] = [];
    if (gs != null && Number.isFinite(gs.bias)) {
      baLines.push({ type: 'line', label: `Sesgo global: ${sign(gs.bias!)} ppm`,
        data: [{ x: xMin, y: gs.bias }, { x: xMax, y: gs.bias }],
        borderColor: '#6366f1', borderWidth: 2, borderDash: [5, 4],
        pointRadius: 0, fill: false });
    }
    if (gs != null && Number.isFinite(gs.loa_u)) {
      baLines.push({ type: 'line', label: `+LoA: ${sign(gs.loa_u!)} ppm`,
        data: [{ x: xMin, y: gs.loa_u }, { x: xMax, y: gs.loa_u }],
        borderColor: '#ef4444', borderWidth: 1.5, borderDash: [2, 4],
        pointRadius: 0, fill: false });
    }
    if (gs != null && Number.isFinite(gs.loa_l)) {
      baLines.push({ type: 'line', label: `−LoA: ${sign(gs.loa_l!)} ppm`,
        data: [{ x: xMin, y: gs.loa_l }, { x: xMax, y: gs.loa_l }],
        borderColor: '#3b82f6', borderWidth: 1.5, borderDash: [2, 4],
        pointRadius: 0, fill: false });
    }

    tab.baData = {
      _sessionBiases: sessionBiases,
      datasets: [...baScatter, ...baLines],
    };
  }

  exportSportChart(sportType: string, chartType: 'corr' | 'ba'): void {
    const chart = this.sportCharts.find(item =>
      item.chart?.canvas.id === `sport-${chartType}-${sportType}`)?.chart;
    if (!chart) return;
    const filename = `${sportType}-${chartType === 'corr' ? 'correlacion' : 'bland-altman'}.png`;
    withHighResolutionChartExport(chart, canvas => downloadCanvasPng(canvas, filename));
  }

  readonly sportCorrOptions: any = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: {
      legend: { position: 'top', align: 'end',
                labels: { color: '#9ca3af', font: { size: 11 },
                          boxWidth: 20, boxHeight: 2, padding: 14 } },
      tooltip: { callbacks: {
        label: (item: any) =>
          `Ref: ${item.parsed.x.toFixed(0)} ppm   Dev: ${item.parsed.y.toFixed(0)} ppm`,
      }},
    },
    scales: {
      x: { title: { display: true, text: 'Referencia (ppm)', color: '#9ca3af', font: { size: 10 } },
           ticks: { color: '#9ca3af', font: { size: 11 } },
           grid: { color: 'rgba(229,232,239,0.7)' }, border: { display: false } },
      y: { title: { display: true, text: 'Dispositivo (ppm)', color: '#9ca3af', font: { size: 10 } },
           ticks: { color: '#9ca3af', font: { size: 11 } },
           grid: { color: 'rgba(229,232,239,0.7)' }, border: { display: false } },
    },
  };

  readonly sportBaOptions: any = {
    responsive: true, maintainAspectRatio: false, animation: false,
    layout: { padding: { right: 52 } },   // room for the per-session bias numbers
    plugins: {
      legend: {
        position: 'top', align: 'end',
        labels: { color: '#9ca3af', font: { size: 11 }, boxWidth: 20, boxHeight: 2, padding: 14 },
      },
      tooltip: { callbacks: {
        label: (item: any) =>
          `Media: ${item.parsed.x.toFixed(0)} ppm   Dif: ${item.parsed.y >= 0 ? '+' : ''}${item.parsed.y.toFixed(1)} ppm`,
      }},
    },
    scales: {
      x: { title: { display: true, text: 'Media (Ref + Dev) / 2  (ppm)', color: '#9ca3af', font: { size: 10 } },
           ticks: { color: '#9ca3af', font: { size: 11 } },
           grid: { color: 'rgba(229,232,239,0.7)' }, border: { display: false } },
      y: { title: { display: true, text: 'Diferencia  Dev − Ref  (ppm)', color: '#9ca3af', font: { size: 10 } },
           ticks: { color: '#9ca3af', font: { size: 11 } },
           grid: { color: 'rgba(229,232,239,0.7)' }, border: { display: false } },
    },
  };

  // ── GPS Scores ────────────────────────────────────────────────────────────

  loadGpsScores(): void {
    // Prefer localStorage (most recent, even before backend sync)
    const tk = localStorage.getItem(`gps-scores-track-${this.deviceId}`);
    const uk = localStorage.getItem(`gps-scores-urban-${this.deviceId}`);
    this.gpsTrackData = tk ? JSON.parse(tk) : null;
    this.gpsUrbanData = uk ? JSON.parse(uk) : null;

    // Fill any missing data from backend
    if (!this.gpsTrackData || !this.gpsUrbanData) {
      this.api.getGpsScores(this.deviceId).subscribe({
        next: scores => {
          if (!this.gpsTrackData && scores.track) this.gpsTrackData = scores.track;
          if (!this.gpsUrbanData && scores.urban) this.gpsUrbanData = scores.urban;
        },
        error: () => {},  // 404 = no scores yet, ignore
      });
    }
  }

  get gpsScoreRows(): GpsScoreRow[] {
    const names = new Set([
      ...(this.gpsTrackData?.modes.map(m => m.name) ?? []),
      ...(this.gpsUrbanData?.modes.map(m => m.name) ?? []),
    ]);
    return Array.from(names).map(name => {
      const key = name.toLowerCase();
      const tr = this.gpsTrackData?.modes.find(m => m.name.toLowerCase() === key);
      const ur = this.gpsUrbanData?.modes.find(m => m.name.toLowerCase() === key);
      const color = tr?.color ?? ur?.color ?? '#888';
      const globalScore = (tr && ur)
        ? Math.round((ur.urbanScore * 0.55 + tr.trackScore * 0.35 + ur.consistencyScore * 0.10) * 10) / 10
        : null;
      return { name, color,
        trackScore:       tr?.trackScore       ?? null,
        distScore:        tr?.distScore        ?? null,
        pathScore:        tr?.pathScore        ?? null,
        rmseTrack:        tr?.rmse             ?? null,
        mapeTrack:        tr?.mape             ?? null,
        urbanScore:       ur?.urbanScore        ?? null,
        consistencyScore: ur?.consistencyScore  ?? null,
        rmseUrban:        ur?.rmse              ?? null,
        speedJitter:      ur?.speedJitter       ?? null,
        globalScore };
    });
  }

  sortedGpsBy(dim: 'track' | 'urban' | 'global'): GpsScoreRow[] {
    const keyMap: Record<string, keyof GpsScoreRow> = {
      track: 'trackScore', urban: 'urbanScore', global: 'globalScore',
    };
    return [...this.gpsScoreRows].sort((a, b) => {
      const av = a[keyMap[dim]] as number | null;
      const bv = b[keyMap[dim]] as number | null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av;
    });
  }

  formatScore(v: number | null): string { return v != null ? v.toFixed(1) : '—'; }

  gpsScoreColor(v: number | null): string {
    if (v == null) return '';
    if (v >= 85) return 'q-good';
    if (v >= 70) return 'q-warn';
    if (v >= 50) return 'q-orange';
    return 'q-bad';
  }

  // ── Correlation chart ─────────────────────────────────────────────────────

  readonly corrGridLines: { label: string; y: number }[] = [
    { label: '1.0', y: 35 }, { label: '0.9', y: 66 },
    { label: '0.8', y: 97 }, { label: '0.7', y: 128 },
    { label: '0.6', y: 158 }, { label: '0.5', y: 189 },
  ];

  private corrY(r: number): number {
    return 220 - (Math.min(Math.max(r, 0.4), 1.0) - 0.4) / 0.6 * 185;
  }

  private corrMedian(sorted: number[]): number {
    const n = sorted.length;
    if (n === 0) return 0;
    return n % 2 === 0 ? (sorted[n/2-1] + sorted[n/2]) / 2 : sorted[Math.floor(n/2)];
  }

  get hasCorrData(): boolean {
    return this.sportTabs.some(tab =>
      tab.groups.flatMap(g => g.sessions).some(s => s.metrics?.r != null)
    );
  }

  get corrChartCols(): CorrSportCol[] {
    const CX = [128, 285, 442];
    const BHW = 30;
    const THR = 0.90;
    return this.sportTabs.map((tab, i) => {
      const rVals = tab.groups
        .flatMap(g => g.sessions)
        .map(s => s.metrics?.r)
        .filter((r): r is number => r != null && isFinite(r));
      const sorted = [...rVals].sort((a, b) => a - b);
      const n = sorted.length;
      const half = Math.floor(n / 2);
      const med = this.corrMedian(sorted);
      const q1 = n >= 4 ? this.corrMedian(sorted.slice(0, half)) : med;
      const q3 = n >= 4 ? this.corrMedian(sorted.slice(n % 2 === 0 ? half : half + 1)) : med;
      const pct = n > 0 ? Math.round(rVals.filter(r => r >= THR).length / n * 100) : 0;
      const cx = CX[i];
      const points: CorrSportPoint[] = rVals.map((r, idx) => ({
        r, cx: cx + ((idx % 7) - 3) * 7, cy: this.corrY(r),
      }));
      return {
        label: tab.label, cx, points, n, pct,
        hasBox: n >= 3,
        boxX1: cx - BHW, boxX2: cx + BHW,
        boxY1: this.corrY(q3), boxY2: this.corrY(q1),
        medianY: this.corrY(med),
        medianR: med,
      };
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  formatDuration(s: number): string {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('es-ES', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  }

  maeBadge(v: number): string {
    return v <= 3 ? 'good' : v <= 5 ? 'warn' : v <= 10 ? 'orange' : 'bad';
  }

  rBadge(v: number): string {
    return v >= 0.95 ? 'good' : v >= 0.90 ? 'warn' : v >= 0.80 ? 'orange' : 'bad';
  }

  get allGroups(): SessionGroup[] {
    return this.sportTabs.flatMap(t => t.groups);
  }

  getTypeStats(typeName: string) {
    return this.device?.training_types.find(t => t.name === typeName) ?? null;
  }

  biasSign(v: number): string { return v > 0 ? '+' : ''; }

  /** Generate a mini SVG path for a session sparkline (dev or ref line) */
  sparkPath(session: Session, which: 'dev' | 'ref'): string {
    const spark = session.spark_data;
    const pts = spark ? (which === 'dev' ? spark.device : spark.reference) : null;

    const w = 160, h = 28;

    if (pts && pts.length >= 2) {
      const minV = Math.min(...pts);
      const maxV = Math.max(...pts);
      const range = maxV - minV || 1;
      return pts.map((v, i) => {
        const x = (i / (pts.length - 1)) * w;
        const y = h - ((v - minV) / range) * (h - 2) - 1;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
    }

    // Fallback: simple sine-based placeholder when no spark_data
    const fcmax = session.fcmax || 160;
    const fcmid = fcmax * 0.82;
    const n = 16;
    const offset = which === 'ref' ? 2 : 0;
    return Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1);
      const v = fcmid + (fcmax - fcmid) * Math.sin(t * Math.PI * 1.1) +
        (Math.sin(i * 2.3 + offset) * 3) + offset * 1.5;
      const x = (i / (n - 1)) * w;
      const y = h - ((v - (fcmid - 15)) / (fcmax - fcmid + 20)) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${Math.max(1, Math.min(h - 1, y)).toFixed(1)}`;
    }).join(' ');
  }

  // ── Custom tab state (replaces mat-tab-group) ──────────────────────
  activeTabIndex = 0;

  get activeSportTab(): SportTab | null {
    return this.sportTabs[this.activeTabIndex] ?? null;
  }

  countSessions(tab: SportTab): number {
    return tab.groups.reduce((sum, g) => sum + g.sessions.length, 0);
  }

  /** Natural-language verdict first sentence based on quality */
  verdictStrong(score: WeightedScore): string {
    const q = scoreQuality(score);
    if (q === 'good')   return `Excelente acuerdo — CCC = ${score.ccc_global.toFixed(3)}.`;
    if (q === 'warn')   return `Buen acuerdo — CCC = ${score.ccc_global.toFixed(3)}.`;
    if (q === 'orange') return `Acuerdo moderado — CCC = ${score.ccc_global.toFixed(3)}.`;
    return `Acuerdo bajo — CCC = ${score.ccc_global.toFixed(3)}.`;
  }

  /** CSS class for a score metric value */
  scoreQuality(value: number, kind: 'r' | 'ccc' | 'mae'): string {
    if (kind === 'r' || kind === 'ccc') {
      if (value >= 0.95) return 'q-good';
      if (value >= 0.90) return 'q-warn';
      if (value >= 0.80) return 'q-orange';
      return 'q-bad';
    }
    if (value <= 3)  return 'q-good';
    if (value <= 5)  return 'q-warn';
    if (value <= 10) return 'q-orange';
    return 'q-bad';
  }

  /** Summary badges shown collapsed in group header */
  groupBadges(group: SessionGroup): { label: string; value: string; quality: string }[] {
    if (!group.sessions.length) return [];
    const cccs = group.sessions.map(s => s.metrics?.ccc ?? 0).filter(Boolean);
    const maes = group.sessions.map(s => s.metrics?.mae ?? 0).filter(Boolean);
    if (!cccs.length) return [];
    const avgCCC = cccs.reduce((a, b) => a + b, 0) / cccs.length;
    const avgMae = maes.length ? maes.reduce((a, b) => a + b, 0) / maes.length : null;
    const badges: { label: string; value: string; quality: string }[] = [
      { label: 'CCC', value: avgCCC.toFixed(3), quality: this.rBadge(avgCCC) },
    ];
    if (avgMae !== null) {
      badges.push({ label: 'MAE', value: avgMae.toFixed(1), quality: this.maeBadge(avgMae) });
    }
    return badges;
  }
}

import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatSelectModule } from '@angular/material/select';

import { ApiService } from '../../services/api.service';
import { Device, Session, AggregateResult,
         SportType, SessionDifficulty,
         SPORT_TYPE_LABELS, DIFFICULTY_LABELS,
         TRAINING_TYPES_BY_SPORT, SPORT_HAS_DIFFICULTY, GYM_DIFFICULTY,
         WeightedScore, computeWeightedScore, scoreQuality,
         MetricQuality } from '../../models/session.model';
import { GpsTrackModeScore, GpsUrbanModeScore, GpsStoredScores } from '../../models/gps-analysis.model';
import { ChartViewerComponent } from '../../shared/chart-viewer/chart-viewer.component';
import { MetricsTableComponent } from '../../shared/metrics-table/metrics-table.component';

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
    ChartViewerComponent, MetricsTableComponent,
  ],
  templateUrl: './device-detail.component.html',
  styleUrls: ['./device-detail.component.scss'],
})
export class DeviceDetailComponent implements OnInit, OnDestroy {
  device: Device | null = null;
  deviceId = '';
  sportTabs: SportTab[] = [];
  loading = true;

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

      const score = computeWeightedScore(sportSessions);
      return {
        sportType:    sport,
        label:        SPORT_TYPE_LABELS[sport],
        icon:         SPORT_ICONS[sport],
        groups,
        score,
        scoreQuality: score ? scoreQuality(score) : null,
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

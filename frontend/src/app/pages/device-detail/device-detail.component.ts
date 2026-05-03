import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatChipsModule } from '@angular/material/chips';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';

import { ApiService } from '../../services/api.service';
import { Device, Session, AggregateResult, SportType, SessionDifficulty,
         SPORT_TYPE_LABELS, DIFFICULTY_LABELS,
         TRAINING_TYPES_BY_SPORT, SPORT_HAS_DIFFICULTY, GYM_DIFFICULTY,
         WeightedScore, computeWeightedScore, scoreQuality,
         MetricQuality } from '../../models/session.model';
import { ChartViewerComponent } from '../../shared/chart-viewer/chart-viewer.component';
import { MetricsTableComponent } from '../../shared/metrics-table/metrics-table.component';

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
    MatCardModule, MatButtonModule, MatIconModule, MatInputModule,
    MatFormFieldModule, MatAutocompleteModule, MatChipsModule,
    MatCheckboxModule, MatProgressSpinnerModule, MatExpansionModule,
    MatSnackBarModule, MatTooltipModule, MatSelectModule, MatTabsModule,
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
}

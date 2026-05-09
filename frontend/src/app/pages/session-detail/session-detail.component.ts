import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

import { ApiService } from '../../services/api.service';
import { ReportPdfService } from '../../services/report-pdf.service';
import { Session, AiAnalysis, AiCalificacion, metricQuality, SportType, SessionDifficulty,
         SPORT_TYPE_LABELS, DIFFICULTY_LABELS,
         TRAINING_TYPES_BY_SPORT, SPORT_HAS_DIFFICULTY, GYM_DIFFICULTY,
} from '../../models/session.model';
import { ChartViewerComponent } from '../../shared/chart-viewer/chart-viewer.component';
import { MetricsTableComponent } from '../../shared/metrics-table/metrics-table.component';
import { FcTemporalChartComponent } from '../../shared/fc-temporal-chart/fc-temporal-chart.component';
import { SessionValidationChartsComponent } from '../../shared/session-validation-charts/session-validation-charts.component';

@Component({
  selector: 'app-session-detail',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    ReactiveFormsModule,
    MatSnackBarModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    ChartViewerComponent,
    MetricsTableComponent,
    FcTemporalChartComponent,
    SessionValidationChartsComponent,
  ],
  templateUrl: './session-detail.component.html',
  styleUrls: ['./session-detail.component.scss'],
})
export class SessionDetailComponent implements OnInit, OnDestroy {
  session: Session | null = null;
  loading = true;
  error   = '';
  deviceId = '';
  metricQuality = metricQuality;

  siblingIds: string[] = [];  // all session IDs for this device, newest-first
  get currentIndex(): number { return this.siblingIds.indexOf(this.session?.id ?? ''); }
  get prevId(): string | null { return this.siblingIds[this.currentIndex - 1] ?? null; }
  get nextId(): string | null { return this.siblingIds[this.currentIndex + 1] ?? null; }

  readonly zoneColumns = ['zone', 'range', 'pct_time', 'n', 'mae', 'mape', 'bias'];

  editing     = false;
  saving      = false;
  private sportSub?: Subscription;
  reanalyzing = false;

  // ── AI analysis ───────────────────────────────────────────────────────────
  activeTab: 'stats' | 'ai' = 'stats';
  aiAnalysis:  AiAnalysis | null = null;
  aiLoading  = false;
  aiError    = '';
  aiGenerating = false;
  editForm = this.fb.group({
    session_name:       [''],
    training_type:      ['', Validators.required],
    sport_type:         ['' as SportType,         Validators.required],
    session_difficulty: ['' as SessionDifficulty, Validators.required],
  });

  readonly sportTypes   = Object.entries(SPORT_TYPE_LABELS) as [SportType, string][];
  readonly difficulties = Object.entries(DIFFICULTY_LABELS) as [SessionDifficulty, string][];

  readonly sportLabel      = SPORT_TYPE_LABELS;
  readonly difficultyLabel = DIFFICULTY_LABELS;

  get editHasDifficulty(): boolean {
    const sport = this.editForm.get('sport_type')?.value as SportType;
    return sport ? SPORT_HAS_DIFFICULTY[sport] : true;
  }

  get editAvailableTrainingTypes(): string[] {
    const sport = this.editForm.get('sport_type')?.value as SportType;
    return sport ? TRAINING_TYPES_BY_SPORT[sport] : [];
  }

  get aiZones(): { key: string; mae: number | null; valoracion: string; explicacion_canal: string; causa_probable: string }[] {
    const zones = this.aiAnalysis?.report?.informe?.error_por_zonas;
    if (!zones || typeof zones !== 'object') return [];
    return Object.entries(zones as Record<string, any>).map(([key, v]) => ({
      key,
      mae:               v?.mae              ?? null,
      valoracion:        v?.valoracion        ?? '',
      explicacion_canal: v?.explicacion_canal ?? '',
      causa_probable:    v?.causa_probable    ?? '',
    }));
  }

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ApiService,
    private fb: FormBuilder,
    private snack: MatSnackBar,
    private reportPdf: ReportPdfService,
  ) {}

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get('deviceId') || '';
    const id = this.route.snapshot.paramMap.get('sessionId')!;
    this.loadSession(id);

    // Load sibling IDs so we can navigate prev/next
    if (this.deviceId) {
      this.api.listDeviceSessions(this.deviceId).subscribe({
        next: sessions => { this.siblingIds = sessions.map(s => s.id); },
      });
    }
  }

  loadSession(id: string): void {
    this.loading     = true;
    this.error       = '';
    this.session     = null;
    this.aiAnalysis  = null;
    this.aiError     = '';
    this.api.getSession(id).subscribe({
      next: s => {
        this.session = s;
        this.loading = false;
        if (s.has_ai_analysis) {
          this.loadAiAnalysis(id);
        } else {
          this.triggerAiAnalysis(id);
        }
      },
      error: () => { this.error = 'No se pudo cargar la sesión.'; this.loading = false; },
    });
  }

  loadAiAnalysis(sessionId: string): void {
    this.aiLoading = true;
    this.aiError   = '';
    this.api.getSessionAiAnalysis(sessionId).subscribe({
      next:  a  => { this.aiAnalysis = a; this.aiLoading = false; },
      error: () => { this.aiLoading = false; },
    });
  }

  triggerAiAnalysis(sessionId: string): void {
    this.aiLoading    = true;
    this.aiGenerating = true;
    this.aiError      = '';
    this.api.generateSessionAiAnalysis(sessionId).subscribe({
      next: a => {
        this.aiAnalysis   = a;
        this.aiLoading    = false;
        this.aiGenerating = false;
        if (this.session) this.session.has_ai_analysis = true;
      },
      error: err => {
        this.aiError      = err.error?.detail || 'Error al generar el análisis IA';
        this.aiLoading    = false;
        this.aiGenerating = false;
      },
    });
  }

  reAnalyzeAi(): void {
    if (!this.session) return;
    this.aiAnalysis = null;
    this.triggerAiAnalysis(this.session.id);
    this.activeTab = 'ai';
  }

  downloadPdf(): void {
    if (!this.session || !this.aiAnalysis) return;
    this.reportPdf.download(this.session, this.aiAnalysis);
  }

  aiCalClass(cal: AiCalificacion | undefined): string {
    const map: Record<AiCalificacion, string> = {
      excelente: 'good',
      bueno:     'warn',
      moderado:  'orange',
      deficiente: 'bad',
    };
    return cal ? (map[cal] ?? '') : '';
  }

  aiAnnotationIcon(tipo: string): string {
    const icons: Record<string, string> = {
      lag:               '⏱',
      overshooting:      '↑',
      cadence_lock:      '🔒',
      alta_discrepancia: '⚠',
      recuperacion_lenta:'↓',
    };
    return icons[tipo] ?? '•';
  }

  navigateTo(id: string): void {
    this.router.navigate(['/devices', this.deviceId, 'sessions', id]);
    this.loadSession(id);
  }

  startEdit(): void {
    if (!this.session) return;
    this.editForm.setValue({
      session_name:       this.session.session_name       ?? '',
      training_type:      this.session.training_type      ?? '',
      sport_type:         this.session.sport_type         ?? '' as SportType,
      session_difficulty: this.session.session_difficulty ?? '' as SessionDifficulty,
    });
    this.editing = true;
    this.sportSub = this.editForm.get('sport_type')!.valueChanges.subscribe(sport => {
      this.editForm.get('training_type')!.reset('');
      if (sport === 'gym') {
        this.editForm.get('session_difficulty')!.setValue(GYM_DIFFICULTY);
      } else {
        this.editForm.get('session_difficulty')!.reset(null);
      }
    });
  }

  ngOnDestroy(): void { this.sportSub?.unsubscribe(); }

  cancelEdit(): void {
    this.editing = false;
  }

  saveEdit(): void {
    if (!this.session || this.editForm.invalid) return;
    this.saving = true;
    const v = this.editForm.value;
    this.api.updateSession(this.session.id, {
      session_name:       v.session_name       || '',
      training_type:      v.training_type!,
      sport_type:         v.sport_type!        as SportType,
      session_difficulty: v.session_difficulty! as SessionDifficulty,
    }).subscribe({
      next: updated => {
        this.session = updated;
        this.editing = false;
        this.saving  = false;
        this.snack.open('Sesión actualizada', 'OK', { duration: 2500 });
      },
      error: err => {
        this.saving = false;
        this.snack.open(err.error?.detail || 'Error al guardar', 'Cerrar', { duration: 4000 });
      },
    });
  }

  reanalyze(): void {
    if (!this.session) return;
    this.reanalyzing = true;
    this.api.reanalyzeSession(this.session.id).subscribe({
      next: updated => {
        this.session     = updated;
        this.reanalyzing = false;
        this.snack.open('Actividad recalculada correctamente', 'OK', { duration: 3000 });
      },
      error: err => {
        this.reanalyzing = false;
        this.snack.open(err.error?.detail || 'Error al recalcular', 'Cerrar', { duration: 5000 });
      },
    });
  }

  delete(): void {
    if (!this.session) return;
    if (!confirm(`¿Eliminar "${this.session.session_name}"?`)) return;
    this.api.deleteSession(this.session.id).subscribe({
      next: () => {
        this.snack.open('Sesión eliminada', 'OK', { duration: 2000 });
        this.router.navigate(['/devices', this.deviceId]);
      },
      error: () => this.snack.open('Error al eliminar', 'Cerrar', { duration: 3000 }),
    });
  }

  biasSign(v: number): string { return v > 0 ? '+' : ''; }

  loaSemi(session: Session): number {
    return Math.round(((session.metrics.loa_u - session.metrics.loa_l) / 2) * 10) / 10;
  }

  mq(metric: string, v: number): string {
    return metricQuality(metric as any, v);
  }

  verdictQuality(session: Session): string {
    return metricQuality('ccc', session.metrics.ccc);
  }

  verdictText(session: Session): string {
    const ccc  = session.metrics.ccc;
    const mae  = session.metrics.mae;
    const bias = session.metrics.bias;
    const q    = metricQuality('ccc', ccc);
    const biasStr = Math.abs(bias) < 0.1 ? 'bias prácticamente nulo' :
      `bias ${bias > 0 ? '+' : ''}${bias.toFixed(1)} bpm`;

    if (q === 'good') return `Validación de calidad clínica. CCC = ${ccc.toFixed(3)} con ${biasStr}. MAE ${mae.toFixed(1)} bpm — sensor de alta fidelidad para este tipo de entrenamiento.`;
    if (q === 'warn') return `Acuerdo bueno (CCC = ${ccc.toFixed(3)}) con ${biasStr}. MAE ${mae.toFixed(1)} bpm — apto para monitorización de carga aeróbica.`;
    if (q === 'orange') return `Acuerdo moderado (CCC = ${ccc.toFixed(3)}). MAE ${mae.toFixed(1)} bpm. Usar con precaución en análisis de intensidad.`;
    return `Acuerdo insuficiente (CCC = ${ccc.toFixed(3)}). MAE ${mae.toFixed(1)} bpm — resultados poco fiables para este tipo de sesión.`;
  }

  formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h) return `${h}h ${m}m ${s}s`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleString('es-ES', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  zoneCssClass(name: string): string {
    const z = name.split(' ')[0].toLowerCase();
    return `zone-${z}`;
  }
}

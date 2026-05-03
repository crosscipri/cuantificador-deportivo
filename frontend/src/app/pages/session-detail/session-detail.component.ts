import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTableModule } from '@angular/material/table';
import { MatChipsModule } from '@angular/material/chips';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ApiService } from '../../services/api.service';
import { Session, metricQuality, SportType, SessionDifficulty,
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
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatTableModule,
    MatChipsModule,
    MatSnackBarModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    ChartViewerComponent,
    MetricsTableComponent,
    FcTemporalChartComponent,
    SessionValidationChartsComponent,
    MatTooltipModule,
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

  readonly zoneColumns = ['zone', 'range', 'pct_time', 'n', 'mae', 'mape', 'bias'];

  editing     = false;
  saving      = false;
  private sportSub?: Subscription;
  reanalyzing = false;
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

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ApiService,
    private fb: FormBuilder,
    private snack: MatSnackBar,
  ) {}

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get('deviceId') || '';
    const id = this.route.snapshot.paramMap.get('sessionId')!;
    this.api.getSession(id).subscribe({
      next:  s  => { this.session = s; this.loading = false; },
      error: () => { this.error = 'No se pudo cargar la sesión.'; this.loading = false; },
    });
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

import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Subscription } from 'rxjs';

import { ApiService } from '../../services/api.service';
import { Device, Session, SportType, SessionDifficulty,
         SPORT_TYPE_LABELS, DIFFICULTY_LABELS,
         TRAINING_TYPES_BY_SPORT, SPORT_HAS_DIFFICULTY, GYM_DIFFICULTY,
} from '../../models/session.model';
import { ChartViewerComponent } from '../../shared/chart-viewer/chart-viewer.component';
import { MetricsTableComponent } from '../../shared/metrics-table/metrics-table.component';

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule, RouterModule,
    MatCardModule, MatButtonModule, MatIconModule,
    MatInputModule, MatFormFieldModule, MatSelectModule,
    MatSnackBarModule, MatProgressSpinnerModule,
    ChartViewerComponent, MetricsTableComponent,
  ],
  templateUrl: './upload.component.html',
  styleUrls: ['./upload.component.scss'],
})
export class UploadComponent implements OnInit, OnDestroy {
  device: Device | null = null;
  deviceId = '';

  form = this.fb.group({
    sportType:         ['' as SportType,         Validators.required],
    sessionDifficulty: ['' as SessionDifficulty, Validators.required],
    trainingType:      ['',                      Validators.required],
    sessionName:       [''],
  });

  readonly sportTypes   = Object.entries(SPORT_TYPE_LABELS) as [SportType, string][];
  readonly difficulties = Object.entries(DIFFICULTY_LABELS) as [SessionDifficulty, string][];

  deviceFile:    File | null = null;
  referenceFile: File | null = null;
  loading = false;
  result: Session | null = null;

  private sportSub!: Subscription;

  constructor(
    private fb: FormBuilder,
    private api: ApiService,
    private route: ActivatedRoute,
    private router: Router,
    private snack: MatSnackBar,
  ) {}

  get isGym(): boolean {
    return this.form.get('sportType')?.value === 'gym';
  }

  get hasDifficulty(): boolean {
    const sport = this.form.get('sportType')?.value as SportType;
    return sport ? SPORT_HAS_DIFFICULTY[sport] : true;
  }

  get availableTrainingTypes(): string[] {
    const sport = this.form.get('sportType')?.value as SportType;
    return sport ? TRAINING_TYPES_BY_SPORT[sport] : [];
  }

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get('deviceId') || '';
    if (this.deviceId) {
      this.api.getDevice(this.deviceId).subscribe({
        next:  d  => (this.device = d),
        error: () => this.router.navigate(['/devices']),
      });
    } else {
      this.router.navigate(['/devices']);
    }

    this.sportSub = this.form.get('sportType')!.valueChanges.subscribe(sport => {
      this.form.get('trainingType')!.reset('');
      if (sport === 'gym') {
        this.form.get('sessionDifficulty')!.setValue(GYM_DIFFICULTY);
      } else {
        this.form.get('sessionDifficulty')!.reset(null);
      }
    });
  }

  ngOnDestroy(): void { this.sportSub?.unsubscribe(); }

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

  canSubmit(): boolean {
    return this.form.valid && !!this.deviceFile && !!this.referenceFile && !this.loading;
  }

  submit(): void {
    if (!this.canSubmit() || !this.device) return;
    const v = this.form.value;
    this.loading = true;
    this.result  = null;

    this.api.uploadSession(
      this.device.id,
      this.deviceFile!,
      this.referenceFile!,
      v.trainingType!,
      v.sessionName || '',
      v.sportType! as SportType,
      v.sessionDifficulty! as SessionDifficulty,
    ).subscribe({
      next: session => {
        this.result  = session;
        this.loading = false;
        this.snack.open('Sesión analizada y guardada', 'OK', { duration: 3000 });
      },
      error: err => {
        this.loading = false;
        this.snack.open(err.error?.detail || 'Error al procesar los archivos', 'Cerrar', { duration: 5000 });
      },
    });
  }

  reset(): void {
    this.result        = null;
    this.deviceFile    = null;
    this.referenceFile = null;
    this.form.reset();
  }
}

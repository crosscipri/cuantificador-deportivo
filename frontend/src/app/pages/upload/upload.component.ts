import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { ApiService } from '../../services/api.service';
import { Device, Session } from '../../models/session.model';
import { ChartViewerComponent } from '../../shared/chart-viewer/chart-viewer.component';
import { MetricsTableComponent } from '../../shared/metrics-table/metrics-table.component';

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatAutocompleteModule,
    MatSnackBarModule,
    MatProgressSpinnerModule,
    ChartViewerComponent,
    MetricsTableComponent,
  ],
  templateUrl: './upload.component.html',
  styleUrls: ['./upload.component.scss'],
})
export class UploadComponent implements OnInit {
  device: Device | null = null;
  deviceId = '';

  form = this.fb.group({
    trainingType: ['', Validators.required],
    sessionName:  [''],
  });

  deviceFile:    File | null = null;
  referenceFile: File | null = null;

  loading = false;
  result: Session | null = null;

  constructor(
    private fb: FormBuilder,
    private api: ApiService,
    private route: ActivatedRoute,
    private router: Router,
    private snack: MatSnackBar,
  ) {}

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

  canSubmit(): boolean {
    return this.form.valid && !!this.deviceFile && !!this.referenceFile && !this.loading;
  }

  get existingTypes(): string[] {
    return (this.device?.training_types ?? []).map(t => t.name);
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
    ).subscribe({
      next: session => {
        this.result  = session;
        this.loading = false;
        this.snack.open('Sesión analizada y guardada', 'OK', { duration: 3000 });
      },
      error: err => {
        this.loading = false;
        const msg = err.error?.detail || 'Error al procesar los archivos';
        this.snack.open(msg, 'Cerrar', { duration: 5000 });
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

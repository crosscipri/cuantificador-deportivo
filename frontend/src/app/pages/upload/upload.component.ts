import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDividerModule } from '@angular/material/divider';

import { ApiService } from '../../services/api.service';
import { Session, TrainingType } from '../../models/session.model';
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
    MatDividerModule,
    ChartViewerComponent,
    MetricsTableComponent,
  ],
  templateUrl: './upload.component.html',
  styleUrls: ['./upload.component.scss'],
})
export class UploadComponent implements OnInit {
  form = this.fb.group({
    trainingType:  ['', Validators.required],
    sessionName:   [''],
    deviceName:    [''],
    referenceName: [''],
  });

  deviceFile:    File | null = null;
  referenceFile: File | null = null;

  loading  = false;
  result:  Session | null = null;
  trainingTypes: TrainingType[] = [];

  constructor(
    private fb: FormBuilder,
    private api: ApiService,
    private snack: MatSnackBar,
  ) {}

  ngOnInit(): void {
    this.api.getTrainingTypes().subscribe({
      next: types => (this.trainingTypes = types),
    });
  }

  onDeviceFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) {
      this.deviceFile = input.files[0];
      if (!this.form.value.deviceName) {
        this.form.patchValue({ deviceName: input.files[0].name.replace(/\.fit$/i, '') });
      }
    }
  }

  onReferenceFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) {
      this.referenceFile = input.files[0];
      if (!this.form.value.referenceName) {
        this.form.patchValue({ referenceName: input.files[0].name.replace(/\.fit$/i, '') });
      }
    }
  }

  onDrop(event: DragEvent, type: 'device' | 'reference'): void {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    if (type === 'device') {
      this.deviceFile = file;
      if (!this.form.value.deviceName) {
        this.form.patchValue({ deviceName: file.name.replace(/\.fit$/i, '') });
      }
    } else {
      this.referenceFile = file;
      if (!this.form.value.referenceName) {
        this.form.patchValue({ referenceName: file.name.replace(/\.fit$/i, '') });
      }
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  canSubmit(): boolean {
    return this.form.valid && !!this.deviceFile && !!this.referenceFile;
  }

  submit(): void {
    if (!this.canSubmit()) return;
    const v = this.form.value;
    this.loading = true;
    this.result  = null;

    this.api
      .uploadSession(
        this.deviceFile!,
        this.referenceFile!,
        v.trainingType!,
        v.sessionName  || '',
        v.deviceName   || '',
        v.referenceName|| '',
      )
      .subscribe({
        next: session => {
          this.result  = session;
          this.loading = false;
          this.snack.open('Sesión analizada y guardada correctamente', 'OK', { duration: 3000 });
          // Refresh training types
          this.api.getTrainingTypes().subscribe(t => (this.trainingTypes = t));
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
    this.form.patchValue({ sessionName: '', deviceName: '', referenceName: '' });
  }

  filteredTypes(): string[] {
    const query = (this.form.value.trainingType || '').toLowerCase();
    return this.trainingTypes
      .map(t => t.name)
      .filter(n => n.toLowerCase().includes(query));
  }
}

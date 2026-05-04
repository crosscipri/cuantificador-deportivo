import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';

import { ApiService } from '../../services/api.service';
import { Device } from '../../models/session.model';

// ── Inline dialog component ───────────────────────────────────────────────────

@Component({
  selector: 'app-new-device-dialog',
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule,
    MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule, MatDialogModule,
  ],
  template: `
    <h2 mat-dialog-title>Nuevo dispositivo</h2>
    <mat-dialog-content>
      <form [formGroup]="form" class="dialog-form">
        <mat-form-field appearance="outline">
          <mat-label>Nombre del dispositivo *</mat-label>
          <input matInput formControlName="name" placeholder="Garmin Forerunner 265">
          <mat-icon matPrefix>watch</mat-icon>
          <mat-error>Campo obligatorio</mat-error>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Dispositivo de referencia *</mat-label>
          <input matInput formControlName="referenceName" placeholder="Polar H10">
          <mat-icon matPrefix>monitor_heart</mat-icon>
          <mat-error>Campo obligatorio</mat-error>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Descripción</mat-label>
          <textarea matInput formControlName="description" rows="2"
                    placeholder="Notas opcionales…"></textarea>
          <mat-icon matPrefix>notes</mat-icon>
        </mat-form-field>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button mat-dialog-close>Cancelar</button>
      <button mat-flat-button color="primary" [disabled]="form.invalid" (click)="confirm()">
        <mat-icon>add</mat-icon> Crear
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .dialog-form { display: flex; flex-direction: column; gap: 8px; min-width: 380px; padding-top: 8px; }
    mat-form-field { width: 100%; }
  `],
})
export class NewDeviceDialogComponent {
  form = this.fb.group({
    name:          ['', Validators.required],
    referenceName: ['', Validators.required],
    description:   [''],
  });

  constructor(
    private fb: FormBuilder,
    private ref: MatDialogRef<NewDeviceDialogComponent>,
  ) {}

  confirm(): void {
    if (this.form.valid) this.ref.close(this.form.value);
  }
}

// ── Devices list component ────────────────────────────────────────────────────

@Component({
  selector: 'app-devices',
  standalone: true,
  imports: [
    CommonModule, RouterModule,
    MatSnackBarModule, MatDialogModule,
  ],
  templateUrl: './devices.component.html',
  styleUrls: ['./devices.component.scss'],
})
export class DevicesComponent implements OnInit {
  devices: Device[] = [];
  loading = true;

  constructor(
    private api: ApiService,
    private snack: MatSnackBar,
    private dialog: MatDialog,
  ) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.api.listDevices().subscribe({
      next:  d  => { this.devices = d; this.loading = false; },
      error: () => { this.loading = false; },
    });
  }

  openCreate(): void {
    const ref = this.dialog.open(NewDeviceDialogComponent, { width: '460px' });
    ref.afterClosed().subscribe(val => {
      if (!val) return;
      this.api.createDevice(val.name, val.referenceName, val.description || '').subscribe({
        next: () => { this.snack.open('Dispositivo creado', 'OK', { duration: 2500 }); this.load(); },
        error: err => this.snack.open(err.error?.detail || 'Error al crear', 'Cerrar', { duration: 4000 }),
      });
    });
  }

  delete(dev: Device, event: Event): void {
    event.stopPropagation();
    if (!confirm(`¿Eliminar "${dev.name}" y todas sus sesiones?`)) return;
    this.api.deleteDevice(dev.id).subscribe({
      next: () => { this.snack.open('Dispositivo eliminado', 'OK', { duration: 2500 }); this.load(); },
      error: () => this.snack.open('Error al eliminar', 'Cerrar', { duration: 3000 }),
    });
  }

  /** Return 2-char uppercase initials from device name */
  initials(name: string): string {
    const words = name.trim().split(/\s+/);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  /** Return formatted date of most recent session */
  lastDate(dev: Device): string {
    if (!dev.training_types.length) return '—';
    const latest = dev.training_types
      .map(t => t.last_date)
      .filter(Boolean)
      .sort()
      .pop();
    if (!latest) return '—';
    const d = new Date(latest);
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  }

  /** Average CCC across all training types that have data */
  avgCcc(dev: Device): number | null {
    const vals = dev.training_types.map(t => t.avg_ccc).filter((v): v is number => v != null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  /** Average MAE across all training types that have data */
  avgMae(dev: Device): number | null {
    const vals = dev.training_types.map(t => t.avg_mae).filter((v): v is number => v != null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  /** Quality class for CCC/r value */
  cccQuality(v: number): string {
    if (v >= 0.95) return 'good';
    if (v >= 0.90) return 'warn';
    if (v >= 0.80) return 'orange';
    return 'bad';
  }

  /** Quality class for MAE value */
  maeQuality(v: number): string {
    if (v <= 3)  return 'good';
    if (v <= 5)  return 'warn';
    if (v <= 10) return 'orange';
    return 'bad';
  }
}

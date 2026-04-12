import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ApiService } from '../../services/api.service';
import { Session, TrainingType, metricQuality } from '../../models/session.model';

@Component({
  selector: 'app-sessions',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatFormFieldModule,
    MatCheckboxModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatChipsModule,
    MatDialogModule,
    MatTooltipModule,
  ],
  templateUrl: './sessions.component.html',
  styleUrls: ['./sessions.component.scss'],
})
export class SessionsComponent implements OnInit {
  sessions:      Session[]      = [];
  trainingTypes: TrainingType[] = [];
  filterType     = '';
  loading        = true;
  selectedIds    = new Set<string>();
  metricQuality  = metricQuality;
  Math           = Math;

  constructor(
    private api: ApiService,
    private snack: MatSnackBar,
  ) {}

  ngOnInit(): void {
    this.loadTypes();
    this.loadSessions();
  }

  loadTypes(): void {
    this.api.getTrainingTypes().subscribe(t => (this.trainingTypes = t));
  }

  loadSessions(): void {
    this.loading = true;
    this.api.listSessions(this.filterType || undefined).subscribe({
      next:  s  => { this.sessions = s; this.loading = false; },
      error: () => { this.loading = false; },
    });
  }

  onFilterChange(): void {
    this.selectedIds.clear();
    this.loadSessions();
  }

  toggleSelect(id: string): void {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
  }

  isSelected(id: string): boolean {
    return this.selectedIds.has(id);
  }

  selectAll(): void {
    this.sessions.forEach(s => this.selectedIds.add(s.id));
  }

  clearSelection(): void {
    this.selectedIds.clear();
  }

  get selectedSessions(): Session[] {
    return this.sessions.filter(s => this.selectedIds.has(s.id));
  }

  get selectedQueryParams(): { ids: string; type: string } {
    const sel = this.selectedSessions;
    return {
      ids:  sel.map(s => s.id).join(','),
      type: sel[0]?.training_type ?? '',
    };
  }

  groupQueryParams(sessions: Session[]): { ids: string; type: string } {
    return {
      ids:  sessions.map(s => s.id).join(','),
      type: sessions[0]?.training_type ?? '',
    };
  }

  /** Group sessions by training type for display. */
  get groupedSessions(): { type: string; sessions: Session[] }[] {
    const map = new Map<string, Session[]>();
    for (const s of this.sessions) {
      if (!map.has(s.training_type)) map.set(s.training_type, []);
      map.get(s.training_type)!.push(s);
    }
    return Array.from(map.entries()).map(([type, sessions]) => ({ type, sessions }));
  }

  delete(session: Session): void {
    if (!confirm(`¿Eliminar "${session.session_name}"?`)) return;
    this.api.deleteSession(session.id).subscribe({
      next: () => {
        this.sessions = this.sessions.filter(s => s.id !== session.id);
        this.selectedIds.delete(session.id);
        this.loadTypes();
        this.snack.open('Sesión eliminada', 'OK', { duration: 2000 });
      },
      error: () => this.snack.open('Error al eliminar', 'Cerrar', { duration: 3000 }),
    });
  }

  formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleString('es-ES', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }
}

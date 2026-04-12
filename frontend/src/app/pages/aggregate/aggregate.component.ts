import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatStepperModule } from '@angular/material/stepper';
import { MatDividerModule } from '@angular/material/divider';

import { ApiService } from '../../services/api.service';
import { AggregateResult, Session, TrainingType, metricQuality } from '../../models/session.model';
import { ChartViewerComponent } from '../../shared/chart-viewer/chart-viewer.component';
import { MetricsTableComponent } from '../../shared/metrics-table/metrics-table.component';

@Component({
  selector: 'app-aggregate',
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
    MatTableModule,
    MatStepperModule,
    MatDividerModule,
    ChartViewerComponent,
    MetricsTableComponent,
  ],
  templateUrl: './aggregate.component.html',
  styleUrls: ['./aggregate.component.scss'],
})
export class AggregateComponent implements OnInit {
  trainingTypes: TrainingType[] = [];
  sessions:      Session[]      = [];
  selectedType   = '';
  selectedIds    = new Set<string>();
  loadingSessions = false;
  loadingAggregate = false;
  result: AggregateResult | null = null;
  metricQuality = metricQuality;

  readonly zoneColumns = ['zone', 'range', 'pct_time', 'n', 'mae', 'mape', 'bias'];

  constructor(
    private api: ApiService,
    private route: ActivatedRoute,
    private snack: MatSnackBar,
  ) {}

  ngOnInit(): void {
    this.api.getTrainingTypes().subscribe(t => {
      this.trainingTypes = t;

      // Support deep-linking from sessions page: ?ids=...&type=...
      const qp = this.route.snapshot.queryParams;
      if (qp['type']) {
        this.selectedType = qp['type'];
        this.loadSessionsForType(qp['type'], qp['ids']?.split(','));
      }
    });
  }

  onTypeChange(): void {
    this.sessions    = [];
    this.selectedIds.clear();
    this.result      = null;
    if (this.selectedType) {
      this.loadSessionsForType(this.selectedType);
    }
  }

  private loadSessionsForType(type: string, preselect?: string[]): void {
    this.loadingSessions = true;
    this.api.listSessions(type).subscribe({
      next: s => {
        this.sessions = s;
        this.loadingSessions = false;
        if (preselect?.length) {
          preselect.forEach(id => {
            if (s.find(sess => sess.id === id)) {
              this.selectedIds.add(id);
            }
          });
        } else {
          // Auto-select all
          s.forEach(sess => this.selectedIds.add(sess.id));
        }
      },
      error: () => { this.loadingSessions = false; },
    });
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

  selectAll():   void { this.sessions.forEach(s => this.selectedIds.add(s.id)); }
  clearAll():    void { this.selectedIds.clear(); }

  canGenerate(): boolean {
    return this.selectedIds.size >= 1 && !this.loadingAggregate;
  }

  generate(): void {
    if (!this.canGenerate()) return;
    this.loadingAggregate = true;
    this.result = null;

    this.api.aggregate(Array.from(this.selectedIds), this.selectedType).subscribe({
      next: r => {
        this.result = r;
        this.loadingAggregate = false;
        this.snack.open('Análisis agregado generado', 'OK', { duration: 2500 });
      },
      error: err => {
        this.loadingAggregate = false;
        const msg = err.error?.detail || 'Error al generar el análisis agregado';
        this.snack.open(msg, 'Cerrar', { duration: 5000 });
      },
    });
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('es-ES', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  }

  zoneCssClass(name: string): string {
    const z = name.split(' ')[0].toLowerCase();
    return `zone-${z}`;
  }
}

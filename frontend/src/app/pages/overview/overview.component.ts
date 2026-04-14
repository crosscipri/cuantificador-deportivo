import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';

import { ApiService } from '../../services/api.service';
import { ChartViewerComponent } from '../../shared/chart-viewer/chart-viewer.component';
import { SportType, SPORT_TYPE_LABELS } from '../../models/session.model';

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [
    CommonModule, RouterModule, FormsModule,
    MatCardModule, MatButtonModule, MatButtonToggleModule, MatIconModule,
    MatProgressSpinnerModule,
    ChartViewerComponent,
  ],
  templateUrl: './overview.component.html',
  styleUrls: ['./overview.component.scss'],
})
export class OverviewComponent implements OnInit {
  loading  = false;
  chart:   string | null = null;
  deviceCount   = 0;
  totalSessions = 0;
  error = '';

  selectedSport: SportType = 'running';
  readonly sportTypes = Object.entries(SPORT_TYPE_LABELS) as [SportType, string][];

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.error   = '';
    this.chart   = null;

    this.api.getOverviewChart(this.selectedSport).subscribe({
      next: res => {
        this.chart         = res.chart;
        this.deviceCount   = res.device_count;
        this.totalSessions = res.total_sessions;
        this.loading       = false;
      },
      error: err => {
        this.error   = err.error?.detail || 'Error al generar el gráfico';
        this.loading = false;
      },
    });
  }
}

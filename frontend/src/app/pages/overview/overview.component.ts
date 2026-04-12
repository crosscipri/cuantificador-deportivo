import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { ApiService } from '../../services/api.service';
import { ChartViewerComponent } from '../../shared/chart-viewer/chart-viewer.component';

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [
    CommonModule, RouterModule,
    MatCardModule, MatButtonModule, MatIconModule,
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

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.error   = '';
    this.chart   = null;

    this.api.getOverviewChart().subscribe({
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

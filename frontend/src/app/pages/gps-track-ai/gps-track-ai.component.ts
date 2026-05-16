import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { GpsAiAnalysis } from '../../models/gps-analysis.model';

interface TrackModeStats {
  name: string; rmse: number; p95: number; mean_err: number;
  mape: number; delta_dist: number; sample_hz: number; n_samples: number;
}

@Component({
  selector: 'app-gps-track-ai',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './gps-track-ai.component.html',
  styleUrls: ['./gps-track-ai.component.scss'],
})
export class GpsTrackAiComponent implements OnInit {
  deviceId = '';
  testId = '';
  aiAnalysis: GpsAiAnalysis | null = null;
  loading = true;
  generating = false;
  error = '';
  modesStats: TrackModeStats[] | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ApiService,
  ) {}

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get('deviceId') || '';
    this.testId   = this.route.snapshot.paramMap.get('testId') || '';
    if (!this.deviceId || !this.testId) { this.router.navigate(['/devices']); return; }

    const stored = sessionStorage.getItem(`gps-track-modesStats-${this.testId}`);
    if (stored) try { this.modesStats = JSON.parse(stored); } catch {}

    this.api.getGpsTestAiAnalysis(this.testId).subscribe({
      next:  ai => { this.aiAnalysis = ai; this.loading = false; },
      error: ()  => { this.loading = false; },
    });
  }

  generate(): void {
    if (!this.modesStats) return;
    this.generating = true;
    this.error = '';
    this.aiAnalysis = null;
    this.api.generateGpsTestAiAnalysis(this.testId, this.modesStats).subscribe({
      next:  ai  => { this.aiAnalysis = ai; this.generating = false; },
      error: err => { this.error = err?.error?.detail ?? 'Error al generar el análisis IA'; this.generating = false; },
    });
  }

  nivelClass(nivel: string): string {
    const map: Record<string, string> = {
      'Competición': 'nivel-comp', 'Excelente': 'nivel-exc',
      'Apto': 'nivel-apto', 'No Apto': 'nivel-no',
    };
    return map[nivel] ?? '';
  }
}

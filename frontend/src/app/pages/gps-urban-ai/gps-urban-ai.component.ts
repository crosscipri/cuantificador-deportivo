import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { UrbanAiAnalysis } from '../../models/gps-analysis.model';

interface UrbanModeStatsCache {
  name: string; rmse: number; mape: number; p95: number;
  building_pct: number | null; corner_err: number | null; speed_jitter: number | null;
}
interface UrbanAiCache {
  modesStats: UrbanModeStatsCache[];
  refMeters: number;
}

@Component({
  selector: 'app-gps-urban-ai',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './gps-urban-ai.component.html',
  styleUrls: ['./gps-urban-ai.component.scss'],
})
export class GpsUrbanAiComponent implements OnInit {
  deviceId = '';
  testId = '';
  aiAnalysis: UrbanAiAnalysis | null = null;
  loading = true;
  generating = false;
  error = '';
  cache: UrbanAiCache | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ApiService,
  ) {}

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get('deviceId') || '';
    this.testId   = this.route.snapshot.paramMap.get('testId') || '';
    if (!this.deviceId || !this.testId) { this.router.navigate(['/devices']); return; }

    const stored = sessionStorage.getItem(`gps-urban-aiCache-${this.testId}`);
    if (stored) try { this.cache = JSON.parse(stored); } catch {}

    this.api.getUrbanTestAiAnalysis(this.testId).subscribe({
      next:  ai => { this.aiAnalysis = ai; this.loading = false; },
      error: ()  => { this.loading = false; },
    });
  }

  get canGenerate(): boolean { return this.cache !== null; }

  generate(): void {
    if (!this.cache) return;
    this.generating = true;
    this.error = '';
    this.aiAnalysis = null;
    this.api.generateUrbanTestAiAnalysis(this.testId, this.cache.modesStats, this.cache.refMeters).subscribe({
      next:  ai  => { this.aiAnalysis = ai; this.generating = false; },
      error: err => { this.error = err?.error?.detail ?? 'Error al generar el análisis IA'; this.generating = false; },
    });
  }
}

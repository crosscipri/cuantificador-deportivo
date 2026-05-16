import { Component, OnInit } from '@angular/core';
import { CommonModule, TitleCasePipe } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';

import { ApiService } from '../../services/api.service';
import { Device, AiVerdict, AiCalificacion } from '../../models/session.model';

@Component({
  selector: 'app-device-ai-verdict',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './device-ai-verdict.component.html',
  styleUrls: ['./device-ai-verdict.component.scss'],
})
export class DeviceAiVerdictComponent implements OnInit {
  deviceId = '';
  device: Device | null = null;

  aiVerdict: AiVerdict | null = null;
  loading = true;
  generating = false;
  error = '';

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ApiService,
  ) {}

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get('deviceId') || '';
    if (!this.deviceId) { this.router.navigate(['/devices']); return; }
    this.api.getDevice(this.deviceId).subscribe({
      next: dev => {
        this.device = dev;
        if (dev.has_ai_verdict) {
          this.loadVerdict();
        } else {
          this.loading = false;
        }
      },
      error: () => this.router.navigate(['/devices']),
    });
  }

  loadVerdict(): void {
    this.loading = true;
    this.error = '';
    this.api.getDeviceAiVerdict(this.deviceId).subscribe({
      next: v => { this.aiVerdict = v; this.loading = false; },
      error: () => { this.error = 'No se pudo cargar el veredicto.'; this.loading = false; },
    });
  }

  generate(): void {
    this.generating = true;
    this.error = '';
    this.aiVerdict = null;
    this.api.generateDeviceAiVerdict(this.deviceId).subscribe({
      next: v => {
        this.aiVerdict = v;
        this.generating = false;
        if (this.device) this.device.has_ai_verdict = true;
      },
      error: err => {
        this.error = err.error?.detail || 'Error al generar el veredicto IA.';
        this.generating = false;
      },
    });
  }

  calClass(cal: AiCalificacion | undefined): string {
    const map: Record<AiCalificacion, string> = {
      excelente: 'good', bueno: 'warn', moderado: 'orange', deficiente: 'bad',
    };
    return cal ? (map[cal] ?? '') : '';
  }
}

import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Metrics, metricQuality } from '../../models/session.model';

@Component({
  selector: 'app-metrics-table',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './metrics-table.component.html',
  styleUrls: ['./metrics-table.component.scss'],
})
export class MetricsTableComponent {
  @Input() metrics!: Metrics;
  @Input() lag: number | null = null;

  metricQuality = metricQuality;
  Math = Math;

  get biasSign(): string {
    return this.metrics.bias > 0 ? '+' : '';
  }
}

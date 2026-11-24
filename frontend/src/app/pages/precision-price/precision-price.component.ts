import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { BaseChartDirective } from 'ng2-charts';
import { ApiService } from '../../services/api.service';
import { PrecisionPriceDevice, PrecisionPriceResponse, PrecisionPriceView } from '../../models/precision-price.model';
import { formatDate, insideLabelsPlugin, paretoCaptionPlugin, priceScoreChart, VIEW_COPY } from './precision-price-charts';

interface ChartView {
  key: PrecisionPriceView;
  title: string;
  subtitle: string;
  chart: { data: any; options: any };
  few: PrecisionPriceDevice[];
}

@Component({
  selector: 'app-precision-price',
  standalone: true,
  imports: [CommonModule, RouterLink, BaseChartDirective],
  templateUrl: './precision-price.component.html',
  styleUrls: ['../night-validation/night-validation.component.scss', './precision-price.component.scss'],
})
export class PrecisionPriceComponent implements OnInit {
  loading = true;
  error = '';
  response: PrecisionPriceResponse | null = null;
  views: ChartView[] = [];
  readonly plugins = [insideLabelsPlugin, paretoCaptionPlugin];
  readonly formatDate = formatDate;

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.api.getPrecisionPrice().subscribe({
      next: res => {
        this.response = res;
        this.views = (['sports', 'night', 'final'] as PrecisionPriceView[]).map(key => ({
          key,
          title: VIEW_COPY[key].title,
          subtitle: VIEW_COPY[key].subtitle,
          chart: priceScoreChart(res[key] ?? [], key),
          few: (res[key] ?? []).filter(d => d.few),
        }));
        this.loading = false;
      },
      error: err => {
        this.error = err?.status === 401
          ? 'Necesitas iniciar sesión para ver los datos.'
          : 'No se han podido cargar las notas de precisión y los precios.';
        this.loading = false;
      },
    });
  }

  get hasData(): boolean {
    return !!this.response && (this.response.sports.length + this.response.night.length + this.response.final.length) > 0;
  }

  formulaLine(): string {
    const f = this.response?.formula;
    if (!f) return '';
    const date = formatDate(this.response?.price_checked_at);
    return (
      `Nota = 0,5·nota_MAE + 0,5·nota_r, con constantes fijas (r₀=${this.comma(f.r0)}; ` +
      `MAE_max deporte ${this.comma(f.mae_max.sport_hr_bpm, 0)} lpm, ` +
      `FC reposo ${this.comma(f.mae_max.rest_hr_bpm, 0)} lpm, ` +
      `RMSSD ${this.comma(f.mae_max.rmssd_ms, 0)} ms). ` +
      `Precios: oferta verificada más barata${date ? ` del ${date}` : ''}. ` +
      `Mejor relación: arriba a la derecha. ★ frontera de Pareto.`
    );
  }

  fewText(list: PrecisionPriceDevice[], key: PrecisionPriceView): string {
    if (key === 'sports') return list.map(d => `${d.name} (${d.sessions})`).join(', ');
    return list.map(d => `${d.name} (${d.nights ?? d.night_nights})`).join(', ');
  }

  trackByKey(_: number, v: ChartView): string { return v.key; }

  missingNames(list: { name: string }[]): string {
    return list.map(d => d.name).join(', ');
  }

  private comma(value: number, digits = 2): string {
    return value.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
}

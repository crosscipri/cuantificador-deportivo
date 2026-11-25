import { Component, Injectable, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BaseChartDirective } from 'ng2-charts';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, shareReplay } from 'rxjs/operators';
import { ApiService } from '../../services/api.service';
import type { PrecisionPriceDevice, PrecisionPriceView } from '../../models/precision-price.model';
import type { SportValidationResponse } from '../../models/sport-validation.model';
import type { NightValidationResponse } from '../../models/night-validation.model';
import { statBoxPlugin } from '../night-validation/night-validation-charts';
import { DETAIL_GRIDS, DetailCard, DetailGrid, buildDetailGrids, selectSource } from './precision-price-details';

/** Descarga una sola vez (y solo si hace falta) las validaciones por deporte y por noche. */
@Injectable({ providedIn: 'root' })
export class PrecisionPriceDetailsData {
  private sport$?: Observable<SportValidationResponse | null>;
  private night$?: Observable<NightValidationResponse | null>;

  constructor(private api: ApiService) {}

  sport(): Observable<SportValidationResponse | null> {
    return this.sport$ ??= this.api.getSportValidation().pipe(catchError(() => of(null)), shareReplay(1));
  }

  night(): Observable<NightValidationResponse | null> {
    return this.night$ ??= this.api.getNightValidation().pipe(catchError(() => of(null)), shareReplay(1));
  }
}

@Component({
  selector: 'app-precision-price-details',
  standalone: true,
  imports: [CommonModule, BaseChartDirective],
  templateUrl: './precision-price-details.component.html',
  styleUrls: ['../night-validation/night-validation.component.scss', './precision-price.component.scss'],
})
export class PrecisionPriceDetailsComponent implements OnInit {
  @Input({ required: true }) view!: PrecisionPriceView;
  @Input({ required: true }) devices: PrecisionPriceDevice[] = [];

  loading = true;
  failed = false;
  grids: DetailGrid[] = [];
  readonly statPlugins = [statBoxPlugin];

  constructor(private data: PrecisionPriceDetailsData) {}

  ngOnInit(): void {
    const keys = DETAIL_GRIDS[this.view];
    const needSport = keys.some(k => k.startsWith('sport'));
    const needNight = keys.some(k => k.startsWith('night'));
    forkJoin({
      sport: needSport ? this.data.sport() : of(null),
      night: needNight ? this.data.night() : of(null),
    }).subscribe(({ sport, night }) => {
      this.failed = (needSport && !sport) || (needNight && !night);
      this.grids = buildDetailGrids(this.view, this.devices, sport, night);
      this.loading = false;
    });
  }

  select(card: DetailCard, index: string | number): void { selectSource(card, index); }
  trackByKey(_: number, g: DetailGrid): string { return g.key; }
  trackByDevice(_: number, c: DetailCard): string { return c.deviceId; }
}

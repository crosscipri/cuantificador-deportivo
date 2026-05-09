import { Component, OnInit, OnDestroy, AfterViewInit, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import * as L from 'leaflet';

import { GpxParserService } from '../../services/gpx-parser.service';
import { GpsMode, GpsModeStats, GpsTrackAnalysis, GPS_MODE_COLORS } from '../../models/gps-analysis.model';

interface ModeSetup {
  id: string;
  name: string;
  color: string;
  fileInputFiles: File[];
  loading: boolean;
  error: string;
}

@Component({
  selector: 'app-gps-track-analysis',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './gps-track-analysis.component.html',
  styleUrls: ['./gps-track-analysis.component.scss'],
})
export class GpsTrackAnalysisComponent implements OnInit, OnDestroy, AfterViewInit {
  @ViewChild('mapEl') mapEl!: ElementRef<HTMLDivElement>;

  deviceId = '';
  referenceDistance = 1600;

  modes: ModeSetup[] = [];
  analysis: GpsTrackAnalysis | null = null;
  analyzing = false;
  analyzeError = '';

  private map?: L.Map;
  private layerGroup?: L.LayerGroup;
  private mapInitialized = false;

  readonly GPS_MODE_COLORS = GPS_MODE_COLORS;
  readonly Math = Math;

  // Preset mode names matching Garmin FR265 GPS modes
  readonly presetModeNames = [
    'GPS Solo',
    'Todos los Sistemas',
    'Todos + Multibanda',
    'SatIQ',
    'UltraTrac',
  ];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private gpxParser: GpxParserService,
  ) {}

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get('deviceId') || '';
    this.addMode();
  }

  ngAfterViewInit(): void {
    // Map will be initialized after analysis runs
  }

  ngOnDestroy(): void {
    this.map?.remove();
  }

  addMode(): void {
    const idx = this.modes.length;
    this.modes.push({
      id: crypto.randomUUID(),
      name: this.presetModeNames[idx] ?? `Modo ${idx + 1}`,
      color: GPS_MODE_COLORS[idx % GPS_MODE_COLORS.length],
      fileInputFiles: [],
      loading: false,
      error: '',
    });
  }

  removeMode(idx: number): void {
    this.modes.splice(idx, 1);
  }

  onFilesSelected(event: Event, mode: ModeSetup): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    mode.fileInputFiles = files.slice(0, 5);
    mode.error = '';
  }

  onDrop(event: DragEvent, mode: ModeSetup): void {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? [])
      .filter(f => f.name.toLowerCase().endsWith('.gpx'));
    mode.fileInputFiles = files.slice(0, 5);
    mode.error = '';
  }

  onDragOver(e: DragEvent): void { e.preventDefault(); }

  canAnalyze(): boolean {
    return !this.analyzing && this.modes.some(m => m.fileInputFiles.length > 0);
  }

  async analyze(): Promise<void> {
    this.analyzing = true;
    this.analyzeError = '';
    this.analysis = null;

    try {
      const gpsModes: GpsMode[] = [];
      for (const setup of this.modes) {
        if (!setup.fileInputFiles.length) continue;
        setup.loading = true;
        setup.error = '';
        const runs = await Promise.all(
          setup.fileInputFiles.map(f => this.gpxParser.parseFile(f))
        );
        setup.loading = false;
        gpsModes.push({ id: setup.id, name: setup.name, color: setup.color, files: runs });
      }

      this.analysis = this.gpxParser.buildAnalysis(gpsModes, this.referenceDistance);
      setTimeout(() => this.initMap(), 50);
    } catch (err: any) {
      this.analyzeError = err?.message ?? 'Error al procesar los ficheros GPX';
    } finally {
      this.analyzing = false;
    }
  }

  private initMap(): void {
    if (!this.analysis || !this.mapEl) return;

    // Collect all points to set bounds
    const allPoints: L.LatLng[] = [];
    for (const mode of this.analysis.modes) {
      for (const run of mode.files) {
        for (const pt of run.points) allPoints.push(L.latLng(pt.lat, pt.lon));
      }
    }
    if (!allPoints.length) return;

    // Destroy and recreate map (handles re-analysis)
    if (this.map) { this.map.remove(); this.map = undefined; }

    this.map = L.map(this.mapEl.nativeElement, { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(this.map);

    this.layerGroup = L.layerGroup().addTo(this.map);

    for (const mode of this.analysis.modes) {
      for (const run of mode.files) {
        const latlngs = run.points.map(p => L.latLng(p.lat, p.lon));
        L.polyline(latlngs, {
          color: mode.color,
          weight: 2,
          opacity: 0.7,
        }).addTo(this.layerGroup!);
      }
    }

    // Start/end markers on the first run of the first mode
    const firstRun = this.analysis.modes[0]?.files[0];
    if (firstRun?.points.length) {
      const start = firstRun.points[0];
      const end   = firstRun.points[firstRun.points.length - 1];
      L.circleMarker([start.lat, start.lon], { radius: 6, color: '#10b981', fillColor: '#10b981', fillOpacity: 1 })
        .bindTooltip('Inicio').addTo(this.layerGroup!);
      L.circleMarker([end.lat, end.lon], { radius: 6, color: '#ef4444', fillColor: '#ef4444', fillOpacity: 1 })
        .bindTooltip('Fin').addTo(this.layerGroup!);
    }

    const bounds = L.latLngBounds(allPoints);
    this.map.fitBounds(bounds, { padding: [30, 30] });
    this.mapInitialized = true;
  }

  // ── Stats helpers ────────────────────────────────────────────────────────

  sortedStats(): GpsModeStats[] {
    if (!this.analysis) return [];
    return [...this.analysis.stats].sort((a, b) => a.mape - b.mape);
  }

  mapeBadge(mape: number): string {
    return mape <= 0.5 ? 'good' : mape <= 1 ? 'warn' : mape <= 2 ? 'orange' : 'bad';
  }

  cvBadge(cv: number): string {
    return cv <= 0.5 ? 'good' : cv <= 1 ? 'warn' : cv <= 2 ? 'orange' : 'bad';
  }

  rmseBadge(rmse: number): string {
    return rmse <= 8 ? 'good' : rmse <= 16 ? 'warn' : rmse <= 32 ? 'orange' : 'bad';
  }

  fmt(v: number, dec = 1): string { return v.toFixed(dec); }

  fmtDist(v: number): string {
    return `${(v / 1000).toFixed(3)} km (${Math.round(v)} m)`;
  }

  errorSign(v: number): string { return v > 0 ? '+' : ''; }
}

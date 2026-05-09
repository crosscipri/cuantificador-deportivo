import { Component, OnInit, OnDestroy, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';

import { GpxParserService } from '../../services/gpx-parser.service';
import { GpsMode, GpsModeStats, GpsTrackAnalysis, GPS_MODE_COLORS } from '../../models/gps-analysis.model';
import {
  STRAIGHT, R_INNER, LANE_W, N_LANES,
  runRadius, trackBbox, lapLength, pathEdge, pointAt,
} from './track-geometry';

interface ModeSetup {
  id: string;
  name: string;
  color: string;
  fileInputFiles: File[];
  loading: boolean;
  error: string;
}

interface TrackPoint { x: number; y: number }

interface ProjectedRun {
  modeId: string;
  modeName: string;
  color: string;
  runIdx: number;
  pathD: string;
  points: TrackPoint[];
}

interface HoveredPoint {
  worldX: number;
  worldY: number;
  screenX: number;
  screenY: number;
  modeColor: string;
  modeName: string;
}

@Component({
  selector: 'app-gps-track-analysis',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './gps-track-analysis.component.html',
  styleUrls: ['./gps-track-analysis.component.scss'],
})
export class GpsTrackAnalysisComponent implements OnInit, OnDestroy {
  @ViewChild('trackSvg')   trackSvgEl!:   ElementRef<SVGSVGElement>;
  @ViewChild('trackStage') trackStageEl!: ElementRef<HTMLDivElement>;

  deviceId = '';
  referenceDistance = 1600;

  modes: ModeSetup[] = [];
  analysis: GpsTrackAnalysis | null = null;
  analyzing    = false;
  analyzeError = '';

  // ── Track SVG state ────────────────────────────────────────────────────────
  trackStyle: 'realista' | 'esquematica' | 'blueprint' = 'realista';
  trackZoom   = 1;
  trackPanX   = 0;
  trackPanY   = 0;
  hoveredPoint: HoveredPoint | null = null;
  projectedRuns: ProjectedRun[]     = [];

  private svgDrag: { startX: number; startY: number; panX: number; panY: number } | null = null;
  get isDragging(): boolean { return !!this.svgDrag; }

  // ── IAAF track geometry (precomputed once) ─────────────────────────────────
  readonly STRAIGHT = STRAIGHT;
  readonly R_INNER  = R_INNER;
  readonly LANE_W   = LANE_W;
  readonly N_LANES  = N_LANES;
  readonly Math     = Math;

  readonly innerKerb = pathEdge(R_INNER);
  readonly outerKerb = pathEdge(R_INNER + LANE_W * N_LANES);
  readonly trackRing = `${pathEdge(R_INNER + LANE_W * N_LANES)} ${pathEdge(R_INNER)}`;
  readonly lane1Run  = pathEdge(runRadius(1));
  readonly lanePaths = Array.from({ length: N_LANES - 1 }, (_, i) =>
    pathEdge(R_INNER + (i + 1) * LANE_W)
  );

  readonly finishLine = {
    x:  STRAIGHT / 2,
    y0: -R_INNER,
    y1: -(R_INNER + LANE_W * N_LANES),
  };

  readonly line100m = (() => {
    const d = (lapLength(1) - 100 + lapLength(1)) % lapLength(1);
    const [px] = pointAt(1, d);
    return { x: px, y0: -R_INNER, y1: -(R_INNER + LANE_W * N_LANES) };
  })();

  readonly distanceMarks = (() => {
    const marks: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
    const lap = lapLength(1);
    for (let d = 0; d < lap; d += 10) {
      const [px, py, pang] = pointAt(1, d);
      const major = d % 100 === 0;
      const len   = major ? 0.45 : 0.22;
      const ox    = -Math.sin(pang);
      const oy    =  Math.cos(pang);
      marks.push({ x1: px - ox * 0.05, y1: py - oy * 0.05, x2: px - ox * len, y2: py - oy * len, major });
    }
    return marks;
  })();

  readonly stagger200Marks = (() => {
    const marks: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (let n = 1; n <= N_LANES; n++) {
      const lap  = lapLength(n);
      const d200 = (lap - 200 + lap) % lap;
      const [px, py, pang] = pointAt(n, d200);
      const w  = LANE_W * 0.45;
      const nx = -Math.sin(pang);
      const ny =  Math.cos(pang);
      marks.push({ x1: px - nx * w, y1: py - ny * w, x2: px + nx * w, y2: py + ny * w });
    }
    return marks;
  })();

  readonly laneNumbers = Array.from({ length: N_LANES }, (_, i) => ({
    n:  i + 1,
    cx: STRAIGHT / 2 - 4,
    cy: -runRadius(i + 1),
  }));

  get trackViewBox(): string {
    const bb  = trackBbox();
    const PAD = 12;
    const bvW = bb.maxX - bb.minX + PAD * 2;
    const bvH = bb.maxY - bb.minY + PAD * 2;
    const cx  = bb.minX - PAD + bvW / 2 + this.trackPanX;
    const cy  = bb.minY - PAD + bvH / 2 + this.trackPanY;
    const w   = bvW / this.trackZoom;
    const h   = bvH / this.trackZoom;
    return `${cx - w / 2} ${cy - h / 2} ${w} ${h}`;
  }

  get analysisModes() { return this.analysis?.modes ?? []; }

  readonly GPS_MODE_COLORS = GPS_MODE_COLORS;

  readonly presetModeNames = [
    'GPS Solo', 'Todos los Sistemas', 'Todos + Multibanda', 'SatIQ', 'UltraTrac',
  ];

  constructor(
    private route: ActivatedRoute,
    private gpxParser: GpxParserService,
  ) {}

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get('deviceId') || '';
    this.addMode();
  }

  ngOnDestroy(): void {}

  // ── Mode setup ─────────────────────────────────────────────────────────────

  addMode(): void {
    const idx = this.modes.length;
    this.modes.push({
      id:             crypto.randomUUID(),
      name:           this.presetModeNames[idx] ?? `Modo ${idx + 1}`,
      color:          GPS_MODE_COLORS[idx % GPS_MODE_COLORS.length],
      fileInputFiles: [],
      loading:        false,
      error:          '',
    });
  }

  removeMode(idx: number): void { this.modes.splice(idx, 1); }

  onFilesSelected(event: Event, mode: ModeSetup): void {
    const input = event.target as HTMLInputElement;
    mode.fileInputFiles = Array.from(input.files ?? []).slice(0, 5);
    mode.error = '';
  }

  onDrop(event: DragEvent, mode: ModeSetup): void {
    event.preventDefault();
    mode.fileInputFiles = Array.from(event.dataTransfer?.files ?? [])
      .filter(f => f.name.toLowerCase().endsWith('.gpx')).slice(0, 5);
    mode.error = '';
  }

  onDragOver(e: DragEvent): void { e.preventDefault(); }

  canAnalyze(): boolean {
    return !this.analyzing && this.modes.some(m => m.fileInputFiles.length > 0);
  }

  async analyze(): Promise<void> {
    this.analyzing    = true;
    this.analyzeError = '';
    this.analysis     = null;
    this.projectedRuns = [];

    try {
      const gpsModes: GpsMode[] = [];
      for (const setup of this.modes) {
        if (!setup.fileInputFiles.length) continue;
        setup.loading = true;
        setup.error   = '';
        const runs = await Promise.all(setup.fileInputFiles.map(f => this.gpxParser.parseFile(f)));
        setup.loading = false;
        gpsModes.push({ id: setup.id, name: setup.name, color: setup.color, files: runs });
      }
      this.analysis      = this.gpxParser.buildAnalysis(gpsModes, this.referenceDistance);
      this.projectedRuns = this.projectGpsToTrack();
      this.trackZoom = 1; this.trackPanX = 0; this.trackPanY = 0;
    } catch (err: any) {
      this.analyzeError = err?.message ?? 'Error al procesar los ficheros GPX';
    } finally {
      this.analyzing = false;
    }
  }

  // ── GPS → Track projection (equirectangular + PCA rotation) ───────────────

  private projectGpsToTrack(): ProjectedRun[] {
    if (!this.analysis) return [];

    const allPts: { lat: number; lon: number }[] = [];
    for (const mode of this.analysis.modes)
      for (const run of mode.files) allPts.push(...run.points);
    if (!allPts.length) return [];

    const centLat = allPts.reduce((s, p) => s + p.lat, 0) / allPts.length;
    const centLon = allPts.reduce((s, p) => s + p.lon, 0) / allPts.length;
    const cosLat  = Math.cos(centLat * Math.PI / 180);
    const R = 6371000;

    const toLocal = (p: { lat: number; lon: number }): TrackPoint => ({
      x: (p.lon - centLon) * cosLat * R * Math.PI / 180,
      y: (p.lat - centLat) * R * Math.PI / 180,
    });

    // PCA — find principal orientation angle
    const local = allPts.map(toLocal);
    const mx  = local.reduce((s, p) => s + p.x, 0) / local.length;
    const my  = local.reduce((s, p) => s + p.y, 0) / local.length;
    const cxx = local.reduce((s, p) => s + (p.x - mx) ** 2, 0) / local.length;
    const cxy = local.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / local.length;
    const cyy = local.reduce((s, p) => s + (p.y - my) ** 2, 0) / local.length;
    const tr  = cxx + cyy;
    const lam = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - (cxx * cyy - cxy * cxy)));
    let angle = cxy !== 0 ? Math.atan2(lam - cxx, cxy) : (cxx >= cyy ? 0 : Math.PI / 2);

    const rot = (p: TrackPoint, a: number): TrackPoint => ({
      x: (p.x - mx) * Math.cos(-a) - (p.y - my) * Math.sin(-a),
      y: (p.x - mx) * Math.sin(-a) + (p.y - my) * Math.cos(-a),
    });

    // If height > width after rotation, the track is sideways — rotate 90°
    const rotated = local.map(p => rot(p, angle));
    const rW = Math.max(...rotated.map(p => p.x)) - Math.min(...rotated.map(p => p.x));
    const rH = Math.max(...rotated.map(p => p.y)) - Math.min(...rotated.map(p => p.y));
    if (rH > rW) angle += Math.PI / 2;

    const transform = (p: { lat: number; lon: number }): TrackPoint => rot(toLocal(p), angle);

    const result: ProjectedRun[] = [];
    for (const mode of this.analysis.modes) {
      mode.files.forEach((run, ri) => {
        const pts = run.points.map(transform);
        const pathD = pts.map((p, i) =>
          (i === 0 ? `M ${p.x.toFixed(3)} ${p.y.toFixed(3)}` : `L ${p.x.toFixed(3)} ${p.y.toFixed(3)}`)
        ).join(' ');
        result.push({ modeId: mode.id, modeName: mode.name, color: mode.color, runIdx: ri, pathD, points: pts });
      });
    }
    return result;
  }

  // ── SVG event handlers ─────────────────────────────────────────────────────

  onTrackMouseMove(e: MouseEvent): void {
    if (this.svgDrag) {
      const bb  = trackBbox();
      const PAD = 12;
      const bvW = bb.maxX - bb.minX + PAD * 2;
      const bvH = bb.maxY - bb.minY + PAD * 2;
      const el  = this.trackStageEl?.nativeElement;
      if (!el) return;
      const dx = (e.clientX - this.svgDrag.startX) * (bvW / this.trackZoom) / el.clientWidth;
      const dy = (e.clientY - this.svgDrag.startY) * (bvH / this.trackZoom) / el.clientHeight;
      this.trackPanX = this.svgDrag.panX - dx;
      this.trackPanY = this.svgDrag.panY + dy;
      return;
    }

    if (!this.projectedRuns.length || !this.trackSvgEl) return;
    const svg = this.trackSvgEl.nativeElement;
    const pt  = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const sp = pt.matrixTransform(ctm.inverse());
    const wx = sp.x;
    const wy = -sp.y; // scale(1,-1) applied inside <g>

    let best: { d2: number; run: ProjectedRun; pt: TrackPoint } | null = null;
    for (const run of this.projectedRuns) {
      for (const p of run.points) {
        const d2 = (p.x - wx) ** 2 + (p.y - wy) ** 2;
        if (!best || d2 < best.d2) best = { d2, run, pt: p };
      }
    }

    if (best && best.d2 < 25) {
      const rect = this.trackStageEl.nativeElement.getBoundingClientRect();
      this.hoveredPoint = {
        worldX: best.pt.x, worldY: best.pt.y,
        screenX: e.clientX - rect.left,
        screenY: e.clientY - rect.top,
        modeColor: best.run.color,
        modeName:  best.run.modeName,
      };
    } else {
      this.hoveredPoint = null;
    }
  }

  onTrackMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    this.svgDrag = { startX: e.clientX, startY: e.clientY, panX: this.trackPanX, panY: this.trackPanY };
  }

  onTrackMouseUp():    void { this.svgDrag = null; }
  onTrackMouseLeave(): void { this.svgDrag = null; this.hoveredPoint = null; }

  onTrackWheel(e: WheelEvent): void {
    e.preventDefault();
    const f = e.deltaY > 0 ? 0.9 : 1.1;
    this.trackZoom = Math.max(0.6, Math.min(8, this.trackZoom * f));
  }

  resetTrack(): void { this.trackZoom = 1; this.trackPanX = 0; this.trackPanY = 0; }
  zoomIn():     void { this.trackZoom = Math.min(8, this.trackZoom * 1.25); }
  zoomOut():    void { this.trackZoom = Math.max(0.6, this.trackZoom / 1.25); }

  // ── Stats helpers ──────────────────────────────────────────────────────────

  sortedStats(): GpsModeStats[] {
    if (!this.analysis) return [];
    return [...this.analysis.stats].sort((a, b) => a.mape - b.mape);
  }

  mapeBadge(v: number): string { return v <= 0.5 ? 'good' : v <= 1 ? 'warn' : v <= 2 ? 'orange' : 'bad'; }
  cvBadge(v: number):   string { return v <= 0.5 ? 'good' : v <= 1 ? 'warn' : v <= 2 ? 'orange' : 'bad'; }
  rmseBadge(v: number): string { return v <= 8   ? 'good' : v <= 16 ? 'warn' : v <= 32 ? 'orange' : 'bad'; }

  fmt(v: number, dec = 1): string { return v.toFixed(dec); }
  errorSign(v: number): string    { return v > 0 ? '+' : ''; }
}

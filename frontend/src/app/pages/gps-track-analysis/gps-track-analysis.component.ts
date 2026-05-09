import { Component, OnInit, ElementRef, ViewChild } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';

import { GpxParserService } from '../../services/gpx-parser.service';
import { ApiService } from '../../services/api.service';
import { GpsMode, GPS_MODE_COLORS, GpsTestSummary, GpsTestDetail } from '../../models/gps-analysis.model';
import {
  STRAIGHT, R_INNER, LANE_W, N_LANES,
  runRadius, trackBbox, lapLength, pathEdge, pointAt, nearestOnLane1,
} from './track-geometry';

// ── Interfaces ──────────────────────────────────────────────────────────────

interface ModeSetup {
  id: string; name: string; color: string;
  fileInputFiles: File[]; loading: boolean; error: string;
}

interface AnalyticsPoint {
  x: number; y: number;
  err: number;   // perpendicular distance to lane 1 (m)
  d: number;     // arc position along lane 1 in current lap (m)
  cumD: number;  // cumulative GPS path distance for timeline X axis (m)
}

interface AnalyticsRun { pathD: string; points: AnalyticsPoint[]; }

interface GpsModeAnalytics {
  modeId: string; modeName: string; color: string;
  visible: boolean; selected: boolean;
  runs: AnalyticsRun[];
  allPoints: AnalyticsPoint[];  // all runs merged for stats
  meanErr: number; maxErr: number;
  recDist: number;   // recorded GPS distance (avg across runs)
  trueDist: number;  // reference distance
  deltaDist: number; // recDist - trueDist
  sampleHz: number;  // samples/s (0 if no time data)
  nSamples: number;
  hist: number[];         // 12 bins, 0–6 m at 0.5 m each
  heatmapBins: number[];  // 50 bins normalized 0..1 by avg error per lap sector
}

interface HoveredTrackPoint {
  worldX: number; worldY: number;
  screenX: number; screenY: number;
  modeColor: string; modeName: string; err: number;
}

// ── Timeline constants ──────────────────────────────────────────────────────
const TL_W = 340, TL_H = 110, TL_PL = 26, TL_PR = 8, TL_PT = 8, TL_PB = 18;
const TL_BINS = 50;

@Component({
  selector: 'app-gps-track-analysis',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, DatePipe],
  templateUrl: './gps-track-analysis.component.html',
  styleUrls: ['./gps-track-analysis.component.scss'],
})
export class GpsTrackAnalysisComponent implements OnInit {
  @ViewChild('trackSvg')   trackSvgEl!:   ElementRef<SVGSVGElement>;
  @ViewChild('trackStage') trackStageEl!: ElementRef<HTMLDivElement>;

  deviceId = '';
  referenceDistance = 1600;

  modes: ModeSetup[] = [];
  analyzing    = false;
  analyzeError = '';

  savedTests:    GpsTestSummary[] = [];
  loadingTests   = false;
  savingTest     = false;
  currentTestId: string | null = null;

  analytics: GpsModeAnalytics[] | null = null;
  hoveredModeId: string | null = null;

  trackStyle: 'realista' | 'esquematica' | 'blueprint' = 'realista';
  trackZoom   = 1;
  trackPanX   = 0;
  trackPanY   = 0;
  hoveredTrackPoint: HoveredTrackPoint | null = null;

  private svgDrag: { startX: number; startY: number; panX: number; panY: number } | null = null;

  // ── Exposed constants for template ──────────────────────────────────────
  readonly STRAIGHT = STRAIGHT;
  readonly R_INNER  = R_INNER;
  readonly LANE_W   = LANE_W;
  readonly N_LANES  = N_LANES;
  readonly Math     = Math;

  // ── Precomputed track geometry ──────────────────────────────────────────
  readonly innerKerb = pathEdge(R_INNER);
  readonly outerKerb = pathEdge(R_INNER + LANE_W * N_LANES);
  readonly trackRing = `${pathEdge(R_INNER + LANE_W * N_LANES)} ${pathEdge(R_INNER)}`;
  readonly lane1Run  = pathEdge(runRadius(1));
  readonly lanePaths = Array.from({ length: N_LANES - 1 }, (_, i) =>
    pathEdge(R_INNER + (i + 1) * LANE_W)
  );
  readonly finishLine = {
    x:  STRAIGHT / 2, y0: -R_INNER, y1: -(R_INNER + LANE_W * N_LANES),
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
      const len = major ? 0.45 : 0.22;
      const ox = -Math.sin(pang), oy = Math.cos(pang);
      marks.push({ x1: px - ox * 0.05, y1: py - oy * 0.05, x2: px - ox * len, y2: py - oy * len, major });
    }
    return marks;
  })();
  readonly stagger200Marks = (() => {
    const marks: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (let n = 1; n <= N_LANES; n++) {
      const lap = lapLength(n);
      const d200 = (lap - 200 + lap) % lap;
      const [px, py, pang] = pointAt(n, d200);
      const w = LANE_W * 0.45;
      const nx = -Math.sin(pang), ny = Math.cos(pang);
      marks.push({ x1: px - nx * w, y1: py - ny * w, x2: px + nx * w, y2: py + ny * w });
    }
    return marks;
  })();
  readonly laneNumbers = Array.from({ length: N_LANES }, (_, i) => ({
    n: i + 1, cx: STRAIGHT / 2 - 4, cy: -runRadius(i + 1),
  }));

  readonly GPS_MODE_COLORS = GPS_MODE_COLORS;
  readonly presetModeNames = [
    'GPS Solo', 'Todos los Sistemas', 'Todos + Multibanda', 'SatIQ', 'UltraTrac',
  ];

  // ── Getters ──────────────────────────────────────────────────────────────

  get isDragging(): boolean { return !!this.svgDrag; }

  get selectedAnalytics(): GpsModeAnalytics | null {
    return this.analytics?.find(m => m.selected) ?? this.analytics?.[0] ?? null;
  }

  get visibleAnalytics(): GpsModeAnalytics[] {
    return this.analytics?.filter(m => m.visible) ?? [];
  }

  get sortedByMeanErr(): GpsModeAnalytics[] {
    return [...(this.analytics ?? [])].sort((a, b) => a.meanErr - b.meanErr);
  }

  get sortedByDistAccuracy(): GpsModeAnalytics[] {
    return [...(this.analytics ?? [])].sort((a, b) => Math.abs(a.deltaDist) - Math.abs(b.deltaDist));
  }

  get maxAbsDeltaDist(): number {
    return Math.max(...(this.analytics ?? []).map(m => Math.abs(m.deltaDist)), 0.01);
  }

  get histMax(): number {
    if (!this.analytics) return 1;
    return Math.max(...this.analytics.flatMap(m => m.hist), 1);
  }

  get timelineMaxDist(): number {
    if (!this.analytics) return this.referenceDistance;
    return Math.max(...this.analytics.flatMap(m => m.allPoints.map(p => p.cumD)), 400);
  }

  get timelineMaxErr(): number {
    if (!this.analytics) return 6;
    const visible = this.visibleAnalytics;
    if (!visible.length) return 6;
    const mx = Math.max(...visible.flatMap(m => m.allPoints.map(p => p.err)));
    return Math.ceil(Math.max(mx, 2) / 2) * 2;
  }

  get timelineYTicks(): number[] {
    const yMax = this.timelineMaxErr;
    return [0, yMax / 2, yMax];
  }

  get timelineLapMarkers(): number[] {
    const lap = lapLength(1);
    const nLaps = Math.round(this.referenceDistance / lap);
    return Array.from({ length: nLaps - 1 }, (_, i) => (i + 1) * lap);
  }

  get timelinePaths(): { color: string; d: string; dim: boolean }[] {
    if (!this.analytics) return [];
    const maxD = this.timelineMaxDist;
    const maxE = this.timelineMaxErr || 6;
    const sx = (d: number) => TL_PL + (d / maxD) * (TL_W - TL_PL - TL_PR);
    const sy = (e: number) => TL_PT + (1 - Math.min(e, maxE) / maxE) * (TL_H - TL_PT - TL_PB);

    return this.analytics
      .filter(m => m.visible)
      .map(m => ({
        color: m.color,
        dim: !!this.hoveredModeId && this.hoveredModeId !== m.modeId,
        d: m.allPoints.map((p, i) =>
          `${i === 0 ? 'M' : 'L'}${sx(p.cumD).toFixed(1)},${sy(p.err).toFixed(1)}`
        ).join(' '),
      }));
  }

  get timelineViewBox(): string { return `0 0 ${TL_W} ${TL_H}`; }

  get lapCount(): number {
    return Math.round(this.referenceDistance / lapLength(1));
  }

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

  tlSx(d: number): string {
    return (TL_PL + (d / this.timelineMaxDist) * (TL_W - TL_PL - TL_PR)).toFixed(1);
  }
  tlSy(e: number): string {
    const maxE = this.timelineMaxErr || 6;
    return (TL_PT + (1 - Math.min(e, maxE) / maxE) * (TL_H - TL_PT - TL_PB)).toFixed(1);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  constructor(
    private route: ActivatedRoute,
    private gpxParser: GpxParserService,
    private api: ApiService,
  ) {}

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get('deviceId') || '';
    this.addMode();
    this.addMode();
    this.loadSavedTests();
  }

  private loadSavedTests(): void {
    if (!this.deviceId) return;
    this.loadingTests = true;
    this.api.listGpsTests(this.deviceId).subscribe({
      next: tests => {
        this.savedTests = tests;
        this.loadingTests = false;
        if (tests.length > 0) this.loadTest(tests[0].id);
      },
      error: () => { this.loadingTests = false; },
    });
  }

  loadTest(testId: string): void {
    this.api.getGpsTest(testId).subscribe({
      next: (test: GpsTestDetail) => {
        this.referenceDistance = test.reference_distance;
        const gpsModes: GpsMode[] = test.modes.map(m => ({
          id: m.id, name: m.name, color: m.color,
          files: m.runs.map(r => ({
            filename: r.filename,
            distance_m: r.distance_m,
            points: r.points.map(p => ({
              lat: p.lat, lon: p.lon, ele: p.ele,
              time: p.time ? new Date(p.time) : undefined,
            })),
          })),
        }));
        this.analytics = this.buildAnalytics(gpsModes);
        this.currentTestId = testId;
        this.trackZoom = 1; this.trackPanX = 0; this.trackPanY = 0;
      },
    });
  }

  deleteTest(testId: string, event: Event): void {
    event.stopPropagation();
    this.api.deleteGpsTest(testId).subscribe({
      next: () => {
        this.savedTests = this.savedTests.filter(t => t.id !== testId);
        if (this.currentTestId === testId) {
          this.analytics = null;
          this.currentTestId = null;
        }
      },
    });
  }

  private saveCurrentTest(gpsModes: GpsMode[]): void {
    if (!this.deviceId) return;
    this.savingTest = true;
    const payload = {
      reference_distance: this.referenceDistance,
      modes: gpsModes.map(m => ({
        id: m.id, name: m.name, color: m.color,
        runs: m.files.map(f => ({
          filename: f.filename,
          distance_m: f.distance_m,
          points: f.points.map(p => ({
            lat: p.lat, lon: p.lon, ele: p.ele,
            time: p.time?.toISOString(),
          })),
        })),
      })),
    };
    this.api.saveGpsTest(this.deviceId, payload).subscribe({
      next: saved => {
        this.currentTestId = saved.id;
        this.savedTests = [saved, ...this.savedTests];
        this.savingTest = false;
      },
      error: () => { this.savingTest = false; },
    });
  }

  // ── Mode setup ───────────────────────────────────────────────────────────

  addMode(): void {
    const idx = this.modes.length;
    this.modes.push({
      id: crypto.randomUUID(),
      name:  this.presetModeNames[idx] ?? `Modo ${idx + 1}`,
      color: GPS_MODE_COLORS[idx % GPS_MODE_COLORS.length],
      fileInputFiles: [], loading: false, error: '',
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
    this.analyzing = true; this.analyzeError = ''; this.analytics = null;
    try {
      const gpsModes: GpsMode[] = [];
      for (const setup of this.modes) {
        if (!setup.fileInputFiles.length) continue;
        setup.loading = true; setup.error = '';
        const runs = await Promise.all(setup.fileInputFiles.map(f => this.gpxParser.parseFile(f)));
        setup.loading = false;
        gpsModes.push({ id: setup.id, name: setup.name, color: setup.color, files: runs });
      }
      this.analytics = this.buildAnalytics(gpsModes);
      this.trackZoom = 1; this.trackPanX = 0; this.trackPanY = 0;
      this.saveCurrentTest(gpsModes);
    } catch (err: any) {
      this.analyzeError = err?.message ?? 'Error al procesar los ficheros GPX';
    } finally {
      this.analyzing = false;
    }
  }

  newTest(): void {
    this.analytics = null;
    this.currentTestId = null;
    this.hoveredModeId = null;
    this.hoveredTrackPoint = null;
    this.trackZoom = 1; this.trackPanX = 0; this.trackPanY = 0;
    this.modes.forEach(m => { m.fileInputFiles = []; m.error = ''; });
  }

  // ── Analytics computation ────────────────────────────────────────────────

  private buildAnalytics(gpsModes: GpsMode[]): GpsModeAnalytics[] {
    if (!gpsModes.length) return [];

    // Collect all GPS points for PCA
    const allPts: { lat: number; lon: number }[] = [];
    for (const mode of gpsModes)
      for (const run of mode.files) allPts.push(...run.points);
    if (!allPts.length) return [];

    // Centroid + equirectangular projection
    const centLat = allPts.reduce((s, p) => s + p.lat, 0) / allPts.length;
    const centLon = allPts.reduce((s, p) => s + p.lon, 0) / allPts.length;
    const cosLat  = Math.cos(centLat * Math.PI / 180);
    const EARTH_R = 6371000;
    const toLocal = (p: { lat: number; lon: number }) => ({
      x: (p.lon - centLon) * cosLat * EARTH_R * Math.PI / 180,
      y: (p.lat - centLat) * EARTH_R * Math.PI / 180,
    });

    // PCA to align track orientation with X axis
    const local = allPts.map(toLocal);
    const mx = local.reduce((s, p) => s + p.x, 0) / local.length;
    const my = local.reduce((s, p) => s + p.y, 0) / local.length;
    const cxx = local.reduce((s, p) => s + (p.x - mx) ** 2, 0) / local.length;
    const cxy = local.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / local.length;
    const cyy = local.reduce((s, p) => s + (p.y - my) ** 2, 0) / local.length;
    const tr  = cxx + cyy;
    const lam = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - (cxx * cyy - cxy * cxy)));
    let angle = cxy !== 0 ? Math.atan2(lam - cxx, cxy) : (cxx >= cyy ? 0 : Math.PI / 2);

    const rot = (p: { x: number; y: number }, a: number) => ({
      x: (p.x - mx) * Math.cos(-a) - (p.y - my) * Math.sin(-a),
      y: (p.x - mx) * Math.sin(-a) + (p.y - my) * Math.cos(-a),
    });
    const rotated = local.map(p => rot(p, angle));
    const rW = Math.max(...rotated.map(p => p.x)) - Math.min(...rotated.map(p => p.x));
    const rH = Math.max(...rotated.map(p => p.y)) - Math.min(...rotated.map(p => p.y));
    if (rH > rW) angle += Math.PI / 2;

    const transform = (p: { lat: number; lon: number }) => rot(toLocal(p), angle);

    const lap = lapLength(1);

    return gpsModes.map((mode, mi) => {
      const runs: AnalyticsRun[] = [];
      const allModePoints: AnalyticsPoint[] = [];

      mode.files.forEach(run => {
        const pts: AnalyticsPoint[] = [];
        let cumD = 0;
        let prev: { x: number; y: number } | null = null;

        for (const gpt of run.points) {
          const { x, y } = transform(gpt);
          if (prev) cumD += Math.hypot(x - prev.x, y - prev.y);
          const { dist: err, arcLen: d } = nearestOnLane1(x, y);
          pts.push({ x, y, err: Math.min(err, 30), d: d % lap, cumD });
          prev = { x, y };
        }

        const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ');
        runs.push({ pathD, points: pts });
        allModePoints.push(...pts);
      });

      // Aggregate stats
      const errs = allModePoints.map(p => p.err);
      const meanErr = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0;
      const maxErr  = errs.length ? Math.max(...errs) : 0;
      const recDist = mode.files.reduce((s, r) => s + r.distance_m, 0) / Math.max(mode.files.length, 1);

      // Sample Hz
      let sampleHz = 0;
      const fp = mode.files[0]?.points.filter(p => p.time) ?? [];
      if (fp.length >= 2) {
        const dt = (fp[fp.length - 1].time!.getTime() - fp[0].time!.getTime()) / 1000;
        if (dt > 0) sampleHz = fp.length / dt;
      }

      // Histogram (12 bins × 0.5m = 0..6m)
      const hist = new Array(12).fill(0);
      for (const e of errs) hist[Math.min(11, Math.floor(e / 0.5))]++;

      // Heatmap (50 bins by lap phase)
      const binSums   = new Array(TL_BINS).fill(0);
      const binCounts = new Array(TL_BINS).fill(0);
      for (const p of allModePoints) {
        const b = Math.min(TL_BINS - 1, Math.floor((p.d / lap) * TL_BINS));
        binSums[b] += p.err; binCounts[b]++;
      }
      const heatAvg = binSums.map((s, i) => binCounts[i] ? s / binCounts[i] : 0);
      const hmMax   = Math.max(...heatAvg, 0.01);
      const heatmapBins = heatAvg.map(v => v / hmMax);

      return {
        modeId: mode.id, modeName: mode.name, color: mode.color,
        visible: true, selected: mi === 0,
        runs, allPoints: allModePoints,
        meanErr:   Math.round(meanErr  * 100) / 100,
        maxErr:    Math.round(maxErr   * 100) / 100,
        recDist:   Math.round(recDist  * 10)  / 10,
        trueDist:  this.referenceDistance,
        deltaDist: Math.round((recDist - this.referenceDistance) * 10) / 10,
        sampleHz:  Math.round(sampleHz * 100) / 100,
        nSamples:  allModePoints.length,
        hist, heatmapBins,
      };
    });
  }

  // ── Sidebar interactions ─────────────────────────────────────────────────

  toggleVisibility(modeId: string): void {
    const m = this.analytics?.find(a => a.modeId === modeId);
    if (m) m.visible = !m.visible;
  }

  selectMode(modeId: string): void {
    this.analytics?.forEach(m => m.selected = m.modeId === modeId);
  }

  hoverMode(modeId: string | null): void { this.hoveredModeId = modeId; }

  // ── SVG track events ─────────────────────────────────────────────────────

  onTrackMouseMove(e: MouseEvent): void {
    if (this.svgDrag) {
      const bb = trackBbox(); const PAD = 12;
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
    if (!this.analytics || !this.trackSvgEl) return;
    const svg = this.trackSvgEl.nativeElement;
    const pt  = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const sp = pt.matrixTransform(ctm.inverse());
    const wx = sp.x, wy = -sp.y;

    let best: { d2: number; color: string; name: string; err: number; pt: AnalyticsPoint } | null = null;
    for (const m of this.analytics) {
      if (!m.visible) continue;
      for (const run of m.runs) {
        for (const p of run.points) {
          const d2 = (p.x - wx) ** 2 + (p.y - wy) ** 2;
          if (!best || d2 < best.d2) best = { d2, color: m.color, name: m.modeName, err: p.err, pt: p };
        }
      }
    }
    if (best && best.d2 < 25) {
      const rect = this.trackStageEl.nativeElement.getBoundingClientRect();
      this.hoveredTrackPoint = {
        worldX: best.pt.x, worldY: best.pt.y,
        screenX: e.clientX - rect.left, screenY: e.clientY - rect.top,
        modeColor: best.color, modeName: best.name, err: best.err,
      };
    } else { this.hoveredTrackPoint = null; }
  }

  onTrackMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    this.svgDrag = { startX: e.clientX, startY: e.clientY, panX: this.trackPanX, panY: this.trackPanY };
  }
  onTrackMouseUp():    void { this.svgDrag = null; }
  onTrackMouseLeave(): void { this.svgDrag = null; this.hoveredTrackPoint = null; }
  onTrackWheel(e: WheelEvent): void {
    e.preventDefault();
    this.trackZoom = Math.max(0.6, Math.min(8, this.trackZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
  }
  resetTrack(): void { this.trackZoom = 1; this.trackPanX = 0; this.trackPanY = 0; }
  zoomIn():  void { this.trackZoom = Math.min(8, this.trackZoom * 1.25); }
  zoomOut(): void { this.trackZoom = Math.max(0.6, this.trackZoom / 1.25); }

  // ── Helpers ───────────────────────────────────────────────────────────────

  fmt(v: number, dec = 1): string { return isNaN(v) ? '—' : v.toFixed(dec); }
  fmtSign(v: number, dec = 1): string { return (v >= 0 ? '+' : '') + v.toFixed(dec); }
  fmtHz(v: number): string { return v > 0 ? `${v.toFixed(2)} Hz` : '—'; }

  histBarHeight(count: number): string {
    return `${Math.round((count / Math.max(this.histMax, 1)) * 100)}%`;
  }

  rankBarPct(value: number, worst?: number): string {
    const w = worst ?? Math.max(...(this.analytics ?? []).map(m => m.meanErr), 0.01);
    return `${Math.round((value / w) * 100)}%`;
  }
}

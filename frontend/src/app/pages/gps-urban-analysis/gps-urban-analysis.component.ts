import {
  Component,
  OnInit,
  OnDestroy,
  NgZone,
  ViewChild,
  ElementRef,
} from "@angular/core";
import { CommonModule, DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterModule } from "@angular/router";
import { HttpClient } from "@angular/common/http";
import * as L from "leaflet";

import { GpxParserService } from "../../services/gpx-parser.service";
import { ApiService } from "../../services/api.service";
import {
  GpsRunFile,
  GPS_MODE_COLORS,
  UrbanTestSummary,
  GpsUrbanModeScore,
  GpsStoredScores,
} from "../../models/gps-analysis.model";

// ── Types ─────────────────────────────────────────────────────────────────────
type GeoPoint = { lat: number; lon: number };

// ── Geo helpers ───────────────────────────────────────────────────────────────

function haversine(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const sa = Math.sin(dLat / 2),
    sb = Math.sin(dLon / 2);
  const h =
    sa * sa +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      sb *
      sb;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function gpsToLocal(
  lat: number,
  lon: number,
  oLat: number,
  oLon: number,
): [number, number] {
  const R = 6371000,
    cos = Math.cos((oLat * Math.PI) / 180);
  return [
    (((lon - oLon) * Math.PI) / 180) * R * cos,
    (((lat - oLat) * Math.PI) / 180) * R,
  ];
}

interface RefIndex {
  xs: number[];
  ys: number[];
  cumArc: number[];
  totalArc: number;
  origin: GeoPoint;
  cornerIndices: number[];
  cornerSAlongs: number[];
}

function buildRefIndex(pts: GeoPoint[]): RefIndex {
  const origin = pts[0];
  const xs: number[] = [],
    ys: number[] = [],
    cumArc = [0];
  for (const p of pts) {
    const [x, y] = gpsToLocal(p.lat, p.lon, origin.lat, origin.lon);
    xs.push(x);
    ys.push(y);
  }
  for (let i = 1; i < xs.length; i++) {
    const dx = xs[i] - xs[i - 1],
      dy = ys[i] - ys[i - 1];
    cumArc.push(cumArc[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const totalArc = cumArc[cumArc.length - 1];
  const cornerIndices: number[] = [],
    cornerSAlongs: number[] = [];
  for (let i = 1; i < xs.length - 1; i++) {
    const dx1 = xs[i] - xs[i - 1],
      dy1 = ys[i] - ys[i - 1],
      dx2 = xs[i + 1] - xs[i],
      dy2 = ys[i + 1] - ys[i];
    const l1 = Math.sqrt(dx1 * dx1 + dy1 * dy1),
      l2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    if (l1 < 1 || l2 < 1) continue;
    const angle =
      (Math.acos(
        Math.max(-1, Math.min(1, (dx1 * dx2 + dy1 * dy2) / (l1 * l2))),
      ) *
        180) /
      Math.PI;
    if (angle >= 40) {
      cornerIndices.push(i);
      cornerSAlongs.push(cumArc[i]);
    }
  }
  return { xs, ys, cumArc, totalArc, origin, cornerIndices, cornerSAlongs };
}

function crossTrackToRef(
  p: GeoPoint,
  idx: RefIndex,
): { error: number; sAlong: number } {
  const [px, py] = gpsToLocal(p.lat, p.lon, idx.origin.lat, idx.origin.lon);
  let minErr = Infinity,
    bestS = 0;
  for (let i = 0; i < idx.xs.length - 1; i++) {
    const ax = idx.xs[i],
      ay = idx.ys[i],
      bx = idx.xs[i + 1],
      by = idx.ys[i + 1];
    const dx = bx - ax,
      dy = by - ay,
      len2 = dx * dx + dy * dy;
    const t =
      len2 > 0
        ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
        : 0;
    const err = Math.sqrt((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2);
    if (err < minErr) {
      minErr = err;
      bestS = idx.cumArc[i] + t * (idx.cumArc[i + 1] - idx.cumArc[i]);
    }
  }
  return { error: minErr, sAlong: bestS };
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
}

function computeSpeedJitter(
  pts: { lat: number; lon: number; time?: Date }[],
): number {
  const spds: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (!pts[i - 1].time || !pts[i].time) continue;
    const dt = (pts[i].time!.getTime() - pts[i - 1].time!.getTime()) / 1000;
    if (dt < 0.3 || dt > 5) continue;
    const spd = haversine(pts[i - 1], pts[i]) / dt;
    if (spd > 12) continue;
    spds.push(spd);
  }
  if (spds.length < 5) return NaN;
  const mean = spds.reduce((a, b) => a + b, 0) / spds.length;
  return Math.sqrt(spds.reduce((s, v) => s + (v - mean) ** 2, 0) / spds.length);
}

function pointInPolygon(p: GeoPoint, poly: GeoPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lon,
      yi = poly[i].lat,
      xj = poly[j].lon,
      yj = poly[j].lat;
    if (
      yi > p.lat !== yj > p.lat &&
      p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

async function parseRefFile(file: File): Promise<GeoPoint[]> {
  const text = await file.text();
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Fichero XML inválido");

  // GPX: trkpt / rtept
  const gpxPts = Array.from(xml.querySelectorAll("trkpt, rtept"));
  if (gpxPts.length > 1) {
    return gpxPts
      .map((el) => ({
        lat: parseFloat(el.getAttribute("lat") ?? ""),
        lon: parseFloat(el.getAttribute("lon") ?? ""),
      }))
      .filter((p) => isFinite(p.lat) && isFinite(p.lon));
  }

  // KML: LineString coordinates (lon,lat,alt format)
  const coordEl = xml.querySelector("LineString coordinates");
  if (coordEl?.textContent) {
    return coordEl.textContent
      .trim()
      .split(/\s+/)
      .flatMap((chunk) => {
        const [lonS, latS] = chunk.split(",");
        const lon = parseFloat(lonS),
          lat = parseFloat(latS);
        return isFinite(lat) && isFinite(lon) ? [{ lat, lon }] : [];
      });
  }
  throw new Error(
    "No se encontraron puntos. Usa .gpx con <trkpt> o .kml con <LineString>.",
  );
}

// ── Component interfaces ──────────────────────────────────────────────────────

interface ModeSetup {
  id: string;
  name: string;
  color: string;
  fileInputFiles: File[];
  loading: boolean;
  error: string;
}

interface UrbanRunMetrics {
  filename: string;
  nPoints: number;
  rmse: number;
  p95: number;
  maxErr: number;
  mape: number;       // |GPS_dist - ref_dist| / ref_dist * 100
  distDelta: number;  // GPS_dist - ref_dist  (signed, meters)
  buildingPct: number;   // NaN until Overpass data loaded
  cornerErr: number;     // NaN if no corners
  speedJitter: number;   // NaN if no timestamps
  errProfile: { s: number; err: number }[];
}

interface UrbanModeAnalytics {
  modeId: string;
  modeName: string;
  color: string;
  visible: boolean;
  selected: boolean;
  runs: GpsRunFile[];
  runMetrics: UrbanRunMetrics[];
  rmse: number;
  p95: number;
  maxErr: number;
  mape: number;
  distDelta: number;
  buildingPct: number;
  cornerErr: number;
  speedJitter: number;
  sampleHz: number;
  nSamples: number;
}

type AptLevel =
  | "elite"
  | "high"
  | "standard"
  | "marginal"
  | "no-apto"
  | "sin-ref";
interface UrbanAptitude {
  level: AptLevel;
  label: string;
  sublabel: string;
  failing: string[];
}

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector: "app-gps-urban-analysis",
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, DatePipe],
  templateUrl: "./gps-urban-analysis.component.html",
  styleUrls: ["./gps-urban-analysis.component.scss"],
})
export class GpsUrbanAnalysisComponent implements OnInit, OnDestroy {
  @ViewChild("mapContainer")
  set mapContainerRef(el: ElementRef<HTMLDivElement> | undefined) {
    if (el && !this.leafletMap)
      this.ngZone.runOutsideAngular(() =>
        this.initLeafletMap(el.nativeElement),
      );
  }

  // ── Reference line ────────────────────────────────────────────────────────
  refFile: File | null = null;
  refFilename = "";
  refPoints: GeoPoint[] = [];
  refParsing = false;
  refError = "";
  private refIdx?: RefIndex;
  private refLayer?: L.Polyline;

  // ── Setup ─────────────────────────────────────────────────────────────────
  deviceId = "";
  modes: ModeSetup[] = [];
  readonly GPS_MODE_COLORS = GPS_MODE_COLORS;
  readonly presetModeNames = [
    "GPS Solo",
    "Todos los Sistemas",
    "Todos + Multibanda",
    "SatIQ",
    "UltraTrac",
  ];

  // ── Analysis ──────────────────────────────────────────────────────────────
  analyzing = false;
  analyzeError = "";
  analytics: UrbanModeAnalytics[] | null = null;
  hoveredModeId: string | null = null;

  // ── Buildings (async, Overpass API) ───────────────────────────────────────
  loadingBuildings = false;
  buildingsLoaded = false;
  private buildings: GeoPoint[][] = [];

  // ── Persistence ───────────────────────────────────────────────────────────
  savedTests: UrbanTestSummary[] = [];
  loadingTests = false;
  savingTest = false;
  currentTestId: string | null = null;

  // ── AI Analysis ───────────────────────────────────────────────────────────
  aiError = "";

  // ── Map ───────────────────────────────────────────────────────────────────
  private leafletMap?: L.Map;
  private runLayers = new Map<string, L.Polyline[]>();
  private cornerMarkers: L.CircleMarker[] = [];
  private endpointMarkers: L.Marker[] = [];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private gpxParser: GpxParserService,
    private ngZone: NgZone,
    private api: ApiService,
    private http: HttpClient,
  ) {}

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get("deviceId") || "";
    this.addMode();
    this.addMode();
    this.loadSavedTests();
  }

  ngOnDestroy(): void {
    this.cursorMarker?.remove();
    this.leafletMap?.remove();
  }

  // ── Reference file ────────────────────────────────────────────────────────

  async onRefFileSelected(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.refFile = file;
    this.refFilename = file.name;
    this.refError = "";
    this.refParsing = true;
    try {
      this.refPoints = await parseRefFile(file);
      if (this.refPoints.length < 2)
        throw new Error("La referencia necesita al menos 2 puntos");
      this.refIdx = buildRefIndex(this.refPoints);
      console.log(
        `[Ref] "${file.name}": ${this.refPoints.length} pts, ${this.refIdx.totalArc.toFixed(0)} m, ${this.refIdx.cornerIndices.length} corners`,
      );
    } catch (e: any) {
      this.refError = e.message ?? "Error al parsear el fichero de referencia";
      this.refPoints = [];
      this.refIdx = undefined;
    } finally {
      this.refParsing = false;
    }
  }

  onRefDrop(event: DragEvent): void {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      (event.target as HTMLElement).dispatchEvent(new Event("change"));
      this.refFile = file;
      this.onRefFileSelected({ target: { files: [file] } } as any);
    }
  }

  onRefDragOver(e: DragEvent): void {
    e.preventDefault();
  }

  // ── Mode setup ────────────────────────────────────────────────────────────

  addMode(): void {
    const idx = this.modes.length;
    this.modes.push({
      id: crypto.randomUUID(),
      name: this.presetModeNames[idx] ?? `Modo ${idx + 1}`,
      color: GPS_MODE_COLORS[idx % GPS_MODE_COLORS.length],
      fileInputFiles: [],
      loading: false,
      error: "",
    });
  }

  removeMode(i: number): void {
    this.modes.splice(i, 1);
  }

  onFilesSelected(event: Event, mode: ModeSetup): void {
    mode.fileInputFiles = Array.from(
      (event.target as HTMLInputElement).files ?? [],
    ).slice(0, 10);
    mode.error = "";
  }

  onDrop(event: DragEvent, mode: ModeSetup): void {
    event.preventDefault();
    mode.fileInputFiles = Array.from(event.dataTransfer?.files ?? [])
      .filter((f) => f.name.toLowerCase().endsWith(".gpx"))
      .slice(0, 10);
    mode.error = "";
  }

  onDragOver(e: DragEvent): void {
    e.preventDefault();
  }

  canAnalyze(): boolean {
    return (
      !this.analyzing &&
      !!this.refIdx &&
      this.modes.some((m) => m.fileInputFiles.length > 0)
    );
  }

  // ── Analysis ──────────────────────────────────────────────────────────────

  async analyze(): Promise<void> {
    if (!this.refIdx) {
      this.analyzeError =
        "Primero sube la Línea de Verdad Absoluta (.gpx o .kml)";
      return;
    }
    this.analyzing = true;
    this.analyzeError = "";
    this.analytics = null;
    this.leafletMap?.remove();
    this.leafletMap = undefined;
    this.runLayers.clear();
    this.buildings = [];
    this.buildingsLoaded = false;
    try {
      const result: UrbanModeAnalytics[] = [];
      for (const setup of this.modes) {
        if (!setup.fileInputFiles.length) continue;
        setup.loading = true;
        setup.error = "";
        const runs = await Promise.all(
          setup.fileInputFiles.map((f) => this.gpxParser.parseFile(f)),
        );
        setup.loading = false;
        result.push(
          this.buildModeAnalytics(setup.id, setup.name, setup.color, runs),
        );
      }
      if (result.length) {
        this.analytics = result;
        result[0].selected = true;
        this.saveCurrentTest(result);
        this.persistUrbanScores();
        this.loadBuildings();
      }
    } catch (err: any) {
      this.analyzeError = err?.message ?? "Error al procesar los ficheros GPX";
    } finally {
      this.analyzing = false;
    }
  }

  private buildModeAnalytics(
    id: string,
    name: string,
    color: string,
    runs: GpsRunFile[],
  ): UrbanModeAnalytics {
    const idx = this.refIdx!;
    const runMetrics: UrbanRunMetrics[] = [];

    for (const run of runs) {
      const errors: number[] = [];
      const profile: { s: number; err: number }[] = [];
      const step = Math.max(1, Math.floor(run.points.length / 300));

      // Compute cross-track error for every GPS point
      for (let i = 0; i < run.points.length; i++) {
        const { error, sAlong } = crossTrackToRef(run.points[i], idx);
        errors.push(error);
        if (i % step === 0) profile.push({ s: sAlong, err: error });
      }

      // Corner cutting: nearest GPS point to each corner vertex
      let cornerErr = NaN;
      if (idx.cornerIndices.length > 0) {
        const cornerPtsLocal = idx.cornerIndices.map(
          (ci) => [idx.xs[ci], idx.ys[ci]] as [number, number],
        );
        const gpsLocal = run.points.map((p) =>
          gpsToLocal(p.lat, p.lon, idx.origin.lat, idx.origin.lon),
        );
        let sumCornerErr = 0;
        for (const [cx, cy] of cornerPtsLocal) {
          let minD = Infinity;
          for (const [gx, gy] of gpsLocal) {
            const d = Math.sqrt((gx - cx) ** 2 + (gy - cy) ** 2);
            if (d < minD) minD = d;
          }
          sumCornerErr += minD;
        }
        cornerErr = sumCornerErr / cornerPtsLocal.length;
      }

      const sampleHz = (() => {
        const fp = run.points.filter((p) => p.time);
        if (fp.length < 2) return 0;
        const dt =
          (fp[fp.length - 1].time!.getTime() - fp[0].time!.getTime()) / 1000;
        return dt > 0 ? Math.round((fp.length / dt) * 100) / 100 : 0;
      })();

      const refDist = idx.totalArc;
      const distDelta = run.distance_m - refDist;
      const mape = refDist > 0 ? (Math.abs(distDelta) / refDist) * 100 : NaN;

      runMetrics.push({
        filename: run.filename,
        nPoints: run.points.length,
        rmse: Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length),
        p95: percentile(errors, 95),
        maxErr: Math.max(...errors),
        mape,
        distDelta,
        buildingPct: NaN,
        cornerErr: Math.round((cornerErr || 0) * 100) / 100,
        speedJitter: computeSpeedJitter(run.points),
        errProfile: profile,
      });

      console.log(
        `[Urban GPS] "${name}" run "${run.filename}":`,
        `RMSE=${runMetrics[runMetrics.length - 1].rmse.toFixed(2)}m`,
        `P95=${runMetrics[runMetrics.length - 1].p95.toFixed(2)}m`,
        `max=${runMetrics[runMetrics.length - 1].maxErr.toFixed(1)}m`,
        idx.cornerIndices.length
          ? `corner=${runMetrics[runMetrics.length - 1].cornerErr.toFixed(2)}m`
          : "no corners",
      );
    }

    const mean = (arr: number[]) => {
      const v = arr.filter((x) => !isNaN(x));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
    };
    const sampleHz = (() => {
      const fp = runs[0]?.points.filter((p) => p.time) ?? [];
      if (fp.length < 2) return 0;
      const dt =
        (fp[fp.length - 1].time!.getTime() - fp[0].time!.getTime()) / 1000;
      return dt > 0 ? Math.round((fp.length / dt) * 100) / 100 : 0;
    })();

    return {
      modeId: id,
      modeName: name,
      color,
      visible: true,
      selected: false,
      runs,
      runMetrics,
      rmse:       mean(runMetrics.map((r) => r.rmse)),
      p95:        mean(runMetrics.map((r) => r.p95)),
      maxErr:     Math.max(...runMetrics.map((r) => r.maxErr)),
      mape:       mean(runMetrics.map((r) => r.mape)),
      distDelta:  mean(runMetrics.map((r) => r.distDelta)),
      buildingPct: NaN,
      cornerErr:  mean(runMetrics.map((r) => r.cornerErr)),
      speedJitter: mean(runMetrics.map((r) => r.speedJitter)),
      sampleHz,
      nSamples: runs.reduce((s, r) => s + r.points.length, 0),
    };
  }

  // ── Building penetration via Overpass API ─────────────────────────────────

  private loadBuildings(): void {
    if (!this.analytics) return;
    const lats: number[] = [],
      lons: number[] = [];
    for (const m of this.analytics) {
      for (const run of m.runs) {
        for (const p of run.points) {
          lats.push(p.lat);
          lons.push(p.lon);
        }
      }
    }
    const pad = 0.0005;
    const s = Math.min(...lats) - pad,
      n = Math.max(...lats) + pad;
    const w = Math.min(...lons) - pad,
      e = Math.max(...lons) + pad;
    const query = `[out:json][bbox:${s},${w},${n},${e}];way[building];out geom;`;
    this.loadingBuildings = true;

    this.http
      .post<any>(
        "https://overpass-api.de/api/interpreter",
        `data=${encodeURIComponent(query)}`,
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      )
      .subscribe({
        next: (data) => {
          this.buildings = (data.elements ?? [])
            .filter((el: any) => el.geometry?.length >= 3)
            .map((el: any) =>
              (el.geometry as any[]).map((p) => ({ lat: p.lat, lon: p.lon })),
            );
          this.ngZone.run(() => {
            this.applyBuildingPenetration();
            this.loadingBuildings = false;
            this.buildingsLoaded = true;
          });
        },
        error: () => {
          this.ngZone.run(() => {
            this.loadingBuildings = false;
          });
        },
      });
  }

  private applyBuildingPenetration(): void {
    if (!this.analytics || !this.buildings.length) return;
    for (const m of this.analytics) {
      for (let ri = 0; ri < m.runs.length; ri++) {
        const pts = m.runs[ri].points;
        let inside = 0;
        for (const p of pts) {
          for (const poly of this.buildings) {
            if (pointInPolygon(p, poly)) {
              inside++;
              break;
            }
          }
        }
        m.runMetrics[ri].buildingPct =
          pts.length > 0 ? (inside / pts.length) * 100 : 0;
      }
      const valid = m.runMetrics.filter((r) => !isNaN(r.buildingPct));
      m.buildingPct = valid.length
        ? valid.reduce((s, r) => s + r.buildingPct, 0) / valid.length
        : NaN;
    }
  }

  // ── Leaflet map ───────────────────────────────────────────────────────────

  private initLeafletMap(container: HTMLDivElement): void {
    this.leafletMap = L.map(container, {
      zoomControl: true,
      scrollWheelZoom: true,
      preferCanvas: true,
    });
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
        maxZoom: 20,
        subdomains: "abcd",
      },
    ).addTo(this.leafletMap);
    this.drawAllLayers();
    this.fitMapToAll();
  }

  private drawAllLayers(): void {
    if (!this.leafletMap || !this.analytics) return;
    this.runLayers.forEach((ls) => ls.forEach((l) => l.remove()));
    this.runLayers.clear();
    this.refLayer?.remove();
    this.cornerMarkers.forEach((m) => m.remove());
    this.cornerMarkers = [];
    this.endpointMarkers.forEach((m) => m.remove());
    this.endpointMarkers = [];
    this.cursorMarker?.remove();
    this.cursorMarker = undefined;

    // Reference line — bold white with dark outline
    if (this.refPoints.length > 1) {
      this.refLayer = L.polyline(
        this.refPoints.map((p) => [p.lat, p.lon] as [number, number]),
        { color: "#1a1a1a", weight: 5, opacity: 0.85 },
      ).addTo(this.leafletMap);
      L.polyline(
        this.refPoints.map((p) => [p.lat, p.lon] as [number, number]),
        { color: "#ffffff", weight: 2.5, opacity: 0.95, dashArray: "8 4" },
      ).addTo(this.leafletMap);

      // Corner markers
      if (this.refIdx) {
        for (const ci of this.refIdx.cornerIndices) {
          const marker = L.circleMarker(
            [this.refPoints[ci].lat, this.refPoints[ci].lon],
            {
              radius: 5,
              color: "#FF6B35",
              fillColor: "#FF6B35",
              fillOpacity: 0.9,
              weight: 2,
            },
          ).addTo(this.leafletMap);
          this.cornerMarkers.push(marker);
        }
      }

      // Reference start / end markers
      const rStart = this.refPoints[0];
      const rEnd = this.refPoints[this.refPoints.length - 1];
      this.endpointMarkers.push(
        L.marker([rStart.lat, rStart.lon], {
          icon: this._endpointIcon("S", "#16a34a"),
          zIndexOffset: 1000,
        }).addTo(this.leafletMap),
        L.marker([rEnd.lat, rEnd.lon], {
          icon: this._endpointIcon("F", "#dc2626"),
          zIndexOffset: 1000,
        }).addTo(this.leafletMap),
      );
    }

    // GPS tracks per mode + small start/end dots per mode
    for (const m of this.analytics) {
      const runLines: L.Polyline[] = [];
      for (const run of m.runs) {
        runLines.push(
          L.polyline(
            run.points.map((p) => [p.lat, p.lon] as [number, number]),
            {
              color: m.color,
              weight: 2.5,
              opacity: m.visible
                ? this.hoveredModeId && this.hoveredModeId !== m.modeId
                  ? 0.12
                  : 0.75
                : 0,
              smoothFactor: 1.2,
            },
          ).addTo(this.leafletMap!),
        );

        if (run.points.length > 1 && m.visible) {
          const sp = run.points[0];
          const ep = run.points[run.points.length - 1];
          this.endpointMarkers.push(
            L.marker([sp.lat, sp.lon], {
              icon: this._runDotIcon(m.color, "▶"),
              zIndexOffset: 500,
            }).addTo(this.leafletMap!),
            L.marker([ep.lat, ep.lon], {
              icon: this._runDotIcon(m.color, "■"),
              zIndexOffset: 500,
            }).addTo(this.leafletMap!),
          );
        }
      }
      this.runLayers.set(m.modeId, runLines);
    }
  }

  private _endpointIcon(label: string, bg: string): L.DivIcon {
    return L.divIcon({
      html: `<div style="
        background:${bg};color:#fff;width:24px;height:24px;border-radius:50%;
        display:flex;align-items:center;justify-content:center;
        font-size:11px;font-weight:700;font-family:sans-serif;
        border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.5);">${label}</div>`,
      className: "",
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  private _runDotIcon(color: string, symbol: string): L.DivIcon {
    return L.divIcon({
      html: `<div style="
        background:${color};color:#fff;width:14px;height:14px;border-radius:50%;
        display:flex;align-items:center;justify-content:center;
        font-size:7px;line-height:1;font-family:sans-serif;
        border:1.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.45);">${symbol}</div>`,
      className: "",
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  private fitMapToAll(): void {
    if (!this.leafletMap) return;
    const all: [number, number][] = this.refPoints.map((p) => [p.lat, p.lon]);
    for (const m of this.analytics ?? []) {
      for (const run of m.runs)
        all.push(...run.points.map((p) => [p.lat, p.lon] as [number, number]));
    }
    if (all.length)
      this.leafletMap.fitBounds(L.latLngBounds(all), { padding: [24, 24] });
  }

  private updateMapOpacity(): void {
    if (!this.leafletMap) return;
    for (const m of this.analytics ?? []) {
      const dimmed = !!this.hoveredModeId && this.hoveredModeId !== m.modeId;
      const hovered = this.hoveredModeId === m.modeId;
      const op = m.visible ? (dimmed ? 0.1 : hovered ? 1 : 0.75) : 0;
      this.runLayers
        .get(m.modeId)
        ?.forEach((l) =>
          l.setStyle({ opacity: op, weight: hovered ? 4 : 2.5 }),
        );
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private loadSavedTests(): void {
    if (!this.deviceId) return;
    this.loadingTests = true;
    this.api.listUrbanTests(this.deviceId).subscribe({
      next: (tests) => {
        this.savedTests = tests;
        this.loadingTests = false;
        if (tests.length > 0) this.loadTest(tests[0].id);
      },
      error: () => {
        this.loadingTests = false;
      },
    });
  }

  loadTest(testId: string): void {
    this.api.getUrbanTest(testId).subscribe({
      next: (test: any) => {
        this.refPoints = test.ref_points ?? [];
        this.refFilename = test.ref_filename ?? "";
        this.refIdx =
          this.refPoints.length >= 2
            ? buildRefIndex(this.refPoints)
            : undefined;

        if (!this.refIdx) {
          console.warn(
            "[Urban] Test loaded without ref_points — cannot compute metrics",
          );
          return;
        }

        const result: UrbanModeAnalytics[] = (test.modes ?? []).map(
          (m: any) => {
            const runs: GpsRunFile[] = m.runs.map((r: any) => ({
              filename: r.filename,
              distance_m: r.distance_m,
              points: r.points.map((p: any) => ({
                lat: p.lat,
                lon: p.lon,
                ele: p.ele,
                time: p.time ? new Date(p.time) : undefined,
              })),
            }));
            return this.buildModeAnalytics(m.id, m.name, m.color, runs);
          },
        );

        if (result.length) {
          this.analytics = result;
          result[0].selected = true;
          this.currentTestId = testId;
          this.aiError = "";
          this.leafletMap?.remove();
          this.leafletMap = undefined;
          this.runLayers.clear();
          this.persistUrbanScores();
          this.loadBuildings();
          this.cacheUrbanStats(testId);
        }
      },
      error: (err) => console.error("[Urban] loadTest error", err),
    });
  }

  deleteTest(testId: string, event: Event): void {
    event.stopPropagation();
    this.api.deleteUrbanTest(testId).subscribe({
      next: () => {
        this.savedTests = this.savedTests.filter((t) => t.id !== testId);
        if (this.currentTestId === testId) {
          this.analytics = null;
          this.currentTestId = null;
        }
      },
    });
  }

  private saveCurrentTest(result: UrbanModeAnalytics[]): void {
    if (!this.deviceId) return;
    this.savingTest = true;
    const payload = {
      ref_filename: this.refFilename,
      ref_points: this.refPoints.map((p) => ({ lat: p.lat, lon: p.lon })),
      modes: result.map((m) => ({
        id: m.modeId,
        name: m.modeName,
        color: m.color,
        runs: m.runs.map((r) => ({
          filename: r.filename,
          distance_m: r.distance_m,
          points: r.points.map((p) => ({
            lat: p.lat,
            lon: p.lon,
            ele: p.ele,
            time: p.time?.toISOString(),
          })),
        })),
      })),
    };
    this.api.saveUrbanTest(this.deviceId, payload).subscribe({
      next: (saved) => {
        this.currentTestId = saved.id;
        this.savedTests = [saved, ...this.savedTests];
        this.savingTest = false;
        this.cacheUrbanStats(saved.id);
      },
      error: () => {
        this.savingTest = false;
      },
    });
  }

  // ── AI Analysis ───────────────────────────────────────────────────────────

  private cacheUrbanStats(testId: string): void {
    if (!this.analytics || !this.refIdx) return;
    const cache = {
      modesStats: this.analytics.map((m) => ({
        name: m.modeName, rmse: m.rmse, mape: m.mape, p95: m.p95,
        building_pct: isNaN(m.buildingPct) ? null : m.buildingPct,
        corner_err: isNaN(m.cornerErr) ? null : m.cornerErr,
        speed_jitter: isNaN(m.speedJitter) ? null : m.speedJitter,
      })),
      refMeters: this.refIdx.totalArc,
    };
    sessionStorage.setItem(`gps-urban-aiCache-${testId}`, JSON.stringify(cache));
  }

  private persistUrbanScores(): void {
    if (!this.analytics?.length || !this.deviceId) return;
    const clamp = (v: number) => Math.max(0, Math.min(100, v));
    const r1    = (v: number) => Math.round(v * 10) / 10;
    // Sigmoid: lenient 0.2–0.8 m/s, penalty ramps from 1.0 m/s
    // k=4.6, mid=1.16 → J=0.725 gives ~88 pts
    const consistencySigmoid = (j: number) =>
      Math.min(100, 100 / (1 + Math.exp(4.6 * (j - 1.16))));
    const modes: GpsUrbanModeScore[] = this.analytics.map(m => {
      const jitter = isNaN(m.speedJitter) ? 0 : m.speedJitter;
      return {
        id: m.modeId, name: m.modeName, color: m.color,
        urbanScore:       r1(clamp(100 - (m.rmse - 1.0) / 14.5 * 100)),
        consistencyScore: r1(consistencySigmoid(jitter)),
        rmse: m.rmse, speedJitter: jitter,
      };
    });
    const testName = this.savedTests.find(t => t.id === this.currentTestId)?.name ?? '';
    const payload: GpsStoredScores<GpsUrbanModeScore> = {
      deviceId: this.deviceId, testId: this.currentTestId ?? '',
      testName, computedAt: new Date().toISOString(), modes,
    };
    localStorage.setItem(`gps-scores-urban-${this.deviceId}`, JSON.stringify(payload));
    this.api.saveGpsScores(this.deviceId, 'urban', payload).subscribe();
  }

  goToAiPage(): void {
    if (!this.currentTestId) return;
    this.router.navigate(['/devices', this.deviceId, 'gps-analysis', 'urban-ai', this.currentTestId]);
  }

  newTest(): void {
    this.analytics = null;
    this.currentTestId = null;
    this.aiError = "";
    this.hoveredModeId = null;
    this.chartCursorX = null;
    this.chartCursorS = null;
    this.refFile = null;
    this.refFilename = "";
    this.refPoints = [];
    this.refIdx = undefined;
    this.refError = "";
    this.buildings = [];
    this.buildingsLoaded = false;
    this.cursorMarker?.remove();
    this.cursorMarker = undefined;
    this.leafletMap?.remove();
    this.leafletMap = undefined;
    this.runLayers.clear();
    this.modes.forEach((m) => {
      m.fileInputFiles = [];
      m.error = "";
    });
  }

  // ── Interactions ──────────────────────────────────────────────────────────

  get selectedAnalytics(): UrbanModeAnalytics | null {
    return (
      this.analytics?.find((m) => m.selected) ?? this.analytics?.[0] ?? null
    );
  }

  get sortedByRmse(): UrbanModeAnalytics[] {
    return [...(this.analytics ?? [])].sort((a, b) => {
      if (isNaN(a.rmse) && isNaN(b.rmse)) return 0;
      if (isNaN(a.rmse)) return 1;
      if (isNaN(b.rmse)) return -1;
      return a.rmse - b.rmse;
    });
  }

  selectMode(id: string): void {
    this.analytics?.forEach((m) => (m.selected = m.modeId === id));
  }

  toggleVisibility(id: string): void {
    const m = this.analytics?.find((a) => a.modeId === id);
    if (m) {
      m.visible = !m.visible;
      this.ngZone.runOutsideAngular(() => this.updateMapOpacity());
    }
  }

  hoverMode(id: string | null): void {
    this.hoveredModeId = id;
    this.ngZone.runOutsideAngular(() => this.updateMapOpacity());
  }

  // ── Aptitude ──────────────────────────────────────────────────────────────

  urbanAptitude(m: UrbanModeAnalytics): UrbanAptitude {
    if (!this.refIdx)
      return {
        level: "sin-ref",
        label: "Sin referencia",
        sublabel: "Carga una Línea de Verdad Absoluta para evaluar",
        failing: [],
      };
    const failing: string[] = [];
    if (!isNaN(m.buildingPct) && m.buildingPct > 0)
      failing.push(`${m.buildingPct.toFixed(1)}% puntos en edificios`);
    if (!isNaN(m.cornerErr) && m.cornerErr > 5)
      failing.push(`Error esquinas ${m.cornerErr.toFixed(1)} m`);

    if (m.rmse <= 2.5)
      return {
        level: "elite",
        label: "Urban Elite",
        sublabel: "RMSE ≤ 2.5 m: sigue la acera con fidelidad milimétrica",
        failing,
      };
    if (m.rmse <= 5)
      return {
        level: "high",
        label: "High Tier",
        sublabel: "RMSE ≤ 5 m: distancia correcta, leve redondeo en giros",
        failing: [
          ...failing,
          `RMSE ${m.rmse.toFixed(2)} m (lím. Elite: 2.5 m)`,
        ],
      };
    if (m.rmse <= 10)
      return {
        level: "standard",
        label: "Standard",
        sublabel: "RMSE ≤ 10 m: puede cruzar a la acera opuesta",
        failing: [...failing, `RMSE ${m.rmse.toFixed(2)} m`],
      };
    if (m.rmse <= 15)
      return {
        level: "marginal",
        label: "Marginal",
        sublabel: "RMSE 10–15 m: distorsiones severas en cañones urbanos",
        failing: [...failing, `RMSE ${m.rmse.toFixed(2)} m`],
      };
    return {
      level: "no-apto",
      label: "No Apto",
      sublabel: "RMSE > 15 m: atraviesa manzanas enteras",
      failing: [...failing, `RMSE ${m.rmse.toFixed(2)} m`],
    };
  }

  // ── Error timeline chart ──────────────────────────────────────────────────

  readonly isNaN = isNaN;
  readonly CHART_W = 480;
  readonly CHART_H = 200;
  readonly CHART_PAD_L = 28;
  readonly CHART_PAD_B = 18;
  readonly THRESHOLDS = [
    { val: 2.5, label: "2.5m", color: "#1a7a45" },
    { val: 5, label: "5m", color: "#2563eb" },
    { val: 10, label: "10m", color: "#d97706" },
    { val: 15, label: "15m", color: "#c0392b" },
  ];

  // ── Chart cursor (scrubber) ───────────────────────────────────────────────
  chartCursorX: number | null = null;
  chartCursorS: number | null = null;
  private cursorMarker?: L.CircleMarker;

  onChartMouseMove(event: MouseEvent): void {
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const viewBoxW = this.CHART_W + this.CHART_PAD_L + 18;
    const svgX = ((event.clientX - rect.left) / rect.width) * viewBoxW;
    const clamped = Math.max(
      this.CHART_PAD_L,
      Math.min(this.CHART_PAD_L + this.CHART_W, svgX),
    );
    const s =
      ((clamped - this.CHART_PAD_L) / this.CHART_W) *
      (this.refIdx?.totalArc ?? 1);

    this.chartCursorX = clamped;
    this.chartCursorS = s;

    const pt = this.arcToLatLon(s);
    if (pt && this.leafletMap) {
      this.ngZone.runOutsideAngular(() => {
        if (!this.cursorMarker) {
          this.cursorMarker = L.circleMarker([pt.lat, pt.lon], {
            radius: 9,
            color: "#14130F",
            fillColor: "#ffffff",
            fillOpacity: 1,
            weight: 2.5,
          }).addTo(this.leafletMap!);
        } else {
          this.cursorMarker.setLatLng([pt.lat, pt.lon]);
        }
      });
    }
  }

  onChartMouseLeave(): void {
    this.chartCursorX = null;
    this.chartCursorS = null;
    this.ngZone.runOutsideAngular(() => {
      this.cursorMarker?.remove();
      this.cursorMarker = undefined;
    });
  }

  private arcToLatLon(s: number): GeoPoint | null {
    const idx = this.refIdx;
    if (!idx || this.refPoints.length < 2) return null;
    const cumArc = idx.cumArc;
    let lo = 0,
      hi = cumArc.length - 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      cumArc[mid + 1] < s ? (lo = mid + 1) : (hi = mid);
    }
    const i = lo;
    const segLen = cumArc[i + 1] - cumArc[i];
    const t =
      segLen > 0 ? Math.max(0, Math.min(1, (s - cumArc[i]) / segLen)) : 0;
    const a = this.refPoints[i],
      b = this.refPoints[i + 1] ?? a;
    return {
      lat: a.lat + t * (b.lat - a.lat),
      lon: a.lon + t * (b.lon - a.lon),
    };
  }

  get chartCursorValues(): { modeName: string; color: string; err: number }[] {
    if (this.chartCursorS === null || !this.analytics) return [];
    const s = this.chartCursorS;
    return this.analytics
      .filter((m) => m.visible)
      .map((m) => {
        const errs = m.runMetrics
          .map((rm) => {
            if (!rm.errProfile.length) return NaN;
            let best = rm.errProfile[0],
              bestD = Math.abs(rm.errProfile[0].s - s);
            for (const pt of rm.errProfile) {
              const d = Math.abs(pt.s - s);
              if (d < bestD) {
                bestD = d;
                best = pt;
              }
            }
            return best.err;
          })
          .filter((e) => !isNaN(e));
        return {
          modeName: m.modeName,
          color: m.color,
          err: errs.length
            ? errs.reduce((a, b) => a + b, 0) / errs.length
            : NaN,
        };
      });
  }

  get chartMaxErr(): number {
    if (!this.analytics || !this.refIdx) return 15;
    let max = 0;
    for (const m of this.analytics) {
      if (!m.visible) continue;
      for (const rm of m.runMetrics) max = Math.max(max, rm.maxErr);
    }
    if (max === 0) return 15;
    // Round up to next multiple of 5 with 10% headroom
    const withPad = max * 1.1;
    return Math.min(Math.ceil(withPad / 5) * 5, 80);
  }

  get chartViewBox(): string {
    return `0 0 ${this.CHART_W + this.CHART_PAD_L + 18} ${this.CHART_H + this.CHART_PAD_B + 8}`;
  }

  chartX(s: number): number {
    const totalArc = this.refIdx?.totalArc ?? 1;
    return this.CHART_PAD_L + (s / totalArc) * this.CHART_W;
  }

  chartY(err: number): number {
    return (
      4 +
      (1 - Math.min(err, this.chartMaxErr) / this.chartMaxErr) * this.CHART_H
    );
  }

  get chartPaths(): { d: string; color: string; dim: boolean }[] {
    if (!this.analytics || !this.refIdx) return [];
    const totalArc = this.refIdx.totalArc;
    // Max sAlong gap allowed before breaking the polyline (5% of route length)
    const gapThreshold = totalArc * 0.05;
    const paths: { d: string; color: string; dim: boolean }[] = [];
    for (const m of this.analytics) {
      if (!m.visible) continue;
      const dim = !!this.hoveredModeId && this.hoveredModeId !== m.modeId;
      for (const rm of m.runMetrics) {
        if (rm.errProfile.length < 2) continue;
        // Sort by route position so the path always goes left→right
        const sorted = [...rm.errProfile].sort((a, b) => a.s - b.s);
        let d = "";
        for (let i = 0; i < sorted.length; i++) {
          const pt = sorted[i];
          const gap = i === 0 ? 0 : sorted[i].s - sorted[i - 1].s;
          const cmd = i === 0 || gap > gapThreshold ? "M" : "L";
          d += `${cmd}${this.chartX(pt.s).toFixed(1)},${this.chartY(pt.err).toFixed(1)} `;
        }
        paths.push({ d: d.trim(), color: m.color, dim });
      }
    }
    return paths;
  }

  get chartThresholds(): { y: number; label: string; color: string }[] {
    return this.THRESHOLDS.filter((t) => t.val <= this.chartMaxErr).map(
      (t) => ({ y: this.chartY(t.val), label: t.label, color: t.color }),
    );
  }

  get chartCornerLines(): number[] {
    return (this.refIdx?.cornerSAlongs ?? []).map((s) => this.chartX(s));
  }

  get chartYTicks(): { y: number; label: string }[] {
    const max = this.chartMaxErr;
    const step = max <= 20 ? 5 : max <= 50 ? 10 : 20;
    const ticks: number[] = [];
    for (let v = 0; v <= max; v += step) ticks.push(v);
    return ticks.map((v) => ({ y: this.chartY(v), label: `${v}m` }));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  fmt(v: number, dec = 1): string {
    return isNaN(v) || !isFinite(v) ? "—" : v.toFixed(dec);
  }
  fmtHz(v: number): string {
    return v > 0 ? `${v.toFixed(2)} Hz` : "—";
  }
  fmtPct(v: number): string {
    return isNaN(v) ? "—" : `${v.toFixed(1)}%`;
  }
  fmtMs(v: number): string {
    return isNaN(v) ? "—" : `${(v * 100).toFixed(1)} cm/s`;
  }
  fmtDelta(v: number): string {
    return isNaN(v) || !isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)} m`;
  }

  modeAvgDist(m: UrbanModeAnalytics): number {
    if (!m.runs.length) return 0;
    return m.runs.reduce((s, r) => s + r.distance_m, 0) / m.runs.length;
  }

  modeDeltaDist(m: UrbanModeAnalytics): number {
    return this.modeAvgDist(m) - this.refTotalArc;
  }

  fmtDist(v: number): string {
    return isNaN(v) ? "—" : `${Math.round(v)} m`;
  }

  get totalRuns(): number {
    return (this.analytics ?? []).reduce((s, m) => s + m.runs.length, 0);
  }
  get refTotalArc(): number {
    return this.refIdx?.totalArc ?? 0;
  }
  get cornerCount(): number {
    return this.refIdx?.cornerIndices.length ?? 0;
  }

  rankBarPct(val: number, maxVal: number): string {
    if (!maxVal || isNaN(val) || isNaN(maxVal)) return "0%";
    return `${Math.round((val / maxVal) * 100)}%`;
  }
}

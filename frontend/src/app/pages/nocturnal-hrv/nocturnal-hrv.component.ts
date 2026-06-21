import {
  Component, OnInit, OnDestroy, ViewChild, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { NocturnalHrvSummary, NocturnalHrvDetail, NocturnalHrvAiAnalysis, NocturnalHrvAggregated } from '../../models/hrv-analysis.model';
import { MatButtonModule }  from '@angular/material/button';
import { MatIconModule }    from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BaseChartDirective } from 'ng2-charts';

// ─── Domain types ─────────────────────────────────────────────────────────────

interface RawRR    { ts: Date; rr: number; }
interface RawHRRow { ts: Date; hr: number; hrv: number | null; breathing: number | null; }
interface FitbitHrvRow { ts: Date; rmssd: number; }
interface FitbitHRRow  { ts: Date; bpm: number; }

interface HrvWindow {
  tStart:         Date;
  label:          string;
  tsMs:           number;
  rmssdPolar:     number | null;
  rmssdFitbit:    number | null;
  hrPolar:        number | null;
  hrFitbit:       number | null;
  sdnnPolar:      number | null;
  pnn50Polar:     number | null;
  breathingPolar: number | null;
  beatsInWindow:  number;
}

interface Summary {
  polarRmssdMean:  number | null;
  polarRmssdSd:    number | null;
  fitbitRmssdMean: number | null;
  fitbitRmssdSd:   number | null;
  biasMean:        number | null;
  biasPct:         number | null;
  pearsonR:        number | null;
  rmssdMAE:        number | null;
  polarHRMean:     number | null;
  polarHRMin:      number | null;
  fitbitHRMean:    number | null;
  fitbitHRMin:     number | null;
  hrMAE:           number | null;
  pearsonRHR:      number | null;
  blandSd:         number | null;
  upperLoa:        number | null;
  lowerLoa:        number | null;
}

interface FileCard {
  label:        string;
  sublabel:     string;
  accept:       string;
  loaded:       boolean;
  name:         string;
  error:        string;
  validWindows: number;
  rejectedPct:  number;
}

type FileKey = 'polarRR' | 'polarHR' | 'fitbitHrv' | 'fitbitHR';

// ─── Bland-Altman label plugin ────────────────────────────────────────────────

const baLabelsPlugin: any = {
  id: 'baLabels',
  afterDatasetsDraw(chart: any) {
    const { ctx, scales, chartArea } = chart;
    if (!scales['x'] || !scales['y']) return;
    const datasets: any[] = chart.data.datasets;
    ctx.save();
    ctx.font = '10px "Inter Tight",system-ui,sans-serif';
    ctx.textAlign = 'right';
    for (let i = 1; i < datasets.length; i++) {
      const ds = datasets[i];
      if (!ds?.data?.length) continue;
      const yVal = (ds.data[0] as any)?.y;
      if (yVal == null) continue;
      const yPx = scales['y'].getPixelForValue(yVal);
      if (yPx < chartArea.top || yPx > chartArea.bottom) continue;
      ctx.fillStyle = typeof ds.borderColor === 'string' ? ds.borderColor : '#555';
      ctx.fillText(ds.label ?? '', chartArea.right - 4, yPx - 3);
    }
    ctx.restore();
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-nocturnal-hrv',
  standalone: true,
  imports: [
    CommonModule, DatePipe, FormsModule, RouterModule,
    MatButtonModule, MatIconModule, MatTooltipModule,
    BaseChartDirective,
  ],
  templateUrl: './nocturnal-hrv.component.html',
  styleUrls: ['./nocturnal-hrv.component.scss'],
})
export class NocturnalHrvComponent implements OnInit, OnDestroy {

  // ── Device / session state ─────────────────────────────────────────────────
  deviceId             = '';
  savedSessions:       NocturnalHrvSummary[] = [];
  loadingSessions      = false;
  savingSession        = false;
  currentSessionId:    string | null = null;
  sessionName          = '';

  // ── AI analysis ────────────────────────────────────────────────────────────
  aiAnalysis:    NocturnalHrvAiAnalysis | null = null;
  loadingAi      = false;
  generatingAi   = false;
  aiError        = '';

  // ── Global aggregated charts ───────────────────────────────────────────────
  globalData:     NocturnalHrvAggregated | null = null;
  loadingGlobal   = false;
  gcRmssdData: any = { datasets: [] };
  gcBlandData: any = { datasets: [] };
  gcHrData:    any = { datasets: [] };
  readonly gcRmssdOptions = this.makeCorrelationOpts('RMSSD Polar H10 (ms)', 'RMSSD Fitbit (ms)');
  readonly gcBlandOptions = this.makeBaOpts();
  readonly gcHrOptions    = this.makeCorrelationOpts('FC Polar H10 (bpm)', 'FC Fitbit (bpm)');
  readonly gcPlugins       = [baLabelsPlugin];

  // ── Settings ───────────────────────────────────────────────────────────────
  artifactThresholdPct = 20;
  minBeatsPerWindow    = 30;
  showSettings         = false;

  // ── Raw File objects (for upload) ─────────────────────────────────────────
  private rawFileObjects: Partial<Record<FileKey, File>> = {};

  // ── File cards (ordered for template iteration) ────────────────────────────
  readonly fileKeys: FileKey[] = ['polarRR', 'polarHR', 'fitbitHrv', 'fitbitHR'];

  files: Record<FileKey, FileCard> = {
    polarRR:   { label: 'Polar H10 — RR',   sublabel: '.txt · timestamp;RR[ms]',           accept: '.txt', loaded: false, name: '', error: '', validWindows: 0, rejectedPct: 0 },
    polarHR:   { label: 'Polar H10 — HR',   sublabel: '.txt · timestamp;HR;HRV;Breathing', accept: '.txt', loaded: false, name: '', error: '', validWindows: 0, rejectedPct: 0 },
    fitbitHrv: { label: 'Fitbit HRV',       sublabel: '.csv · timestamp,rmssd,...',         accept: '.csv', loaded: false, name: '', error: '', validWindows: 0, rejectedPct: 0 },
    fitbitHR:  { label: 'Fitbit HR',        sublabel: '.csv · timestamp,bpm,source',        accept: '.csv', loaded: false, name: '', error: '', validWindows: 0, rejectedPct: 0 },
  };

  // ── Parsed raw data ────────────────────────────────────────────────────────
  private rawRR:         RawRR[]        = [];
  private cleanRR:       RawRR[]        = [];
  private rawHR:         RawHRRow[]     = [];
  private fitbitHrvRows: FitbitHrvRow[] = [];
  private fitbitHrRows:  FitbitHRRow[]  = [];

  // ── Computed output ────────────────────────────────────────────────────────
  windows:        HrvWindow[] = [];
  summary:        Summary | null = null;
  overlapWarning = false;

  // ── Chart data ─────────────────────────────────────────────────────────────
  chart1Data: any = { datasets: [] };
  chart2Data: any = { datasets: [] };
  chart3Data: any = { datasets: [] };
  chart4Data: any = { datasets: [] };
  chart5Data: any = { datasets: [] };
  chart6Data: any = { datasets: [] };

  readonly chart1Options = this.makeTimeOpts('RMSSD (ms)');
  readonly chart2Options = this.makeTimeOpts('FC (bpm)');
  readonly chart3Options = this.makeErrorOpts();
  readonly chart4Options = this.makeBaOpts();
  readonly chart5Options = this.makeCorrelationOpts('RMSSD Polar H10 (ms)', 'RMSSD Fitbit (ms)');
  readonly chart6Options = this.makeCorrelationOpts('FC Polar (bpm)', 'FC Fitbit (bpm)');
  readonly chart4Plugins = [baLabelsPlugin];

  // ── Zoom ───────────────────────────────────────────────────────────────────
  private xDataMin = 0;
  private xDataMax = 0;

  @ViewChild('c1', { read: BaseChartDirective }) c1Ref?: BaseChartDirective;
  @ViewChild('c2', { read: BaseChartDirective }) c2Ref?: BaseChartDirective;
  @ViewChild('c3', { read: BaseChartDirective }) c3Ref?: BaseChartDirective;
  @ViewChild('c4', { read: BaseChartDirective }) c4Ref?: BaseChartDirective;
  @ViewChild('c5', { read: BaseChartDirective }) c5Ref?: BaseChartDirective;
  @ViewChild('c6', { read: BaseChartDirective }) c6Ref?: BaseChartDirective;
  @ViewChild('gcRmssd', { read: BaseChartDirective }) gcRmssdRef?: BaseChartDirective;
  @ViewChild('gcBland', { read: BaseChartDirective }) gcBlandRef?: BaseChartDirective;
  @ViewChild('gcHr',    { read: BaseChartDirective }) gcHrRef?:    BaseChartDirective;

  constructor(
    private cdRef: ChangeDetectorRef,
    private route: ActivatedRoute,
    private api: ApiService,
  ) {}

  ngOnInit(): void {
    this.deviceId = this.route.snapshot.paramMap.get('deviceId') ?? '';
    if (this.deviceId) this.loadSavedSessions();
  }

  ngOnDestroy(): void {}

  // ── Session persistence ────────────────────────────────────────────────────

  private loadSavedSessions(): void {
    this.loadingSessions = true;
    this.api.listNocturnalHrvSessions(this.deviceId).subscribe({
      next: sessions => {
        this.savedSessions = sessions;
        this.loadingSessions = false;
        this.loadGlobalData();
        if (sessions.length > 0 && !this.hasData) {
          this.loadSession(sessions[0].id);
        }
      },
      error: () => { this.loadingSessions = false; },
    });
  }

  loadSession(id: string): void {
    this.api.getNocturnalHrvSession(id).subscribe({
      next: (session: NocturnalHrvDetail) => {
        this.currentSessionId = id;
        this.sessionName = session.session_name;
        if (session.settings) {
          this.artifactThresholdPct = session.settings.artifact_threshold_pct ?? 20;
          this.minBeatsPerWindow    = session.settings.min_beats_per_window ?? 30;
        }

        this.windows = (session.windows ?? []).map((w: any) => ({
          ...w,
          tStart: new Date(w.tStart),
        }));
        this.summary = (session.summary as any) ?? null;
        this.overlapWarning = false;

        this.resetFileCards();
        if (session.polar_rr_filename)   { this.files.polarRR.name   = session.polar_rr_filename;   this.files.polarRR.loaded   = true; }
        if (session.polar_hr_filename)   { this.files.polarHR.name   = session.polar_hr_filename;   this.files.polarHR.loaded   = true; }
        if (session.fitbit_hrv_filename) { this.files.fitbitHrv.name = session.fitbit_hrv_filename; this.files.fitbitHrv.loaded = true; }
        if (session.fitbit_hr_filename)  { this.files.fitbitHR.name  = session.fitbit_hr_filename;  this.files.fitbitHR.loaded  = true; }

        this.rawRR = []; this.cleanRR = []; this.rawHR = [];
        this.fitbitHrvRows = []; this.fitbitHrRows = [];
        this.rawFileObjects = {};

        const FIVE = 5 * 60 * 1000;
        this.xDataMin = this.windows[0]?.tsMs ?? 0;
        this.xDataMax = (this.windows.at(-1)?.tsMs ?? 0) + FIVE;
        this.buildCharts();
        this.aiAnalysis = null;
        this.aiError = '';
        this.loadAiAnalysis(id);
        this.cdRef.markForCheck();
      },
    });
  }

  // ── Global aggregated charts ───────────────────────────────────────────────

  private readonly SESSION_COLORS = [
    'rgba(99,102,241,0.65)', 'rgba(16,185,129,0.65)', 'rgba(245,158,11,0.65)',
    'rgba(239,68,68,0.65)',  'rgba(139,92,246,0.65)', 'rgba(14,165,233,0.65)',
    'rgba(249,115,22,0.65)', 'rgba(236,72,153,0.65)',
  ];

  loadGlobalData(): void {
    if (!this.deviceId) return;
    this.loadingGlobal = true;
    this.api.getAggregatedHrvData(this.deviceId).subscribe({
      next:  data => { this.globalData = data; this.loadingGlobal = false; this.buildGlobalCharts(); this.cdRef.markForCheck(); },
      error: ()   => { this.loadingGlobal = false; this.cdRef.markForCheck(); },
    });
  }

  private buildGlobalCharts(): void {
    const g = this.globalData;
    if (!g) return;
    this.buildGcRmssd(g);
    this.buildGcBland(g);
    this.buildGcHr(g);
  }

  private buildGcRmssd(g: NocturnalHrvAggregated): void {
    const st = g.rmssd.stats;
    if (!st || g.rmssd.by_session.length === 0) { this.gcRmssdData = { datasets: [] }; return; }

    const scatterDs = g.rmssd.by_session.map((s, i) => ({
      type: 'scatter',
      label: s.session_name,
      data:  s.points,
      backgroundColor: this.SESSION_COLORS[i % this.SESSION_COLORS.length],
      borderColor: 'transparent',
      pointRadius: 5, pointHoverRadius: 7,
    }));

    const allX = g.rmssd.by_session.flatMap(s => s.points.map(p => p.x));
    const allY = g.rmssd.by_session.flatMap(s => s.points.map(p => p.y));
    const all  = [...allX, ...allY];
    const pad  = (Math.max(...all) - Math.min(...all)) * 0.06 + 2;
    const vMin = Math.min(...all) - pad;
    const vMax = Math.max(...all) + pad;
    const { slope: sl, intercept: ic } = st;
    const regLabel = sl != null && ic != null
      ? `Regresión y=${sl.toFixed(2)}x${ic >= 0 ? '+' : ''}${ic.toFixed(1)}`
      : 'Regresión';

    this.gcRmssdData = {
      datasets: [
        ...scatterDs,
        { type: 'line', label: 'Identidad (y=x)', data: [{ x: vMin, y: vMin }, { x: vMax, y: vMax }],
          borderColor: 'rgba(150,150,150,0.5)', borderWidth: 1.5, borderDash: [4,4], pointRadius: 0, fill: false },
        { type: 'line', label: regLabel,
          data: sl != null && ic != null
            ? [{ x: vMin, y: sl * vMin + ic }, { x: vMax, y: sl * vMax + ic }]
            : [],
          borderColor: '#6366f1', borderWidth: 2, borderDash: [5,3], pointRadius: 0, fill: false },
      ],
    };
  }

  private buildGcBland(g: NocturnalHrvAggregated): void {
    const st = g.rmssd.stats;
    if (!st || g.rmssd.by_session.length === 0) { this.gcBlandData = { datasets: [] }; return; }

    const allPts = g.rmssd.by_session.flatMap((s, i) =>
      s.points.map(p => ({
        pt: { x: (p.x + p.y) / 2, y: p.y - p.x },
        color: this.SESSION_COLORS[i % this.SESSION_COLORS.length],
      }))
    );
    const means   = allPts.map(p => p.pt.x);
    const xPad    = (Math.max(...means) - Math.min(...means)) * 0.1 + 3;
    const xMin    = Math.min(...means) - xPad;
    const xMax    = Math.max(...means) + xPad;
    const { bias, upperLoa: upper, lowerLoa: lower } = st;

    const scatterDs = g.rmssd.by_session.map((s, i) => ({
      type: 'scatter',
      label: s.session_name,
      data:  s.points.map(p => ({ x: (p.x + p.y) / 2, y: p.y - p.x })),
      backgroundColor: this.SESSION_COLORS[i % this.SESSION_COLORS.length],
      borderColor: 'transparent',
      pointRadius: 5, pointHoverRadius: 7,
    }));

    this.gcBlandData = {
      datasets: [
        ...scatterDs,
        { type: 'line', label: `Sesgo: ${this.fmt(bias)} ms`,
          data: [{ x: xMin, y: bias }, { x: xMax, y: bias }],
          borderColor: '#6366f1', borderWidth: 2, borderDash: [5,4], pointRadius: 0, fill: false },
        { type: 'line', label: `+1.96 DE: ${this.fmt(upper)} ms`,
          data: [{ x: xMin, y: upper }, { x: xMax, y: upper }],
          borderColor: '#ef4444', borderWidth: 1.5, borderDash: [2,4], pointRadius: 0, fill: false },
        { type: 'line', label: `-1.96 DE: ${this.fmt(lower)} ms`,
          data: [{ x: xMin, y: lower }, { x: xMax, y: lower }],
          borderColor: '#3b82f6', borderWidth: 1.5, borderDash: [2,4], pointRadius: 0, fill: false },
      ],
    };
  }

  private buildGcHr(g: NocturnalHrvAggregated): void {
    const st = g.hr.stats;
    if (!st || g.hr.by_session.length === 0) { this.gcHrData = { datasets: [] }; return; }

    const scatterDs = g.hr.by_session.map((s, i) => ({
      type: 'scatter',
      label: s.session_name,
      data:  s.points,
      backgroundColor: this.SESSION_COLORS[i % this.SESSION_COLORS.length],
      borderColor: 'transparent',
      pointRadius: 5, pointHoverRadius: 7,
    }));

    const allX = g.hr.by_session.flatMap(s => s.points.map(p => p.x));
    const allY = g.hr.by_session.flatMap(s => s.points.map(p => p.y));
    const all  = [...allX, ...allY];
    const pad  = (Math.max(...all) - Math.min(...all)) * 0.06 + 1;
    const vMin = Math.min(...all) - pad;
    const vMax = Math.max(...all) + pad;
    const { slope: sl, intercept: ic } = st;
    const regLabel = sl != null && ic != null
      ? `Regresión y=${sl.toFixed(2)}x${ic >= 0 ? '+' : ''}${ic.toFixed(1)}`
      : 'Regresión';

    this.gcHrData = {
      datasets: [
        ...scatterDs,
        { type: 'line', label: 'Identidad (y=x)', data: [{ x: vMin, y: vMin }, { x: vMax, y: vMax }],
          borderColor: 'rgba(150,150,150,0.5)', borderWidth: 1.5, borderDash: [4,4], pointRadius: 0, fill: false },
        { type: 'line', label: regLabel,
          data: sl != null && ic != null
            ? [{ x: vMin, y: sl * vMin + ic }, { x: vMax, y: sl * vMax + ic }]
            : [],
          borderColor: '#10b981', borderWidth: 2, borderDash: [5,3], pointRadius: 0, fill: false },
      ],
    };
  }

  loadAiAnalysis(id: string): void {
    this.loadingAi = true;
    this.api.getNocturnalHrvAiAnalysis(id).subscribe({
      next:  ai  => { this.aiAnalysis = ai; this.loadingAi = false; this.cdRef.markForCheck(); },
      error: ()  => { this.loadingAi = false; this.cdRef.markForCheck(); },
    });
  }

  generateAiAnalysis(): void {
    if (!this.currentSessionId || this.generatingAi) return;
    this.generatingAi = true;
    this.aiError = '';
    this.aiAnalysis = null;
    this.api.generateNocturnalHrvAiAnalysis(this.currentSessionId).subscribe({
      next:  ai  => { this.aiAnalysis = ai; this.generatingAi = false; this.cdRef.markForCheck(); },
      error: err => {
        this.aiError = err?.error?.detail ?? 'Error al generar el análisis IA';
        this.generatingAi = false;
        this.cdRef.markForCheck();
      },
    });
  }

  deleteSession(id: string, event: Event): void {
    event.stopPropagation();
    this.api.deleteNocturnalHrvSession(id).subscribe({
      next: () => {
        this.savedSessions = this.savedSessions.filter(s => s.id !== id);
        if (this.currentSessionId === id) {
          this.windows = []; this.summary = null; this.currentSessionId = null;
          this.aiAnalysis = null; this.aiError = '';
          this.resetFileCards();
        }
        this.loadGlobalData();
      },
    });
  }

  saveCurrentSession(): void {
    if (!this.hasData || !this.deviceId || this.savingSession) return;
    this.savingSession = true;

    const fd = new FormData();
    if (this.rawFileObjects.polarRR)   fd.append('polar_rr_file',   this.rawFileObjects.polarRR);
    if (this.rawFileObjects.polarHR)   fd.append('polar_hr_file',   this.rawFileObjects.polarHR);
    if (this.rawFileObjects.fitbitHrv) fd.append('fitbit_hrv_file', this.rawFileObjects.fitbitHrv);
    if (this.rawFileObjects.fitbitHR)  fd.append('fitbit_hr_file',  this.rawFileObjects.fitbitHR);

    fd.append('session_name', this.sessionName.trim() ||
      `HRV Nocturno ${new Date().toLocaleDateString('es-ES')}`);

    const windowsForSave = this.windows.map(w => ({ ...w, tStart: w.tStart.toISOString() }));
    fd.append('windows_json',  JSON.stringify(windowsForSave));
    fd.append('summary_json',  JSON.stringify(this.summary));
    fd.append('settings_json', JSON.stringify({
      artifact_threshold_pct: this.artifactThresholdPct,
      min_beats_per_window:   this.minBeatsPerWindow,
    }));

    this.api.saveNocturnalHrvSession(this.deviceId, fd).subscribe({
      next: saved => {
        this.currentSessionId = saved.id;
        this.sessionName = saved.session_name;
        this.savedSessions = [saved, ...this.savedSessions];
        this.savingSession = false;
        this.loadGlobalData();
      },
      error: () => { this.savingSession = false; },
    });
  }

  private resetFileCards(): void {
    for (const key of this.fileKeys) {
      this.files[key].loaded = false;
      this.files[key].name = '';
      this.files[key].error = '';
      this.files[key].validWindows = 0;
      this.files[key].rejectedPct = 0;
    }
  }

  // ── File handling ──────────────────────────────────────────────────────────

  onFileSelected(event: Event, key: FileKey): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.rawFileObjects[key] = file;
    this.currentSessionId = null;
    this.files[key].error = '';
    this.files[key].name  = file.name;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target!.result as string;
      try {
        this.parseFile(text, key);
        this.files[key].loaded = true;
      } catch (err: any) {
        this.files[key].error  = err?.message ?? 'Error al leer el fichero';
        this.files[key].loaded = false;
      }
      this.processAll();
      this.cdRef.markForCheck();
      (event.target as HTMLInputElement).value = '';
    };
    reader.readAsText(file, 'utf-8');
  }

  onDrop(event: DragEvent, key: FileKey): void {
    event.preventDefault();
    (event.currentTarget as HTMLElement).classList.remove('drag-over');
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    this.rawFileObjects[key] = file;
    this.currentSessionId = null;
    this.files[key].error = '';
    this.files[key].name  = file.name;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target!.result as string;
      try {
        this.parseFile(text, key);
        this.files[key].loaded = true;
      } catch (err: any) {
        this.files[key].error  = err?.message ?? 'Error al leer el fichero';
        this.files[key].loaded = false;
      }
      this.processAll();
      this.cdRef.markForCheck();
    };
    reader.readAsText(file, 'utf-8');
  }

  onDragOver(e: DragEvent): void {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.add('drag-over');
  }
  onDragLeave(e: DragEvent): void {
    (e.currentTarget as HTMLElement).classList.remove('drag-over');
  }

  // ── Parsers ────────────────────────────────────────────────────────────────

  private parseFile(text: string, key: FileKey): void {
    switch (key) {
      case 'polarRR':   this.parsePolarRR(text);   break;
      case 'polarHR':   this.parsePolarHR(text);   break;
      case 'fitbitHrv': this.parseFitbitHrv(text); break;
      case 'fitbitHR':  this.parseFitbitHR(text);  break;
    }
  }

  private parsePolarRR(text: string): void {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('Fichero sin datos');
    const sep = lines[0].includes(';') ? ';' : ',';
    const raw: RawRR[] = [];
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(sep);
      if (p.length < 2) continue;
      const ts = this.parseTs(p[0]);
      const rr = parseFloat(p[1].trim());
      if (!isFinite(rr) || isNaN(ts.getTime())) continue;
      if (rr < 300 || rr > 2000) continue;   // physiological bounds: 30–200 bpm
      raw.push({ ts, rr });
    }
    if (!raw.length) throw new Error('Sin intervalos RR válidos (300–2000 ms)');
    this.rawRR = raw;

    // Ectopic filter: remove beats where |RR - local_median| > threshold
    const rrVals = raw.map(r => r.rr);
    const thr    = this.artifactThresholdPct / 100;
    const HALF   = 5;
    let rejected = 0;
    this.cleanRR = raw.filter((_, i) => {
      const lo  = Math.max(0, i - HALF);
      const hi  = Math.min(rrVals.length - 1, i + HALF);
      const med = this.median(rrVals.slice(lo, hi + 1));
      if (Math.abs(rrVals[i] - med) > thr * med) { rejected++; return false; }
      return true;
    });
    this.files.polarRR.rejectedPct = raw.length ? +(rejected / raw.length * 100).toFixed(1) : 0;
  }

  private parsePolarHR(text: string): void {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('Fichero sin datos');
    const sep  = lines[0].includes(';') ? ';' : ',';
    const rows: RawHRRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const p  = lines[i].split(sep);
      if (p.length < 2) continue;
      const ts = this.parseTs(p[0]);
      const hr = parseFloat(p[1].trim());
      if (!isFinite(hr) || isNaN(ts.getTime())) continue;
      const hrv = p[2]?.trim() ? parseFloat(p[2].trim().replace(',', '.')) : null;
      const br  = p[3]?.trim() ? parseFloat(p[3].trim().replace(',', '.')) : null;
      rows.push({
        ts, hr,
        hrv: hrv != null && !isNaN(hrv) ? hrv : null,
        breathing: br != null && !isNaN(br) ? br : null,
      });
    }
    if (!rows.length) throw new Error('Sin datos de FC válidos');
    this.rawHR = rows;
  }

  private parseFitbitHrv(text: string): void {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('Fichero sin datos');
    const sep  = lines[0].includes(';') ? ';' : ',';
    const rows: FitbitHrvRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const p     = lines[i].split(sep);
      if (p.length < 2) continue;
      const ts    = this.parseTs(p[0]);
      const rmssd = parseFloat(p[1].trim());
      if (!isFinite(rmssd) || isNaN(ts.getTime())) continue;
      rows.push({ ts, rmssd });
    }
    if (!rows.length) throw new Error('Sin datos HRV de Fitbit');
    this.fitbitHrvRows = rows;
    this.files.fitbitHrv.validWindows = rows.length;
  }

  private parseFitbitHR(text: string): void {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('Fichero sin datos');
    const sep  = lines[0].includes(';') ? ';' : ',';
    const rows: FitbitHRRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const p   = lines[i].split(sep);
      if (p.length < 2) continue;
      const ts  = this.parseTs(p[0]);
      const bpm = parseFloat(p[1].trim());
      if (!isFinite(bpm) || isNaN(ts.getTime())) continue;
      rows.push({ ts, bpm });
    }
    if (!rows.length) throw new Error('Sin datos HR de Fitbit');
    this.fitbitHrRows = rows;
  }

  // ── Processing pipeline ────────────────────────────────────────────────────

  processAll(): void {
    const hasPolarRR   = this.rawRR.length > 0;
    const hasFitbitHrv = this.fitbitHrvRows.length > 0;
    if (!hasPolarRR && !hasFitbitHrv) { this.windows = []; this.summary = null; return; }

    // Time grid: 5-minute windows covering only the overlap between both devices.
    // When only one device is loaded, use its full range.
    const FIVE = 5 * 60 * 1000;

    // Polar range: from RR file (primary) extended by HR file if loaded
    const polarTs = [
      ...(hasPolarRR ? this.rawRR.map(r => r.ts.getTime()) : []),
      ...(this.rawHR.length ? this.rawHR.map(r => r.ts.getTime()) : []),
    ];
    const polarMin = polarTs.length ? Math.min(...polarTs) : null;
    const polarMax = polarTs.length ? Math.max(...polarTs) : null;

    // Fitbit range: union of ALL Fitbit files loaded (HRV + HR)
    // This way if Fitbit HR covers all day, the Fitbit range is wider and the
    // intersection = full Polar recording, making HR data available all night.
    const fitbitTs = [
      ...(hasFitbitHrv ? this.fitbitHrvRows.map(r => r.ts.getTime()) : []),
      ...(this.fitbitHrRows.length ? this.fitbitHrRows.map(r => r.ts.getTime()) : []),
    ];
    const fitbitMin = fitbitTs.length ? Math.min(...fitbitTs) : null;
    const fitbitMax = fitbitTs.length ? Math.max(...fitbitTs) : null;

    const hasFitbitAny = fitbitMin != null;

    let gMin: number;
    let gMax: number;

    if (polarMin != null && hasFitbitAny) {
      // Intersection of both device ranges
      gMin = Math.max(polarMin, fitbitMin!);
      gMax = Math.min(polarMax!, fitbitMax!);
    } else if (polarMin != null) {
      gMin = polarMin;
      gMax = polarMax!;
    } else {
      gMin = fitbitMin!;
      gMax = fitbitMax!;
    }

    // Align to 5-min boundaries
    gMin = Math.floor(gMin / FIVE) * FIVE;
    gMax = Math.ceil(gMax  / FIVE) * FIVE;

    // No intersection — nothing to show
    if (gMin >= gMax) {
      this.windows = []; this.summary = null; this.overlapWarning = true; return;
    }

    const gridStarts: number[] = [];
    for (let t = gMin; t < gMax; t += FIVE) gridStarts.push(t);

    // Build HRV windows
    this.windows = gridStarts.map(tMs => {
      const tEnd  = tMs + FIVE;
      const label = this.hhMM(new Date(tMs));

      // ── Polar metrics from clean RR ────────────────────────────────────
      let rmssdPolar: number | null = null;
      let hrPolar:    number | null = null;
      let sdnnPolar:  number | null = null;
      let pnn50Polar: number | null = null;
      let beatsInWindow = 0;

      if (hasPolarRR) {
        const beats = this.cleanRR.filter(r => {
          const t = r.ts.getTime();
          return t >= tMs && t < tEnd;
        });
        beatsInWindow = beats.length;
        if (beats.length >= this.minBeatsPerWindow) {
          const rr  = beats.map(b => b.rr);
          rmssdPolar = this.calcRMSSD(rr);
          hrPolar    = 60000 / (rr.reduce((s, v) => s + v, 0) / rr.length);
          sdnnPolar  = this.stdDev(rr);
          pnn50Polar = this.calcPNN50(rr);
        }
      }

      // ── Fitbit HRV (nearest window within 2.5 min) ────────────────────
      let rmssdFitbit: number | null = null;
      if (hasFitbitHrv) {
        const nb = this.nearest(this.fitbitHrvRows, tMs, 2.5 * 60 * 1000);
        if (nb != null) rmssdFitbit = nb.rmssd;
      }

      // ── Fitbit HR (mean of readings in window, else nearest) ──────────
      let hrFitbit: number | null = null;
      if (this.fitbitHrRows.length) {
        const inWin = this.fitbitHrRows.filter(r => { const t = r.ts.getTime(); return t >= tMs && t < tEnd; });
        if (inWin.length) {
          hrFitbit = inWin.reduce((s, r) => s + r.bpm, 0) / inWin.length;
        } else {
          const nb = this.nearest(this.fitbitHrRows, tMs, 2.5 * 60 * 1000);
          if (nb != null) hrFitbit = nb.bpm;
        }
      }

      // ── Polar breathing rate (nearest from HR file) ───────────────────
      let breathingPolar: number | null = null;
      if (this.rawHR.length) {
        const nb = this.nearest(this.rawHR, tMs, 2.5 * 60 * 1000);
        if (nb?.breathing != null) breathingPolar = nb.breathing;
      }

      return {
        tStart: new Date(tMs), label, tsMs: tMs,
        rmssdPolar, rmssdFitbit, hrPolar, hrFitbit,
        sdnnPolar, pnn50Polar, breathingPolar, beatsInWindow,
      };
    });

    // Update quality badge for Polar RR
    this.files.polarRR.validWindows = this.windows.filter(w => w.rmssdPolar != null).length;

    // Overlap warning: fires when both devices are loaded but their ranges don't intersect at all.
    if (polarMin != null && hasFitbitAny) {
      const rawIntersection = Math.min(polarMax!, fitbitMax!) - Math.max(polarMin, fitbitMin!);
      this.overlapWarning = rawIntersection <= 0;
    } else {
      this.overlapWarning = false;
    }

    // Summary stats
    this.computeSummary();

    // Chart zoom extents
    this.xDataMin = this.windows[0]?.tsMs ?? 0;
    this.xDataMax = (this.windows.at(-1)?.tsMs ?? 0) + FIVE;

    this.buildCharts();
  }

  private computeSummary(): void {
    const pRMSSDs = this.windows.map(w => w.rmssdPolar).filter((v): v is number => v != null);
    const fRMSSDs = this.windows.map(w => w.rmssdFitbit).filter((v): v is number => v != null);
    const pairs   = this.windows
      .filter(w => w.rmssdPolar != null && w.rmssdFitbit != null)
      .map(w => [w.rmssdPolar!, w.rmssdFitbit!] as [number, number]);

    const pHRs   = this.windows.map(w => w.hrPolar).filter((v): v is number => v != null);
    const fHRs   = this.windows.map(w => w.hrFitbit).filter((v): v is number => v != null);
    const hrPairs = this.windows
      .filter(w => w.hrPolar != null && w.hrFitbit != null)
      .map(w => [w.hrPolar!, w.hrFitbit!] as [number, number]);

    const diffs   = pairs.map(([p, f]) => f - p);
    const biasMean = diffs.length ? this.mean(diffs) : null;
    const blandSd  = diffs.length ? this.stdDev(diffs) : null;

    this.summary = {
      polarRmssdMean:  pRMSSDs.length ? this.mean(pRMSSDs) : null,
      polarRmssdSd:    pRMSSDs.length ? this.stdDev(pRMSSDs) : null,
      fitbitRmssdMean: fRMSSDs.length ? this.mean(fRMSSDs) : null,
      fitbitRmssdSd:   fRMSSDs.length ? this.stdDev(fRMSSDs) : null,
      biasMean,
      biasPct: biasMean != null && pRMSSDs.length ? biasMean / this.mean(pRMSSDs) * 100 : null,
      pearsonR: pairs.length >= 3 ? this.pearson(pairs.map(([p]) => p), pairs.map(([, f]) => f)) : null,
      rmssdMAE: pairs.length ? this.mean(pairs.map(([p, f]) => Math.abs(f - p))) : null,
      polarHRMean:  pHRs.length ? this.mean(pHRs)  : null,
      polarHRMin:   pHRs.length ? Math.min(...pHRs) : null,
      fitbitHRMean: fHRs.length ? this.mean(fHRs)  : null,
      fitbitHRMin:  fHRs.length ? Math.min(...fHRs) : null,
      hrMAE:      hrPairs.length ? this.mean(hrPairs.map(([p, f]) => Math.abs(f - p))) : null,
      pearsonRHR: hrPairs.length >= 3 ? this.pearson(hrPairs.map(([p]) => p), hrPairs.map(([, f]) => f)) : null,
      blandSd,
      upperLoa: biasMean != null && blandSd != null ? biasMean + 1.96 * blandSd : null,
      lowerLoa: biasMean != null && blandSd != null ? biasMean - 1.96 * blandSd : null,
    };
  }

  // ── Chart builders ─────────────────────────────────────────────────────────

  private buildCharts(): void {
    this.buildChart1();
    this.buildChart2();
    this.buildChart3();
    this.buildChart4();
    this.buildChart5();
    this.buildChart6();
    setTimeout(() => this.resetZoom(), 20);
  }

  private buildChart1(): void {
    const pPts = this.windows.map(w => ({ x: w.tsMs, y: w.rmssdPolar }));
    const fPts = this.windows.map(w => ({ x: w.tsMs, y: w.rmssdFitbit }));
    const hasP = pPts.some(p => p.y != null);
    const hasF = fPts.some(p => p.y != null);
    const ds: any[] = [];
    if (hasP) ds.push({
      label: 'Polar H10',
      data: pPts,
      borderColor: '#3b82f6', backgroundColor: 'transparent',
      borderWidth: 2, pointRadius: 3, pointHoverRadius: 6,
      tension: 0.35, spanGaps: false, fill: false,
    });
    if (hasF) ds.push({
      label: 'Fitbit',
      data: fPts,
      borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.08)',
      borderWidth: 2, pointRadius: 3, pointHoverRadius: 6,
      tension: 0.35, spanGaps: false,
      fill: hasP ? '-1' : 'origin',
    });
    this.chart1Data = { datasets: ds };
  }

  private buildChart2(): void {
    const hasRawPolar  = this.rawHR.length > 0;
    const hasRawFitbit = this.fitbitHrRows.length > 0;

    let pPts: { x: number; y: number | null }[];
    let fPts: { x: number; y: number | null }[];
    let pointRadius: number;
    let tension: number;

    if (hasRawPolar || hasRawFitbit) {
      // Full native-resolution HR filtered to the sleep window
      const MAX = 4000;

      if (hasRawPolar) {
        const raw = this.rawHR.filter(r => {
          const t = r.ts.getTime();
          return t >= this.xDataMin && t <= this.xDataMax;
        });
        const step = Math.max(1, Math.ceil(raw.length / MAX));
        pPts = raw.filter((_, i) => i % step === 0).map(r => ({ x: r.ts.getTime(), y: r.hr }));
      } else {
        pPts = [];
      }

      if (hasRawFitbit) {
        const raw = this.fitbitHrRows.filter(r => {
          const t = r.ts.getTime();
          return t >= this.xDataMin && t <= this.xDataMax;
        });
        const step = Math.max(1, Math.ceil(raw.length / MAX));
        fPts = raw.filter((_, i) => i % step === 0).map(r => ({ x: r.ts.getTime(), y: r.bpm }));
      } else {
        fPts = [];
      }

      const total = pPts.length + fPts.length;
      pointRadius = total > 300 ? 0 : 3;
      tension = 0.1;
    } else {
      // Fallback to 5-min window averages (e.g. session loaded from DB)
      pPts = this.windows.map(w => ({ x: w.tsMs, y: w.hrPolar }));
      fPts = this.windows.map(w => ({ x: w.tsMs, y: w.hrFitbit }));
      pointRadius = 3;
      tension = 0.35;
    }

    const hasP = pPts.some(p => p.y != null);
    const hasF = fPts.some(p => p.y != null);
    const ds: any[] = [];
    if (hasP) ds.push({
      label: 'Polar H10',
      data: pPts,
      borderColor: '#3b82f6', backgroundColor: 'transparent',
      borderWidth: 1.5, pointRadius, pointHoverRadius: 5,
      tension, spanGaps: false, fill: false,
    });
    if (hasF) ds.push({
      label: 'Fitbit óptico',
      data: fPts,
      borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.08)',
      borderWidth: 1.5, pointRadius, pointHoverRadius: 5,
      tension, spanGaps: false,
      fill: hasP ? '-1' : 'origin',
    });
    this.chart2Data = { datasets: ds };
  }

  private buildChart3(): void {
    const hasBoth = this.windows.some(w => w.rmssdPolar != null && w.rmssdFitbit != null);
    if (!hasBoth) { this.chart3Data = { datasets: [] }; return; }

    const allPts = this.windows.map(w => ({
      x: w.tsMs,
      y: w.rmssdPolar != null && w.rmssdFitbit != null ? w.rmssdFitbit - w.rmssdPolar : null,
    }));
    const posPts = allPts.map(p => ({ x: p.x, y: (p.y != null && p.y > 0) ? p.y : null }));
    const negPts = allPts.map(p => ({ x: p.x, y: (p.y != null && p.y < 0) ? p.y : null }));

    this.chart3Data = {
      datasets: [
        // Positive fill — Fitbit overestimates (red)
        {
          label: '_pos',
          data: posPts,
          borderColor: 'transparent', backgroundColor: 'rgba(239,68,68,0.22)',
          fill: 'origin', pointRadius: 0, tension: 0.35, spanGaps: false,
        },
        // Negative fill — Fitbit underestimates (blue)
        {
          label: '_neg',
          data: negPts,
          borderColor: 'transparent', backgroundColor: 'rgba(59,130,246,0.22)',
          fill: 'origin', pointRadius: 0, tension: 0.35, spanGaps: false,
        },
        // Main error line
        {
          label: 'Error RMSSD (Fitbit − Polar)',
          data: allPts,
          borderColor: '#374151', backgroundColor: 'transparent',
          fill: false, borderWidth: 2,
          pointRadius: 3, pointHoverRadius: 6, tension: 0.35, spanGaps: false,
        },
        // Zero reference
        {
          label: '_zero',
          data: [{ x: this.xDataMin, y: 0 }, { x: this.xDataMax, y: 0 }],
          borderColor: 'rgba(100,100,100,0.35)', borderDash: [4, 4], borderWidth: 1,
          pointRadius: 0, fill: false,
        },
      ],
    };
  }

  private buildChart4(): void {
    const pairs = this.windows
      .filter(w => w.rmssdPolar != null && w.rmssdFitbit != null)
      .map(w => ({ polar: w.rmssdPolar!, fitbit: w.rmssdFitbit! }));
    if (pairs.length < 3) { this.chart4Data = { datasets: [] }; return; }

    const diffs   = pairs.map(p => p.fitbit - p.polar);
    const means   = pairs.map(p => (p.polar + p.fitbit) / 2);
    const bias    = this.mean(diffs);
    const sdDiff  = this.stdDev(diffs);
    const upper   = bias + 1.96 * sdDiff;
    const lower   = bias - 1.96 * sdDiff;
    const xPad    = (Math.max(...means) - Math.min(...means)) * 0.1 + 3;
    const xMin    = Math.min(...means) - xPad;
    const xMax    = Math.max(...means) + xPad;

    this.chart4Data = {
      datasets: [
        {
          type: 'scatter',
          label: 'Ventana 5 min',
          data: pairs.map((p, i) => ({ x: means[i], y: diffs[i] })),
          backgroundColor: 'rgba(99,102,241,0.55)',
          borderColor: 'transparent',
          pointRadius: 5, pointHoverRadius: 7,
        },
        {
          type: 'line',
          label: `Sesgo: ${this.fmt(bias)} ms`,
          data: [{ x: xMin, y: bias }, { x: xMax, y: bias }],
          borderColor: '#6366f1', borderWidth: 2, borderDash: [5, 4],
          pointRadius: 0, fill: false,
        },
        {
          type: 'line',
          label: `+1.96 DE: ${this.fmt(upper)} ms`,
          data: [{ x: xMin, y: upper }, { x: xMax, y: upper }],
          borderColor: '#ef4444', borderWidth: 1.5, borderDash: [2, 4],
          pointRadius: 0, fill: false,
        },
        {
          type: 'line',
          label: `-1.96 DE: ${this.fmt(lower)} ms`,
          data: [{ x: xMin, y: lower }, { x: xMax, y: lower }],
          borderColor: '#3b82f6', borderWidth: 1.5, borderDash: [2, 4],
          pointRadius: 0, fill: false,
        },
      ],
    };
  }

  private buildChart5(): void {
    const pairs = this.windows
      .filter(w => w.rmssdPolar != null && w.rmssdFitbit != null)
      .map(w => ({ polar: w.rmssdPolar!, fitbit: w.rmssdFitbit! }));
    if (pairs.length < 3) { this.chart5Data = { datasets: [] }; return; }

    const xs = pairs.map(p => p.polar);
    const ys = pairs.map(p => p.fitbit);
    const all = [...xs, ...ys];
    const pad  = (Math.max(...all) - Math.min(...all)) * 0.06 + 2;
    const vMin = Math.min(...all) - pad;
    const vMax = Math.max(...all) + pad;
    const { slope, intercept } = this.linearRegression(xs, ys);
    const regLabel = `Regresión y=${slope.toFixed(2)}x${intercept >= 0 ? '+' : ''}${intercept.toFixed(1)}`;

    this.chart5Data = {
      datasets: [
        {
          type: 'scatter',
          label: 'Ventana 5 min',
          data: pairs.map(p => ({ x: p.polar, y: p.fitbit })),
          backgroundColor: 'rgba(99,102,241,0.55)', borderColor: 'transparent',
          pointRadius: 5, pointHoverRadius: 7,
        },
        {
          type: 'line',
          label: 'Identidad (y=x)',
          data: [{ x: vMin, y: vMin }, { x: vMax, y: vMax }],
          borderColor: 'rgba(150,150,150,0.5)', borderWidth: 1.5, borderDash: [4, 4],
          pointRadius: 0, fill: false,
        },
        {
          type: 'line',
          label: regLabel,
          data: [{ x: vMin, y: slope * vMin + intercept }, { x: vMax, y: slope * vMax + intercept }],
          borderColor: '#6366f1', borderWidth: 1.5, borderDash: [5, 3],
          pointRadius: 0, fill: false,
        },
      ],
    };
  }

  private buildChart6(): void {
    const pairs = this.windows
      .filter(w => w.hrPolar != null && w.hrFitbit != null)
      .map(w => ({ polar: w.hrPolar!, fitbit: w.hrFitbit! }));
    if (pairs.length < 3) { this.chart6Data = { datasets: [] }; return; }

    const xs = pairs.map(p => p.polar);
    const ys = pairs.map(p => p.fitbit);
    const all = [...xs, ...ys];
    const pad  = (Math.max(...all) - Math.min(...all)) * 0.06 + 1;
    const vMin = Math.min(...all) - pad;
    const vMax = Math.max(...all) + pad;
    const { slope, intercept } = this.linearRegression(xs, ys);
    const regLabel = `Regresión y=${slope.toFixed(2)}x${intercept >= 0 ? '+' : ''}${intercept.toFixed(1)}`;

    this.chart6Data = {
      datasets: [
        {
          type: 'scatter',
          label: 'Ventana 5 min',
          data: pairs.map(p => ({ x: p.polar, y: p.fitbit })),
          backgroundColor: 'rgba(34,197,94,0.55)', borderColor: 'transparent',
          pointRadius: 5, pointHoverRadius: 7,
        },
        {
          type: 'line',
          label: 'Identidad (y=x)',
          data: [{ x: vMin, y: vMin }, { x: vMax, y: vMax }],
          borderColor: 'rgba(150,150,150,0.5)', borderWidth: 1.5, borderDash: [4, 4],
          pointRadius: 0, fill: false,
        },
        {
          type: 'line',
          label: regLabel,
          data: [{ x: vMin, y: slope * vMin + intercept }, { x: vMax, y: slope * vMax + intercept }],
          borderColor: '#22c55e', borderWidth: 1.5, borderDash: [5, 3],
          pointRadius: 0, fill: false,
        },
      ],
    };
  }

  // ── Chart options factories ────────────────────────────────────────────────

  private makeTimeOpts(yLabel: string): any {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top', align: 'end',
          labels: { color: '#9ca3af', font: { size: 12 }, boxWidth: 24, boxHeight: 3, padding: 20 },
        },
        tooltip: {
          callbacks: {
            title: (items: any[]) => items[0] ? this.hhMM(new Date(items[0].parsed.x)) : '',
            label: (item: any) => `${item.dataset.label}: ${item.parsed.y != null ? this.fmt(item.parsed.y) : '—'}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            callback: (val: any) => this.hhMM(new Date(val as number)),
            maxTicksLimit: 12, color: '#9ca3af', font: { size: 11 },
          },
          grid: { color: 'rgba(229,232,239,0.7)' }, border: { display: false },
        },
        y: {
          ticks: { color: '#9ca3af', font: { size: 11 }, padding: 8 },
          grid: { color: 'rgba(229,232,239,0.7)' }, border: { display: false },
          title: { display: true, text: yLabel, color: '#9ca3af', font: { size: 10 } },
        },
      },
    };
  }

  private makeErrorOpts(): any {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top', align: 'end',
          labels: {
            filter: (item: any) => !item.text.startsWith('_'),
            color: '#9ca3af', font: { size: 12 }, boxWidth: 24, boxHeight: 3, padding: 20,
          },
        },
        tooltip: {
          filter: (item: any) => !item.dataset.label?.startsWith('_'),
          callbacks: {
            title: (items: any[]) => items[0] ? this.hhMM(new Date(items[0].parsed.x)) : '',
            label: (item: any) => `Error: ${item.parsed.y != null ? this.fmtSign(item.parsed.y) : '—'} ms`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          ticks: { callback: (val: any) => this.hhMM(new Date(val as number)), maxTicksLimit: 12, color: '#9ca3af', font: { size: 11 } },
          grid: { color: 'rgba(229,232,239,0.7)' }, border: { display: false },
        },
        y: {
          ticks: { color: '#9ca3af', font: { size: 11 }, padding: 8 },
          grid: { color: 'rgba(229,232,239,0.7)' }, border: { display: false },
          title: { display: true, text: 'Error (Fitbit − Polar) ms', color: '#9ca3af', font: { size: 10 } },
        },
      },
    };
  }

  private makeCorrelationOpts(xLabel: string, yLabel: string): any {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          position: 'top', align: 'end',
          labels: {
            color: '#9ca3af', font: { size: 12 }, boxWidth: 20, boxHeight: 2, padding: 16,
          },
        },
        tooltip: {
          filter: (item: any) => item.datasetIndex === 0,
          callbacks: {
            label: (item: any) =>
              `Polar: ${this.fmt(item.parsed.x)}   Fitbit: ${this.fmt(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: xLabel, color: '#9ca3af', font: { size: 10 } },
          ticks: { color: '#9ca3af', font: { size: 11 } },
          grid: { color: 'rgba(229,232,239,0.7)' }, border: { display: false },
        },
        y: {
          title: { display: true, text: yLabel, color: '#9ca3af', font: { size: 10 } },
          ticks: { color: '#9ca3af', font: { size: 11 } },
          grid: { color: 'rgba(229,232,239,0.7)' }, border: { display: false },
        },
      },
    };
  }

  private makeBaOpts(): any {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          position: 'top', align: 'end',
          labels: {
            filter: (item: any) => item.datasetIndex === 0,
            color: '#9ca3af', font: { size: 12 },
          },
        },
        tooltip: {
          filter: (item: any) => item.datasetIndex === 0,
          callbacks: {
            label: (item: any) =>
              `Media: ${this.fmt(item.parsed.x)} ms   Dif: ${this.fmtSign(item.parsed.y)} ms`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Media Polar + Fitbit RMSSD (ms)', color: '#9ca3af', font: { size: 10 } },
          ticks: { color: '#9ca3af', font: { size: 11 } },
          grid: { color: 'rgba(229,232,239,0.7)' }, border: { display: false },
        },
        y: {
          title: { display: true, text: 'Diferencia Fitbit − Polar (ms)', color: '#9ca3af', font: { size: 10 } },
          ticks: { color: '#9ca3af', font: { size: 11 } },
          grid: { color: 'rgba(229,232,239,0.7)' }, border: { display: false },
        },
      },
    };
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────

  onChartWheel(event: WheelEvent): void {
    if (!this.windows.length) return;
    event.preventDefault();
    const factor   = event.deltaY < 0 ? 0.75 : 1.33;
    const range    = this.xDataMax - this.xDataMin;
    const curMin   = (this.c1Ref?.chart?.options as any)?.scales?.['x']?.min ?? this.xDataMin;
    const curMax   = (this.c1Ref?.chart?.options as any)?.scales?.['x']?.max ?? this.xDataMax;
    const curRange = curMax - curMin;
    const center   = (curMin + curMax) / 2;
    const newRange = Math.min(curRange * factor, range);
    const newMin   = Math.max(center - newRange / 2, this.xDataMin);
    const newMax   = Math.min(center + newRange / 2, this.xDataMax);
    this.applyZoom(newMin, newMax);
  }

  resetZoom(): void { this.applyZoom(this.xDataMin, this.xDataMax); }

  private applyZoom(min: number, max: number): void {
    for (const ref of [this.c1Ref, this.c2Ref, this.c3Ref]) {
      if (!ref?.chart) continue;
      (ref.chart.options as any).scales!['x']!.min = min;
      (ref.chart.options as any).scales!['x']!.max = max;
      ref.chart.update('none');
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  exportCSV(): void {
    const hdr  = 'tiempo,rmssd_polar_ms,rmssd_fitbit_ms,hr_polar_bpm,hr_fitbit_bpm,sdnn_polar_ms,pnn50_polar_pct,respiracion_polar_rpm';
    const rows = this.windows.map(w => [
      w.label,
      this.csvVal(w.rmssdPolar),
      this.csvVal(w.rmssdFitbit),
      this.csvVal(w.hrPolar, 1),
      this.csvVal(w.hrFitbit, 1),
      this.csvVal(w.sdnnPolar),
      this.csvVal(w.pnn50Polar),
      this.csvVal(w.breathingPolar),
    ].join(','));
    this.download([hdr, ...rows].join('\n'), 'hrv-nocturno.csv', 'text/csv');
  }

  exportChart(ref: BaseChartDirective | undefined, name: string): void {
    const chart = ref?.chart;
    if (!chart) return;
    const canvas  = chart.canvas;
    const origDpr = (chart.options.devicePixelRatio ?? window.devicePixelRatio ?? 1) as number;

    // Re-render at 4× CSS pixels so text/lines are natively sharp (not upscaled)
    chart.options.devicePixelRatio = 4;
    chart.resize();

    const out = document.createElement('canvas');
    out.width  = canvas.width;
    out.height = canvas.height;
    const ctx  = out.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);

    const a = document.createElement('a');
    a.href = out.toDataURL('image/png');
    a.download = `hrv-nocturno-${name}.png`;
    a.click();

    // Restore screen render quality
    chart.options.devicePixelRatio = origDpr;
    chart.resize();
  }

  exportPNG(): void {
    const items = [
      { ref: this.c1Ref,       name: '1-rmssd' },
      { ref: this.c2Ref,       name: '2-fc' },
      { ref: this.c3Ref,       name: '3-error' },
      { ref: this.c4Ref,       name: '4-bland-altman' },
      { ref: this.c5Ref,       name: '5-correlacion-rmssd' },
      { ref: this.c6Ref,       name: '6-correlacion-fc' },
      { ref: this.gcRmssdRef,  name: 'global-correlacion-rmssd' },
      { ref: this.gcBlandRef,  name: 'global-bland-altman-rmssd' },
      { ref: this.gcHrRef,     name: 'global-correlacion-fc' },
    ];
    items.forEach(({ ref, name }, i) => {
      setTimeout(() => this.exportChart(ref, name), i * 400);
    });
  }

  // ── Stat helpers (template-facing) ────────────────────────────────────────

  fmt(v: number | null | undefined, dec = 1): string {
    if (v == null || !isFinite(v)) return '—';
    return v.toFixed(dec);
  }

  fmtSign(v: number | null | undefined, dec = 1): string {
    if (v == null || !isFinite(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(dec);
  }

  fmtPct(v: number | null | undefined): string {
    if (v == null || !isFinite(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  }

  biasClass(v: number | null | undefined): string {
    if (v == null) return '';
    const a = Math.abs(v);
    if (a < 5)  return 'good';
    if (a < 15) return 'warn';
    return 'bad';
  }

  get hasData():       boolean { return this.windows.length > 0; }
  get hasBothSeries(): boolean {
    return this.windows.some(w => w.rmssdPolar != null && w.rmssdFitbit != null);
  }
  get hasChart3(): boolean { return this.chart3Data.datasets.length > 0; }
  get hasChart4(): boolean { return this.chart4Data.datasets.length > 0; }
  get hasChart5(): boolean { return this.chart5Data.datasets.length > 0; }
  get hasChart6(): boolean { return this.chart6Data.datasets.length > 0; }

  // ── Private math ──────────────────────────────────────────────────────────

  private calcRMSSD(rr: number[]): number {
    if (rr.length < 2) return 0;
    const sq = [];
    for (let i = 1; i < rr.length; i++) sq.push((rr[i] - rr[i - 1]) ** 2);
    return Math.sqrt(sq.reduce((s, v) => s + v, 0) / sq.length);
  }

  private calcPNN50(rr: number[]): number {
    if (rr.length < 2) return 0;
    let n50 = 0;
    for (let i = 1; i < rr.length; i++) if (Math.abs(rr[i] - rr[i - 1]) > 50) n50++;
    return n50 / (rr.length - 1) * 100;
  }

  private mean(arr: number[]): number {
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  }

  private stdDev(arr: number[]): number {
    if (arr.length < 2) return 0;
    const m = this.mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
  }

  private median(arr: number[]): number {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  private linearRegression(x: number[], y: number[]): { slope: number; intercept: number } {
    const n = x.length;
    if (n < 2) return { slope: 1, intercept: 0 };
    const mx = this.mean(x), my = this.mean(y);
    const num = x.reduce((s, xi, i) => s + (xi - mx) * (y[i] - my), 0);
    const den = x.reduce((s, xi) => s + (xi - mx) ** 2, 0);
    const slope = den > 0 ? num / den : 1;
    return { slope, intercept: my - slope * mx };
  }

  private pearson(a: number[], b: number[]): number {
    const n = a.length;
    if (n < 2) return NaN;
    const ma = this.mean(a), mb = this.mean(b);
    const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / n;
    const sa  = Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0) / n);
    const sb  = Math.sqrt(b.reduce((s, v) => s + (v - mb) ** 2, 0) / n);
    return sa * sb > 0 ? cov / (sa * sb) : NaN;
  }

  private nearest<T extends { ts: Date }>(arr: T[], tMs: number, tol: number): T | null {
    let best: T | null = null, bestDt = Infinity;
    for (const item of arr) {
      const dt = Math.abs(item.ts.getTime() - tMs);
      if (dt < bestDt && dt <= tol) { bestDt = dt; best = item; }
    }
    return best;
  }

  private parseTs(s: string): Date {
    // Handles ISO with Z (UTC) or without Z (local)
    return new Date(s.trim());
  }

  private hhMM(d: Date): string {
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  private csvVal(v: number | null | undefined, dec = 2): string {
    return v != null && isFinite(v) ? v.toFixed(dec) : '';
  }

  private download(content: string, filename: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }
}

import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  PLATFORM_ID,
  ViewChild,
  inject,
} from "@angular/core";
import { CommonModule, isPlatformBrowser } from "@angular/common";
import { elapsed, finite, identityReference, nearestTimeIndex, pairedIndices, pairAt } from './chart-data';
import { CHART_BLUE, CHART_REFERENCE, TRACK_COLORS } from './chart-colors';
import { ReviewTrackComponent } from './review-track.component';
import { ReviewUrbanMapComponent } from './review-urban-map.component';
import { keyReviewMetrics, metricSampleContext } from './review-metrics';

const LABELS: Record<string, string> = {
  mae: "Error absoluto medio",
  rmse: "Raíz del error cuadrático medio",
  bias: "Sesgo",
  r: "Correlación de Pearson",
  ccc: "Concordancia de Lin",
  coverage_percent: "Cobertura",
  n: "Pares válidos",
  session_count: "Pruebas incluidas",
  n_epochs: "Épocas válidas",
  expected_epochs: "Épocas esperadas",
  agreement_percent: "Acuerdo",
  kappa: "Kappa",
  loa_l: "Límite de acuerdo inferior",
  loa_u: "Límite de acuerdo superior",
  loa_lower: "Límite de acuerdo inferior",
  loa_upper: "Límite de acuerdo superior",
  biasMean: "Sesgo RMSSD",
  lowerLoa: "Límite de acuerdo inferior",
  upperLoa: "Límite de acuerdo superior",
  polarHRMin: "FC mínima de referencia",
  fitbitHRMin: "FC mínima del dispositivo",
  polarHRMean: "FC media de referencia",
  fitbitHRMean: "FC media del dispositivo",
  polarRmssdMean: "RMSSD media de referencia",
  fitbitRmssdMean: "RMSSD media del dispositivo",
  rmssdMAE: "Error absoluto medio RMSSD",
  hrMAE: "Error absoluto medio FC",
  pearsonR: "Correlación RMSSD",
  pearsonRHR: "Correlación FC",
};
@Component({
  selector: "app-review-evidence",
  standalone: true,
  imports: [CommonModule, ReviewTrackComponent, ReviewUrbanMapComponent],
  template: ` <figure *ngIf="evidence as e">
    <div class="aggregate-summary" *ngIf="e.kind==='fc_total'">
      <strong>{{e.session_count}} {{e.session_count === 1 ? 'prueba' : 'pruebas'}}{{e.sport_label ? ' de ' + e.sport_label : ''}} · correlación conjunta</strong>
      <p>{{totalPairs | number:'1.0-0'}} pares guardados. Incluye cada prueba completa; los recortes de las curvas temporales no modifican este resultado.</p>
    </div>
    <div class="chart-tools" *ngIf="isTimeChart && ready">
      <div class="range-buttons" role="group" aria-label="Intervalo visible de la gráfica">
        <button *ngFor="let minutes of [0,5,15]" (click)="setRange(minutes)" [attr.aria-pressed]="rangeMinutes===minutes" [disabled]="minutes>0 && duration<=minutes*60">{{minutes ? minutes+' min' : 'Sesión completa'}}</button>
      </div>
      <label *ngIf="rangeMinutes" class="range-slider">Desplazar intervalo · {{clock(windowStart)}}–{{clock(windowEnd)}}
        <input type="range" aria-label="Inicio del intervalo visible" [min]="firstTime" [max]="lastTime-rangeMinutes*60" step="1" [value]="windowStart" (input)="moveWindow($any($event.target).value)">
      </label>
    </div>
    <div class="point-reading" *ngIf="isTimeChart && ready" role="status" aria-label="Lectura del punto seleccionado" aria-live="polite" aria-atomic="true">
      <span><small>Tiempo</small><strong>{{reading ? clock(reading.time) : '—'}}</strong></span>
      <span><small>Dispositivo</small><strong>{{reading ? value(reading.device) : '—'}} <small *ngIf="reading?.device != null">{{displayUnit}}</small></strong></span>
      <span><small>Referencia</small><strong>{{reading ? value(reading.reference) : '—'}} <small *ngIf="reading?.reference != null">{{displayUnit}}</small></strong></span>
      <span class="difference"><small>Dispositivo − referencia</small><strong>{{reading ? signed(reading.difference) : '—'}} <small *ngIf="reading?.difference != null">{{displayUnit}}</small></strong></span>
    </div>
    <div
      #plot
      class="plot"
      [class.track-plot]="isTrack"
      [class.urban-plot]="kind==='map' && !isTrack"
      [class.scatter-plot]="kind==='scatter'"
      [hidden]="kind === 'table'"
      [attr.aria-label]="title || 'Visualización de resultados'"
    >
      <canvas
        #canvas
        [hidden]="kind === 'map'"
        role="img"
        [attr.tabindex]="isTimeChart ? 0 : null"
        (keydown)="stepPoint($event)"
        [attr.aria-label]="(title || 'Gráfica') + (isTimeChart ? '. Usa las flechas para seleccionar un instante; valores y diferencia encima de la gráfica.' : '; resultados numéricos debajo')"
      ></canvas>
      <app-review-urban-map *ngIf="kind==='map' && !isTrack && loaded" [tracks]="loaded.tracks || []" />
      <app-review-track *ngIf="isTrack && loaded" [tracks]="loaded.tracks || []" />
      <p *ngIf="!ready && !error" class="loading">
        La visualización se carga al acercarte a esta sección.
      </p>
    </div>
    <ng-container *ngIf="isTimeChart && ready">
      <p class="chart-help">{{kind==='temporal' ? 'El relleno muestra la separación entre reloj y referencia.' : 'Diferencia del reloj respecto a la referencia.'}} Mueve la línea discontinua con el cursor, toca la gráfica o usa las flechas: la lectura aparece arriba.</p>
      <p class="chart-help">Vista: {{clock(windowStart)}}–{{clock(windowEnd)}}. Las métricas mantienen el intervalo del análisis original.</p>
    </ng-container>
    <p *ngIf="kind==='scatter' && ready" class="chart-help identity-help">La línea discontinua y = x indica coincidencia exacta. Por encima, el reloj mide más; por debajo, menos. La correlación no equivale a acuerdo.</p>
    <details *ngIf="e.kind==='fc_total'" class="aggregate-sources"><summary>Ver las {{e.session_count}} pruebas incluidas</summary><ul><li *ngFor="let s of e.sessions"><strong>{{s.name}}</strong> · {{s.date | date:'dd/MM/yyyy'}} · {{s.n | number:'1.0-0'}} pares</li></ul></details>
    <p *ngIf="error" role="alert">
      {{ error }} <button type="button" (click)="load()">Reintentar</button>
    </p>
    <div class="metric-highlights" *ngIf="kind!=='table' && highlights.length">
      <div *ngFor="let m of highlights"><small>{{label(m.key)}}</small><strong>{{m.value | number:'1.0-3'}} <span>{{m.unit==='bpm' ? 'lpm' : m.unit}}</span></strong></div>
    </div>
    <div class="key-metrics" *ngIf="kind==='table'">
      <table *ngIf="keyMetrics.length; else noKeyMetrics">
        <caption>
          <strong>Resultados clave</strong>
          <span>{{e.kind==='fc_total' ? 'Conjunto de pruebas de este deporte' : 'Resumen del análisis completo'}}</span>
        </caption>
        <thead>
          <tr>
            <th scope="col">Métrica</th>
            <th scope="col">Resultado</th>
          </tr>
        </thead>
        <tbody>
          <tr *ngFor="let m of keyMetrics" [attr.data-metric]="m.key">
            <th scope="row"><span>{{m.label}}</span><small>{{m.description}}</small></th>
            <td><strong>{{m.value}}</strong><span *ngIf="m.unit">{{m.unit}}</span></td>
          </tr>
        </tbody>
      </table>
      <ng-template #noKeyMetrics><p class="chart-help">Sin métricas clave disponibles para esta prueba.</p></ng-template>
      <p class="metric-context" *ngIf="sampleContext">{{sampleContext}} · Valores del intervalo analizado, sin recalcular.</p>
    </div>
    <div class="table" *ngIf="e.confusion_matrix?.classes?.length">
      <table>
        <caption>
          Matriz de sueño · filas: referencia; columnas: dispositivo
        </caption>
        <thead>
          <tr>
            <th>Referencia / dispositivo</th>
            <th *ngFor="let c of e.confusion_matrix.classes">{{ c }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            *ngFor="
              let row of e.confusion_matrix.confusion_matrix;
              let i = index
            "
          >
            <th scope="row">{{ e.confusion_matrix.classes[i] }}</th>
            <td *ngFor="let n of row">{{ n }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <figcaption>
      {{ e.name }} · {{ e.sport }}
      <span *ngIf="e.date">· {{ e.date | date: "dd/MM/yyyy" }}</span
      ><br />Referencia: {{ e.reference || "Indicada en la leyenda" }} · Unidad:
      {{ e.unit || "Según métrica" }}<br />{{ e.limitations }}<br /><small
        >Revisión {{ e.revision?.slice(0, 12) }} · Motor
        {{ e.analysis_version || "Histórico" }} · Elegibilidad para rankings sin
        evaluar</small
      >
    </figcaption>
  </figure>`,
  styles: [
    `
      figure {
        margin: 1.5rem 0;
        border: 1px solid var(--line,#e3e3e3);
        padding: 20px;
        background: var(--surface,#fff);
      }
      .plot {
        height: 400px;
        position: relative;
        min-width: 0;
      }
      .plot canvas {max-width:100%}
      .plot.urban-plot {height:auto;min-height:400px}
      .plot.track-plot {height:auto;min-height:320px}
      .plot.scatter-plot {width:100%;max-width:560px;height:auto;aspect-ratio:1;margin-inline:auto}
      .scatter-plot canvas {position:absolute;inset:0;width:100%!important;height:100%!important}
      .loading {
        position: absolute;
        inset: 40% 10%;
        text-align: center;
        color: var(--ink-3);
      }
      .table {
        overflow: auto;
        margin: 1rem 0;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      td,
      th {
        text-align: left;
        padding: 10px;
        border-bottom: 1px solid var(--line, #ddd);
      }
      td,
      thead th {
        white-space: nowrap;
        overflow-wrap: normal;
      }
      caption {
        text-align: left;
        font-weight: 600;
        padding: 10px 0;
      }
      figcaption {
        font-size: 0.85rem;
        color: var(--ink-3, #666);
        line-height: 1.6;
      }
      button {
        padding: 8px 16px;
      }
      .chart-tools {margin-bottom:18px;display:grid;gap:12px}
      .range-buttons {display:flex;flex-wrap:wrap;gap:6px}
      .range-buttons button {background:var(--surface,#fff);border:1px solid var(--line,#ddd);font:inherit;font-size:12px;cursor:pointer;color:var(--ink,#161616)}
      .range-buttons button[aria-pressed=true] {background:#161616;color:#fff;border-color:#161616}
      .range-buttons button:disabled {opacity:.45;cursor:default}
      .range-slider {display:grid;gap:6px;font-size:12px;color:var(--ink-3,#505050)}
      .range-slider input {width:100%;accent-color:#4295de}
      .chart-help {font-size:12px;line-height:1.6;color:var(--ink-3,#505050)}
      .aggregate-summary {font-size:14px;margin-bottom:18px}
      .aggregate-summary p,.aggregate-sources {font-size:12px;line-height:1.6;color:var(--ink-3,#505050)}
      .aggregate-sources {margin:16px 0}.aggregate-sources summary{cursor:pointer;font-weight:500}.aggregate-sources li{margin:6px 0}
      .point-reading {display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:14px 16px;margin-bottom:16px;background:var(--surface-2,#f7f7f7);min-height:76px;border-top:1px solid var(--line,#e3e3e3);border-bottom:1px solid var(--line,#e3e3e3)}
      .point-reading>span {display:grid;align-content:start;gap:6px;min-width:0}
      .point-reading small {font-size:11px;color:var(--ink-3,#505050)}
      .point-reading>span>small {min-height:2.5em;line-height:1.25}
      .point-reading strong {font-size:18px;line-height:1.4;font-variant-numeric:tabular-nums;white-space:nowrap}
      .point-reading strong small {font-size:11px;font-weight:400}
      .point-reading .difference strong {color:#256ca6}
      .metric-highlights {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));gap:12px;margin:20px 0}
      .metric-highlights>div {display:grid;gap:8px;padding:14px;background:var(--surface-2,#f7f7f7)}
      .metric-highlights small {font-size:11px;color:var(--ink-3,#505050)}
      .metric-highlights strong {font-size:24px;line-height:1.3;font-variant-numeric:tabular-nums}
      .metric-highlights strong span {font-size:12px;font-weight:400}
      .key-metrics {margin:0 0 18px;min-width:0}
      .key-metrics table {table-layout:fixed}
      .key-metrics caption {padding:0 0 20px}
      .key-metrics caption strong {display:block;font-size:20px;letter-spacing:-.025em;color:var(--ink,#161616)}
      .key-metrics caption span {display:block;font-size:12px;line-height:1.5;font-weight:400;color:var(--ink-3,#505050);margin-top:6px}
      .key-metrics thead th {background:var(--surface-2,#f7f7f7);font-size:11px;font-weight:500;padding:10px 14px;color:var(--ink-3,#505050)}
      .key-metrics thead th:last-child {width:31%;text-align:right}
      .key-metrics tbody th,.key-metrics td {padding:18px 14px;vertical-align:middle}
      .key-metrics tbody th {font-size:14px;font-weight:500;line-height:1.5}
      .key-metrics tbody th small {display:block;font-weight:400;font-size:12px;line-height:1.6;margin-top:4px;color:var(--ink-3,#505050);overflow-wrap:normal}
      .key-metrics td {text-align:right;white-space:normal;font-variant-numeric:tabular-nums}
      .key-metrics td strong {font-size:23px;font-weight:600;white-space:nowrap;line-height:1.4;letter-spacing:-.025em}
      .key-metrics td>span {display:inline-block;margin-left:5px;font-size:12px;color:var(--ink-3,#505050)}
      .key-metrics tbody tr:first-child {background:#f0f7ff}
      .key-metrics tbody tr:first-child td strong {color:#256ca6}
      .metric-context {font-size:11px;line-height:1.6;color:var(--ink-3,#505050);margin:12px 0 0}
      @container review (max-width:420px){.key-metrics thead th,.key-metrics tbody th,.key-metrics td{padding:12px 8px}.key-metrics td strong{font-size:20px}.key-metrics tbody th{font-size:13px}.key-metrics tbody th small{font-size:11px}.key-metrics caption strong{font-size:18px}}
      @container review (max-width:600px){figure{padding:12px}.plot,.map{height:320px}.point-reading{grid-template-columns:repeat(2,minmax(0,1fr));padding:12px;gap:14px}.point-reading>span>small{min-height:1.25em}td,th{padding:8px;font-size:12px}}
      small {
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class ReviewEvidenceComponent
  implements AfterViewInit, OnChanges, OnDestroy
{
  @Input() evidence: any;
  @Input() title = "";
  @Input() evidenceUrl = "";
  @ViewChild("plot") plot?: ElementRef<HTMLElement>;
  @ViewChild("canvas") canvas?: ElementRef<HTMLCanvasElement>;
  private platform = inject(PLATFORM_ID);
  private cd = inject(ChangeDetectorRef);
  private observer?: IntersectionObserver;
  private resize?: ResizeObserver;
  private chart: any;
  private destroyed = false;
  private generation = 0;
  private started = false;
  loaded: any;
  ready = false;
  error = "";
  rangeMinutes = 0;
  windowStart = 0;
  reading: ReturnType<typeof pairAt> | null = null;
  private pointIndex = -1;
  clock = elapsed;
  get isTimeChart():boolean { return ['temporal','error'].includes(this.kind); }
  get isTrack():boolean {return this.kind==='map' && (this.evidence?.kind || this.evidence?.configuration?.kind)==='gps';}
  get totalPairs():number {return this.metricRows.find(m=>m.key==='n')?.value || 0;}
  get firstTime():number { return this.loaded?.time?.[0] ?? 0; }
  get lastTime():number { return this.loaded?.time?.at(-1) ?? 0; }
  get duration():number { return this.lastTime-this.firstTime; }
  get windowEnd():number { return this.rangeMinutes ? Math.min(this.lastTime,this.windowStart+this.rangeMinutes*60) : this.lastTime; }
  get displayUnit():string { return this.loaded?.unit==='bpm' ? 'lpm' : this.loaded?.unit || ''; }
  value(n:number|null):string { return n==null ? 'Sin dato' : n.toLocaleString('es-ES',{maximumFractionDigits:1}); }
  signed(n:number|null):string { return n==null ? 'Sin par' : (n>0?'+':'')+this.value(n); }
  setRange(minutes:number):void {
    this.rangeMinutes=minutes;
    this.windowStart=minutes ? Math.max(this.firstTime,Math.min(this.reading?.time ?? this.windowStart,this.lastTime-minutes*60)) : this.firstTime;
    this.refreshLines();
  }
  moveWindow(value:string):void {this.windowStart=Number(value);this.refreshLines();}
  private lineDatasets(e:any):any[] {
    const budget=Math.max(300,Math.min(1600,Math.round((this.plot?.nativeElement.clientWidth || 800)*1.3)));
    const indices=pairedIndices(e.time,e.series,this.windowStart,this.windowEnd,budget);
    const visible=e.series.filter((s:any)=>this.kind!=='error'||s.role==='device');
    const refIndex=visible.findIndex((s:any)=>s.role==='reference');
    return visible.map((s:any)=>({
      label:s.name,
      role:s.role,
      data:indices.map(i=>({x:e.time[i],y:(this.kind==='error'?s.errors:s.values)?.[i]??null,sourceIndex:i})),
      borderColor:s.role==='reference'?CHART_REFERENCE:CHART_BLUE,
      backgroundColor:'rgba(66,149,222,0.13)',
      fill:this.kind==='temporal'&&s.role==='device'&&refIndex>=0 ? {target:refIndex,above:'rgba(66,149,222,0.20)',below:'rgba(66,149,222,0.11)'} : false,
      borderDash:s.role==='reference'?[5,3]:[],borderWidth:s.role==='reference'?1.2:1.5,
      pointRadius:0,pointHoverRadius:0,pointHitRadius:8,pointStyle:'line',spanGaps:false,tension:0,
    }));
  }
  private refreshLines():void {
    if(!this.chart||!this.loaded)return;
    const selectedTime=this.reading?.time ?? this.windowStart;
    this.chart.data.datasets=this.lineDatasets(this.loaded);
    this.chart.options.scales.x.min=this.windowStart;this.chart.options.scales.x.max=this.windowEnd;
    this.readPoint(nearestTimeIndex(this.loaded.time,selectedTime,this.windowStart,this.windowEnd));
    this.chart.setActiveElements([]);this.chart.update('none');
  }
  private readPoint(index:number):void {this.pointIndex=index;this.reading=index>=0?pairAt(this.loaded,index):null;this.cd.markForCheck();}
  private timeCursorPlugin():any {
    return {
      id:'review-time-cursor',
      afterEvent:(chart:any,args:any)=>{
        if(!this.isTimeChart || !args.inChartArea || args.replay || args.event.type==='mouseout')return;
        const time=chart.scales.x.getValueForPixel(args.event.x);
        const index=nearestTimeIndex(this.loaded.time,time,this.windowStart,this.windowEnd);
        if(index!==this.pointIndex){this.readPoint(index);args.changed=true;}
      },
      afterDatasetsDraw:(chart:any)=>{
        if(!this.isTimeChart || !this.reading)return;
        const {ctx,chartArea:area,scales}=chart;
        const x=scales.x.getPixelForValue(this.reading.time);
        if(x<area.left || x>area.right)return;
        ctx.save();ctx.beginPath();ctx.rect(area.left,area.top,area.width,area.height);ctx.clip();
        ctx.beginPath();ctx.setLineDash([5,4]);ctx.lineWidth=1;ctx.strokeStyle='#64748b';
        ctx.moveTo(x,area.top);ctx.lineTo(x,area.bottom);ctx.stroke();ctx.setLineDash([]);
        chart.data.datasets.forEach((dataset:any,i:number)=>{
          if(!chart.isDatasetVisible(i))return;
          const value=this.kind==='error'?this.reading!.difference:dataset.role==='reference'?this.reading!.reference:this.reading!.device;
          if(!finite(value))return;
          ctx.beginPath();ctx.arc(x,scales.y.getPixelForValue(value),3.5,0,Math.PI*2);
          ctx.fillStyle=dataset.borderColor;ctx.fill();ctx.lineWidth=1.5;ctx.strokeStyle='#fff';ctx.stroke();
        });
        ctx.restore();
      },
    };
  }
  stepPoint(event:KeyboardEvent):void {
    if(!this.isTimeChart||!this.chart||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const time=this.loaded.time;
    const first=nearestTimeIndex(time,this.windowStart,this.windowStart,this.windowEnd),last=nearestTimeIndex(time,this.windowEnd,this.windowStart,this.windowEnd);
    if(first<0)return;
    const index=event.key==='Home'?first:event.key==='End'?last:Math.max(first,Math.min(last,this.pointIndex+(event.key==='ArrowLeft'?-1:1)));
    this.readPoint(index);this.chart.setActiveElements([]);this.chart.draw();
  }
  get kind(): string {
    return this.evidence?.configuration?.visualization || "table";
  }
  get metricRows(): any[] {
    return this.evidence?.summary_metrics || this.evidence?.metrics || [];
  }
  get highlights():any[] {
    return [['mae','rmssdMAE','hrMAE'],['bias','biasMean'],['r','pearsonR','pearsonRHR']]
      .map(keys=>this.metricRows.find(m=>keys.includes(m.key)&&m.value!=null)).filter(Boolean);
  }
  get keyMetrics() { return keyReviewMetrics(this.evidence); }
  get sampleContext():string { return metricSampleContext(this.evidence); }
  label(key: string): string {
    return LABELS[key] || key.replace(/_/g, " ");
  }
  color(i: number): string {
    return TRACK_COLORS[i % TRACK_COLORS.length];
  }
  ngOnChanges(): void {
    this.generation++;
    this.started = false;
    this.ready = false;
    this.loaded = null;
    this.reading=null;this.rangeMinutes=0;this.pointIndex=-1;
    this.dispose();
    if (this.plot && isPlatformBrowser(this.platform))
      queueMicrotask(() => this.watch());
  }
  ngAfterViewInit(): void {
    if (isPlatformBrowser(this.platform)) this.watch();
  }
  private watch(): void {
    this.observer?.disconnect();
    if (this.kind === "table" || !this.plot) return;
    if (typeof IntersectionObserver === "undefined") {
      void this.load();
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          this.observer?.disconnect();
          void this.load();
        }
      },
      { rootMargin: "300px" },
    );
    this.observer.observe(this.plot.nativeElement);
  }
  async load(): Promise<void> {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.error = "";
    const gen = this.generation;
    try {
      let e = this.evidence;
      if (e.deferred) {
        const response = await fetch(this.evidenceUrl, {
          credentials: "omit",
          cache: "no-store",
        });
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "La publicación ha cambiado o se ha retirado. Recarga el artículo."
              : "No se pudo cargar la visualización.",
          );
        e = (await response.json()).evidence;
      }
      if (this.destroyed || gen !== this.generation) return;
      this.loaded = e;
      this.windowStart=this.firstTime;
      if (this.isTrack) {
        // The shared SVG uses the same track geometry as the local analysis.
      } else if (this.kind === "map") {
        // The shared urban map owns its lazy map engine and route controls.
      } else {
        const { Chart } = await import("chart.js/auto");
        if (this.destroyed || gen !== this.generation) return;
        const unit = e.unit || "";
        let datasets: any[] = [];
        let identity:ReturnType<typeof identityReference>=null;
        let xLabel = "Tiempo (s)",
          yLabel = unit;
        if (this.kind === "distribution") {
          datasets = [
            {
              label: "Error absoluto acumulado",
              data: e.distribution,
              borderColor: this.color(0),
              pointRadius: 0,
              pointStyle:'line',
              showLine: true,
            },
          ];
          xLabel = "Error absoluto (" + unit + ")";
          yLabel = "Pares (%)";
        } else if (["scatter", "bland_altman"].includes(this.kind)) {
          const ref =
              e.series.find((s: any) => s.role === "reference")?.values || [],
            dev = e.series.find((s: any) => s.role === "device")?.values || [];
          const points = ref.flatMap((r: any, i: number) =>
            !finite(r) || !finite(dev[i])
              ? []
              : [
                  this.kind === "scatter"
                    ? { x: r, y: dev[i], sourceIndex:i }
                    : { x: (r + dev[i]) / 2, y: dev[i] - r },
                ],
          );
          // Chart.js parsing:false requires ascending x for reliable point hit testing.
          points.sort((a:any,b:any)=>a.x-b.x || a.y-b.y);
          datasets = [
            {
              label: e.kind==='fc_total' ? 'Pares de las '+e.session_count+' pruebas' : "Pares de medidas",
              data: points,
              backgroundColor: 'rgba(66,149,222,0.38)',
              borderColor: CHART_BLUE,
              borderWidth:.5,
              pointStyle:'circle',
              pointRadius: e.kind==='fc_total' ? 1.6 : 2,
              pointHoverRadius: 4,
              order:1,
            },
          ];
          xLabel =
            (this.kind === "scatter" ? "Referencia" : "Media del par") +
            " (" +
            this.displayUnit +
            ")";
          yLabel =
            (this.kind === "scatter" ? "Dispositivo" : "Diferencia") +
            " (" +
            this.displayUnit +
            ")";
          if(this.kind==='scatter'){
            identity=identityReference(points);
            if(identity)datasets.push({
              label:'Referencia · y = x',data:identity.data,showLine:true,
              borderColor:CHART_REFERENCE,backgroundColor:CHART_REFERENCE,
              borderWidth:2,borderDash:[7,5],pointRadius:0,pointHoverRadius:0,
              pointHitRadius:0,pointStyle:'line',order:0,
            });
          }
          if (this.kind === "bland_altman" && points.length) {
            const xs = points.map((p: any) => p.x);
            for (const m of e.metrics || []) {
              if (m.value != null)
                datasets.push({
                  label: this.label(m.key),
                  data: [
                    { x: Math.min(...xs), y: m.value },
                    { x: Math.max(...xs), y: m.value },
                  ],
                  showLine: true,
                  borderColor: CHART_REFERENCE,
                  pointRadius: 0,
                  pointStyle:'line',
                  borderWidth:1.5,
                  order:0,
                  borderDash: [4, 4],
                });
            }
          }
        } else {
          datasets = this.lineDatasets(e);
          xLabel='Tiempo transcurrido';yLabel=this.displayUnit;
        }
        this.chart = new Chart(this.canvas!.nativeElement, {
          type: ["scatter", "bland_altman"].includes(this.kind)
            ? "scatter"
            : "line",
          data: { datasets },
          plugins:[this.timeCursorPlugin()],
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            interaction: {mode:this.isTimeChart?'index':'nearest',intersect:!this.isTimeChart,axis:this.isTimeChart?'x':'xy'},
            scales: {
              x: { type: "linear", ...(identity?{min:identity.min,max:identity.max}:{}),title: { display: true, text: xLabel }, grid:{display:this.kind==='scatter',color:'#edf0f4'}, ticks:{maxTicksLimit:7,maxRotation:0,...(this.isTimeChart?{callback:(v:any)=>elapsed(Number(v))}:{})} },
              y: { ...(identity?{min:identity.min,max:identity.max}:{}),title: { display: true, text: yLabel },grid:{color:'#edf0f4'},ticks:{maxTicksLimit:6} },
            },
            plugins: {
              legend: { display: true,position:'bottom',labels:{usePointStyle:true,boxWidth:24,padding:18,font:{size:11}} },
              filler:{propagate:false},
              tooltip: {enabled:!this.isTimeChart,backgroundColor:'#161616',padding:12,displayColors:true,
                ...(this.kind==='scatter' ? {filter:(item:any)=>item.datasetIndex===0,callbacks:{
                  title:(items:any[])=>{
                    const i=items[0]?.raw.sourceIndex;
                    const session=e.sessions?.find((s:any)=>i>=s.point_start&&i<s.point_start+s.display_n);
                    return session?.name || 'Par de medidas';
                  },
                  label:(item:any)=>['Referencia: '+this.value(item.parsed.x)+' '+this.displayUnit,'Dispositivo: '+this.value(item.parsed.y)+' '+this.displayUnit],
                  footer:(items:any[])=>items.length?'Dispositivo − referencia: '+this.signed(items[0].parsed.y-items[0].parsed.x)+' '+this.displayUnit:'',
                }} : {})
              }
            },
          },
        });
        if(this.isTimeChart){
          this.refreshLines();
          this.resize=new ResizeObserver(()=>{this.refreshLines();this.cd.markForCheck();});
          this.resize.observe(this.plot!.nativeElement);
        }
      }
      this.ready = true;
    } catch (err) {
      this.error =
        err instanceof Error
          ? err.message
          : "No se pudo cargar la visualización";
      this.started = false;
    } finally {
      this.cd.markForCheck();
    }
  }
  private dispose(): void {
    this.chart?.destroy();
    this.chart = null;
    this.resize?.disconnect();
  }
  ngOnDestroy(): void {
    this.destroyed = true;
    this.generation++;
    this.observer?.disconnect();
    this.dispose();
  }
}

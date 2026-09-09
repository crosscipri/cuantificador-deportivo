import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { ComparisonSeries, deviceColor } from '../../models/comparison.model';
import { downloadCanvasPng, downloadCanvasFramePng, withHighResolutionChartExport } from '../chart-export';

@Component({
  selector: 'app-comparison-chart', standalone: true, imports: [CommonModule, BaseChartDirective],
  template: `<div class="chart" [class.expanded]="fullscreen">
    <div class="controls"><strong>{{title}}</strong><span></span>
      <button type="button" (click)="zoom(0.5)">Zoom +</button><button type="button" (click)="zoom(2)">Zoom −</button>
      <button type="button" (click)="pan(-1)">←</button><button type="button" (click)="pan(1)">→</button>
      <button type="button" (click)="reset()">Restablecer</button>
      <button type="button" (click)="fullscreen = !fullscreen">{{fullscreen ? 'Salir' : 'Pantalla completa'}}</button>
      <button type="button" (click)="download()">PNG</button>
      <button type="button" (click)="download(1920)">PNG 1080p</button><button type="button" (click)="download(3840)">PNG 4K</button>
      <button *ngIf="allowInterval" type="button" (click)="rangeMode=!rangeMode;rangeStart=null">{{rangeMode?'Cancelar selección':'Seleccionar intervalo'}}</button>
    </div><div class="canvas"><canvas baseChart [data]="data" [options]="options" [plugins]="chartPlugins" [type]="'line'"></canvas></div>
    <small>{{rangeMode?'Pulsa dos instantes para recalcular ese intervalo.':timeCaption}}</small>
  </div>`,
  styles: [`.chart{background:var(--surface);padding:1rem;border:1px solid var(--line);border-radius:var(--r-md)}
    .controls{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem}.controls span{flex:1}
    button{background:var(--surface-2);border:1px solid var(--line);border-radius:4px;padding:.35rem .55rem;color:var(--ink);cursor:pointer}
    .canvas{height:390px}.expanded{position:fixed;inset:1rem;z-index:1500;overflow:auto}.expanded .canvas{height:75vh}
    small{color:var(--ink-3)}`],
})
export class ComparisonChartComponent implements OnChanges {
  @Input() time: number[] = [];
  @Input() series: ComparisonSeries[] = [];
  @Input() hidden: string[] = [];
  @Input() error = false;
  @Input() absoluteError=false;
  @Input() timeCaption='Tiempo desde el inicio de la ventana común · Las discontinuidades indican datos ausentes.';
  @Input() band = 0;
  @Input() title = 'Frecuencia cardíaca';
  @Input() unit = 'bpm';
  @Input() yMin: number | undefined;
  @Input() yMax: number | undefined;
  @Input() cursorTime:number|null=null;
  @Input() allowInterval=false;
  @Output() cursor = new EventEmitter<number>();
  @Output() interval = new EventEmitter<{start:number;end:number}>();
  @ViewChild(BaseChartDirective) chart?: BaseChartDirective;
  fullscreen = false;
  rangeMode=false;rangeStart:number|null=null;
  chartPlugins = [{id:'comparisonCrosshair',afterDraw:(chart:any)=>{
    const active=chart.tooltip?.getActiveElements();if(this.cursorTime==null&&!active?.length)return;
    const x=this.cursorTime!=null?chart.scales.x.getPixelForValue(this.cursorTime):active[0].element.x,ctx=chart.ctx;
    if(x<chart.chartArea.left||x>chart.chartArea.right)return;
    ctx.save();ctx.strokeStyle='#9ca3af';ctx.setLineDash([3,3]);ctx.beginPath();
    ctx.moveTo(x,chart.chartArea.top);ctx.lineTo(x,chart.chartArea.bottom);ctx.stroke();ctx.restore();
  }}];
  data: ChartConfiguration<'line'>['data'] = { datasets: [] };
  options: ChartOptions<'line'> = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    onHover: (_event, active) => { const point=active[0];if(point&&this.time[point.index]!=null)this.cursor.emit(this.time[point.index]); },
    onClick:(event,_active,chart)=>{if(!this.rangeMode||event.x==null)return;const value=chart.scales['x'].getValueForPixel(event.x);if(value==null)return;
      const t=Math.round(Math.max(this.time[0],Math.min(this.time[this.time.length-1],value))*1000)/1000;
      if(this.rangeStart==null)this.rangeStart=t;else if(t!==this.rangeStart){this.interval.emit({start:Math.min(t,this.rangeStart),end:Math.max(t,this.rangeStart)});this.rangeMode=false;this.rangeStart=null;}},
    scales: { x: { type: 'linear', title: {display:true, text:'Tiempo (s)'} }, y: {title:{display:true,text:'bpm'}} },
    plugins: { legend: {display: true}, tooltip: { callbacks: {
      title: items => `${Number(items[0]?.parsed.x ?? 0).toLocaleString('es-ES',{maximumFractionDigits:3})} s`,
      label: ctx => {
        const value = ctx.parsed.y;
        const ref = this.series.find(s => s.role === 'reference')?.values[ctx.dataIndex];
        const source = this.series.filter(s=>!this.error || s.role==='device')[ctx.datasetIndex];
        const delta = !this.error && source?.role === 'device' && value != null && ref != null ? ` · Δ ${(value-ref)>0?'+':''}${(value-ref).toFixed(1)}` : '';
        return `${ctx.dataset.label}: ${value == null ? 'NO DATA' : value.toFixed(1)+' '+this.unit}${delta}`;
      },
    }}},
  };
  ngOnChanges(changes:SimpleChanges): void {
    if(Object.keys(changes).every(k=>k==='cursorTime')){this.chart?.chart?.draw();return;}
    this.options={...this.options,scales:{...this.options.scales,y:{...this.options.scales?.['y'],min:this.yMin,max:this.yMax,title:{display:true,text:this.unit}}}};
    this.data = { datasets: this.series.filter(s=> !this.error || s.role==='device').map(s=>({
      label: s.name, data: this.time.map((t,i)=>{const value=(this.error?s.errors:s.values)?.[i]??null;return {x:t,y:value!=null&&this.error&&this.absoluteError?Math.abs(value):value};}) as any,
      hidden: this.hidden.includes(s.id), borderColor: s.role==='reference'?'#18181b':deviceColor(s.device_id||s.id),
      borderDash: s.role==='reference'?[7,3]:[], borderWidth:s.role==='reference'?2.8:1.6,
      tension:0, spanGaps:false, pointRadius:0, pointHitRadius:8,
    })) };
    if (this.error) {
      for (const level of this.band ? (this.absoluteError?[0,this.band]:[-this.band, 0, this.band]) : [0]) {
        this.data.datasets.push({label: `${level} ${this.unit}`, data:this.time.map(t=>({x:t,y:level})),
          pointRadius:0,borderWidth:1,borderColor:'#a1a1aa',borderDash:[4,4]});
      }
    }
  }
  zoom(factor: number): void {
    const scale = this.chart?.chart?.scales['x'];
    if (!scale || !this.time.length) return;
    const center=(scale.min+scale.max)/2, half=(scale.max-scale.min)*factor/2;
    this.setWindow(Math.max(this.time[0],center-half),Math.min(this.time[this.time.length-1],center+half));
  }
  pan(direction: number): void {
    const scale=this.chart?.chart?.scales['x'];
    if (!scale || !this.time.length) return;
    const width=scale.max-scale.min, min=Math.max(this.time[0],Math.min(this.time[this.time.length-1]-width,scale.min+direction*width/4));
    this.setWindow(min,min+width);
  }
  setWindow(min: number,max: number): void {
    this.options={...this.options,scales:{...this.options.scales,x:{...this.options.scales?.['x'],min,max}}};
  }
  reset(): void { if(this.time.length) this.setWindow(this.time[0],this.time[this.time.length-1]); }
  download(width?:number): void {
    const chart=this.chart?.chart;
    if(chart) withHighResolutionChartExport(chart,canvas=>width?downloadCanvasFramePng(canvas,width,width*9/16,`comparativa-${width}.png`,this.title):downloadCanvasPng(canvas,`${this.error?'error':'fc'}-comparativa.png`));
  }
}

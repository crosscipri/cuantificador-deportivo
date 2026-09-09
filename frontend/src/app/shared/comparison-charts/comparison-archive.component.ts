import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration,ChartOptions } from 'chart.js';
import { ComparisonChartComponent } from './comparison-chart.component';
import { ComparisonMapComponent } from './comparison-map.component';
import { ComparisonGpsTrack,ComparisonSeries,deviceColor } from '../../models/comparison.model';

interface ArchiveSource {id:string;device_id:string;device_name:string;name:string;source_url:string;}
interface ArchiveResult {
  configuration:any;unit:string;warnings:string[];metric_keys:string[];time?:number[];series?:ComparisonSeries[];tracks?:ComparisonGpsTrack[];
  rows:(ArchiveSource&{metrics:Record<string,number|null>;analysis_revision_id?:string})[];
  groups:{device_id:string;device_name:string;n_sources:number;n_sessions:number;metrics:Record<string,{n:number;mean:number|null;median:number|null;sd:number|null;iqr:number|null;min:number|null;max:number|null}>}[];
  statistics?:{id:string;name:string;unit:string}[];
}

@Component({selector:'app-comparison-archive',standalone:true,imports:[CommonModule,FormsModule,RouterModule,BaseChartDirective,ComparisonChartComponent,ComparisonMapComponent],
 template:`<section class="panel"><h2>Comparar el histórico GPS y nocturno</h2><p>Reutiliza los runs y ventanas ya guardados, con acceso a su análisis original.</p><p role="alert">{{message}}</p>
 <fieldset [disabled]="busy"><div class="fields"><label>Datos<select [(ngModel)]="selection.domain" (ngModelChange)="domainChanged()"><option value="GPS_TRACK">GPS de pista</option><option value="GPS_URBAN">GPS urbano</option><option value="NIGHT_RMSSD">RMSSD nocturno · ventanas 5 min</option><option value="NIGHT_HR">FC nocturna · ventanas 5 min</option></select></label>
 <label>Modo<select [(ngModel)]="selection.mode" (ngModelChange)="result=null"><option value="BENCHMARK">Benchmark de resultados por sesión</option><option value="DIRECT">Direct: misma prueba o noche</option></select></label><label>Nombre<input [(ngModel)]="selection.name" (ngModelChange)="result=null"></label><label>Filtrar dispositivo<select [(ngModel)]="deviceFilter"><option value="">Todos</option><option *ngFor="let d of devices" [value]="d.id">{{d.name}}</option></select></label></div>
 <div class="sources"><label *ngFor="let s of visibleSources"><input type="checkbox" [checked]="selection.source_ids.includes(s.id)" (change)="toggle(s.id)"> {{s.device_name}} · {{s.name}}</label></div><button *ngIf="hasMore" (click)="loadMore()">Más fuentes</button>
 <p>{{selection.source_ids.length}} fuentes seleccionadas</p>
 <ng-container *ngIf="selection.mode==='DIRECT'"><label>Fuente de referencia<select [(ngModel)]="selection.reference_source_id" (ngModelChange)="result=null"><option [ngValue]="null">Referencia de la primera selección</option><option *ngFor="let s of selectedSources" [value]="s.id">{{s.name}}</option></select></label><label><input type="checkbox" [(ngModel)]="selection.assume_same_event" (ngModelChange)="result=null">Declaro que es la misma prueba/noche y que la referencia seleccionada es compartida.</label></ng-container>
 <label *ngIf="selection.domain.startsWith('NIGHT')"><input type="checkbox" [(ngModel)]="selection.confirm_legacy_definition" (ngModelChange)="result=null">He comprobado que las ventanas históricas representan la misma métrica de 5 min y acepto su procesamiento heredado.</label>
 <div class="actions"><button [disabled]="selection.source_ids.length<2" (click)="calculate()">Calcular</button><button [disabled]="!result" (click)="calculate(true)">Guardar snapshot</button></div></fieldset>
 <details *ngIf="saved.length"><summary>Comparativas del histórico guardadas</summary><p *ngFor="let s of saved"><button [disabled]="busy" (click)="open(s.id)">{{s.configuration.name}}</button> <a [href]="'/api/comparison-archive/comparisons/'+s.id+'/evidence'" target="_blank" rel="noopener">Evidencia JSON</a></p></details>
 <ng-container *ngIf="result as r"><h3>{{r.configuration.name}}</h3><p *ngFor="let w of r.warnings">{{w}}</p><div class="actions"><button (click)="exportJson()">JSON</button><button (click)="exportCsv()">CSV</button><label>Métrica<select [(ngModel)]="metric" (ngModelChange)="buildDots()"><option *ngFor="let k of r.metric_keys" [value]="k">{{label(k)}} {{unit(k)}}</option></select></label></div>
 <div class="chart" *ngIf="r.configuration.mode==='BENCHMARK'"><canvas baseChart [data]="dots" [options]="dotOptions" [type]="'scatter'"></canvas></div>
 <div class="table-wrap"><table><thead><tr><th>Dispositivo / fuente</th><th>{{label(metric)}} {{unit(metric)}}</th><th>Origen</th></tr></thead><tbody><tr *ngFor="let row of r.rows"><td>{{row.device_name}} · {{row.name}}</td><td>{{number(row.metrics[metric])}}</td><td><a [routerLink]="row.source_url.split('?')[0]" [queryParams]="query(row.source_url)">Análisis fuente</a> <a *ngIf="row.analysis_revision_id" [href]="'/api/analysis-revisions/'+row.analysis_revision_id" target="_blank" rel="noopener">Revisión JSON</a></td></tr></tbody></table></div>
 <div class="table-wrap" *ngIf="r.configuration.mode==='BENCHMARK'"><table><thead><tr><th>Dispositivo</th><th>n sesiones / runs</th><th>n con dato</th><th>Media</th><th>Mediana</th><th>SD</th><th>IQR</th><th>Mín–Máx</th></tr></thead><tbody><tr *ngFor="let g of r.groups"><td>{{g.device_name}}</td><td>{{g.n_sessions}} / {{g.n_sources}}</td><td>{{g.metrics[metric]?.n||0}}</td><td>{{number(g.metrics[metric]?.mean)}}</td><td>{{number(g.metrics[metric]?.median)}}</td><td>{{number(g.metrics[metric]?.sd)}}</td><td>{{number(g.metrics[metric]?.iqr)}}</td><td>{{number(g.metrics[metric]?.min)}}–{{number(g.metrics[metric]?.max)}}</td></tr></tbody></table><p>Los runs del mismo test GPS se promedian primero; cada test o noche pesa una vez.</p></div>
 <ng-container *ngIf="r.configuration.mode==='DIRECT'"><label *ngFor="let s of seriesOptions" class="visibility"><input type="checkbox" [checked]="!hidden.includes(s.id)" (change)="toggleHidden(s.id)">{{s.name}}</label>
 <app-comparison-chart *ngIf="r.series?.length" [series]="r.series||[]" [time]="r.time||[]" [hidden]="hidden" [unit]="r.unit" title="Ventanas nocturnas alineadas en UTC"></app-comparison-chart>
 <app-comparison-chart *ngIf="r.series?.length" [series]="r.series||[]" [time]="r.time||[]" [hidden]="hidden" [unit]="r.unit" [error]="true" title="Error por ventana nocturna"></app-comparison-chart>
 <app-comparison-map *ngIf="r.tracks?.length" [tracks]="r.tracks||[]" [hidden]="hidden"></app-comparison-map></ng-container>
 </ng-container></section>`,
 styles:[`.panel{padding:1.2rem;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface)}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.7rem}.sources{max-height:300px;overflow:auto}.sources label{display:block;padding:.6rem;border-bottom:1px solid var(--line)}label{margin:.5rem;display:block}fieldset{border:0;padding:0}input,select,button{padding:.5rem;background:var(--surface);color:var(--ink);border:1px solid var(--line)}.actions{display:flex;gap:.5rem;flex-wrap:wrap}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}td,th{padding:.6rem;text-align:left;border-bottom:1px solid var(--line)}.chart{height:340px}.visibility{display:inline-block}p{color:var(--ink-3)}`]})
export class ComparisonArchiveComponent implements OnInit {
  @Input() devices:{id:string;name:string}[]=[];
  selection={name:'Comparativa del histórico',domain:'GPS_TRACK',mode:'BENCHMARK',source_ids:[] as string[],reference_source_id:null as string|null,assume_same_event:false,confirm_legacy_definition:false};
  sources:ArchiveSource[]=[];saved:{id:string;configuration:any}[]=[];result:ArchiveResult|null=null;
  busy=false;message='';offset=0;hasMore=false;deviceFilter='';metric='distance_error_m';hidden:string[]=[];
  dots:ChartConfiguration<'scatter'>['data']={datasets:[]};dotOptions:ChartOptions<'scatter'>={responsive:true,maintainAspectRatio:false,animation:false,scales:{y:{ticks:{stepSize:1,callback:v=>this.result?.groups[Number(v)]?.device_name||''}}}};
  constructor(private http:HttpClient){}
  ngOnInit():void{this.loadMore();this.refresh();}
  get visibleSources():ArchiveSource[]{return this.sources.filter(s=>!this.deviceFilter||s.device_id===this.deviceFilter);}
  get selectedSources():ArchiveSource[]{return this.sources.filter(s=>this.selection.source_ids.includes(s.id));}
  get seriesOptions():{id:string;name:string}[]{return this.result?.series?.length?this.result.series:this.result?.tracks||[];}
  domainChanged():void{this.hidden=[];this.selection.assume_same_event=false;this.selection.confirm_legacy_definition=false;this.sources=[];this.offset=0;this.selection.source_ids=[];this.selection.reference_source_id=null;this.result=null;this.metric=this.selection.domain==='GPS_TRACK'?'distance_error_m':this.selection.domain==='GPS_URBAN'?'cross_track_p95_m':'mae';this.loadMore();}
  loadMore():void{this.busy=true;this.http.get<{items:ArchiveSource[];has_more:boolean;next_offset:number}>('/api/comparison-archive/options',{params:{domain:this.selection.domain,offset:this.offset}}).subscribe({next:r=>{this.sources=[...new Map([...this.sources,...r.items].map(s=>[s.id,s])).values()];this.offset=r.next_offset;this.hasMore=r.has_more;this.busy=false;},error:e=>this.fail(e)});}
  toggle(id:string):void{this.selection.source_ids=this.selection.source_ids.includes(id)?this.selection.source_ids.filter(s=>s!==id):[...this.selection.source_ids,id];if(this.selection.reference_source_id&&!this.selection.source_ids.includes(this.selection.reference_source_id))this.selection.reference_source_id=null;this.result=null;}
  toggleHidden(id:string):void{this.hidden=this.hidden.includes(id)?this.hidden.filter(s=>s!==id):[...this.hidden,id];}
  calculate(save=false):void{this.busy=true;this.message='';this.http.post<ArchiveResult|{id:string;result:ArchiveResult}>(`/api/comparison-archive/${save?'comparisons':'preview'}`,this.selection).subscribe({next:r=>{this.result='result' in r?r.result:r;this.busy=false;this.hidden=[];this.buildDots();if(save)this.refresh();},error:e=>this.fail(e)});}
  refresh():void{this.http.get<typeof this.saved>('/api/comparison-archive/comparisons').subscribe({next:r=>this.saved=r,error:e=>this.fail(e)});}
  open(id:string):void{this.busy=true;this.http.get<{result:ArchiveResult}>(`/api/comparison-archive/comparisons/${id}`).subscribe({next:r=>{this.selection={...r.result.configuration};this.hidden=[];this.sources=[...r.result.rows];this.offset=0;this.deviceFilter='';this.loadMore();this.result=r.result;this.metric=r.result.metric_keys.includes('mae')?'mae':r.result.metric_keys[0];this.buildDots();},error:e=>this.fail(e)});}
  buildDots():void{if(!this.result)return;this.dots={datasets:this.result.groups.map((g,i)=>({label:g.device_name,backgroundColor:deviceColor(g.device_id),data:this.result!.rows.filter(r=>r.device_id===g.device_id&&r.metrics[this.metric]!=null).map(r=>({x:r.metrics[this.metric]!,y:i})),pointRadius:5}))};this.dotOptions={...this.dotOptions,scales:{...this.dotOptions.scales,x:{title:{display:true,text:`${this.label(this.metric)} ${this.unit(this.metric)}`}}}};}
  label(k:string):string{return this.result?.statistics?.find(d=>d.id===k)?.name||k;}
  unit(k:string):string{return this.result?.statistics?.find(d=>d.id===k)?.unit||'';}
  number(v:unknown):string{return typeof v==='number'&&Number.isFinite(v)?v.toLocaleString('es-ES',{maximumFractionDigits:2}):'NO DATA';}
  query(url:string):Record<string,string>{return Object.fromEntries(new URLSearchParams(url.split('?')[1]||''));}
  exportJson():void{this.download(JSON.stringify(this.result,null,2),'application/json','historico-comparativa.json');}
  exportCsv():void{if(!this.result)return;const keys=['id','device_id','device_name','name','source_url','analysis_revision_id',...this.result.metric_keys.map(k=>this.unit(k)?`${k} [${this.unit(k)}]`:k)];const cell=(v:unknown)=>{let s=String(v??'');if(typeof v==='string'&&/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};this.download([keys.map(cell).join(','),...this.result.rows.map(r=>[r.id,r.device_id,r.device_name,r.name,r.source_url,r.analysis_revision_id,...this.result!.metric_keys.map(k=>r.metrics[k])].map(cell).join(','))].join('\r\n'),'text/csv;charset=utf-8','historico-metricas.csv');}
  download(data:string,type:string,name:string):void{const url=URL.createObjectURL(new Blob([data],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  fail(e:any):void{this.busy=false;this.message=typeof e.error?.detail==='string'?e.error.detail:JSON.stringify(e.error?.detail||'No se ha podido completar la operación.');}
}

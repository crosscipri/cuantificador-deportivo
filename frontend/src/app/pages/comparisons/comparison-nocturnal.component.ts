import { CommonModule } from '@angular/common';
import { Component, DestroyRef, Input, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { catchError, forkJoin, map, of } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { ComparisonService } from '../../services/comparison.service';
import { NocturnalHrvAggregated, NocturnalHrvSummary } from '../../models/hrv-analysis.model';
import { ComparisonAnalysisMode, deviceColor } from '../../models/comparison.model';

type NocturnalMetric = 'rmssd' | 'hr';
interface NocturnalDeviceRow { id:string; name:string; data:NocturnalHrvAggregated|null; error:string; }

@Component({
  selector:'app-comparison-nocturnal', standalone:true,
  imports:[CommonModule,BaseChartDirective],
  templateUrl:'./comparison-nocturnal.component.html', styleUrls:['./comparisons.component.scss'],
})
export class ComparisonNocturnalComponent implements OnInit {
  @Input() devices:{id:string;name:string}[]=[];
  @Input() mode:ComparisonAnalysisMode='ALL';
  @Input() workspaceId='';
  @Input() selection?:{session_ids:string[]};
  choices:Record<string,NocturnalHrvSummary[]>={};
  selected:string[]=[];saving=false;notice='';
  private generation=0;
  private destroyRef=inject(DestroyRef);
  metric:NocturnalMetric='rmssd';rows:NocturnalDeviceRow[]=[];loading=false;error='';
  correlation:ChartConfiguration<'scatter'>['data']={datasets:[]};
  options:ChartOptions<'scatter'>={responsive:true,maintainAspectRatio:false,animation:false,
    scales:{x:{title:{display:true,text:'Referencia RMSSD (ms)'}},y:{title:{display:true,text:'Dispositivo RMSSD (ms)'}}},
    plugins:{tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: referencia ${ctx.parsed.x}, dispositivo ${ctx.parsed.y} ${this.unit}`}}}};
  constructor(private api:ApiService,private comparisons:ComparisonService){}
  ngOnInit():void{this.selected=[...(this.selection?.session_ids||[])];this.load();}
  get unit():string{return this.metric==='rmssd'?'ms':'bpm';}
  get title():string{return this.metric==='rmssd'?'HRV · RMSSD nocturno':'Frecuencia cardiaca en reposo/nocturna';}
  load():void{
    this.loading=true;this.error='';
    if(this.mode==='ALL'){this.loadAggregates();return;}
    forkJoin(this.devices.map(device=>this.api.listNocturnalHrvSessions(device.id).pipe(
      map(sessions=>({id:device.id,sessions,error:''})),
      catchError(()=>of({id:device.id,sessions:[] as NocturnalHrvSummary[],error:`No se han podido cargar las noches de ${device.name}.`}))
    ))).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(rows=>{
      this.choices=Object.fromEntries(rows.map(row=>[row.id,row.sessions]));
      this.error=rows.map(row=>row.error).filter(Boolean).join(' ');
      this.loadAggregates();
    });
  }
  toggle(id:string):void{
    this.selected=this.selected.includes(id)?this.selected.filter(s=>s!==id):[...this.selected,id];
    this.notice='';this.loadAggregates();
  }
  loadAggregates():void{
    const generation=++this.generation;
    this.loading=true;this.rows=[];this.correlation={datasets:[]};
    forkJoin(this.devices.map(device=>this.api.getAggregatedHrvData(device.id,
      this.mode==='SELECTED'?(this.choices[device.id]||[]).filter(s=>this.selected.includes(s.id)).map(s=>s.id):undefined).pipe(
      map(data=>({id:device.id,name:device.name,data,error:''})),
      catchError(e=>of({id:device.id,name:device.name,data:null,error:typeof e.error?.detail==='string'?e.error.detail:'No se ha podido cargar el agregado nocturno.'}))
    ))).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(rows=>{if(generation!==this.generation)return;this.rows=rows;this.loading=false;this.buildChart();});
  }
  save():void{
    if(this.saving||this.error)return;
    this.saving=true;this.notice='';
    const ids=Object.values(this.choices).flat().filter(s=>this.selected.includes(s.id)).map(s=>s.id);
    this.comparisons.saveNocturnalSelection(this.workspaceId,ids).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next:saved=>{this.selection=saved;this.saving=false;this.notice='Selección guardada para HRV y FC en reposo.';},
      error:e=>{this.saving=false;this.notice=typeof e.error?.detail==='string'?e.error.detail:'No se ha podido guardar la selección.';}
    });
  }
  select(metric:NocturnalMetric):void{this.metric=metric;this.buildChart();}
  data(row:NocturnalDeviceRow){return row.data?.[this.metric];}
  buildChart():void{
    const datasets:ChartConfiguration<'scatter'>['data']['datasets']=this.rows.filter(row=>this.data(row)?.by_session.length).map(row=>({
      label:row.name,data:this.data(row)!.by_session.flatMap(session=>session.points),
      backgroundColor:deviceColor(row.id)+'80',borderColor:deviceColor(row.id),pointRadius:4,
    }));
    let min=Infinity,max=-Infinity;
    for(const dataset of datasets)for(const point of dataset.data as {x:number;y:number}[]){min=Math.min(min,point.x,point.y);max=Math.max(max,point.x,point.y);}
    if(Number.isFinite(min)&&Number.isFinite(max))datasets.push({label:'Identidad (y = x)',data:[{x:min,y:min},{x:max,y:max}],showLine:true,pointRadius:0,borderColor:'#888',borderDash:[5,5]});
    this.correlation={datasets};
    const metricName=this.metric==='rmssd'?'RMSSD':'FC';
    this.options={...this.options,scales:{x:{title:{display:true,text:`Referencia ${metricName} (${this.unit})`}},y:{title:{display:true,text:`Dispositivo ${metricName} (${this.unit})`}}}};
  }
  number(value:number|null|undefined):string{return value!=null&&Number.isFinite(value)?value.toLocaleString('es-ES',{maximumFractionDigits:3}):'Sin datos';}
}

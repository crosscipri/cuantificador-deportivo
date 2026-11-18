import { CommonModule } from '@angular/common';
import { Component, DestroyRef, Input, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, forkJoin, map, of } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { ComparisonService } from '../../services/comparison.service';
import { NocturnalHrvAggregated, NocturnalHrvSummary } from '../../models/hrv-analysis.model';
import { ComparisonAnalysisMode } from '../../models/comparison.model';
import { ComparisonTotalChartsComponent } from '../../shared/comparison-total-charts/comparison-total-charts.component';
import { TotalCorrRow } from '../../shared/comparison-total-charts/comparison-total-charts';

type NocturnalMetric = 'rmssd' | 'hr';
interface NocturnalDeviceRow { id:string; name:string; data:NocturnalHrvAggregated|null; error:string; }

@Component({
  selector:'app-comparison-nocturnal', standalone:true,
  imports:[CommonModule,ComparisonTotalChartsComponent],
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
    this.loading=true;this.rows=[];
    forkJoin(this.devices.map(device=>this.api.getAggregatedHrvData(device.id,
      this.mode==='SELECTED'?(this.choices[device.id]||[]).filter(s=>this.selected.includes(s.id)).map(s=>s.id):undefined).pipe(
      map(data=>({id:device.id,name:device.name,data,error:''})),
      catchError(e=>of({id:device.id,name:device.name,data:null,error:typeof e.error?.detail==='string'?e.error.detail:'No se ha podido cargar el agregado nocturno.'}))
    ))).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(rows=>{if(generation!==this.generation)return;this.rows=rows;this.loading=false;});
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
  select(metric:NocturnalMetric):void{this.metric=metric;}
  data(row:NocturnalDeviceRow){return row.data?.[this.metric];}
  get metricName():string{return this.metric==='rmssd'?'RMSSD':'FC';}
  get chartRows():TotalCorrRow[] {
    return this.rows.map(row=>{
      const metric=this.data(row);
      const stats=metric?.stats;
      return {
        id:row.id,name:row.name,error:row.error,
        points:metric?.by_session.flatMap(session=>session.points)||[],
        stats:stats?{r:stats.pearsonR,mae:stats.mae,rmse:null,bias:stats.bias,loaL:stats.lowerLoa,loaU:stats.upperLoa,slope:stats.slope,intercept:stats.intercept,n:stats.n}:undefined,
      };
    }).filter(row=>row.points.length||row.error);
  }
}

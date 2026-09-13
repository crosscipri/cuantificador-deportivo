import { CommonModule } from '@angular/common';
import { Component, DestroyRef, Input, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { RouterModule } from '@angular/router';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { ComparisonGpsTrack, deviceColor } from '../../models/comparison.model';
import { ComparisonGpsTrackViewComponent } from './comparison-gps-track-view.component';
import { ComparisonGpsUrbanViewComponent } from './comparison-gps-urban-view.component';

type GpsDomain='GPS_TRACK'|'GPS_URBAN';
interface GpsSource {id:string;device_id:string;device_name:string;name:string;source_url:string;}
interface GpsStatistic {id:string;name:string;unit:string;}
interface GpsArchiveResult {
  metric_keys:string[];statistics:GpsStatistic[];warnings:string[];tracks:ComparisonGpsTrack[];
  rows:(GpsSource&{metrics:Record<string,number|null>})[];
  groups:{device_id:string;device_name:string;n_sources:number;n_sessions:number;metrics:Record<string,{n:number;mean:number|null;median:number|null;sd:number|null;iqr:number|null;min:number|null;max:number|null}>}[];
}

@Component({
  selector:'app-comparison-gps',standalone:true,
  imports:[CommonModule,FormsModule,RouterModule,BaseChartDirective,ComparisonGpsTrackViewComponent,ComparisonGpsUrbanViewComponent],
  templateUrl:'./comparison-gps.component.html',styleUrls:['./comparisons.component.scss'],
})
export class ComparisonGpsComponent implements OnInit {
  @Input() devices:{id:string;name:string}[]=[];
  private destroyRef=inject(DestroyRef);
  domain:GpsDomain='GPS_TRACK';result:GpsArchiveResult|null=null;loading=false;error='';metric='distance_error_percent';truncated=false;
  dots:ChartConfiguration<'scatter'>['data']={datasets:[]};
  options:ChartOptions<'scatter'>={responsive:true,maintainAspectRatio:false,animation:false,
    scales:{x:{title:{display:true,text:'Diferencia de distancia (%)'}},y:{ticks:{stepSize:1,callback:value=>this.result?.groups[Number(value)]?.device_name||''}}},
    plugins:{tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${this.number(ctx.parsed.x)} ${this.unit(this.metric)}`}}}};
  constructor(private http:HttpClient){}
  ngOnInit():void{this.load();}
  select(domain:GpsDomain):void{if(this.domain===domain)return;this.domain=domain;this.metric=domain==='GPS_TRACK'?'distance_error_percent':'cross_track_p95_m';this.load();}
  load():void{this.loading=true;this.error='';this.result=null;this.dots={datasets:[]};this.truncated=false;this.loadPage(0,[]);}
  private loadPage(offset:number,collected:GpsSource[]):void{
    this.http.get<{items:GpsSource[];has_more:boolean;next_offset:number}>('/api/comparison-archive/options',{params:{domain:this.domain,offset}})
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({next:page=>{
        const sources=[...new Map([...collected,...page.items].map(source=>[source.id,source])).values()];
        if(page.has_more){this.loadPage(page.next_offset,sources);return;}
        const selected=sources.filter(source=>this.devices.some(device=>device.id===source.device_id));
        this.truncated=selected.length>100;
        const sourceIds=selected.slice(0,100).map(source=>source.id);
        if(new Set(selected.map(source=>source.device_id)).size<2){this.loading=false;this.error='No hay pruebas GPS guardadas para al menos dos de los dispositivos seleccionados.';return;}
        this.calculate(sourceIds);
      },error:e=>this.fail(e)});
  }
  private calculate(sourceIds:string[]):void{
    const body={name:this.domain==='GPS_TRACK'?'GPS de pista · análisis conjunto':'GPS urbano · análisis conjunto',domain:this.domain,mode:'BENCHMARK',source_ids:sourceIds,reference_source_id:null,assume_same_event:false,confirm_legacy_definition:false};
    this.http.post<GpsArchiveResult>('/api/comparison-archive/preview',body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({next:result=>{
      this.result=result;this.loading=false;
      if(!this.availableMetrics.includes(this.metric))this.metric=this.availableMetrics[0]||result.metric_keys[0];
      this.buildDots();
    },error:e=>this.fail(e)});
  }
  get availableMetrics():string[]{return (this.result?.metric_keys||[]).filter(key=>this.result!.rows.some(row=>row.metrics[key]!=null));}
  buildDots():void{
    if(!this.result)return;
    this.dots={datasets:this.result.groups.map((group,index)=>({
      label:group.device_name,backgroundColor:deviceColor(group.device_id),borderColor:deviceColor(group.device_id),pointRadius:6,
      data:this.result!.rows.filter(row=>row.device_id===group.device_id&&row.metrics[this.metric]!=null).map(row=>({x:row.metrics[this.metric]!,y:index})),
    }))};
    this.options={...this.options,scales:{x:{title:{display:true,text:`${this.label(this.metric)} ${this.unit(this.metric)}`}},y:{ticks:{stepSize:1,callback:value=>this.result?.groups[Number(value)]?.device_name||''}}}};
  }
  label(key:string):string{return this.result?.statistics.find(item=>item.id===key)?.name||key;}
  unit(key:string):string{return this.result?.statistics.find(item=>item.id===key)?.unit||'';}
  aggregate(group:GpsArchiveResult['groups'][number],field:'mean'|'median'|'sd'|'min'|'max'):number|null{return group.metrics[this.metric]?.[field]??null;}
  count(group:GpsArchiveResult['groups'][number]):number{return group.metrics[this.metric]?.n??0;}
  number(value:number|null|undefined):string{return value!=null&&Number.isFinite(value)?value.toLocaleString('es-ES',{maximumFractionDigits:2}):'Sin datos';}
  query(url:string):Record<string,string>{return Object.fromEntries(new URLSearchParams(url.split('?')[1]||''));}
  private fail(error:any):void{this.loading=false;this.error=typeof error.error?.detail==='string'?error.error.detail:'No se ha podido generar el análisis GPS conjunto.';}
}

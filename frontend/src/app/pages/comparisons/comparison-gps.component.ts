import { CommonModule } from '@angular/common';
import { Component, DestroyRef, Input, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { RouterModule } from '@angular/router';
import { ComparisonGpsTrack } from '../../models/comparison.model';
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
  imports:[CommonModule,RouterModule,ComparisonGpsTrackViewComponent,ComparisonGpsUrbanViewComponent],
  templateUrl:'./comparison-gps.component.html',styleUrls:['./comparisons.component.scss'],
})
export class ComparisonGpsComponent implements OnInit {
  @Input() devices:{id:string;name:string}[]=[];
  private destroyRef=inject(DestroyRef);
  domain:GpsDomain='GPS_TRACK';result:GpsArchiveResult|null=null;loading=false;error='';truncated=false;
  constructor(private http:HttpClient){}
  ngOnInit():void{this.load();}
  select(domain:GpsDomain):void{if(this.domain===domain)return;this.domain=domain;this.load();}
  load():void{this.loading=true;this.error='';this.result=null;this.truncated=false;this.loadPage(0,[]);}
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
    },error:e=>this.fail(e)});
  }
  metric(row:GpsArchiveResult['rows'][number], key:string):number|null{return row.metrics[key]??null;}
  mape(row:GpsArchiveResult['rows'][number]):number|null{const value=this.metric(row,'distance_error_percent');return value==null?null:Math.abs(value);}
  distance(row:GpsArchiveResult['rows'][number]):number|null{return row.metrics['legacy_derived_distance_m']??row.metrics['derived_distance_m']??null;}
  distanceText(meters:number|null|undefined):string{return meters!=null&&Number.isFinite(meters)?`${(meters/1000).toLocaleString('es-ES',{maximumFractionDigits:2})} km`:'Sin datos';}
  number(value:number|null|undefined):string{return value!=null&&Number.isFinite(value)?value.toLocaleString('es-ES',{maximumFractionDigits:2}):'Sin datos';}
  query(url:string):Record<string,string>{return Object.fromEntries(new URLSearchParams(url.split('?')[1]||''));}
  private fail(error:any):void{this.loading=false;this.error=typeof error.error?.detail==='string'?error.error.detail:'No se ha podido generar el análisis GPS conjunto.';}
}

import { Component, DestroyRef, Input, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { EMPTY, catchError, expand, forkJoin, map, of, reduce } from 'rxjs';
import { ComparisonService } from '../../services/comparison.service';
import { ApiService } from '../../services/api.service';
import { ComparisonAnalysisMode, ComparisonSession, SportSelection, deviceColor } from '../../models/comparison.model';
import { SportAggregateCharts } from '../../models/session.model';
import { ComparisonSessionComponent } from './comparison-session.component';
import { ComparisonSelectedSportComponent } from './comparison-selected-sport.component';

interface SportSection {id:string;name:string;sessions:ComparisonSession[];opened:Set<string>;loading:boolean;loaded:boolean;aggregates:{id:string;name:string;data:SportAggregateCharts|null;error:string}[];correlation:ChartConfiguration<'scatter'>['data'];}

@Component({selector:'app-comparison-sports',standalone:true,imports:[CommonModule,BaseChartDirective,ComparisonSessionComponent,ComparisonSelectedSportComponent],
  templateUrl:'./comparison-sports.component.html',styleUrls:['./comparisons.component.scss']})
export class ComparisonSportsComponent implements OnInit {
  @Input() devices:{id:string;name:string}[]=[];
  @Input() workspaceId='';
  @Input() pairs:Record<string,string[]>={};
  @Input() mode:ComparisonAnalysisMode='ALL';
  @Input() selections:Record<string,SportSelection>={};
  visited=new Set<string>();
  private destroyRef=inject(DestroyRef);
  sports:SportSection[]=[];active:SportSection|null=null;loading=false;error='';
  options:ChartOptions<'scatter'>={responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{title:{display:true,text:'FC de referencia (bpm)'}},y:{title:{display:true,text:'FC del dispositivo (bpm)'}}},plugins:{tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: referencia ${ctx.parsed.x}, dispositivo ${ctx.parsed.y} bpm`}}}};
  constructor(private api:ComparisonService,private legacy:ApiService){}
  ngOnInit():void{this.load();}
  load():void {
    this.loading=true;this.error='';this.sports=[];this.active=null;
    forkJoin(this.devices.map(d=>this.api.sessions(0,d.id).pipe(
      map(page=>({...page,offset:page.items.length})),
      expand(page=>page.has_more&&page.items.length?this.api.sessions(page.offset,d.id).pipe(map(next=>({...next,offset:page.offset+next.items.length}))):EMPTY),
      reduce((all,page)=>[...all,...page.items],[] as ComparisonSession[])
    ))).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({next:lists=>{
      const sessions=[...new Map(lists.flat().map(s=>[s.id,s])).values()];
      const names:Record<string,string>={running:'Running',cycling:'Ciclismo',gym:'Fuerza',unknown:'Sin deporte clasificado'};
      const ids=[...new Set(sessions.map(s=>s.sport_type||'unknown'))].sort((a,b)=>{
        const order=['running','cycling','gym'];return (order.includes(a)?order.indexOf(a):3)-(order.includes(b)?order.indexOf(b):3);
      });
      this.sports=ids.map(id=>({id,name:names[id]||id,sessions:sessions.filter(s=>(s.sport_type||'unknown')===id),opened:new Set<string>(),loading:false,loaded:false,aggregates:[],correlation:{datasets:[]}}));
      this.loading=false;if(this.sports.length)this.choose(this.sports[0]);
    },error:e=>{this.loading=false;this.error=typeof e.error?.detail==='string'?e.error.detail:'No se han podido cargar los entrenamientos analizados.';}});
  }
  choose(sport:SportSection):void{this.active=sport;this.visited.add(sport.id);if(this.mode==='ALL'&&!sport.loaded&&!sport.loading)this.aggregate(sport);}
  aggregate(sport:SportSection):void {
    if(!['running','cycling','gym'].includes(sport.id)){sport.loaded=true;return;}
    sport.loading=true;
    forkJoin(this.devices.map(device=>this.legacy.getSportAggregateCharts(device.id,sport.id).pipe(
      map(data=>({id:device.id,name:device.name,data,error:''})),
      catchError(e=>of({id:device.id,name:device.name,data:null,error:typeof e.error?.detail==='string'?e.error.detail:'No se ha podido cargar el agregado.'}))
    ))).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(rows=>{
      sport.aggregates=rows;sport.loading=false;sport.loaded=true;
      const datasets:ChartConfiguration<'scatter'>['data']['datasets']=rows.filter(row=>row.data).map(row=>({
        label:row.name,data:row.data!.sessions.flatMap(s=>s.points),backgroundColor:deviceColor(row.id)+'80',borderColor:deviceColor(row.id),pointRadius:2,
      }));
      let min=Infinity,max=-Infinity;
      for(const row of rows)for(const session of row.data?.sessions||[])for(const p of session.points){min=Math.min(min,p.x,p.y);max=Math.max(max,p.x,p.y);}
      if(Number.isFinite(min)&&Number.isFinite(max))datasets.push({label:'Identidad (y = x)',data:[{x:min,y:min},{x:max,y:max}],showLine:true,pointRadius:0,borderColor:'#888',borderDash:[5,5]});
      sport.correlation={datasets};
    });
  }
  number(value:number|null|undefined):string{return value!=null&&Number.isFinite(value)?value.toLocaleString('es-ES',{maximumFractionDigits:3}):'Sin datos';}
  toggle(sport:SportSection,id:string,open:boolean):void{if(open)sport.opened.add(id);}
}

import { Component, DestroyRef, Input, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { EMPTY, catchError, expand, forkJoin, map, of, reduce } from 'rxjs';
import { ComparisonService } from '../../services/comparison.service';
import { ApiService } from '../../services/api.service';
import { ComparisonAnalysisMode, ComparisonSession, SportSelection } from '../../models/comparison.model';
import { SportAggregateCharts } from '../../models/session.model';
import { ComparisonSessionComponent } from './comparison-session.component';
import { ComparisonSelectedSportComponent } from './comparison-selected-sport.component';
import { ComparisonTotalChartsComponent } from '../../shared/comparison-total-charts/comparison-total-charts.component';
import { SportCorrDevice, TotalCorrRow, percentAtLeast, usableCorrelation } from '../../shared/comparison-total-charts/comparison-total-charts';
import { TotalCorrTimeSession } from '../../shared/comparison-total-charts/comparison-total-charts.component';

interface SportSection {generation:number;selectedIds?:string[];id:string;name:string;sessions:ComparisonSession[];opened:Set<string>;loading:boolean;loaded:boolean;aggregates:{id:string;name:string;data:SportAggregateCharts|null;error:string}[];}

@Component({selector:'app-comparison-sports',standalone:true,imports:[CommonModule,ComparisonSessionComponent,ComparisonSelectedSportComponent,ComparisonTotalChartsComponent],
  templateUrl:'./comparison-sports.component.html',styleUrls:['./comparisons.component.scss']})
export class ComparisonSportsComponent implements OnInit {
  @Input() devices:{id:string;name:string}[]=[];
  @Input() workspaceId='';
  @Input() pairs:Record<string,string[]>={};
  @Input() mode:ComparisonAnalysisMode='ALL';
  @Input() selections:Record<string,SportSelection>={};
  visited=new Set<string>();
  private destroyRef=inject(DestroyRef);
  sports:SportSection[]=[];active:SportSection|null=null;loading=false;error='';sportProfiles:SportCorrDevice[]=[];
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
      this.sports=ids.map(id=>({generation:0,id,name:names[id]||id,sessions:sessions.filter(s=>(s.sport_type||'unknown')===id),opened:new Set<string>(),loading:false,loaded:false,aggregates:[]}));
      this.loading=false;this.loadSportCorrelations();if(this.sports.length)this.choose(this.sports[0]);
    },error:e=>{this.loading=false;this.error=typeof e.error?.detail==='string'?e.error.detail:'No se han podido cargar los entrenamientos analizados.';}});
  }
  choose(sport:SportSection):void{this.active=sport;this.visited.add(sport.id);if(this.mode==='ALL'&&!sport.loaded&&!sport.loading)this.aggregate(sport);}
  selectSessions(sport:SportSection,ids:string[]):void {
    sport.selectedIds=ids;
    this.aggregate(sport);
    this.loadSportCorrelations();
  }
  aggregate(sport:SportSection):void {
    if(!['running','cycling','gym'].includes(sport.id)){sport.loaded=true;return;}
    sport.loading=true;sport.aggregates=[];
    const generation=++sport.generation;
    forkJoin(this.devices.map(device=>{
      const ids=this.mode==='SELECTED'?sport.sessions.filter(s=>s.device_id===device.id&&sport.selectedIds?.includes(s.id)).map(s=>s.id):undefined;
      if(ids&&!ids.length)return of({id:device.id,name:device.name,data:null,error:''});
      return this.legacy.getSportAggregateCharts(device.id,sport.id,ids).pipe(
      map(data=>({id:device.id,name:device.name,data,error:''})),
      catchError(e=>of({id:device.id,name:device.name,data:null,error:typeof e.error?.detail==='string'?e.error.detail:'No se ha podido cargar el agregado.'}))
    );})).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(rows=>{
      if(generation!==sport.generation)return;
      sport.aggregates=rows;sport.loading=false;sport.loaded=true;
    });
  }
  loadSportCorrelations():void {
    const sportIds=['running','cycling','gym'] as const;
    const labels:Record<string,string>={running:'Running',cycling:'Ciclismo',gym:'Fuerza'};
    if(!this.devices.length){this.sportProfiles=[];return;}
    forkJoin(this.devices.map(device=>
      forkJoin(sportIds.map(sportId=>{
        const section=this.sports.find(sport=>sport.id===sportId);
        if(this.mode==='SELECTED'){
          const ids=section?.sessions.filter(s=>s.device_id===device.id&&section.selectedIds?.includes(s.id)).map(s=>s.id)||[];
          if(!ids.length)return of({sportId,data:null as SportAggregateCharts|null});
          return this.legacy.getSportAggregateCharts(device.id,sportId,ids).pipe(
            map(data=>({sportId,data:data as SportAggregateCharts})),
            catchError(()=>of({sportId,data:null as SportAggregateCharts|null}))
          );
        }
        return this.legacy.getSportAggregateCharts(device.id,sportId).pipe(
          map(data=>({sportId,data:data as SportAggregateCharts})),
          catchError(()=>of({sportId,data:null as SportAggregateCharts|null}))
        );
      })).pipe(map(sports=>({id:device.id,name:device.name,sports})))
    )).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(rows=>{
      this.sportProfiles=rows.map(row=>({
        id:row.id,
        name:row.name,
        sports:row.sports.map(({sportId,data})=>{
          const sessionRs=(data?.per_session||[]).map((session:any)=>usableCorrelation(session?.metrics?.pearson_r, session?.metrics?.ccc)?session.metrics.pearson_r as number:null).filter((r:number|null):r is number=>r!=null);
          return {id:sportId,label:labels[sportId],r:data?.global_stats?.pearson_r??null,sessionRs,perc:percentAtLeast(sessionRs)};
        }),
      })) as SportCorrDevice[];
    });
  }
  chartRows(sport:SportSection):TotalCorrRow[] {
    return sport.aggregates.map(row=>{
      const stats=row.data?.global_stats;
      return {
        id:row.id,name:row.name,error:row.error,
        points:row.data?.sessions.flatMap(session=>session.points)||[],
        stats:stats?{r:stats.pearson_r,mae:stats.mae??null,rmse:stats.rmse??null,bias:stats.bias,loaL:stats.loa_l,loaU:stats.loa_u,slope:stats.slope,intercept:stats.intercept}:undefined,
      };
    });
  }
  timeSessions(sport:SportSection):TotalCorrTimeSession[] {
    const ids=this.mode==='SELECTED'?new Set(sport.selectedIds||[]):null;
    return sport.sessions
      .filter(session=>!ids||ids.has(session.id))
      .map(session=>({id:session.id,deviceId:session.device_id,label:`${session.device_name} · ${session.session_name}`}));
  }
  toggle(sport:SportSection,id:string,open:boolean):void{if(open)sport.opened.add(id);}
}

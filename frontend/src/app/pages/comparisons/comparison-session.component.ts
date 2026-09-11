import { Component, DestroyRef, Input, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { forkJoin } from 'rxjs';
import { ComparisonService } from '../../services/comparison.service';
import { ComparisonSession, ComparisonSeries, deviceColor } from '../../models/comparison.model';

@Component({selector:'app-comparison-session',standalone:true,imports:[CommonModule,FormsModule,RouterModule,BaseChartDirective],
  template:`<div class="fields"><label *ngFor="let device of devices">{{device.name}}
    <select [disabled]="saving" [ngModel]="selected[device.id]||''" (ngModelChange)="select(device.id,$event)">
      <option value="">Sin sesión seleccionada</option><option *ngFor="let s of choices[device.id]" [value]="s.id">{{s.session_name}} · {{s.activity_date|date:'short'}} · {{s.training_type||s.session_difficulty}}</option>
    </select></label></div>
    <p class="hint">Elige el entrenamiento de cada dispositivo que quieres poner en esta gráfica. Cada curva conserva su referencia y su tiempo desde el inicio; no se presupone que sean grabaciones simultáneas.</p>
    <button *ngIf="workspaceId" [disabled]="saving||busy" (click)="save()">{{saving?'Guardando…':'Guardar selección de entrenamientos'}}</button><p role="status" *ngIf="notice">{{notice}}</p>
    <p *ngIf="busy" role="status">Cargando curvas analizadas…</p><p *ngIf="error" class="error" role="alert">{{error}}</p>
    <ng-container *ngIf="!busy&&data.datasets.length"><div class="session-chart"><canvas baseChart [type]="'line'" [data]="data" [options]="options"></canvas></div>
    <div class="actions"><a *ngFor="let s of sources" [routerLink]="['/devices',s.device_id,'sessions',s.id]">Abrir análisis · {{s.device_name}} · {{s.session_name}}</a></div></ng-container>`,
  styles:[`.fields{display:flex;gap:1rem;flex-wrap:wrap}label{display:flex;flex:1;min-width:200px;flex-direction:column;gap:.5rem}select{max-width:100%;padding:.65rem;color:var(--ink);background:var(--surface);border:1px solid var(--line)}.session-chart{height:400px}.hint{color:var(--ink-3);line-height:1.6}.error{color:var(--bad-ink)}.actions{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}a{color:var(--accent)}`]})
export class ComparisonSessionComponent implements OnInit {
  @Input({required:true}) session!:ComparisonSession;
  @Input() sessions:ComparisonSession[]=[];
  @Input() devices:{id:string;name:string}[]=[];
  @Input() workspaceId='';
  @Input() pairs:Record<string,string[]>={};
  saving=false;notice='';
  private destroyRef=inject(DestroyRef);
  private generation=0;
  selected:Record<string,string>={};choices:Record<string,ComparisonSession[]>={};sources:ComparisonSession[]=[];
  busy=false;error='';data:ChartConfiguration<'line'>['data']={datasets:[]};
  options:ChartOptions<'line'>={responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'nearest',intersect:false},scales:{x:{type:'linear',title:{display:true,text:'Tiempo desde el inicio de cada sesión (s)'}},y:{title:{display:true,text:'Frecuencia cardíaca (bpm)'}}}};
  constructor(private api:ComparisonService){}
  ngOnInit():void {
    for(const device of this.devices){
      this.choices[device.id]=this.sessions.filter(s=>s.device_id===device.id);
      const matches=this.session.experiment_id?this.choices[device.id].filter(s=>s.experiment_id===this.session.experiment_id):[];
      this.selected[device.id]=device.id===this.session.device_id?this.session.id:matches.length===1?matches[0].id:'';
      if(this.pairs[this.session.id])this.selected[device.id]=this.choices[device.id].find(s=>this.pairs[this.session.id].includes(s.id))?.id||'';
    }
    this.load();
  }
  select(device:string,id:string):void{this.selected[device]=id;this.notice='';this.load();}
  save():void {
    if(this.saving)return;
    const ids=Object.values(this.selected).filter(Boolean);this.saving=true;
    this.api.saveWorkspacePair(this.workspaceId,this.session.id,ids).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({next:r=>{
      this.pairs[this.session.id]=r.session_ids;this.saving=false;this.notice='Selección guardada para esta gráfica.';
    },error:e=>{this.saving=false;this.error=typeof e.error?.detail==='string'?e.error.detail:'No se ha podido guardar la selección.';}});
  }
  load():void {
    const generation=++this.generation;
    this.sources=this.sessions.filter(s=>Object.values(this.selected).includes(s.id));this.error='';this.data={datasets:[]};
    if(!this.sources.length){this.busy=false;return;}
    this.busy=true;
    forkJoin(this.sources.map(s=>this.api.historicalChart(s.id))).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({next:charts=>{
      if(generation!==this.generation)return;
      this.data={datasets:charts.flatMap(chart=>chart.series.map((series:ComparisonSeries)=>{
        const source=this.sources.find(s=>s.id===chart.session_id)!;
        return {label:`${source.device_name} · ${series.role==='reference'?'Referencia: ':''}${series.name}`,data:chart.time.map((t,i)=>({x:t,y:series.values[i]??NaN})),borderColor:deviceColor(source.device_id),borderDash:series.role==='reference'?[6,4]:[],borderWidth:series.role==='reference'?1:2,pointRadius:0,spanGaps:false};
      }))};this.busy=false;
    },error:e=>{if(generation===this.generation){this.busy=false;this.error=typeof e.error?.detail==='string'?e.error.detail:'No se han podido cargar las curvas. Vuelve a seleccionar la sesión para reintentar.';}}});
  }
}

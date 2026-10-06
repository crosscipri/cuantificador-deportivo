import { Component, DestroyRef, EventEmitter, Input, OnInit, Output, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { forkJoin } from 'rxjs';
import { ComparisonService } from '../../services/comparison.service';
import { ComparisonSession, ComparisonSeries, SportSelection, deviceColor } from '../../models/comparison.model';

@Component({selector:'app-comparison-selected-sport',standalone:true,
  imports:[CommonModule,FormsModule,RouterModule,BaseChartDirective],
  template:`<section class="panel">
    <h2>{{sportName}} · Sesiones seleccionadas</h2>
    <p>Marca una o varias sesiones de cada dispositivo. La correlación total se recalcula solo con estas sesiones, comparadas con la referencia de cada análisis.</p>
    <fieldset [disabled]="busy||saving">
      <div class="fields"><div class="session-choices" *ngFor="let device of devices"><h3>{{device.name}}</h3>
        <label class="check" *ngFor="let session of choices[device.id]">
          <input type="checkbox" [checked]="selected[device.id].includes(session.id)" (change)="select(device.id,session.id)">
          <span>{{session.session_name}} · {{session.activity_date|date:'short'}} · {{session.training_type||session.session_difficulty}} · Ref: {{session.reference_name}}</span>
        </label><small *ngIf="!choices[device.id]?.length">Este dispositivo no tiene sesiones de {{sportName}}.</small>
      </div></div>
      <div class="actions"><button class="primary" [disabled]="!!issue" (click)="show()">{{busy?'Cargando…':'Ver curvas de las sesiones'}}</button><button [disabled]="!!issue" (click)="save()">{{saving?'Guardando…':'Guardar selección de este deporte'}}</button></div>
    </fieldset>
    <p class="hint" role="status" *ngIf="issue">{{issue}}</p><p role="status" *ngIf="notice">{{notice}}</p><p class="error" role="alert" *ngIf="error">{{error}}</p>
    <ng-container *ngIf="data.datasets.length">
      <div class="session-chart"><canvas baseChart [type]="'line'" [data]="data" [options]="options"></canvas></div>
      <p class="hint">Tiempo desde el inicio de cada análisis guardado. Se conserva la alineación de esos análisis; no se añaden desplazamientos ni interpolación.</p>
      <div class="actions"><a *ngFor="let session of selectedSessions" [routerLink]="['/devices',session.device_id,'sessions',session.id]">Abrir análisis · {{session.device_name}} · {{session.session_name}}</a></div>
    </ng-container>
  </section>`,styleUrls:['./comparisons.component.scss'],
  styles:[`.session-chart{height:440px;position:relative;min-width:0}`]})
export class ComparisonSelectedSportComponent implements OnInit {
  @Input() devices:{id:string;name:string}[]=[];
  @Input() sessions:ComparisonSession[]=[];
  @Input() workspaceId='';
  @Input() sport='';
  @Input() sportName='';
  @Input() selections:Record<string,SportSelection>={};
  @Output() selectionChange=new EventEmitter<string[]>();
  private destroyRef=inject(DestroyRef);
  choices:Record<string,ComparisonSession[]>={};selected:Record<string,string[]>={};
  busy=false;saving=false;error='';notice='';
  data:ChartConfiguration<'line'>['data']={datasets:[]};
  options:ChartOptions<'line'>={responsive:true,maintainAspectRatio:false,animation:false,
    interaction:{mode:'nearest',intersect:false},
    scales:{x:{type:'linear',title:{display:true,text:'Tiempo desde el inicio (s)'}},y:{title:{display:true,text:'Frecuencia cardíaca (bpm)'}}}};
  constructor(private api:ComparisonService){}
  ngOnInit():void {
    const saved=this.selections[this.sport];
    for(const device of this.devices){
      this.choices[device.id]=this.sessions.filter(s=>s.device_id===device.id);
      this.selected[device.id]=this.choices[device.id].filter(s=>saved?.session_ids.includes(s.id)).map(s=>s.id);
    }
    this.selectionChange.emit(this.selectedSessions.map(s=>s.id));
  }
  get selectedSessions():ComparisonSession[]{return this.devices.flatMap(d=>this.choices[d.id]?.filter(s=>this.selected[d.id]?.includes(s.id))||[]);}
  get issue():string {
    if(this.devices.length<2||this.devices.some(d=>!this.selected[d.id]?.length))return 'Elige al menos una sesión de cada dispositivo para este deporte.';
    return '';
  }
  select(device:string,id:string):void {
    const ids=this.selected[device]||[];
    this.selected[device]=ids.includes(id)?ids.filter(s=>s!==id):[...ids,id];
    this.invalidate();
    this.selectionChange.emit(this.selectedSessions.map(s=>s.id));
  }
  invalidate():void{this.data={datasets:[]};this.error='';this.notice='';}
  show():void {
    if(this.busy||this.saving||this.issue)return;
    this.busy=true;this.error='';this.data={datasets:[]};
    const sessions=this.selectedSessions;
    forkJoin(sessions.map(s=>this.api.historicalChart(s.id))).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({next:charts=>{
      const dataset=(time:number[],source:ComparisonSeries,label:string,color:string,isReference=false)=>({
        label,data:time.map((x,i)=>({x,y:source.values[i]??NaN})),borderColor:color,borderWidth:isReference?2.5:1.8,borderDash:isReference?[6,4]:[],pointRadius:0,spanGaps:false,
      });
      this.data={datasets:charts.flatMap((chart,index)=>chart.series.map(series=>dataset(
        chart.time,series,`${sessions[index].device_name} · ${sessions[index].session_name} · ${series.role==='reference'?'Referencia: ':''}${series.name}`,
        deviceColor(sessions[index].device_id),series.role==='reference')))};
      this.busy=false;
    },error:e=>{this.busy=false;this.error=this.message(e);}});
  }
  save():void {
    if(this.busy||this.saving||this.issue)return;
    const selection={session_ids:this.selectedSessions.map(s=>s.id)};
    this.saving=true;this.error='';this.notice='';
    this.api.saveSportSelection(this.workspaceId,this.sport,selection).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({next:saved=>{
      this.selections[this.sport]=saved;this.saving=false;this.notice='Selección de sesiones guardada para este deporte.';
    },error:e=>{this.saving=false;this.error=this.message(e);}});
  }
  private message(e:any):string{return typeof e.error?.detail==='string'?e.error.detail:'No se ha podido completar la operación. Inténtalo de nuevo.';}
}

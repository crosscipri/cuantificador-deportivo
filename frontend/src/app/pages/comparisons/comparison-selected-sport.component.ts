import { Component, DestroyRef, Input, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { forkJoin } from 'rxjs';
import { ComparisonService } from '../../services/comparison.service';
import { ComparisonSession, ComparisonSeries, SportSelection, DEVICE_COLORS } from '../../models/comparison.model';

@Component({selector:'app-comparison-selected-sport',standalone:true,
  imports:[CommonModule,FormsModule,RouterModule,BaseChartDirective],
  template:`<section class="panel">
    <h2>{{sportName}} · Una sesión por dispositivo</h2>
    <p>Elige las sesiones que comparten la misma referencia. La gráfica mostrará una única referencia y una curva por dispositivo.</p>
    <fieldset [disabled]="busy||saving">
      <div class="fields"><label *ngFor="let device of devices">{{device.name}}
        <select [ngModel]="selected[device.id]||''" (ngModelChange)="select(device.id,$event)">
          <option value="">Elige un entrenamiento</option>
          <option *ngFor="let session of choices[device.id]" [value]="session.id">{{session.session_name}} · {{session.activity_date|date:'short'}} · {{session.training_type||session.session_difficulty}} · Ref: {{session.reference_name}}</option>
        </select><small *ngIf="!choices[device.id]?.length">Este dispositivo no tiene sesiones de {{sportName}}.</small>
      </label></div>
      <label>Referencia común<select [(ngModel)]="referenceId" (ngModelChange)="invalidate()">
        <option value="">Elige la sesión que aporta la referencia</option>
        <option *ngFor="let session of selectedSessions" [value]="session.id">{{session.reference_name}} · {{session.device_name}} · {{session.session_name}}</option>
      </select></label>
      <p class="hint">La referencia común la eliges tú entre los análisis seleccionados, asegurándote de que corresponden a la misma referencia. Se muestra una sola vez, en negro.</p>
      <div class="actions"><button class="primary" [disabled]="!!issue" (click)="show()">{{busy?'Cargando…':'Ver gráfica comparativa'}}</button><button [disabled]="!!issue" (click)="save()">{{saving?'Guardando…':'Guardar selección de este deporte'}}</button></div>
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
  private destroyRef=inject(DestroyRef);
  choices:Record<string,ComparisonSession[]>={};selected:Record<string,string>={};
  referenceId='';busy=false;saving=false;error='';notice='';
  data:ChartConfiguration<'line'>['data']={datasets:[]};
  options:ChartOptions<'line'>={responsive:true,maintainAspectRatio:false,animation:false,
    interaction:{mode:'nearest',intersect:false},
    scales:{x:{type:'linear',title:{display:true,text:'Tiempo desde el inicio (s)'}},y:{title:{display:true,text:'Frecuencia cardíaca (bpm)'}}}};
  constructor(private api:ComparisonService){}
  ngOnInit():void {
    const saved=this.selections[this.sport];
    for(const device of this.devices){
      this.choices[device.id]=this.sessions.filter(s=>s.device_id===device.id);
      this.selected[device.id]=this.choices[device.id].find(s=>saved?.session_ids.includes(s.id))?.id||'';
    }
    this.referenceId=this.selectedSessions.some(s=>s.id===saved?.reference_session_id)?saved!.reference_session_id:'';
    if(saved&&!this.issue)this.show();
  }
  get selectedSessions():ComparisonSession[]{return this.devices.flatMap(d=>this.choices[d.id]?.filter(s=>s.id===this.selected[d.id])||[]);}
  get issue():string {
    if(this.devices.length<2||this.selectedSessions.length!==this.devices.length)return 'Elige una sesión de cada dispositivo para este deporte.';
    if(!this.selectedSessions.some(s=>s.id===this.referenceId))return 'Elige qué referencia común mostrar en la gráfica.';
    return '';
  }
  select(device:string,id:string):void {
    this.selected[device]=id;
    if(!this.selectedSessions.some(s=>s.id===this.referenceId))this.referenceId=this.selectedSessions[0]?.id||'';
    this.invalidate();
  }
  invalidate():void{this.data={datasets:[]};this.error='';this.notice='';}
  show():void {
    if(this.busy||this.saving||this.issue)return;
    this.busy=true;this.error='';this.data={datasets:[]};
    const sessions=this.selectedSessions;
    forkJoin(sessions.map(s=>this.api.historicalChart(s.id))).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({next:charts=>{
      const reference=charts.find(c=>c.session_id===this.referenceId);
      const series=reference?.series.find(s=>s.role==='reference');
      if(!reference||!series||charts.some(c=>!c.series.some(s=>s.role==='device'))){this.busy=false;this.error='Falta la referencia o la curva de un dispositivo en los análisis seleccionados.';return;}
      const dataset=(time:number[],source:ComparisonSeries,label:string,color:string,isReference=false)=>({
        label,data:time.map((x,i)=>({x,y:source.values[i]??NaN})),borderColor:color,borderWidth:isReference?2.5:1.8,borderDash:isReference?[6,4]:[],pointRadius:0,spanGaps:false,
      });
      this.data={datasets:[dataset(reference.time,series,`Referencia · ${series.name}`,'#18181b',true),
        ...charts.map((chart,index)=>dataset(chart.time,chart.series.find(s=>s.role==='device')!,sessions[index].device_name,DEVICE_COLORS[index%DEVICE_COLORS.length]))]};
      this.busy=false;
    },error:e=>{this.busy=false;this.error=this.message(e);}});
  }
  save():void {
    if(this.busy||this.saving||this.issue)return;
    const selection={session_ids:this.selectedSessions.map(s=>s.id),reference_session_id:this.referenceId};
    this.saving=true;this.error='';this.notice='';
    this.api.saveSportSelection(this.workspaceId,this.sport,selection).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({next:saved=>{
      this.selections[this.sport]=saved;this.saving=false;this.notice='Sesiones y referencia común guardadas para este deporte.';
      if(!this.data.datasets.length)this.show();
    },error:e=>{this.saving=false;this.error=this.message(e);}});
  }
  private message(e:any):string{return typeof e.error?.detail==='string'?e.error.detail:'No se ha podido completar la operación. Inténtalo de nuevo.';}
}

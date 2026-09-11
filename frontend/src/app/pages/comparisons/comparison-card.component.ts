import { Component, Input, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { ComparisonResult, deviceColor } from '../../models/comparison.model';
import { ComparisonChartComponent } from '../../shared/comparison-charts/comparison-chart.component';
import { ComparisonMapComponent } from '../../shared/comparison-charts/comparison-map.component';
import { ComparisonDiagnosticsComponent } from '../../shared/comparison-charts/comparison-diagnostics.component';

@Component({
  selector:'app-comparison-card',standalone:true,
  imports:[CommonModule,BaseChartDirective,ComparisonChartComponent,ComparisonMapComponent,ComparisonDiagnosticsComponent],
  template:`
    <ng-container *ngIf="result as r">
      <p>{{r.rows.length}} entrenamientos · {{sessionNames}}</p>
      <ng-container *ngIf="r.mode==='BENCHMARK';else direct">
        <p>{{metric}} · Cada punto representa el resultado de un entrenamiento.</p>
        <div class="metric-chart"><canvas baseChart [data]="data" [options]="options" [type]="'scatter'"></canvas></div>
      </ng-container>
      <ng-template #direct>
        <ng-container [ngSwitch]="type">
          <ng-container *ngSwitchCase="'gps'"><app-comparison-map *ngIf="r.gps as gps" [tracks]="gps.tracks" [hidden]="hidden"></app-comparison-map><p *ngIf="!r.gps">No hay datos GPS en este cálculo.</p></ng-container>
          <app-comparison-diagnostics *ngSwitchCase="'scatter'" [diagnostics]="r.diagnostics||[]" [rows]="r.rows" [hidden]="hidden" kind="scatter"></app-comparison-diagnostics>
          <app-comparison-diagnostics *ngSwitchCase="'bland_altman'" [diagnostics]="r.diagnostics||[]" [rows]="r.rows" [hidden]="hidden" kind="bland_altman"></app-comparison-diagnostics>
          <app-comparison-diagnostics *ngSwitchCase="'ecdf'" [diagnostics]="r.diagnostics||[]" [rows]="r.rows" [hidden]="hidden" kind="ecdf"></app-comparison-diagnostics>
          <ng-container *ngSwitchDefault>
            <ng-container *ngIf="r.configuration.visualization?.layout==='SMALL_MULTIPLES';else overlay">
              <ng-container *ngFor="let panel of panels"><app-comparison-chart *ngIf="!hidden.includes(panel.id)" [time]="r.time||[]" [series]="panel.series" [hidden]="hidden" [title]="panel.name" [error]="type==='error'" [absoluteError]="absoluteError" [band]="band" [yMin]="type==='error'?undefined:yMin" [yMax]="type==='error'?undefined:yMax"></app-comparison-chart></ng-container>
            </ng-container>
            <ng-template #overlay><app-comparison-chart [time]="r.time||[]" [series]="r.series||[]" [hidden]="hidden" [title]="r.configuration.name" [error]="type==='error'" [absoluteError]="absoluteError" [band]="band"></app-comparison-chart></ng-template>
          </ng-container>
        </ng-container>
      </ng-template>
    </ng-container>`,
  styles:[`.metric-chart{height:350px}p{color:var(--ink-3);line-height:1.6}app-comparison-chart{display:block;margin:1rem 0}`],
})
export class ComparisonCardComponent implements OnChanges {
  @Input({required:true}) result!:ComparisonResult;
  data:ChartConfiguration<'scatter'>['data']={datasets:[]};
  options:ChartOptions<'scatter'>={};
  panels:{id:string;name:string;series:NonNullable<ComparisonResult['series']>}[]=[];
  yMin=0;yMax=200;
  get type(){return this.result.configuration.visualization?.chart_type||'hr';}
  get hidden(){return this.result.configuration.visualization?.hidden||[];}
  get metric(){return this.result.configuration.visualization?.benchmark_metric||'mae';}
  get band(){return this.result.configuration.visualization?.error_band||0;}
  get absoluteError(){return this.result.configuration.visualization?.error_view==='ABSOLUTE';}
  get sessionNames(){return this.result.rows.map(r=>`${r.device_name}: ${r.session_name}`).join(' · ');}
  ngOnChanges():void {
    const groups=this.result.groups||[];
    this.data={datasets:groups.map((group,index)=>({label:group.device_name,backgroundColor:deviceColor(group.device_id),pointRadius:6,
      data:this.result.rows.filter(r=>r.device_id===group.device_id&&r.metrics[this.metric]!=null).map(r=>({x:r.metrics[this.metric]!,y:index,sessionName:r.session_name}))}))};
    this.options={responsive:true,maintainAspectRatio:false,animation:false,
      scales:{x:{title:{display:true,text:this.metric}},y:{ticks:{stepSize:1,callback:v=>groups[Number(v)]?.device_name||''}}},
      plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${(ctx.raw as {sessionName:string}).sessionName}: ${ctx.parsed.x?.toLocaleString('es-ES',{maximumFractionDigits:2})??'NO DATA'}`}}}};
    this.panels=this.result.rows.map(row=>({id:row.session_id,name:row.device_name,series:(this.result.series||[]).filter(s=>s.role==='reference'||s.id===row.session_id)}));
    let min=Infinity,max=-Infinity;
    for(const series of this.result.series||[])for(const value of series.values)if(value!=null){min=Math.min(min,value);max=Math.max(max,value);}
    this.yMin=Number.isFinite(min)?Math.floor(min/10)*10:0;this.yMax=Number.isFinite(max)?Math.ceil(max/10)*10+10:200;
  }
}

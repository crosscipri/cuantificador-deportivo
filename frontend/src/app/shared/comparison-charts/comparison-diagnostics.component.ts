import { Component, Input, OnChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { ComparisonDiagnostic, SessionEvidence, deviceColor } from '../../models/comparison.model';
import { downloadCanvasPng, withHighResolutionChartExport } from '../chart-export';

@Component({selector:'app-comparison-diagnostics',standalone:true,imports:[CommonModule,BaseChartDirective],
  template:`<div class="panel"><button (click)="download()">PNG</button><div class="canvas"><canvas baseChart [data]="data" [options]="options" [type]="'scatter'"></canvas></div>
    <p>{{explanation}}</p><p *ngFor="let d of diagnostics">{{name(d.session_id)}}: {{d.n}} pares analíticos · {{d.display_n}} puntos de dispersión.</p></div>`,
  styles:[`.panel{padding:1rem;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface)}.canvas{height:390px}p{color:var(--ink-3);font-size:.85rem}button{padding:.4rem .8rem;cursor:pointer}`]})
export class ComparisonDiagnosticsComponent implements OnChanges {
  @Input() diagnostics:ComparisonDiagnostic[]=[];
  @Input() rows:SessionEvidence[]=[];
  @Input() hidden:string[]=[];
  @Input() kind:'scatter'|'bland_altman'|'ecdf'='scatter';
  @ViewChild(BaseChartDirective) chart?:BaseChartDirective;
  data:ChartConfiguration<'scatter'>['data']={datasets:[]};
  options:ChartOptions<'scatter'>={};
  explanation='';
  name(id:string):string{return this.rows.find(r=>r.session_id===id)?.device_name||id;}
  ngOnChanges():void {
    const titles={scatter:['Referencia (bpm)','Dispositivo (bpm)'],bland_altman:['Media del par (bpm)','Dispositivo − referencia (bpm)'],ecdf:['Error absoluto (bpm)','Pares con error ≤ x (%)']};
    const [x,y]=titles[this.kind];
    this.explanation=this.kind==='ecdf'?'Distribución calculada con todos los pares; se representan hasta 501 puntos de su función acumulada.':this.kind==='bland_altman'?'Bias y límites descriptivos ±1,96 SD. Los segundos no se consideran sujetos independientes ni estos límites intervalos de confianza.':'La diagonal indica identidad. La asociación no equivale a acuerdo; CCC y Pearson se consultan por separado.';
    this.data={datasets:this.diagnostics.filter(d=>!this.hidden.includes(d.session_id)).map(d=>{
      const row=this.rows.find(r=>r.session_id===d.session_id);
      return {label:this.name(d.session_id),data:d[this.kind],pointRadius:this.kind==='ecdf'?0:2,
        showLine:this.kind==='ecdf',borderWidth:1.6,borderColor:deviceColor(row?.device_id||d.session_id),backgroundColor:deviceColor(row?.device_id||d.session_id)};
    })};
    const points=this.data.datasets.flatMap(d=>d.data as {x:number;y:number}[]);
    if(points.length&&this.kind==='scatter'){
      const low=Math.min(...points.flatMap(p=>[p.x,p.y])),high=Math.max(...points.flatMap(p=>[p.x,p.y]));
      this.data.datasets.push({label:'Identidad',data:[{x:low,y:low},{x:high,y:high}],showLine:true,pointRadius:0,borderColor:'#71717a',borderDash:[5,5]});
    }
    if(points.length&&this.kind==='bland_altman'){
      const low=Math.min(...points.map(p=>p.x)),high=Math.max(...points.map(p=>p.x));
      for(const row of this.rows.filter(r=>!this.hidden.includes(r.session_id))){
        for(const key of ['bias','loa_lower','loa_upper']){
          const level=row.metrics[key];if(level==null)continue;
          this.data.datasets.push({label:`${row.device_name} · ${key}`,data:[{x:low,y:level},{x:high,y:level}],showLine:true,pointRadius:0,borderColor:deviceColor(row.device_id),borderDash:key==='bias'?[]:[4,4],borderWidth:1});
        }
      }
    }
    this.options={responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{title:{display:true,text:x}},y:{title:{display:true,text:y},...(this.kind==='ecdf'?{min:0,max:100}:{})}},plugins:{legend:{display:true}}};
  }
  download():void{const chart=this.chart?.chart;if(chart)withHighResolutionChartExport(chart,c=>downloadCanvasPng(c,`${this.kind}-comparativa.png`));}
}

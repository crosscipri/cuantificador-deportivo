import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { ComparisonService } from '../../services/comparison.service';
import { ApiService } from '../../services/api.service';
import { ComparisonResult, ComparisonWorkspace, SavedComparison, WorkspaceChart } from '../../models/comparison.model';
import { ComparisonsComponent } from './comparisons.component';
import { ComparisonCardComponent } from './comparison-card.component';
import { ComparisonArchiveComponent } from '../../shared/comparison-charts/comparison-archive.component';
import { ComparisonSleepComponent } from '../../shared/comparison-charts/comparison-sleep.component';

@Component({
  selector:'app-comparison-workspace', standalone:true,
  imports:[CommonModule,FormsModule,RouterModule,ComparisonsComponent,ComparisonCardComponent,ComparisonArchiveComponent,ComparisonSleepComponent],
  templateUrl:'./comparison-workspace.component.html', styleUrls:['./comparisons.component.scss'],
})
export class ComparisonWorkspaceComponent implements OnInit {
  private destroyRef=inject(DestroyRef);
  name='';items:ComparisonWorkspace[]=[];active:ComparisonWorkspace|null=null;
  legacy:SavedComparison[]=[];devices:{id:string;name:string}[]=[];
  tab:'training'|'archive'|'sleep'='training';
  busy=false;editorBusy=false;loading=false;more=false;error='';
  editors:{comparisonId:string;chartId:string|null}[]=[];
  results:Record<string,ComparisonResult>={};chartErrors:Record<string,string>={};
  constructor(private api:ComparisonService,private deviceApi:ApiService,private route:ActivatedRoute,private router:Router){}
  ngOnInit():void {
    if(this.route.snapshot.queryParamMap.has('session')||this.route.snapshot.queryParamMap.has('device')){
      this.router.navigate(['/comparisons/calculate'],{queryParams:this.route.snapshot.queryParams,replaceUrl:true});return;
    }
    this.loadList();
    this.api.list().subscribe({next:items=>this.legacy=items,error:e=>this.error=this.message(e)});
    this.deviceApi.listDevices().subscribe({next:items=>this.devices=items,error:e=>this.error=this.message(e)});
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params=>{
      this.active=null;this.editors=[];this.results={};this.chartErrors={};this.error='';
      const id=params.get('workspaceId');
      if(id)this.open(id);
    });
  }
  loadList(more=false):void {
    this.api.workspaces(more?this.items.length:0).subscribe({next:items=>{
      this.items=more?[...this.items,...items]:items;this.more=items.length===50;
    },error:e=>this.error=this.message(e)});
  }
  create():void {
    if(this.busy||!this.name.trim())return;
    this.busy=true;this.error='';
    this.api.createWorkspace(this.name.trim()).subscribe({next:item=>{
      this.busy=false;this.name='';this.loadList();this.router.navigate(['/comparisons/workspaces',item.id]);
    },error:e=>{this.busy=false;this.error=this.message(e);}});
  }
  open(id:string):void {
    this.loading=true;
    this.api.workspace(id).subscribe({next:item=>{
      if(this.route.snapshot.paramMap.get('workspaceId')!==id)return;
      this.active=item;this.loading=false;
      if(!item.charts.length)this.addChart();
      for(const chart of item.charts)this.loadChart(chart,item.id);
    },error:e=>{this.loading=false;this.error=this.message(e);}});
  }
  loadChart(chart:WorkspaceChart,workspaceId=this.active?.id):void {
    delete this.chartErrors[chart.id];
    this.api.get(chart.comparison_id).subscribe({next:r=>{
      if(this.active?.id===workspaceId)this.results[chart.id]=r.result;
    },error:e=>{if(this.active?.id===workspaceId)this.chartErrors[chart.id]=this.message(e);}});
  }
  addChart():void {if(!this.editorBusy)this.editors=[{comparisonId:'',chartId:null}];}
  editChart(chart:WorkspaceChart):void {if(!this.editorBusy)this.editors=[{comparisonId:chart.comparison_id,chartId:chart.id}];}
  saved(event:{chart:WorkspaceChart;result:ComparisonResult}):void {
    if(!this.active)return;
    const exists=this.active.charts.some(c=>c.id===event.chart.id);
    this.active={...this.active,charts:exists?this.active.charts.map(c=>c.id===event.chart.id?event.chart:c):[...this.active.charts,event.chart]};
    this.results[event.chart.id]=event.result;delete this.chartErrors[event.chart.id];
    this.editors=[];this.editorBusy=false;this.loadList();
  }
  message(error:any):string {return typeof error.error?.detail==='string'?error.error.detail:'No se ha podido cargar o guardar la comparativa. Inténtalo de nuevo.';}
}

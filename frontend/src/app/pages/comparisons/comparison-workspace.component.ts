import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { ComparisonService } from '../../services/comparison.service';
import { ApiService } from '../../services/api.service';
import { ComparisonAnalysisMode, ComparisonResult, ComparisonWorkspace, SavedComparison, WorkspaceChart } from '../../models/comparison.model';
import { ComparisonsComponent } from './comparisons.component';
import { ComparisonCardComponent } from './comparison-card.component';
import { ComparisonArchiveComponent } from '../../shared/comparison-charts/comparison-archive.component';
import { ComparisonSleepComponent } from '../../shared/comparison-charts/comparison-sleep.component';
import { ComparisonSportsComponent } from './comparison-sports.component';

@Component({
  selector:'app-comparison-workspace', standalone:true,
  imports:[CommonModule,FormsModule,RouterModule,ComparisonsComponent,ComparisonCardComponent,ComparisonArchiveComponent,ComparisonSleepComponent,ComparisonSportsComponent],
  templateUrl:'./comparison-workspace.component.html', styleUrls:['./comparisons.component.scss'],
})
export class ComparisonWorkspaceComponent implements OnInit {
  private destroyRef=inject(DestroyRef);
  name='';items:ComparisonWorkspace[]=[];active:ComparisonWorkspace|null=null;
  deviceIds:string[]=[];
  analysisMode:ComparisonAnalysisMode='ALL';
  reports:{devices:{id:string;name:string}[]}[]=[];
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
    this.deviceApi.listDevices().subscribe({next:items=>{this.devices=items;this.updateReport();},error:e=>this.error=this.message(e)});
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params=>{
      this.active=null;this.deviceIds=[];this.analysisMode='ALL';this.reports=[];this.editors=[];this.results={};this.chartErrors={};this.error='';
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
    if(this.busy||!this.name.trim()||this.deviceIds.length<2)return;
    this.busy=true;this.error='';
    this.api.createWorkspace(this.name.trim(),this.deviceIds,this.analysisMode).subscribe({next:item=>{
      this.busy=false;this.name='';this.loadList();this.router.navigate(['/comparisons/workspaces',item.id]);
    },error:e=>{this.busy=false;this.error=this.message(e);}});
  }
  open(id:string):void {
    this.loading=true;
    this.api.workspace(id).subscribe({next:item=>{
      if(this.route.snapshot.paramMap.get('workspaceId')!==id)return;
      item.session_pairs ||= {};
      item.sport_selections ||= {};
      this.analysisMode=item.analysis_mode||'ALL';
      this.active=item;this.loading=false;
      this.deviceIds=[...(item.device_ids||[])];this.updateReport();
      for(const chart of item.charts)this.loadChart(chart,item.id);
    },error:e=>{this.loading=false;this.error=this.message(e);}});
  }
  toggleDevice(id:string):void {
    if(this.deviceIds.includes(id))this.deviceIds=this.deviceIds.filter(d=>d!==id);
    else if(this.deviceIds.length<8)this.deviceIds=[...this.deviceIds,id];
  }
  updateReport():void {
    const ids=this.active?.device_ids||[];
    const devices=ids.map(id=>this.devices.find(d=>d.id===id)).filter((d):d is {id:string;name:string}=>!!d);
    this.reports=devices.length>=2?[{devices}]:[];
  }
  saveDevices():void {
    if(!this.active||this.busy||this.deviceIds.length<2)return;
    this.busy=true;this.error='';
    this.api.setWorkspaceDevices(this.active.id,this.deviceIds,this.analysisMode).subscribe({next:item=>{
      item.session_pairs ||= {};
      item.sport_selections ||= {};
      this.active=item;this.busy=false;this.updateReport();this.loadList();
    },error:e=>{this.busy=false;this.error=this.message(e);}});
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

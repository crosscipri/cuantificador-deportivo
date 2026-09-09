import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { ComparisonService } from '../../services/comparison.service';
import { ApiService } from '../../services/api.service';
import { ComparisonResult, ComparisonSelection, ComparisonSeries, ComparisonSession, Experiment, SavedComparison, StatisticDefinition, deviceColor } from '../../models/comparison.model';
import { ComparisonChartComponent } from '../../shared/comparison-charts/comparison-chart.component';
import { ComparisonMapComponent } from '../../shared/comparison-charts/comparison-map.component';
import { ComparisonDiagnosticsComponent } from '../../shared/comparison-charts/comparison-diagnostics.component';
import { ComparisonContextComponent } from '../../shared/comparison-charts/comparison-context.component';
import { ComparisonArchiveComponent } from '../../shared/comparison-charts/comparison-archive.component';
import { ComparisonSleepComponent } from '../../shared/comparison-charts/comparison-sleep.component';

@Component({selector:'app-comparisons',standalone:true,
  imports:[CommonModule,FormsModule,RouterModule,BaseChartDirective,ComparisonChartComponent,ComparisonMapComponent,ComparisonDiagnosticsComponent,ComparisonContextComponent,ComparisonArchiveComponent,ComparisonSleepComponent],
  templateUrl:'./comparisons.component.html',styleUrls:['./comparisons.component.scss']})
export class ComparisonsComponent implements OnInit {
  selection:ComparisonSelection=this.defaults();
  devices:{id:string;name:string}[]=[];
  sessions:ComparisonSession[]=[];saved:SavedComparison[]=[];experiments:Experiment[]=[];
  definitions:StatisticDefinition[]=[];protocols:{id:string;name:string;version:number}[]=[];
  result:ComparisonResult|null=null;busy=false;loading=false;errorMessage='';notice='';savedId='';
  deviceFilter='';sportFilter='';difficultyFilter='';hasMore=false;offset=0;
  hidden:string[]=[];tab:'hr'|'gps'='hr';metric='mae';band:0|3|5|10=0;experimentName='';experimentProtocol='';
  gpsErrorSeries:ComparisonSeries[]=[];cursorSec:number|null=null;
  layout:'OVERLAY'|'SMALL_MULTIPLES'='OVERLAY';diagnostic:'scatter'|'bland_altman'|'ecdf'='scatter';
  intervalName='';intervalStart=0;intervalEnd=60;exclusionReason='';
  yMin=0;yMax=200;
  heatmapSources:string[]=[];
  revisionParent='';revisions:SavedComparison[]=[];savedOffset=0;savedMore=false;
  gpsColorByError=false;
  workspace:'hr'|'archive'|'sleep'='hr';
  channelInfo:{native_points:number;native_median_step_seconds:number|null;channels:string[];laps:{index:number;start_utc:number|null;end_utc:number|null;distance_m:number|null;duration_seconds:number|null}[];records:unknown[];has_more:boolean}|null=null;
  channelOffset=0;
  smallSeries:Record<string,ComparisonSeries[]>={};
  errorView:'SIGNED'|'ABSOLUTE'='SIGNED';
  sidePanels:{session_id:string;name:string;time:number[];series:ComparisonSeries[]}[]=[];
  selectedExperimentId='';hrQuality:string|null=null;gpsQuality:string|null=null;referenceNotes='';
  referenceQualities=['GOLD_STANDARD','RESEARCH_GRADE','VALIDATED_REFERENCE','PRACTICAL_REFERENCE','COMPARATIVE_REFERENCE'];
  dots:ChartConfiguration<'scatter'>['data']={datasets:[]};
  dotOptions:ChartOptions<'scatter'>={responsive:true,maintainAspectRatio:false,animation:false,
    scales:{x:{title:{display:true,text:'Error por sesión'}},y:{ticks:{stepSize:1,callback:v=>this.result?.groups?.[Number(v)]?.device_name||''}}},
    plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>{
      const row=this.result?.rows.filter(r=>r.device_id===this.result?.groups?.[ctx.datasetIndex]?.device_id&&r.metrics[this.metric]!=null)[ctx.dataIndex];
      return `${row?.session_name}: ${this.number(ctx.parsed.x)}`;
    }}}},
    onClick:(_event,elements)=>{
      const e=elements[0];if(!e)return;
      const row=this.result?.rows.filter(r=>r.device_id===this.result?.groups?.[e.datasetIndex]?.device_id&&r.metrics[this.metric]!=null)[e.index];
      if(row)this.router.navigateByUrl(row.source_url);
    }};
  constructor(private api:ComparisonService,private legacy:ApiService,private route:ActivatedRoute,private router:Router){}
  defaults():ComparisonSelection{return{name:'Nueva comparativa',mode:'DIRECT',session_ids:[],reference_session_id:null,
    gps_reference_session_id:null,assume_same_workout:false,offsets:{},interpolation:'NONE',max_interpolation_gap:5,
    source_resolution:'EPOCH_SECOND_MEAN',sampling_hz:1,
    start_sec:null,end_sec:null,protocol_id:null,protocol_version:null,benchmark_method:'LEGACY',
    exclusions:[],intervals:[],advanced:{enabled:false,lag_max_seconds:30,intensity_bounds:[110,140,170]},
    aggregation:'SESSION',manual_weights:{},uncertainty:{enabled:false,repetitions:1000,seed:2026,confidence:.95},
    storage_mode:'SNAPSHOT',selection_policy:'EXPLICIT',filters:{device_ids:[],sport_type:null,session_difficulty:null,date_from:null,date_to:null,firmware:null,participant_id:null}};}
  ngOnInit():void {
    this.legacy.listDevices().subscribe({next:d=>this.devices=d,error:e=>this.fail(e)});
    this.api.definitions().subscribe({next:d=>{this.definitions=d.statistics;if(!this.protocols.length)this.protocols=d.protocols;},error:e=>this.fail(e)});
    this.loadSessions();this.refreshLists();
    this.route.paramMap.subscribe(p=>{const id=p.get('comparisonId');if(id)this.open(id);});
    const sid=this.route.snapshot.queryParamMap.get('session');
    if(sid){this.selection.session_ids=[sid];this.selection.reference_session_id=sid;this.loadSelectedSessions();}
    const dev=this.route.snapshot.queryParamMap.get('device');
    if(dev){this.selection.mode='BENCHMARK';this.deviceFilter=dev;}
  }
  refreshLists():void {
    this.api.protocols().subscribe({next:p=>this.protocols=p,error:e=>this.fail(e)});
    this.api.list().subscribe({next:s=>{this.saved=s;this.savedOffset=s.length;this.savedMore=s.length===50;},error:e=>this.fail(e)});
    this.api.experiments().subscribe({next:e=>this.experiments=e,error:e=>this.fail(e)});
  }
  loadSessions():void {
    this.loading=true;this.api.sessions(this.offset).subscribe({next:r=>{
      this.sessions=[...new Map([...this.sessions,...r.items].map(s=>[s.id,s])).values()];this.offset+=r.items.length;this.hasMore=r.has_more;this.loading=false;
    },error:e=>{this.loading=false;this.fail(e);}});
  }
  get visibleSessions():ComparisonSession[]{return this.sessions.filter(s=>(!this.deviceFilter||s.device_id===this.deviceFilter)&&
    (!this.sportFilter||s.sport_type===this.sportFilter)&&(!this.difficultyFilter||s.session_difficulty===this.difficultyFilter)&&
    (!this.selection.protocol_id||s.protocol_id===this.selection.protocol_id)&&(!this.selection.protocol_version||s.protocol_version===this.selection.protocol_version)&&
    (!this.selection.filters.firmware||s.firmware===this.selection.filters.firmware)&&(!this.selection.filters.participant_id||s.participant_id===this.selection.filters.participant_id)&&
    (!this.selection.filters.date_from||!!s.activity_date&&s.activity_date.slice(0,10)>=this.selection.filters.date_from)&&(!this.selection.filters.date_to||!!s.activity_date&&s.activity_date.slice(0,10)<=this.selection.filters.date_to));}
  get protocolChoices(){return [...new Map(this.protocols.map(p=>[p.id,p])).values()];}
  get protocolVersions():number[]{return this.protocols.filter(p=>p.id===this.selection.protocol_id).map(p=>p.version);}
  get selectedSessions():ComparisonSession[]{return this.sessions.filter(s=>this.selection.session_ids.includes(s.id));}
  get currentMetric():StatisticDefinition|undefined{return this.definitions.find(d=>d.id===this.metric);}
  get visibleSeriesOptions():{id:string;name:string;role:string}[]{return this.tab==='gps'?(this.result?.gps?.tracks||[]):(this.result?.series||[]);}
  loadSelectedSessions():void {
    if(!this.selection.session_ids.length)return;
    this.api.selectedSessions(this.selection.session_ids).subscribe({next:r=>{
      this.sessions=[...new Map([...this.sessions,...r.items].map(s=>[s.id,s])).values()];
    },error:e=>this.fail(e)});
  }
  toggle(s:ComparisonSession):void {
    this.selectedExperimentId='';
    const ids=this.selection.session_ids;
    if(ids.includes(s.id)){this.selection.session_ids=ids.filter(id=>id!==s.id);delete this.selection.offsets[s.id];delete this.selection.manual_weights[s.id];}
    else{
      if(this.selection.mode==='DIRECT'){
        const existing=this.sessions.find(x=>x.device_id===s.device_id&&ids.includes(x.id));
        if(existing){this.selection.session_ids=ids.filter(id=>id!==existing.id);delete this.selection.offsets[existing.id];}
      }
      this.selection.session_ids=[...this.selection.session_ids,s.id];
      this.selection.manual_weights[s.id]=1;
    }
    if(!this.selection.reference_session_id||!this.selection.session_ids.includes(this.selection.reference_session_id))this.selection.reference_session_id=this.selection.session_ids[0]||null;
    if(this.selection.gps_reference_session_id&&!this.selection.session_ids.includes(this.selection.gps_reference_session_id))this.selection.gps_reference_session_id=null;
    this.invalidate();
  }
  modeChanged():void {this.selection.session_ids=[];this.selection.offsets={};this.selection.start_sec=null;this.selection.end_sec=null;
    this.selectedExperimentId='';
    this.selection.exclusions=[];this.selection.intervals=[];this.selection.manual_weights={};
    this.selection.selection_policy='EXPLICIT';
    this.selection.reference_session_id=null;this.selection.gps_reference_session_id=null;this.invalidate();}
  invalidate():void{this.result=null;this.savedId='';this.notice='';this.hidden=this.hidden.filter(id=>this.selection.session_ids.includes(id)||id==='reference'||id==='gps-reference');}
  selectAllVisible():void {for(const s of this.visibleSessions)if(!this.selection.session_ids.includes(s.id))this.toggle(s);}
  chooseExperiment(id:string):void {
    const exp=this.experiments.find(e=>e.id===id);if(!exp){this.selectedExperimentId='';return;}
    this.selectedExperimentId=id;this.hrQuality=exp.references?.['hr']?.quality||null;this.gpsQuality=exp.references?.['gps']?.quality||null;
    this.selection={...this.defaults(),name:exp.name,session_ids:[...exp.session_ids],reference_session_id:exp.reference_session_id,
      gps_reference_session_id:exp.gps_reference_session_id||null,assume_same_workout:true};
    this.invalidate();
    this.loadSelectedSessions();
  }
  createExperiment():void {
    if(!this.experimentName.trim()||!this.selection.reference_session_id)return;
    const [protocolId,protocolVersion]=this.experimentProtocol.split('@');
    this.busy=true;this.api.createExperiment({name:this.experimentName,session_ids:this.selection.session_ids,
      reference_session_id:this.selection.reference_session_id,gps_reference_session_id:this.selection.gps_reference_session_id,
      protocol_id:protocolId||null,protocol_version:Number(protocolVersion)||1}).subscribe({next:e=>{
        this.busy=false;this.experiments=[e,...this.experiments];this.selectedExperimentId=e.id;
        this.sessions=this.sessions.map(s=>e.session_ids.includes(s.id)?{...s,experiment_id:e.id,protocol_id:e.protocol_id,protocol_version:e.protocol_version}:s);
        this.notice='Experimento creado. Asociación declarada por el usuario.';
      },error:e=>{this.busy=false;this.fail(e);}});
  }
  calculate(save=false):void {
    this.busy=true;this.errorMessage='';this.notice='';
    this.selection.filters.date_from||=null;this.selection.filters.date_to||=null;
    if(this.tab==='gps'||this.selection.advanced.gps_geometry)this.selection.gps_enabled=true;
    this.captureVisualization();
    if(this.selection.mode==='BENCHMARK')this.selection.offsets={};
    if(save)(this.revisionParent?this.api.revise(this.revisionParent,this.selection):this.api.save(this.selection)).subscribe({next:r=>{this.savedId=r.id;this.revisionParent=r.id;this.accept(r.result);this.notice=`Comparativa ${this.selection.storage_mode} guardada; versiones anteriores conservadas.`;this.refreshLists();},error:e=>{this.busy=false;this.fail(e);}});
    else this.api.preview(this.selection).subscribe({next:r=>this.accept(r),error:e=>{this.busy=false;this.fail(e);}});
  }
  accept(result:ComparisonResult):void {
    const view=result.configuration.visualization;
    this.hidden=[...(view?.hidden||[])];this.tab=view?.tab||'hr';this.band=view?.error_band||0;this.metric=view?.benchmark_metric||'mae';
    this.layout=view?.layout||'OVERLAY';this.diagnostic=view?.diagnostic||'scatter';this.errorView=view?.error_view||'SIGNED';this.sidePanels=[];
    let min=Infinity,max=-Infinity;for(const s of result.series||[])for(const v of s.values)if(v!=null){min=Math.min(min,v);max=Math.max(max,v);}
    this.yMin=Number.isFinite(min)?Math.floor(min/10)*10:0;this.yMax=Number.isFinite(max)?Math.ceil(max/10)*10+10:200;
    this.result=result;this.busy=false;this.cursorSec=null;this.buildDots();
    this.smallSeries=Object.fromEntries(result.rows.map(row=>[row.session_id,(result.series||[]).filter(s=>s.role==='reference'||s.id===row.session_id)]));
    this.gpsErrorSeries=(result.gps?.rows||[]).map(row=>({id:row['session_id'],device_id:result.rows.find(r=>r.session_id===row['session_id'])?.device_id,
      name:row['device_name'],role:'device',values:row['position_errors']||[]}));
  }
  open(id:string):void {
    this.selectedExperimentId='';this.channelInfo=null;this.revisions=[];this.heatmapSources=[];
    this.busy=true;this.errorMessage='';this.api.get(id).subscribe({next:r=>{this.selection={...this.defaults(),...(r.selection_request||r.result.configuration)};this.selection.session_ids=r.result.rows.map(row=>row.session_id);this.savedId=id;this.revisionParent=id;this.accept(r.result);this.loadSelectedSessions();this.api.revisions(id).subscribe({next:items=>this.revisions=items,error:e=>this.fail(e)});},error:e=>{this.busy=false;this.fail(e);}});
  }
  newComparison():void {this.selection=this.defaults();this.hidden=[];this.tab='hr';this.band=0;this.metric='mae';this.revisionParent='';this.revisions=[];this.selectedExperimentId='';this.channelInfo=null;this.sidePanels=[];this.invalidate();this.router.navigate(['/comparisons']);}
  toggleSeries(id:string):void {this.hidden=this.hidden.includes(id)?this.hidden.filter(x=>x!==id):[...this.hidden,id];}
  buildDots():void {
    this.dots={datasets:(this.result?.groups||[]).map((group,index)=>({label:group.device_name,backgroundColor:deviceColor(group.device_id),pointRadius:6,
      data:(this.result?.rows||[]).filter(r=>r.device_id===group.device_id&&r.metrics[this.metric]!=null).map(r=>({x:r.metrics[this.metric]!,y:index}))}))};
    this.dotOptions={...this.dotOptions,scales:{...this.dotOptions.scales,x:{title:{display:true,text:`${this.currentMetric?.name||this.metric} (${this.currentMetric?.unit||''})`}}}};
  }
  number(value:unknown):string{return typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('es-ES',{maximumFractionDigits:1}):'NO DATA';}
  private captureVisualization():void {
    this.selection.visualization={hidden:[...this.hidden],tab:this.tab,error_band:this.band,benchmark_metric:this.metric,layout:this.layout,diagnostic:this.diagnostic,error_view:this.errorView};
  }
  addInterval(exclude=false):void {
    if(!this.intervalName.trim()||!Number.isFinite(this.intervalStart)||!Number.isFinite(this.intervalEnd)||this.intervalStart<0||this.intervalEnd<=this.intervalStart){this.errorMessage='Introduce un nombre y un intervalo válido.';return;}
    if(exclude&&this.exclusionReason.trim().length<3){this.errorMessage='Explica el motivo de la exclusión.';return;}
    const item={name:this.intervalName,start_sec:this.intervalStart,end_sec:this.intervalEnd};
    if(exclude)this.selection.exclusions.push({...item,reason:this.exclusionReason});else this.selection.intervals.push(item);
    this.errorMessage='';this.invalidate();
  }
  deviceSeries(id:string):ComparisonSeries[]{return this.smallSeries[id]||[];}
  get heatmapCategories():string[]{return [...new Set((this.result?.heatmap||[]).map(c=>`${c.category}${c.protocol_version?' v'+c.protocol_version:''}`))];}
  heatmapCell(category:string,device:string){return this.result?.heatmap?.find(c=>`${c.category}${c.protocol_version?' v'+c.protocol_version:''}`===category&&c.device_id===device);}
  heatmapColor(value:number|null|undefined):string {
    if(value==null)return 'transparent';
    const values=(this.result?.heatmap||[]).map(c=>c.metrics[this.metric]?.median).filter((v):v is number=>v!=null);
    const max=Math.max(...values.map(Math.abs),1),min=Math.min(...values,0);
    const t=this.metric==='bias'?Math.min(1,Math.abs(value)/max):(value-min)/(Math.max(...values,1)-min||1);
    const hue=this.metric==='bias'?(value<0?215:20):210-180*t;
    return `hsla(${hue},70%,65%,${.15+.4*t})`;
  }
  loadMoreSaved():void{this.api.list(this.savedOffset).subscribe({next:s=>{this.saved=[...this.saved,...s];this.savedOffset+=s.length;this.savedMore=s.length===50;},error:e=>this.fail(e)});}
  dynamicDevice(id:string):void{const ids=this.selection.filters.device_ids;this.selection.filters.device_ids=ids.includes(id)?ids.filter(d=>d!==id):[...ids,id];this.invalidate();}
  inspectChannels(id:string,reference=false):void{this.api.channels(id,reference?'reference':'device').subscribe({next:data=>{this.channelInfo=data;this.channelOffset=reference?0:this.selection.offsets[id]||0;},error:e=>this.fail(e)});}
  useLaps():void{
    if(!this.channelInfo||!this.result?.window)return;
    const start=this.result.window.full_start_utc,end=this.result.window.end_utc,offset=this.channelOffset;
    this.selection.intervals=this.channelInfo.laps.filter(l=>l.start_utc!=null&&l.end_utc!=null&&l.end_utc+offset>start&&l.start_utc+offset<end).slice(0,30).map(l=>({name:`Vuelta ${l.index}`,start_sec:Math.max(0,l.start_utc!+offset-start),end_sec:Math.min(end,l.end_utc!+offset)-start})).filter(l=>l.end_sec>l.start_sec);
    this.invalidate();
  }
  selectChartInterval(range:{start:number;end:number}):void{this.selection.start_sec=range.start;this.selection.end_sec=range.end;this.invalidate();this.calculate();}
  showGps():void{this.tab='gps';if(this.result&&!this.result.gps){this.selection.gps_enabled=true;this.invalidate();this.calculate();}}
  updateReferences():void{
    if(!this.selectedExperimentId||!this.selection.reference_session_id)return;this.busy=true;
    this.api.updateReferences(this.selectedExperimentId,{reference_session_id:this.selection.reference_session_id,gps_reference_session_id:this.selection.gps_reference_session_id,hr_quality:this.hrQuality,gps_quality:this.gpsQuality,notes:this.referenceNotes}).subscribe({next:()=>{this.busy=false;this.invalidate();this.refreshLists();this.notice='Referencias actualizadas con historial; los snapshots anteriores conservan su evidencia.';},error:e=>{this.busy=false;this.fail(e);}});
  }
  togglePanel(id:string):void{if(this.sidePanels.some(p=>p.session_id===id)){this.sidePanels=this.sidePanels.filter(p=>p.session_id!==id);return;}if(this.sidePanels.length>=4){this.notice='Máximo cuatro gráficas fuente lado a lado.';return;}this.api.historicalChart(id).subscribe({next:p=>{if(!this.sidePanels.some(x=>x.session_id===id)&&this.sidePanels.length<4)this.sidePanels=[...this.sidePanels,p];},error:e=>this.fail(e)});}
  exportJson():void{if(this.result){this.captureVisualization();this.download(JSON.stringify({comparison_id:this.savedId||null,...this.result,
    exported_visualization:this.selection.visualization},null,2),'application/json','comparativa.json');}}
  exportCsv():void{
    if(!this.result)return;
    const keys=['session_id','device_name','session_name','reference_name','analysis_revision_id','processing_version'];
    const metricKeys=[...new Set(['n','expected_pairs','excluded_pairs','planned_pairs','observed_pairs','interpolated_pairs',...this.definitions.map(d=>d.id)])];
    const quote=(v:unknown)=>this.csvCell(v);
    const lines=[['device_id',...keys,...metricKeys].map(quote).join(',')];
    for(const row of this.result.rows)lines.push([row.device_id,...keys.map(k=>(row as unknown as Record<string,unknown>)[k]),...metricKeys.map(k=>row.metrics[k])].map(quote).join(','));
    this.download(lines.join('\r\n'),'text/csv;charset=utf-8','metricas-comparativa.csv');
  }
  exportGpsCsv():void {
    if(!this.result?.gps)return;
    const keys=['session_id','device_name','analysis_revision_id','derived_distance_m','reference_distance_m',
      'distance_error_m','distance_error_percent','position_mean_m','position_median_m','position_rmse_m',
      'position_p95_m','position_max_m','position_pairs','position_coverage_percent','point_count',
      'gps_gap_count','longest_gps_gap','segment_break_count','untimed_point_count','recorded_distance_m',
      'reference_recorded_distance_m','recorded_distance_error_m','recorded_distance_error_percent',
      'distance_start_utc','distance_end_utc','recorded_distance_basis','recorded_distance_unavailable_reason',
      'cross_track_mean_m','cross_track_p95_m','cross_track_max_m','geometry_n','along_track_bias_m',
      'along_track_mae_m','along_track_n','ambiguous_projection_n','geometry_method','geometry_reason'];
    const lines=[keys.map(k=>this.csvCell(k)).join(',')];
    for(const row of this.result.gps.rows)lines.push(keys.map(k=>this.csvCell(row[k])).join(','));
    this.download(lines.join('\r\n'),'text/csv;charset=utf-8','metricas-gps-comparativa.csv');
  }
  private csvCell(value:unknown):string {
    let text=String(value??'');
    if(typeof value==='string'&&/^[=+@\-\t\r]/.test(text))text="'"+text;
    return `"${text.replace(/"/g,'""')}"`;
  }
  download(data:string,type:string,name:string):void{const url=URL.createObjectURL(new Blob([data],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  fail(error:HttpErrorResponse):void{const detail=error.error?.detail;this.errorMessage=typeof detail==='string'?detail:detail?JSON.stringify(detail):'No se ha podido conectar con la API.';}
}

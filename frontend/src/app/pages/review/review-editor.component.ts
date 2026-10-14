import { Component, ElementRef, HostListener, OnDestroy, OnInit, QueryList, ViewChildren } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ReviewService, ReviewBlock, EvidenceRef, newBlock, fcReviewMembers, fcReviewGroups, FC_SPORTS, FCSport } from '../../services/review.service';
import { RichTextComponent } from '../../shared/review/rich-text.component';
import { ReviewRendererComponent } from '../../shared/review/review-renderer.component';
import { SCORE_DIMENSIONS, ScoreKey, emptyReviewScores, deviceReviewScores, reviewScoreSummary } from '@cuantificador/review-renderer/scores';

@Component({selector:'app-review-editor',standalone:true,imports:[CommonModule,FormsModule,RouterModule,RichTextComponent,ReviewRendererComponent],
  templateUrl:'./review-editor.component.html',styleUrls:['./review-editor.component.scss']})
export class ReviewEditorComponent implements OnInit,OnDestroy {
  id='';state:any=null;draft:any=null;profile:any=null;media:any[]=[];sources:any[]=[];devices:any[]=[];history:any[]=[];
  boundSources:any[]=[];
  loading=true;missing=false;busy=false;dirty=false;profileDirty=false;conflict=false;status='Guardado';error='';
  tab='Artículo';tabs=['Artículo','Medios','Gráficas y resultados','SEO y enlaces','Historial'];
  profileConflict=false;remoteProfile:any=null;
  batchSelection=new Set<string>();batchVisuals=['temporal','map'];batchCorrelation=true;previewToken:string|null=null;
  preview:any=null;previewErrors:string[]=[];mobile=false;remote:any=null;newType='text';
  types=[['text','Texto'],['heading','Título'],['image','Imagen'],['gallery','Galería'],['video','Vídeo'],['chart','Gráfica'],['map','Mapa GPS'],['table','Tabla'],['verdict','Veredicto'],['alternatives','Alternativas'],['purchase','Compra']];
  labels:Record<string,string>={temporal:'Señales temporales',error:'Error',scatter:'Correlación',bland_altman:'Bland–Altman',table:'Tabla de resultados',map:'Mapa GPS',distribution:'Distribución acumulada del error'};
  private seq=0;private timer?:ReturnType<typeof setTimeout>;private saving?:Promise<boolean>;
  @ViewChildren('blockElement') blockElements?:QueryList<ElementRef<HTMLElement>>;
  private focusTimer?:ReturnType<typeof setTimeout>;
  readonly scoreDimensions=SCORE_DIMENSIONS;
  scoreSummary=reviewScoreSummary;
  constructor(private api:ReviewService,private route:ActivatedRoute){}
  async ngOnInit():Promise<void>{this.id=this.route.snapshot.paramMap.get('deviceId')!;await this.load();}
  async load():Promise<void>{
    this.loading=true;this.error='';
    try{
      const [profile,media,sources,devices,boundSources]=await Promise.all([this.api.get(this.path('/profile')),this.api.get(this.path('/media')),this.api.get(this.path('/sources')),this.api.get('devices'),this.api.get(this.path('/evidence'))]);
      this.profile=profile;this.media=media;this.sources=sources;this.boundSources=boundSources;this.devices=devices.filter((d:any)=>d.id!==this.id);
      try{this.accept(await this.api.get(this.path()));await this.loadHistory();}catch(e:any){if(e.status===404)this.missing=true;else throw e;}
    }catch(e){this.fail(e);}finally{this.loading=false;}
  }
  path(suffix=''):string{return 'reviews/'+this.id+suffix;}
  acceptResponse(s:any,sequence:number):void{if(sequence===this.seq)this.accept(s);else{this.state=s;this.dirty=true;this.status='Cambios sin guardar';}}
  accept(s:any):void{this.state=s;this.draft=structuredClone(s.draft);this.dirty=false;this.conflict=false;this.missing=false;this.status='Guardado';}
  async create():Promise<void>{await this.action(async()=>this.accept(await this.api.send('POST',this.path())));}
  changed():void{this.seq++;this.dirty=true;this.status='Cambios sin guardar';this.preview=null;this.previewToken=null;clearTimeout(this.timer);if(!this.conflict)this.timer=setTimeout(()=>void this.save(),900);}
  async save():Promise<boolean>{
    clearTimeout(this.timer);if(this.conflict)return false;
    if(this.saving){await this.saving;return this.dirty&&!this.conflict?this.save():!this.dirty;}
    if(!this.dirty)return true;
    this.saving=this.persist();const result=await this.saving;this.saving=undefined;return result;
  }
  private async persist():Promise<boolean>{
    while(this.dirty&&!this.conflict){
      const sequence=this.seq;const copy=structuredClone(this.draft);this.status='Guardando';
      try{const result=await this.api.send('PUT',this.path(),{expected_revision:this.state.revision,draft:copy});this.state=result;
        if(sequence===this.seq){this.dirty=false;this.status='Guardado';} // Keep the editing DOM stable; server sanitizes the saved copy.
      }catch(e:any){this.conflict=this.isConflict(e);this.status='Error al guardar';this.fail(e);return false;}
    }
    return !this.dirty;
  }
  isConflict(e:any):boolean{const message=e?.error?.detail;return e.status===409 && typeof message==='string' && (message.startsWith('Conflicto de edición') || message==='El borrador ha cambiado');}
  fail(e:any):void{const d=e?.error?.detail;this.error=Array.isArray(d)?d.map((x:any)=>typeof x==='string'?x:x.msg||JSON.stringify(x)).join('\n'):typeof d==='string'?d:(e?.message||'No se pudo completar la operación');}
  async action(fn:()=>Promise<unknown>):Promise<void>{if(this.busy)return;this.busy=true;this.error='';try{await fn();}catch(e:any){if(this.isConflict(e))this.conflict=true;if(e.status===409&&e?.error?.detail?.startsWith?.('La ficha ha cambiado'))this.profileConflict=true;this.fail(e);}finally{this.busy=false;}}
  get pending():boolean{return this.dirty || this.profileDirty || this.state?.revision!==this.state?.published_revision || this.profile?.revision!==this.state?.profile_revision || !!this.state?.dependencies_dirty;}
  add():void{this.draft.blocks.push(newBlock(this.newType));this.changed();}
  editConclusion():void{
    let block=this.draft.blocks.find((b:ReviewBlock)=>b.type==='verdict');
    if(!block){block=newBlock('verdict');this.draft.blocks.unshift(block);this.changed();}
    clearTimeout(this.focusTimer);
    this.focusTimer=setTimeout(()=>{
      const element=this.blockElements?.find(ref=>ref.nativeElement.id==='review-block-'+block.id)?.nativeElement;
      element?.scrollIntoView({block:'center'});element?.focus({preventScroll:true});
    });
  }
  setScore(block:ReviewBlock,key:ScoreKey,value:number|null):void{
    block.scores={...(block.scores || emptyReviewScores()),[key]:value ?? null,
      source:'editorial',source_device_id:'',source_device_name:'',captured_at:''};
    this.changed();
  }
  async loadDeviceScores(block:ReviewBlock):Promise<void>{
    await this.action(async()=>{
      const [running,cycling,gym,gps,hrv]=await Promise.all([
        ...['running','cycling','gym'].map(sport=>this.api.get('overview/data?sport_type='+sport)),
        this.api.get('overview/gps-scores'),this.api.get('overview/hrv-scores')]);
      const scores=deviceReviewScores(this.id,running,cycling,gym,gps,hrv);
      if(!reviewScoreSummary(scores).count)throw new Error('El dispositivo todavía no tiene puntuaciones disponibles.');
      scores.source_device_name=this.profile.name;scores.captured_at=new Date().toISOString();
      block.scores=scores;this.changed();
    });
  }
  insertMedia(type:'image'|'gallery',index:number):void{
    if(this.busy)return;
    const block=newBlock(type);
    this.draft.blocks.splice(index,0,block);this.changed();
    clearTimeout(this.focusTimer);
    this.focusTimer=setTimeout(()=>{
      const element=this.blockElements?.find(ref=>ref.nativeElement.id==='review-block-'+block.id)?.nativeElement;
      element?.scrollIntoView({block:'center'});
      element?.focus({preventScroll:true});
    });
  }
  move(i:number,delta:number):void{const j=i+delta;if(j<0||j>=this.draft.blocks.length)return;const b=this.draft.blocks.splice(i,1)[0];this.draft.blocks.splice(j,0,b);this.changed();}
  duplicate(i:number):void{const b=structuredClone(this.draft.blocks[i]);b.id=crypto.randomUUID();this.draft.blocks.splice(i+1,0,b);this.changed();}
  remove(i:number):void{if(confirm('¿Eliminar este bloque del borrador?')){this.draft.blocks.splice(i,1);this.changed();}}
  track(_i:number,b:any):string{return b.id;}
  lines(value:string):string[]{return value.split('\n').filter(x=>x.trim());}
  comma(value:string):string[]{return value.split(',').map(x=>x.trim()).filter(Boolean);}
  rows(value:string):string[][]{return value.split('\n').map(x=>x.split('|').map(c=>c.trim()));}
  tableText(b:ReviewBlock):string{return b.rows.map(r=>r.join(' | ')).join('\n');}
  chooseMedia(b:ReviewBlock,id:string):void{const m=this.media.find(x=>x.id===id);if(!m)return;if(b.type==='gallery'&&b.media.length>=50){this.error='Cada galería admite hasta 50 imágenes';return;}const ref={media_id:id,alt:m.alt,caption:m.caption};if(b.type==='image')b.media=[ref];else b.media.push(ref);this.changed();}
  moveMedia(b:ReviewBlock,i:number,delta:number):void{const j=i+delta;if(j<0||j>=b.media.length)return;const m=b.media.splice(i,1)[0];b.media.splice(j,0,m);this.changed();}
  cover(id:string):void{const m=this.media.find(x=>x.id===id);this.draft.cover={media_id:id,alt:m?.alt||'',caption:''};this.changed();}
  async upload(event:Event,block?:ReviewBlock):Promise<void>{
    const input=event.target as HTMLInputElement;
    const files=Array.from(input.files||[]).slice(0,block?.type==='gallery'?undefined:1);
    if(!files.length||this.busy)return;
    if(files.some(file=>!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5*1024*1024)){
      this.error='Sube JPEG, PNG o WebP de hasta 5 MiB por imagen';input.value='';return;
    }
    if(block?.type==='gallery'&&block.media.length+files.length>50){
      this.error='Cada galería admite hasta 50 imágenes';input.value='';return;
    }
    await this.action(async()=>{
      for(const file of files){
        const fd=new FormData();fd.append('file',file);
        const medium=await this.api.send('POST',this.path('/media'),fd);this.media.push(medium);
        if(block)this.chooseMedia(block,medium.id);
      }
    });input.value='';
  }
  async metadata(m:any):Promise<void>{await this.action(async()=>{await this.api.send('PUT','review-media/'+m.id,{alt:m.alt,caption:m.caption});m.editing=false;this.state.dependencies_dirty=true;this.previewToken=null;});}
  async deleteMedia(m:any):Promise<void>{if(!confirm('¿Quitar esta imagen de la biblioteca? Si está en uso, se impedirá.'))return;await this.action(async()=>{await this.api.send('DELETE','review-media/'+m.id);this.media=this.media.filter(x=>x.id!==m.id);});}
  source(ref:any):any{return this.sources.find(s=>s.source_id===ref?.source_id&&s.kind===ref?.kind);}
  stale(ref:any):boolean{if(ref.kind==='fc_total'){try{
    const members=ref.sport ? fcReviewGroups(this.draft.blocks,this.boundSources).find(g=>g.sport===ref.sport)?.members || [] : fcReviewMembers(this.draft.blocks);
    return JSON.stringify(ref.members)!==JSON.stringify(members);
  }catch{return true;}}const s=this.source(ref);return !!s&&s.revision!==ref.revision;}
  rememberEvidence(e:any):void{if(e.kind==='fc'&&!this.boundSources.some(s=>s.revision===e.revision))this.boundSources.push(e);}
  sourceKey(s:any):string{return s.kind+':'+s.source_id;}
  async selectSource(b:ReviewBlock,key:string):Promise<void>{const s=this.sources.find(x=>this.sourceKey(x)===key);if(!s)return;
    await this.action(async()=>{const ref:EvidenceRef={source_id:s.source_id,kind:s.kind,revision:s.revision,visualization:b.type==='map'?'map':b.type==='table'?'table':s.visualizations.find((v:string)=>!['table','map'].includes(v)),series:s.series.map((x:any)=>x.id),start:null,end:null};
      const e=await this.api.send('POST',this.path('/evidence'),ref);ref.revision=e.revision;this.rememberEvidence(e);b.evidence=ref;this.changed();});
  }
  async updateEvidence(ref:EvidenceRef):Promise<void>{if(ref.kind==='fc_total'){await this.organizeFc();return;}await this.action(async()=>{const e=await this.api.send('POST',this.path('/evidence'),ref);ref.revision=e.revision;this.rememberEvidence(e);this.sources=await this.api.get(this.path('/sources'));this.changed();});}
  toggleSeries(ref:EvidenceRef,id:string,checked:boolean):void{ref.series=checked?[...new Set([...ref.series,id])]:ref.series.filter(x=>x!==id);this.changed();}
  eligibleSources(b:ReviewBlock):any[]{return this.sources.filter(s=>b.type==='map'?s.visualizations.includes('map'):b.type==='table'?s.visualizations.includes('table'):s.visualizations.some((v:string)=>!['table','map'].includes(v))); }
  selected(s:any):boolean{return this.draft.public_results.some((x:any)=>x.kind===s.kind&&x.source_id===s.source_id);}
  async toggleResult(s:any,checked:boolean):Promise<void>{if(!checked){this.draft.public_results=this.draft.public_results.filter((x:any)=>!(x.kind===s.kind&&x.source_id===s.source_id));this.changed();return;}
    await this.action(async()=>{const ref={source_id:s.source_id,kind:s.kind,revision:s.revision,visualization:'table',series:s.series.map((x:any)=>x.id),start:null,end:null};const e=await this.api.send('POST',this.path('/evidence'),ref);ref.revision=e.revision;this.draft.public_results.push(ref);this.changed();});}
  removeVisual(value:string):(v:string)=>boolean{return v=>v!==value;}
  blockLabel(type:string):string{return this.types.find(t=>t[0]===type)?.[1]||type;}
  chartOptions(ref:any):string[]{if(ref.kind==='fc_total')return ['scatter'];return (this.source(ref)?.visualizations||[]).filter((v:string)=>!['table','map',...(ref.kind==='fc'?['scatter','bland_altman']:[])].includes(v));}
  toggleBatch(key:string,checked:boolean):void{if(checked)this.batchSelection.add(key);else this.batchSelection.delete(key);}
  selectAllSources():void{this.batchSelection=new Set(this.sources.map(s=>this.sourceKey(s)));}
  async insertBatch():Promise<void>{await this.action(async()=>{
    let blocks:ReviewBlock[]=[...this.draft.blocks];
    const order=(s:any)=>s.kind==='fc'?Math.max(0,Object.keys(FC_SPORTS).indexOf(s.sport)):3;
    for(const s of this.sources.filter(s=>this.batchSelection.has(this.sourceKey(s))).sort((a,b)=>order(a)-order(b))){
      const selected=s.visualizations.filter((v:string)=>this.batchVisuals.includes(v)&&!blocks.some(b=>b.evidence?.kind===s.kind&&b.evidence?.source_id===s.source_id&&b.evidence?.visualization===v));
      if(!selected.length)continue;
      const ref={source_id:s.source_id,kind:s.kind,revision:s.revision,visualization:s.visualizations[0],series:s.series.map((x:any)=>x.id),start:null,end:null};
      const e=await this.api.send('POST',this.path('/evidence'),ref);ref.revision=e.revision;this.rememberEvidence(e);
      const heading=newBlock('heading');heading.level=3;heading.text=s.name+' · '+s.test_type;
      const chunk=[heading];
      for(const v of selected){const block=newBlock(v==='map'?'map':v==='table'?'table':'chart');block.title=s.name+' · '+this.labels[v];block.table_origin='results';block.evidence={...ref,visualization:v};chunk.push(block);}
      let position=-1;
      if(s.kind==='fc'){
        blocks.forEach((b,i)=>{if(b.evidence?.kind==='fc'&&this.boundSources.some(f=>f.revision===b.evidence!.revision&&f.sport===e.sport))position=i+1;});
        if(position<0){const section=newBlock('heading');section.text=FC_SPORTS[e.sport as FCSport] || 'Frecuencia cardíaca';blocks.push(section);}
      }
      blocks.splice(position<0?blocks.length:position,0,...chunk);
    }
    if(this.batchCorrelation&&fcReviewMembers(blocks).length)blocks=await this.withFcTotals(blocks);
    this.draft.blocks=blocks;this.changed();
    this.batchSelection.clear();this.tab='Artículo';
  });}
  get fcCount():number{return new Set((this.draft?.blocks||[]).filter((b:any)=>b.type==='chart'&&b.evidence?.kind==='fc'&&b.evidence?.visualization==='temporal').map((b:any)=>b.evidence.source_id)).size;}
  async organizeFc():Promise<void>{await this.action(async()=>{
    this.draft.blocks=await this.withFcTotals(this.draft.blocks);this.changed();this.tab='Artículo';
  });}
  private async withFcTotals(original:ReviewBlock[]):Promise<ReviewBlock[]>{
    this.boundSources=await this.api.get(this.path('/evidence'));
    const groups=fcReviewGroups(original,this.boundSources);
    if(!groups.length)throw new Error('Inserta al menos una curva FC para crear las correlaciones por deporte.');
    const summaries=[];
    for(const {sport,members} of groups){
      const ref:EvidenceRef={kind:'fc_total',source_id:'total',sport,revision:'',visualization:'scatter',series:['device','reference'],start:null,end:null,members};
      const evidence=await this.api.send('POST',this.path('/evidence'),ref);ref.revision=evidence.revision;
      const previous=original.find(b=>b.evidence?.kind==='fc_total'&&b.evidence.sport===sport);
      const block=previous?structuredClone(previous):newBlock('chart');block.evidence=ref;
      if(!previous){block.title='Correlación de '+FC_SPORTS[sport];block.explanation='Todos los pares guardados de las pruebas de este deporte, sin unir sus curvas temporales ni mezclar otros deportes.';}
      summaries.push({sport,members,block});
    }
    const blocks=original.filter(b=>!/^fc-total-summary(?:-(running|cycling|gym))?$/.test(b.id)&&b.evidence?.kind!=='fc_total'&&!(b.type==='chart'&&b.evidence?.kind==='fc'&&['scatter','bland_altman'].includes(b.evidence.visualization)));
    for(const {sport,members,block} of summaries){
      let position=0;blocks.forEach((b,i)=>{if(b.type==='chart'&&b.evidence?.kind==='fc'&&members.some(m=>m.source_id===b.evidence!.source_id&&m.revision===b.evidence!.revision))position=i+1;});
      const heading=structuredClone(original.find(b=>b.id==='fc-total-summary-'+sport) || newBlock('heading'));
      heading.id='fc-total-summary-'+sport;heading.level=3;heading.text='Correlación conjunta · '+FC_SPORTS[sport];
      blocks.splice(position,0,heading,block);
    }
    return blocks;
  }
  async refreshSources():Promise<void>{await this.action(async()=>{this.sources=await this.api.get(this.path('/sources'));});}
  toggleLink(b:ReviewBlock,id:string,checked:boolean):void{b.link_ids=checked?[...b.link_ids,id]:b.link_ids.filter(x=>x!==id);this.changed();}
  async showPreview():Promise<void>{await this.action(async()=>{if(!await this.save())return;const result=await this.api.send('POST',this.path('/preview'),{expected_revision:this.state.revision});this.preview=result.payload;this.previewErrors=result.errors;this.previewToken=result.preview_token;});}
  async publish():Promise<void>{if(this.profileDirty){this.error='Guarda primero los cambios de la ficha y enlaces';return;}if(!confirm('Se creará una versión accesible públicamente con el artículo, imágenes y pruebas seleccionadas. ¿Publicar?'))return;
    await this.action(async()=>{if(!await this.save())return;const sequence=this.seq;if(!this.previewToken){const validation=await this.api.send('POST',this.path('/preview'),{expected_revision:this.state.revision});if(validation.errors.length){this.preview=validation.payload;this.previewErrors=validation.errors;return;}this.previewToken=validation.preview_token;}this.acceptResponse(await this.api.send('POST',this.path('/publish'),{expected_revision:this.state.revision,preview_token:this.previewToken}),sequence);await this.loadHistory();this.preview=null;});}
  async withdraw():Promise<void>{if(!confirm('Retirar bloqueará las lecturas públicas de esta review, sus imágenes y evidencia. Se conservan borrador e historial; las copias ya descargadas no se pueden revocar. ¿Retirar?'))return;
    await this.action(async()=>{if(!await this.save())return;const sequence=this.seq;this.acceptResponse(await this.api.send('POST',this.path('/withdraw'),{expected_revision:this.state.revision}),sequence);});}
  async loadHistory():Promise<void>{this.history=await this.api.get(this.path('/history'));}
  async inspectVersion(v:any):Promise<void>{await this.action(async()=>{this.preview=await this.api.get(this.path('/history/'+v.version));this.previewErrors=[];});}
  async restore(v:any):Promise<void>{if(!confirm('Se reemplazará el borrador por esta versión. La publicación actual seguirá intacta. ¿Restaurar?'))return;
    await this.action(async()=>{if(!await this.save())return;const sequence=this.seq;this.acceptResponse(await this.api.send('POST',this.path('/restore/'+v.version),{expected_revision:this.state.revision}),sequence);this.preview=null;});}
  async saveProfile():Promise<void>{await this.action(async()=>{const {id,name,revision,...data}=this.profile;this.profile=await this.api.send('PUT',this.path('/profile'),{...data,expected_revision:revision});this.profileDirty=false;this.profileConflict=false;this.remoteProfile=null;});}
  async compareProfile():Promise<void>{await this.action(async()=>{this.remoteProfile=await this.api.get(this.path('/profile'));});}
  async keepLocalProfile():Promise<void>{if(!this.remoteProfile||!confirm('¿Guardar tu ficha y enlaces sobre la revisión del servidor mostrada? Descarga ambas copias si necesitas conservarlas.'))return;this.profile.revision=this.remoteProfile.revision;await this.saveProfile();}
  useRemoteProfile():void{if(!this.remoteProfile||!confirm('¿Descartar los cambios locales de ficha y enlaces?'))return;this.profile=this.remoteProfile;this.remoteProfile=null;this.profileDirty=false;this.profileConflict=false;}
  addLink():void{this.profile.purchase_links.push({id:crypto.randomUUID(),label:'',url:'',price:null,currency:'EUR',price_checked_at:''});this.profileDirty=true;}
  async compare():Promise<void>{await this.action(async()=>{this.remote=await this.api.get(this.path());});}
  async useLocal():Promise<void>{if(!this.remote||!confirm('¿Guardar tu documento completo sobre la revisión mostrada del servidor? Esta acción reemplaza ese borrador. Puedes descargar ambas copias antes.'))return;
    this.state=this.remote;this.remote=null;this.conflict=false;this.changed();await this.save();}
  useRemote():void{if(!this.remote||!confirm('¿Descartar la copia local y abrir el borrador del servidor? Descarga primero la copia local si quieres conservarla.'))return;this.accept(this.remote);this.remote=null;}
  download(value:any=this.draft,name='review-local.json'):void{const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);}
  canLeave():boolean{return !this.dirty&&!this.profileDirty&&!this.saving&&!this.media.some(m=>m.editing)||confirm('Hay cambios sin guardar. ¿Salir y descartarlos?');}
  @HostListener('window:beforeunload',['$event']) unload(event:BeforeUnloadEvent):void{if(this.dirty||this.profileDirty||this.saving||this.media.some(m=>m.editing)){event.preventDefault();event.returnValue='';}}
  ngOnDestroy():void{clearTimeout(this.timer);clearTimeout(this.focusTimer);}
}

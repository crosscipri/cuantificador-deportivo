import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ComparisonSession } from '../../models/comparison.model';

@Component({selector:'app-comparison-context',standalone:true,imports:[CommonModule,FormsModule],
  template:`<details><summary>Protocolos y contexto de adquisición</summary>
    <p>Las definiciones publicadas son inmutables. Para modificar una prescripción, publica otra versión. El contexto describe lo que consta de cada grabación.</p>
    <p role="status">{{message}}</p><fieldset [disabled]="busy">
    <label>Sesión<select [(ngModel)]="sessionId" (ngModelChange)="load()"><option value="">Elige una sesión seleccionada</option><option *ngFor="let s of sessions" [value]="s.id">{{s.device_name}} · {{s.session_name}}</option></select></label>
    <ng-container *ngIf="loaded"><div class="fields">
      <label>Protocolo y versión<select [(ngModel)]="protocolKey"><option value="">Sin clasificar</option><option *ngFor="let p of protocols" [value]="p.id+'@'+p.version">{{p.name}} v{{p.version}}</option></select></label>
      <label>Identificador de participante<input [(ngModel)]="context.participant_id" placeholder="Opcional, seudónimo"></label>
      <label>Firmware<input [(ngModel)]="context.firmware"></label>
      <label>Muñeca<select [(ngModel)]="context.wrist"><option [ngValue]="null">Desconocida</option><option value="LEFT">Izquierda</option><option value="RIGHT">Derecha</option><option value="OTHER">Otra ubicación</option></select></label>
      <label>Modo GNSS<input [(ngModel)]="context.gnss_mode"></label>
      <label>Condiciones (JSON clave: valor)<textarea [(ngModel)]="contextText" placeholder='{"surface":"track"}'></textarea></label>
      <label>Notas<textarea [(ngModel)]="context.notes"></textarea></label>
    </div><button (click)="save()">Guardar clasificación de la sesión</button></ng-container>
    <details><summary>Publicar protocolo exacto</summary><div class="fields">
      <label>Identificador estable<input [(ngModel)]="protocol.protocol_id" placeholder="RUN_10X400"></label><label>Versión<input type="number" min="1" [(ngModel)]="protocol.version"></label><label>Nombre<input [(ngModel)]="protocol.name"></label>
      <label>Deporte<select [(ngModel)]="protocol.sport_type"><option value="running">Carrera</option><option value="cycling">Ciclismo</option><option value="gym">Fuerza</option><option value="gps">GPS</option><option value="night">Noche</option></select></label>
      <label>Categoría<input [(ngModel)]="protocol.category" placeholder="z2, tempo, series…"></label>
      <label>Prescripción exacta<textarea [(ngModel)]="protocol.specification" placeholder="Repeticiones, duración, recuperaciones y condiciones"></textarea></label>
      <label>Condiciones obligatorias (JSON)<textarea [(ngModel)]="requiredText"></textarea></label>
    </div><button (click)="publish()">Publicar versión</button></details></fieldset>
  </details>`,
  styles:[`.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.8rem}label{display:flex;flex-direction:column;gap:.3rem;margin:.6rem 0}input,textarea,select{padding:.6rem;border:1px solid var(--line);background:var(--surface);color:var(--ink)}textarea{min-height:70px}fieldset{border:0;padding:0}button{padding:.5rem;margin:.5rem 0}p{font-size:.85rem;color:var(--ink-3)}`]})
export class ComparisonContextComponent {
  @Input() sessions:ComparisonSession[]=[];
  @Input() protocols:{id:string;version:number;name:string}[]=[];
  @Output() changed=new EventEmitter<void>();
  sessionId='';protocolKey='';loaded=false;busy=false;message='';contextText='{}';requiredText='{}';
  context:{protocol_id:string|null;protocol_version:number|null;participant_id:string|null;firmware:string|null;wrist:string|null;gnss_mode:string|null;context:Record<string,string>;notes:string}={protocol_id:null,protocol_version:null,participant_id:null,firmware:null,wrist:null,gnss_mode:null,context:{},notes:''};
  protocol={protocol_id:'',version:1,name:'',sport_type:'running',category:'series',specification:''};
  constructor(private http:HttpClient){}
  load():void{this.loaded=false;if(!this.sessionId)return;this.busy=true;this.http.get<typeof this.context>(`/api/comparison-sessions/${this.sessionId}/context`).subscribe({next:c=>{this.context=c;this.protocolKey=c.protocol_id?`${c.protocol_id}@${c.protocol_version}`:'';this.contextText=JSON.stringify(c.context||{},null,2);this.loaded=true;this.busy=false;},error:e=>this.fail(e)});}
  private parse(text:string):Record<string,string>{const value=JSON.parse(text);if(!value||Array.isArray(value)||typeof value!=='object'||Object.values(value).some(v=>typeof v!=='string'))throw Error('Usa un objeto JSON con valores de texto.');return value;}
  save():void{
    let values:Record<string,string>;try{values=this.parse(this.contextText);}catch(e){this.message=String(e);return;}
    const [id,version]=this.protocolKey.split('@');this.busy=true;
    this.http.put(`/api/comparison-sessions/${this.sessionId}/context`,{...this.context,context:values,protocol_id:id||null,protocol_version:version?Number(version):null}).subscribe({next:()=>{this.busy=false;this.message='Clasificación guardada con su revisión anterior.';this.changed.emit();},error:e=>this.fail(e)});
  }
  publish():void{
    let values:Record<string,string>;try{values=this.parse(this.requiredText);}catch(e){this.message=String(e);return;}
    this.busy=true;this.http.post('/api/comparison-protocols',{...this.protocol,required_context:values}).subscribe({next:()=>{this.busy=false;this.message='Versión publicada.';this.changed.emit();},error:e=>this.fail(e)});
  }
  private fail(e:any):void{this.busy=false;this.message=typeof e.error?.detail==='string'?e.error.detail:JSON.stringify(e.error?.detail||'No se ha podido completar la operación.');}
}

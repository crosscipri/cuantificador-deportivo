import { UiIconComponent } from './ui-icon.component';
import { CommonModule } from '@angular/common';
import { Component, Input, OnChanges } from '@angular/core';
import { TRACK_COLORS } from './chart-colors';
import { GpsTrack, projectTrackRuns } from './track-projection';
import { STRAIGHT, R_INNER, LANE_W, N_LANES, pathEdge, runRadius, trackBbox, lapLength, pointAt } from './track-geometry';

@Component({
  selector:'app-review-track',standalone:true,imports:[CommonModule,UiIconComponent],
  template:`
    <div class="track-heading"><strong>Pista de 400 m</strong><span>8 calles · recorridos GPS</span></div>
    <div class="track-stage">
      <svg class="track-svg" [attr.viewBox]="viewBox" [style.touch-action]="zoom>1?'none':'pan-y'" preserveAspectRatio="xMidYMid meet" shape-rendering="geometricPrecision" role="img" tabindex="0"
        aria-label="Recorridos GPS sobre la pista de atletismo. Usa más y menos para ampliar, flechas para desplazar e Inicio para restablecer."
        (keydown)="key($event)" (pointerdown)="pointerDown($event)" (pointermove)="pointerMove($event)" (pointerup)="drag=null" (pointercancel)="drag=null">
        <!-- Original realistic skin from gps-track-analysis; IDs are scoped per review block. -->
        <defs>
          <radialGradient [attr.id]="paintId+'-surface'" cx="0.5" cy="0.5" r="0.7">
            <stop offset="0" stop-color="#CC5A3A"/><stop offset="0.6" stop-color="#B84A30"/><stop offset="1" stop-color="#9C3E27"/>
          </radialGradient>
          <linearGradient [attr.id]="paintId+'-field'" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="#84A56F"/><stop offset="1" stop-color="#638151"/>
          </linearGradient>
          <pattern [attr.id]="paintId+'-stripes'" width="120" height="3" patternUnits="userSpaceOnUse">
            <rect width="120" height="1.5" fill="#000" opacity=".06"/>
          </pattern>
          <pattern [attr.id]="paintId+'-texture'" width="1.2" height="1.2" patternUnits="userSpaceOnUse" patternTransform="rotate(20)">
            <circle cx=".2" cy=".3" r=".05" fill="#7A2E18" opacity=".35"/>
            <circle cx=".8" cy=".7" r=".04" fill="#D87A60" opacity=".30"/>
            <circle cx=".5" cy="1" r=".04" fill="#7A2E18" opacity=".25"/>
            <circle cx="1" cy=".2" r=".05" fill="#FAF9F4" opacity=".08"/>
          </pattern>
          <pattern [attr.id]="paintId+'-hatch'" width=".4" height=".4" patternUnits="userSpaceOnUse" patternTransform="rotate(50)">
            <line x1="0" y1="0" x2="0" y2=".4" stroke="#922F1E" stroke-width=".025" opacity=".18"/>
          </pattern>
          <radialGradient [attr.id]="paintId+'-vignette'" cx=".5" cy=".5" r=".6">
            <stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".85" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".18"/>
          </radialGradient>
          <filter [attr.id]="paintId+'-shadow'" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur in="SourceAlpha" stdDeviation=".8"/><feOffset dx="0" dy=".4"/>
            <feComponentTransfer><feFuncA type="linear" slope=".35"/></feComponentTransfer>
            <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter [attr.id]="paintId+'-route-glow'" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation=".16" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        <g transform="scale(1,-1)">
          <path [attr.d]="inner" [attr.fill]="paint('field')"/>
          <path [attr.d]="inner" [attr.fill]="paint('stripes')"/>
          <g opacity=".92">
            <rect [attr.x]="-finishX+4" y="-3" width="38" height="1.22" fill="#C25538" opacity=".7"/>
            <rect [attr.x]="-finishX+4" y="-3" width="38" height="1.22" fill="none" stroke="#FAF9F4" stroke-width=".08" opacity=".7"/>
            <rect [attr.x]="-finishX+42" y="-3.4" width="3" height="2" fill="#E8D49A" stroke="#B89B5C" stroke-width=".08"/>
            <circle [attr.cx]="finishX-6" cy="14" r="1.07" fill="#D8D4C8" stroke="#FAF9F4" stroke-width=".1"/>
            <circle cx="0" cy="0" r=".3" fill="#FAF9F4" opacity=".4"/>
          </g>
          <path [attr.d]="outer" fill="none" stroke="#314a35" stroke-width="5.5" opacity=".16"/>
          <path class="track-surface" [attr.d]="ring" [attr.fill]="paint('surface')" fill-rule="evenodd" [attr.filter]="paint('shadow')"/>
          <path [attr.d]="ring" [attr.fill]="paint('texture')" fill-rule="evenodd" opacity=".85"/>
          <path [attr.d]="ring" [attr.fill]="paint('hatch')" fill-rule="evenodd" opacity=".7"/>
          <path [attr.d]="ring" [attr.fill]="paint('vignette')" fill-rule="evenodd"/>
          <path *ngFor="let lane of lanes" [attr.d]="lane" fill="none" stroke="#FAF9F4" stroke-width=".12" opacity=".95"/>
          <path [attr.d]="inner" fill="none" stroke="#FAF9F4" stroke-width=".192"/>
          <path [attr.d]="outer" fill="none" stroke="#FAF9F4" stroke-width=".168"/>
          <line [attr.x1]="finishX" [attr.x2]="finishX" [attr.y1]="finishY" [attr.y2]="finishOuter" stroke="#FAF9F4" stroke-width=".264"/>
          <line [attr.x1]="line100X" [attr.x2]="line100X" [attr.y1]="finishY" [attr.y2]="finishOuter" stroke="#3F6FB5" stroke-width=".168" opacity=".9"/>
          <line *ngFor="let m of staggerMarks" [attr.x1]="m.x1" [attr.y1]="m.y1" [attr.x2]="m.x2" [attr.y2]="m.y2" stroke="#5FA86E" stroke-width=".192" opacity=".85"/>
          <line *ngFor="let m of distanceMarks" [attr.x1]="m.x1" [attr.y1]="m.y1" [attr.x2]="m.x2" [attr.y2]="m.y2" stroke="#FAF9F4" [attr.stroke-width]="m.major ? .108 : .066" [attr.opacity]="m.major ? .9 : .55"/>
          <g *ngFor="let n of laneNumbers">
            <rect [attr.x]="n.x-.55" [attr.y]="n.y-.5" width="1.1" height="1" fill="#FAF9F4" opacity=".92" rx=".08"/>
            <text [attr.transform]="'translate('+n.x+','+n.y+') scale(1,-1)'" text-anchor="middle" dominant-baseline="central" font-size=".85" font-weight="700" fill="#9C3E27">{{n.number}}</text>
          </g>
          <ng-container *ngFor="let run of runs;let i=index">
            <g *ngIf="!hidden.has(run.id)">
              <path [attr.d]="run.path" fill="none" stroke="#fff" stroke-width=".68" stroke-opacity=".42" stroke-linejoin="round" stroke-linecap="round"/>
              <path class="gps-run" [attr.d]="run.path" fill="none" [attr.stroke]="color(i)" stroke-width=".36" stroke-opacity=".88" stroke-linejoin="round" stroke-linecap="round" [attr.filter]="paint('route-glow')"><title>{{run.name}}</title></path>
            </g>
          </ng-container>
          <path class="lane-reference" [attr.d]="reference" fill="none" stroke="#14130F" stroke-width=".18" stroke-dasharray="1.08 .72" opacity=".85"/>
        </g>
      </svg>
      <div class="track-zoom" role="group" aria-label="Vista de la pista">
        <button type="button" aria-label="Alejar pista" (click)="zoomBy(1/1.5)" [disabled]="zoom===1"><svg appIcon="minus"></svg></button>
        <button type="button" aria-label="Ampliar pista" (click)="zoomBy(1.5)" [disabled]="zoom===8"><svg appIcon="plus"></svg></button>
        <button type="button" (click)="reset()">Restablecer</button>
      </div>
    </div>
    <p class="track-key"><span></span>Línea de carrera · calle 1</p>
    <div class="track-runs" role="group" aria-label="Recorridos visibles en pista">
      <button *ngFor="let run of runs;let i=index" type="button" [attr.aria-pressed]="!hidden.has(run.id)" (click)="toggle(run.id)"><span [style.background]="color(i)"></span>{{run.name}}</button>
    </div>
    <p class="track-note">Esquema de 400 m usado en el análisis. Recorridos alineados conjuntamente, sin cambiar su escala. La pista es un modelo, no una referencia georreferenciada. Selecciona los recorridos para compararlos; amplía y arrastra para ver el detalle.</p>
  `,
  styles:[`
    :host{display:block;min-width:0}
    .track-heading{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;font-size:13px;margin-bottom:12px}
    .track-heading span{color:var(--ink-3,#505050);font-size:12px}
    .track-stage{position:relative;overflow:hidden;border:1px solid #d8e2d3;background:
      radial-gradient(ellipse at center,rgba(255,255,255,.6) 0 28%,transparent 59%),
      repeating-linear-gradient(102deg,rgba(49,74,53,.035) 0 1px,transparent 1px 9px),
      linear-gradient(145deg,#e6ece2 0%,#d8e2d3 52%,#edf1e9 100%)}
    .track-svg{display:block;width:100%;height:360px;touch-action:pan-y;cursor:grab}
    .track-svg:active{cursor:grabbing}.track-svg:focus-visible{outline:2px solid #256ca6;outline-offset:3px}
    .track-zoom{position:absolute;bottom:12px;right:12px;display:flex;gap:4px}
    button{display:inline-flex;align-items:center;justify-content:center;font:inherit;color:var(--ink,#161616);border:1px solid #cbd5df;background:#fff;padding:10px 12px;cursor:pointer;font-size:12px}
    button:disabled{opacity:.4;cursor:default}button:focus-visible{outline:2px solid #256ca6;outline-offset:3px}
    .track-key{display:flex;align-items:center;gap:8px;font-size:12px;color:#505050;margin:16px 0 12px}
    .track-key span{width:22px;border-top:2px dashed #14130F}
    .track-runs{display:flex;flex-wrap:wrap;gap:6px}
    .track-runs button{display:flex;align-items:center;gap:8px;text-align:left;line-height:1.5;min-height:44px}
    .track-runs button[aria-pressed=false]{color:#66717d;background:#f7f9fb;text-decoration:line-through}
    .track-runs span{width:18px;height:3px;flex:none}
    .track-note{color:var(--ink-3,#505050);font-size:12px;line-height:1.6;margin:14px 0 18px}
    @container review (max-width:600px){.track-svg{height:280px}.track-zoom{bottom:8px;right:8px}}
  `]
})
export class ReviewTrackComponent implements OnChanges {
  @Input() tracks:GpsTrack[]=[];
  private static nextPaintId=0;
  readonly paintId='review-track-'+ReviewTrackComponent.nextPaintId++;
  paint(name:string):string{return 'url(#'+this.paintId+'-'+name+')';}
  readonly inner=pathEdge(R_INNER);
  readonly outer=pathEdge(R_INNER+LANE_W*N_LANES);
  readonly ring=this.outer+' '+this.inner;
  readonly reference=pathEdge(runRadius(1));
  readonly lanes=Array.from({length:N_LANES-1},(_,i)=>pathEdge(R_INNER+(i+1)*LANE_W));
  readonly finishX=STRAIGHT/2;readonly finishY=-R_INNER;readonly finishOuter=-(R_INNER+LANE_W*N_LANES);
  readonly line100X=pointAt(1,(lapLength(1)-100+lapLength(1))%lapLength(1))[0];
  readonly laneNumbers=Array.from({length:N_LANES},(_,i)=>({number:i+1,x:STRAIGHT/2-4,y:-runRadius(i+1)}));
  readonly staggerMarks=Array.from({length:N_LANES},(_,i)=>{
    const lap=lapLength(i+1),[x,y,angle]=pointAt(i+1,(lap-200+lap)%lap),w=LANE_W*.45;
    const nx=-Math.sin(angle),ny=Math.cos(angle);
    return {x1:x-nx*w,y1:y-ny*w,x2:x+nx*w,y2:y+ny*w};
  });
  readonly distanceMarks=Array.from({length:Math.ceil(lapLength(1)/10)},(_,i)=>{
    const [x,y,angle]=pointAt(1,i*10),major=i%10===0,len=major ? .45 : .22;
    const nx=-Math.sin(angle),ny=Math.cos(angle);
    return {x1:x-nx*.05,y1:y-ny*.05,x2:x-nx*len,y2:y-ny*len,major};
  });
  runs:ReturnType<typeof projectTrackRuns>['runs']=[];
  bounds=trackBbox();hidden=new Set<string>();zoom=1;panX=0;panY=0;
  drag:{x:number;y:number;panX:number;panY:number;scale:number}|null=null;
  color(i:number):string{return TRACK_COLORS[i%TRACK_COLORS.length];}
  ngOnChanges():void{const view=projectTrackRuns(this.tracks);this.runs=view.runs;this.bounds=view.bounds;this.hidden.clear();this.reset();}
  get width():number{return this.bounds.maxX-this.bounds.minX+24;}
  get height():number{return this.bounds.maxY-this.bounds.minY+24;}
  get viewBox():string{
    const cx=(this.bounds.minX+this.bounds.maxX)/2+this.panX,cy=-(this.bounds.minY+this.bounds.maxY)/2+this.panY;
    return `${cx-this.width/this.zoom/2} ${cy-this.height/this.zoom/2} ${this.width/this.zoom} ${this.height/this.zoom}`;
  }
  toggle(id:string):void{this.hidden.has(id)?this.hidden.delete(id):this.hidden.add(id);}
  zoomBy(factor:number):void{this.zoom=Math.max(1,Math.min(8,this.zoom*factor));if(this.zoom===1)this.reset();}
  reset():void{this.zoom=1;this.panX=0;this.panY=0;this.drag=null;}
  pointerDown(event:PointerEvent):void{
    if(this.zoom===1||event.button!==0)return;
    const svg=event.currentTarget as SVGSVGElement,rect=svg.getBoundingClientRect();
    const scale=Math.min(rect.width/(this.width/this.zoom),rect.height/(this.height/this.zoom));
    this.drag={x:event.clientX,y:event.clientY,panX:this.panX,panY:this.panY,scale};svg.setPointerCapture(event.pointerId);
  }
  pointerMove(event:PointerEvent):void{if(this.drag){this.panX=this.drag.panX-(event.clientX-this.drag.x)/this.drag.scale;this.panY=this.drag.panY-(event.clientY-this.drag.y)/this.drag.scale;}}
  key(event:KeyboardEvent):void{
    if(!['+','=','-','Home','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();const step=10/this.zoom;
    if(event.key==='Home')this.reset();else if(['+','='].includes(event.key))this.zoomBy(1.5);else if(event.key==='-')this.zoomBy(1/1.5);
    else if(event.key==='ArrowLeft')this.panX-=step;else if(event.key==='ArrowRight')this.panX+=step;
    else if(event.key==='ArrowUp')this.panY-=step;else this.panY+=step;
  }
}

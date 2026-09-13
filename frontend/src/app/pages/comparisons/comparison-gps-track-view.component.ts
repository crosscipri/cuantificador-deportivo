import { CommonModule } from '@angular/common';
import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { ComparisonGpsTrack, deviceColor } from '../../models/comparison.model';
import { STRAIGHT, R_INNER, LANE_W, N_LANES, runRadius, trackBbox, lapLength, pathEdge, nearestOnLane1 } from '../gps-track-analysis/track-geometry';

interface TrackView {
  id:string; name:string; deviceId:string; color:string; visible:boolean; pathD:string;
  points:{x:number;y:number;error:number}[]; meanError:number; p95:number; samples:number;
}

@Component({
  selector:'app-comparison-gps-track-view', standalone:true, imports:[CommonModule],
  templateUrl:'./comparison-gps-track-view.component.html',
  styleUrls:['../gps-track-analysis/gps-track-analysis.component.scss','./comparison-gps-specialized.component.scss'],
})
export class ComparisonGpsTrackViewComponent implements OnChanges {
  @Input() tracks:ComparisonGpsTrack[]=[];
  views:TrackView[]=[]; selectedId=''; trackStyle:'realista'|'esquematica'|'blueprint'='realista';
  trackZoom=1;trackPanX=0;trackPanY=0;
  readonly STRAIGHT=STRAIGHT;readonly R_INNER=R_INNER;readonly LANE_W=LANE_W;readonly N_LANES=N_LANES;
  readonly innerKerb=pathEdge(R_INNER);readonly outerKerb=pathEdge(R_INNER+LANE_W*N_LANES);
  readonly trackRing=`${pathEdge(R_INNER+LANE_W*N_LANES)} ${pathEdge(R_INNER)}`;
  readonly lane1Run=pathEdge(runRadius(1));
  readonly lanePaths=Array.from({length:N_LANES-1},(_,i)=>pathEdge(R_INNER+(i+1)*LANE_W));
  readonly finishLine={x:STRAIGHT/2,y0:-R_INNER,y1:-(R_INNER+LANE_W*N_LANES)};
  private drag:{x:number;y:number;panX:number;panY:number}|null=null;

  ngOnChanges(_:SimpleChanges):void { this.views=this.tracks.filter(t=>t.role!=='reference').map(t=>this.project(t));this.selectedId=this.views[0]?.id||''; }
  get selected():TrackView|undefined{return this.views.find(v=>v.id===this.selectedId)||this.views[0];}
  get visible():TrackView[]{return this.views.filter(v=>v.visible);}
  get trackViewBox():string{const b=trackBbox(),pad=12,w0=b.maxX-b.minX+pad*2,h0=b.maxY-b.minY+pad*2,cx=b.minX-pad+w0/2+this.trackPanX,cy=b.minY-pad+h0/2+this.trackPanY;return `${cx-w0/this.trackZoom/2} ${cy-h0/this.trackZoom/2} ${w0/this.trackZoom} ${h0/this.trackZoom}`;}
  toggle(view:TrackView):void{view.visible=!view.visible;if(view.visible)this.selectedId=view.id;}
  zoom(factor:number):void{this.trackZoom=Math.max(1,Math.min(8,this.trackZoom*factor));}
  reset():void{this.trackZoom=1;this.trackPanX=0;this.trackPanY=0;}
  wheel(event:WheelEvent):void{event.preventDefault();this.zoom(event.deltaY<0?1.06:1/1.06);}
  pointerDown(event:PointerEvent):void{this.drag={x:event.clientX,y:event.clientY,panX:this.trackPanX,panY:this.trackPanY};(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);}
  pointerMove(event:PointerEvent):void{if(!this.drag)return;const scale=1.2/this.trackZoom;this.trackPanX=this.drag.panX-(event.clientX-this.drag.x)*scale;this.trackPanY=this.drag.panY-(event.clientY-this.drag.y)*scale;}
  pointerUp():void{this.drag=null;}
  fmt(value:number,digits=2):string{return Number.isFinite(value)?value.toLocaleString('es-ES',{maximumFractionDigits:digits}):'—';}

  private project(track:ComparisonGpsTrack):TrackView {
    const raw=track.segments.flat();
    if(raw.length<2)return{id:track.id,name:track.name,deviceId:track.device_id||track.id,color:deviceColor(track.device_id||track.id),visible:true,pathD:'',points:[],meanError:0,p95:0,samples:raw.length};
    const centLat=raw.reduce((s,p)=>s+p.lat,0)/raw.length,centLon=raw.reduce((s,p)=>s+p.lon,0)/raw.length;
    const factorX=Math.cos(centLat*Math.PI/180)*6371000*Math.PI/180,factorY=6371000*Math.PI/180;
    const local=raw.map(p=>({x:(p.lon-centLon)*factorX,y:(p.lat-centLat)*factorY}));
    const mx=local.reduce((s,p)=>s+p.x,0)/local.length,my=local.reduce((s,p)=>s+p.y,0)/local.length;
    const cxx=local.reduce((s,p)=>s+(p.x-mx)**2,0),cxy=local.reduce((s,p)=>s+(p.x-mx)*(p.y-my),0),cyy=local.reduce((s,p)=>s+(p.y-my)**2,0);
    const tr=cxx+cyy,lambda=tr/2+Math.sqrt(Math.max(0,tr*tr/4-(cxx*cyy-cxy*cxy)));
    let angle=cxy!==0?Math.atan2(lambda-cxx,cxy):(cxx>=cyy?0:Math.PI/2);
    const rotate=(p:{x:number;y:number},a=angle)=>({x:(p.x-mx)*Math.cos(-a)-(p.y-my)*Math.sin(-a),y:(p.x-mx)*Math.sin(-a)+(p.y-my)*Math.cos(-a)});
    let rotated=local.map(p=>rotate(p));
    if(Math.max(...rotated.map(p=>p.y))-Math.min(...rotated.map(p=>p.y))>Math.max(...rotated.map(p=>p.x))-Math.min(...rotated.map(p=>p.x))){angle+=Math.PI/2;rotated=local.map(p=>rotate(p,angle));}
    const points=rotated.map(p=>({...p,error:Math.min(30,nearestOnLane1(p.x,p.y).dist)}));
    const sorted=points.map(p=>p.error).sort((a,b)=>a-b);
    return{id:track.id,name:track.name,deviceId:track.device_id||track.id,color:deviceColor(track.device_id||track.id),visible:true,
      pathD:points.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' '),points,
      meanError:points.reduce((s,p)=>s+p.error,0)/points.length,p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]||0,samples:points.length};
  }
}

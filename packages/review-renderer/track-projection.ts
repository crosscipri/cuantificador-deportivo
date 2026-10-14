import { finite } from './chart-data';
import { trackBbox } from './track-geometry';

export interface GpsTrack {
  id:string; name:string; role:string;
  segments:{lat:number;lon:number}[][];
}

// The same centroid/equirectangular/PCA projection used by the local track analysis.
// All selected runs share ONE transform: no per-run fitting, rescaling or new metrics.
export function projectTrackRuns(tracks:GpsTrack[]) {
  const valid=(p:{lat:number;lon:number})=>finite(p.lat)&&finite(p.lon);
  const points=tracks.flatMap(t=>t.segments.flat()).filter(valid);
  const bounds=trackBbox();
  if (!points.length) return {bounds,runs:[]};
  const lat=points.reduce((s,p)=>s+p.lat,0)/points.length;
  const lon=points.reduce((s,p)=>s+p.lon,0)/points.length;
  const scaleY=6371000*Math.PI/180, scaleX=Math.cos(lat*Math.PI/180)*scaleY;
  const local=(p:{lat:number;lon:number})=>({x:(p.lon-lon)*scaleX,y:(p.lat-lat)*scaleY});
  let xx=0,xy=0,yy=0;
  for(const p of points){const {x,y}=local(p);xx+=x*x;xy+=x*y;yy+=y*y;}
  const angle=.5*Math.atan2(2*xy,xx-yy),cos=Math.cos(angle),sin=Math.sin(angle);
  const runs=tracks.map(track=>{
    const segments=track.segments.map(segment=>{
      // Non-finite coordinates split paths, just like source GPS recording gaps.
      let move=true;
      return segment.map(p=>{
        if(!valid(p)){move=true;return '';}
        const q=local(p),x=q.x*cos+q.y*sin,y=-q.x*sin+q.y*cos;
        bounds.minX=Math.min(bounds.minX,x);bounds.maxX=Math.max(bounds.maxX,x);
        bounds.minY=Math.min(bounds.minY,y);bounds.maxY=Math.max(bounds.maxY,y);
        const d=`${move?'M':'L'}${x.toFixed(3)} ${y.toFixed(3)}`;move=false;return d;
      }).filter(Boolean).join(' ');
    }).filter(Boolean);
    return {id:track.id,name:track.name,path:segments.join(' ')};
  });
  return {bounds,runs};
}

export const SCORE_DIMENSIONS = [
  { key: 'fc', label: 'FC' },
  { key: 'hrv', label: 'HRV' },
  { key: 'rest_hr', label: 'FC en reposo' },
  { key: 'gps', label: 'GPS' },
] as const;
export type ScoreKey = typeof SCORE_DIMENSIONS[number]['key'];
export interface ReviewScores {
  fc: number | null;
  hrv: number | null;
  rest_hr: number | null;
  gps: number | null;
  source: 'editorial' | 'device';
  source_device_id: string;
  source_device_name: string;
  captured_at: string;
}
export function emptyReviewScores(): ReviewScores {
  return {fc:null,hrv:null,rest_hr:null,gps:null,source:'editorial',source_device_id:'',source_device_name:'',captured_at:''};
}
export function reviewScoreSummary(scores: Partial<ReviewScores> | null | undefined): {total:number|null;count:number} {
  const values=SCORE_DIMENSIONS.map(d=>scores?.[d.key]).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v));
  return {total:values.length ? Math.round(values.reduce((sum,v)=>sum+v,0)/values.length*10)/10 : null,count:values.length};
}
/** Same source values and calculation as the existing private global-scores page. */
export function deviceReviewScores(deviceId:string,running:any[],cycling:any[],gym:any[],gps:any[],hrv:any[]):ReviewScores {
  const sports=[running,cycling,gym].map(rows=>rows.find(r=>r.device_id===deviceId));
  const gpsRow=gps.find(r=>r.device_id===deviceId),night=hrv.find(r=>r.device_id===deviceId);
  const ccc=sports.map(r=>r?.ccc_global).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>0);
  const valid=(v:any):number|null=>typeof v==='number'&&Number.isFinite(v) ? v : null;
  return {...emptyReviewScores(),
    fc:ccc.length ? Math.round(ccc.reduce((sum,v)=>sum+v,0)/ccc.length*1000)/10 : null,
    gps:valid(gpsRow?.global_score),hrv:valid(night?.hrv_score),rest_hr:valid(night?.hr_score),
    source:'device',source_device_id:deviceId,
    source_device_name:sports.find(r=>r?.name)?.name || gpsRow?.name || night?.name || '',
  };
}

/** Promote the first verdict without leaving duplicate content or empty section headings. */
export function reviewConclusionLayout(blocks:any[] = []):{conclusion:any;body:any[]} {
  const conclusion=blocks.find(b=>b.type==='verdict') || null;
  const remaining=blocks.filter(b=>b!==conclusion);
  const body=remaining.filter((b,i)=>{
    if(b.type!=='heading')return true;
    for(const next of remaining.slice(i+1)){
      if(next.type==='heading'&&next.level<=b.level)break;
      if(next.type!=='heading')return true;
    }
    return false;
  });
  return {conclusion,body};
}

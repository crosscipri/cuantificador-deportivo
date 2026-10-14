import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ReviewScores } from '@cuantificador/review-renderer/scores';

export interface EvidenceRef {
  source_id: string; kind: string; revision: string; visualization: string;
  series: string[]; start: number|null; end: number|null;
  members?: {source_id:string;revision:string}[];
  sport?: 'running'|'cycling'|'gym'|null;
}
export const FC_SPORTS={running:'Running',cycling:'Ciclismo',gym:'Fuerza'} as const;
export type FCSport=keyof typeof FC_SPORTS;
export function fcReviewMembers(blocks:ReviewBlock[]):{source_id:string;revision:string}[] {
  const members=new Map<string,string>();
  for(const b of blocks){
    const ref=b.evidence;
    if(b.type!=='chart'||ref?.kind!=='fc'||ref.visualization!=='temporal')continue;
    if(members.has(ref.source_id)&&members.get(ref.source_id)!==ref.revision)
      throw new Error('Hay dos revisiones diferentes de la misma prueba FC. Unifica sus vínculos antes de crear la correlación total.');
    members.set(ref.source_id,ref.revision);
  }
  return [...members].sort(([a],[b])=>a.localeCompare(b)).map(([source_id,revision])=>({source_id,revision}));
}
/** Group the exact frozen revisions used by the curves, never mutable source metadata. */
export function fcReviewGroups(blocks:ReviewBlock[],boundSources:any[]):{sport:FCSport;members:{source_id:string;revision:string}[]}[] {
  const groups=new Map<FCSport,{source_id:string;revision:string}[]>();
  for(const member of fcReviewMembers(blocks)){
    const source=boundSources.find(s=>s.kind==='fc'&&s.source_id===member.source_id&&s.revision===member.revision);
    if(!source || !Object.hasOwn(FC_SPORTS,source.sport))throw new Error('No se conoce el deporte de una revisión FC vinculada. Comprueba las pruebas antes de agruparlas.');
    const sport=source.sport as FCSport;
    if(!groups.has(sport))groups.set(sport,[]);
    groups.get(sport)!.push(member);
  }
  return [...groups].map(([sport,members])=>({sport,members}));
}
export interface MediaRef { media_id: string; alt: string; caption: string; }
export interface ReviewBlock {
  id: string; type: string; text: string; level: number; html: string; title: string;
  caption: string; explanation: string; media: MediaRef[]; video: string;
  evidence: EvidenceRef|null; table_origin: string; rows: string[][];
  recommended: string; not_recommended: string; pros: string[]; cons: string[];
  scores?: ReviewScores | null;
  alternatives: {device_id:string; reason:string}[]; link_ids: string[]; affiliate_notice: string;
}
export function newBlock(type: string): ReviewBlock {
  return {id:crypto.randomUUID(),type,text:'',level:2,html:'',title:'',caption:'',explanation:'',media:[],video:'',
    evidence:null,table_origin:'editorial',rows:[],recommended:'',not_recommended:'',pros:[],cons:[],alternatives:[],link_ids:[],affiliate_notice:''};
}
@Injectable({providedIn:'root'})
export class ReviewService {
  constructor(private http:HttpClient) {}
  get<T=any>(path:string):Promise<T>{return firstValueFrom(this.http.get<T>('/api/'+path));}
  send<T=any>(method:string,path:string,body?:unknown):Promise<T>{return firstValueFrom(this.http.request<T>(method,'/api/'+path,{body}));}
}

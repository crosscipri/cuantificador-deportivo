import '@angular/compiler';
import assert from 'node:assert/strict';
import { ReviewEditorComponent } from '../src/app/pages/review/review-editor.component';
import { RichTextComponent } from '../src/app/shared/review/rich-text.component';
import { newBlock, fcReviewMembers, fcReviewGroups } from '../src/app/services/review.service';
import { webcrypto } from 'node:crypto';
import { pairedIndices, pairAt, identityReference, nearestTimeIndex } from '../../packages/review-renderer/chart-data';
import { projectTrackRuns } from '../../packages/review-renderer/track-projection';
import { lapLength, pathEdge } from '../src/app/pages/gps-track-analysis/track-geometry';
import { reviewMedia } from '../../packages/review-renderer/review-media';
import { deviceReviewScores, reviewScoreSummary, reviewConclusionLayout } from '../../packages/review-renderer/review-scores';
(globalThis as any).crypto ||= webcrypto;
(globalThis as any).confirm=()=>true;

function deferred(){let resolve!:(v:any)=>void;let reject!:(v:any)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const route:any={snapshot:{paramMap:{get:()=> 'test-device'}}};
const initial={revision:1,draft:{title:'Original',blocks:[],public_results:[]}};
function editor(api:any){const e=new ReviewEditorComponent(api,route);e.id='test-device';e.accept(structuredClone(initial));return e;}

// Edit while save is in flight: no old response replaces the newer text.
{
 const one=deferred(),two=deferred(),calls:any[]=[];
 const e=editor({send:(_m:any,_p:any,b:any)=>{calls.push(b);return calls.length===1?one.promise:two.promise;}});
 e.draft.title='Primera edición';e.changed();const saving=e.save();
 e.draft.title='Edición más reciente';e.changed();
 one.resolve({revision:2,draft:structuredClone(calls[0].draft)});
 await new Promise(r=>setTimeout(r,0));
 assert.equal(e.draft.title,'Edición más reciente');assert.equal(calls.length,2);assert.equal(calls[1].expected_revision,2);
 two.resolve({revision:3,draft:calls[1].draft});assert.equal(await saving,true);assert.equal(e.dirty,false);assert.equal(e.state.revision,3);e.ngOnDestroy();
}
// Concurrent manual save and autosave share one request when document is unchanged.
{
 const pending=deferred();let calls=0;
 const e=editor({send:()=>{calls++;return pending.promise;}});e.changed();const a=e.save(),b=e.save();
 pending.resolve({revision:2,draft:e.draft});await Promise.all([a,b]);assert.equal(calls,1);e.ngOnDestroy();
}
// Conflict and transport failure preserve local work; retry is explicit.
{
 let failure:any={status:409,error:{detail:'Conflicto de edición. Otra pestaña'}};let calls=0;
 const e=editor({send:async()=>{calls++;throw failure;}});e.draft.title='No perder este texto';e.changed();
 assert.equal(await e.save(),false);assert.equal(e.conflict,true);assert.equal(e.draft.title,'No perder este texto');
 e.changed();assert.equal(await e.save(),false);assert.equal(calls,1);e.ngOnDestroy();
 const p=editor({send:async()=>{throw {status:500,error:{detail:'Sin conexión'}};}});p.draft.title='Recuperable';p.changed();assert.equal(await p.save(),false);assert.equal(p.dirty,true);assert.equal(p.status,'Error al guardar');assert.equal(p.draft.title,'Recuperable');p.ngOnDestroy();
}
// Reordering preserves identity; duplication creates identity; restoring refreshes rich text DOM.
{
 const e=editor({});e.draft.blocks=[newBlock('text'),newBlock('heading')];const id=e.draft.blocks[0].id;
 e.move(0,1);assert.equal(e.draft.blocks[1].id,id);e.duplicate(1);assert.notEqual(e.draft.blocks[2].id,id);
 const text=new RichTextComponent();let restored='';(text as any).quill={getSemanticHTML:()=>'<p>Anterior</p>',enable:()=>{},clipboard:{dangerouslyPasteHTML:(html:string)=>restored=html}};text.value='<p>Restaurado</p>';text.ngOnChanges();assert.equal(restored,'<p>Restaurado</p>');e.ngOnDestroy();
}
// A slug collision is recoverable by changing the slug, not a stale revision.
{
 const e=editor({send:async()=>{throw {status:409,error:{detail:'El slug ya pertenece a otra review'}};}});e.changed();await e.save();assert.equal(e.conflict,false);assert.equal(e.dirty,true);e.ngOnDestroy();
}
// Late publish/restore responses must never overwrite a newer local edit.
for(const operation of ['publish','restore'] as const){
 const pending=deferred();const e=editor({get:async()=>[],send:async(_m:any,path:string)=>path.endsWith('/preview')?{errors:[],preview_token:'token'}:pending.promise});
 const request=operation==='publish'?e.publish():e.restore({version:'old'});
 await new Promise(r=>setTimeout(r,0));
 e.draft.title='Edición posterior a la petición';e.changed();
 pending.resolve({...initial,revision:2});await request;
 assert.equal(e.draft.title,'Edición posterior a la petición');assert.equal(e.dirty,true);assert.equal(e.state.revision,2);e.ngOnDestroy();
}
// Drawing reduction keeps aligned original extrema and both sides of missing data.
{
 const time=Array.from({length:10000},(_,i)=>i);
 const device:any[]=time.map(i=>120+Math.sin(i/30));const reference:any[]=time.map(i=>118+Math.sin(i/30));
 device[4321]=200;reference[5678]=65;reference[5000]=null;reference[5001]=null;
 const series=[{role:'device',values:device},{role:'reference',values:reference}];
 const copy=JSON.stringify(series);const indices=pairedIndices(time,series,0,9999,800);
 assert(indices.length<1200);for(const i of [0,9999,4321,5678,4999,5000,5001,5002])assert(indices.includes(i));
 assert.equal(JSON.stringify(series),copy);assert.equal(pairAt({time,series},40).difference,2);
 assert.equal(pairAt({time,series},5000).difference,null);
 const selected=pairedIndices(time,series,4200,4500,800);assert.equal(selected[0],4200);assert.equal(selected.at(-1),4500);
 // Cursor reads original pairs even where drawing reduction omitted a timestamp.
 const omitted=time.find(i=>!indices.includes(i))!;
 assert.equal(nearestTimeIndex(time,omitted,0,9999),omitted);
 assert.equal(pairAt({time,series},nearestTimeIndex(time,5000,0,9999)).difference,null);
 assert.equal(nearestTimeIndex(time,100,4200,4500),4200);
 assert.equal(nearestTimeIndex(time,9000,4200,4500),4500);
 assert.equal(nearestTimeIndex([0,3,10],8,0,10),2);
 assert.equal(nearestTimeIndex([0,3,10],8,4,9),-1);
 assert.equal(nearestTimeIndex([],0,0,10),-1);
}
// Identity covers both axes, including constant data, without inventing pairs for gaps.
{
 const points=[{x:180,y:65},{x:90,y:210},{x:NaN,y:999}];const before=structuredClone(points);
 const identity=identityReference(points)!;
 assert(identity.min<65);assert(identity.max>210);
 assert.deepEqual(identity.data,[{x:identity.min,y:identity.min},{x:identity.max,y:identity.max}]);
 assert.deepEqual(points,before);assert.equal(identityReference([]),null);
 assert.equal(identityReference([{x:Infinity,y:1}]),null);
 const constant=identityReference([{x:120,y:120}])!;assert(constant.min<120&&constant.max>120);
}
// Track projection preserves metres and gaps, and never centres individual runs separately.
{
 const metres=6371000*Math.PI/180;
 const p=(x:number,y:number)=>({lat:y/metres,lon:x/metres});
 const tracks=[{id:'a',name:'A',role:'device',segments:[[p(-80,0),p(-60,0)],[],[p(60,0),p(80,0)]]},
  {id:'b',name:'B',role:'device',segments:[[p(-80,4),p(-60,4)],[p(60,4),p(80,4)]]}];
 const before=JSON.stringify(tracks),view=projectTrackRuns(tracks);
 assert.equal(JSON.stringify(tracks),before);assert.equal(view.runs.length,2);
 assert.equal((view.runs[0].path.match(/M/g)||[]).length,2);
 const coords=(path:string)=>[...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(m=>[Number(m[1]),Number(m[2])]);
 const a=coords(view.runs[0].path),b=coords(view.runs[1].path);
 assert(Math.abs(Math.hypot(a[1][0]-a[0][0],a[1][1]-a[0][1])-20)<.01);
 assert(Math.abs(Math.hypot(a[0][0]-b[0][0],a[0][1]-b[0][1])-4)<.01);
 assert.deepEqual(projectTrackRuns([]).runs,[]);
 assert(Math.abs(lapLength(1)-400)<.02);assert(pathEdge(36.5).endsWith('Z'));
 const gaps=projectTrackRuns([{...tracks[0],segments:[[p(0,0),{lat:NaN,lon:0},p(20,0)]]}]);
 assert.equal((gaps.runs[0].path.match(/M/g)||[]).length,2);assert(!gaps.runs[0].path.includes('NaN'));
}
// Sport summaries preserve unrelated blocks, deduplicate trials and use frozen revisions.
{
 const signal=(id:string,revision='rev-'+id)=>({...newBlock('chart'),evidence:{kind:'fc',source_id:id,revision,visualization:'temporal',series:['device','reference'],start:null,end:null}});
 const a=signal('a'),b=signal('b'),c=signal('c'),d=signal('d'),g=signal('g'),copy=structuredClone(a);copy.id='copy';
 const photo=newBlock('image');photo.caption='Conservar imagen';
 const correlation={...signal('a'),evidence:{...a.evidence,visualization:'scatter'}};
 const ba={...signal('a'),evidence:{...a.evidence,visualization:'bland_altman'}};
 const frozen=[['a','running'],['b','running'],['c','cycling'],['d','cycling'],['g','gym']].map(([source_id,sport])=>({kind:'fc',source_id,sport,revision:'rev-'+source_id}));
 let failOn='';const calls:any[]=[];
 const e=editor({get:async()=>frozen,send:async(_m:any,_p:any,ref:any)=>{if(ref.sport===failOn)throw Error('Sin conexión');calls.push(ref);return {revision:'total-'+ref.sport};}});
 // Current source metadata deliberately disagrees with the frozen metadata.
 e.sources=frozen.map(s=>({...s,sport:'gym',revision:'changed'}));
 e.draft.blocks=[a,correlation,photo,b,ba,copy,c,d,g];
 assert.equal(fcReviewMembers(e.draft.blocks).length,5);
 assert.throws(()=>fcReviewMembers([a,signal('a','other-revision')]));
 assert.throws(()=>fcReviewGroups(e.draft.blocks,[]));
 await e.organizeFc();
 assert.equal(calls.length,3);assert.deepEqual(calls[0].members,[{source_id:'a',revision:'rev-a'},{source_id:'b',revision:'rev-b'}]);
 assert.equal(e.draft.blocks.filter((b:any)=>b.evidence?.kind==='fc_total').length,3);
 assert.equal(e.draft.blocks.filter((b:any)=>b.evidence?.visualization==='temporal').length,6);
 assert.equal(e.draft.blocks.filter((b:any)=>b.evidence?.kind==='fc'&&['scatter','bland_altman'].includes(b.evidence.visualization)).length,0);
 assert.deepEqual(e.draft.blocks.find((b:any)=>b.id===photo.id),photo);
 for(const [sport,last] of [['running',copy],['cycling',d],['gym',g]] as const){
  const index=e.draft.blocks.findIndex((b:any)=>b.id===last.id);
  assert.equal(e.draft.blocks[index+1].id,'fc-total-summary-'+sport);
  assert.equal(e.draft.blocks[index+2].evidence.sport,sport);
 }
 const ids=e.draft.blocks.map((b:any)=>b.id);await e.organizeFc();assert.deepEqual(e.draft.blocks.map((b:any)=>b.id),ids);
 const running=e.draft.blocks.find((b:any)=>b.evidence?.sport==='running').evidence;
 const cycling=e.draft.blocks.find((b:any)=>b.evidence?.sport==='cycling').evidence;
 assert.equal(e.stale(running),false);frozen.push({kind:'fc',source_id:'x',revision:'rev-x',sport:'cycling'});e.draft.blocks.push(signal('x'));
 assert.equal(e.stale(running),false);assert.equal(e.stale(cycling),true);
 const before=JSON.stringify(e.draft.blocks);failOn='cycling';await e.organizeFc();assert.equal(JSON.stringify(e.draft.blocks),before);e.ngOnDestroy();
}
// Batch insertion groups interleaved sports and appends another trial inside its sport section.
{
 const frozen:any[]=[];const e=editor({get:async()=>frozen,send:async(_m:any,_p:any,ref:any)=>{
  if(ref.kind==='fc_total')return {revision:'total-'+ref.sport};
  const value={...ref,sport:e.sources.find(s=>s.source_id===ref.source_id).sport};
  if(!frozen.some(f=>f.revision===ref.revision))frozen.push(value);return value;
 }});
 e.sources=[['a','cycling'],['b','running'],['c','gym'],['d','running']].map(([source_id,sport])=>({kind:'fc',source_id,sport,revision:'rev-'+source_id,name:source_id,test_type:'Prueba',visualizations:['temporal'],series:[{id:'device'},{id:'reference'}]}));
 e.selectAllSources();await e.insertBatch();
 assert.deepEqual(e.draft.blocks.filter((b:any)=>b.evidence?.kind==='fc').map((b:any)=>b.evidence.source_id),['b','d','a','c']);
 assert.equal(e.draft.blocks.filter((b:any)=>b.evidence?.kind==='fc_total').length,3);
 e.sources.push({...e.sources[1],source_id:'e',revision:'rev-e',name:'Nueva carrera'});e.batchSelection.add('fc:e');await e.insertBatch();
 assert.deepEqual(e.draft.blocks.filter((b:any)=>b.evidence?.kind==='fc').map((b:any)=>b.evidence.source_id),['b','d','e','a','c']);
 assert.equal(e.draft.blocks.find((b:any)=>b.evidence?.sport==='running').evidence.members.length,3);e.ngOnDestroy();
}
// Main video comes first; collect only referenced media once, without changing the article.
{
 const cover={media_id:'cover',alt:'Portada',caption:''},photo={media_id:'detail',alt:'Detalle',caption:'Pie de foto'};
 const payload={article:{youtube:'abcdefghijk',cover,blocks:[
  {type:'image',media:[photo]}, {type:'gallery',media:[cover,photo,{media_id:'missing'}]},
  {type:'video',video:'abcdefghijk'}, {type:'video',video:'lmnopqrstuv',title:'Segundo vídeo'},
  {type:'video',video:'https://invalid.test/video'}, {type:'text',media:[{media_id:'unused'}]}
 ]},media:{cover:{},detail:{},unused:{}}};
 const before=JSON.stringify(payload),items=reviewMedia(payload);
 assert.deepEqual(items.map(i=>i.key),['video:abcdefghijk','image:cover','image:detail','video:lmnopqrstuv']);
 assert.equal(items[0].primary,true);assert.equal(items[2].caption,'Pie de foto');
 assert.equal(JSON.stringify(payload),before);
 assert.deepEqual(reviewMedia(null),[]);assert.deepEqual(reviewMedia({article:{}}),[]);
 const withoutVideo={...payload,article:{...payload.article,youtube:''}};
 assert.equal(reviewMedia(withoutVideo)[0].key,'image:cover');
 const withoutCover={...payload,article:{...payload.article,cover:null}};
 assert.equal(reviewMedia(withoutCover)[0].key,'video:abcdefghijk');
}
// Scores reuse the private global formula, distinguish missing from zero, and preserve negatives.
{
 const row={device_id:'test-device',name:'Sintético',ccc_global:.9};
 const scores=deviceReviewScores('test-device',[row],[{...row,ccc_global:.8}],[],[{...row,global_score:75}],[{...row,hrv_score:90,hr_score:null}]);
 assert.equal(scores.fc,85);assert.deepEqual(reviewScoreSummary(scores),{total:83.3,count:3});
 assert.deepEqual(reviewScoreSummary({fc:0,gps:80}),{total:40,count:2});
 assert.deepEqual(reviewScoreSummary({hrv:-20,rest_hr:80}),{total:30,count:2});
 assert.deepEqual(reviewScoreSummary(null),{total:null,count:0});
 const h=(id:string)=>({id,type:'heading',level:2});const verdict={...newBlock('verdict'),id:'v'};
 const blocks=[h('intro'),{id:'text',type:'text'},h('empty-after-promotion'),verdict,h('next'),{id:'last',type:'text'}];
 const before=JSON.stringify(blocks),layout=reviewConclusionLayout(blocks);
 assert.equal(layout.conclusion,verdict);assert.deepEqual(layout.body.map(b=>b.id),['intro','text','next','last']);
 assert.equal(JSON.stringify(blocks),before);assert.equal(reviewConclusionLayout([]).conclusion,null);
}
// Loading scores is explicit and atomic on transport failure; editing marks them as editorial.
{
 let failure=false;const calls:string[]=[];
 const row={device_id:'test-device',name:'Sintético',ccc_global:.9};
 const e=editor({get:async(path:string)=>{calls.push(path);if(failure&&path.includes('gps'))throw Error('Sin conexión');return path.includes('data?')?[row]:path.includes('gps')?[{...row,global_score:80}]:[];}});
 e.profile={name:'Sintético'};e.editConclusion();const b=e.draft.blocks[0];e.editConclusion();assert.equal(e.draft.blocks.length,1);
 await e.loadDeviceScores(b);assert.equal(calls.length,5);assert.equal(b.scores.fc,90);assert.equal(b.scores.gps,80);assert.equal(b.scores.hrv,null);
 assert.equal(b.scores.source,'device');const before=JSON.stringify(b.scores);failure=true;await e.loadDeviceScores(b);assert.equal(JSON.stringify(b.scores),before);
 e.setScore(b,'fc',0);assert.equal(b.scores.fc,0);assert.equal(b.scores.source,'editorial');assert.equal(b.scores.source_device_id,'');
 e.setScore(b,'hrv',null);assert.equal(b.scores.hrv,null);e.ngOnDestroy();
}
console.log('14 grupos frontend OK: guardado, conflictos, bloques, gráficas, carrusel, conclusión y puntuaciones.');

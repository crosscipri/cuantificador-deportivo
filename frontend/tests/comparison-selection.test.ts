import '@angular/compiler';
import assert from 'node:assert/strict';
import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';
import { of, Subject } from 'rxjs';
import { ComparisonSelectedSportComponent } from '../src/app/pages/comparisons/comparison-selected-sport.component';
import { ComparisonSportsComponent } from '../src/app/pages/comparisons/comparison-sports.component';
import { ComparisonNocturnalComponent } from '../src/app/pages/comparisons/comparison-nocturnal.component';

const injector=Injector.create({providers:[{provide:DestroyRef,useValue:{onDestroy:()=>()=>{}}}]});
const create=<T>(fn:()=>T):T=>runInInjectionContext(injector,fn);
const devices=[{id:'a',name:'A'},{id:'b',name:'B'}];
const sessions:any[]=[{id:'a1',device_id:'a'},{id:'a2',device_id:'a'},{id:'a3',device_id:'a'},{id:'b1',device_id:'b'}];

// Reopening restores every selected session, and toggling one never clears the others.
{
 let saved:any;
 const c=create(()=>new ComparisonSelectedSportComponent({saveSportSelection:(_w:any,_s:any,s:any)=>{saved=s;return of(s);}} as any));
 c.devices=devices;c.sessions=sessions;c.sport='running';c.selections={running:{session_ids:['a1','a2','b1']}};
 let emitted:string[]=[];c.selectionChange.subscribe(ids=>emitted=ids);
 c.ngOnInit();assert.deepEqual(c.selected.a,['a1','a2']);assert.equal(c.issue,'');
 c.select('a','a3');assert.deepEqual(emitted,['a1','a2','a3','b1']);
 c.select('a','a2');assert.deepEqual(emitted,['a1','a3','b1']);
 c.save();assert.deepEqual(saved.session_ids,emitted);
}
// A device without checked sessions must not fall back to all its sessions.
// Late results must not replace statistics for the latest selection.
{
 const requests:any[]=[];
 const c=create(()=>new ComparisonSportsComponent({} as any,{getSportAggregateCharts:(device:string,sport:string,ids:string[])=>{
   const response=new Subject<any>();requests.push({device,ids,response});return response;
 }} as any));
 c.devices=devices;c.mode='SELECTED';
 const sport:any={id:'running',sessions,generation:0,aggregates:[],correlation:{datasets:[]}};
 c.selectSessions(sport,['a1','a2']);assert.deepEqual(requests.map(r=>[r.device,r.ids]),[['a',['a1','a2']]]);
 c.selectSessions(sport,['a3']);assert.deepEqual(requests[1].ids,['a3']);
 const result=(n:number)=>({sessions:[{points:[{x:n,y:n+1}]}]});
 requests[1].response.next(result(30));requests[1].response.complete();
 requests[0].response.next(result(10));requests[0].response.complete();
 assert.deepEqual(sport.correlation.datasets[0].data,[{x:30,y:31}]);
 c.selectSessions(sport,[]);assert.equal(sport.correlation.datasets.length,0);assert.equal(requests.length,2);
}
// HRV and resting HR share the same explicit multi-night selection and save it.
{
 const calls:any[]=[];let saved:any;
 const metric=(ids:string[],offset:number)=>({by_session:ids.map((session_id,i)=>({session_id,points:[{x:i,y:i+offset}]})),stats:{n:ids.length}});
 const c=create(()=>new ComparisonNocturnalComponent({
   listNocturnalHrvSessions:(id:string)=>of(sessions.filter(s=>s.device_id===id)),
   getAggregatedHrvData:(id:string,ids:string[])=>{calls.push({id,ids});return of({n_sessions:ids.length,rmssd:metric(ids,1),hr:metric(ids,2)});}
 } as any,{saveNocturnalSelection:(_id:string,ids:string[])=>{saved=ids;return of({session_ids:ids});}} as any));
 c.devices=devices;c.mode='SELECTED';c.selection={session_ids:['a1','a2','b1']};c.ngOnInit();
 assert.deepEqual(calls,[{id:'a',ids:['a1','a2']},{id:'b',ids:['b1']}]);
 assert.equal(c.correlation.datasets[0].data.length,2);
 c.select('hr');assert.equal(c.correlation.datasets[0].data.length,2);assert.equal(calls.length,2);
 c.toggle('a1');assert.deepEqual(calls.at(-2).ids,['a2']);
 c.toggle('a2');assert.deepEqual(calls.at(-2).ids,[]);
 c.save();assert.deepEqual(saved,['b1']);
}
console.log('Comparison selection controller tests passed');

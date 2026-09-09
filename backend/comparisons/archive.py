"""Adapters for stored GPS runs and nocturnal windows. No source reimport."""
from datetime import datetime, timezone
from typing import Literal
import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.concurrency import run_in_threadpool
from .service import oid, digest, public
from .statistics import paired_metrics, summary, finite, VERSION
from .gps import describe
from .geometry import compare_geometry
from .synchronization import display_indices, json_values
from .definitions import archive_definitions

router=APIRouter(prefix="/api/comparison-archive",tags=["comparison archive"])
COLLECTIONS={"GPS_TRACK":"gps_tests","GPS_URBAN":"urban_tests","NIGHT_RMSSD":"nocturnal_hrv_sessions","NIGHT_HR":"nocturnal_hrv_sessions"}


class ArchiveSelection(BaseModel):
    model_config=ConfigDict(extra="forbid")
    name:str=Field(default="Comparativa del histórico",min_length=1,max_length=160)
    domain:Literal["GPS_TRACK","GPS_URBAN","NIGHT_RMSSD","NIGHT_HR"]
    mode:Literal["DIRECT","BENCHMARK"]="BENCHMARK"
    source_ids:list[str]=Field(min_length=2,max_length=100)
    reference_source_id:str|None=None
    assume_same_event:bool=False
    confirm_legacy_definition:bool=False

    @model_validator(mode="after")
    def coherent(self):
        if len(set(self.source_ids))!=len(self.source_ids):raise ValueError("Fuentes repetidas.")
        if self.reference_source_id and self.reference_source_id not in self.source_ids:raise ValueError("Referencia fuera de selección.")
        if self.mode=="DIRECT" and len(self.source_ids)>8:raise ValueError("Máximo 8 grabaciones directas.")
        if self.domain.startswith("GPS") and self.mode=="DIRECT" and not self.assume_same_event:raise ValueError("Declara explícitamente que las trayectorias corresponden a la misma prueba.")
        if self.domain.startswith("NIGHT") and not self.confirm_legacy_definition:raise ValueError("Confirma la definición de las ventanas históricas antes de comparar.")
        return self


def options_for(doc,domain,device_name):
    base={"device_id":str(doc["device_id"]),"device_name":device_name,"created_at":public(doc.get("created_at")),
          "source_document_id":str(doc["_id"]),"source_collection":COLLECTIONS[domain]}
    if domain.startswith("NIGHT"):
        return [{**base,"id":str(doc["_id"]),"name":doc.get("session_name","Noche"),
                 "source_url":f"/devices/{doc['device_id']}/nocturnal-hrv?session={doc['_id']}"}]
    rows=[]
    kind="track" if domain=="GPS_TRACK" else "urban"
    for mi,mode in enumerate(doc.get("modes",[])):
        for ri,run in enumerate(mode.get("runs",[])):
            rows.append({**base,"id":f"{doc['_id']}:{mi}:{ri}","name":f"{doc.get('name','GPS')} · {mode.get('name','Modo')} · {run.get('filename','Run')}",
                         "source_url":f"/devices/{doc['device_id']}/gps-analysis/{kind}?test={doc['_id']}"})
    return rows


@router.get("/options")
async def archive_options(request:Request,domain:Literal["GPS_TRACK","GPS_URBAN","NIGHT_RMSSD","NIGHT_HR"],offset:int=Query(default=0,ge=0)):
    db=request.app.state.db
    projection={"device_id":1,"name":1,"session_name":1,"created_at":1,"modes.name":1,"modes.runs.filename":1}
    docs=await db[COLLECTIONS[domain]].find({},projection).sort("created_at",-1).skip(offset).limit(51).to_list(length=51)
    devices={str(d["_id"]):d.get("name","Dispositivo") for d in await db.devices.find({}, {"name":1}).to_list(length=1000)}
    return {"items":[item for doc in docs[:50] for item in options_for(doc,domain,devices.get(str(doc["device_id"]),"Dispositivo"))],"has_more":len(docs)>50,"next_offset":offset+min(50,len(docs))}


async def load_sources(db,selection):
    ids=list(dict.fromkeys(s.split(':')[0] for s in selection.source_ids))
    docs=await db[COLLECTIONS[selection.domain]].find({"_id":{"$in":[oid(s) for s in ids]}}).to_list(length=len(ids))
    indexed={str(d["_id"]):d for d in docs}
    devices={str(d["_id"]):d.get("name","Dispositivo") for d in await db.devices.find({}, {"name":1}).to_list(length=1000)}
    result=[]
    for sid in selection.source_ids:
        doc=indexed.get(sid.split(':')[0])
        if not doc:raise HTTPException(404,"Fuente histórica no disponible.")
        option=next((o for o in options_for(doc,selection.domain,devices.get(str(doc["device_id"]),"Dispositivo")) if o["id"]==sid),None)
        if not option:raise HTTPException(404,"Run histórico no encontrado.")
        if selection.domain.startswith("GPS"):
            _,mi,ri=sid.split(':');data=doc['modes'][int(mi)]['runs'][int(ri)]
            source={**option,"data":data,"reference_distance":doc.get("reference_distance"),"ref_points":doc.get("ref_points",[])}
        else:
            reference_files=["polar_rr_bytes"] if selection.domain=="NIGHT_RMSSD" else ["polar_rr_bytes","polar_hr_bytes"]
            hashes=[digest(bytes(doc[k])) for k in reference_files if doc.get(k)]
            source={**option,"data":doc.get("windows",[]),"settings":doc.get("settings",{}),"secondary_source":doc.get("secondary_source"),
                    "reference_hash":digest(hashes) if hashes else None}
        source["fingerprint"]=digest({k:v for k,v in source.items() if k not in ("name","created_at","device_name","source_url")})
        result.append(source)
    return result


def gps_points(raw):
    stamps=pd.to_datetime([p.get("time") for p in raw],utc=True,errors="coerce",format="mixed")
    return [{"lat":float(p['lat']),"lon":float(p['lon']),"t":None if pd.isna(t) else t.timestamp(),"segment_id":p.get('segment_id',0)}
            for p,t in zip(raw,stamps) if finite(p.get('lat')) and finite(p.get('lon')) and abs(float(p['lat']))<=90 and abs(float(p['lon']))<=180]


def night_values(source,domain):
    refkey,devkey=("rmssdPolar","rmssdFitbit") if domain=="NIGHT_RMSSD" else ("hrPolar","hrFitbit")
    rows=source["data"]
    stamps=pd.to_datetime([w.get('tStart') for w in rows],utc=True,errors="coerce",format="mixed")
    result={}
    for row,stamp in zip(rows,stamps):
        t=stamp.timestamp() if not pd.isna(stamp) else float(row['tsMs'])/1000 if finite(row.get('tsMs')) else None
        if t is None:continue
        if t in result:raise ValueError("Ventanas nocturnas con timestamps duplicados; revisa la fuente.")
        result[t]=(float(row[refkey]) if finite(row.get(refkey)) else np.nan,float(row[devkey]) if finite(row.get(devkey)) else np.nan)
    return result


def calculate(sources,config):
    rows,tracks=[],[]
    base={"configuration":config.model_dump(),"processing_version":VERSION,"warnings":[],"series":[],"time":[],"tracks":tracks,
          "source_manifest":{s['id']:s['fingerprint'] for s in sources}}
    # Same device + same original run/windows must not count twice.
    seen=set()
    for source in sources:
        key=(source['device_id'],digest(source['data']))
        if key in seen:raise ValueError("Fuentes duplicadas del mismo dispositivo.")
        seen.add(key)
    if config.mode=='DIRECT' and len({s['device_id'] for s in sources})!=len(sources):raise ValueError("Elige una grabación por dispositivo para Direct.")
    if config.domain.startswith('GPS'):
        base['unit']='m'
        common=next((s for s in sources if s['id']==config.reference_source_id),sources[0])
        for source_index,source in enumerate(sources):
            described=describe(gps_points(source['data'].get('points',[])),-np.inf,np.inf)
            stats={k:v for k,v in described.items() if k not in ('segments','timed')}
            ref=(common if config.mode=='DIRECT' else source).get('reference_distance')
            distance=source['data'].get('distance_m')
            # Existing UI stored a coordinate-derived distance; never relabel native.
            stats['legacy_derived_distance_m']=distance if finite(distance) else None
            stats['distance_error_m']=distance-ref if finite(distance) and finite(ref) else None
            stats['distance_error_percent']=100*(distance-ref)/ref if finite(distance) and finite(ref) and ref>0 else None
            if config.domain=='GPS_URBAN':
                reference_source=common if config.mode=='DIRECT' else source
                reference=describe(gps_points(reference_source.get('ref_points',[])),-np.inf,np.inf)
                stats.update(compare_geometry(reference['segments'],[p for seg in described['segments'] for p in seg]))
                if config.mode!='DIRECT' or source_index==0:
                    tracks.append({'id':reference_source['id']+'-reference','name':reference_source['name']+' · Referencia geométrica','role':'reference','segments':reference['segments']})
            tracks.append({'id':source['id'],'device_id':source['device_id'],'name':source['device_name']+' · '+source['name'],'role':'device','segments':described['segments']})
            rows.append({**{k:v for k,v in source.items() if k not in ('data','ref_points')},'metrics':stats})
        base['warnings'].append('Distancia histórica derivada de coordenadas. La geometría urbana no aporta por sí sola una referencia temporal.')
        # Benchmark keeps independent maps; only explicit Direct overlays them.
    else:
        base['unit']='ms' if config.domain=='NIGHT_RMSSD' else 'bpm'
        if len({digest(s.get('settings')) for s in sources})>1:raise ValueError('Las noches usan ajustes de procesamiento diferentes. Homogeneiza la definición antes de agregarlas.')
        values=[night_values(s,config.domain) for s in sources]
        if any(not v for v in values):raise ValueError('Una noche no contiene ventanas con tiempo absoluto utilizable.')
        for values_for_source in values:
            times=sorted(values_for_source)
            if any((b-a)%300!=0 for a,b in zip(times,times[1:])):raise ValueError('La rejilla nocturna no es compatible con ventanas históricas de 5 minutos.')
        reference_index=next((i for i,s in enumerate(sources) if s['id']==config.reference_source_id),0)
        if config.mode=='DIRECT':
            hashes={s.get('reference_hash') for s in sources}
            if not (len(hashes)==1 and None not in hashes) and not config.assume_same_event:raise ValueError('No hay referencia nocturna común verificada; declara la misma noche y referencia.')
            start=max(min(v) for v in values);end=min(max(v) for v in values)
            if end<start or end-start>24*3600:raise ValueError('Las ventanas no comparten una noche temporal válida.')
            grid=np.arange(start,end+1,300)
            ref=np.array([values[reference_index].get(t,(np.nan,np.nan))[0] for t in grid])
            arrays=[np.array([v.get(t,(np.nan,np.nan))[1] for t in grid]) for v in values]
            indices=display_indices([ref]+arrays)
            base['time']=(grid[indices]-start).tolist();base['start_utc']=float(start)
            base['series']=[{'id':'reference','name':'Referencia nocturna','role':'reference','values':json_values(ref[indices])}]
        for i,(source,value) in enumerate(zip(sources,values)):
            if config.mode=='DIRECT':x,y=ref,arrays[i]
            else:
                if max(value)-min(value)>7*24*3600:raise ValueError('La fuente supera 7 días: selecciona noches individuales.')
                times=np.arange(min(value),max(value)+1,300)
                x=np.array([value.get(t,(np.nan,np.nan))[0] for t in times]);y=np.array([value.get(t,(np.nan,np.nan))[1] for t in times])
            stats=paired_metrics(x,y)
            if config.domain=='NIGHT_RMSSD':
                for key in ('within_3_bpm','within_5_bpm','within_10_bpm'):stats.pop(key,None)
            stats['gap_seconds']=stats.pop('missing_duration')*300
            stats['longest_gap_seconds']=stats.pop('longest_gap')*300
            rows.append({**{k:v for k,v in source.items() if k not in ('data',)},'metrics':stats,
                         'reference_source_id':sources[reference_index]['id'] if config.mode=='DIRECT' else source['id']})
            if config.mode=='DIRECT':base['series'].append({'id':source['id'],'device_id':source['device_id'],'name':source['device_name'],'role':'device','values':json_values(y[indices]),'errors':json_values((y-x)[indices])})
        base['warnings'].append('Ventanas guardadas de 5 min, no una nueva extracción de RR. La definición heredada se acepta explícitamente; no se mezclan RMSSD y SDNN ni épocas de sueño.')
    definitions=archive_definitions(config.domain)
    metric_keys=[d['id'] for d in definitions]
    base.update(rows=rows,metric_keys=metric_keys,statistics=definitions,groups=[])
    for device_id in dict.fromkeys(s['device_id'] for s in sources):
        selected=[r for r in rows if r['device_id']==device_id]
        # Runs in one stored test are one experimental cluster, not extra sessions.
        clusters={r['source_document_id'] for r in selected}
        grouped={k:summary([summary([r['metrics'].get(k) for r in selected if r['source_document_id']==cluster])['mean'] for cluster in clusters]) for k in metric_keys}
        base['groups'].append({'device_id':device_id,'device_name':selected[0]['device_name'],'n_sources':len(selected),'n_sessions':len(clusters),'metrics':grouped})
    return public(base)


async def build_archive(db,body):
    sources=await load_sources(db,body)
    try:return await run_in_threadpool(calculate,sources,body)
    except ValueError as exc:raise HTTPException(422,str(exc))


@router.post('/preview')
async def preview(request:Request,body:ArchiveSelection):return await build_archive(request.app.state.db,body)


@router.post('/comparisons',status_code=201)
async def save(request:Request,body:ArchiveSelection):
    db=request.app.state.db
    result=await build_archive(db,body)
    for row in result['rows']:
        rid=digest([body.domain,row['id'],row['fingerprint'],body.model_dump(),row['metrics'],VERSION])
        await db.analysis_revisions.update_one({'_id':rid},{'$setOnInsert':{'metric_type':body.domain,'metrics':row['metrics'],'source_locator':{k:row[k] for k in ('source_collection','source_document_id','id')},'processing_version':VERSION,'configuration':body.model_dump(),'created_at':datetime.now(timezone.utc)}},upsert=True)
        row['analysis_revision_id']=rid
    evidence={k:v for k,v in result.items() if k not in ('series','time','tracks')}
    doc={'configuration':body.model_dump(),'evidence':evidence,'created_at':datetime.now(timezone.utc)}
    inserted=await db.archive_comparisons.insert_one(doc)
    return {'id':str(inserted.inserted_id),'result':result}


@router.get('/comparisons')
async def saved(request:Request,offset:int=Query(default=0,ge=0)):
    return public(await request.app.state.db.archive_comparisons.find({}, {'configuration':1,'created_at':1}).sort('created_at',-1).skip(offset).limit(50).to_list(length=50))


@router.get('/comparisons/{comparison_id}')
async def reopen(request:Request,comparison_id:str):
    db=request.app.state.db
    doc=await db.archive_comparisons.find_one({'_id':oid(comparison_id)})
    if not doc:raise HTTPException(404,'Comparativa no encontrada')
    if doc['configuration']['mode']=='BENCHMARK':return {'id':comparison_id,'result':public(doc['evidence'])}
    if doc['evidence']['processing_version']!=VERSION:raise HTTPException(409,'Versión anterior: consulta la evidencia congelada.')
    result=await build_archive(db,ArchiveSelection(**doc['configuration']))
    if result['source_manifest']!=doc['evidence']['source_manifest']:raise HTTPException(409,'Las fuentes cambiaron; se conserva la evidencia congelada.')
    result.update(doc['evidence'])
    return {'id':comparison_id,'result':public(result)}


@router.get('/comparisons/{comparison_id}/evidence')
async def evidence(request:Request,comparison_id:str):
    doc=await request.app.state.db.archive_comparisons.find_one({'_id':oid(comparison_id)},{'evidence':1,'created_at':1})
    if not doc:raise HTTPException(404,'Comparativa no encontrada')
    return public(doc)


async def protect_archive(db,collection,ids):
    if await db.archive_comparisons.find_one({'evidence.rows':{'$elemMatch':{'source_collection':collection,'source_document_id':{'$in':ids}}}},{'_id':1}):
        raise HTTPException(409,'La fuente está vinculada a una comparativa del histórico. Se conserva para mantener su trazabilidad.')


async def ensure_archive_recordings(db,doc,domain,migration_run=None):
    created=[]
    for option in options_for(doc,domain,doc.get('device_name','Dispositivo')):
        rid=digest([COLLECTIONS[domain],option['id']])
        channels=['rmssd_5min','hr_5min'] if domain.startswith('NIGHT') else ['gps']
        await db.recordings.update_one({'_id':rid},{'$setOnInsert':{
            'device_id':str(doc['device_id']),'label':option['name'],'channels':channels,
            'source_locator':{'collection':COLLECTIONS[domain],'document_id':str(doc['_id']),'source_id':option['id']},
            'original_available':False,'availability':'stored_windows' if domain.startswith('NIGHT') else 'stored_coordinates',
            'created_at':datetime.now(timezone.utc),'migration_version':2,'migration_run_id':migration_run}},upsert=True)
        created.append(rid)
    return created

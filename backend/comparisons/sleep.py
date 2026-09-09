"""Explicit epoch labels and versioned mappings; never infer sleep from HR/HRV."""
from datetime import datetime,timezone
from typing import Literal
import numpy as np
from fastapi import APIRouter,Request,HTTPException,Query
from pydantic import BaseModel,ConfigDict,Field,AwareDatetime,model_validator
from starlette.concurrency import run_in_threadpool
from .service import digest,public,oid
from .statistics import summary

router=APIRouter(prefix='/api/comparison-sleep',tags=['comparison sleep'])
VERSION='sleep-epoch-1'
SCHEMAS={'FIVE_STAGE':['WAKE','N1','N2','N3','REM'],'FOUR_STAGE':['WAKE','LIGHT','DEEP','REM']}


class Epoch(BaseModel):
    model_config=ConfigDict(extra='forbid')
    start_utc:AwareDatetime
    stage:str=Field(min_length=1,max_length=80)


class SleepRecording(BaseModel):
    model_config=ConfigDict(extra='forbid')
    name:str=Field(min_length=1,max_length=160)
    device_id:str|None=None
    reference_label:str|None=Field(default=None,max_length=160)
    participant_id:str=Field(min_length=1,max_length=100)
    night_id:str|None=Field(default=None,min_length=1,max_length=100)
    source_filename:str=Field(default='',max_length=200)
    epoch_seconds:Literal[30,60]=30
    stage_schema:Literal['FIVE_STAGE','FOUR_STAGE']='FIVE_STAGE'
    mapping_version:str=Field(min_length=1,max_length=80)
    stage_map:dict[str,str]=Field(min_length=1,max_length=30)
    epochs:list[Epoch]=Field(min_length=1,max_length=6000)
    reference_quality:Literal['GOLD_STANDARD','RESEARCH_GRADE','VALIDATED_REFERENCE','PRACTICAL_REFERENCE','COMPARATIVE_REFERENCE']|None=None

    @model_validator(mode='after')
    def valid_epochs(self):
        if not self.device_id and not self.reference_label:raise ValueError('Indica dispositivo o nombre de referencia.')
        if any(len(k)>80 or v not in SCHEMAS[self.stage_schema] for k,v in self.stage_map.items()):raise ValueError('Mapping incompatible con las clases seleccionadas.')
        stamps=sorted(e.start_utc.timestamp() for e in self.epochs)
        if any(b-a<self.epoch_seconds for a,b in zip(stamps,stamps[1:])):raise ValueError('Épocas duplicadas o solapadas.')
        if stamps[-1]-stamps[0]>48*3600:raise ValueError('Importa una noche de hasta 48 h por grabación.')
        return self


class SleepSelection(BaseModel):
    model_config=ConfigDict(extra='forbid')
    name:str=Field(default='Comparación de sueño',min_length=1,max_length=160)
    reference_id:str
    recording_ids:list[str]=Field(min_length=1,max_length=8)

    @model_validator(mode='after')
    def distinct(self):
        if len(set(self.recording_ids))!=len(self.recording_ids) or self.reference_id in self.recording_ids:raise ValueError('Referencia y dispositivos deben ser grabaciones distintas.')
        return self


class SleepBenchmark(BaseModel):
    model_config=ConfigDict(extra='forbid')
    comparison_ids:list[str]=Field(min_length=2,max_length=100)

    @model_validator(mode='after')
    def unique(self):
        if len(set(self.comparison_ids))!=len(self.comparison_ids):raise ValueError('Comparativas repetidas.')
        return self


def classify(reference,device):
    if reference['stage_schema']!=device['stage_schema'] or reference['epoch_seconds']!=device['epoch_seconds']:
        raise ValueError('Las épocas deben compartir duración y esquema de clases.')
    if reference['participant_id']!=device['participant_id']:raise ValueError('Las grabaciones pertenecen a participantes distintos.')
    classes=SCHEMAS[reference['stage_schema']];step=reference['epoch_seconds']
    def timestamps(doc):
        return {datetime.fromisoformat(e['start_utc']).timestamp():doc['stage_map'].get(e['stage']) for e in doc['epochs']}
    ref,dev=timestamps(reference),timestamps(device)
    if max(min(ref),min(dev))>min(max(ref),max(dev)):raise ValueError('No hay noche temporal común.')
    # Missing leading/trailing device epochs must reduce coverage of the reference night.
    start=min(ref);end=max(ref)
    if any((t-start)%step!=0 for t in [*ref,*dev]):raise ValueError('Los comienzos de época no comparten rejilla UTC; no se desplazan etiquetas automáticamente.')
    grid=np.arange(start,end+step,step)
    matrix=np.zeros((len(classes),len(classes)),dtype=int)
    invalid_ref,invalid_dev=0,0
    for stamp in grid:
        a,b=ref.get(stamp),dev.get(stamp)
        if a not in classes:invalid_ref+=1
        if b not in classes:invalid_dev+=1
        if a in classes and b in classes:matrix[classes.index(a),classes.index(b)]+=1
    n=int(matrix.sum());correct=int(np.trace(matrix))
    accuracy=correct/n if n else None
    expected=float(np.dot(matrix.sum(axis=0),matrix.sum(axis=1))/n**2) if n else None
    kappa=(accuracy-expected)/(1-expected) if expected is not None and expected<1 else None
    per_class=[]
    for i,name in enumerate(classes):
        tp=int(matrix[i,i]);ref_n=int(matrix[i].sum());dev_n=int(matrix[:,i].sum())
        per_class.append({'class':name,'reference_n':ref_n,'device_n':dev_n,'precision':tp/dev_n if dev_n else None,
                          'recall':tp/ref_n if ref_n else None,'f1':2*tp/(ref_n+dev_n) if ref_n+dev_n else None})
    return {'classes':classes,'confusion_matrix':matrix.tolist(),'n_epochs':n,'expected_epochs':len(grid),
            'coverage_percent':100*n/len(grid) if len(grid) else None,'agreement_percent':100*accuracy if accuracy is not None else None,
            'kappa':kappa,'per_class':per_class,'reference_missing_or_unmapped':invalid_ref,'device_missing_or_unmapped':invalid_dev,
            'start_utc':float(start),'end_utc':float(end+step),'epoch_seconds':step,'matrix_rows':'reference','matrix_columns':'device',
            'coverage_window':'full_reference_recording','device_epochs_outside_reference':sum(t<start or t>end for t in dev),
            'processing_version':VERSION,'reference_mapping_version':reference['mapping_version'],'device_mapping_version':device['mapping_version']}


@router.post('/recordings',status_code=201)
async def import_recording(request:Request,body:SleepRecording):
    db=request.app.state.db
    if body.device_id and not await db.devices.find_one({'_id':oid(body.device_id)}):raise HTTPException(404,'Dispositivo no encontrado.')
    data=body.model_dump(mode='json');data['epochs'].sort(key=lambda e:datetime.fromisoformat(e['start_utc']).timestamp())
    rid=digest(data)
    await db.sleep_recordings.update_one({'_id':rid},{'$setOnInsert':{**data,'created_at':datetime.now(timezone.utc),'fingerprint':rid}},upsert=True)
    return {'id':rid,'epoch_count':len(data['epochs'])}


@router.get('/recordings')
async def recordings(request:Request,offset:int=Query(default=0,ge=0)):
    return public(await request.app.state.db.sleep_recordings.find({}, {'epochs':0,'stage_map':0}).sort('created_at',-1).skip(offset).limit(100).to_list(length=100))


@router.get('/recordings/{recording_id}')
async def recording(request:Request,recording_id:str):
    doc=await request.app.state.db.sleep_recordings.find_one({'_id':recording_id})
    if not doc:raise HTTPException(404,'Grabación no encontrada.')
    return public(doc)


async def build(db,selection):
    docs=await db.sleep_recordings.find({'_id':{'$in':[selection.reference_id,*selection.recording_ids]}}).to_list(length=9)
    indexed={doc['_id']:doc for doc in docs}
    if len(indexed)!=len(selection.recording_ids)+1:raise HTTPException(404,'Falta una grabación.')
    rows=[]
    reference=indexed[selection.reference_id]
    identities=[indexed[rid].get('device_id') for rid in selection.recording_ids]
    if not all(identities) or len(set(identities))!=len(identities):raise HTTPException(422,'Elige una grabación por dispositivo; una referencia externa no es un dispositivo analizado.')
    for rid in selection.recording_ids:
        doc=indexed[rid]
        try:metrics=await run_in_threadpool(classify,reference,doc)
        except ValueError as exc:raise HTTPException(422,str(exc))
        rows.append({'recording_id':rid,'name':doc['name'],'device_id':doc['device_id'],'metrics':metrics})
    return {'configuration':selection.model_dump(),'rows':rows,'reference_name':reference['name'],
            'participant_id':reference['participant_id'],'night_id':reference.get('night_id'),
            'reference_quality':reference.get('reference_quality'),'source_manifest':{d['_id']:d['fingerprint'] for d in docs},'processing_version':VERSION}


@router.post('/preview')
async def preview(request:Request,body:SleepSelection):return await build(request.app.state.db,body)


@router.post('/comparisons',status_code=201)
async def save(request:Request,body:SleepSelection):
    result=await build(request.app.state.db,body)
    inserted=await request.app.state.db.sleep_comparisons.insert_one({'evidence':result,'configuration':body.model_dump(),'created_at':datetime.now(timezone.utc)})
    return {'id':str(inserted.inserted_id),'result':result}


@router.get('/comparisons')
async def comparisons(request:Request):
    return public(await request.app.state.db.sleep_comparisons.find({}, {'configuration':1,'created_at':1}).sort('created_at',-1).limit(100).to_list(length=100))


@router.get('/comparisons/{comparison_id}')
async def evidence(request:Request,comparison_id:str):
    doc=await request.app.state.db.sleep_comparisons.find_one({'_id':oid(comparison_id)})
    if not doc:raise HTTPException(404,'Comparativa no encontrada.')
    return {'id':comparison_id,'result':public(doc['evidence'])}


@router.post('/benchmark')
async def benchmark(request:Request,body:SleepBenchmark):
    docs=await request.app.state.db.sleep_comparisons.find({'_id':{'$in':[oid(s) for s in body.comparison_ids]}}).to_list(length=len(body.comparison_ids))
    if len(docs)!=len(body.comparison_ids):raise HTTPException(404,'Falta una comparativa de sueño.')
    buckets={};rows=[];seen=set();definitions=set()
    for doc in docs:
        evidence=doc['evidence']
        if evidence['processing_version']!=VERSION:raise HTTPException(422,'Hay versiones metodológicas distintas.')
        if not evidence.get('night_id'):raise HTTPException(422,'El benchmark requiere un night_id declarado en cada referencia; no se infiere por fecha de subida.')
        for row in evidence['rows']:
            definitions.add((tuple(row['metrics']['classes']),row['metrics']['epoch_seconds']))
            identity=(row['device_id'],evidence['participant_id'],evidence['night_id'])
            if identity in seen:raise HTTPException(422,'Una noche del mismo participante/dispositivo aparece más de una vez.')
            seen.add(identity)
            item={**row,'comparison_id':str(doc['_id']),'participant_id':evidence['participant_id'],'night_id':evidence['night_id']}
            rows.append(item);buckets.setdefault(row['device_id'],[]).append(item)
    if len(definitions)!=1:raise HTTPException(422,'Esquemas de etapas o duración de época incompatibles.')
    keys=['agreement_percent','coverage_percent','kappa']
    return {'rows':rows,'aggregation':'equal_weight_per_declared_night',
            'groups':[{'device_id':did,'name':values[0]['name'],'n_nights':len(values),
                       'metrics':{key:summary([r['metrics'].get(key) for r in values]) for key in keys}} for did,values in buckets.items()]}

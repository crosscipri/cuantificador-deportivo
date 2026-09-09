from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request
from .models import Selection, ExperimentInput, ReferenceUpdate, PROTOCOLS
from .statistics import METRICS, VERSION
from .service import (build, public, oid, sessions_for, ensure_recordings, read_hr,
                      direct_compute, source_manifest,digest)
from starlette.concurrency import run_in_threadpool
from pymongo.errors import DuplicateKeyError
from .channels import read_channels

router = APIRouter(prefix="/api", tags=["comparisons"])


@router.get("/comparison-definitions")
async def definitions():
    return {"version": VERSION, "protocols": PROTOCOLS,
            "statistics": [{"id": k, "name": v[0], "description": v[1], "unit": v[2]} for k,v in METRICS.items()]}


@router.get("/comparison-options/sessions")
async def options(request: Request, device_id: str | None = None,
                  protocol_id: str | None = None, sport_type: str | None = None,
                  session_ids: str | None = None,
                  offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=200)):
    db = request.app.state.db
    query = {}
    if session_ids:
        ids = session_ids.split(",")
        if len(ids)>100:
            raise HTTPException(422, "Máximo 100 sesiones por consulta.")
        query["_id"] = {"$in": [oid(s) for s in ids]}
    if device_id:
        query["device_id"] = oid(device_id)
    if protocol_id:
        query["protocol_id"] = protocol_id
    if sport_type:
        query["sport_type"] = sport_type
    fields = {k: 1 for k in ("device_id", "device_name", "reference_name", "session_name", "activity_date",
                             "sport_type", "session_difficulty", "training_type", "duration_seconds",
                             "experiment_id", "protocol_id", "protocol_version", "metrics",
                             "reference_recording_id", "recording_id","firmware","participant_id")}
    cursor = db.sessions.find(query, fields).sort("activity_date", -1).skip(offset).limit(limit+1)
    docs = await cursor.to_list(length=limit+1)
    return {"items": public(docs[:limit]), "has_more": len(docs)>limit, "offset": offset}


@router.get("/recordings")
async def recordings(request: Request, offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=200)):
    return public(await request.app.state.db.recordings.find().skip(offset).limit(limit).to_list(length=limit))


@router.get("/experiments")
async def experiments(request: Request, offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=200)):
    return public(await request.app.state.db.experiments.find().sort("created_at", -1).skip(offset).limit(limit).to_list(length=limit))


@router.get("/experiments/{experiment_id}")
async def experiment(request: Request, experiment_id: str):
    doc = await request.app.state.db.experiments.find_one({"_id": oid(experiment_id)})
    if not doc:
        raise HTTPException(404, "Experimento no encontrado")
    return public(doc)


@router.post("/experiments", status_code=201)
async def create_experiment(request: Request, body: ExperimentInput):
    db = request.app.state.db
    if len(set(body.session_ids)) != len(body.session_ids):
        raise HTTPException(422, "Sesiones duplicadas")
    if body.reference_session_id not in body.session_ids or (body.gps_reference_session_id and body.gps_reference_session_id not in body.session_ids):
        raise HTTPException(422, "Selecciona la referencia entre las sesiones del experimento.")
    from .protocols import resolve_protocol
    protocol = await resolve_protocol(db,body.protocol_id,body.protocol_version) if body.protocol_id else None
    docs = await sessions_for(db, body.session_ids)
    if any(d.get("experiment_id") for d in docs):
        raise HTTPException(409, "Una sesión ya está asociada a un experimento.")
    docs = [await ensure_recordings(db, d) for d in docs]
    ref = next(d for d in docs if str(d["_id"]) == body.reference_session_id)
    def bounds():
        series = [read_hr(d, "device") for d in docs]+[read_hr(ref, "reference")]
        return float(max(s.index.min() for s in series)), float(min(s.index.max() for s in series))
    try:
        start, end = await run_in_threadpool(bounds)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    if start >= end:
        raise HTTPException(422, "Las grabaciones no comparten una ventana temporal real.")
    doc = {**body.model_dump(), "protocol_snapshot":protocol,"recording_ids": [d["recording_id"] for d in docs],
           "references": {"hr": {"recording_id": ref["reference_recording_id"],
                                   "source_session_id": body.reference_session_id,
                                   "quality": body.reference_quality}},
           "start_utc": start, "end_utc": end, "association": "USER_DECLARED",
           "created_at": datetime.now(timezone.utc)}
    if body.gps_reference_session_id:
        gpsref = next(d for d in docs if str(d["_id"]) == body.gps_reference_session_id)
        doc["references"]["gps"] = {"recording_id": gpsref["reference_recording_id"],
                                    "source_session_id": body.gps_reference_session_id, "quality": body.reference_quality}
    try:
        result = await db.experiments.insert_one(doc)
    except DuplicateKeyError:
        raise HTTPException(409, "Una sesión ya pertenece a otro experimento.")
    await db.sessions.update_many({"_id": {"$in": [d["_id"] for d in docs]}}, {"$set": {
        "experiment_id": str(result.inserted_id), "protocol_id": body.protocol_id, "protocol_version": body.protocol_version,"protocol_snapshot":protocol}})
    await db.recordings.update_many({"_id": {"$in": doc["recording_ids"]}}, {"$set": {"experiment_id": str(result.inserted_id)}})
    doc["_id"] = result.inserted_id
    return public(doc)


@router.post("/comparisons/preview")
async def preview(request: Request, body: Selection):
    return await build(request.app.state.db, body)


@router.post('/experiments/{experiment_id}/references')
async def update_references(request:Request,experiment_id:str,body:ReferenceUpdate):
    db=request.app.state.db
    experiment=await db.experiments.find_one({'_id':oid(experiment_id)})
    if not experiment:raise HTTPException(404,'Experimento no encontrado.')
    if any(s and s not in experiment['session_ids'] for s in (body.reference_session_id,body.gps_reference_session_id)):
        raise HTTPException(422,'Las referencias deben proceder de grabaciones del experimento.')
    docs=await sessions_for(db,experiment['session_ids'])
    docs=[await ensure_recordings(db,d) for d in docs]
    indexed={str(d['_id']):d for d in docs}
    refs={}
    for metric,sid,quality in [('hr',body.reference_session_id,body.hr_quality),('gps',body.gps_reference_session_id,body.gps_quality)]:
        if sid:refs[metric]={'recording_id':indexed[sid]['reference_recording_id'],'source_session_id':sid,'quality':quality}
    rid=digest([experiment_id,experiment.get('reference_revision_id'),body.model_dump(),refs])
    await db.experiment_revisions.update_one({'_id':rid},{'$setOnInsert':{'experiment_id':experiment_id,
        'before':experiment.get('references',{}),'after':refs,'notes':body.notes,'previous_revision_id':experiment.get('reference_revision_id'),
        'created_at':datetime.now(timezone.utc)}},upsert=True)
    updated=await db.experiments.update_one({'_id':experiment['_id'],'reference_revision_id':experiment.get('reference_revision_id')},
        {'$set':{'references':refs,'reference_session_id':body.reference_session_id,'gps_reference_session_id':body.gps_reference_session_id,'reference_revision_id':rid}})
    if not updated.matched_count:raise HTTPException(409,'Las referencias cambiaron durante la edición; recarga el experimento.')
    return {'reference_revision_id':rid,'references':refs}


@router.get("/comparisons")
async def comparisons(request: Request, offset: int = Query(default=0, ge=0), limit: int = Query(default=50, ge=1, le=100)):
    docs = await request.app.state.db.comparisons.find({}, {"configuration": 1, "created_at": 1, "source_analysis_versions": 1}).sort("created_at", -1).skip(offset).limit(limit).to_list(length=limit)
    return public(docs)


@router.post("/comparisons", status_code=201)
async def create_comparison(request: Request, body: Selection):
    return await store_comparison(request.app.state.db,body)


async def store_comparison(db, body, parent=None):
    result = await build(db, body)
    # Freeze scalar evidence and source revisions. Never copy temporal datasets.
    evidence = {k:v for k,v in result.items() if k not in ("series", "time", "gps", "diagnostics")}
    gps_evidence = None
    if result.get("gps"):
        gps_evidence = {"reference_available": result["gps"]["reference_available"],
                        "rows": [{k: v for k, v in row.items() if k != "position_errors"}
                                 for row in result["gps"]["rows"]]}
    configuration=body.model_dump() if body.storage_mode=="LIVE" else result["configuration"]
    doc = {"configuration": configuration, "evidence": evidence,
           "gps_evidence": gps_evidence,
           "source_analysis_versions": [r["analysis_revision_id"] for r in result["rows"]] +
                                       [r["analysis_revision_id"] for r in (gps_evidence or {}).get("rows", [])],
           "created_at": datetime.now(timezone.utc), "storage_mode": body.storage_mode,
           "parent_comparison_id":str(parent["_id"]) if parent else None,
           "root_comparison_id":parent.get("root_comparison_id") or str(parent["_id"]) if parent else None}
    inserted = await db.comparisons.insert_one(doc)
    return {"id": str(inserted.inserted_id), "result": result}


@router.get("/comparisons/{comparison_id}")
async def comparison(request: Request, comparison_id: str):
    db = request.app.state.db
    doc = await db.comparisons.find_one({"_id": oid(comparison_id)})
    if not doc:
        raise HTTPException(404, "Comparativa no encontrada")
    if doc.get("storage_mode")=="LIVE":
        result=await build(db,Selection(**doc["configuration"]))
        return {"id":comparison_id,"created_at":public(doc["created_at"]),"storage_mode":"LIVE","selection_request":doc["configuration"],"result":result}
    if doc["configuration"]["mode"] == "BENCHMARK":
        result = doc["evidence"]
    else:
        # Display is reconstructed only from immutable retained source files.
        if doc["evidence"]["processing_version"] != VERSION:
            raise HTTPException(409, "Este snapshot utiliza una versión anterior del motor. Su evidencia sigue conservada, pero no se reconstruirá con otra metodología.")
        frozen = doc["evidence"]
        sources = await sessions_for(db, doc["configuration"]["session_ids"])
        if frozen.get("source_manifest") and source_manifest(sources) != frozen["source_manifest"]:
            raise HTTPException(409, "Los archivos fuente han cambiado; se conserva el snapshot de evidencia.")
        try:
            result = public(await run_in_threadpool(direct_compute, sources, Selection(**doc["configuration"])))
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        if not frozen.get("source_manifest"):
            for row, original in zip(result["rows"], frozen["rows"]):
                if row["original_files"] != original["original_files"]:
                    raise HTTPException(409, "Los archivos fuente han cambiado; se conserva el snapshot de evidencia.")
        if doc.get("gps_evidence"):
            for row, original in zip(result["gps"]["rows"], doc["gps_evidence"]["rows"]):
                row.update(original)
        result.update(frozen)
    return {"id": comparison_id, "created_at": public(doc["created_at"]), "storage_mode":"SNAPSHOT","result": public(result)}


@router.post("/comparisons/{comparison_id}/revisions",status_code=201)
async def revise_comparison(request:Request, comparison_id:str, body:Selection):
    db=request.app.state.db
    parent=await db.comparisons.find_one({"_id":oid(comparison_id)})
    if not parent:raise HTTPException(404,"Comparativa no encontrada")
    return await store_comparison(db,body,parent)


@router.get("/comparisons/{comparison_id}/revisions")
async def comparison_revisions(request:Request,comparison_id:str):
    db=request.app.state.db
    parent=await db.comparisons.find_one({"_id":oid(comparison_id)})
    if not parent:raise HTTPException(404,"Comparativa no encontrada")
    root=parent.get("root_comparison_id") or comparison_id
    docs=await db.comparisons.find({"$or":[{"_id":oid(root)},{"root_comparison_id":root}]},
                                   {"configuration":1,"created_at":1,"parent_comparison_id":1}).sort("created_at",1).to_list(length=1000)
    return public(docs)


@router.get("/comparisons/{comparison_id}/evidence")
async def comparison_evidence(request: Request, comparison_id: str):
    """Frozen evidence remains readable even when signals cannot be rebuilt."""
    doc = await request.app.state.db.comparisons.find_one({"_id": oid(comparison_id)})
    if not doc:
        raise HTTPException(404, "Comparativa no encontrada")
    return public({"id": comparison_id, "created_at": doc["created_at"],
                   "evidence": doc["evidence"], "gps_evidence": doc.get("gps_evidence"),
                   "source_analysis_versions": doc["source_analysis_versions"]})


@router.get("/analysis-revisions/{revision_id}")
async def analysis(request: Request, revision_id: str):
    doc = await request.app.state.db.analysis_revisions.find_one({"_id": revision_id})
    if not doc:
        raise HTTPException(404, "Revisión no encontrada")
    return public(doc)


@router.get('/comparison-sessions/{session_id}/channels')
async def channels(request:Request,session_id:str,role:str=Query(default='device',pattern='^(device|reference)$'),offset:int=Query(default=0,ge=0)):
    doc=(await sessions_for(request.app.state.db,[session_id]))[0]
    raw=doc.get(f'{role}_file_bytes')
    if not raw:raise HTTPException(422,'No se conservaron los originales de esta fuente.')
    try:result=await run_in_threadpool(read_channels,bytes(raw),doc.get(f'{role}_file_name',''))
    except (ValueError,TypeError) as exc:raise HTTPException(422,str(exc))
    records=result.pop('records')
    return public({**result,'records':records[offset:offset+5000],'has_more':len(records)>offset+5000,'offset':offset,
                   'source_session_id':session_id,'role':role,'fingerprint':source_manifest([doc])[session_id][role]['hash']})


@router.get('/comparison-sessions/{session_id}/historical-chart')
async def historical_chart(request:Request,session_id:str):
    doc=await request.app.state.db.sessions.find_one({'_id':oid(session_id)},{'fc_data':1,'device_id':1,'device_name':1,'reference_name':1,'session_name':1})
    if not doc:raise HTTPException(404,'Sesión no encontrada.')
    data=doc.get('fc_data') or {};time=data.get('time',[]);reference=data.get('reference',[]);device=data.get('device',[])
    if not time or not(len(time)==len(reference)==len(device)):raise HTTPException(422,'La sesión no conserva una gráfica completa.')
    return public({'session_id':session_id,'name':doc.get('session_name'),'time':time,
                   'series':[{'id':'reference','name':doc.get('reference_name','Referencia'),'role':'reference','values':reference},
                             {'id':session_id,'device_id':str(doc['device_id']),'name':doc.get('device_name','Dispositivo'),'role':'device','values':device}],
                   'processing_version':'legacy_current_source_chart'})

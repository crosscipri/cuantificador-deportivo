"""Per-source journal. Rollback restores untouched links and retains evidence."""
from datetime import datetime,timezone
from uuid import uuid4
from fastapi import HTTPException
from comparisons.service import create_indexes,ensure_recordings,protect_sources,oid
from comparisons.archive import ensure_archive_recordings,COLLECTIONS

LINKS=('recording_id','reference_recording_id','legacy_analysis_revision_id','comparison_migration_run')


async def rollback(db,run_id,apply):
    run=await db.migration_runs.find_one({'_id':run_id})
    if not run:raise ValueError('Migración no encontrada.')
    counts={'mode':'rollback-apply' if apply else 'rollback-dry-run','restored':0,'protected':0,'changed':0}
    async for item in db.migration_items.find({'run_id':run_id,'kind':'hr','status':{'$in':['APPLIED','PREPARED']}}):
        current=await db.sessions.find_one({'_id':oid(item['source_id'])})
        if not current or current.get('comparison_migration_run')!=run_id:
            counts['changed']+=1;continue
        if item.get('after') and any(current.get(k)!=v for k,v in item['after'].items()):
            counts['changed']+=1;continue
        try:await protect_sources(db,[item['source_id']])
        except HTTPException:
            counts['protected']+=1;continue
        if await db.analysis_revisions.find_one({'source_session_id':item['source_id'],'migration_run_id':{'$ne':run_id},'created_at':{'$gt':run['created_at']}}):
            counts['protected']+=1;continue
        if apply:
            before=item['before'];updates={}
            restore={k:v['value'] for k,v in before.items() if v['present']}
            unset={k:'' for k,v in before.items() if not v['present']}
            if restore:updates['$set']=restore
            if unset:updates['$unset']=unset
            match={'_id':current['_id'],**{k:current.get(k) for k in LINKS}}
            changed=await db.sessions.update_one(match,updates)
            if not changed.matched_count:counts['changed']+=1;continue
            await db.migration_items.update_one({'_id':item['_id']},{'$set':{'status':'LINKS_RESTORED','rollback_at':datetime.now(timezone.utc)}})
        counts['restored']+=1
    if apply:await db.migration_runs.update_one({'_id':run_id},{'$set':{'status':'ROLLBACK_LINKS_PARTIAL' if counts['protected'] or counts['changed'] else 'ROLLBACK_LINKS_COMPLETE','rollback':counts}})
    counts['retention']='All sources, recordings, revisions and audit documents retained.'
    return counts


async def execute(db,apply,run_id=None,rollback_id=None,hr_only=False):
    if rollback_id:return await rollback(db,rollback_id,apply)
    run_id=run_id or str(uuid4())
    started=False
    counts={'sessions':0,'without_originals':0,'adapted':0,'already_applied':0,'archive_documents':0,'archive_recordings':0,'mode':'apply' if apply else 'dry-run'}
    try:
        if apply:
            await create_indexes(db)
            await db.migration_items.create_index([('run_id',1),('status',1)])
            old=await db.migration_runs.find_one({'_id':run_id})
            if old and old.get('status','').startswith('ROLLBACK'):raise ValueError('No se puede reanudar una migración revertida; inicia otro run.')
            await db.migration_runs.update_one({'_id':run_id},{'$setOnInsert':{'created_at':datetime.now(timezone.utc),'version':2},'$set':{'status':'RUNNING'}},upsert=True)
            started=True
            print({'run_id':run_id,'mode':'apply'})
        async for doc in db.sessions.find().sort('_id',1).batch_size(20):
            counts['sessions']+=1
            if not doc.get('device_file_bytes') or not doc.get('reference_file_bytes'):counts['without_originals']+=1
            if not apply:continue
            item_id=f"{run_id}:hr:{doc['_id']}"
            previous=await db.migration_items.find_one({'_id':item_id})
            if previous and previous.get('status')=='APPLIED':
                counts['already_applied']+=1;continue
            await db.migration_items.update_one({'_id':item_id},{'$setOnInsert':{
                'run_id':run_id,'kind':'hr','source_id':str(doc['_id']),'status':'PREPARED',
                'before':{k:{'present':k in doc,'value':doc.get(k)} for k in LINKS}}},upsert=True)
            adapted=await ensure_recordings(db,doc,run_id)
            after={k:adapted[k] for k in LINKS if k!='comparison_migration_run'}
            after['comparison_migration_run']=run_id
            await db.migration_items.update_one({'_id':item_id},{'$set':{'status':'APPLIED','after':after,'completed_at':datetime.now(timezone.utc)}})
            counts['adapted']+=1
            await db.migration_runs.update_one({'_id':run_id},{'$set':{'last_session_id':str(doc['_id']),'counts':counts}})
        if not hr_only:
            for domain in ('GPS_TRACK','GPS_URBAN','NIGHT_RMSSD'):
                async for doc in db[COLLECTIONS[domain]].find().sort('_id',1).batch_size(10):
                    counts['archive_documents']+=1
                    if apply:
                        ids=await ensure_archive_recordings(db,doc,domain,run_id)
                        counts['archive_recordings']+=len(ids)
                        await db.migration_items.update_one({'_id':f"{run_id}:{domain}:{doc['_id']}"},{'$setOnInsert':{
                            'run_id':run_id,'kind':domain,'source_id':str(doc['_id']),'recording_ids':ids,'status':'APPLIED'}},upsert=True)
        if apply:await db.migration_runs.update_one({'_id':run_id},{'$set':{'status':'COMPLETE','counts':counts,'completed_at':datetime.now(timezone.utc)}})
        return counts
    except Exception as exc:
        if started:
            try:await db.migration_runs.update_one({'_id':run_id},{'$set':{'status':'FAILED','error_type':type(exc).__name__}})
            except Exception:pass
        raise

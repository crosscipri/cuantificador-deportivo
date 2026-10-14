"""Read-only adapters over saved analyses; public shapes are explicit."""
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool
from .evidence import number, fingerprint, METRICS, oid
from comparisons.statistics import METRICS as COMPARISON_METRICS, VERSION
from comparisons.archive import night_values


def metrics(values, units):
    return [{'key':key,'value':number(values.get(key)),'unit':unit} for key,unit in units.items() if key in values]


def night_export(doc, kind):
    from .evidence import source_export
    e = source_export({**doc, 'fc_data':{}}, 'fc')
    values = night_values({'data':doc.get('windows',[])}, 'NIGHT_RMSSD' if kind=='night_rmssd' else 'NIGHT_HR')
    stamps = sorted(values); origin = stamps[0] if stamps else 0
    rmssd = kind=='night_rmssd'; unit = 'ms' if rmssd else 'bpm'
    fields = {'polarRmssdMean':'ms','fitbitRmssdMean':'ms','biasMean':'ms','rmssdMAE':'ms','pearsonR':'','lowerLoa':'ms','upperLoa':'ms'} if rmssd else {'polarHRMean':'bpm','polarHRMin':'bpm','fitbitHRMean':'bpm','fitbitHRMin':'bpm','hrMAE':'bpm','pearsonRHR':''}
    e.update(kind=kind, unit=unit, test_type='RMSSD nocturna' if rmssd else 'FC nocturna', reference='Polar',
             time=[t-origin for t in stamps], time_origin_utc=origin,
             series=[{'id':role,'role':role,'name':'Polar' if role=='reference' else doc.get('secondary_source','Dispositivo'),
                      'values':[number(values[t][index]) for t in stamps]} for role,index in [('device',1),('reference',0)]],
             metrics=metrics(doc.get('summary',{}),fields), night_count=1,
             limitations='Ventanas nocturnas guardadas de 5 minutos; no equivalen a FC en reposo ni permiten inferir fases de sueño.')
    e['visualizations']=['temporal','error','scatter','table']+(['bland_altman'] if rmssd and all(doc.get('summary',{}).get(k) is not None for k in ('biasMean','lowerLoa','upperLoa')) else [])
    e['revision']=fingerprint(e)
    return e


def stored_row(doc, row, kind, device_id):
    ev=doc['evidence']; sleep=kind=='sleep'
    row_id=row.get('recording_id') if sleep else row.get('session_id')
    e={'source_id':f"{doc['_id']}:{row_id}",'kind':kind,'device_id':device_id,
       'name':doc.get('configuration',{}).get('name','Comparativa guardada'),'sport':row.get('sport_type'),
       'test_type':'Sueño' if sleep else 'Comparativa FC', 'date':str(row.get('activity_date') or doc.get('created_at','')),
       'reference':ev.get('reference_name') or row.get('reference_name'), 'reference_quality':ev.get('reference_quality'),
       'analysis_version':ev.get('processing_version'),'analysis_revision_id':row.get('analysis_revision_id'),
       'protocol':None,'coverage':number(row.get('metrics',{}).get('coverage_percent')),'session_count':1,
       'ranking_eligibility':'not_assessed','unit':'' if sleep else 'bpm','visualizations':['table'],
       'limitations':'Evidencia escalar congelada del análisis guardado; no certifica elegibilidad para rankings.'}
    if row.get('protocol_id'): e['protocol']={'id':str(row['protocol_id']),'version':row.get('protocol_version')}
    units={'n_epochs':'épocas','expected_epochs':'épocas','coverage_percent':'%','agreement_percent':'%','kappa':''} if sleep else {**METRICS,**{k:v[2] for k,v in COMPARISON_METRICS.items()}}
    e['metrics']=metrics(row.get('metrics',{}),units)
    if sleep:
        m=row.get('metrics',{});e['night_count']=1
        e['confusion_matrix']={k:m[k] for k in ('classes','confusion_matrix','matrix_rows','matrix_columns') if k in m}
        e['per_class']=[{k:r.get(k) for k in ('class','reference_n','device_n','precision','recall','f1')} for r in m.get('per_class',[])]
    return e


async def comparison_export(db, doc, row, device_id):
    from comparisons.service import sessions_for, source_manifest, direct_compute
    from comparisons.models import Selection
    e=stored_row(doc,row,'comparison',device_id);frozen=doc['evidence'];config=doc['configuration']
    if doc.get('storage_mode')=='LIVE': raise HTTPException(422,'Guarda primero una instantánea de la comparativa LIVE')
    if config.get('mode')=='DIRECT':
        try:
            if frozen.get('processing_version')!=VERSION or not frozen.get('source_manifest'):
                raise ValueError('Versión o huellas originales no verificables')
            sources=await sessions_for(db, config['session_ids'])
            if source_manifest(sources)!=frozen['source_manifest']: raise ValueError('Los archivos originales han cambiado')
            computed=await run_in_threadpool(direct_compute,sources,Selection(**config),False)
            dev=next(s for s in computed['series'] if s['id']==row['session_id'])
            ref=next(s for s in computed['series'] if s['role']=='reference')
            e['series']=[{k:s[k] for k in ('id','name','role','values') if k in s} for s in ({**dev,'id':'device'},ref)]
            e['time']=computed['time'];e['visualizations']=['temporal','error','scatter','bland_altman','table']
            diagnostic=next((d for d in computed.get('diagnostics',[]) if d['session_id']==row['session_id']),{})
            if diagnostic.get('ecdf'):
                e['distribution']=diagnostic['ecdf'];e['visualizations'].append('distribution')
            e['limitations']='Gráfica reconstruida con originales verificados y la configuración guardada. Métricas del intervalo analítico congelado; ECDF calculada por el motor existente sobre todos los pares elegibles.'
        except (ValueError,KeyError,StopIteration,HTTPException) as exc:
            e['unavailable_reason']='Solo tabla: los originales, la configuración o la versión del motor no permiten reconstruir esta gráfica con garantías.'
    e['revision']=fingerprint(e);return e


EXTRA_COLLECTIONS={'comparison':'comparisons','sleep':'sleep_comparisons','archive':'archive_comparisons'}


def archive_export(doc,row,device_id):
    from comparisons.definitions import archive_definitions
    domain=doc['configuration']['domain']
    e=stored_row(doc,{**row,'session_id':row['id']},'archive',device_id)
    units={m['id']:m['unit'] for m in archive_definitions(domain)}
    e.update(metrics=metrics(row.get('metrics',{}),units),unit=doc['evidence'].get('unit',''),
             test_type={'GPS_TRACK':'GPS pista','GPS_URBAN':'GPS urbano','NIGHT_RMSSD':'RMSSD nocturna','NIGHT_HR':'FC nocturna'}.get(domain,domain),
             reference='Referencia geométrica' if domain=='GPS_URBAN' else 'Referencia de la prueba guardada',
             session_count=None,limitations='Métricas congeladas del registro seleccionado. Las distancias GPS históricas se derivan de coordenadas; los runs no equivalen a sesiones independientes. No se publican agregados ni señales de otras fechas.')
    if domain.startswith('NIGHT'):e['night_count']=1
    e['revision']=fingerprint(e);return e


def row_key(row,kind):
    return row.get('recording_id') if kind=='sleep' else row.get('id') if kind=='archive' else row.get('session_id')


async def export_row(db,doc,row,kind,device_id):
    if kind=='comparison':return await comparison_export(db,doc,row,device_id)
    if kind=='archive':return archive_export(doc,row,device_id)
    return stored_row(doc,row,kind,device_id)


async def extra_sources(db, device_id):
    for kind in ('night_rmssd','night_hr'):
        async for doc in db.nocturnal_hrv_sessions.find({'device_id':oid(device_id)},{'windows':1,'summary':1,'device_id':1,'session_name':1,'created_at':1,'secondary_source':1}):
            yield night_export(doc,kind)
    for kind,collection in EXTRA_COLLECTIONS.items():
        async for doc in db[collection].find({'evidence.rows.device_id':device_id}):
            if doc.get('storage_mode')=='LIVE': continue
            for row in doc['evidence']['rows']:
                if str(row.get('device_id'))!=device_id: continue
                e=await export_row(db,doc,row,kind,device_id)
                e['revision']=fingerprint({k:v for k,v in e.items() if k!='revision'})
                yield e


async def extra_current(db, device_id, kind, source_id):
    if kind.startswith('night_'):
        doc=await db.nocturnal_hrv_sessions.find_one({'_id':oid(source_id),'device_id':oid(device_id)})
        if doc:return night_export(doc,kind)
    else:
        parts=source_id.split(':',1)
        if len(parts)!=2: raise HTTPException(422,'Identificador de resultado incompleto')
        doc=await db[EXTRA_COLLECTIONS[kind]].find_one({'_id':oid(parts[0])})
        if doc:
            for row in doc['evidence']['rows']:
                if str(row.get('device_id'))==device_id and str(row_key(row,kind))==parts[1]:
                    e=await export_row(db,doc,row,kind,device_id)
                    e['revision']=fingerprint({k:v for k,v in e.items() if k!='revision'});return e
    raise HTTPException(422,'La prueba no existe o no pertenece al dispositivo')

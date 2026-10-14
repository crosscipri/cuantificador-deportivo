"""Allowlisted exports from existing stored results; never read acquisition bytes."""
import hashlib
import json
import math
from bson import BSON, ObjectId
from fastapi import HTTPException
from .models import EvidenceRef

COLLECTIONS = {'fc':'sessions', 'gps':'gps_tests', 'urban':'urban_tests'}
METRICS = {'mae':'bpm','rmse':'bpm','bias':'bpm','r':'','ccc':'','mape':'%',
           'loa_l':'bpm','loa_u':'bpm','loa_lower':'bpm','loa_upper':'bpm','media_ref':'bpm','media_dev':'bpm','icc':'','p':'','slope':'','intercept':'bpm',
           'coverage_percent':'%','n':'pares','n_samples':'pares'}


def oid(value):
    if not ObjectId.is_valid(value):
        raise HTTPException(422, 'Identificador inválido')
    return ObjectId(value)


def number(v):
    return float(v) if isinstance(v, (float,int)) and math.isfinite(v) else None


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def source_export(doc, kind):
    result = {'source_id':str(doc['_id']), 'kind':kind, 'device_id':str(doc['device_id']),
              'name':doc.get('session_name',doc.get('name','')), 'sport':doc.get('sport_type'),
              'test_type':doc.get('training_type',kind),
              'date':str(doc.get('activity_date',doc.get('created_at',''))),
              'reference':doc.get('reference_name'), 'protocol':None,
              'duration_seconds':number(doc.get('duration_seconds')),
              'analysis_version':str(doc.get('processing_version') or 'LEGACY_UNKNOWN'), 'analysis_revision_id':doc.get('legacy_analysis_revision_id'), 'session_count':1,
              'coverage':number(doc.get('metrics',{}).get('coverage_percent')),
              'ranking_eligibility':'not_assessed'}
    result['difficulty'] = doc.get('session_difficulty')
    result['interval_start_sec'] = number(doc.get('interval_start_sec'))
    result['interval_end_sec'] = number(doc.get('interval_end_sec'))
    protocol = doc.get('protocol_snapshot')
    if not isinstance(protocol,dict) and doc.get('protocol_id'):
        result['protocol']={'id':str(doc['protocol_id']),'version':doc.get('protocol_version')}
    if isinstance(protocol,dict):
        result['protocol'] = {k:protocol[k] for k in ('id','version','name') if isinstance(protocol.get(k),(str,int))}
    if kind == 'fc':
        fc = doc.get('fc_data') or {}
        result['time'] = [number(x) for x in fc.get('time',[])]
        result['series'] = [{'id':role,'name':doc.get(role+'_name',role),'role':role,
                             'values':[number(x) for x in fc.get(role,[])]} for role in ('device','reference')]
        result['metrics'] = [{'key':k,'value':number(v),'unit':METRICS[k]} for k,v in doc.get('metrics',{}).items() if k in METRICS]
        result['unit'] = 'bpm'
        result['limitations'] = 'Serie histórica reducida para visualización; métricas originales de la sesión completa. Protocolo y versión histórica no certificados.'
    else:
        tracks = []
        from comparisons.archive import gps_points, display_track_segments
        from comparisons.gps import describe
        def segments(values):
            return [[{'lat':p['lat'],'lon':p['lon']} for p in segment] for segment in display_track_segments(describe(gps_points(values), -float('inf'), float('inf'))['segments'])]
        if kind == 'urban' and doc.get('ref_points'):
            tracks.append({'id':'reference','name':'Referencia','role':'reference','segments':segments(doc['ref_points'])})
        for mi, mode in enumerate(doc.get('modes',[])):
            for ri, run in enumerate(mode.get('runs',[])):
                tracks.append({'id':f'{mi}:{ri}','name':f"{mode.get('name','Modo')} · recorrido {ri+1}",
                               'role':'device','segments':segments(run.get('points',[]))})
        result['session_count'] = None
        result['tracks'] = tracks
        result['unit'] = 'm'
        result['metrics'] = []
        result['limitations'] = 'Mapa de recorridos seleccionados; no presupone simultaneidad ni certifica elegibilidad para rankings.'
    result['visualizations'] = ['temporal','error','scatter','bland_altman','table'] if kind=='fc' else ['map']
    result['revision'] = fingerprint(result)
    return result


async def current(db, device_id, kind, source_id):
    if kind not in COLLECTIONS:
        from .adapters import extra_current
        return await extra_current(db, str(oid(device_id)), kind, source_id)
    doc = await db[COLLECTIONS[kind]].find_one({'_id':oid(source_id),'device_id':oid(device_id)},
                                             {'device_file_bytes':0,'reference_file_bytes':0,'charts':0,'ai_analysis':0})
    if not doc:
        raise HTTPException(422, 'La prueba no existe o no pertenece al dispositivo')
    return source_export(doc, kind)


async def bind(db, device_id, ref):
    if ref.kind=='fc_total':
        from .totals import total_export
        export=await total_export(db,device_id,ref)
    else:
        export = await current(db, device_id, ref.kind, ref.source_id)
    if len(BSON.encode(export)) > 12*1024*1024:
        raise HTTPException(422, 'La exportación de esta prueba supera 12 MiB')
    await db.review_evidence.update_one({'_id':export['revision']}, {'$setOnInsert':{'export':export}}, upsert=True)
    return export


async def resolve(db, device_id, ref: EvidenceRef):
    stored = await db.review_evidence.find_one({'_id':ref.revision})
    if not stored:
        raise HTTPException(422, 'Selecciona y vincula una revisión de la prueba')
    e = dict(stored['export'])
    if (e['device_id'], e['kind'], e['source_id']) != (device_id, ref.kind, ref.source_id):
        raise HTTPException(422, 'Evidencia ajena al dispositivo o a la prueba')
    config = ref.model_dump()
    if ref.sport is None: config.pop('sport',None)
    if ref.kind!='fc_total': config.pop('members',None)
    elif sorted(config['members'],key=lambda m:m['source_id'])!=e.get('members'):
        raise HTTPException(422,'La selección de pruebas no coincide con la correlación total vinculada')
    if ref.sport is not None and (e.get('sport')!=ref.sport or
            any(s.get('sport')!=ref.sport for s in e.get('sessions',[]))):
        raise HTTPException(422,'La correlación vinculada no corresponde al deporte seleccionado')
    e['configuration'] = config
    e.pop('device_id')
    if ref.start is not None and ref.end is not None and ref.end <= ref.start:
        raise HTTPException(422,'El final debe ser posterior al inicio')
    if ref.visualization not in e.get('visualizations', ['temporal','error','scatter','bland_altman','table'] if ref.kind=='fc' else ['map']):
        raise HTTPException(422,e.get('unavailable_reason','Visualización no disponible en esta revisión'))
    e['summary_metrics'] = e.get('metrics',[])
    if ref.visualization == 'table':
        if ref.start is not None or ref.end is not None:
            raise HTTPException(422,'La tabla conserva el intervalo analítico original; elimina el recorte visual')
        for key in ('time','series','tracks','distribution'): e.pop(key,None)
    elif ref.visualization == 'distribution':
        if ref.start is not None or ref.end is not None:
            raise HTTPException(422,'La distribución conserva el intervalo analítico original')
        for key in ('time','series','tracks'): e.pop(key,None)
    elif ref.visualization != 'map':
        if not ref.series or not set(ref.series) <= {'device','reference'}:
            raise HTTPException(422, 'Selecciona series válidas')
        if ref.visualization in ('error','scatter','bland_altman') and set(ref.series) != {'device','reference'}:
            raise HTTPException(422, 'Esta visualización requiere dispositivo y referencia')
        times = e.pop('time',[]);series = e.pop('series',[])
        if not times or any(len(s['values']) != len(times) for s in series):
            raise HTTPException(422, 'Series no disponibles o desalineadas')
        indices = [i for i,t in enumerate(times) if t is not None and (ref.start is None or t >= ref.start) and (ref.end is None or t <= ref.end)]
        if not indices: raise HTTPException(422, 'El intervalo no contiene puntos')
        e['metrics'] = [m for m in e['metrics'] if ref.visualization=='bland_altman' and m['key'] in ('bias','loa_l','loa_u','loa_lower','loa_upper','biasMean','lowerLoa','upperLoa')]
        e['time'] = [times[i] for i in indices]
        e['series'] = [{**s,'values':[s['values'][i] for i in indices]} for s in series if s['id'] in ref.series]
        if ref.visualization == 'error':
            dev=next(s['values'] for s in series if s['id']=='device');reference=next(s['values'] for s in series if s['id']=='reference')
            for series_out in e['series']:
                series_out['errors'] = [dev[i]-reference[i] if dev[i] is not None and reference[i] is not None else None for i in indices]
        e.pop('distribution',None)
    else:
        if not ref.series or not set(ref.series) <= {t['id'] for t in e['tracks']}:
            raise HTTPException(422, 'Selecciona recorridos GPS disponibles')
        e['tracks'] = [t for t in e['tracks'] if t['id'] in ref.series]
        if any(not any(t['segments']) for t in e['tracks']):
            raise HTTPException(422, 'Un recorrido seleccionado no contiene coordenadas')
    e['id'] = fingerprint(config)
    return e

"""Frozen descriptive FC correlation over the exact revisions selected by the editor."""
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool
from .evidence import fingerprint, number

SPORT_LABELS = {'running':'Running','cycling':'Ciclismo','gym':'Fuerza'}

async def total_export(db, device_id, ref):
    exports=[]
    for member in ref.members:
        stored=await db.review_evidence.find_one({'_id':member.revision})
        e=stored.get('export',{}) if stored else {}
        if (e.get('device_id'),e.get('kind'),e.get('source_id')) != (device_id,'fc',member.source_id):
            raise HTTPException(422,'Una prueba de la correlación total no está vinculada o pertenece a otro dispositivo')
        exports.append(e)
    sports={e.get('sport') for e in exports}
    if len(sports)!=1 or not sports <= SPORT_LABELS.keys():
        raise HTTPException(422,'La correlación por deporte debe reunir pruebas de un único deporte identificado')
    sport=next(iter(sports))
    if ref.sport is not None and ref.sport!=sport:
        raise HTTPException(422,'Las pruebas seleccionadas no pertenecen al deporte de esta correlación')
    return await run_in_threadpool(build_total,device_id,exports)


def build_total(device_id, exports):
    # Same aggregate used by the original device page, over retained fc_data pairs.
    # No average of session correlations, independent re-alignment or raw-file processing.
    from analyzer import build_sport_chart_data
    sport=exports[0]['sport'];label=SPORT_LABELS[sport]
    session_data=[]; sessions=[]
    for e in sorted(exports,key=lambda e:e['source_id']):
        signals={s['role']:s['values'] for s in e.get('series',[])}
        reference=signals.get('reference',[]);device=signals.get('device',[])
        if e.get('unit')!='bpm' or not reference or len(reference)!=len(device) or len(reference)!=len(e.get('time',[])):
            raise HTTPException(422,'La prueba '+e['name']+' no contiene pares de FC alineados')
        pairs=[(r,d) for r,d in zip(reference,device) if number(r) is not None and number(d) is not None]
        if len(pairs)<3:
            raise HTTPException(422,'La prueba '+e['name']+' necesita al menos tres pares de FC válidos')
        session_data.append({'label':e['name'],'ref':[r for r,d in pairs],'dev':[d for r,d in pairs]})
        sessions.append({k:e.get(k) for k in ('source_id','revision','name','sport','date','reference')} |
                        {'n':len(pairs)})
    result=build_sport_chart_data(session_data)
    reference=[];device=[]
    for session, data in zip(sessions,result['sessions']):
        session['point_start']=len(reference);session['display_n']=len(data['points'])
        reference.extend(p['x'] for p in data['points']);device.extend(p['y'] for p in data['points'])
    stats=result['global_stats'];count=sum(s['n'] for s in sessions)
    e={'kind':'fc_total','source_id':'total','device_id':device_id,
       'name':'Correlación de '+label,'sport':sport,'sport_label':label,
       'test_type':'Correlación conjunta','date':None,'unit':'bpm','session_count':len(sessions),
       'reference':', '.join(dict.fromkeys(s['reference'] or 'Referencia de la prueba' for s in sessions)),
       'analysis_version':'legacy-build_sport_chart_data/review-sport-2','ranking_eligibility':'not_assessed',
       'visualizations':['scatter','table'],'sessions':sessions,
       'members':[{'source_id':s['source_id'],'revision':s['revision']} for s in sessions],
       'time':list(range(len(reference))),
       'series':[{'id':'reference','role':'reference','name':'Referencia','values':reference},
                 {'id':'device','role':'device','name':'Dispositivo','values':device}],
       'metrics':[{'key':'r','value':number(stats['pearson_r']),'unit':''},
                  {'key':'bias','value':number(stats['bias']),'unit':'bpm'},
                  {'key':'n','value':count,'unit':'pares guardados'},
                  {'key':'session_count','value':len(sessions),'unit':'pruebas'}],
       'limitations':'Correlación descriptiva calculada con todos los pares válidos guardados de las pruebas indicadas, '
          'que pueden estar reducidos respecto al registro original. Cada par tiene el mismo peso; no es una media de correlaciones '
          'ni una puntuación equilibrada por sesión. La visualización muestra hasta 500 pares originales por prueba; '
          'el cálculo usa todos los pares guardados del mismo deporte. Agrupar intensidades puede elevar la correlación y no implica acuerdo.'}
    e['revision']=fingerprint(e)
    return e

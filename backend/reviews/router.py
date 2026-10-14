"""Editorial persistence. An atomic review update is the sole publication commit point."""
import copy
import io
import re
import unicodedata
from datetime import datetime, timezone
from uuid import uuid4
from bson import BSON, Binary
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Query
from fastapi.responses import Response
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError
from .models import Draft, Save, Revision, EvidenceRef, MediaMetadata, Profile, visible_text, validate_youtube, Publication
from .evidence import oid, COLLECTIONS, source_export, bind, resolve, current, fingerprint
from .catalog import parse_catalog_filters, catalog_item, catalog_page
from .comparison import parse_comparison_slugs, comparison_page, comparison_projection
from .rankings import rankings_page

MAX_IMAGE = 5 * 1024 * 1024


def now():
    return datetime.now(timezone.utc).isoformat()


def db(request):
    return request.app.state.db


async def private(request: Request):
    # Existing middleware checks Basic credentials; fail closed when it is disabled.
    if not getattr(request.app.state, 'review_auth_configured', False):
        raise HTTPException(503, 'Configura APP_PASSWORD para utilizar el editor privado de reviews')


router = APIRouter(prefix='/api/reviews', dependencies=[Depends(private)])
media_router = APIRouter(prefix='/api/review-media', dependencies=[Depends(private)])
public_router = APIRouter(prefix='/api/public')


async def create_indexes(database):
    await database.reviews.create_index('slug', unique=True)
    await database.review_media.create_index('device_id')
    await database.review_versions.create_index('device_id')


async def device(database, device_id):
    device_id = str(oid(device_id))
    doc = await database.devices.find_one({'_id':oid(device_id)})
    if not doc:
        raise HTTPException(404, 'Dispositivo no encontrado')
    return doc


def profile(doc):
    return {'id':str(doc['_id']), 'name':doc.get('name',''),
            **{k:doc.get(k,'') for k in ('brand','model','format','characteristics')},
            'purchase_links':doc.get('purchase_links',[]), 'revision':doc.get('editorial_revision',0)}


async def review(database, device_id):
    device_id = str(oid(device_id))
    value = await database.reviews.find_one({'_id':device_id})
    if not value:
        raise HTTPException(404, 'Aún no hay review')
    return value


def output(value):
    return {k:value.get(k) for k in ('device_id','draft','revision','created_at','saved_at','first_published_at',
            'published_at','published_revision','active_version','withdrawn','history_ids','profile_revision')}


def size_check(value):
    if len(BSON.encode(value)) > 12*1024*1024:
        raise HTTPException(422, 'El documento supera 12 MiB. Reduce bloques o recorridos seleccionados')


async def cas(database, device_id, revision, changes, push=None):
    device_id = str(oid(device_id))
    update = {'$set':changes, '$inc':{'revision':1}}
    if push:
        update['$push'] = push
    try:
        result = await database.reviews.find_one_and_update({'_id':device_id,'revision':revision}, update, return_document=ReturnDocument.AFTER)
    except DuplicateKeyError:
        raise HTTPException(409, 'El slug ya pertenece a otra review')
    if result is None:
        raise HTTPException(409, 'Conflicto de edición. Conserva tu copia y compara con el borrador del servidor')
    return result


@router.get('/{device_id}')
async def get_review(request: Request, device_id: str):
    device_id = str(oid(device_id))
    database=db(request); r=await review(database,device_id); result=output(r)
    result['dependencies_dirty']=False
    if r.get('active'):
        active_payload=r['active']
        current_profile=profile(await device(database,device_id))
        result['dependencies_dirty']=current_profile['revision']!=active_payload['device']['revision']
        for ident, frozen in active_payload['media'].items():
            m=await database.review_media.find_one({'_id':ident})
            if not m or media_output(m)!=frozen: result['dependencies_dirty']=True
    return result


@router.post('/{device_id}')
async def create_review(request: Request, device_id: str):
    device_id = str(oid(device_id))
    database = db(request)
    d = await device(database,device_id)
    title = d.get('name','')
    slug = re.sub(r'[^a-z0-9]+','-',unicodedata.normalize('NFKD',title).encode('ascii','ignore').decode().lower()).strip('-')[:85] or 'review'
    sections = ['Introducción y veredicto','Para quién es y para quién no','Diseño, comodidad y experiencia de uso',
                'Frecuencia cardíaca: running, ciclismo y gimnasio','GPS','HRV y frecuencia cardíaca en reposo',
                'Sueño','Batería y funciones relevantes','Alternativas','Conclusión y dónde comprar']
    blocks = []
    for text in sections:
        blocks.extend([{'id':uuid4().hex,'type':'heading','text':text}, {'id':uuid4().hex,'type':'text','html':''}])
    draft = Draft(title=title,slug=f'{slug}-{device_id[-6:]}',blocks=blocks).model_dump()
    value = {'_id':device_id,'device_id':device_id,'draft':draft,'slug':draft['slug'],'revision':1,
             'created_at':now(),'saved_at':now(),'active_version':None,'active':None,'history_ids':[], 'withdrawn':False}
    await database.reviews.update_one({'_id':device_id},{'$setOnInsert':value},upsert=True)
    return output(await review(database,device_id))


@router.put('/{device_id}')
async def save_review(request: Request, device_id: str, body: Save):
    device_id = str(oid(device_id))
    database = db(request)
    old = await review(database,device_id)
    draft = body.draft.model_dump()
    if old.get('first_published_at') and draft['slug'] != old['slug']:
        raise HTTPException(422,'El slug es estable desde la primera publicación')
    size_check({**old, 'draft':draft})
    return output(await cas(database,device_id,body.expected_revision,{'draft':draft,'slug':draft['slug'],'saved_at':now()}))


@router.get('/{device_id}/profile')
async def get_profile(request: Request, device_id: str):
    device_id = str(oid(device_id))
    return profile(await device(db(request),device_id))


@router.put('/{device_id}/profile')
async def save_profile(request: Request, device_id: str, body: Profile):
    device_id = str(oid(device_id))
    database = db(request)
    await device(database,device_id)
    query = {'_id':oid(device_id)}
    if body.expected_revision:
        query['editorial_revision'] = body.expected_revision
    else:
        query['$or'] = [{'editorial_revision':0},{'editorial_revision':{'$exists':False}}]
    result = await database.devices.find_one_and_update(query,{'$set':body.model_dump(exclude={'expected_revision'}),
                '$inc':{'editorial_revision':1}},return_document=ReturnDocument.AFTER)
    if not result:
        raise HTTPException(409,'La ficha ha cambiado en otra pestaña; conserva los cambios locales')
    return profile(result)


@router.get('/{device_id}/sources')
async def sources(request: Request, device_id: str):
    device_id = str(oid(device_id))
    database = db(request)
    await device(database,device_id)
    from .adapters import extra_sources
    result = []
    def option(e):
        return {k:e.get(k) for k in ('source_id','kind','revision','name','sport','test_type','date','reference','visualizations','unavailable_reason')} | {
            'series':[{'id':s['id'],'name':s['name']} for s in e.get('series',e.get('tracks',[]))]}
    for kind, collection in COLLECTIONS.items():
        async for doc in database[collection].find({'device_id':oid(device_id)}, {'device_file_bytes':0,'reference_file_bytes':0,'charts':0,'ai_analysis':0}):
            result.append(option(source_export(doc,kind)))
    async for e in extra_sources(database,device_id): result.append(option(e))
    return result


@router.post('/{device_id}/evidence')
async def bind_evidence(request: Request, device_id: str, body: EvidenceRef):
    device_id = str(oid(device_id))
    return await bind(db(request),device_id,body)


@router.get('/{device_id}/evidence')
async def bound_evidence(request: Request, device_id: str):
    """Frozen grouping metadata, even if a session has since been reclassified."""
    device_id=str(oid(device_id))
    database=db(request)
    await device(database,device_id)
    fields=('source_id','kind','revision','sport')
    projection={'export.'+key:1 for key in fields}
    return [{key:doc['export'].get(key) for key in fields} async for doc in
            database.review_evidence.find({'export.device_id':device_id,'export.kind':'fc'},projection)]


def media_ids(draft):
    ids = {draft.get('cover',{}).get('media_id'),draft.get('share_image',{}).get('media_id')}
    for b in draft.get('blocks',[]):
        if b['type'] in ('image','gallery'): ids.update(x.get('media_id') for x in b.get('media',[]))
    return ids - {'',None}


def media_output(m):
    return {k:m.get(k) for k in ('id','alt','caption','mime','size','width','height','created_at')}


@router.get('/{device_id}/media')
async def list_media(request: Request, device_id: str):
    device_id = str(oid(device_id))
    return [media_output(m) async for m in db(request).review_media.find({'device_id':device_id,'deleted':False},{'data':0})]


@router.post('/{device_id}/media')
async def upload_media(request: Request, device_id: str, file: UploadFile = File(...)):
    device_id = str(oid(device_id))
    await device(db(request),device_id)
    data = await file.read(MAX_IMAGE+1)
    if len(data)>MAX_IMAGE:
        raise HTTPException(413,'La imagen supera 5 MiB')
    if file.content_type not in ('image/jpeg','image/png','image/webp'):
        raise HTTPException(422,'Solo se permiten JPEG, PNG y WebP')
    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.width*img.height>25_000_000:
                raise ValueError('Imagen demasiado grande')
            actual = Image.MIME.get(img.format)
            if actual != file.content_type:
                raise ValueError('El contenido no coincide con el tipo declarado')
            img.verify()
        # Strip EXIF/GPS and other metadata. No original uploaded bytes are exposed.
        with Image.open(io.BytesIO(data)) as img:
            cleaned = io.BytesIO()
            fmt = img.format
            img.info.clear()
            img.save(cleaned,format=fmt)
            width,height = img.size
        data = cleaned.getvalue()
        if len(data)>MAX_IMAGE:
            raise ValueError('La imagen normalizada supera 5 MiB')
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        raise HTTPException(422,'Imagen inválida o demasiado grande')
    ident = uuid4().hex
    value = {'_id':ident,'id':ident,'device_id':device_id,'data':Binary(data),'mime':actual,
             'size':len(data),'width':width,'height':height,'alt':'','caption':'','deleted':False,'created_at':now()}
    await db(request).review_media.insert_one(value)
    return media_output(value)


@media_router.put('/{media_id}')
async def edit_media(request: Request, media_id: str, body: MediaMetadata):
    value = await db(request).review_media.find_one_and_update({'_id':media_id,'deleted':False},{'$set':body.model_dump()},return_document=ReturnDocument.AFTER)
    if not value:
        raise HTTPException(404,'Medio no encontrado')
    return media_output(value)


@media_router.delete('/{media_id}')
async def delete_media(request: Request, media_id: str):
    database = db(request)
    m = await database.review_media.find_one({'_id':media_id})
    if not m:
        raise HTTPException(404,'Medio no encontrado')
    r = await database.reviews.find_one({'_id':m['device_id']})
    if r:
        if media_id in media_ids(r['draft']):
            raise HTTPException(409,'La imagen está en uso en el borrador')
        if await database.review_versions.find_one({'device_id':m['device_id'],f'payload.media.{media_id}':{'$exists':True}}):
            raise HTTPException(409,'La imagen está en uso en una versión histórica')
    await database.review_media.update_one({'_id':media_id},{'$set':{'deleted':True}})
    return {'deleted':True}


async def image_response(database, media_id, width=None):
    m = await database.review_media.find_one({'_id':media_id})
    if not m:
        raise HTTPException(404,'Imagen no disponible')
    data = bytes(m['data']); mime = m['mime']
    if width:
        with Image.open(io.BytesIO(data)) as img:
            img.thumbnail((width,width*4))
            buffer = io.BytesIO(); img.save(buffer,format='WEBP',quality=82); data=buffer.getvalue(); mime='image/webp'
    return Response(data,media_type=mime,headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})


@media_router.get('/{media_id}')
async def private_image(request: Request, media_id: str):
    return await image_response(db(request),media_id)


def block_visible(b):
    if b['type']=='text': return bool(visible_text(b['html']))
    if b['type']=='heading': return bool(b['text'].strip())
    if b['type']=='verdict':
        return any(b[k] for k in ('text','recommended','not_recommended','pros','cons')) or any(
            (b.get('scores') or {}).get(k) is not None for k in ('fc','hrv','rest_hr','gps'))
    if b['type']=='alternatives': return bool(b['alternatives'])
    return True


def visible_blocks(blocks):
    # A template heading without any following content is omitted.
    out = []
    for i,b in enumerate(blocks):
        if not block_visible(b): continue
        if b['type']=='heading':
            following = []
            for next_block in blocks[i+1:]:
                if next_block['type']=='heading' and next_block['level'] <= b['level']: break
                following.append(next_block)
            if not any(x['type']!='heading' and block_visible(x) for x in following): continue
        out.append(copy.deepcopy(b))
    return out


BLOCK_FIELDS = {
    'text': ('html',), 'heading': ('text','level'), 'image': ('media',), 'gallery': ('media',),
    'video': ('video','title'), 'chart': ('title','caption','explanation','evidence_id'),
    'map': ('title','caption','explanation','evidence_id'),
    'table': ('title','caption','explanation','table_origin','rows','evidence_id'),
    'verdict': ('title','text','recommended','not_recommended','pros','cons','scores'),
    'alternatives': ('title','alternatives'), 'purchase': ('title','affiliate_notice','links')}


def public_block(block):
    return {k:copy.deepcopy(block[k]) for k in ('id','type',*BLOCK_FIELDS[block['type']]) if k in block}


async def snapshot(database, r, strict):
    draft = copy.deepcopy(r['draft'])
    errors = []
    for k,label in [('title','título'),('summary','resumen'),('author','autor')]:
        if not draft[k].strip(): errors.append('Falta '+label)
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*',draft['slug']): errors.append('Slug inválido')
    if not draft['cover']['media_id'] or not draft['cover']['alt'].strip(): errors.append('Falta portada con texto alternativo')
    draft['blocks'] = visible_blocks(draft['blocks'])
    media = {}
    for ident in media_ids(draft):
        m = await database.review_media.find_one({'_id':ident,'device_id':r['device_id']})
        if not m:
            errors.append('Medio no disponible: '+ident)
        else: media[ident] = media_output(m)
    d = profile(await device(database,r['device_id']))
    blocks = visible_blocks(draft['blocks'])
    if not any(b['type']!='heading' for b in blocks): errors.append('Falta contenido visible')
    fc_members=sorted({(b['evidence']['source_id'],b['evidence']['revision']) for b in blocks
                       if b['type']=='chart' and b.get('evidence') and b['evidence']['kind']=='fc'
                       and b['evidence']['visualization']=='temporal'})
    frozen_fc={doc['_id']:doc['export'] async for doc in database.review_evidence.find(
        {'_id':{'$in':[revision for _,revision in fc_members]},'export.device_id':r['device_id'],'export.kind':'fc'},
        {'export.source_id':1,'export.sport':1})}
    for b in blocks:
        ref=b.get('evidence')
        if ref and ref['kind']=='fc_total':
            selected=sorted((m['source_id'],m['revision']) for m in ref.get('members',[]))
            # Legacy snapshots without sport remain readable; new summaries are scoped.
            sport=ref.get('sport')
            expected=fc_members if sport is None else [(source,revision) for source,revision in fc_members
                if frozen_fc.get(revision,{}).get('source_id')==source and frozen_fc[revision].get('sport')==sport]
            if selected!=expected:
                errors.append('Correlación '+(sport or 'total')+': actualiza el resumen para incluir las mismas pruebas y revisiones que las curvas FC de ese deporte' if sport else
                              'Correlación total: actualiza el resumen para incluir las mismas pruebas y revisiones que las curvas FC del artículo')
    evidence = {}
    async def include(ref, location):
        try:
            e = await resolve(database,r['device_id'],EvidenceRef(**ref))
            evidence[e['id']] = e
            return e['id']
        except HTTPException as exc:
            errors.append(location+': '+str(exc.detail))
            return None
    try: draft['youtube'] = validate_youtube(draft['youtube'])
    except ValueError as exc:
        errors.append('Vídeo principal: '+str(exc)); draft['youtube'] = ''
    for b in blocks:
        label = b['title'] or b['type']+' '+b['id'][:8]
        if b['type']=='verdict' and (b.get('scores') or {}).get('source')=='device':
            if b['scores'].get('source_device_id')!=r['device_id']:
                errors.append('Puntuaciones: carga las del dispositivo asociado a esta review')
        if b['type'] in ('image','gallery'):
            if not b['media'] or (b['type']=='image' and len(b['media'])!=1): errors.append(label+': selecciona imagen')
            if any(not m['media_id'] or not m['alt'].strip() for m in b['media']): errors.append(label+': falta medio o texto alternativo')
        if b['type']=='video':
            try:
                b['video'] = validate_youtube(b['video'])
                if not b['video']: errors.append(label+': falta vídeo de YouTube')
            except ValueError as exc:
                errors.append(label+': '+str(exc)); b['video'] = ''
        needs = b['type'] in ('chart','map') or (b['type']=='table' and b['table_origin']=='results')
        if needs:
            if not b['evidence']: errors.append(label+': falta prueba')
            else:
                expected = 'map' if b['type']=='map' else 'table' if b['type']=='table' else None
                if (expected and b['evidence']['visualization']!=expected) or (b['type']=='chart' and b['evidence']['visualization'] in ('map','table')):
                    errors.append(label+': visualización incompatible')
                b['evidence_id'] = await include(b['evidence'],label)
        if b['type']=='table' and b['table_origin']=='editorial' and not any(any(c.strip() for c in row) for row in b['rows']): errors.append(label+': tabla vacía')
        if b['type']=='alternatives':
            for a in b['alternatives']:
                try: other = await database.devices.find_one({'_id':oid(a['device_id'])}) if a['device_id'] else None
                except HTTPException: other = None
                if not other or a['device_id']==r['device_id'] or not a['reason'].strip(): errors.append(label+': alternativa incompleta')
                else: a['name'] = other.get('name','')
        if b['type']=='purchase':
            links = {x['id']:x for x in d['purchase_links']}
            if not b['link_ids'] or not set(b['link_ids'])<=set(links) or not b['affiliate_notice'].strip(): errors.append(label+': selecciona enlaces y aviso de afiliación')
            b['links'] = [links[x] for x in b['link_ids'] if x in links]
    public_results = []
    for ref in draft['public_results']:
        if ref['visualization']!='table' or ref.get('start') is not None or ref.get('end') is not None:
            errors.append('Resultados públicos: selecciona una tabla sin recorte visual')
        else: public_results.append(await include(ref,'Resultado público'))
    used_links = {ident for b in blocks if b['type']=='purchase' for ident in b['link_ids']}
    d['purchase_links'] = [link for link in d['purchase_links'] if link['id'] in used_links]
    draft['blocks'] = [public_block(b) for b in blocks]
    draft['seo_title'] = draft['seo_title'] or draft['title']
    draft['seo_description'] = draft['seo_description'] or draft['summary']
    draft['share_image'] = draft['share_image'] if draft['share_image']['media_id'] else draft['cover']
    draft.pop('public_results')
    if strict and errors: raise HTTPException(422,errors)
    payload = {'schema_version':1,'article':draft,'device':d,'media':media,'evidence':evidence,
               'public_results':[x for x in public_results if x], 'ranking_default':'fc_global'}
    size_check(payload)
    return payload,errors


@router.post('/{device_id}/preview')
async def preview(request: Request, device_id: str, body: Revision):
    device_id = str(oid(device_id))
    r = await review(db(request),device_id)
    if r['revision']!=body.expected_revision: raise HTTPException(409,'El borrador ha cambiado')
    payload,errors = await snapshot(db(request),r,False)
    token = fingerprint(payload)
    # Preview-only dates must not become publication dates or change the publish token.
    payload['preview'] = {'saved_at':r.get('saved_at'),'first_published_at':r.get('first_published_at')}
    return {'payload':payload,'errors':errors,'preview_token':token}


@router.post('/{device_id}/publish')
async def publish(request: Request, device_id: str, body: Publication):
    device_id = str(oid(device_id))
    database = db(request)
    r = await review(database,device_id)
    if r['revision']!=body.expected_revision: raise HTTPException(409,'El borrador ha cambiado')
    payload,_ = await snapshot(database,r,True)
    if body.preview_token and body.preview_token != fingerprint(payload):
        raise HTTPException(409,'Las dependencias cambiaron desde la vista previa. Revisa la publicación de nuevo')
    ident,date = uuid4().hex,now()
    payload.update(version=ident,published_at=date,first_published_at=r.get('first_published_at') or date)
    version = {'_id':ident,'device_id':device_id,'payload':payload,'draft':r['draft'],'created_at':date,'draft_revision':r['revision']}
    size_check(version)
    prospective = {**r,'active':payload}
    size_check(prospective)
    await database.review_versions.insert_one(version)
    return output(await cas(database,device_id,body.expected_revision,{
        'active':payload,'active_version':ident,'published_at':date,'first_published_at':payload['first_published_at'],
        'published_revision':body.expected_revision+1,'withdrawn':False,'profile_revision':payload['device']['revision']}, {'history_ids':ident}))


@router.post('/{device_id}/withdraw')
async def withdraw(request: Request, device_id: str, body: Revision):
    device_id = str(oid(device_id))
    return output(await cas(db(request),device_id,body.expected_revision,{'active':None,'active_version':None,'withdrawn':True}))


@router.get('/{device_id}/history')
async def history(request: Request, device_id: str):
    device_id = str(oid(device_id))
    r = await review(db(request),device_id)
    return [{'version':v['_id'],'created_at':v['created_at'],'draft_revision':v['draft_revision']}
            async for v in db(request).review_versions.find({'_id':{'$in':r['history_ids']}},{'payload':0,'draft':0}).sort('created_at',-1)]


async def version_for(database,device_id,version):
    device_id = str(oid(device_id))
    r = await review(database,device_id)
    if version not in r['history_ids']: raise HTTPException(404,'Versión no encontrada')
    return await database.review_versions.find_one({'_id':version})


@router.get('/{device_id}/history/{version}')
async def historical(request: Request, device_id: str, version: str):
    device_id = str(oid(device_id))
    return (await version_for(db(request),device_id,version))['payload']


@router.post('/{device_id}/restore/{version}')
async def restore(request: Request, device_id: str, version: str, body: Revision):
    device_id = str(oid(device_id))
    v = await version_for(db(request),device_id,version)
    return output(await cas(db(request),device_id,body.expected_revision,{'draft':v['draft'],'saved_at':now()}))


async def active(database,slug):
    r = await database.reviews.find_one({'slug':slug,'active_version':{'$ne':None}})
    if not r or not r.get('active'): raise HTTPException(404,'Publicación no disponible')
    return r['active']


@public_router.get('/comparisons')
async def public_comparisons(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    try:
        slugs = parse_comparison_slugs(request.query_params.getlist('slug'))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    if not slugs:
        return comparison_page([], [])
    query = {'slug': {'$in': slugs}, 'active_version': {'$ne': None}, 'active': {'$ne': None}}
    # Resolve every item from a single active immutable snapshot. The database
    # projection omits signal arrays and all current private analysis documents.
    payloads = [record['active'] async for record in db(request).reviews.aggregate([
        {'$match': query}, {'$project': comparison_projection()}])]
    return comparison_page(slugs, payloads)


@public_router.get('/reviews')
async def public_catalog(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    try:
        filters = parse_catalog_filters(request.query_params.multi_items())
    except ValidationError:
        raise HTTPException(422, 'Filtros de catálogo inválidos')
    query = {'active_version':{'$ne':None}, 'active':{'$ne':None}}
    database = db(request)
    # Read only editorial metadata, never the large evidence arrays or drafts.
    projection = {f'active.{key}': 1 for key in (
        'version', 'published_at', 'first_published_at', 'device', 'media',
        'article.slug', 'article.title', 'article.summary', 'article.author', 'article.cover',
        'article.categories', 'article.tags', 'article.blocks.type', 'article.blocks.scores',
        'article.blocks.links', 'article.blocks.affiliate_notice')}
    items = []
    async for r in database.reviews.find(query, projection):
        items.append(catalog_item(r['active']))
    return catalog_page(items, filters)


@public_router.get('/rankings')
async def public_rankings(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    # All charts use the same set of frozen publications, with no catalog
    # pagination or four-item comparison limit. Project before reading signals.
    query = {'active_version': {'$ne': None}, 'active': {'$ne': None}}
    payloads = [record['active'] async for record in db(request).reviews.aggregate([
        {'$match': query}, {'$project': comparison_projection()}])]
    return rankings_page(payloads)


@public_router.get('/reviews/{slug}')
async def public_review(request: Request, slug: str, response: Response, view: str = Query("full", pattern="^(full|article)$")):
    response.headers['Cache-Control']='no-store'
    payload = copy.deepcopy(await active(db(request),slug))
    if view == 'article':
        for e in payload['evidence'].values():
            for key in ('series','time','tracks','distribution'): e.pop(key,None)
            e['deferred'] = e['configuration']['visualization'] != 'table'
    return payload


@public_router.get('/reviews/{slug}/evidence/{evidence_id}')
async def public_evidence(request: Request, slug: str, evidence_id: str, version: str, response: Response):
    payload = await active(db(request),slug)
    if payload['version']!=version or evidence_id not in payload['evidence']: raise HTTPException(404,'Evidencia no disponible en la versión activa')
    response.headers['Cache-Control']='no-store'
    return {'version':version,'evidence':payload['evidence'][evidence_id]}


@public_router.get('/reviews/{slug}/media/{media_id}')
async def public_media(request: Request, slug: str, media_id: str, version: str, w: int | None = Query(None, ge=160, le=1600)):
    payload = await active(db(request),slug)
    if payload['version']!=version or media_id not in payload['media']: raise HTTPException(404,'Imagen no disponible en la versión activa')
    return await image_response(db(request),media_id,w)

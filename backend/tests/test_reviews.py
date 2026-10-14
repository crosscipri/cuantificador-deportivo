"""Explicit opt-in integration tests, localhost only, disposable synthetic MongoDB.
Run: REVIEW_TEST_MONGO=1 python -m unittest discover -s tests -p 'test_reviews.py' -v
"""
import asyncio
import copy
import io
import os
import unittest
from uuid import uuid4
from unittest.mock import patch, AsyncMock
from bson import ObjectId
from PIL import Image
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from httpx import AsyncClient, ASGITransport
from reviews.models import Draft, PurchaseLink, ReviewScores, sanitize, validate_youtube as youtube
from reviews.router import create_indexes

class ReviewModelTests(unittest.TestCase):
    def test_review_score_validation(self):
        self.assertIsNone(ReviewScores().fc)
        self.assertEqual(ReviewScores(fc=0,hrv=-20,gps=100).fc,0)
        for values in ({'fc':101},{'hrv':-101},{'gps':-1},{'rest_hr':float('nan')},{'fc':float('inf')}):
            with self.assertRaises(ValueError): ReviewScores(**values)
    def test_optional_purchase_price(self):
        link={'id':'shop','label':'Tienda sintética','url':'https://example.test/product'}
        self.assertIsNone(PurchaseLink(**link).price)
        self.assertEqual(PurchaseLink(**link,price=199.95,price_checked_at='2026-09-30').currency,'EUR')
        for value in (-1,float('nan'),float('inf')):
            with self.assertRaises(ValueError): PurchaseLink(**link,price=value)
        with self.assertRaises(ValueError): PurchaseLink(**link,price_checked_at='2026-02-31')
    def test_sanitization_and_validation(self):
        self.assertEqual(sanitize('<p onclick="x()"><strong>Hola</strong><img src=x><a href="javascript:x()">link</a></p>'),'<p><strong>Hola</strong><a>link</a></p>')
        self.assertEqual(youtube('https://youtu.be/abcdefghijk'),'abcdefghijk')
        with self.assertRaises(ValueError): youtube('https://evil.test/abcdefghijk')
        with self.assertRaises(ValueError): Draft(blocks=[{'id':'x','type':'text'},{'id':'x','type':'heading'}])

@unittest.skipUnless(os.getenv('REVIEW_TEST_MONGO')=='1','Requires explicit local MongoDB opt-in')
class ReviewIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        os.environ.update(MONGO_URL='mongodb://127.0.0.1:27017',DB_NAME='review_test_unused',APP_PASSWORD='synthetic-test-password')
        import main
        self.main=main;self.old_password=main.APP_PASSWORD
        main.APP_PASSWORD='synthetic-test-password';main.app.state.review_auth_configured=True
        self.mongo=AsyncIOMotorClient('mongodb://127.0.0.1:27017',serverSelectionTimeoutMS=2000)
        self.database=self.mongo['review_test_'+uuid4().hex]
        await self.database.command('ping');main.app.state.db=self.database
        await create_indexes(self.database)
        self.http=AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test',auth=(main.APP_USERNAME,main.APP_PASSWORD))
        self.device_id=str(ObjectId());self.source_id=str(ObjectId())
        await self.database.devices.insert_one({'_id':ObjectId(self.device_id),'name':'SINTÉTICO — no es un producto','reference_name':'Referencia sintética'})
        await self.database.sessions.insert_one({'_id':ObjectId(self.source_id),'device_id':ObjectId(self.device_id),
            'session_name':'Fixture FC sintética','sport_type':'running','training_type':'z2','device_name':'Sensor sintético',
            'reference_name':'Referencia sintética','activity_date':'2026-01-01',
            'fc_data':{'time':[0,1,2,3],'device':[101,112,119,130],'reference':[100,110,120,130]},
            'metrics':{'mae':1.0,'bias':.5,'r':.99,'loa_l':-2.0,'loa_u':3.0,'n':4},
            'device_file_bytes':b'PRIVATE RAW','device_file_name':'/private/acquisition.fit','ai_analysis':{'secret':'PRIVATE'}})
        self.path='/api/reviews/'+self.device_id
        self.state=(await self.call('POST',self.path)).json()
    async def asyncTearDown(self):
        await self.http.aclose();await self.mongo.drop_database(self.database.name);self.mongo.close()
        self.main.APP_PASSWORD=self.old_password
    async def call(self,method,path,expected=200,**kwargs):
        response=await self.http.request(method,path,**kwargs)
        self.assertEqual(response.status_code,expected,response.text[:1200]);return response
    async def save(self,draft=None):
        self.state=(await self.call('PUT',self.path,json={'expected_revision':self.state['revision'],'draft':draft or self.state['draft']})).json()
    async def image(self):
        buf=io.BytesIO();Image.new('RGB',(20,20),'blue').save(buf,format='PNG')
        return (await self.call('POST',self.path+'/media',files={'file':('synthetic.png',buf.getvalue(),'image/png')})).json()
    async def valid(self,evidence=True):
        self.medium=await self.image();d=self.state['draft']
        d.update(summary='Resumen editorial sintético',cover={'media_id':self.medium['id'],'alt':'Cuadrado sintético','caption':''})
        d['blocks']=[{'id':'intro','type':'heading','text':'Introducción'},{'id':'body','type':'text','html':'<p>Texto <strong>sintético</strong>.</p>'},{'id':'photo','type':'image','media':[d['cover']]}]
        if evidence:
            self.ref={'kind':'fc','source_id':self.source_id,'visualization':'temporal','series':['device','reference']}
            export=(await self.call('POST',self.path+'/evidence',json=self.ref)).json();self.ref['revision']=export['revision']
            d['blocks'].append({'id':'chart','type':'chart','title':'FC de prueba','evidence':self.ref})
        await self.save(d)
    async def publish(self):
        self.state=(await self.call('POST',self.path+'/publish',json={'expected_revision':self.state['revision']})).json()
        return (await self.call('GET','/api/public/reviews/'+self.state['draft']['slug'],auth=None)).json()
    async def test_create_unique_and_reopen_persistent(self):
        results=await asyncio.gather(*[self.call('POST',self.path) for _ in range(5)])
        self.assertEqual(await self.database.reviews.count_documents({}),1)
        self.assertTrue(all(r.json()['revision']==1 for r in results))
        d=self.state['draft'];d['blocks']=[{'id':'b','type':'text','html':'<p>Persistente</p>'},{'id':'a','type':'heading','text':'Al final'}];await self.save(d)
        fresh=AsyncIOMotorClient('mongodb://127.0.0.1:27017')
        try:
            stored=await fresh[self.database.name].reviews.find_one({'_id':self.device_id});self.assertEqual(stored['draft'],self.state['draft'])
        finally: fresh.close()
        self.assertEqual((await self.call('GET',self.path)).json()['draft'],self.state['draft'])
    async def test_prices_keep_selected_links_and_publication_isolation(self):
        await self.valid(False)
        selected={'id':'store','label':'Tienda sintética','url':'https://example.test/product','price':199.95,'currency':'EUR','price_checked_at':'2026-09-30'}
        private={'id':'private-store','label':'No seleccionado','url':'https://example.test/private','price':5}
        await self.call('PUT',self.path+'/profile',json={'expected_revision':0,'purchase_links':[selected,private]})
        self.state['draft']['blocks'].append({'id':'buy','type':'purchase','link_ids':['store'],'affiliate_notice':'Enlace de prueba sintético.'})
        await self.save();published=await self.publish()
        self.assertEqual(published['device']['purchase_links'],[selected])
        self.assertEqual(published['article']['blocks'][-1]['links'],[selected])
        await self.call('PUT',self.path+'/profile',json={'expected_revision':1,'purchase_links':[{**selected,'price':179.95}]})
        current=(await self.call('GET','/api/public/reviews/'+self.state['draft']['slug'],auth=None)).json()
        self.assertEqual(current,published)
    async def test_catalog_filters_scores_amazon_and_frozen_publication(self):
        await self.valid(False)
        selected={'id':'amazon','label':'Amazon sintético','url':'https://www.amazon.es/dp/SYNTHETIC','price':199.95,'currency':'EUR','price_checked_at':'2026-10-05'}
        private={**selected,'id':'private','url':'https://www.amazon.es/dp/PRIVATE','price':1}
        await self.call('PUT',self.path+'/profile',json={'expected_revision':0,'brand':'Marca A','purchase_links':[selected,private]})
        self.state['draft']['categories']=['Relojes']
        self.state['draft']['blocks'].extend([
            {'id':'rating','type':'verdict','scores':{'fc':90,'hrv':80,'rest_hr':100,'gps':90}},
            {'id':'buy','type':'purchase','link_ids':['amazon'],'affiliate_notice':'Enlace sintético.'}])
        await self.save();published=await self.publish()
        # A second synthetic active publication exercises pagination after ordering.
        second=copy.deepcopy(published);second['article']['slug']='segundo-sintetico';second['device']['name']='Segundo';second['device']['brand']='Marca B'
        second['article']['blocks']=[{'type':'verdict','scores':{'fc':98}}];second['device']['purchase_links']=[]
        await self.database.reviews.insert_one({'_id':'synthetic-second','slug':'segundo-sintetico','active_version':'synthetic','active':second})
        catalog=(await self.call('GET','/api/public/reviews?sort=score_desc&limit=1&page=2',auth=None)).json()
        self.assertEqual(catalog['total'],2);self.assertEqual(catalog['items'][0]['rating']['total'],90)
        self.assertEqual(catalog['items'][0]['amazon']['price'],199.95)
        self.assertNotIn('PRIVATE',str(catalog));self.assertNotIn('blocks',catalog['items'][0]['article'])
        for query in ['brand=Marca+A','brand=Marca+B&brand=Marca+A&complete_only=true','amazon_only=true&max_price=200','metric=gps&min_score=90']:
            result=(await self.call('GET','/api/public/reviews?'+query,auth=None)).json()
            self.assertEqual(result['total'],1)
        await self.call('GET','/api/public/reviews?sort=invalid',auth=None,expected=422)
        await self.call('GET','/api/public/reviews?min_score=NaN',auth=None,expected=422)
        await self.call('GET','/api/public/reviews?limit=51',auth=None,expected=422)
        await self.call('PUT',self.path+'/profile',json={'expected_revision':1,'brand':'Editada','purchase_links':[{**selected,'price':5}]})
        self.state['draft']['blocks'][-2]['scores']['fc']=0
        await self.save()
        after=(await self.call('GET','/api/public/reviews?brand=Marca+A',auth=None)).json()['items'][0]
        self.assertEqual(after['rating']['total'],90);self.assertEqual(after['amazon']['price'],199.95)
        await self.call('POST',self.path+'/withdraw',json={'expected_revision':self.state['revision']})
        self.assertEqual((await self.call('GET','/api/public/reviews?amazon_only=true',auth=None)).json()['total'],0)
    async def test_incomplete_draft_and_preview(self):
        await self.save()
        response=await self.call('POST',self.path+'/publish',expected=422,json={'expected_revision':self.state['revision']})
        self.assertIn('Falta resumen',response.json()['detail'])
        p=(await self.call('POST',self.path+'/preview',json={'expected_revision':self.state['revision']})).json()
        self.assertEqual(p['payload']['article']['blocks'],[])
        await self.call('GET','/api/public/reviews/'+self.state['draft']['slug'],expected=404,auth=None)
    async def test_preview_dates_and_publication_dates_remain_distinct(self):
        await self.valid(False)
        preview=(await self.call('POST',self.path+'/preview',json={'expected_revision':self.state['revision']})).json()
        self.assertEqual(preview['payload']['preview'],{'saved_at':self.state['saved_at'],'first_published_at':None})
        self.assertNotIn('published_at',preview['payload'])
        self.state=(await self.call('POST',self.path+'/publish',json={'expected_revision':self.state['revision'],'preview_token':preview['preview_token']})).json()
        published=(await self.call('GET','/api/public/reviews/'+self.state['draft']['slug'],auth=None)).json()
        self.assertNotIn('preview',published)
        self.assertEqual(published['first_published_at'],published['published_at'])
        self.state['draft']['summary']='Borrador posterior a la publicación';await self.save()
        preview=(await self.call('POST',self.path+'/preview',json={'expected_revision':self.state['revision']})).json()
        self.assertEqual(preview['payload']['preview']['saved_at'],self.state['saved_at'])
        self.assertEqual(preview['payload']['preview']['first_published_at'],published['first_published_at'])
        self.assertEqual((await self.call('GET','/api/public/reviews/'+self.state['draft']['slug'],auth=None)).json(),published)
        self.state=(await self.call('POST',self.path+'/publish',json={'expected_revision':self.state['revision'],'preview_token':preview['preview_token']})).json()
        updated=(await self.call('GET','/api/public/reviews/'+self.state['draft']['slug'],auth=None)).json()
        self.assertEqual(updated['first_published_at'],published['first_published_at'])
        self.assertGreater(updated['published_at'],published['published_at'])
        self.assertNotIn('preview',updated)
    async def test_verdict_scores_persist_and_publication_stays_frozen(self):
        await self.valid(False)
        self.state['draft']['blocks'].append({'id':'verdict','type':'verdict','scores':{'fc':0,'hrv':90,'rest_hr':None,'gps':80}})
        await self.save()
        draft=(await self.call('GET',self.path)).json()['draft'];self.assertEqual(draft['blocks'][-1]['scores']['fc'],0)
        preview=(await self.call('POST',self.path+'/preview',json={'expected_revision':self.state['revision']})).json()
        self.assertEqual(preview['payload']['article']['blocks'][-1]['scores']['fc'],0)
        published=await self.publish();self.assertEqual(published['article']['blocks'][-1]['scores']['gps'],80)
        self.state['draft']['blocks'][-1]['scores']['fc']=99;await self.save()
        self.assertEqual((await self.call('GET','/api/public/reviews/'+published['article']['slug'],auth=None)).json(),published)
        updated=await self.publish();self.assertEqual(updated['article']['blocks'][-1]['scores']['fc'],99)
        historic=(await self.call('GET',self.path+'/history/'+published['version'])).json()
        self.assertEqual(historic['article']['blocks'][-1]['scores']['fc'],0)
        self.state['draft']['blocks'][-1]['scores'].update(source='device',source_device_id=str(ObjectId()))
        await self.save()
        await self.call('POST',self.path+'/publish',expected=422,json={'expected_revision':self.state['revision']})
    async def test_canonical_device_id_and_incomplete_fields(self):
        upper=(await self.call('POST','/api/reviews/'+self.device_id.upper())).json()
        self.assertEqual(upper['device_id'],self.device_id)
        self.assertEqual(await self.database.reviews.count_documents({}),1)
        await self.valid()
        self.state['draft']['youtube']='https://you'
        self.state['draft']['blocks'][-1]['evidence'].update(start=20,end=2)
        await self.save()
        preview=(await self.call('POST',self.path+'/preview',json={'expected_revision':self.state['revision']})).json()
        self.assertTrue(any('Vídeo principal' in e for e in preview['errors']))
        self.assertTrue(any('final debe' in e for e in preview['errors']))
        await self.call('POST',self.path+'/publish',expected=422,json={'expected_revision':self.state['revision']})

    async def test_lightweight_catalog_preview_dependency_and_projection(self):
        await self.valid()
        self.state['draft']['blocks'][1]['media']=[{'media_id':'UNSELECTED','alt':'secret','caption':''}]
        self.state['draft']['blocks'].insert(1,{'id':'child','type':'heading','level':3,'text':'Subsección'})
        await self.save()
        preview=(await self.call('POST',self.path+'/preview',json={'expected_revision':self.state['revision']})).json()
        await self.call('PUT','/api/review-media/'+self.medium['id'],json={'alt':'Nuevo metadato','caption':''})
        await self.call('POST',self.path+'/publish',expected=409,json={'expected_revision':self.state['revision'],'preview_token':preview['preview_token']})
        p=await self.publish();slug=p['article']['slug']
        self.assertEqual(p['article']['blocks'][0]['id'],'intro')
        self.assertNotIn('UNSELECTED',str(p));self.assertNotIn('evidence',p['article']['blocks'][-1])
        catalog=(await self.call('GET','/api/public/reviews',auth=None)).json()
        self.assertEqual(catalog['total'],1);self.assertNotIn('blocks',catalog['items'][0]['article'])
        light=(await self.call('GET','/api/public/reviews/'+slug+'?view=article',auth=None)).json()
        e=next(iter(light['evidence'].values()));self.assertTrue(e['deferred']);self.assertNotIn('series',e);self.assertTrue(e['summary_metrics'])
        await self.call('PUT','/api/review-media/'+self.medium['id'],json={'alt':'Otro cambio privado','caption':''})
        self.assertTrue((await self.call('GET',self.path)).json()['dependencies_dirty'])
        image=await self.call('GET',f'/api/public/reviews/{slug}/media/{self.medium["id"]}?version={p["version"]}&w=400',auth=None)
        self.assertEqual(image.headers['content-type'],'image/webp')
        await self.call('POST',self.path+'/withdraw',json={'expected_revision':self.state['revision']})
        self.assertEqual((await self.call('GET','/api/public/reviews',auth=None)).json()['total'],0)

    async def test_night_sleep_and_table_without_series(self):
        await self.valid(False)
        night_id=ObjectId()
        await self.database.nocturnal_hrv_sessions.insert_one({'_id':night_id,'device_id':ObjectId(self.device_id),'session_name':'Noche sintética','windows':[{'tsMs':1000000,'rmssdPolar':40,'rmssdFitbit':42,'hrPolar':55,'hrFitbit':56},{'tsMs':1300000,'rmssdPolar':50,'rmssdFitbit':52,'hrPolar':54,'hrFitbit':55}],'summary':{'biasMean':2,'lowerLoa':1,'upperLoa':3,'hrMAE':1}})
        sources=(await self.call('GET',self.path+'/sources')).json()
        for kind,unit in [('night_rmssd','ms'),('night_hr','bpm')]:
            option=next(s for s in sources if s['kind']==kind)
            ref={'kind':kind,'source_id':str(night_id),'visualization':'temporal','series':['device','reference']}
            exported=(await self.call('POST',self.path+'/evidence',json=ref)).json();self.assertEqual(exported['unit'],unit);self.assertEqual(exported['revision'],option['revision']);ref['revision']=exported['revision']
            self.state['draft']['blocks'].append({'id':kind,'type':'chart','evidence':ref})
        sleep_id=ObjectId()
        await self.database.sleep_comparisons.insert_one({'_id':sleep_id,'configuration':{'name':'Sueño sintético'},'evidence':{'participant_id':'PRIVATE_PARTICIPANT','reference_name':'Referencia sintética','processing_version':'sleep-epoch-1','rows':[{'device_id':self.device_id,'recording_id':'opaque','metrics':{'n_epochs':2,'classes':['WAKE','LIGHT'],'confusion_matrix':[[1,0],[0,1]],'coverage_percent':100}},{'device_id':str(ObjectId()),'recording_id':'PRIVATE_OTHER','metrics':{'n_epochs':999}}]}})
        ref={'kind':'sleep','source_id':str(sleep_id)+':opaque','visualization':'table'}
        exported=(await self.call('POST',self.path+'/evidence',json=ref)).json();ref['revision']=exported['revision'];self.assertNotIn('PRIVATE_',str(exported))
        self.state['draft']['public_results']=[ref]
        self.state['draft']['blocks'].append({'id':'sleep','type':'table','table_origin':'results','evidence':ref})
        await self.save();p=await self.publish();self.assertEqual(len(p['evidence']),3)
        await self.database.sessions.update_one({'_id':ObjectId(self.source_id)},{'$set':{'fc_data':{}}})
        ref={'kind':'fc','source_id':self.source_id,'visualization':'table'}
        exported=(await self.call('POST',self.path+'/evidence',json=ref)).json();ref['revision']=exported['revision']
        self.state['draft']['public_results']=[ref];await self.save();await self.publish()

    async def test_current_comparison_verified_originals_distribution_and_no_writes(self):
        from comparisons.models import Selection
        from comparisons.service import direct_compute, source_manifest
        from comparisons.statistics import VERSION
        from datetime import datetime, timezone, timedelta
        def gpx(delta):
            start=datetime(2026,1,1,tzinfo=timezone.utc)
            points=''.join(f'<trkpt lat="40" lon="-3"><time>{(start+timedelta(seconds=i)).isoformat()}</time><extensions><hr>{100+i%30+delta}</hr></extensions></trkpt>' for i in range(120))
            return ('<gpx><trk><trkseg>'+points+'</trkseg></trk></gpx>').encode()
        other=str(ObjectId());second=str(ObjectId());reference=gpx(0)
        docs=[]
        for sid,did,delta in [(self.source_id,self.device_id,2),(second,other,7)]:
            doc={'_id':ObjectId(sid),'device_id':ObjectId(did),'reference_recording_id':'opaque-reference','device_name':'Sensor sintético','session_name':'Prueba sintética','device_file_name':'PRIVATE_DEVICE.gpx','reference_file_name':'PRIVATE_REFERENCE.gpx','device_file_bytes':gpx(delta),'reference_file_bytes':reference,'participant_id':'PRIVATE_PARTICIPANT'}
            await self.database.sessions.replace_one({'_id':doc['_id']},doc,upsert=True);docs.append(doc)
        config=Selection(mode='DIRECT',session_ids=[self.source_id,second],advanced={'enabled':True})
        computed=direct_compute(docs,config,False)
        ident=ObjectId();frozen={'rows':computed['rows'],'processing_version':VERSION,'source_manifest':source_manifest(docs)}
        await self.database.comparisons.insert_one({'_id':ident,'configuration':config.model_dump(),'evidence':frozen,'storage_mode':'SNAPSHOT'})
        ref={'kind':'comparison','source_id':str(ident)+':'+self.source_id,'visualization':'distribution','series':['device','reference']}
        before=await self.database.analysis_revisions.count_documents({})
        exported=(await self.call('POST',self.path+'/evidence',json=ref)).json()
        self.assertIn('distribution',exported['visualizations']);self.assertTrue(exported['distribution']);self.assertEqual(len(exported['series']),2)
        self.assertNotIn('PRIVATE_',str(exported));self.assertNotIn(other,str(exported));self.assertNotIn(second,str(exported))
        self.assertEqual(await self.database.analysis_revisions.count_documents({}),before)
        self.assertEqual(await self.database.recordings.count_documents({}),0)
        source=next(s for s in (await self.call('GET',self.path+'/sources')).json() if s['kind']=='comparison')
        self.assertEqual(source['revision'],exported['revision'])
        await self.database.comparisons.update_one({'_id':ident},{'$set':{'evidence.processing_version':'older-engine'}})
        unavailable=(await self.call('POST',self.path+'/evidence',json=ref)).json()
        self.assertEqual(unavailable['visualizations'],['table']);self.assertTrue(unavailable['metrics']);self.assertNotIn('series',unavailable)

    async def test_archived_gps_scalar_evidence_and_segment_breaks(self):
        from reviews.evidence import source_export
        ident=ObjectId();row_id=str(ObjectId())+':0:1'
        await self.database.archive_comparisons.insert_one({'_id':ident,'configuration':{'name':'GPS sintético','domain':'GPS_TRACK'},'evidence':{'unit':'m','processing_version':'comparison-2.0.0','rows':[{'id':row_id,'device_id':self.device_id,'analysis_revision_id':'frozen','source_url':'PRIVATE_URL','name':'PRIVATE_FILENAME','metrics':{'distance_error_m':2.5,'distance_error_percent':.5}}]}})
        ref={'kind':'archive','source_id':str(ident)+':'+row_id,'visualization':'table'}
        e=(await self.call('POST',self.path+'/evidence',json=ref)).json()
        self.assertTrue(e['metrics']);self.assertEqual(e['unit'],'m');self.assertNotIn('PRIVATE_',str(e));self.assertIsNone(e['session_count'])
        sources=(await self.call('GET',self.path+'/sources')).json();self.assertEqual(next(s for s in sources if s['kind']=='archive')['revision'],e['revision'])
        doc={'_id':ObjectId(),'device_id':ObjectId(self.device_id),'modes':[{'runs':[{'points':[{'lat':40,'lon':-3,'time':'2026-01-01T00:00:00Z'},{'lat':40.1,'lon':-3.1,'time':'2026-01-01T00:01:00Z'}]}]}]}
        self.assertEqual(len(source_export(doc,'gps')['tracks'][0]['segments']),2)

    async def test_out_of_order_and_two_tab_conflicts(self):
        old=copy.deepcopy(self.state);d=copy.deepcopy(old['draft']);d['summary']='Cambios nuevos';await self.save(d)
        await self.call('PUT',self.path,expected=409,json={'expected_revision':old['revision'],'draft':old['draft']})
        self.assertEqual((await self.call('GET',self.path)).json()['draft']['summary'],'Cambios nuevos')
        replies=await asyncio.gather(*[self.http.put(self.path,json={'expected_revision':self.state['revision'],'draft':d}) for _ in range(2)])
        self.assertEqual(sorted(r.status_code for r in replies),[200,409])
    async def test_media_validation_metadata_and_protection(self):
        await self.valid(False);m=self.medium['id']
        await self.call('PUT','/api/review-media/'+m,json={'alt':'Metadato persistente','caption':'Pie'})
        self.assertEqual((await self.call('GET',self.path+'/media')).json()[0]['alt'],'Metadato persistente')
        await self.call('DELETE','/api/review-media/'+m,expected=409)
        for name,data,mime,code in [('bad.png',b'<script/>','image/png',422),('bad.svg',b'<svg/>','image/svg+xml',422),('large.png',b'x'*(5*1024*1024+1),'image/png',413)]:
            await self.call('POST',self.path+'/media',expected=code,files={'file':(name,data,mime)})
        p=await self.publish();await self.call('PUT','/api/review-media/'+m,json={'alt':'Cambio privado','caption':''})
        same=(await self.call('GET','/api/public/reviews/'+p['article']['slug'],auth=None)).json()
        self.assertEqual(same['media'][m]['alt'],'Metadato persistente')
    async def test_isolation_draft_profile_recalculation_and_history(self):
        await self.valid();original=await self.publish();slug=original['article']['slug']
        self.state['draft']['title']='Título privado';await self.save()
        await self.call('PUT',self.path+'/profile',json={'expected_revision':0,'brand':'Marca privada'})
        await self.database.sessions.update_one({'_id':ObjectId(self.source_id)},{'$set':{'fc_data.device':[900,900,900,900]}})
        self.assertNotEqual((await self.call('GET',self.path+'/sources')).json()[0]['revision'],self.ref['revision'])
        self.assertEqual((await self.call('GET','/api/public/reviews/'+slug,auth=None)).json(),original)
        latest=(await self.call('POST',self.path+'/evidence',json=self.ref)).json()
        self.state['draft']['blocks'][-1]['evidence']['revision']=latest['revision'];await self.save();update=await self.publish()
        self.assertNotEqual(update['version'],original['version']);self.assertEqual(update['article']['title'],'Título privado');self.assertEqual(update['device']['brand'],'Marca privada')
        self.assertEqual(next(iter(update['evidence'].values()))['series'][0]['values'],[900]*4)
        self.assertEqual(len((await self.call('GET',self.path+'/history')).json()),2)
        self.assertEqual((await self.call('GET',self.path+'/history/'+original['version'])).json(),original)
        for forbidden in ('PRIVATE RAW','/private/','file_bytes','file_name','ai_analysis','credentials'): self.assertNotIn(forbidden,str(update))
    async def test_results_selection_independent_of_article(self):
        await self.valid();await self.publish()
        self.state['draft']['blocks']=[b for b in self.state['draft']['blocks'] if b['type']!='chart']
        self.state['draft']['public_results']=[{**self.ref,'visualization':'table'}];await self.save();p=await self.publish()
        self.assertEqual(len(p['public_results']),1);self.assertFalse(any(b['type']=='chart' for b in p['article']['blocks']))
        e=p['evidence'][p['public_results'][0]];self.assertNotIn('series',e);self.assertNotIn('time',e)
        self.assertEqual(e['session_count'],1);self.assertIsNone(e['coverage']);self.assertIsNone(e['protocol']);self.assertEqual(e['ranking_eligibility'],'not_assessed')
    async def test_failure_preserves_public_version_hides_orphan(self):
        await self.valid();original=await self.publish();self.state['draft']['summary']='Intento fallido';await self.save()
        with patch('reviews.router.cas',AsyncMock(side_effect=HTTPException(409,'Simulated commit conflict'))):
            await self.call('POST',self.path+'/publish',expected=409,json={'expected_revision':self.state['revision']})
        self.assertEqual((await self.call('GET','/api/public/reviews/'+original['article']['slug'],auth=None)).json(),original)
        self.assertEqual(len((await self.call('GET',self.path+'/history')).json()),1)
        orphan=await self.database.review_versions.find_one({'_id':{'$ne':original['version']}})
        await self.call('GET',self.path+'/history/'+orphan['_id'],expected=404)
    async def test_withdraw_revokes_media_evidence_restore_only_draft(self):
        await self.valid();p=await self.publish();slug=p['article']['slug'];v=p['version'];eid=next(iter(p['evidence']))
        suffixes=['',f'/evidence/{eid}?version={v}',f'/media/{self.medium["id"]}?version={v}']
        for suffix in suffixes: await self.call('GET','/api/public/reviews/'+slug+suffix,auth=None)
        self.state=(await self.call('POST',self.path+'/withdraw',json={'expected_revision':self.state['revision']})).json()
        for suffix in suffixes: await self.call('GET','/api/public/reviews/'+slug+suffix,expected=404,auth=None)
        self.state=(await self.call('POST',self.path+'/restore/'+v,json={'expected_revision':self.state['revision']})).json();self.assertIsNone(self.state['active_version'])
        await self.call('GET','/api/public/reviews/'+slug,expected=404,auth=None)
        await self.call('GET',self.path+'/history/'+v)
        self.state['draft']['cover']['media_id']='';self.state['draft']['blocks']=[];await self.save()
        await self.call('DELETE','/api/review-media/'+self.medium['id'],expected=409)
    async def test_authentication_fail_closed_and_public_allowlist(self):
        await self.valid();p=await self.publish()
        for method,path in [('GET',self.path),('POST',self.path+'/preview'),('GET',self.path+'/history'),('GET','/api/review-media/'+self.medium['id'])]: await self.call(method,path,expected=401,auth=None)
        await self.call('GET','/api/public/reviews/'+p['article']['slug'],auth=None)
        await self.call('GET','/api/public/reviews/'+self.device_id,expected=404,auth=None)
        self.main.APP_PASSWORD='';self.main.app.state.review_auth_configured=False
        try: await self.call('GET',self.path,expected=503,auth=None)
        finally: self.main.APP_PASSWORD='synthetic-test-password';self.main.app.state.review_auth_configured=True
    async def test_slug_uniqueness_stability_and_foreign_sources(self):
        await self.valid();p=await self.publish();d=copy.deepcopy(self.state['draft']);d['slug']='new-slug'
        await self.call('PUT',self.path,expected=422,json={'expected_revision':self.state['revision'],'draft':d})
        other=str(ObjectId());await self.database.devices.insert_one({'_id':ObjectId(other),'name':'Otro sintético'})
        state=(await self.call('POST','/api/reviews/'+other)).json();state['draft']['slug']=p['article']['slug']
        await self.call('PUT','/api/reviews/'+other,expected=409,json={'expected_revision':state['revision'],'draft':state['draft']})
        await self.call('POST','/api/reviews/'+other+'/evidence',expected=422,json=self.ref)
        await self.call('DELETE','/api/devices/'+self.device_id,expected=409)
    async def test_total_correlation_uses_frozen_unique_aligned_session_pairs(self):
        import numpy as np
        await self.valid()
        second=ObjectId();refs=[200+i/10 for i in range(800)];devs=[300-i/20 for i in range(800)];devs[11]=None
        await self.database.sessions.insert_one({'_id':second,'device_id':ObjectId(self.device_id),
            'session_name':'Segunda prueba sintética','sport_type':'running','reference_name':'Referencia sintética',
            'fc_data':{'time':list(range(800)),'reference':refs,'device':devs},'metrics':{'r':-.99}})
        second_ref={'kind':'fc','source_id':str(second),'visualization':'temporal','series':['device','reference']}
        e=(await self.call('POST',self.path+'/evidence',json=second_ref)).json();second_ref['revision']=e['revision']
        total={'kind':'fc_total','source_id':'total','sport':'running','visualization':'scatter','series':['device','reference'],
               'members':[{'source_id':r['source_id'],'revision':r['revision']} for r in (self.ref,second_ref)]}
        exported=(await self.call('POST',self.path+'/evidence',json=total)).json();total['revision']=exported['revision']
        values={m['key']:m['value'] for m in exported['metrics']}
        x=[100,110,120,130]+[r for r,d in zip(refs,devs) if d is not None]
        y=[101,112,119,130]+[d for d in devs if d is not None]
        self.assertEqual(values['n'],803);self.assertEqual(values['session_count'],2)
        self.assertEqual(values['r'],round(float(np.corrcoef(x,y)[0,1]),4))
        self.assertNotAlmostEqual(values['r'],(.99-.99)/2,places=2)
        self.assertEqual(sum(s['display_n'] for s in exported['sessions']),504)
        self.assertNotIn('PRIVATE',str(exported))
        await self.call('POST',self.path+'/evidence',expected=422,json={**total,'members':[total['members'][0]]*2})
        await self.call('POST',self.path+'/evidence',expected=422,json={**total,'start':1})
        await self.call('POST',self.path+'/evidence',expected=422,json={**total,'visualization':'temporal'})
        other=str(ObjectId())
        await self.call('POST','/api/reviews/'+other+'/evidence',expected=422,json=total)
        self.state['draft']['blocks'].extend([{'id':'second','type':'chart','evidence':second_ref},{'id':'total','type':'chart','evidence':total}])
        await self.save();published=await self.publish()
        frozen=next(e for e in published['evidence'].values() if e['kind']=='fc_total')
        self.assertEqual({m['key']:m['value'] for m in frozen['summary_metrics']},values)
        complete=copy.deepcopy(self.state['draft']);partial=copy.deepcopy(complete)
        partial['blocks']=[b for b in partial['blocks'] if b['id']!='second'];await self.save(partial)
        preview=(await self.call('POST',self.path+'/preview',json={'expected_revision':self.state['revision']})).json()
        self.assertTrue(any('mismas pruebas' in e for e in preview['errors']))
        await self.call('POST',self.path+'/publish',expected=422,json={'expected_revision':self.state['revision']})
        await self.save(complete)
        await self.database.sessions.update_one({'_id':second},{'$set':{'fc_data.device':[999]*800}})
        again=(await self.call('POST',self.path+'/evidence',json=total)).json()
        self.assertEqual(again,exported)
        self.assertEqual((await self.call('GET','/api/public/reviews/'+self.state['draft']['slug'],auth=None)).json(),published)
        latest=(await self.call('POST',self.path+'/evidence',json=second_ref)).json()
        altered=copy.deepcopy(total);altered['members'][1]['revision']=latest['revision']
        self.state['draft']['blocks'][-1]['evidence']=altered;await self.save()
        preview=(await self.call('POST',self.path+'/preview',json={'expected_revision':self.state['revision']})).json()
        self.assertTrue(any('no coincide' in e for e in preview['errors']))
        self.assertNotEqual((await self.call('POST',self.path+'/evidence',json=altered)).json()['revision'],total['revision'])

    async def test_sport_correlations_use_only_their_frozen_curves(self):
        await self.valid()
        refs=[self.ref]
        for sport in ('running','cycling'):
            source=ObjectId()
            await self.database.sessions.insert_one({'_id':source,'device_id':ObjectId(self.device_id),
                'session_name':'Prueba '+sport,'sport_type':sport,
                'fc_data':{'time':[0,1,2],'reference':[100,110,120],'device':[102,109,122]}})
            ref={'kind':'fc','source_id':str(source),'visualization':'temporal','series':['device','reference']}
            ref['revision']=(await self.call('POST',self.path+'/evidence',json=ref)).json()['revision']
            refs.append(ref)
            self.state['draft']['blocks'].append({'id':'curve-'+sport,'type':'chart','evidence':ref})
        totals=[]
        for sport,members in [('running',refs[:2]),('cycling',refs[2:])]:
            ref={'kind':'fc_total','source_id':'total','sport':sport,'visualization':'scatter',
                 'series':['device','reference'],'members':[{'source_id':r['source_id'],'revision':r['revision']} for r in members]}
            exported=(await self.call('POST',self.path+'/evidence',json=ref)).json()
            self.assertEqual(exported['sport'],sport)
            self.assertEqual({s['sport'] for s in exported['sessions']},{sport})
            ref['revision']=exported['revision'];totals.append(ref)
            self.state['draft']['blocks'].append({'id':'total-'+sport,'type':'chart','evidence':ref})
        await self.save()
        preview=(await self.call('POST',self.path+'/preview',json={'expected_revision':self.state['revision']})).json()
        self.assertEqual(preview['errors'],[])
        mixed={**totals[0],'members':totals[0]['members']+totals[1]['members']}
        for sport in ('running',None):
            await self.call('POST',self.path+'/evidence',expected=422,json={**mixed,'sport':sport})
        await self.call('POST',self.path+'/evidence',expected=422,json={**totals[0],'sport':'cycling'})
        # Reclassification of a live source cannot change membership of a frozen review.
        await self.database.sessions.update_one({'_id':ObjectId(refs[1]['source_id'])},{'$set':{'sport_type':'gym'}})
        metadata=(await self.call('GET',self.path+'/evidence')).json()
        self.assertEqual(next(e for e in metadata if e['revision']==refs[1]['revision'])['sport'],'running')
        self.assertTrue(all(set(e)=={'kind','source_id','revision','sport'} for e in metadata))
        await self.call('GET',self.path+'/evidence',expected=401,auth=None)
        other=ObjectId();await self.database.devices.insert_one({'_id':other,'name':'Otro'})
        self.assertEqual((await self.call('GET','/api/reviews/'+str(other)+'/evidence')).json(),[])
        preview=(await self.call('POST',self.path+'/preview',json={'expected_revision':self.state['revision']})).json()
        self.assertEqual(preview['errors'],[])
        self.state['draft']['blocks']=[b for b in self.state['draft']['blocks'] if b['id']!='curve-running']
        await self.save()
        errors=(await self.call('POST',self.path+'/preview',json={'expected_revision':self.state['revision']})).json()['errors']
        self.assertTrue(any('running' in e and 'mismas pruebas' in e for e in errors))
        self.assertFalse(any('cycling' in e for e in errors))

    async def test_gps_selected_tracks_no_filenames(self):
        await self.valid(False);gps_id=str(ObjectId())
        await self.database.gps_tests.insert_one({'_id':ObjectId(gps_id),'device_id':ObjectId(self.device_id),'name':'GPS sintético','modes':[{'name':'Modo','runs':[{'filename':'PRIVATE.fit','points':[{'lat':40,'lon':-3},{'lat':40.001,'lon':-3.001}]},{'filename':'SECRET.fit','points':[{'lat':41,'lon':-4}]}]}]})
        ref={'source_id':gps_id,'kind':'gps','visualization':'map','series':['0:0']}
        export=(await self.call('POST',self.path+'/evidence',json=ref)).json();ref['revision']=export['revision']
        self.state['draft']['blocks'].append({'id':'gps','type':'map','evidence':ref});await self.save();p=await self.publish();e=next(iter(p['evidence'].values()))
        self.assertEqual(len(e['tracks']),1);self.assertNotIn('filename',str(e));self.assertNotIn('SECRET',str(e))
    async def test_image_metadata_removed_and_invalid_dependencies(self):
        buf=io.BytesIO();img=Image.new('RGB',(20,20),'blue');exif=Image.Exif();exif[270]='PRIVATE GPS METADATA'
        img.save(buf,format='PNG',exif=exif)
        medium=(await self.call('POST',self.path+'/media',files={'file':('with-exif.png',buf.getvalue(),'image/png')})).json()
        response=await self.call('GET','/api/review-media/'+medium['id'])
        self.assertNotIn(b'PRIVATE GPS METADATA',response.content)
        self.assertFalse(Image.open(io.BytesIO(response.content)).getexif())
        await self.valid(False)
        self.state['draft']['blocks'].append({'id':'missing-chart','type':'chart'})
        await self.save()
        response=await self.call('POST',self.path+'/publish',expected=422,json={'expected_revision':self.state['revision']})
        self.assertTrue(any('falta prueba' in message for message in response.json()['detail']))
    async def test_profile_conflict_and_publish_storage_failure(self):
        await self.call('PUT',self.path+'/profile',json={'expected_revision':0,'brand':'Primera'})
        await self.call('PUT',self.path+'/profile',expected=409,json={'expected_revision':0,'brand':'Segunda'})
        self.assertEqual((await self.call('GET',self.path+'/profile')).json()['brand'],'Primera')
        await self.valid();original=await self.publish()
        with patch('reviews.router.size_check',side_effect=HTTPException(422,'Documento demasiado grande')):
            await self.call('POST',self.path+'/publish',expected=422,json={'expected_revision':self.state['revision']})
        self.assertEqual((await self.call('GET','/api/public/reviews/'+original['article']['slug'],auth=None)).json(),original)
    async def test_version_pin_and_selected_interval(self):
        await self.valid();self.state['draft']['blocks'][-1]['evidence'].update(start=1,end=2);await self.save()
        p=await self.publish();e=next(iter(p['evidence'].values()));self.assertEqual(e['time'],[1,2]);self.assertEqual(len(e['series'][0]['values']),2)
        await self.save();new=await self.publish()
        await self.call('GET',f'/api/public/reviews/{p["article"]["slug"]}/evidence/{e["id"]}?version={p["version"]}',expected=404,auth=None)
        await self.call('GET',f'/api/public/reviews/{p["article"]["slug"]}/evidence/{e["id"]}?version={new["version"]}',auth=None)

if __name__=='__main__': unittest.main()

"""Public comparison/ranking contracts; integration uses a disposable local DB."""
import copy
import os
import unittest
from uuid import uuid4

from reviews.comparison import (
    comparison_item, comparison_page, comparison_projection, parse_comparison_slugs,
)
from reviews.rankings import rankings_item, rankings_page


def evidence(source='a', kind='fc', **changes):
    result = {'kind': kind, 'source_id': source, 'name': 'Prueba sintética ' + source,
              'sport': 'running', 'date': '2026-10-01', 'reference': 'Referencia sintética',
              'revision': 'revision-' + source, 'analysis_version': 'synthetic-1',
              'summary_metrics': [{'key': 'mae', 'value': 1, 'unit': 'bpm'},
                                  {'key': 'ccc', 'value': .9, 'unit': ''},
                                  {'key': 'bias', 'value': -2, 'unit': 'bpm'},
                                  {'key': 'n', 'value': 2, 'unit': 'pares'}],
              'time': ['PRIVATE ARRAY'], 'series': ['PRIVATE ARRAY'],
              'tracks': ['PRIVATE ARRAY'], 'distribution': ['PRIVATE ARRAY'],
              'raw_file': 'PRIVATE RAW', 'configuration': {'private': 'PRIVATE CONFIG'}}
    result.update(changes)
    return result


def publication(slug='sintetico-a', value=90):
    return {'version': 'version-' + slug, 'published_at': '2026-10-01T12:00:00Z',
            'article': {'slug': slug, 'title': 'Review sintética', 'summary': 'Sólo pruebas',
                        'author': 'Test', 'cover': {'media_id': 'cover'}, 'categories': ['Relojes'], 'tags': [],
                        'blocks': [{'type': 'verdict', 'text': 'Conclusión congelada', 'pros': ['Ventaja'],
                                    'cons': ['Limitación'], 'recommended': 'Uso sintético',
                                    'not_recommended': 'Ninguna recomendación real',
                                    'scores': {'fc': value, 'gps': 0}}]},
            'device': {'name': slug, 'brand': 'SINTÉTICO', 'purchase_links': []},
            'media': {'cover': {}, 'unselected': {}}, 'evidence': {'test-a': evidence()},
            'draft': {'private': 'PRIVATE DRAFT'}}


class ComparisonTests(unittest.TestCase):
    def test_rankings_keep_original_signed_values_and_omit_test_provenance(self):
        payload = publication(value=-20)
        payload['evidence'] = {
            'private-chart-id': evidence('PRIVATE SOURCE', name='PRIVATE NAME', reference='PRIVATE REFERENCE',
                summary_metrics=[{'key': 'ccc', 'value': -.6, 'unit': ''}]),
            'private-chart-id-2': evidence('PRIVATE SOURCE 2', reference='PRIVATE REFERENCE',
                summary_metrics=[{'key': 'ccc', 'value': -.2, 'unit': ''}]),
            'private-hrv-id': evidence('PRIVATE NIGHT', kind='night_rmssd',
                reference='PRIVATE REFERENCE', summary_metrics=[
                    {'key': 'biasMean', 'value': -5, 'unit': 'ms'},
                    {'key': 'pearsonR', 'value': -.3, 'unit': ''}]),
            'private-gps-id': evidence('PRIVATE GPS', kind='gps', summary_metrics=[]),
        }
        before = copy.deepcopy(payload)
        item = rankings_item(payload)
        self.assertEqual(payload, before)
        self.assertEqual(item['rating']['total'], -10)
        self.assertEqual(item['rating']['gps'], 0)
        self.assertIsNone(item['rating']['hrv'])
        group = item['comparison']['sports'][0]
        self.assertEqual(set(group), {'key', 'label', 'sessions', 'metrics'})
        self.assertEqual(group['sessions'], 2)
        self.assertAlmostEqual(group['metrics'][0]['value'], -.4)
        self.assertEqual(group['metrics'][0]['aggregation'], 'session_mean')
        self.assertEqual(group['metrics'][0]['count'], 2)
        self.assertEqual(item['comparison']['nights'][0]['metrics'][0]['value'], -5)
        self.assertEqual(item['comparison']['gps'][0]['metrics'], [])
        self.assertEqual(item['comparison']['coverage']['gps_tests'], 1)
        serialized = str(item)
        for private in ('PRIVATE', 'source_id', 'private-chart', 'private-gps',
                        'pooled_source', 'references', 'series', 'tracks', 'distribution', 'configuration'):
            self.assertNotIn(private, serialized)

    def test_rankings_include_all_devices_and_leave_unmeasured_total_missing(self):
        payloads = [publication('sintetico-' + str(i)) for i in range(17)]
        payloads[0]['article']['blocks'][0]['scores'] = {}
        payloads[0]['evidence'] = {}
        page = rankings_page(reversed(payloads))
        self.assertEqual(page['total'], 17)
        self.assertEqual(len(page['items']), 17)
        self.assertEqual(page, rankings_page(payloads))
        missing = next(item for item in page['items'] if item['article']['slug'] == 'sintetico-0')
        self.assertIsNone(missing['rating']['total'])
        self.assertEqual(missing['rating']['areas'], 0)
        self.assertEqual(missing['comparison']['sports'], [])
        self.assertEqual(rankings_page([]), {'items': [], 'total': 0})

    def test_bounded_selection_deduplicates_and_retains_order(self):
        self.assertEqual(parse_comparison_slugs(['b', 'a', 'b']), ['b', 'a'])
        self.assertEqual(parse_comparison_slugs([]), [])
        for values in ([''], ['../private'], ['a'] * 17, list('abcde'), ['a' * 121]):
            with self.subTest(values=values):
                with self.assertRaises(ValueError):
                    parse_comparison_slugs(values)
        result = comparison_page(['sintetico-b', 'ausente', 'sintetico-a'],
                                 [publication(), publication('sintetico-b')])
        self.assertEqual([p['article']['slug'] for p in result['items']], ['sintetico-b', 'sintetico-a'])
        self.assertEqual(result['missing'], ['ausente'])

    def test_compact_immutable_projection_keeps_zero_and_missing(self):
        payload = publication(value=0)
        before = copy.deepcopy(payload)
        item = comparison_item(payload)
        self.assertEqual(payload, before)
        self.assertNotIn('PRIVATE', str(item))
        self.assertNotIn('evidence', item)
        self.assertEqual(set(item['media']), {'cover'})
        self.assertIsNone(item['rating']['hrv'])
        self.assertEqual(item['rating']['total'], 0)
        self.assertEqual(item['comparison']['verdict'], 'Conclusión congelada')
        source = item['comparison']['sports'][0]['sources'][0]
        self.assertEqual(source['revision'], 'revision-a')
        self.assertEqual(source['date'], '2026-10-01')
        self.assertEqual(source['reference'], 'Referencia sintética')

    def test_session_means_are_not_pooled_or_duplicated_visualizations(self):
        payload = publication()
        payload['evidence']['another-chart'] = evidence()
        payload['evidence']['test-b'] = evidence('b', summary_metrics=[
            {'key': 'mae', 'value': 5, 'unit': 'bpm'}, {'key': 'ccc', 'value': .7, 'unit': ''},
            {'key': 'bias', 'value': 4, 'unit': 'bpm'}, {'key': 'n', 'value': 100, 'unit': 'pares'}])
        payload['evidence']['total'] = evidence('total', kind='fc_total', members=[
            {'source_id': 'a', 'revision': 'revision-a'}, {'source_id': 'b', 'revision': 'revision-b'}],
            summary_metrics=[{'key': 'r', 'value': .98, 'unit': ''}, {'key': 'n', 'value': 102, 'unit': 'pares guardados'}])
        group = comparison_item(payload)['comparison']['sports'][0]
        self.assertEqual(group['sessions'], 2)
        metrics = {m['key']: m for m in group['metrics']}
        self.assertEqual(metrics['mae']['value'], 3)  # Unweighted mean of original MAEs, not samples.
        self.assertEqual(metrics['mae']['aggregation'], 'session_mean')
        self.assertEqual(metrics['mae']['count'], 2)
        self.assertIn('media por prueba', metrics['mae']['label'])
        self.assertEqual(metrics['bias']['value'], 1)
        self.assertEqual(metrics['n']['value'], 102)
        self.assertEqual(metrics['r']['value'], .98)
        self.assertEqual(metrics['r']['aggregation'], 'frozen_pooled')
        payload['evidence']['total']['members'][0]['revision'] = 'old-revision'
        self.assertNotIn('r', [m['key'] for m in comparison_item(payload)['comparison']['sports'][0]['metrics']])

    def test_units_missing_metrics_and_conflicting_revisions_are_explicit(self):
        payload = publication()
        payload['evidence']['first-copy'] = evidence(revision='different-revision')
        payload['evidence']['test-b'] = evidence('b', summary_metrics=[
            {'key': 'mae', 'value': 999, 'unit': 'ms'},
            {'key': 'ccc', 'value': float('nan'), 'unit': ''},
            {'key': 'bias', 'value': True, 'unit': 'bpm'}])
        payload['evidence']['unsupported'] = evidence('archive', kind='archive')
        comp = comparison_item(payload)['comparison']
        group = comp['sports'][0]
        self.assertEqual(group['sessions'], 2)
        mae = next(m for m in group['metrics'] if m['key'] == 'mae')
        self.assertEqual(mae['value'], 1)
        self.assertEqual(mae['count'], 1)
        self.assertEqual(group['sources'][1]['metrics'], [])
        self.assertTrue(any('varias revisiones' in message for message in comp['limitations']))

    def test_nights_and_gps_preserve_concepts_and_coverage(self):
        payload = publication()
        payload['evidence'] = {
            'hrv': evidence('night', kind='night_rmssd', summary_metrics=[
                {'key': 'rmssdMAE', 'value': 0, 'unit': 'ms'},
                {'key': 'biasMean', 'value': -5, 'unit': 'ms'},
                {'key': 'pearsonR', 'value': -.2, 'unit': ''}]),
            'hr': evidence('night', kind='night_hr', summary_metrics=[
                {'key': 'hrMAE', 'value': 2, 'unit': 'bpm'}]),
            'track': evidence('track', kind='gps', summary_metrics=[]),
            'urban': evidence('urban', kind='urban', summary_metrics=[]),
        }
        comp = comparison_item(payload)['comparison']
        self.assertEqual(comp['sports'], [])
        self.assertEqual(comp['coverage'], {'fc_sessions': 0, 'hrv_nights': 1, 'hr_nights': 1,
                                            'gps_tests': 2, 'sports': 0, 'areas': 2})
        self.assertEqual(comp['nights'][0]['metrics'][0]['value'], 0)
        self.assertIn('media por noche', comp['nights'][0]['metrics'][0]['label'])
        self.assertEqual(comp['nights'][1]['label'], 'FC nocturna')
        self.assertEqual([group['metrics'] for group in comp['gps']], [[], []])
        self.assertTrue(any('no se deduce' in message for message in comp['limitations']))


@unittest.skipUnless(os.getenv('REVIEW_TEST_MONGO') == '1', 'Requires explicit local MongoDB opt-in')
class ComparisonIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from motor.motor_asyncio import AsyncIOMotorClient
        from httpx import AsyncClient, ASGITransport
        os.environ.update(MONGO_URL='mongodb://127.0.0.1:27017', DB_NAME='review_test_unused', APP_PASSWORD='synthetic-test-password')
        import main
        self.main = main
        self.old_password = main.APP_PASSWORD
        main.APP_PASSWORD = 'synthetic-test-password'
        main.app.state.review_auth_configured = True
        self.mongo = AsyncIOMotorClient('mongodb://127.0.0.1:27017', serverSelectionTimeoutMS=2000)
        self.database = self.mongo['review_test_' + uuid4().hex]
        await self.database.command('ping')
        main.app.state.db = self.database
        self.http = AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test')
        for slug, score in [('sintetico-a', 90), ('sintetico-b', 70)]:
            payload = publication(slug, score)
            await self.database.reviews.insert_one({'_id': slug, 'slug': slug,
                'active_version': payload['version'], 'active': payload,
                'draft': {'title': 'PRIVATE DRAFT', 'scores': {'fc': -90}}})
        await self.database.reviews.insert_one({'_id': 'borrador', 'slug': 'borrador',
            'active_version': None, 'draft': publication('borrador')})

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.mongo.drop_database(self.database.name)
        self.mongo.close()
        self.main.APP_PASSWORD = self.old_password

    async def test_anonymous_selection_order_missing_and_database_projection(self):
        response = await self.http.get('/api/public/comparisons?slug=sintetico-b&slug=borrador&slug=sintetico-a&slug=sintetico-b')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        result = response.json()
        self.assertEqual([item['article']['slug'] for item in result['items']], ['sintetico-b', 'sintetico-a'])
        self.assertEqual(result['missing'], ['borrador'])
        self.assertNotIn('PRIVATE', response.text)
        records = await self.database.reviews.aggregate([
            {'$match': {'active_version': {'$ne': None}}}, {'$project': comparison_projection()}]).to_list(length=4)
        self.assertEqual(len(records), 2)
        self.assertNotIn('PRIVATE', str(records))
        self.assertNotIn('series', records[0]['active']['evidence']['test-a'])
        empty = await self.http.get('/api/public/comparisons')
        self.assertEqual(empty.json(), {'items': [], 'missing': [], 'limit': 4})

    async def test_frozen_scores_metrics_and_withdrawal(self):
        url = '/api/public/comparisons?slug=sintetico-a'
        before = (await self.http.get(url)).json()
        await self.database.reviews.update_one({'_id': 'sintetico-a'}, {'$set': {'draft': {'scores': {'fc': 0}}}})
        await self.database.devices.insert_one({'_id': 'sintetico-a', 'purchase_links': ['PRIVATE NEW LINK']})
        await self.database.sessions.insert_one({'_id': 'a', 'metrics': {'mae': 9000}})
        self.assertEqual((await self.http.get(url)).json(), before)
        await self.database.reviews.update_one({'_id': 'sintetico-a'}, {'$set': {'active': None, 'active_version': None}})
        after = (await self.http.get(url)).json()
        self.assertEqual(after['items'], [])
        self.assertEqual(after['missing'], ['sintetico-a'])

    async def test_invalid_selection_and_read_only_contract(self):
        for query in ['slug=a&slug=b&slug=c&slug=d&slug=e', 'slug=', 'slug=../private', 'slug=' + 'a' * 121]:
            response = await self.http.get('/api/public/comparisons?' + query)
            self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual((await self.http.post('/api/public/comparisons')).status_code, 405)

    async def test_rankings_are_anonymous_complete_frozen_and_withdrawable(self):
        for i in range(15):
            slug = 'adicional-' + str(i)
            payload = publication(slug, -20 if i == 0 else 0)
            await self.database.reviews.insert_one({'_id': slug, 'slug': slug,
                'active_version': payload['version'], 'active': payload,
                'draft': {'private': 'PRIVATE DRAFT'}})
        await self.database.reviews.insert_one({'_id': 'retirada', 'slug': 'retirada',
            'active_version': None, 'active': publication('retirada')})
        await self.database.reviews.insert_one({'_id': 'sin-payload', 'slug': 'sin-payload',
            'active_version': 'invalid', 'active': None})
        response = await self.http.get('/api/public/rankings')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        before = response.json()
        self.assertEqual(before['total'], 17)
        self.assertEqual(len(before['items']), 17)
        self.assertNotIn('PRIVATE', response.text)
        self.assertNotIn('source_id', response.text)
        self.assertNotIn('series', response.text)
        self.assertNotIn('sources', response.text)
        self.assertNotIn('retirada', response.text)
        self.assertNotIn('borrador', response.text)
        self.assertEqual(next(item for item in before['items'] if item['article']['slug'] == 'adicional-0')['rating']['total'], -10)
        await self.database.reviews.update_one({'_id': 'sintetico-a'}, {'$set': {'draft': {'scores': {'fc': -90}}}})
        await self.database.devices.insert_one({'_id': 'sintetico-a', 'name': 'PRIVATE NEW DEVICE'})
        await self.database.sessions.insert_one({'_id': 'a', 'metrics': {'ccc': -1}})
        self.assertEqual((await self.http.get('/api/public/rankings')).json(), before)
        await self.database.reviews.update_one({'_id': 'sintetico-a'}, {'$set': {'active': None, 'active_version': None}})
        after = (await self.http.get('/api/public/rankings')).json()
        self.assertEqual(after['total'], 16)
        self.assertNotIn('sintetico-a', str(after))
        self.assertEqual((await self.http.post('/api/public/rankings')).status_code, 405)


if __name__ == '__main__':
    unittest.main()

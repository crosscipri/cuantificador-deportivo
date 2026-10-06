import copy
import json
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from bson import ObjectId
from fastapi import HTTPException
from pydantic import ValidationError

from comparisons.models import WorkspaceSportSelection, WorkspaceNocturnalSelection
from comparisons.router import save_sport_selection, save_nocturnal_selection
from main import get_sport_aggregate_charts, get_nocturnal_hrv_aggregated, create_nocturnal_hrv_session, _ser_nocturnal_hrv
from nocturnal_dates import nocturnal_activity_date, nocturnal_session_name


class Cursor:
    def __init__(self, docs):
        self.docs = copy.deepcopy(docs)

    def sort(self, *_args):
        return self

    async def to_list(self, length=None):
        return self.docs

    def __aiter__(self):
        async def iterate():
            for doc in self.docs:
                yield doc
        return iterate()


class Collection:
    def __init__(self, docs):
        self.docs = docs

    def find(self, query, projection=None):
        def matches(doc):
            return all(doc.get(key) in value['$in'] if isinstance(value, dict)
                       else doc.get(key) == value for key, value in query.items())
        return Cursor([doc for doc in self.docs if matches(doc)])


class SelectedAggregationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.device_id = ObjectId()
        self.docs = []
        for index, ys in enumerate(([61, 71, 81], [62, 72, 82], [90, 70, 50])):
            self.docs.append({
                '_id': ObjectId(), 'device_id': self.device_id, 'sport_type': 'running',
                'session_name': f'Noche {index}',
                'metrics': {'mae': sum(abs(y-x) for x,y in zip([60,70,80],ys))/3, 'r': 1 if index < 2 else -1},
                'fc_data': {'reference': [60, 70, 80], 'device': ys},
                'windows': [{'tStart': '2026-09-20T23:30:00Z', 'rmssdPolar': x,
                             'rmssdFitbit': y, 'hrPolar': x, 'hrFitbit': y}
                            for x, y in zip([60, 70, 80], ys)],
            })
        # A session on another device must never leak into either aggregation.
        self.docs.append({**self.docs[2], '_id': ObjectId(), 'device_id': ObjectId()})
        self.database = SimpleNamespace(
            devices=SimpleNamespace(find_one=AsyncMock(return_value={'name': 'Reloj', 'reference_name': 'Polar'})),
            sessions=Collection(self.docs), nocturnal_hrv_sessions=Collection(self.docs))
        self.ids = ','.join(str(doc['_id']) for doc in self.docs[:2])

    async def test_sport_statistics_and_points_exclude_unselected_sessions(self):
        with patch('main.db', return_value=self.database):
            selected = await get_sport_aggregate_charts(str(self.device_id), 'running', self.ids)
            all_sessions = await get_sport_aggregate_charts(str(self.device_id), 'running')
        self.assertEqual(selected['session_count'], 2)
        self.assertEqual(len(selected['sessions']), 2)
        self.assertEqual(selected['global_stats']['bias'], 1.5)
        self.assertEqual(selected['balanced_by_session']['mae'], 1.5)
        self.assertEqual(all_sessions['session_count'], 3)
        self.assertNotEqual(selected['global_stats']['pearson_r'], all_sessions['global_stats']['pearson_r'])

    async def test_both_nocturnal_metrics_use_only_selected_nights(self):
        with patch('main.db', return_value=self.database):
            selected = await get_nocturnal_hrv_aggregated(str(self.device_id), self.ids)
            all_sessions = await get_nocturnal_hrv_aggregated(str(self.device_id))
            empty = await get_nocturnal_hrv_aggregated(str(self.device_id), '')
        self.assertEqual(selected['n_sessions'], 2)
        self.assertEqual(all_sessions['n_sessions'], 3)
        self.assertEqual(empty['n_sessions'], 0)
        for metric in ('rmssd', 'hr'):
            self.assertEqual(selected[metric]['stats']['n'], 6)
            self.assertEqual(selected[metric]['stats']['bias'], 1.5)
            self.assertEqual(selected[metric]['balanced_by_session']['mae'], 1.5)
            self.assertEqual([s['session_id'] for s in selected[metric]['by_session']], self.ids.split(','))
            self.assertNotEqual(selected[metric]['stats']['pearsonR'], all_sessions[metric]['stats']['pearsonR'])
            self.assertIsNone(empty[metric]['stats'])
            self.assertEqual(empty[metric]['by_session'], [])


class SelectionPersistenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.workspace_id = ObjectId()
        self.devices = [ObjectId(), ObjectId()]
        self.sessions = [{'_id': ObjectId(), 'device_id': self.devices[i % 2], 'sport_type': 'running'} for i in range(10)]
        self.workspace = {'_id': self.workspace_id, 'device_ids': list(map(str, self.devices))}
        self.collection = SimpleNamespace(find_one=AsyncMock(side_effect=lambda _: copy.deepcopy(self.workspace)),
                                          update_one=AsyncMock(return_value=SimpleNamespace(matched_count=1)))
        self.database = SimpleNamespace(comparison_workspaces=self.collection, sessions=Collection(self.sessions),
                                        nocturnal_hrv_sessions=Collection(self.sessions))
        self.request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=self.database)))

    async def test_multiple_sessions_per_device_are_saved_and_old_selection_is_valid(self):
        ids = [str(s['_id']) for s in self.sessions]
        result = await save_sport_selection(self.request, str(self.workspace_id), 'running', WorkspaceSportSelection(session_ids=ids))
        self.assertEqual(result['session_ids'], ids)
        self.assertEqual(self.collection.update_one.call_args.args[1]['$set']['sport_selections.running'], result)
        self.assertEqual(WorkspaceSportSelection(session_ids=ids[:2], reference_session_id=ids[0]).reference_session_id, ids[0])

    async def test_sport_mismatch_or_foreign_device_is_rejected(self):
        body = WorkspaceSportSelection(session_ids=[str(s['_id']) for s in self.sessions])
        with self.assertRaises(HTTPException):
            await save_sport_selection(self.request, str(self.workspace_id), 'cycling', body)
        self.sessions[0]['device_id'] = ObjectId()
        with self.assertRaises(HTTPException):
            await save_sport_selection(self.request, str(self.workspace_id), 'running', body)
        self.collection.update_one.assert_not_awaited()

    async def test_nocturnal_selection_persists_and_can_be_cleared(self):
        for ids in ([str(s['_id']) for s in self.sessions[:3]], []):
            result = await save_nocturnal_selection(self.request, str(self.workspace_id), WorkspaceNocturnalSelection(session_ids=ids))
            self.assertEqual(result['session_ids'], ids)
            self.assertEqual(self.collection.update_one.call_args.args[1]['$set']['nocturnal_selection'], result)

    async def test_nocturnal_selection_rejects_missing_or_foreign_sessions(self):
        with self.assertRaises(HTTPException):
            await save_nocturnal_selection(self.request, str(self.workspace_id), WorkspaceNocturnalSelection(session_ids=[str(ObjectId())]))
        self.sessions[0]['device_id'] = ObjectId()
        with self.assertRaises(HTTPException):
            await save_nocturnal_selection(self.request, str(self.workspace_id), WorkspaceNocturnalSelection(session_ids=[str(self.sessions[0]['_id'])]))
        self.collection.update_one.assert_not_awaited()

    def test_duplicate_sessions_are_rejected(self):
        sid = str(self.sessions[0]['_id'])
        for model in (WorkspaceSportSelection, WorkspaceNocturnalSelection):
            with self.assertRaises(ValidationError):
                model(session_ids=[sid, sid])


class NocturnalDateTests(unittest.IsolatedAsyncioTestCase):
    def test_legacy_dates_use_recording_start_and_preserve_custom_names(self):
        doc = {'_id': ObjectId(), 'created_at': datetime(2026, 10, 6), 'session_name': 'HRV Nocturno 06/10/2026 15:45',
               'windows': [{'tStart': '2026-09-21T02:00:00Z'}, {'tStart': '2026-09-20T23:30:00Z'}]}
        self.assertEqual(nocturnal_activity_date(doc), '2026-09-20')
        self.assertEqual(nocturnal_session_name(doc), 'HRV Nocturno 20/09/2026')
        serialized = _ser_nocturnal_hrv(copy.deepcopy(doc), include_windows=False)
        self.assertEqual(serialized['activity_date'], '2026-09-20')
        self.assertNotIn('windows', serialized)
        doc['session_name'] = 'Después de la carrera'
        self.assertEqual(nocturnal_session_name(doc), 'Después de la carrera')

    def test_local_calendar_day_and_missing_dates(self):
        doc = {'activity_date': '2026-09-21', 'windows': [{'tStart': '2026-09-20T22:30:00Z'}]}
        self.assertEqual(nocturnal_activity_date(doc), '2026-09-21')
        self.assertIsNone(nocturnal_activity_date({'created_at': datetime(2026, 10, 6)}))
        self.assertEqual(nocturnal_activity_date({'windows': [{'tsMs': 0}]}), '1970-01-01')

    async def test_upload_uses_recording_day_in_name(self):
        collection = SimpleNamespace(insert_one=AsyncMock(return_value=SimpleNamespace(inserted_id=ObjectId())))
        database = SimpleNamespace(devices=SimpleNamespace(find_one=AsyncMock(return_value={})), nocturnal_hrv_sessions=collection)
        database.devices.find_one.return_value = {'name': 'Reloj'}
        with patch('main.db', return_value=database), patch('main.ensure_archive_recordings', AsyncMock()):
            result = await create_nocturnal_hrv_session(
                str(ObjectId()), polar_rr_file=None, polar_hr_file=None, fitbit_hrv_file=None,
                fitbit_hr_file=None, huawei_file=None, secondary_source='fitbit', session_name='',
                windows_json=json.dumps([{'tStart': '2026-09-20T22:30:00Z'}]), summary_json='{}', settings_json='{}', activity_date='2026-09-21')
        self.assertEqual(result['session_name'], 'HRV Nocturno 21/09/2026')
        self.assertEqual(result['activity_date'], '2026-09-21')


if __name__ == '__main__':
    unittest.main()

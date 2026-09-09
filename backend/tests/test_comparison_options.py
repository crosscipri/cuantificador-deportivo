import unittest
from types import SimpleNamespace

from bson import ObjectId

from comparisons.router import options


class _Cursor:
    def __init__(self, docs=None):
        self.docs = docs or []

    def sort(self, *_args):
        return self

    def skip(self, *_args):
        return self

    def limit(self, *_args):
        return self

    async def to_list(self, *, length):
        return self.docs[:length]


class _Sessions:
    def __init__(self, docs=None):
        self.query = None
        self.projection = None
        self.docs = docs

    def find(self, query, projection):
        self.query = query
        self.projection = projection
        return _Cursor(self.docs)

    async def find_one(self, query, projection):
        self.hydration_projection = projection
        return next((doc for doc in (self.docs or []) if doc["_id"] == query["_id"]), None)


class _Devices:
    def __init__(self, ids):
        self.ids = ids

    async def distinct(self, field):
        assert field == "_id"
        return self.ids


class ComparisonOptionsTests(unittest.IsolatedAsyncioTestCase):
    async def test_default_listing_excludes_orphaned_sessions(self):
        device_ids = [ObjectId(), ObjectId()]
        sessions = _Sessions()
        db = SimpleNamespace(devices=_Devices(device_ids), sessions=sessions)
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))

        response = await options(request, offset=0, limit=100)

        self.assertEqual(sessions.query["device_id"], {"$in": device_ids})
        self.assertEqual(response, {"items": [], "has_more": False, "offset": 0})

    async def test_listing_pages_over_ids_and_hydrates_rows_individually(self):
        device_id = ObjectId()
        session_id = ObjectId()
        sessions = _Sessions([{
            "_id": session_id,
            "device_id": device_id,
            "session_name": "Test",
        }])
        db = SimpleNamespace(devices=None, sessions=sessions)
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))

        response = await options(request, device_id=str(device_id), offset=0, limit=100)

        self.assertEqual(sessions.projection, {"_id": 1})
        self.assertEqual(sessions.hydration_projection["session_name"], 1)
        self.assertEqual(response["items"], [{
            "id": str(session_id), "device_id": str(device_id), "session_name": "Test"
        }])

    async def test_explicit_device_filter_does_not_load_all_devices(self):
        device_id = ObjectId()
        sessions = _Sessions()
        db = SimpleNamespace(devices=None, sessions=sessions)
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))

        await options(request, device_id=str(device_id), offset=0, limit=100)

        self.assertEqual(sessions.query["device_id"], device_id)


if __name__ == "__main__":
    unittest.main()

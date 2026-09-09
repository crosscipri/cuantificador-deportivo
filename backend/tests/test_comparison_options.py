import unittest
from types import SimpleNamespace

from bson import ObjectId

from comparisons.router import options


class _Cursor:
    def sort(self, *_args):
        return self

    def skip(self, *_args):
        return self

    def limit(self, *_args):
        return self

    async def to_list(self, *, length):
        return []


class _Sessions:
    def __init__(self):
        self.query = None

    def find(self, query, _fields):
        self.query = query
        return _Cursor()


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

    async def test_explicit_device_filter_does_not_load_all_devices(self):
        device_id = ObjectId()
        sessions = _Sessions()
        db = SimpleNamespace(devices=None, sessions=sessions)
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))

        await options(request, device_id=str(device_id), offset=0, limit=100)

        self.assertEqual(sessions.query["device_id"], device_id)


if __name__ == "__main__":
    unittest.main()

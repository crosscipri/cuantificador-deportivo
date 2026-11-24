import asyncio
import unittest

from bson import ObjectId
from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport

from datetime import datetime

from comparisons.sport_validation import (SAMPLE_MAX, SERIES_MAX, build_sport_validation, router, sample_pairs,
                                          session_pairs, session_series)


def session(device_id, sport, ref, dev):
    return {"_id": ObjectId(), "device_id": device_id, "sport_type": sport,
            "fc_data": {"reference": ref, "device": dev, "time": list(range(len(ref))), "step": 1}}


class HelperTests(unittest.TestCase):
    def test_session_pairs_skips_missing_and_nan(self):
        doc = session(ObjectId(), "running", [100, None, 120, float("nan"), 130], [101, 110, None, 140, 131])
        self.assertEqual(session_pairs(doc), [(100.0, 101.0), (130.0, 131.0)])
        self.assertEqual(session_pairs({"fc_data": None}), [])

    def test_sample_is_capped(self):
        pairs = [(float(i), float(i) + 0.04) for i in range(10_001)]
        sample = sample_pairs(pairs)
        self.assertLessEqual(len(sample), SAMPLE_MAX)
        self.assertGreater(len(sample), SAMPLE_MAX * 0.8)
        self.assertEqual(sample[0], [0.0, 0.0])
        self.assertEqual(sample_pairs([(1, 2)] * 10), [[1, 2]] * 10)


class SeriesTests(unittest.TestCase):
    def test_series_is_bucketed_and_relative(self):
        n = 2000
        doc = {"fc_data": {"reference": [100.0] * n, "device": [101.0] * (n - 1) + [None],
                           "time": list(range(500, 500 + 2 * n, 2)), "step": 2}}
        s = session_series(doc)
        self.assertLessEqual(len(s["time"]), SERIES_MAX)
        self.assertEqual(len(s["time"]), len(s["reference"]))
        self.assertEqual(s["time"][0], 0.0)
        self.assertEqual(s["time"][1], 12.0)  # tramos de 6 puntos cada 2 s
        self.assertEqual(s["reference"][0], 100.0)
        self.assertEqual(s["device"][-1], 101.0)

    def test_series_without_time_uses_step_and_keeps_gaps(self):
        s = session_series({"fc_data": {"reference": [100, None, 102], "device": [None, None, 103], "step": 3}}, limit=10)
        self.assertEqual(s["time"], [0.0, 3.0, 6.0])
        self.assertEqual(s["reference"], [100.0, None, 102.0])
        self.assertEqual(s["device"], [None, None, 103.0])
        self.assertIsNone(session_series({"fc_data": {}}))


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.garmin, self.fitbit, self.biceps = ObjectId(), ObjectId(), ObjectId()
        self.devices = [{"_id": self.garmin, "name": "Garmin Cirqa"}, {"_id": self.fitbit, "name": "Fitbit Air"},
                        {"_id": self.biceps, "name": "FitBit Air Biceps"}]
        self.sessions = [
            session(self.garmin, "running", [100, 110, 120], [101, 111, 121]),
            session(self.garmin, "running", [130, 140, 150], [129, 141, 152]),
            session(self.garmin, "gym", [90, 100, 110], [90, 100, 110]),
            session(self.fitbit, "running", [100, 110, 120], [100, 110, 120]),
            session(self.biceps, "running", [100, 110, 120], [150, 90, 100]),
            session(self.fitbit, "swimming", [100, 110, 120], [100, 110, 120]),
            session(self.fitbit, "cycling", [], []),
        ]

    def test_pooled_by_sport_and_device_sorted_by_mae(self):
        out = build_sport_validation(self.devices, self.sessions)
        self.assertEqual(set(out["sports"]), {"running", "gym", "cycling", "combined"})
        running = out["sports"]["running"]
        self.assertEqual([d["name"] for d in running], ["Fitbit Air", "Garmin Cirqa"])
        garmin = running[1]
        self.assertEqual(garmin["sessions"], 2)
        self.assertEqual(garmin["n"], 6)
        self.assertAlmostEqual(garmin["mae"], 7 / 6, places=4)
        self.assertAlmostEqual(garmin["bias"], 5 / 6, places=4)
        self.assertEqual(len(garmin["sample"]), 6)
        self.assertEqual(running[0]["r"], 1.0)
        self.assertEqual(out["sports"]["gym"][0]["mae"], 0.0)
        self.assertEqual(out["sports"]["cycling"], [])

    def test_combined_pools_the_three_sports(self):
        out = build_sport_validation(self.devices, self.sessions)
        combined = {d["name"]: d for d in out["sports"]["combined"]}
        self.assertEqual(set(combined), {"Garmin Cirqa", "Fitbit Air"})
        garmin = combined["Garmin Cirqa"]
        self.assertEqual(garmin["sessions"], 3)
        self.assertEqual(garmin["sessions_by_sport"], {"running": 2, "gym": 1})
        self.assertEqual(garmin["n"], 9)
        self.assertAlmostEqual(garmin["mae"], 7 / 9, places=4)
        self.assertEqual(combined["Fitbit Air"]["sessions"], 1)  # natación y sesión vacía fuera
        self.assertEqual(out["sport_labels"]["combined"], "Los 3 deportes combinados")
        self.assertNotIn("sessions_by_sport", out["sports"]["running"][0])

    def test_session_means_and_series_per_device(self):
        self.sessions[0]["activity_date"] = datetime(2026, 9, 2, 18, 0)
        self.sessions[1]["activity_date"] = datetime(2026, 9, 1, 18, 0)
        self.sessions[1]["session_name"] = "Series"
        out = build_sport_validation(self.devices, self.sessions)
        garmin = [d for d in out["sports"]["running"] if d["name"] == "Garmin Cirqa"][0]
        means = garmin["session_means"]
        self.assertEqual([p["date"][:10] for p in means["points"]], ["2026-09-01", "2026-09-02"])
        self.assertEqual(means["points"][0]["name"], "Series")
        self.assertAlmostEqual(means["points"][0]["reference"], 140.0)
        self.assertAlmostEqual(means["points"][0]["device"], 140.67, places=2)
        self.assertEqual(means["n"], 2)
        self.assertIsNone(means["r"])  # con 2 sesiones no hay r
        self.assertEqual(len(garmin["series"]), 2)
        self.assertEqual(garmin["series"][0]["time"], [0.0, 1.0, 2.0])
        self.assertEqual(garmin["series"][0]["device"], [129.0, 141.0, 152.0])
        combined = [d for d in out["sports"]["combined"] if d["name"] == "Garmin Cirqa"][0]
        self.assertNotIn("series", combined)
        self.assertEqual(len(combined["session_means"]["points"]), 3)
        self.assertEqual({p["sport"] for p in combined["session_means"]["points"]}, {"running", "gym"})
        self.assertFalse({"loa_l", "loa_u", "ccc"} & set(means))

    def test_excludes_biceps_and_unknown_sports(self):
        out = build_sport_validation(self.devices, self.sessions)
        names = {d["name"] for items in out["sports"].values() for d in items}
        self.assertNotIn("FitBit Air Biceps", names)
        self.assertNotIn("swimming", out["sports"])

    def test_only_pearson_no_agreement_limits(self):
        item = build_sport_validation(self.devices, self.sessions)["sports"]["running"][1]
        self.assertTrue({"n", "r", "r2", "mae", "bias", "slope", "intercept", "sessions", "sample"} <= set(item))
        self.assertFalse({"loa_l", "loa_u", "ccc", "icc"} & set(item))


class FakeCursor:
    def __init__(self, docs):
        self.docs = docs

    def __aiter__(self):
        self._it = iter(self.docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class FakeCollection:
    def __init__(self, docs):
        self.docs = docs
        self.calls = []

    def find(self, *args, **kwargs):
        self.calls.append(args)
        return FakeCursor(self.docs)


class EndpointTests(unittest.TestCase):
    def test_endpoint_reads_only(self):
        d = ObjectId()
        sessions = FakeCollection([session(d, "cycling", [100, 110, 120], [101, 112, 119])])
        app = FastAPI()
        app.include_router(router)
        app.state.db = type("Db", (), {"devices": FakeCollection([{"_id": d, "name": "Garmin Cirqa"}]), "sessions": sessions})()

        async def call():
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                return await client.get("/api/sport-validation")

        response = asyncio.run(call())
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["sports"]["cycling"][0]["name"], "Garmin Cirqa")
        self.assertEqual(body["sports"]["cycling"][0]["n"], 3)
        projection = sessions.calls[0][1]
        self.assertNotIn("device_file_bytes", projection)


if __name__ == "__main__":
    unittest.main()

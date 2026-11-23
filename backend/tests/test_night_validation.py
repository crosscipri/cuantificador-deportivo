import asyncio
import unittest

from bson import ObjectId
from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport

from comparisons.night_validation import build_validation, pair_stats, router


def windows(rows):
    base = 1788123600  # 2026-08-30T21:00:00Z
    out = []
    for i, (hr_ref, hr_dev, rm_ref, rm_dev) in enumerate(rows):
        out.append({"tsMs": (base + i * 300) * 1000, "hrPolar": hr_ref, "hrFitbit": hr_dev,
                    "rmssdPolar": rm_ref, "rmssdFitbit": rm_dev})
    return out


class PairStatsTests(unittest.TestCase):
    def test_perfect_line(self):
        s = pair_stats([(1, 3), (2, 5), (3, 7)])
        self.assertEqual(s["n"], 3)
        self.assertEqual(s["r"], 1.0)
        self.assertEqual(s["slope"], 2.0)
        self.assertEqual(s["intercept"], 1.0)
        self.assertEqual(s["bias"], 3.0)
        self.assertEqual(s["mae"], 3.0)

    def test_ignores_missing_and_needs_three_points_for_r(self):
        s = pair_stats([(1, None), (None, 2), (1, 2), (2, 3)])
        self.assertEqual(s["n"], 2)
        self.assertIsNone(s["r"])
        self.assertEqual(s["mae"], 1.0)

    def test_empty(self):
        self.assertEqual(pair_stats([])["n"], 0)

    def test_no_agreement_limits(self):
        self.assertFalse({"loa_l", "loa_u", "lowerLoa", "upperLoa"} & set(pair_stats([(1, 2), (2, 2), (3, 5)])))


class BuildValidationTests(unittest.TestCase):
    def setUp(self):
        self.a, self.b, self.c = ObjectId(), ObjectId(), ObjectId()
        self.devices = [{"_id": self.a, "name": "Garmin Forerunner 70"}, {"_id": self.b, "name": "Fitbit Air"},
                        {"_id": self.c, "name": "Sin noches"}]
        self.sessions = [
            {"_id": ObjectId(), "device_id": self.a, "windows": windows([(50, 51, 40, 42), (52, 52, 45, None), (54, 56, 50, 49)])},
            {"_id": ObjectId(), "device_id": self.a, "windows": windows([(48, 47, 60, 58), (46, 46, 70, 72), (45, 47, 65, 66)])},
            {"_id": ObjectId(), "device_id": self.b, "windows": windows([(50, 50, 40, 40), (55, 55, 50, 50), (60, 60, 60, 60)])},
        ]

    def test_groups_by_device_sorted_and_skips_devices_without_nights(self):
        out = build_validation(self.devices, self.sessions)
        self.assertEqual([d["name"] for d in out["devices"]], ["Fitbit Air", "Garmin Forerunner 70"])
        self.assertEqual(out["window_seconds"], 300)

    def test_pooled_nightly_and_coverage(self):
        garmin = build_validation(self.devices, self.sessions)["devices"][1]
        self.assertEqual(garmin["hr"]["n"], 6)
        self.assertEqual(garmin["hr"]["nights"], 2)
        self.assertEqual(garmin["rmssd"]["n"], 5)
        self.assertAlmostEqual(garmin["rmssd"]["coverage"], 5 / 6, places=4)
        self.assertEqual(len(garmin["hr"]["nightly"]["points"]), 2)
        self.assertEqual(garmin["hr"]["nightly"]["n"], 2)
        self.assertIsNone(garmin["hr"]["nightly"]["r"])
        self.assertAlmostEqual(garmin["hr"]["nightly"]["points"][0]["reference"], 52.0, places=3)
        night = garmin["rmssd"]["series"][0]
        self.assertEqual(night["time"], [0, 300, 600])
        self.assertIsNone(night["device"][1])
        self.assertNotIn("pairs", night)

    def test_identical_device_is_perfect(self):
        fitbit = build_validation(self.devices, self.sessions)["devices"][0]
        self.assertEqual(fitbit["hr"]["r"], 1.0)
        self.assertEqual(fitbit["hr"]["mae"], 0.0)


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

    def find(self, *_args, **_kwargs):
        return FakeCursor(self.docs)


class EndpointTests(unittest.TestCase):
    def test_endpoint_is_read_only_and_returns_devices(self):
        d = ObjectId()
        app = FastAPI()
        app.include_router(router)
        app.state.db = type("Db", (), {
            "devices": FakeCollection([{"_id": d, "name": "Garmin Cirqa"}]),
            "nocturnal_hrv_sessions": FakeCollection([{"_id": ObjectId(), "device_id": d,
                                                       "windows": windows([(50, 51, 40, 42), (52, 52, 45, 44), (54, 56, 50, 49)])}]),
        })()

        async def call():
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                return await client.get("/api/night-validation")

        response = asyncio.run(call())
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["devices"][0]["name"], "Garmin Cirqa")
        self.assertEqual(body["devices"][0]["hr"]["n"], 3)


if __name__ == "__main__":
    unittest.main()

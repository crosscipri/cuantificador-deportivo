import asyncio
import math
import unittest
from pathlib import Path

from bson import ObjectId
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from comparisons.precision_price import (
    EXCLUDED_NAMES,
    FEW,
    FORMULA,
    MAE_MAX_REST_HR,
    MAE_MAX_RMSSD,
    MAE_MAX_SPORT_HR,
    PRICES_PATH,
    R0,
    build_precision_price,
    collect_precision_price,
    load_prices,
    mae_score,
    metric_score,
    pareto_flags,
    r_score,
    router,
)
from comparisons.sport_validation import build_sport_validation


def _prices(extra=None):
    catalog = {
        "garmin cirqa": {"name": "Garmin Cirqa", "price": 200.0, "shop": "Decathlon",
                         "label": "Decathlon · CIRQA", "checked_at": "2026-10-14", "source": "test"},
        "fitbit air": {"name": "Fitbit Air", "price": 100.0, "shop": "Google Store",
                       "label": "Google Store · Fitbit Air", "checked_at": "2026-10-14", "source": "test"},
        "huawei watch fit 5 pro": {"name": "Huawei Watch Fit 5 Pro", "price": 300.0, "shop": "PcComponentes",
                                   "label": "PcComponentes · Fit 5 Pro", "checked_at": "2026-10-14", "source": "test"},
    }
    if extra:
        catalog.update(extra)
    return {"version": "prices-test", "checked_at": "2026-10-14", "currency": "EUR",
            "rule": "test", "source": {"file": "test"}, "by_name": catalog}


def _sport_item(device_id, name, mae, r, sessions=9, n=1000, by_sport=None):
    return {"device_id": str(device_id), "name": name, "sessions": sessions, "n": n,
            "mae": mae, "r": r, "sessions_by_sport": by_sport or {"running": sessions}}


def _night_kind(mae, r, nights=5, n=100):
    return {"n": n, "r": r, "mae": mae, "nights": nights, "windows": n, "coverage": 1,
            "r2": r * r if r is not None else None, "bias": 0, "slope": 1, "intercept": 0}


def _night_item(device_id, name, hr_mae, hr_r, rm_mae, rm_r, nights=5):
    return {"device_id": str(device_id), "name": name, "reference": "Polar",
            "hr": _night_kind(hr_mae, hr_r, nights), "rmssd": _night_kind(rm_mae, rm_r, nights)}


class FormulaTests(unittest.TestCase):
    def test_constants_match_the_mockup(self):
        self.assertEqual(R0, 0.50)
        self.assertEqual(MAE_MAX_SPORT_HR, 15.0)
        self.assertEqual(MAE_MAX_REST_HR, 5.0)
        self.assertEqual(MAE_MAX_RMSSD, 30.0)
        self.assertEqual(FORMULA["weights"], {"mae": 0.5, "r": 0.5})
        self.assertEqual(FEW, 5)

    def test_mae_and_r_scores_are_fixed_not_relative(self):
        self.assertAlmostEqual(mae_score(0, 15), 100)
        self.assertAlmostEqual(mae_score(15, 15), 0)
        self.assertAlmostEqual(mae_score(30, 15), 0)
        self.assertAlmostEqual(r_score(1.0), 100)
        self.assertAlmostEqual(r_score(0.50), 0)
        self.assertAlmostEqual(r_score(0.25), 0)
        # Independiente del grupo: la misma entrada da la misma nota.
        self.assertAlmostEqual(metric_score(1.5475, 0.995, MAE_MAX_SPORT_HR), 94.3416666666, places=4)

    def test_mockup_sport_anchors(self):
        # Cifras de la maqueta (combined de /api/sport-validation).
        anchors = [
            ("Huawei Watch Fit 5 Pro", 1.5475, 0.995, 94.34),
            ("Garmin Forerunner 170", 2.2863, 0.9869, 91.07),
            ("Fitbit Air", 2.9359, 0.9826, 88.47),
            ("Realme Watch 5", 12.4124, 0.7837, 37.00),
        ]
        for name, mae, r, expected in anchors:
            self.assertAlmostEqual(metric_score(mae, r, MAE_MAX_SPORT_HR), expected, places=2, msg=name)


class ParetoTests(unittest.TestCase):
    def test_frontier_is_not_dominated(self):
        rows = [
            {"name": "barato-flojo", "price": 50, "score": 40},
            {"name": "medio", "price": 100, "score": 80},
            {"name": "caro-preciso", "price": 200, "score": 95},
            {"name": "caro-peor", "price": 250, "score": 70},  # dominado por medio y por caro-preciso
            {"name": "igual-de-caro-peor", "price": 200, "score": 90},  # dominado por caro-preciso
        ]
        flags = pareto_flags(rows)
        named = {r["name"]: flags[id(r)] for r in rows}
        self.assertTrue(named["barato-flojo"])
        self.assertTrue(named["medio"])
        self.assertTrue(named["caro-preciso"])
        self.assertFalse(named["caro-peor"])
        self.assertFalse(named["igual-de-caro-peor"])


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.air, self.huawei, self.orphan = "air-id", "huawei-id", "orphan-id"
        self.sport = {"reference": "Polar H10", "sports": {"combined": [
            _sport_item(self.huawei, "Huawei Watch Fit 5 Pro", 1.5475, 0.995, 9),
            _sport_item(self.air, "Fitbit Air", 2.9359, 0.9826, 24),
            _sport_item(self.orphan, "Dispositivo Sin Precio", 2.0, 0.99, 8),
            _sport_item("biceps-id", "FitBit Air Biceps", 1.0, 0.99, 2),
        ]}}
        self.night = {"reference": "Polar", "devices": [
            _night_item(self.air, "Fitbit Air", 0.9788, 0.9373, 6.9307, 0.9659, 5),
            _night_item(self.huawei, "Huawei Watch Fit 5 Pro", 1.3764, 0.9724, 13.4379, 0.854, 4),
        ]}

    def test_builds_three_views_and_lists_missing_price(self):
        out = build_precision_price(self.sport, self.night, _prices())
        sports = {d["name"]: d for d in out["sports"]}
        self.assertEqual(set(sports), {"Huawei Watch Fit 5 Pro", "Fitbit Air"})
        self.assertAlmostEqual(sports["Huawei Watch Fit 5 Pro"]["score"], 94.34, places=2)
        self.assertTrue(sports["Huawei Watch Fit 5 Pro"]["frontier"])
        self.assertTrue(sports["Fitbit Air"]["frontier"])
        self.assertEqual(out["missing_price"], [{"device_id": self.orphan, "name": "Dispositivo Sin Precio"}])
        self.assertNotIn("FitBit Air Biceps", {d["name"] for d in out["sports"]})
        self.assertNotIn("Dispositivo Sin Precio", {d["name"] for d in out["sports"]})
        # Final: ambos tienen deporte y noche.
        final = {d["name"]: d for d in out["final"]}
        self.assertEqual(set(final), {"Fitbit Air", "Huawei Watch Fit 5 Pro"})
        self.assertTrue(final["Fitbit Air"]["frontier"])
        self.assertFalse(final["Huawei Watch Fit 5 Pro"]["frontier"])
        self.assertTrue(out["night"][0]["name"] == "Fitbit Air" or any(d["few"] for d in out["night"]))
        huawei_night = next(d for d in out["night"] if d["name"].startswith("Huawei"))
        self.assertTrue(huawei_night["few"])
        self.assertEqual(huawei_night["nights"], 4)

    def test_missing_night_is_listed_and_left_out_of_final(self):
        sport = {"reference": "Polar H10", "sports": {"combined": [
            _sport_item(self.air, "Fitbit Air", 2.9359, 0.9826, 24),
            _sport_item("fr265", "Garmin Forerunner 265", 3.7075, 0.9703, 18),
        ]}}
        prices = _prices({"garmin forerunner 265": {
            "name": "Garmin Forerunner 265", "price": 359.99, "shop": "Decathlon",
            "label": "Decathlon · Forerunner 265", "checked_at": "2026-10-14", "source": "test",
        }})
        out = build_precision_price(sport, {"devices": [_night_item(self.air, "Fitbit Air", 1, 0.9, 8, 0.9, 5)]}, prices)
        self.assertEqual(out["missing_night"], [{"device_id": "fr265", "name": "Garmin Forerunner 265"}])
        self.assertEqual([d["name"] for d in out["final"]], ["Fitbit Air"])
        self.assertIn("Garmin Forerunner 265", {d["name"] for d in out["sports"]})

    def test_biceps_is_excluded(self):
        self.assertIn("fitbit air biceps", EXCLUDED_NAMES)


class CatalogTests(unittest.TestCase):
    def test_versioned_prices_file_has_the_nine_devices(self):
        prices = load_prices(PRICES_PATH)
        self.assertEqual(prices["checked_at"], "2026-10-14")
        names = {v["name"] for v in prices["by_name"].values()}
        expected = {
            "Realme Watch 5", "Fitbit Air", "Garmin Cirqa", "Garmin Forerunner 70",
            "Garmin Forerunner 170", "Huawei Watch Fit 5 Pro", "Garmin Forerunner 265",
            "Ultrahuman Ring Air", "Samsung Galaxy Watch 9",
        }
        self.assertEqual(names, expected)
        self.assertEqual(prices["by_name"]["fitbit air"]["price"], 99.99)
        self.assertEqual(prices["by_name"]["realme watch 5"]["price"], 54.9)
        self.assertEqual(prices["by_name"]["ultrahuman ring air"]["price"], 379.0)
        self.assertEqual(prices["by_name"]["samsung galaxy watch 9"]["price"], 389.0)
        self.assertTrue(PRICES_PATH.is_file())
        self.assertTrue(str(PRICES_PATH).endswith("backend/data/prices.json"))


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
        self.calls.append((args, kwargs))
        return FakeCursor(self.docs)


class EndpointTests(unittest.TestCase):
    def test_endpoint_is_read_only_and_returns_the_three_views(self):
        device_id = ObjectId()
        devices = FakeCollection([{"_id": device_id, "name": "Fitbit Air"}])
        sessions = FakeCollection([{
            "_id": ObjectId(), "device_id": device_id, "sport_type": "running",
            "fc_data": {"reference": [100, 110, 120], "device": [101, 111, 119]},
        }])
        nights = FakeCollection([])
        app = FastAPI()
        app.include_router(router)
        app.state.db = type("Db", (), {
            "devices": devices,
            "sessions": sessions,
            "nocturnal_hrv_sessions": nights,
        })()

        async def call():
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                return await client.get("/api/precision-price")

        response = asyncio.run(call())
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["version"], "precision-price-1")
        self.assertIn("sports", body)
        self.assertIn("night", body)
        self.assertIn("final", body)
        self.assertIn("missing_price", body)
        self.assertEqual(body["sports"][0]["name"], "Fitbit Air")
        self.assertEqual(body["sports"][0]["price"], 99.99)
        self.assertFalse({"loa_l", "loa_u", "ccc"} & set(body["sports"][0]))
        # Proyecciones de solo lectura (sin bytes de fichero).
        session_args = sessions.calls[0][0]
        self.assertGreaterEqual(len(session_args), 2)
        self.assertNotIn("device_file_bytes", session_args[1])
        night_args = nights.calls[0][0]
        self.assertEqual(set(night_args[1].keys()), {"windows", "device_id"})


if __name__ == "__main__":
    unittest.main()

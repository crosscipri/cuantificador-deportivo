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
    find_offer,
    mae_score,
    metric_score,
    norm_name,
    pareto_flags,
    r_score,
    router,
    summarize_sessions,
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


class NameMatchingTests(unittest.TestCase):
    def test_norm_name_ignores_case_accents_spaces_and_punctuation(self):
        self.assertEqual(norm_name("  Fitbit   AIR "), "fitbit air")
        self.assertEqual(norm_name("Garmin\u00a0Forerunner-265"), "garmin forerunner 265")
        self.assertEqual(norm_name("Galaxy Watch\u00e9 9"), "galaxy watche 9")

    def test_find_offer_by_id_then_name_alias_and_brandless(self):
        prices = _prices({"samsung galaxy watch 9": {"name": "Samsung Galaxy Watch 9", "price": 389.0,
                                                     "device_id": "w9", "shop": "x", "label": "x",
                                                     "checked_at": "2026-10-14", "source": "t"}})
        prices["by_id"] = {"w9": prices["by_name"]["samsung galaxy watch 9"]}
        prices["by_alias"] = {norm_name("GW9 BT"): prices["by_name"]["fitbit air"]}
        self.assertEqual(find_offer(prices, "w9", "Cualquier cosa")[1], "id")
        offer, how = find_offer(prices, "z", "  FITBIT  air ")
        self.assertEqual((offer["name"], how), ("Fitbit Air", "nombre"))
        self.assertEqual(find_offer(prices, "z", "gw9-bt")[1], "alias")
        offer, how = find_offer(prices, "z", "Galaxy Watch 9")
        self.assertEqual((offer["name"], how), ("Samsung Galaxy Watch 9", "nombre sin marca"))
        # Sin coincidencias aproximadas: otro modelo no hereda el precio.
        self.assertEqual(find_offer(prices, "z", "Garmin Forerunner 70"), (None, None))
        self.assertEqual(find_offer(prices, "z", "Fitbit Air Biceps"), (None, None))

    def test_case_and_space_variants_still_get_their_price_in_the_charts(self):
        sport = {"sports": {"combined": [_sport_item("a", "  FITBIT  air ", 2.9, 0.98, 12)]}}
        out = build_precision_price(sport, {"devices": []}, _prices())
        self.assertEqual([d["name"] for d in out["sports"]], ["  FITBIT  air "])
        self.assertEqual(out["sports"][0]["price"], 100.0)
        self.assertEqual(out["sports"][0]["price_match"], "nombre")

    def test_sport_and_night_are_joined_by_device_id_not_by_name(self):
        # Mismo modelo con nombre distinto en deporte y noche, y dos dispositivos con el mismo nombre.
        sport = {"sports": {"combined": [
            _sport_item("a", "Fitbit Air", 2.9, 0.98, 12),
            _sport_item("b", "Fitbit Air", 3.5, 0.97, 7),
        ]}}
        night = {"devices": [_night_item("a", "FITBIT AIR", 1, 0.95, 7, 0.95, 6)]}
        out = build_precision_price(sport, night, _prices())
        self.assertEqual({d["device_id"] for d in out["sports"]}, {"a", "b"})
        self.assertEqual([d["device_id"] for d in out["final"]], ["a"])
        self.assertEqual([m["device_id"] for m in out["missing_night"]], ["b"])
        self.assertEqual(out["diagnostics"]["duplicate_names"], [["Fitbit Air", "Fitbit Air"]])

    def test_prices_json_ids_match_verified_offers(self):
        prices = load_prices(PRICES_PATH)
        self.assertEqual(len(prices["by_id"]), 9)
        self.assertEqual(prices["by_id"]["6a25a8ce3216ad99131e0c1b"]["name"], "Fitbit Air")
        # El Biceps (excluido) no hereda el precio del Fitbit Air.
        self.assertIsNone(prices["by_id"].get("6a8ecc59e39b7e25dfc44ef3"))


class LeftOutTests(unittest.TestCase):
    def setUp(self):
        self.devices = [
            {"id": "air", "name": "Fitbit Air"},
            {"id": "whoop", "name": "Whoop 5.0"},
            {"id": "edge", "name": "Fitbit Edge"},
            {"id": "ultra", "name": "Galaxy Watch Ultra 2"},
            {"id": "fr265", "name": "Garmin Forerunner 265"},
            {"id": "bic", "name": "FitBit Air Biceps"},
            {"id": "rm", "name": "Realme Watch 5"},
        ]
        self.sport = {"sports": {"combined": [
            _sport_item("air", "Fitbit Air", 2.9, 0.98, 12),
            _sport_item("whoop", "Whoop 5.0", 3.0, 0.97, 4),
            _sport_item("fr265", "Garmin Forerunner 265", 3.7, 0.97, 18),
            _sport_item("rm", "Realme Watch 5", 12.4, 0.78, 6),
        ]}}
        night_rm = _night_item("rm", "Realme Watch 5", 1, 0.9, 8, 0.9, 5)
        night_rm["rmssd"] = _night_kind(None, None, 0, 0)
        night_rm["rmssd"]["n"] = 0
        self.night = {"devices": [_night_item("air", "Fitbit Air", 1, 0.9, 8, 0.9, 5), night_rm]}
        self.stats = {
            "air": {"total": 12, "valid_sport": 12, "other_sport": {}, "no_pairs": 0},
            "whoop": {"total": 4, "valid_sport": 4, "other_sport": {}, "no_pairs": 0},
            "edge": {"total": 0, "valid_sport": 0, "other_sport": {}, "no_pairs": 0},
            "ultra": {"total": 3, "valid_sport": 0, "other_sport": {"swimming": 2, "(sin deporte)": 1}, "no_pairs": 0},
            "fr265": {"total": 18, "valid_sport": 18, "other_sport": {}, "no_pairs": 0},
            "rm": {"total": 6, "valid_sport": 6, "other_sport": {}, "no_pairs": 0},
        }
        self.out = build_precision_price(
            self.sport, self.night,
            _prices({"garmin forerunner 265": {"name": "Garmin Forerunner 265", "price": 359.99, "shop": "Decathlon",
                                                "label": "x", "checked_at": "2026-10-14", "source": "t"},
                     "realme watch 5": {"name": "Realme Watch 5", "price": 54.9, "shop": "MediaMarkt",
                                        "label": "x", "checked_at": "2026-10-14", "source": "t"}}),
            devices=self.devices, session_stats=self.stats, night_counts={"air": 6, "rm": 5, "edge": 2},
        )

    def reasons(self, view):
        return {d["name"]: d["reasons"] for d in self.out["left_out"][view]}

    def test_every_device_not_plotted_is_listed_with_reasons(self):
        sports = self.reasons("sports")
        self.assertEqual(set(sports), {"Whoop 5.0", "Fitbit Edge", "Galaxy Watch Ultra 2"})
        self.assertEqual(sports["Whoop 5.0"], ["sin precio verificado"])
        self.assertEqual(sports["Fitbit Edge"], ["sin sesiones de entrenamiento", "sin precio verificado"])
        self.assertTrue(sports["Galaxy Watch Ultra 2"][0].startswith("3 sesiones sin deporte válido"))
        self.assertIn("swimming (2)", sports["Galaxy Watch Ultra 2"][0])
        self.assertNotIn("FitBit Air Biceps", sports)  # excluido por código, no se lista

    def test_night_reasons_distinguish_no_nights_no_windows_and_missing_hrv(self):
        night = self.reasons("night")
        self.assertEqual(night["Fitbit Edge"], ["2 noches guardadas sin ventanas válidas de FC ni RMSSD", "sin precio verificado"])
        self.assertEqual(night["Garmin Forerunner 265"], ["sin noches guardadas"])
        self.assertEqual(night["Whoop 5.0"], ["sin noches guardadas", "sin precio verificado"])
        self.assertEqual(night["Realme Watch 5"], ["sin HRV (RMSSD) nocturna: la nota nocturna necesita las dos"])

    def test_final_reasons_name_the_missing_part(self):
        final = self.reasons("final")
        self.assertEqual(set(final), {"Garmin Forerunner 265", "Whoop 5.0", "Fitbit Edge", "Galaxy Watch Ultra 2", "Realme Watch 5"})
        self.assertEqual(final["Garmin Forerunner 265"], ["sin nota nocturna"])
        self.assertEqual(final["Whoop 5.0"], ["sin nota nocturna", "sin precio verificado"])
        self.assertEqual(final["Galaxy Watch Ultra 2"], ["sin nota de deporte", "sin nota nocturna", "sin precio verificado"])

    def test_needs_price_lists_devices_with_and_without_data(self):
        needs = {d["name"]: d["has_data"] for d in self.out["needs_price"]}
        self.assertEqual(needs, {"Whoop 5.0": True, "Fitbit Edge": False, "Galaxy Watch Ultra 2": False})
        self.assertEqual([m["name"] for m in self.out["missing_price"]], ["Whoop 5.0"])

    def test_without_device_list_still_explains_devices_with_data(self):
        out = build_precision_price(self.sport, self.night, _prices())
        self.assertIn("Whoop 5.0", {d["name"] for d in out["left_out"]["sports"]})
        self.assertEqual(out["diagnostics"]["devices_in_db"], 4)

    def test_duplicate_names_are_reported(self):
        devices = self.devices + [{"id": "air2", "name": "fitbit  AIR"}]
        out = build_precision_price(self.sport, self.night, _prices(), devices=devices)
        self.assertEqual(out["diagnostics"]["duplicate_names"], [["Fitbit Air", "fitbit  AIR"]])

    def test_summarize_sessions_counts_sports_unlinked_and_empty_pairs(self):
        devices = [{"_id": "d1", "name": "A"}]
        rows = [{"_id": {"d": "d1", "s": "running"}, "n": 3}, {"_id": {"d": "d1", "s": "swim"}, "n": 2},
                {"_id": {"d": "d1", "s": None}, "n": 1}, {"_id": {"d": None, "s": "running"}, "n": 4}]
        sessions = [{"device_id": "d1", "fc_data": {"reference": [1, 2], "device": [1, 2]}},
                    {"device_id": "d1", "fc_data": {"reference": [], "device": []}}]
        stats, diag = summarize_sessions(devices, sessions, rows)
        self.assertEqual(stats["d1"], {"total": 6, "valid_sport": 3, "other_sport": {"swim": 2, "(sin deporte)": 1}, "no_pairs": 1})
        self.assertEqual(diag, {"sessions_unlinked": 4, "sessions_without_valid_sport": {"swim": 2, "(sin deporte)": 1}})
        self.assertEqual(summarize_sessions(devices, sessions, None), (None, {}))


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

    def aggregate(self, pipeline):
        self.pipeline = pipeline
        return FakeCursor([{"_id": {"d": d.get("device_id"), "s": d.get("sport_type")}, "n": 1} for d in self.docs])


class EndpointTests(unittest.TestCase):
    def test_endpoint_survives_a_failing_aggregate(self):
        device_id = ObjectId()
        sessions = FakeCollection([])
        sessions.aggregate = lambda pipeline: (_ for _ in ()).throw(RuntimeError("sin permiso"))
        app = FastAPI()
        app.include_router(router)
        app.state.db = type("Db", (), {
            "devices": FakeCollection([{"_id": device_id, "name": "Fitbit Air"}]),
            "sessions": sessions, "nocturnal_hrv_sessions": FakeCollection([]),
        })()

        async def call():
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                return await client.get("/api/precision-price")

        response = asyncio.run(call())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["left_out"]["sports"][0]["reasons"],
                         ["sin sesiones de running, gym o ciclismo con FC emparejada"])

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
        # El recuento por deporte es un $group de solo lectura.
        self.assertEqual([list(stage) for stage in sessions.pipeline], [["$group"]])
        self.assertEqual(body["left_out"]["sports"], [])
        self.assertEqual(body["left_out"]["night"][0]["reasons"], ["sin noches guardadas"])
        self.assertEqual(body["diagnostics"]["devices_in_db"], 1)


if __name__ == "__main__":
    unittest.main()

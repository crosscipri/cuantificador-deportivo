"""Precisión-precio: nota de precisión (MAE y r) frente al precio verificado.

Solo lectura. Reutiliza las estadísticas agrupadas de la validación por deporte
(clave ``combined``: carrera, fuerza y ciclismo juntos) y de la validación
nocturna (FC en reposo y RMSSD). Aplica una fórmula con constantes fijas, no
relativas al grupo, y lee los precios de ``backend/data/prices.json``.

No calcula límites de acuerdo ni Bland-Altman. Si un dispositivo no tiene
precio, queda fuera de las gráficas y se lista en ``missing_price``.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from .night_validation import build_validation
from .sport_validation import SPORTS, build_sport_validation

router = APIRouter(prefix="/api", tags=["precision price"])

VERSION = "precision-price-1"
FEW = 5
EXCLUDED_NAMES = {"fitbit air biceps"}
PRICES_PATH = Path(__file__).resolve().parent.parent / "data" / "prices.json"

# Constantes fijas (no se reescalan al añadir dispositivos).
R0 = 0.50
WEIGHT_MAE = 0.5
WEIGHT_R = 0.5
MAE_MAX_SPORT_HR = 15.0  # lpm; un error de 15 lpm ya no sirve para zonas
MAE_MAX_REST_HR = 5.0    # lpm; el rango nocturno es estrecho
MAE_MAX_RMSSD = 30.0     # ms; frente a valores típicos de 20-80 ms
NIGHT_WEIGHT_HR = 0.5
NIGHT_WEIGHT_HRV = 0.5

FORMULA = {
    "version": VERSION,
    "weights": {"mae": WEIGHT_MAE, "r": WEIGHT_R},
    "r0": R0,
    "mae_max": {
        "sport_hr_bpm": MAE_MAX_SPORT_HR,
        "rest_hr_bpm": MAE_MAX_REST_HR,
        "rmssd_ms": MAE_MAX_RMSSD,
    },
    "night_weights": {"rest_hr": NIGHT_WEIGHT_HR, "hrv": NIGHT_WEIGHT_HRV},
    "description": (
        "nota_MAE = 100 · max(0, 1 − MAE / MAE_max); "
        "nota_r = 100 · max(0, (r − r0) / (1 − r0)); "
        "nota = 0,5 · nota_MAE + 0,5 · nota_r. "
        "Nota nocturna = media de FC en reposo y HRV. "
        "Nota final = media de deporte y noche, solo si hay ambas. "
        "Índice de valor = nota / precio_€ · 100."
    ),
}


def _round(value, digits=4):
    if value is None:
        return None
    return round(float(value), digits)


def mae_score(mae, mae_max):
    if mae is None or mae_max <= 0:
        return None
    return 100.0 * max(0.0, 1.0 - float(mae) / mae_max)


def r_score(r, r0=R0):
    if r is None:
        return None
    return 100.0 * max(0.0, (float(r) - r0) / (1.0 - r0))


def metric_score(mae, r, mae_max, r0=R0):
    s_mae, s_r = mae_score(mae, mae_max), r_score(r, r0)
    if s_mae is None or s_r is None:
        return None
    return WEIGHT_MAE * s_mae + WEIGHT_R * s_r


def average(a, b):
    if a is None or b is None:
        return None
    return 0.5 * a + 0.5 * b


def value_index(score, price):
    if score is None or not price:
        return None
    return score / float(price) * 100.0


def pareto_flags(rows, price_key="price", score_key="score"):
    """Frontera: no hay otro con precio menor o igual y nota mayor o igual,
    con al menos una desigualdad estricta."""
    eligible = [r for r in rows if r.get(price_key) is not None and r.get(score_key) is not None]
    flags = {id(r): False for r in rows}
    for a in eligible:
        dominated = False
        for b in eligible:
            if b is a:
                continue
            cheaper_or_equal = b[price_key] <= a[price_key]
            better_or_equal = b[score_key] >= a[score_key]
            strictly = (b[price_key] < a[price_key]) or (b[score_key] > a[score_key])
            if cheaper_or_equal and better_or_equal and strictly:
                dominated = True
                break
        flags[id(a)] = not dominated
    return flags


def load_prices(path=None):
    raw = json.loads(Path(path or PRICES_PATH).read_text())
    by_name = {}
    for item in raw.get("devices") or []:
        name = (item.get("name") or "").strip()
        if not name or item.get("price") is None:
            continue
        by_name[name.casefold()] = {
            "name": name,
            "price": float(item["price"]),
            "shop": item.get("shop"),
            "label": item.get("label"),
            "checked_at": item.get("checked_at") or raw.get("checked_at"),
            "source": item.get("source") or (raw.get("source") or {}).get("file"),
        }
    return {
        "version": raw.get("version"),
        "checked_at": raw.get("checked_at"),
        "currency": raw.get("currency") or "EUR",
        "rule": raw.get("rule"),
        "source": raw.get("source"),
        "by_name": by_name,
    }


def _excluded(name):
    return (name or "").strip().casefold() in EXCLUDED_NAMES


def _price_fields(offer):
    if not offer:
        return {
            "price": None, "shop": None, "label": None,
            "checked_at": None, "source": None,
        }
    return {
        "price": offer["price"],
        "shop": offer.get("shop"),
        "label": offer.get("label"),
        "checked_at": offer.get("checked_at"),
        "source": offer.get("source"),
    }


def _sport_row(item, prices):
    name = item["name"]
    offer = prices["by_name"].get(name.casefold())
    score = metric_score(item.get("mae"), item.get("r"), MAE_MAX_SPORT_HR)
    row = {
        "device_id": item["device_id"],
        "name": name,
        "sessions": item.get("sessions"),
        "sessions_by_sport": item.get("sessions_by_sport"),
        "n": item.get("n"),
        "mae": item.get("mae"),
        "r": item.get("r"),
        "mae_score": _round(mae_score(item.get("mae"), MAE_MAX_SPORT_HR)),
        "r_score": _round(r_score(item.get("r"))),
        "score": _round(score),
        **_price_fields(offer),
        "few": (item.get("sessions") or 0) < FEW,
    }
    row["value_index"] = _round(value_index(score, row["price"]), 2)
    return row


def _night_row(item, prices):
    name = item["name"]
    offer = prices["by_name"].get(name.casefold())
    hr, rm = item.get("hr") or {}, item.get("rmssd") or {}
    s_hr = metric_score(hr.get("mae"), hr.get("r"), MAE_MAX_REST_HR) if hr.get("n") else None
    s_rm = metric_score(rm.get("mae"), rm.get("r"), MAE_MAX_RMSSD) if rm.get("n") else None
    score = average(s_hr, s_rm)
    nights = max(hr.get("nights") or 0, rm.get("nights") or 0)
    row = {
        "device_id": item["device_id"],
        "name": name,
        "nights": nights,
        "nights_hr": hr.get("nights"),
        "nights_rmssd": rm.get("nights"),
        "hr_n": hr.get("n"),
        "hr_mae": hr.get("mae"),
        "hr_r": hr.get("r"),
        "hr_score": _round(s_hr),
        "rmssd_n": rm.get("n"),
        "rmssd_mae": rm.get("mae"),
        "rmssd_r": rm.get("r"),
        "rmssd_score": _round(s_rm),
        "score": _round(score),
        **_price_fields(offer),
        "few": nights < FEW,
    }
    row["value_index"] = _round(value_index(score, row["price"]), 2)
    return row


def _mark_frontier(rows):
    flags = pareto_flags(rows)
    for r in rows:
        r["frontier"] = flags[id(r)]
    return rows


def build_precision_price(sport, night, prices):
    """Combina las respuestas de sport/night-validation con los precios versionados."""
    sport_items = [
        _sport_row(it, prices)
        for it in (sport.get("sports") or {}).get("combined") or []
        if not _excluded(it.get("name"))
    ]
    night_items = [
        _night_row(it, prices)
        for it in night.get("devices") or []
        if not _excluded(it.get("name"))
    ]

    sport_by = {r["name"]: r for r in sport_items}
    night_by = {r["name"]: r for r in night_items}
    names = sorted(set(sport_by) | set(night_by), key=lambda n: n.casefold())

    missing_price = []
    missing_night = []
    missing_sport = []
    final_items = []
    for name in names:
        s, n = sport_by.get(name), night_by.get(name)
        has_sport = s is not None and s["score"] is not None
        has_night = n is not None and n["score"] is not None
        price = (s or n or {}).get("price")
        if price is None:
            missing_price.append({
                "device_id": (s or n)["device_id"],
                "name": name,
            })
        if not has_night and has_sport:
            missing_night.append({"device_id": s["device_id"], "name": name})
        if not has_sport and has_night:
            missing_sport.append({"device_id": n["device_id"], "name": name})
        score = average(s["score"], n["score"]) if (has_sport and has_night) else None
        few = bool((s and s["few"]) or (n and n["few"]))
        offer_src = s if (s and s.get("price") is not None) else n
        row = {
            "device_id": (s or n)["device_id"],
            "name": name,
            "sport_score": s["score"] if s else None,
            "sport_mae": s["mae"] if s else None,
            "sport_r": s["r"] if s else None,
            "sport_sessions": s["sessions"] if s else None,
            "night_score": n["score"] if n else None,
            "night_nights": n["nights"] if n else None,
            "score": _round(score) if score is not None else None,
            "included": score is not None and price is not None,
            "missing": [part for part, ok in (("deporte", has_sport), ("noche", has_night)) if not ok],
            **_price_fields(offer_src if offer_src and offer_src.get("price") is not None else None),
            "few": few,
        }
        row["value_index"] = _round(value_index(score, row["price"]), 2)
        final_items.append(row)

    sport_chart = _mark_frontier([r for r in sport_items if r["price"] is not None and r["score"] is not None])
    night_chart = _mark_frontier([r for r in night_items if r["price"] is not None and r["score"] is not None])
    final_chart = _mark_frontier([r for r in final_items if r["included"]])
    # Devices not in a chart keep frontier False.
    in_final = {r["name"] for r in final_chart}
    for r in final_items:
        if r["name"] not in in_final:
            r["frontier"] = False

    sport_chart.sort(key=lambda r: (-(r["score"] or 0), r["name"].casefold()))
    night_chart.sort(key=lambda r: (-(r["score"] or 0), r["name"].casefold()))
    final_shown = [r for r in final_items if r["included"]]
    final_shown.sort(key=lambda r: (-(r["score"] or 0), r["name"].casefold()))

    return {
        "version": VERSION,
        "formula": FORMULA,
        "few_threshold": FEW,
        "price_rule": prices.get("rule"),
        "price_checked_at": prices.get("checked_at"),
        "price_source": prices.get("source"),
        "reference": {
            "sport": sport.get("reference") or "Polar H10",
            "night": night.get("reference") or "Polar",
        },
        "sports": sport_chart,
        "night": night_chart,
        "final": final_shown,
        "missing_price": missing_price,
        "missing_night": missing_night,
        "missing_sport": missing_sport,
    }


def collect_precision_price(devices, sessions, night_sessions, prices=None):
    sport = build_sport_validation(devices, sessions)
    night = build_validation(devices, night_sessions)
    return build_precision_price(sport, night, prices or load_prices())


@router.get("/precision-price")
async def get_precision_price(request: Request):
    db = request.app.state.db
    devices = [d async for d in db.devices.find({}, {"name": 1})]
    sessions = [s async for s in db.sessions.find(
        {"sport_type": {"$in": list(SPORTS)}},
        {"device_id": 1, "sport_type": 1, "fc_data.reference": 1, "fc_data.device": 1},
    )]
    nights = [s async for s in db.nocturnal_hrv_sessions.find({}, {"windows": 1, "device_id": 1})]
    prices = load_prices()
    return await run_in_threadpool(collect_precision_price, devices, sessions, nights, prices)

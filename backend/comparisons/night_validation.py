"""Validación nocturna por dispositivo: FC y RMSSD en ventanas de 5 min frente a Polar.

Solo lectura. Usa las mismas ventanas nocturnas guardadas que las evidencias
``night_hr`` y ``night_rmssd`` de las reviews (``archive.night_values``).
Métricas: n, r de Pearson, R², MAE, sesgo y recta de regresión. No calcula
límites de acuerdo ni Bland-Altman.
"""
import math

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from .archive import night_values

router = APIRouter(prefix="/api", tags=["night validation"])

VERSION = "night-validation-1"
KINDS = {"hr": "NIGHT_HR", "rmssd": "NIGHT_RMSSD"}
WINDOW_SECONDS = 300


def _finite(value):
    return value is not None and isinstance(value, (int, float)) and math.isfinite(value)


def _round(value, digits=4):
    return round(float(value), digits) if _finite(value) else None


def pair_stats(pairs):
    """Estadísticos de acuerdo para pares (referencia, dispositivo)."""
    pairs = [(float(a), float(b)) for a, b in pairs if _finite(a) and _finite(b)]
    n = len(pairs)
    if not n:
        return {"n": 0, "r": None, "r2": None, "mae": None, "bias": None, "slope": None, "intercept": None}
    mx = sum(a for a, _ in pairs) / n
    my = sum(b for _, b in pairs) / n
    sxx = sum((a - mx) ** 2 for a, _ in pairs)
    syy = sum((b - my) ** 2 for _, b in pairs)
    sxy = sum((a - mx) * (b - my) for a, b in pairs)
    r = sxy / math.sqrt(sxx * syy) if n >= 3 and sxx > 0 and syy > 0 else None
    slope = sxy / sxx if n >= 2 and sxx > 0 else None
    return {
        "n": n,
        "r": _round(r),
        "r2": _round(r * r) if r is not None else None,
        "mae": _round(sum(abs(b - a) for a, b in pairs) / n),
        "bias": _round(sum(b - a for a, b in pairs) / n),
        "slope": _round(slope),
        "intercept": _round(my - slope * mx) if slope is not None else None,
    }


def night_series(doc, domain):
    """Serie de una noche: tiempo relativo (s), referencia y dispositivo."""
    values = night_values({"data": doc.get("windows", [])}, domain)
    stamps = sorted(values)
    origin = stamps[0] if stamps else None
    ref = [_round(values[t][0], 3) for t in stamps]
    dev = [_round(values[t][1], 3) for t in stamps]
    return {
        "session_id": str(doc.get("_id")),
        "origin_utc": origin,
        "time": [t - origin for t in stamps],
        "reference": ref,
        "device": dev,
        "pairs": [(a, b) for a, b in zip(ref, dev) if a is not None and b is not None],
        "windows": len(stamps),
    }


def kind_summary(nights):
    pooled = [p for night in nights for p in night["pairs"]]
    total = sum(night["windows"] for night in nights)
    means = []
    for night in nights:
        if not night["pairs"]:
            continue
        k = len(night["pairs"])
        means.append({
            "session_id": night["session_id"],
            "origin_utc": night["origin_utc"],
            "reference": _round(sum(a for a, _ in night["pairs"]) / k),
            "device": _round(sum(b for _, b in night["pairs"]) / k),
        })
    return {
        **pair_stats(pooled),
        "nights": len([n for n in nights if n["pairs"]]),
        "windows": total,
        "coverage": _round(len(pooled) / total) if total else None,
        "nightly": {**pair_stats([(m["reference"], m["device"]) for m in means]), "points": means},
        "series": [{k: v for k, v in night.items() if k != "pairs"} for night in nights],
    }


def build_validation(devices, sessions):
    """Agrupa las noches por dispositivo. Omite dispositivos sin noches."""
    by_device = {}
    for doc in sessions:
        by_device.setdefault(str(doc.get("device_id")), []).append(doc)
    items = []
    for device in devices:
        docs = by_device.get(str(device["_id"]), [])
        if not docs:
            continue
        item = {"device_id": str(device["_id"]), "name": device.get("name") or "Dispositivo", "reference": "Polar"}
        for key, domain in KINDS.items():
            nights = sorted((night_series(doc, domain) for doc in docs),
                            key=lambda s: (s["origin_utc"] is None, s["origin_utc"] or 0))
            item[key] = kind_summary([n for n in nights if n["windows"]])
        if item["hr"]["n"] or item["rmssd"]["n"]:
            items.append(item)
    items.sort(key=lambda x: x["name"].lower())
    return {
        "version": VERSION,
        "window_seconds": WINDOW_SECONDS,
        "reference": "Polar",
        "metrics": ["n", "r", "r2", "mae", "bias", "slope", "intercept"],
        "devices": items,
    }


@router.get("/night-validation")
async def get_night_validation(request: Request):
    db = request.app.state.db
    devices = [d async for d in db.devices.find({}, {"name": 1})]
    sessions = [s async for s in db.nocturnal_hrv_sessions.find({}, {"windows": 1, "device_id": 1})]
    return await run_in_threadpool(build_validation, devices, sessions)

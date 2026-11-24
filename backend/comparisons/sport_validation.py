"""Validación por deporte: FC de entrenamiento de cada dispositivo frente a la Polar H10.

Solo lectura. Junta (pooled) todos los segundos emparejados guardados en ``fc_data``
de todas las sesiones de un dispositivo en cada deporte y calcula n, r de Pearson,
R², MAE, sesgo y recta de regresión con ``pair_stats`` (el mismo cálculo que la
validación nocturna). No calcula límites de acuerdo ni Bland-Altman.

Por dispositivo y deporte añade también, como la validación nocturna:
``session_means`` (un punto por sesión: media de Polar y del dispositivo) y
``series`` (curva de FC de cada sesión frente a Polar, en medias de tramos
para que la respuesta no crezca: como mucho ``SERIES_MAX`` puntos por sesión).
``series`` no se repite en la vista combinada.
"""
import math

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from .night_validation import pair_stats

router = APIRouter(prefix="/api", tags=["sport validation"])

VERSION = "sport-validation-2"
SPORTS = ("running", "gym", "cycling")
SPORT_LABELS = {"running": "Carrera", "gym": "Fuerza", "cycling": "Ciclismo"}
# Clave extra de la respuesta: los segundos de los tres deportes juntos.
COMBINED = "combined"
COMBINED_LABEL = "Los 3 deportes combinados"
SAMPLE_MAX = 4000
SERIES_MAX = 360
# Variantes de colocación que no son un dispositivo aparte (p. ej. la Fitbit Air en el bíceps).
EXCLUDED_NAMES = {"fitbit air biceps"}


def _ok(value):
    return value is not None and isinstance(value, (int, float)) and math.isfinite(value)


def session_pairs(doc):
    """Pares (referencia, dispositivo) válidos de una sesión."""
    fc = doc.get("fc_data") or {}
    ref, dev = fc.get("reference") or [], fc.get("device") or []
    return [(float(a), float(b)) for a, b in zip(ref, dev) if _ok(a) and _ok(b)]


def sample_pairs(pairs, limit=SAMPLE_MAX):
    """Muestra regular de como mucho ``limit`` pares, redondeados a 0,1 bpm."""
    if not pairs:
        return []
    step = max(1, math.ceil(len(pairs) / limit))
    return [[round(a, 1), round(b, 1)] for a, b in pairs[::step]][:limit]


def _mean(values):
    values = [v for v in values if _ok(v)]
    return sum(values) / len(values) if values else None


def _rounded(value, digits=1):
    return round(value, digits) if value is not None else None


def session_series(doc, limit=SERIES_MAX):
    """Curva de la sesión: segundos desde el inicio y FC de Polar y del dispositivo.

    Agrupa en como mucho ``limit`` tramos consecutivos y guarda la media de cada
    tramo (los huecos quedan en ``None``)."""
    fc = doc.get("fc_data") or {}
    ref, dev = fc.get("reference") or [], fc.get("device") or []
    n = min(len(ref), len(dev))
    if not n:
        return None
    step = fc.get("step") or 1
    raw_time = fc.get("time") or []
    times = [float(raw_time[i]) if i < len(raw_time) and _ok(raw_time[i]) else float(i * step) for i in range(n)]
    origin = times[0]
    size = max(1, math.ceil(n / limit))
    out = {"time": [], "reference": [], "device": []}
    for start in range(0, n, size):
        stop = min(n, start + size)
        out["time"].append(round(times[start] - origin, 1))
        out["reference"].append(_rounded(_mean(ref[start:stop])))
        out["device"].append(_rounded(_mean(dev[start:stop])))
    return out


def session_info(doc, pairs):
    date = doc.get("activity_date")
    date = date.isoformat() if hasattr(date, "isoformat") else (str(date) if date else None)
    k = len(pairs)
    return {
        "session_id": str(doc.get("_id")),
        "date": date,
        "name": doc.get("session_name") or doc.get("training_type") or "Sesión",
        "reference": round(sum(a for a, _ in pairs) / k, 2),
        "device": round(sum(b for _, b in pairs) / k, 2),
    }


def build_sport_validation(devices, sessions):
    names = {str(d["_id"]): d.get("name") or "Dispositivo" for d in devices}
    groups = {}
    for doc in sessions:
        sport = doc.get("sport_type")
        device_id = str(doc.get("device_id"))
        name = names.get(device_id)
        if sport not in SPORTS or name is None or name.strip().lower() in EXCLUDED_NAMES:
            continue
        pairs = session_pairs(doc)
        if not pairs:
            continue
        info = session_info(doc, pairs)
        series = session_series(doc)
        for key in (sport, COMBINED):
            group = groups.setdefault((key, device_id), {"sessions": 0, "pairs": [], "by_sport": {}, "points": [], "series": []})
            group["sessions"] += 1
            group["pairs"].extend(pairs)
            group["by_sport"][sport] = group["by_sport"].get(sport, 0) + 1
            group["points"].append({**info, "sport": sport})
            if key != COMBINED and series:
                group["series"].append({**info, **series})
    out = {key: [] for key in (*SPORTS, COMBINED)}
    for (sport, device_id), group in groups.items():
        stats = pair_stats(group["pairs"])
        if not stats["n"]:
            continue
        points = sorted(group["points"], key=lambda p: (p["date"] is None, p["date"] or ""))
        series = sorted(group["series"], key=lambda p: (p["date"] is None, p["date"] or ""))
        out[sport].append({
            "device_id": device_id,
            "name": names[device_id],
            "sessions": group["sessions"],
            **({"sessions_by_sport": group["by_sport"]} if sport == COMBINED else {}),
            **stats,
            "sample": sample_pairs(group["pairs"]),
            "session_means": {**pair_stats([(p["reference"], p["device"]) for p in points]), "points": points},
            **({} if sport == COMBINED else {"series": series}),
        })
    for items in out.values():
        items.sort(key=lambda x: (x["mae"] is None, x["mae"] if x["mae"] is not None else 0, x["name"].lower()))
    return {
        "version": VERSION,
        "reference": "Polar H10",
        "metrics": ["n", "r", "r2", "mae", "bias", "slope", "intercept"],
        "sport_labels": {**SPORT_LABELS, COMBINED: COMBINED_LABEL},
        "sample_max": SAMPLE_MAX,
        "series_max": SERIES_MAX,
        "sports": out,
    }


@router.get("/sport-validation")
async def get_sport_validation(request: Request):
    db = request.app.state.db
    devices = [d async for d in db.devices.find({}, {"name": 1})]
    sessions = [s async for s in db.sessions.find(
        {"sport_type": {"$in": list(SPORTS)}},
        {"device_id": 1, "sport_type": 1, "activity_date": 1, "session_name": 1, "training_type": 1,
         "fc_data.reference": 1, "fc_data.device": 1, "fc_data.time": 1, "fc_data.step": 1},
    )]
    return await run_in_threadpool(build_sport_validation, devices, sessions)

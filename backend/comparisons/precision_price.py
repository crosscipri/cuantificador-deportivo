"""Precisión-precio: nota de precisión (MAE y r) frente al precio verificado.

Solo lectura. Reutiliza las estadísticas agrupadas de la validación por deporte
(clave ``combined``: carrera, fuerza y ciclismo juntos) y de la validación
nocturna (FC en reposo y RMSSD). Aplica una fórmula con constantes fijas, no
relativas al grupo, y lee los precios de ``backend/data/prices.json``.

No calcula límites de acuerdo ni Bland-Altman. Si un dispositivo no tiene
precio, queda fuera de las gráficas y se lista en ``missing_price``. Además,
``left_out`` explica por gráfica quién queda fuera y por qué, y ``needs_price``
lista a quién le falta precio. Nunca se inventan precios.
"""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from .night_validation import build_validation
from .sport_validation import SPORTS, build_sport_validation, session_pairs

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


def norm_name(name):
    """Clave de cruce: sin acentos, sin mayúsculas, sin signos y con espacios únicos."""
    text = unicodedata.normalize("NFKD", str(name or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).casefold()
    return " ".join(re.sub(r"[^0-9a-z]+", " ", text).split())


def flexible_norm(name):
    """Como ``norm_name``, pero separa camelCase y letras pegadas a cifras (Ultra2 → ultra 2)."""
    text = unicodedata.normalize("NFKD", str(name or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    text = re.sub(r"([A-Za-z])(\d)", r"\1 \2", text)
    text = re.sub(r"(\d)([A-Za-z])", r"\1 \2", text)
    return " ".join(re.sub(r"[^0-9a-z]+", " ", text.casefold()).split())


def name_tokens(name):
    return set(flexible_norm(name).split())


# Marcas que no deben heredar el precio del Galaxy Watch Ultra 2 en el cruce por tokens.
_ULTRA2_BLOCKED = {
    "apple", "ultrahuman", "oura", "whoop", "garmin", "fitbit",
    "huawei", "realme", "polar", "suunto", "amazfit",
}


def looks_like_galaxy_watch_ultra_2(name):
    """True si el nombre contiene los tokens «ultra» y «2», con Samsung/Galaxy opcionales.

    No coincide con el Watch 9 ni con Ultrahuman, ni con un Apple Watch Ultra 2.
    «Galaxy Watch Ultra» (sin 2) queda fuera de esta regla (sí puede entrar por alias).
    """
    tokens = name_tokens(name)
    if "ultra" not in tokens or "2" not in tokens:
        return False
    if tokens & _ULTRA2_BLOCKED:
        return False
    return True


def load_prices(path=None):
    """Catálogo de precios. Se indexa por device_id, por nombre normalizado y por alias."""
    raw = json.loads(Path(path or PRICES_PATH).read_text())
    by_name, by_id, by_alias = {}, {}, {}
    for item in raw.get("devices") or []:
        name = (item.get("name") or "").strip()
        if not name or item.get("price") is None:
            continue
        offer = {
            "name": name,
            "device_id": str(item["device_id"]) if item.get("device_id") else None,
            "price": float(item["price"]),
            "shop": item.get("shop"),
            "label": item.get("label"),
            "checked_at": item.get("checked_at") or raw.get("checked_at"),
            "source": item.get("source") or (raw.get("source") or {}).get("file"),
        }
        for key in {norm_name(name), flexible_norm(name)}:
            if key:
                by_name.setdefault(key, offer)
        if offer["device_id"]:
            by_id[offer["device_id"]] = offer
        for alias in item.get("aliases") or []:
            for key in {norm_name(alias), flexible_norm(alias)}:
                if key:
                    by_alias.setdefault(key, offer)
    return {
        "version": raw.get("version"),
        "checked_at": raw.get("checked_at"),
        "currency": raw.get("currency") or "EUR",
        "rule": raw.get("rule"),
        "source": raw.get("source"),
        "by_name": by_name,
        "by_id": by_id,
        "by_alias": by_alias,
    }


def find_offer(prices, device_id, name):
    """Oferta de un dispositivo y cómo se cruzó: id, nombre, alias, nombre sin marca o tokens.

    «Sin marca» solo vale si el nombre de la base es exactamente el del catálogo sin su
    primera palabra (marca) y es único. El cruce por tokens («ultra» + «2») solo aplica
    al Galaxy Watch Ultra 2 y no a otros Samsung ni a Apple/Ultrahuman.
    """
    by_name = prices.get("by_name") or {}
    by_alias = prices.get("by_alias") or {}
    offer = (prices.get("by_id") or {}).get(str(device_id)) if device_id is not None else None
    if offer:
        return offer, "id"
    keys = [k for k in (norm_name(name), flexible_norm(name)) if k]
    # Quitar duplicados conservando el orden.
    keys = list(dict.fromkeys(keys))
    for key in keys:
        if key in by_name:
            return by_name[key], "nombre"
        if key in by_alias:
            return by_alias[key], "alias"
    for key in keys:
        candidates = [o for k, o in by_name.items() if " " in k and k.split(" ", 1)[1] == key]
        # únicos por identidad de oferta
        uniq = []
        for o in candidates:
            if o not in uniq:
                uniq.append(o)
        if len(uniq) == 1:
            return uniq[0], "nombre sin marca"
    if looks_like_galaxy_watch_ultra_2(name):
        ultra = by_name.get("samsung galaxy watch ultra 2")
        if ultra:
            return ultra, "tokens (ultra 2)"
    return None, None


def _excluded(name):
    return norm_name(name) in EXCLUDED_NAMES


def _price_fields(offer, how=None):
    if not offer:
        return {
            "price": None, "shop": None, "label": None,
            "checked_at": None, "source": None, "price_match": None,
        }
    return {
        "price": offer["price"],
        "shop": offer.get("shop"),
        "label": offer.get("label"),
        "checked_at": offer.get("checked_at"),
        "source": offer.get("source"),
        "price_match": how,
    }


def _sport_row(item, prices):
    name = item["name"]
    offer, how = find_offer(prices, item.get("device_id"), name)
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
        **_price_fields(offer, how),
        "few": (item.get("sessions") or 0) < FEW,
    }
    row["value_index"] = _round(value_index(score, row["price"]), 2)
    return row


def _night_row(item, prices):
    name = item["name"]
    offer, how = find_offer(prices, item.get("device_id"), name)
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
        **_price_fields(offer, how),
        "few": nights < FEW,
    }
    row["value_index"] = _round(value_index(score, row["price"]), 2)
    return row


def _mark_frontier(rows):
    flags = pareto_flags(rows)
    for r in rows:
        r["frontier"] = flags[id(r)]
    return rows


NO_PRICE = "sin precio verificado"


def _sport_reasons(did, row, stats):
    """Por qué un dispositivo no tiene nota de deporte (lista vacía si la tiene)."""
    if row is not None and row["score"] is not None:
        return []
    if row is not None:
        return ["sin r (menos de 3 pares de FC emparejados)"]
    if stats is None:
        return ["sin sesiones de running, gym o ciclismo con FC emparejada"]
    entry = stats.get(did)
    if not entry or not entry["total"]:
        return ["sin sesiones de entrenamiento"]
    if not entry["valid_sport"]:
        kinds = ", ".join(f"{k} ({v})" for k, v in sorted(entry["other_sport"].items()))
        return [f"{entry['total']} sesiones sin deporte válido (solo cuentan running, gym y ciclismo): {kinds}"]
    if entry.get("no_pairs") is not None and entry["no_pairs"] >= entry["valid_sport"]:
        return [f"{entry['valid_sport']} sesiones sin pares de FC válidos (referencia y dispositivo)"]
    return ["sin pares de FC válidos en sus sesiones"]


def _night_reasons(did, row, night_counts):
    if row is not None and row["score"] is not None:
        return []
    if row is not None:
        missing = []
        if row["hr_score"] is None:
            missing.append("FC en reposo")
        if row["rmssd_score"] is None:
            missing.append("HRV (RMSSD)")
        return [f"sin {' ni '.join(missing)} nocturna: la nota nocturna necesita las dos"]
    total = (night_counts or {}).get(did, 0)
    if total:
        return [f"{total} noches guardadas sin ventanas válidas de FC ni RMSSD"]
    return ["sin noches guardadas"]


def _left_out(devices, sport_by, night_by, offers, plotted, session_stats, night_counts):
    out = {"sports": [], "night": [], "final": []}
    for did, name in devices:
        s, n = sport_by.get(did), night_by.get(did)
        sport_r = _sport_reasons(did, s, session_stats)
        night_r = _night_reasons(did, n, night_counts)
        price_r = [] if offers.get(did) is not None else [NO_PRICE]
        parts = {
            "sports": sport_r + price_r,
            "night": night_r + price_r,
            "final": (["sin nota de deporte"] if sport_r else []) + (["sin nota nocturna"] if night_r else []) + price_r,
        }
        for view, reasons in parts.items():
            if did in plotted[view]:
                continue
            out[view].append({"device_id": did, "name": name, "reasons": reasons or ["motivo no determinado"]})
    for items in out.values():
        items.sort(key=lambda r: r["name"].casefold())
    return out


def build_precision_price(sport, night, prices, devices=None, session_stats=None, night_counts=None, diagnostics=None):
    """Combina las respuestas de sport/night-validation con los precios versionados.

    Cruza deporte y noche por ``device_id`` (no por nombre) y el precio por id, nombre
    normalizado o alias. ``devices`` (id, nombre) de toda la base, ``session_stats`` y
    ``night_counts`` solo sirven para explicar quién queda fuera de cada gráfica.
    """
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

    sport_by = {r["device_id"]: r for r in sport_items}
    night_by = {r["device_id"]: r for r in night_items}
    ids = sorted(set(sport_by) | set(night_by),
                 key=lambda i: ((sport_by.get(i) or night_by[i])["name"].casefold(), i))

    missing_price = []
    missing_night = []
    missing_sport = []
    final_items = []
    for did in ids:
        s, n = sport_by.get(did), night_by.get(did)
        name = (s or n)["name"]
        has_sport = s is not None and s["score"] is not None
        has_night = n is not None and n["score"] is not None
        price = (s or n).get("price")
        if price is None and n is not None and n.get("price") is not None:
            price = n["price"]
        if price is None:
            missing_price.append({"device_id": did, "name": name})
        if not has_night and has_sport:
            missing_night.append({"device_id": did, "name": name})
        if not has_sport and has_night:
            missing_sport.append({"device_id": did, "name": name})
        score = average(s["score"], n["score"]) if (has_sport and has_night) else None
        few = bool((s and s["few"]) or (n and n["few"]))
        offer_src = s if (s and s.get("price") is not None) else n
        row = {
            "device_id": did,
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
            **{k: (offer_src or {}).get(k) if (offer_src and offer_src.get("price") is not None) else None
               for k in ("price", "shop", "label", "checked_at", "source", "price_match")},
            "few": few,
        }
        row["value_index"] = _round(value_index(score, row["price"]), 2)
        final_items.append(row)

    sport_chart = _mark_frontier([r for r in sport_items if r["price"] is not None and r["score"] is not None])
    night_chart = _mark_frontier([r for r in night_items if r["price"] is not None and r["score"] is not None])
    final_chart = _mark_frontier([r for r in final_items if r["included"]])
    # Devices not in a chart keep frontier False.
    in_final = {r["device_id"] for r in final_chart}
    for r in final_items:
        if r["device_id"] not in in_final:
            r["frontier"] = False

    sport_chart.sort(key=lambda r: (-(r["score"] or 0), r["name"].casefold()))
    night_chart.sort(key=lambda r: (-(r["score"] or 0), r["name"].casefold()))
    final_shown = [r for r in final_items if r["included"]]
    final_shown.sort(key=lambda r: (-(r["score"] or 0), r["name"].casefold()))

    # Quién queda fuera de cada gráfica y por qué (todos los dispositivos de la base).
    known = {}
    for d in devices or []:
        if not _excluded(d["name"]):
            known[d["id"]] = d["name"]
    for did in ids:
        known.setdefault(did, (sport_by.get(did) or night_by[did])["name"])
    offers = {did: find_offer(prices, did, name)[0] for did, name in known.items()}
    plotted = {
        "sports": {r["device_id"] for r in sport_chart},
        "night": {r["device_id"] for r in night_chart},
        "final": {r["device_id"] for r in final_chart},
    }
    left_out = _left_out(sorted(known.items(), key=lambda kv: kv[1].casefold()),
                         sport_by, night_by, offers, plotted, session_stats, night_counts)
    has_data = set(ids)
    needs_price = [
        {"device_id": did, "name": name, "has_data": did in has_data}
        for did, name in sorted(known.items(), key=lambda kv: kv[1].casefold())
        if offers.get(did) is None
    ]

    by_norm = {}
    for did, name in known.items():
        by_norm.setdefault(norm_name(name), []).append(name)
    duplicates = sorted(sorted(v) for v in by_norm.values() if len(v) > 1)

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
        "left_out": left_out,
        "needs_price": needs_price,
        "diagnostics": {
            "devices_in_db": len(known),
            "duplicate_names": duplicates,
            **(diagnostics or {}),
        },
    }


def summarize_sessions(devices, sessions, aggregate_rows):
    """Resumen por dispositivo de TODAS las sesiones (también las de deportes no válidos).

    ``aggregate_rows``: filas ``{"_id": {"d": device_id, "s": sport_type}, "n": count}``.
    Devuelve (stats por device_id, diagnóstico global). ``stats`` es None si no hubo agregado.
    """
    if aggregate_rows is None:
        return None, {}
    known = {str(d["_id"]) for d in devices}
    stats, unlinked, other_total = {}, 0, {}
    for row in aggregate_rows:
        key = row.get("_id") or {}
        did = str(key.get("d")) if key.get("d") is not None else None
        sport = key.get("s")
        count = int(row.get("n") or 0)
        valid = sport in SPORTS
        if did is None or did not in known:
            unlinked += count
            continue
        entry = stats.setdefault(did, {"total": 0, "valid_sport": 0, "other_sport": {}, "no_pairs": 0})
        entry["total"] += count
        if valid:
            entry["valid_sport"] += count
        else:
            label = sport if sport else "(sin deporte)"
            entry["other_sport"][label] = entry["other_sport"].get(label, 0) + count
            other_total[label] = other_total.get(label, 0) + count
    for doc in sessions:
        did = str(doc.get("device_id"))
        if did in stats and not session_pairs(doc):
            stats[did]["no_pairs"] += 1
    diag = {"sessions_unlinked": unlinked, "sessions_without_valid_sport": other_total}
    return stats, diag


def collect_precision_price(devices, sessions, night_sessions, prices=None, session_aggregate=None):
    sport = build_sport_validation(devices, sessions)
    night = build_validation(devices, night_sessions)
    stats, diag = summarize_sessions(devices, sessions, session_aggregate)
    night_counts = {}
    for doc in night_sessions:
        did = str(doc.get("device_id"))
        night_counts[did] = night_counts.get(did, 0) + 1
    return build_precision_price(
        sport, night, prices or load_prices(),
        devices=[{"id": str(d["_id"]), "name": d.get("name") or "Dispositivo"} for d in devices],
        session_stats=stats, night_counts=night_counts, diagnostics=diag,
    )


@router.get("/precision-price")
async def get_precision_price(request: Request):
    db = request.app.state.db
    devices = [d async for d in db.devices.find({}, {"name": 1})]
    sessions = [s async for s in db.sessions.find(
        {"sport_type": {"$in": list(SPORTS)}},
        {"device_id": 1, "sport_type": 1, "fc_data.reference": 1, "fc_data.device": 1},
    )]
    nights = [s async for s in db.nocturnal_hrv_sessions.find({}, {"windows": 1, "device_id": 1})]
    # Solo para explicar a quién se deja fuera: recuento por dispositivo y deporte (lectura).
    aggregate_rows = None
    try:
        aggregate_rows = [row async for row in db.sessions.aggregate(
            [{"$group": {"_id": {"d": "$device_id", "s": "$sport_type"}, "n": {"$sum": 1}}}]
        )]
    except Exception:  # el diagnóstico nunca debe romper la página
        aggregate_rows = None
    prices = load_prices()
    return await run_in_threadpool(collect_precision_price, devices, sessions, nights, prices, aggregate_rows)

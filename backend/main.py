"""
FastAPI backend for HR Analyzer.
Hierarchy: Device → Training Type → Sessions
"""

from __future__ import annotations

import json
import logging
import math
import os
import traceback
from datetime import datetime
from typing import Any, Optional

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("main")

from bson import Binary, ObjectId
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from motor.motor_asyncio import AsyncIOMotorClient

from analyzer import (analyze_session, generate_aggregate_analysis,
                      generate_overview_chart, generate_sport_aggregate,
                      build_sport_chart_data,
                      _weighted_global_score, DIFFICULTY_WEIGHTS,
                      VALID_CHART_CRITERIA,
                      read_fc_from_bytes, align, calculate_metrics,
                      analyze_by_zones, estimate_lag)
from ai_analyzer import generate_session_ai_analysis, generate_device_ai_verdict, generate_gps_track_ai_analysis, generate_gps_urban_ai_analysis, generate_nocturnal_hrv_ai_analysis, generate_nocturnal_hrv_global_ai_analysis

load_dotenv()

app = FastAPI(title="HR Analyzer API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────────────────────────────
# MongoDB lifecycle
# ─────────────────────────────────────────────────────────────────────────────

MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017")
DB_NAME   = os.getenv("DB_NAME",   "hr_analyzer")


@app.on_event("startup")
async def startup() -> None:
    app.state.mongo = AsyncIOMotorClient(MONGO_URL)
    app.state.db    = app.state.mongo[DB_NAME]
    await app.state.db.devices.create_index([("created_at", -1)])
    await app.state.db.sessions.create_index("device_id")
    await app.state.db.sessions.create_index("training_type")
    await app.state.db.sessions.create_index([("created_at", -1)])
    await app.state.db.gps_tests.create_index("device_id")
    await app.state.db.gps_tests.create_index([("created_at", -1)])
    await app.state.db.urban_tests.create_index("device_id")
    await app.state.db.urban_tests.create_index([("created_at", -1)])
    await app.state.db.gps_scores.create_index("device_id", unique=True)
    await app.state.db.nocturnal_hrv_sessions.create_index("device_id")
    await app.state.db.nocturnal_hrv_sessions.create_index([("created_at", -1)])


@app.on_event("shutdown")
async def shutdown() -> None:
    app.state.mongo.close()


def db():
    return app.state.db


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _oid(value: str) -> ObjectId:
    try:
        return ObjectId(value)
    except Exception:
        raise HTTPException(status_code=400, detail="ID inválido")


def _ser(doc: dict, *, keep_fc: bool = False) -> dict:
    doc["id"] = str(doc.pop("_id"))
    if "device_id" in doc:
        doc["device_id"] = str(doc["device_id"])
    if isinstance(doc.get("created_at"), datetime):
        doc["created_at"] = doc["created_at"].isoformat()
    if isinstance(doc.get("activity_date"), datetime):
        doc["activity_date"] = doc["activity_date"].isoformat()
    if not keep_fc:
        doc.pop("fc_data", None)
    # Never expose raw binary file bytes in API responses
    doc.pop("device_file_bytes", None)
    doc.pop("reference_file_bytes", None)
    # Expose only lightweight AI metadata in session list / detail responses;
    # the full payload is returned by dedicated /ai-analysis endpoints.
    ai = doc.pop("ai_analysis", None)
    if ai:
        doc["has_ai_analysis"]   = True
        doc["ai_analysis_at"]    = ai.get("generated_at")
        doc["ai_analysis_model"] = ai.get("model")
    else:
        doc["has_ai_analysis"] = False
    # Same for device ai_verdict
    verdict = doc.pop("ai_verdict", None)
    if verdict:
        doc["has_ai_verdict"]   = True
        doc["ai_verdict_at"]    = verdict.get("generated_at")
        doc["ai_verdict_model"] = verdict.get("model")
    else:
        doc["has_ai_verdict"] = False
    return doc


def _ser_urban_test(doc: dict, *, include_points: bool = False) -> dict:
    doc["id"] = str(doc.pop("_id"))
    if "device_id" in doc:
        doc["device_id"] = str(doc["device_id"])
    if isinstance(doc.get("created_at"), datetime):
        doc["created_at"] = doc["created_at"].isoformat()
    if not include_points:
        modes = doc.get("modes", [])
        doc["mode_count"] = len(modes)
        doc["modes_summary"] = [
            {"name": m["name"], "color": m["color"], "run_count": len(m.get("runs", []))}
            for m in modes
        ]
        doc.pop("modes", None)
    return doc


def _ser_gps_test(doc: dict, *, include_points: bool = False) -> dict:
    doc["id"] = str(doc.pop("_id"))
    if "device_id" in doc:
        doc["device_id"] = str(doc["device_id"])
    if isinstance(doc.get("created_at"), datetime):
        doc["created_at"] = doc["created_at"].isoformat()
    if not include_points:
        modes = doc.get("modes", [])
        doc["mode_count"] = len(modes)
        doc["modes_summary"] = [
            {"name": m["name"], "color": m["color"], "run_count": len(m.get("runs", []))}
            for m in modes
        ]
        doc.pop("modes", None)
    return doc


# ─────────────────────────────────────────────────────────────────────────────
# DEVICES
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/devices", status_code=201)
async def create_device(body: dict) -> dict:
    """Create a device to validate (e.g. Garmin FR265 vs Polar H10)."""
    name           = (body.get("name") or "").strip()
    reference_name = (body.get("reference_name") or "").strip()
    description    = (body.get("description") or "").strip()

    if not name or not reference_name:
        raise HTTPException(status_code=422, detail="name y reference_name son obligatorios")

    doc: dict[str, Any] = {
        "name":           name,
        "reference_name": reference_name,
        "description":    description,
        "created_at":     datetime.utcnow(),
    }
    inserted = await db().devices.insert_one(doc)
    doc["_id"] = inserted.inserted_id
    return _ser(doc)


@app.get("/api/devices")
async def list_devices() -> list[dict]:
    """List all devices with session count and training types summary."""
    devices = [_ser(d) async for d in db().devices.find().sort("created_at", -1)]

    for dev in devices:
        pipeline = [
            {"$match": {"device_id": ObjectId(dev["id"])}},
            {"$group": {
                "_id": "$training_type",
                "count": {"$sum": 1},
                "last_date": {"$max": "$created_at"},
            }},
            {"$sort": {"_id": 1}},
        ]
        types = [d async for d in db().sessions.aggregate(pipeline)]
        dev["training_types"] = [
            {
                "name":      t["_id"],
                "count":     t["count"],
                "last_date": t["last_date"].isoformat() if isinstance(t["last_date"], datetime) else t["last_date"],
            }
            for t in types
        ]
        dev["session_count"] = sum(t["count"] for t in types)

        # Include sparkline of the most recent session for the card preview
        last_session = await db().sessions.find_one(
            {"device_id": ObjectId(dev["id"])},
            {"spark_data": 1, "fc_data": 1},
            sort=[("created_at", -1)],
        )
        if last_session:
            spark = last_session.get("spark_data")
            if not spark:
                # Compute on-the-fly from fc_data for older sessions
                fc = last_session.get("fc_data", {})
                dev_pts = fc.get("device", [])
                ref_pts = fc.get("reference", [])
                n = len(dev_pts)
                if n >= 2:
                    step = max(1, n // 20)
                    idx = list(range(0, n, step))[:20]
                    spark = {
                        "device":    [dev_pts[i] for i in idx],
                        "reference": [ref_pts[i] for i in idx],
                    }
            dev["last_spark"] = spark or {}

    return devices


@app.get("/api/devices/{device_id}")
async def get_device(device_id: str) -> dict:
    """Get a device with its training types and per-type metrics."""
    doc = await db().devices.find_one({"_id": _oid(device_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")
    dev = _ser(doc)

    pipeline = [
        {"$match": {"device_id": ObjectId(device_id)}},
        {"$group": {
            "_id": "$training_type",
            "count": {"$sum": 1},
            "last_date": {"$max": "$created_at"},
            "avg_mae":  {"$avg": "$metrics.mae"},
            "avg_ccc":  {"$avg": "$metrics.ccc"},
        }},
        {"$sort": {"_id": 1}},
    ]
    types = [d async for d in db().sessions.aggregate(pipeline)]
    dev["training_types"] = [
        {
            "name":      t["_id"],
            "count":     t["count"],
            "last_date": t["last_date"].isoformat() if isinstance(t["last_date"], datetime) else t["last_date"],
            "avg_mae":   round(t["avg_mae"], 2) if t["avg_mae"] is not None else None,
            "avg_ccc":   round(t["avg_ccc"], 4) if t["avg_ccc"] is not None else None,
        }
        for t in types
    ]
    dev["session_count"] = sum(t["count"] for t in types)
    return dev


@app.delete("/api/devices/{device_id}")
async def delete_device(device_id: str) -> dict:
    """Delete a device and ALL its sessions."""
    oid = _oid(device_id)
    result = await db().devices.delete_one({"_id": oid})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")
    await db().sessions.delete_many({"device_id": oid})
    await db().nocturnal_hrv_sessions.delete_many({"device_id": oid})
    return {"deleted": True}


# ─────────────────────────────────────────────────────────────────────────────
# SESSIONS  (scoped to a device)
# ─────────────────────────────────────────────────────────────────────────────

VALID_SPORT_TYPES       = {"running", "cycling", "gym"}
VALID_DIFFICULTIES      = {"z2", "tempo", "series"}

@app.post("/api/devices/{device_id}/sessions", status_code=201)
async def create_session(
    device_id:          str,
    device_file:        UploadFile = File(...),
    reference_file:     UploadFile = File(...),
    training_type:      str = Form(...),
    session_name:       str = Form(default=""),
    sport_type:         str = Form(...),
    session_difficulty: str = Form(...),
) -> dict:
    """Upload a FIT/TCX/GPX pair for a device and persist the analysis."""
    if sport_type not in VALID_SPORT_TYPES:
        raise HTTPException(status_code=422, detail=f"sport_type debe ser uno de: {VALID_SPORT_TYPES}")
    if session_difficulty not in VALID_DIFFICULTIES:
        raise HTTPException(status_code=422, detail=f"session_difficulty debe ser uno de: {VALID_DIFFICULTIES}")

    dev_doc = await db().devices.find_one({"_id": _oid(device_id)})
    if not dev_doc:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    dev_name = dev_doc["name"]
    ref_name = dev_doc["reference_name"]

    device_bytes    = await device_file.read()
    reference_bytes = await reference_file.read()

    try:
        result = analyze_session(
            device_bytes, reference_bytes, dev_name, ref_name,
            device_filename=device_file.filename or "",
            reference_filename=reference_file.filename or "",
        )
    except Exception as exc:
        log.error("Unhandled exception", exc_info=True)
        raise HTTPException(status_code=422, detail=str(exc))

    # Build a 20-point sparkline for list views (no need to fetch full fc_data)
    _fc = result.get("fc_data", {})
    _dev_pts = _fc.get("device", [])
    _ref_pts = _fc.get("reference", [])
    _n = len(_dev_pts)
    if _n >= 2:
        _step = max(1, _n // 20)
        _indices = list(range(0, _n, _step))[:20]
        spark_data = {
            "device":    [_dev_pts[i] for i in _indices],
            "reference": [_ref_pts[i] for i in _indices],
        }
    else:
        spark_data = {}

    doc: dict[str, Any] = {
        "device_id":              ObjectId(device_id),
        "training_type":          training_type.strip(),
        "session_name":           session_name.strip() or f"Sesión {datetime.now().strftime('%d/%m/%Y %H:%M')}",
        "device_name":            dev_name,
        "reference_name":         ref_name,
        "sport_type":             sport_type,
        "session_difficulty":     session_difficulty,
        "created_at":             datetime.utcnow(),
        "device_file_bytes":      Binary(device_bytes),
        "device_file_name":       device_file.filename or "",
        "reference_file_bytes":   Binary(reference_bytes),
        "reference_file_name":    reference_file.filename or "",
        "spark_data":             spark_data,
        **result,
    }
    inserted = await db().sessions.insert_one(doc)
    doc["_id"] = inserted.inserted_id
    return _ser(doc)


@app.get("/api/devices/{device_id}/sessions")
async def list_device_sessions(
    device_id:     str,
    training_type: Optional[str] = None,
) -> list[dict]:
    """List sessions for a device, optionally filtered by training type."""
    query: dict[str, Any] = {"device_id": _oid(device_id)}
    if training_type:
        query["training_type"] = training_type

    # Fetch fc_data so we can build spark_data for sessions that pre-date the field,
    # but exclude the heavy binary file bytes.
    cursor = db().sessions.find(
        query,
        {"device_file_bytes": 0, "reference_file_bytes": 0},
    ).sort("activity_date", -1)

    results = []
    async for d in cursor:
        # Build spark_data on-the-fly if not already stored
        if not d.get("spark_data"):
            fc = d.get("fc_data", {})
            dev_pts = fc.get("device", [])
            ref_pts = fc.get("reference", [])
            n = len(dev_pts)
            if n >= 2:
                step = max(1, n // 20)
                indices = list(range(0, n, step))[:20]
                d["spark_data"] = {
                    "device":    [dev_pts[i] for i in indices],
                    "reference": [ref_pts[i] for i in indices],
                }
        d.pop("fc_data", None)  # never send full fc_data in list response
        results.append(_ser(d))
    return results


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str) -> dict:
    """Get a single session with full chart data and raw FC time-series."""
    doc = await db().sessions.find_one({"_id": _oid(session_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")
    return _ser(doc, keep_fc=True)


@app.patch("/api/sessions/{session_id}")
async def update_session(session_id: str, body: dict) -> dict:
    """Update editable metadata fields of a session."""
    allowed = {"session_name", "training_type", "sport_type", "session_difficulty"}
    update: dict[str, Any] = {}

    if "session_name" in body:
        update["session_name"] = (body["session_name"] or "").strip()
    if "training_type" in body:
        v = (body["training_type"] or "").strip()
        if not v:
            raise HTTPException(status_code=422, detail="training_type no puede estar vacío")
        update["training_type"] = v
    if "sport_type" in body:
        if body["sport_type"] not in VALID_SPORT_TYPES:
            raise HTTPException(status_code=422, detail=f"sport_type debe ser uno de: {VALID_SPORT_TYPES}")
        update["sport_type"] = body["sport_type"]
    if "session_difficulty" in body:
        if body["session_difficulty"] not in VALID_DIFFICULTIES:
            raise HTTPException(status_code=422, detail=f"session_difficulty debe ser uno de: {VALID_DIFFICULTIES}")
        update["session_difficulty"] = body["session_difficulty"]

    extra = set(body.keys()) - allowed
    if extra:
        raise HTTPException(status_code=422, detail=f"Campos no editables: {extra}")
    if not update:
        raise HTTPException(status_code=422, detail="No se proporcionó ningún campo para actualizar")

    result = await db().sessions.update_one({"_id": _oid(session_id)}, {"$set": update})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")

    doc = await db().sessions.find_one({"_id": _oid(session_id)}, {"fc_data": 0})
    return _ser(doc)


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> dict:
    """Delete a session."""
    result = await db().sessions.delete_one({"_id": _oid(session_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")
    return {"deleted": True}


@app.post("/api/sessions/{session_id}/reanalyze", status_code=200)
async def reanalyze_session(session_id: str) -> dict:
    """Re-run the analysis for a session using the stored raw files."""
    doc = await db().sessions.find_one({"_id": _oid(session_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")

    device_bytes: bytes | None    = doc.get("device_file_bytes")
    reference_bytes: bytes | None = doc.get("reference_file_bytes")

    if not device_bytes or not reference_bytes:
        raise HTTPException(
            status_code=422,
            detail="Esta sesión no tiene los ficheros originales almacenados. "
                   "Crea la sesión de nuevo para habilitar el recálculo.",
        )

    try:
        result = analyze_session(
            bytes(device_bytes),
            bytes(reference_bytes),
            doc["device_name"],
            doc["reference_name"],
            device_filename=doc.get("device_file_name", ""),
            reference_filename=doc.get("reference_file_name", ""),
        )
    except Exception as exc:
        log.error("Unhandled exception", exc_info=True)
        raise HTTPException(status_code=422, detail=str(exc))

    await db().sessions.update_one({"_id": _oid(session_id)}, {"$set": result})

    updated = await db().sessions.find_one({"_id": _oid(session_id)})
    return _ser(updated, keep_fc=True)


@app.post("/api/sessions/{session_id}/analyze-interval", status_code=200)
async def analyze_session_interval(session_id: str, body: dict) -> dict:
    """Recalculate all metrics for a specific time window [start_sec, end_sec]."""
    start_sec = float(body.get("start_sec", 0))
    end_sec   = float(body.get("end_sec",   0))

    if end_sec <= start_sec:
        raise HTTPException(status_code=422, detail="end_sec debe ser mayor que start_sec")

    doc = await db().sessions.find_one({"_id": _oid(session_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")

    device_bytes    = doc.get("device_file_bytes")
    reference_bytes = doc.get("reference_file_bytes")
    if not device_bytes or not reference_bytes:
        raise HTTPException(status_code=422, detail="Esta sesión no tiene los ficheros originales almacenados.")

    import numpy as np
    fc_ref = read_fc_from_bytes(bytes(reference_bytes), doc.get("reference_file_name", ""))
    fc_dev = read_fc_from_bytes(bytes(device_bytes),    doc.get("device_file_name",    ""))

    ref_aligned, dev_aligned, x_seg, _ = align(fc_ref, fc_dev)

    mask = (x_seg >= start_sec) & (x_seg <= end_sec)
    ref_interval = ref_aligned[mask]
    dev_interval = dev_aligned[mask]
    x_interval   = x_seg[mask] - start_sec

    if len(ref_interval) < 10:
        raise HTTPException(status_code=422, detail="Intervalo demasiado corto (mínimo 10 s).")

    metrics        = calculate_metrics(ref_interval, dev_interval)
    zones, fcmax   = analyze_by_zones(ref_interval, dev_interval)
    lag            = estimate_lag(ref_interval, dev_interval)

    step = max(1, len(ref_interval) // 2000)
    fc_data = {
        "reference": ref_interval.values[::step].round(1).tolist(),
        "device":    dev_interval.values[::step].round(1).tolist(),
        "time":      x_interval[::step].tolist(),
        "step":      step,
    }

    return {
        "metrics":          metrics,
        "zones":            zones,
        "lag":              lag,
        "fcmax":            fcmax,
        "duration_seconds": int(len(ref_interval)),
        "fc_data":          fc_data,
    }


@app.post("/api/admin/backfill-activity-dates", status_code=200)
async def backfill_activity_dates() -> dict:
    """One-time migration: extract activity_date from stored file bytes for sessions that lack it."""
    from analyzer import read_fc_from_bytes
    cursor = db().sessions.find(
        {"activity_date": {"$exists": False}},
        {"device_file_bytes": 1, "device_file_name": 1},
    )
    updated = 0
    skipped = 0
    async for doc in cursor:
        raw = doc.get("device_file_bytes")
        if not raw:
            skipped += 1
            continue
        try:
            series = read_fc_from_bytes(bytes(raw), doc.get("device_file_name", ""))
            activity_date = datetime.utcfromtimestamp(int(series.index[0]))
            await db().sessions.update_one(
                {"_id": doc["_id"]},
                {"$set": {"activity_date": activity_date}},
            )
            updated += 1
        except Exception:
            skipped += 1
    return {"updated": updated, "skipped": skipped}


@app.get("/api/sessions/{session_id}/files/{file_type}")
async def download_session_file(session_id: str, file_type: str) -> Response:
    """Download the original raw file stored for a session.
    file_type must be 'device' or 'reference'.
    """
    if file_type not in ("device", "reference"):
        raise HTTPException(status_code=400, detail="file_type debe ser 'device' o 'reference'")

    doc = await db().sessions.find_one(
        {"_id": _oid(session_id)},
        {f"{file_type}_file_bytes": 1, f"{file_type}_file_name": 1},
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")

    raw: bytes | None = doc.get(f"{file_type}_file_bytes")
    if not raw:
        raise HTTPException(status_code=404, detail="Fichero original no disponible para esta sesión")

    filename: str = doc.get(f"{file_type}_file_name") or f"{file_type}.bin"
    return Response(
        content=bytes(raw),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ─────────────────────────────────────────────────────────────────────────────
# OVERVIEW CHART  (all devices)
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/overview/chart")
async def get_overview_chart(
    sport_type: str = "running",
    criterion:  str = "mae",
) -> dict:
    """
    Global comparison lollipop chart.
    criterion: one of mae | rmse | pearson_fisher | ccc | within_5_bpm |
               within_3_bpm | within_10_bpm | difficulty_weighted
    Default criterion is 'mae' (balanced MAE per session).
    """
    if sport_type not in VALID_SPORT_TYPES:
        raise HTTPException(status_code=422, detail=f"sport_type debe ser uno de: {VALID_SPORT_TYPES}")
    if criterion not in VALID_CHART_CRITERIA:
        raise HTTPException(
            status_code=422,
            detail=f"criterion debe ser uno de: {sorted(VALID_CHART_CRITERIA)}",
        )

    devices = [d async for d in db().devices.find()]
    if not devices:
        raise HTTPException(status_code=404, detail="No hay dispositivos con sesiones.")

    devices_data = []
    total_sessions = 0

    for dev in devices:
        sessions = [
            s async for s in db().sessions.find(
                {"device_id": dev["_id"], "sport_type": sport_type},
                {
                    "metrics": 1, "session_difficulty": 1, "lag": 1,
                    "duration_seconds": 1, "training_type": 1, "fc_data": 1,
                },
            )
        ]
        if not sessions:
            continue

        session_results = [
            {
                "session_id":         str(s["_id"]),
                "sport_type":         sport_type,
                "training_type":      s.get("training_type", ""),
                "session_difficulty": s.get("session_difficulty", ""),
                "metrics":            s.get("metrics") or {},
                "lag":                s.get("lag", 0),
                "duration_seconds":   s.get("duration_seconds", 0),
                "fc_data":            s.get("fc_data") or {},
            }
            for s in sessions
        ]

        try:
            sport_agg = generate_sport_aggregate(session_results)
        except Exception:
            continue

        difficulty_weighted = _weighted_global_score(session_results)
        total_samples = (sport_agg.get("weighted_by_samples") or {}).get("n_samples", 0)

        devices_data.append({
            "name":                dev["name"],
            "reference_name":      dev["reference_name"],
            "session_count":       len(sessions),
            "total_samples":       total_samples,
            "sport_type":          sport_type,
            "balanced_by_session": sport_agg["balanced_by_session"],
            "difficulty_weighted": difficulty_weighted,
        })
        total_sessions += len(sessions)

    if not devices_data:
        raise HTTPException(status_code=404, detail="No hay sesiones con datos suficientes.")

    try:
        chart = generate_overview_chart(devices_data, criterion=criterion)
    except Exception as exc:
        log.error("Unhandled exception", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))

    return {
        "chart":          chart,
        "device_count":   len(devices_data),
        "total_sessions": total_sessions,
        "criterion":      criterion,
        "sport_type":     sport_type,
    }


@app.get("/api/overview/gps-scores")
async def get_overview_gps_scores() -> list[dict]:
    """Best global GPS score per device (best mode present in both track+urban, or best available)."""
    result = []
    async for doc in db().gps_scores.find():
        dev = await db().devices.find_one({"_id": doc["device_id"]}, {"name": 1})
        if not dev:
            continue

        track_modes = {m["name"].lower(): m for m in (doc.get("track") or {}).get("modes", [])}
        urban_modes = {m["name"].lower(): m for m in (doc.get("urban") or {}).get("modes", [])}

        best_global: float | None = None
        best_mode: str | None = None

        # Prefer modes present in both
        for key, urban in urban_modes.items():
            track = track_modes.get(key)
            if track:
                g = round(urban["urbanScore"] * 0.55 + track["trackScore"] * 0.35 + urban["consistencyScore"] * 0.10, 1)
                if best_global is None or g > best_global:
                    best_global = g
                    best_mode = urban["name"]

        # Fallback: track-only or urban-only
        if best_global is None and track_modes:
            bm = max(track_modes.values(), key=lambda m: m["trackScore"])
            best_global = bm["trackScore"]
            best_mode = bm["name"]
        elif best_global is None and urban_modes:
            bm = max(urban_modes.values(), key=lambda m: m["urbanScore"])
            best_global = bm["urbanScore"]
            best_mode = bm["name"]

        if best_global is None:
            continue

        result.append({
            "device_id":    str(doc["device_id"]),
            "name":         dev["name"],
            "global_score": best_global,
            "best_mode":    best_mode,
            "has_track":    bool(doc.get("track")),
            "has_urban":    bool(doc.get("urban")),
        })

    result.sort(key=lambda x: x["global_score"])  # ascending: worst → best (matches lollipop convention)
    return result


@app.get("/api/overview/hrv-scores")
async def get_overview_hrv_scores() -> list[dict]:
    """
    VFC (RMSSD) and FC-reposo (HR) scores per device.

    Aggregation method: Fisher Z-transform on per-session Pearson r values, then
    back-transform — identical to how FC sports correlations are aggregated.
    This avoids the pooling-artefact: concatenating windows across sessions with
    different mean HR levels artificially deflates Pearson r because between-session
    level shifts dominate the pooled variance.

    Primary source: summary.pearsonR / summary.pearsonRHR stored per session.
    Fallback (sessions without summary fields): compute Pearson r from raw windows.
    """
    def _fisher_z_mean(r_vals: list[float]) -> float | None:
        """Fisher Z-transform average of a list of Pearson r values."""
        zs = []
        for r in r_vals:
            r_c = max(min(float(r), 0.9999), -0.9999)
            zs.append(0.5 * math.log((1 + r_c) / (1 - r_c)))
        if not zs:
            return None
        z_mean = sum(zs) / len(zs)
        return round((math.exp(2 * z_mean) - 1) / (math.exp(2 * z_mean) + 1), 4)

    def _pearson_from_pts(pts: list[tuple[float, float]]) -> float | None:
        """Fallback: Pearson r from raw (x, y) pairs."""
        n = len(pts)
        if n < 3:
            return None
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        mx, my = sum(xs) / n, sum(ys) / n
        cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        sx  = math.sqrt(sum((x - mx) ** 2 for x in xs))
        sy  = math.sqrt(sum((y - my) ** 2 for y in ys))
        return round(cov / (sx * sy), 4) if sx * sy > 0 else None

    result = []
    async for dev in db().devices.find({}, {"name": 1}):
        dev_id = dev["_id"]
        sessions = await db().nocturnal_hrv_sessions.find(
            {"device_id": dev_id}, {"summary": 1, "windows": 1}
        ).to_list(None)
        if not sessions:
            continue

        rmssd_rs: list[float] = []
        hr_rs:    list[float] = []
        # Fallback pools for sessions without summary
        rmssd_fallback: list[tuple[float, float]] = []
        hr_fallback:    list[tuple[float, float]] = []

        for s in sessions:
            summ = s.get("summary") or {}

            # ── Primary: use per-session r from stored summary ────────────
            r_rmssd_sess = summ.get("pearsonR")
            r_hr_sess    = summ.get("pearsonRHR")

            if r_rmssd_sess is not None and isinstance(r_rmssd_sess, (int, float)):
                rmssd_rs.append(float(r_rmssd_sess))
            if r_hr_sess is not None and isinstance(r_hr_sess, (int, float)):
                hr_rs.append(float(r_hr_sess))

            # ── Fallback: collect raw window points for sessions without summary ──
            if r_rmssd_sess is None or r_hr_sess is None:
                for w in (s.get("windows") or []):
                    rp, rf = w.get("rmssdPolar"), w.get("rmssdFitbit")
                    hp, hf = w.get("hrPolar"),    w.get("hrFitbit")
                    if r_rmssd_sess is None and rp is not None and rf is not None:
                        rmssd_fallback.append((float(rp), float(rf)))
                    if r_hr_sess is None and hp is not None and hf is not None:
                        hr_fallback.append((float(hp), float(hf)))

        # If Fisher-Z list is empty, try fallback pool
        r_rmssd_agg = _fisher_z_mean(rmssd_rs) if rmssd_rs else _pearson_from_pts(rmssd_fallback)
        r_hr_agg    = _fisher_z_mean(hr_rs)    if hr_rs    else _pearson_from_pts(hr_fallback)

        if r_rmssd_agg is None and r_hr_agg is None:
            continue

        result.append({
            "device_id":  str(dev_id),
            "name":       dev["name"],
            "hrv_score":  round(r_rmssd_agg * 100, 1) if r_rmssd_agg is not None else None,
            "hr_score":   round(r_hr_agg    * 100, 1) if r_hr_agg    is not None else None,
            "n_sessions": len(sessions),
            # Diagnostic fields (not used by frontend, useful for debugging)
            "_n_rmssd_sessions": len(rmssd_rs),
            "_n_hr_sessions":    len(hr_rs),
        })

    result.sort(key=lambda x: (x.get("hrv_score") or 0))
    return result


@app.get("/api/overview/data")
async def get_overview_data(sport_type: str = "running") -> list[dict]:
    """
    Per-device aggregate data for the given sport_type with three independent views:
      balanced_by_session      — primary: equal weight per session (main result)
      weighted_by_samples      — secondary: concatenated signal
      difficulty_weighted_score — editorial score weighted by session difficulty
    """
    if sport_type not in VALID_SPORT_TYPES:
        raise HTTPException(status_code=422,
                            detail=f"sport_type debe ser uno de: {VALID_SPORT_TYPES}")

    devices = [d async for d in db().devices.find().sort("created_at", -1)]
    result = []

    for dev in devices:
        sessions = [
            s async for s in db().sessions.find(
                {"device_id": dev["_id"], "sport_type": sport_type},
                {
                    "metrics": 1, "session_difficulty": 1, "lag": 1,
                    "duration_seconds": 1, "training_type": 1, "fc_data": 1,
                },
            )
        ]
        if not sessions:
            continue

        session_results = [
            {
                "session_id":         str(s["_id"]),
                "sport_type":         sport_type,
                "training_type":      s.get("training_type", ""),
                "session_difficulty": s.get("session_difficulty", ""),
                "metrics":            s.get("metrics") or {},
                "lag":                s.get("lag", 0),
                "duration_seconds":   s.get("duration_seconds", 0),
                "fc_data":            s.get("fc_data") or {},
            }
            for s in sessions
        ]

        try:
            sport_agg = generate_sport_aggregate(session_results)
        except Exception:
            continue

        difficulty_weighted = _weighted_global_score(session_results)
        total_samples = (sport_agg.get("weighted_by_samples") or {}).get("n_samples", 0)
        bal = sport_agg["balanced_by_session"]

        result.append({
            "device_id":              str(dev["_id"]),
            "device_name":            dev["name"],
            "reference_name":         dev["reference_name"],
            "sport_type":             sport_type,
            "session_count":          len(sessions),
            "total_samples":          total_samples,
            "balanced_by_session":    bal,
            "weighted_by_samples":    sport_agg.get("weighted_by_samples"),
            "difficulty_weighted_score": difficulty_weighted,
            "bland_altman":           sport_agg["bland_altman"],
            "sessions":               sport_agg["per_session"],
            # ── Flat aliases for frontend backward compat ─────────────────
            "name":         dev["name"],
            "ccc_global":   bal.get("ccc")              or 0.0,
            "r_global":     bal.get("pearson_fisher")   or 0.0,
            "mae_global":   bal.get("mae")              or 0.0,
            "bias_global":  bal.get("bias")             or 0.0,
            "lag_mean":     bal.get("lag_mean_seconds") or 0.0,
            "total_weight": len(sessions),
        })

    result.sort(
        key=lambda x: (x.get("balanced_by_session") or {}).get("mae") or float("inf")
    )
    return result


# ─────────────────────────────────────────────────────────────────────────────
# SPORT-LEVEL AGGREGATE CHARTS  (per device + sport)
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/devices/{device_id}/sport-aggregate/{sport_type}")
async def get_sport_aggregate_charts(device_id: str, sport_type: str) -> dict:
    """
    Returns balanced metrics + two independent charts for all sessions of a
    given device and sport:
      - correlation_chart: scatter coloured by session
      - bland_altman_chart: BA plot with per-session bias segments
    """
    if sport_type not in VALID_SPORT_TYPES:
        raise HTTPException(status_code=422,
                            detail=f"sport_type debe ser uno de: {VALID_SPORT_TYPES}")

    dev_doc = await db().devices.find_one({"_id": _oid(device_id)})
    if not dev_doc:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    sessions = [
        s async for s in db().sessions.find(
            {"device_id": _oid(device_id), "sport_type": sport_type},
            {"fc_data": 1, "metrics": 1, "session_difficulty": 1,
             "lag": 1, "duration_seconds": 1, "training_type": 1,
             "session_name": 1},
        ).sort("activity_date", 1)
    ]

    if not sessions:
        raise HTTPException(
            status_code=404,
            detail=f"No hay sesiones de {sport_type} para este dispositivo",
        )

    dev_name = dev_doc["name"]
    ref_name = dev_doc["reference_name"]

    # Build session_data for chart functions
    session_data = []
    session_results = []
    for s in sessions:
        fc   = s.get("fc_data") or {}
        ref  = fc.get("reference", [])
        dev  = fc.get("device", [])
        m    = s.get("metrics") or {}
        name = s.get("session_name") or s.get("training_type") or "Sesión"
        diff_lbl = s.get("session_difficulty") or s.get("training_type") or ""
        label = f"{name} ({diff_lbl})" if diff_lbl else name

        if ref and dev:
            session_data.append({
                "label": label,
                "ref":   ref,
                "dev":   dev,
                "mae":   m.get("mae"),
                "bias":  m.get("bias"),
                "loa_l": m.get("loa_l"),
                "loa_u": m.get("loa_u"),
            })

        session_results.append({
            "session_id":         str(s["_id"]),
            "sport_type":         sport_type,
            "training_type":      s.get("training_type", ""),
            "session_difficulty": s.get("session_difficulty", ""),
            "metrics":            m,
            "lag":                s.get("lag", 0),
            "duration_seconds":   s.get("duration_seconds", 0),
            "fc_data":            fc,
        })

    if not session_data:
        raise HTTPException(status_code=422,
                            detail="Las sesiones no tienen datos de FC almacenados.")

    chart_data = build_sport_chart_data(session_data)

    try:
        agg = generate_sport_aggregate(session_results)
    except Exception:
        agg = {}

    return {
        "device_name":         dev_name,
        "reference_name":      ref_name,
        "sport_type":          sport_type,
        "session_count":       len(sessions),
        "sessions_with_data":  len(session_data),
        "sessions":            chart_data["sessions"],
        "global_stats":        chart_data["global_stats"],
        "balanced_by_session": agg.get("balanced_by_session"),
        "per_session":         agg.get("per_session", []),
    }


# ─────────────────────────────────────────────────────────────────────────────
# AGGREGATE  (scoped to device + training type)
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/aggregate")
async def create_aggregate(body: dict) -> dict:
    """
    Aggregate analysis for selected sessions.

    Body: {
        "session_ids": ["..."],
        "training_type": "...",           # optional label for legacy chart
        "allow_mixed_sports": false        # set true only for exploratory cross-sport analysis
    }

    Returns three independent aggregate views:
        balanced_by_session  — primary: equal weight per session
        weighted_by_samples  — secondary: concatenated signal
        difficulty_weighted_score — editorial score by session difficulty
    """
    session_ids       = body.get("session_ids", [])
    training_type     = body.get("training_type", "Agregado")
    allow_mixed       = bool(body.get("allow_mixed_sports", False))

    if not session_ids:
        raise HTTPException(status_code=400, detail="Se requiere al menos una sesión.")

    raw_docs: list[dict] = []
    device_ids:  set[str] = set()
    sport_types: set[str] = set()

    for sid in session_ids:
        doc = await db().sessions.find_one(
            {"_id": _oid(sid)},
            {
                "fc_data": 1, "device_name": 1, "reference_name": 1,
                "device_id": 1, "sport_type": 1, "training_type": 1,
                "session_difficulty": 1, "metrics": 1, "lag": 1,
                "duration_seconds": 1,
            },
        )
        if doc:
            raw_docs.append(doc)
            device_ids.add(str(doc.get("device_id", "")))
            sp = doc.get("sport_type")
            if sp:
                sport_types.add(sp)

    if not raw_docs:
        raise HTTPException(status_code=404, detail="No se encontraron sesiones.")

    # ── Validate sport consistency ────────────────────────────────────────────
    if len(sport_types) > 1 and not allow_mixed:
        raise HTTPException(
            status_code=400,
            detail={
                "error":       "mixed_sport_types",
                "message":     "Todas las sesiones del agregado deben pertenecer al mismo deporte.",
                "sport_types": sorted(sport_types),
            },
        )

    sport_type = next(iter(sport_types), "mixed") if sport_types else "unknown"

    # ── Build session_results for generate_sport_aggregate ───────────────────
    session_results = [
        {
            "session_id":         str(d["_id"]),
            "sport_type":         d.get("sport_type", ""),
            "training_type":      d.get("training_type", ""),
            "session_difficulty": d.get("session_difficulty", ""),
            "metrics":            d.get("metrics") or {},
            "lag":                d.get("lag", 0),
            "duration_seconds":   d.get("duration_seconds", 0),
            "fc_data":            d.get("fc_data") or {},
        }
        for d in raw_docs
    ]

    try:
        sport_agg = generate_sport_aggregate(session_results)
    except Exception as exc:
        log.error("Unhandled exception", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))

    difficulty_weighted = _weighted_global_score(session_results)

    # ── Legacy sample-weighted chart (kept for backward compat) ──────────────
    dev_names = list({d.get("device_name", "Dispositivo") for d in raw_docs})
    ref_names = list({d.get("reference_name", "Referencia") for d in raw_docs})
    dev_name  = dev_names[0] if len(dev_names) == 1 else "Múltiples"
    ref_name  = ref_names[0] if len(ref_names) == 1 else "Múltiples"

    try:
        legacy_chart_result = generate_aggregate_analysis(
            raw_docs, training_type, dev_name, ref_name
        )
    except Exception:
        legacy_chart_result = {}

    # ── Backward-compat flat fields expected by the frontend ─────────────────
    # The template reads: result.metrics, result.zones, result.chart,
    # result.n_sessions, result.total_samples
    legacy_metrics = legacy_chart_result.get("metrics") or {}
    legacy_zones   = legacy_chart_result.get("zones",  [])
    legacy_chart   = legacy_chart_result.get("chart")
    total_samples  = (sport_agg.get("weighted_by_samples") or {}).get("n_samples") \
                     or legacy_chart_result.get("total_samples", 0)

    return {
        "device":              dev_name,
        "reference":           ref_name,
        "sport_type":          sport_type,
        "allow_mixed_sports":  allow_mixed,
        **sport_agg,
        "difficulty_weighted_score": difficulty_weighted,
        # ── Legacy flat aliases ──────────────────────────────────────────────
        "metrics":       legacy_metrics,
        "zones":         legacy_zones,
        "chart":         legacy_chart,
        "n_sessions":    sport_agg["session_count"],
        "total_samples": total_samples,
        "fcmax":         legacy_chart_result.get("fcmax", 0),
    }


# ─────────────────────────────────────────────────────────────────────────────
# GPS TESTS
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/devices/{device_id}/gps-tests", status_code=201)
async def create_gps_test(device_id: str, body: dict) -> dict:
    if not await db().devices.find_one({"_id": _oid(device_id)}):
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")
    modes = body.get("modes", [])
    if not modes:
        raise HTTPException(status_code=422, detail="Se requiere al menos un modo GPS")
    doc = {
        "device_id":          ObjectId(device_id),
        "name":               body.get("name") or f"Test GPS {datetime.now().strftime('%d/%m/%Y %H:%M')}",
        "reference_distance": float(body.get("reference_distance", 1600)),
        "modes":              modes,
        "created_at":         datetime.utcnow(),
    }
    inserted = await db().gps_tests.insert_one(doc)
    doc["_id"] = inserted.inserted_id
    return _ser_gps_test(doc, include_points=False)


@app.get("/api/devices/{device_id}/gps-tests")
async def list_gps_tests(device_id: str) -> list[dict]:
    return [
        _ser_gps_test(d, include_points=False)
        async for d in db().gps_tests.find(
            {"device_id": _oid(device_id)}
        ).sort("created_at", -1)
    ]


@app.get("/api/gps-tests/{test_id}")
async def get_gps_test(test_id: str) -> dict:
    doc = await db().gps_tests.find_one({"_id": _oid(test_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Test GPS no encontrado")
    return _ser_gps_test(doc, include_points=True)


@app.delete("/api/gps-tests/{test_id}")
async def delete_gps_test(test_id: str) -> dict:
    result = await db().gps_tests.delete_one({"_id": _oid(test_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Test GPS no encontrado")
    return {"deleted": True}


@app.get("/api/gps-tests/{test_id}/ai-analysis")
async def get_gps_test_ai_analysis(test_id: str) -> dict:
    doc = await db().gps_tests.find_one({"_id": _oid(test_id)}, {"ai_analysis": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Test GPS no encontrado")
    ai = doc.get("ai_analysis")
    if not ai:
        raise HTTPException(status_code=404, detail="Análisis IA no generado aún")
    return ai


@app.post("/api/gps-tests/{test_id}/ai-analysis", status_code=200)
async def create_gps_test_ai_analysis(test_id: str, body: dict) -> dict:
    doc = await db().gps_tests.find_one({"_id": _oid(test_id)}, {"name": 1, "reference_distance": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Test GPS no encontrado")

    modes_stats = body.get("modes_stats", [])
    if not modes_stats:
        raise HTTPException(status_code=422, detail="Se requieren estadísticas de los modos")

    try:
        result = await generate_gps_track_ai_analysis(
            doc.get("name", "Test GPS"),
            float(doc.get("reference_distance", 1600)),
            modes_stats,
        )
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        log.error("Unhandled exception", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error generando análisis IA: {exc}")

    await db().gps_tests.update_one(
        {"_id": _oid(test_id)},
        {"$set": {"ai_analysis": result}},
    )
    return result


# ── URBAN TESTS ───────────────────────────────────────────────────────────────

@app.post("/api/devices/{device_id}/urban-tests", status_code=201)
async def create_urban_test(device_id: str, body: dict) -> dict:
    if not await db().devices.find_one({"_id": _oid(device_id)}):
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")
    modes = body.get("modes", [])
    if not modes:
        raise HTTPException(status_code=422, detail="Se requiere al menos un modo GPS")
    doc = {
        "device_id":    ObjectId(device_id),
        "name":         body.get("name") or f"Test Urbano {datetime.now().strftime('%d/%m/%Y %H:%M')}",
        "ref_filename": body.get("ref_filename", ""),
        "ref_points":   body.get("ref_points", []),
        "modes":        modes,
        "created_at":   datetime.utcnow(),
    }
    inserted = await db().urban_tests.insert_one(doc)
    doc["_id"] = inserted.inserted_id
    return _ser_urban_test(doc, include_points=False)


@app.get("/api/devices/{device_id}/urban-tests")
async def list_urban_tests(device_id: str) -> list[dict]:
    return [
        _ser_urban_test(d, include_points=False)
        async for d in db().urban_tests.find(
            {"device_id": _oid(device_id)}
        ).sort("created_at", -1)
    ]


@app.get("/api/urban-tests/{test_id}")
async def get_urban_test(test_id: str) -> dict:
    doc = await db().urban_tests.find_one({"_id": _oid(test_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Test urbano no encontrado")
    return _ser_urban_test(doc, include_points=True)


@app.delete("/api/urban-tests/{test_id}")
async def delete_urban_test(test_id: str) -> dict:
    result = await db().urban_tests.delete_one({"_id": _oid(test_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Test urbano no encontrado")
    return {"deleted": True}


@app.get("/api/urban-tests/{test_id}/ai-analysis")
async def get_urban_test_ai_analysis(test_id: str) -> dict:
    doc = await db().urban_tests.find_one({"_id": _oid(test_id)}, {"ai_analysis": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Test urbano no encontrado")
    ai = doc.get("ai_analysis")
    if not ai:
        raise HTTPException(status_code=404, detail="Análisis IA no generado aún")
    return ai


@app.post("/api/urban-tests/{test_id}/ai-analysis", status_code=200)
async def create_urban_test_ai_analysis(test_id: str, body: dict) -> dict:
    doc = await db().urban_tests.find_one({"_id": _oid(test_id)}, {"name": 1, "ref_points": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Test urbano no encontrado")

    modes_stats = body.get("modes_stats", [])
    if not modes_stats:
        raise HTTPException(status_code=422, detail="Se requieren estadísticas de los modos")

    ref_points = doc.get("ref_points", [])
    ref_meters = float(body.get("ref_meters", len(ref_points)))

    try:
        result = await generate_gps_urban_ai_analysis(
            doc.get("name", "Test Urbano"),
            ref_meters,
            modes_stats,
        )
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        log.error("Unhandled exception", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error generando análisis IA: {exc}")

    await db().urban_tests.update_one(
        {"_id": _oid(test_id)},
        {"$set": {"ai_analysis": result}},
    )
    return result


# ─────────────────────────────────────────────────────────────────────────────
# AI ANALYSIS  (session-level)
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/sessions/{session_id}/ai-analysis")
async def get_session_ai_analysis(session_id: str) -> dict:
    """Return stored AI analysis for a session, or 404 if not generated yet."""
    doc = await db().sessions.find_one(
        {"_id": _oid(session_id)},
        {"ai_analysis": 1},
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")
    ai = doc.get("ai_analysis")
    if not ai:
        raise HTTPException(status_code=404, detail="Análisis IA no generado aún")
    return ai


@app.post("/api/sessions/{session_id}/ai-analysis", status_code=200)
async def create_session_ai_analysis(session_id: str, body: dict = None) -> dict:
    """Generate (or re-generate) the AI analysis for a session.
    If body contains interval_* keys, analyse only that time window and do NOT persist."""
    doc = await db().sessions.find_one({"_id": _oid(session_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")

    body = body or {}
    is_interval = bool(body.get("interval_metrics"))

    if is_interval:
        # Build an ephemeral session doc overriding metrics/zones/fc_data with interval data
        session_doc = {
            **doc,
            "metrics":          body["interval_metrics"],
            "zones":            body.get("interval_zones", []),
            "fc_data":          body.get("interval_fc_data", {}),
            "lag":              body.get("interval_lag", 0),
            "fcmax":            body.get("interval_fcmax", 0),
            "duration_seconds": body.get("interval_duration", 0),
        }
    else:
        session_doc = doc

    try:
        result = await generate_session_ai_analysis(session_doc)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        log.error("Unhandled exception", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error al llamar a Claude: {exc}")

    if not is_interval:
        await db().sessions.update_one(
            {"_id": _oid(session_id)},
            {"$set": {"ai_analysis": result}},
        )
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ── GPS SCORES ────────────────────────────────────────────────────────────────

@app.get("/api/devices/{device_id}/gps-scores")
async def get_gps_scores(device_id: str) -> dict:
    doc = await db().gps_scores.find_one({"device_id": _oid(device_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Sin puntuaciones GPS guardadas")
    return {
        "track": doc.get("track"),
        "urban": doc.get("urban"),
    }


@app.put("/api/devices/{device_id}/gps-scores", status_code=200)
async def save_gps_scores(device_id: str, body: dict) -> dict:
    if not await db().devices.find_one({"_id": _oid(device_id)}):
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")
    score_type = body.get("type")  # "track" or "urban"
    data       = body.get("data")
    if score_type not in ("track", "urban") or not data:
        raise HTTPException(status_code=422, detail="type ('track'|'urban') y data son obligatorios")
    await db().gps_scores.update_one(
        {"device_id": _oid(device_id)},
        {"$set": {"device_id": _oid(device_id), score_type: data}},
        upsert=True,
    )
    return {"ok": True}


# AI VERDICT  (device-level)
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/devices/{device_id}/ai-verdict")
async def get_device_ai_verdict(device_id: str) -> dict:
    """Return stored AI verdict for a device, or 404 if not generated yet."""
    doc = await db().devices.find_one(
        {"_id": _oid(device_id)},
        {"ai_verdict": 1},
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")
    verdict = doc.get("ai_verdict")
    if not verdict:
        raise HTTPException(status_code=404, detail="Veredicto IA no generado aún")
    return verdict


@app.post("/api/devices/{device_id}/ai-verdict", status_code=200)
async def create_device_ai_verdict(device_id: str) -> dict:
    """Generate (or re-generate) the AI verdict for a device using all its sessions."""
    dev_doc = await db().devices.find_one({"_id": _oid(device_id)})
    if not dev_doc:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    sessions = [
        s async for s in db().sessions.find(
            {"device_id": _oid(device_id)},
            {"metrics": 1, "zones": 1, "lag": 1, "sport_type": 1,
             "session_difficulty": 1, "training_type": 1, "session_name": 1},
        )
    ]
    if not sessions:
        raise HTTPException(status_code=422,
                            detail="El dispositivo no tiene sesiones para analizar")

    try:
        result = await generate_device_ai_verdict(
            dev_doc["name"], dev_doc["reference_name"], sessions,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        log.error("Unhandled exception", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error al llamar a GPT: {exc}")

    await db().devices.update_one(
        {"_id": _oid(device_id)},
        {"$set": {"ai_verdict": result}},
    )
    return result


# ─────────────────────────────────────────────────────────────────────────────
# NOCTURNAL HRV SESSIONS
# ─────────────────────────────────────────────────────────────────────────────

def _ser_nocturnal_hrv(doc: dict, *, include_windows: bool = True) -> dict:
    doc["id"] = str(doc.pop("_id"))
    if "device_id" in doc:
        doc["device_id"] = str(doc["device_id"])
    if isinstance(doc.get("created_at"), datetime):
        doc["created_at"] = doc["created_at"].isoformat()
    doc.pop("polar_rr_bytes", None)
    doc.pop("polar_hr_bytes", None)
    doc.pop("fitbit_hrv_bytes", None)
    doc.pop("fitbit_hr_bytes", None)
    doc.pop("huawei_bytes", None)
    if not include_windows:
        doc.pop("windows", None)
    return doc


@app.get("/api/devices/{device_id}/nocturnal-hrv/aggregated")
async def get_nocturnal_hrv_aggregated(device_id: str) -> dict:
    """Aggregate RMSSD and HR windows from all sessions for one device."""
    if not await db().devices.find_one({"_id": _oid(device_id)}):
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    projection = {"windows": 1, "session_name": 1, "created_at": 1}
    sessions = await db().nocturnal_hrv_sessions.find(
        {"device_id": _oid(device_id)}, projection
    ).sort("created_at", 1).to_list(None)

    rmssd_by_session: list[dict] = []
    hr_by_session:    list[dict] = []

    for s in sessions:
        s_name = s.get("session_name", "")
        s_id   = str(s["_id"])
        rpts, hpts = [], []
        for w in (s.get("windows") or []):
            rp, rf = w.get("rmssdPolar"), w.get("rmssdFitbit")
            hp, hf = w.get("hrPolar"),    w.get("hrFitbit")
            if rp is not None and rf is not None:
                rpts.append({"x": rp, "y": rf})
            if hp is not None and hf is not None:
                hpts.append({"x": hp, "y": hf})
        if rpts:
            rmssd_by_session.append({"session_id": s_id, "session_name": s_name, "points": rpts})
        if hpts:
            hr_by_session.append({"session_id": s_id, "session_name": s_name, "points": hpts})

    def _stats(by_session: list[dict]) -> dict | None:
        all_pts = [p for s in by_session for p in s["points"]]
        n = len(all_pts)
        if n < 3:
            return None
        xs = [p["x"] for p in all_pts]
        ys = [p["y"] for p in all_pts]
        mx, my = sum(xs) / n, sum(ys) / n
        diffs  = [y - x for x, y in zip(xs, ys)]
        bias   = sum(diffs) / n
        sd     = math.sqrt(sum((d - bias) ** 2 for d in diffs) / (n - 1))
        cov    = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        sx_v   = math.sqrt(sum((x - mx) ** 2 for x in xs))
        sy_v   = math.sqrt(sum((y - my) ** 2 for y in ys))
        r      = cov / (sx_v * sy_v) if sx_v * sy_v > 0 else None
        slope  = cov / (sx_v ** 2) if sx_v > 0 else None
        icpt   = my - slope * mx if slope is not None else None
        return {
            "n":          n,
            "polarMean":  round(mx, 2),
            "fitbitMean": round(my, 2),
            "bias":       round(bias, 2),
            "sd":         round(sd, 2),
            "upperLoa":   round(bias + 1.96 * sd, 2),
            "lowerLoa":   round(bias - 1.96 * sd, 2),
            "mae":        round(sum(abs(d) for d in diffs) / n, 2),
            "pearsonR":   round(r, 4) if r is not None else None,
            "slope":      round(slope, 4) if slope is not None else None,
            "intercept":  round(icpt, 2) if icpt is not None else None,
        }

    return {
        "n_sessions": len(sessions),
        "rmssd": {"stats": _stats(rmssd_by_session), "by_session": rmssd_by_session},
        "hr":    {"stats": _stats(hr_by_session),    "by_session": hr_by_session},
    }


@app.get("/api/devices/{device_id}/nocturnal-hrv/ai-analysis")
async def get_nocturnal_hrv_global_ai(device_id: str) -> dict:
    doc = await db().devices.find_one({"_id": _oid(device_id)}, {"nocturnal_hrv_global_ai": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")
    ai = doc.get("nocturnal_hrv_global_ai")
    if not ai:
        raise HTTPException(status_code=404, detail="Análisis IA global no generado aún")
    return ai


@app.post("/api/devices/{device_id}/nocturnal-hrv/ai-analysis", status_code=200)
async def create_nocturnal_hrv_global_ai(device_id: str) -> dict:
    device = await db().devices.find_one({"_id": _oid(device_id)}, {"name": 1})
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    projection = {"windows": 1, "session_name": 1}
    sessions = await db().nocturnal_hrv_sessions.find(
        {"device_id": _oid(device_id)}, projection
    ).sort("created_at", 1).to_list(None)

    if not sessions:
        raise HTTPException(status_code=422, detail="No hay sesiones guardadas para este dispositivo")

    rmssd_by_session, hr_by_session = [], []
    for s in sessions:
        rpts, hpts = [], []
        for w in (s.get("windows") or []):
            rp, rf = w.get("rmssdPolar"), w.get("rmssdFitbit")
            hp, hf = w.get("hrPolar"),    w.get("hrFitbit")
            if rp is not None and rf is not None:
                rpts.append({"x": rp, "y": rf})
            if hp is not None and hf is not None:
                hpts.append({"x": hp, "y": hf})
        if rpts:
            rmssd_by_session.append({"session_name": s.get("session_name", ""), "points": rpts})
        if hpts:
            hr_by_session.append({"session_name": s.get("session_name", ""), "points": hpts})

    def _agg_stats(by_sess):
        all_pts = [p for s in by_sess for p in s["points"]]
        n = len(all_pts)
        if n < 3:
            return None
        xs, ys = [p["x"] for p in all_pts], [p["y"] for p in all_pts]
        mx, my = sum(xs) / n, sum(ys) / n
        diffs = [y - x for x, y in zip(xs, ys)]
        bias = sum(diffs) / n
        sd = math.sqrt(sum((d - bias) ** 2 for d in diffs) / (n - 1))
        cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        sx_v = math.sqrt(sum((x - mx) ** 2 for x in xs))
        sy_v = math.sqrt(sum((y - my) ** 2 for y in ys))
        r = cov / (sx_v * sy_v) if sx_v * sy_v > 0 else None
        return {
            "n": n, "polarMean": round(mx, 2), "fitbitMean": round(my, 2),
            "bias": round(bias, 2), "sd": round(sd, 2),
            "upperLoa": round(bias + 1.96 * sd, 2), "lowerLoa": round(bias - 1.96 * sd, 2),
            "mae": round(sum(abs(d) for d in diffs) / n, 2),
            "pearsonR": round(r, 4) if r is not None else None,
        }

    try:
        result = await generate_nocturnal_hrv_global_ai_analysis(
            device_name  = device.get("name", "Dispositivo"),
            n_sessions   = len(sessions),
            rmssd_stats  = _agg_stats(rmssd_by_session),
            hr_stats     = _agg_stats(hr_by_session),
            by_session   = rmssd_by_session,
        )
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        log.error("Unhandled exception", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error generando análisis IA: {exc}")

    await db().devices.update_one(
        {"_id": _oid(device_id)},
        {"$set": {"nocturnal_hrv_global_ai": result}},
    )
    return result


@app.post("/api/devices/{device_id}/nocturnal-hrv", status_code=201)
async def create_nocturnal_hrv_session(
    device_id:       str,
    polar_rr_file:    Optional[UploadFile] = File(default=None),
    polar_hr_file:    Optional[UploadFile] = File(default=None),
    fitbit_hrv_file:  Optional[UploadFile] = File(default=None),
    fitbit_hr_file:   Optional[UploadFile] = File(default=None),
    huawei_file:      Optional[UploadFile] = File(default=None),
    secondary_source: str = Form(default="fitbit"),
    session_name:     str = Form(default=""),
    windows_json:     str = Form(default="[]"),
    summary_json:     str = Form(default="{}"),
    settings_json:    str = Form(default="{}"),
) -> dict:
    if not await db().devices.find_one({"_id": _oid(device_id)}):
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")
    try:
        windows  = json.loads(windows_json)
        summary  = json.loads(summary_json)
        settings = json.loads(settings_json)
    except Exception:
        raise HTTPException(status_code=422, detail="JSON inválido en los metadatos")

    doc: dict[str, Any] = {
        "device_id":        ObjectId(device_id),
        "session_name":     session_name.strip() or f"HRV Nocturno {datetime.now().strftime('%d/%m/%Y %H:%M')}",
        "windows":          windows,
        "summary":          summary,
        "settings":         settings,
        "secondary_source": secondary_source if secondary_source in ("fitbit", "huawei") else "fitbit",
        "created_at":       datetime.utcnow(),
    }

    for f, bkey, nkey in [
        (polar_rr_file,   "polar_rr_bytes",   "polar_rr_filename"),
        (polar_hr_file,   "polar_hr_bytes",   "polar_hr_filename"),
        (fitbit_hrv_file, "fitbit_hrv_bytes", "fitbit_hrv_filename"),
        (fitbit_hr_file,  "fitbit_hr_bytes",  "fitbit_hr_filename"),
        (huawei_file,     "huawei_bytes",     "huawei_filename"),
    ]:
        if f and f.filename:
            doc[bkey] = Binary(await f.read())
            doc[nkey] = f.filename

    inserted = await db().nocturnal_hrv_sessions.insert_one(doc)
    doc["_id"] = inserted.inserted_id
    return _ser_nocturnal_hrv(doc, include_windows=False)


@app.get("/api/devices/{device_id}/nocturnal-hrv")
async def list_nocturnal_hrv_sessions(device_id: str) -> list[dict]:
    projection = {
        "polar_rr_bytes": 0, "polar_hr_bytes": 0,
        "fitbit_hrv_bytes": 0, "fitbit_hr_bytes": 0,
        "huawei_bytes": 0,
        "windows": 0,
    }
    return [
        _ser_nocturnal_hrv(d, include_windows=False)
        async for d in db().nocturnal_hrv_sessions.find(
            {"device_id": _oid(device_id)}, projection,
        ).sort("created_at", -1)
    ]


@app.get("/api/nocturnal-hrv/{session_id}")
async def get_nocturnal_hrv_session(session_id: str) -> dict:
    projection = {
        "polar_rr_bytes": 0, "polar_hr_bytes": 0,
        "fitbit_hrv_bytes": 0, "fitbit_hr_bytes": 0,
        "huawei_bytes": 0,
    }
    doc = await db().nocturnal_hrv_sessions.find_one({"_id": _oid(session_id)}, projection)
    if not doc:
        raise HTTPException(status_code=404, detail="Sesión HRV no encontrada")
    return _ser_nocturnal_hrv(doc, include_windows=True)


@app.delete("/api/nocturnal-hrv/{session_id}")
async def delete_nocturnal_hrv_session(session_id: str) -> dict:
    result = await db().nocturnal_hrv_sessions.delete_one({"_id": _oid(session_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Sesión HRV no encontrada")
    return {"deleted": True}


@app.get("/api/nocturnal-hrv/{session_id}/ai-analysis")
async def get_nocturnal_hrv_ai_analysis(session_id: str) -> dict:
    doc = await db().nocturnal_hrv_sessions.find_one(
        {"_id": _oid(session_id)}, {"ai_analysis": 1}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Sesión HRV no encontrada")
    ai = doc.get("ai_analysis")
    if not ai:
        raise HTTPException(status_code=404, detail="Análisis IA no generado aún")
    return ai


@app.post("/api/nocturnal-hrv/{session_id}/ai-analysis", status_code=200)
async def create_nocturnal_hrv_ai_analysis(session_id: str) -> dict:
    doc = await db().nocturnal_hrv_sessions.find_one(
        {"_id": _oid(session_id)}, {"session_name": 1, "summary": 1, "windows": 1}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Sesión HRV no encontrada")

    summary = doc.get("summary") or {}
    windows = doc.get("windows") or []
    if not summary:
        raise HTTPException(status_code=422, detail="La sesión no tiene datos de resumen calculados")

    try:
        result = await generate_nocturnal_hrv_ai_analysis(
            session_name=doc.get("session_name", "HRV Nocturno"),
            summary=summary,
            n_windows=len(windows),
        )
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        log.error("Unhandled exception", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error generando análisis IA: {exc}")

    await db().nocturnal_hrv_sessions.update_one(
        {"_id": _oid(session_id)},
        {"$set": {"ai_analysis": result}},
    )
    return result

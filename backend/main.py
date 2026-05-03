"""
FastAPI backend for HR Analyzer.
Hierarchy: Device → Training Type → Sessions
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any, Optional

from bson import Binary, ObjectId
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from motor.motor_asyncio import AsyncIOMotorClient

from analyzer import (analyze_session, generate_aggregate_analysis,
                      generate_overview_chart, _weighted_global_score)

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
    if not keep_fc:
        doc.pop("fc_data", None)
    # Never expose raw binary file bytes in API responses
    doc.pop("device_file_bytes", None)
    doc.pop("reference_file_bytes", None)
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
        raise HTTPException(status_code=422, detail=str(exc))

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

    cursor = db().sessions.find(query, {"fc_data": 0}).sort("created_at", -1)
    return [_ser(d) async for d in cursor]


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
        raise HTTPException(status_code=422, detail=str(exc))

    await db().sessions.update_one({"_id": _oid(session_id)}, {"$set": result})

    updated = await db().sessions.find_one({"_id": _oid(session_id)})
    return _ser(updated, keep_fc=True)


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
async def get_overview_chart(sport_type: str = "running") -> dict:
    """
    Build a global comparison chart for every device that has sessions of the
    given sport_type. Uses difficulty-weighted scoring (MAE_rel, bias, Fisher r).
    Returns { chart: base64_png, device_count: int, total_sessions: int }.
    """
    if sport_type not in VALID_SPORT_TYPES:
        raise HTTPException(status_code=422, detail=f"sport_type debe ser uno de: {VALID_SPORT_TYPES}")

    devices = [d async for d in db().devices.find()]
    if not devices:
        raise HTTPException(status_code=404, detail="No hay dispositivos con sesiones.")

    devices_data = []
    total_sessions = 0

    for dev in devices:
        sessions = [
            s async for s in db().sessions.find(
                {"device_id": dev["_id"], "sport_type": sport_type},
                {"fc_data": 1, "metrics": 1, "training_type": 1, "session_difficulty": 1},
            )
        ]
        if not sessions:
            continue

        fc_data_list = [s["fc_data"] for s in sessions if s.get("fc_data")]
        if not fc_data_list:
            continue

        sessions_info = [
            {
                "session_difficulty": s.get("session_difficulty", ""),
                "metrics":            s.get("metrics", {}),
            }
            for s in sessions if s.get("fc_data")
        ]

        devices_data.append({
            "name":           dev["name"],
            "reference_name": dev["reference_name"],
            "fc_data_list":   fc_data_list,
            "sessions_info":  sessions_info,
            "session_count":  len(sessions),
        })
        total_sessions += len(sessions)

    if not devices_data:
        raise HTTPException(status_code=404,
                            detail="No hay sesiones con datos suficientes.")

    try:
        chart = generate_overview_chart(devices_data)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return {
        "chart":          chart,
        "device_count":   len(devices_data),
        "total_sessions": total_sessions,
    }


@app.get("/api/overview/data")
async def get_overview_data(sport_type: str = "running") -> list[dict]:
    """
    Structured per-device weighted scores for the given sport_type.
    Used by the frontend to render an interactive ng2-charts comparison chart.
    Returns list sorted descending by r_global.
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
                {"metrics": 1, "session_difficulty": 1, "_id": 0},
            )
        ]
        if not sessions:
            continue

        score = _weighted_global_score(sessions)
        if score is None:
            continue

        result.append({
            "name":           dev["name"],
            "reference_name": dev["reference_name"],
            "r_global":       score["r_global"],
            "mae_global":     score["mae_global"],
            "bias_global":    score["bias_global"],
            "session_count":  score["n_weighted"],
            "total_weight":   score["total_weight"],
        })

    result.sort(key=lambda x: x["r_global"], reverse=True)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# AGGREGATE  (scoped to device + training type)
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/aggregate")
async def create_aggregate(body: dict) -> dict:
    """
    Aggregate analysis for selected sessions.
    Body: { "session_ids": ["..."], "training_type": "..." }
    """
    session_ids   = body.get("session_ids", [])
    training_type = body.get("training_type", "Agregado")

    if not session_ids:
        raise HTTPException(status_code=400, detail="Se requiere al menos una sesión.")

    sessions_data: list[dict] = []
    dev_names: list[str] = []
    ref_names: list[str] = []

    for sid in session_ids:
        doc = await db().sessions.find_one(
            {"_id": _oid(sid)},
            {"fc_data": 1, "device_name": 1, "reference_name": 1},
        )
        if doc:
            sessions_data.append(doc)
            dev_names.append(doc.get("device_name", "Dispositivo"))
            ref_names.append(doc.get("reference_name", "Referencia"))

    if not sessions_data:
        raise HTTPException(status_code=404, detail="No se encontraron sesiones.")

    dev_name = dev_names[0] if len(set(dev_names)) == 1 else "Dispositivo"
    ref_name = ref_names[0] if len(set(ref_names)) == 1 else "Referencia"

    try:
        result = generate_aggregate_analysis(sessions_data, training_type, dev_name, ref_name)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return result

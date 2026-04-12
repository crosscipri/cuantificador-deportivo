"""
FastAPI backend for HR Analyzer.
Endpoints for uploading FIT sessions, querying results and generating aggregate analysis.
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any, Optional

from bson import ObjectId
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient

from analyzer import analyze_session, generate_aggregate_analysis

load_dotenv()

# ─────────────────────────────────────────────────────────────────────────────
# App & CORS
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="HR Analyzer API", version="1.0.0")

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
DB_NAME   = os.getenv("DB_NAME", "hr_analyzer")


@app.on_event("startup")
async def startup() -> None:
    app.state.mongo = AsyncIOMotorClient(MONGO_URL)
    app.state.db    = app.state.mongo[DB_NAME]
    # Indexes
    await app.state.db.sessions.create_index("training_type")
    await app.state.db.sessions.create_index([("created_at", -1)])


@app.on_event("shutdown")
async def shutdown() -> None:
    app.state.mongo.close()


def db():
    return app.state.db


# ─────────────────────────────────────────────────────────────────────────────
# Serialisation helper
# ─────────────────────────────────────────────────────────────────────────────

def _serialise(doc: dict, include_fc_data: bool = False) -> dict:
    doc["id"] = str(doc.pop("_id"))
    if isinstance(doc.get("created_at"), datetime):
        doc["created_at"] = doc["created_at"].isoformat()
    if not include_fc_data:
        doc.pop("fc_data", None)
    return doc


# ─────────────────────────────────────────────────────────────────────────────
# SESSIONS
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/sessions", status_code=201)
async def create_session(
    device_file:    UploadFile = File(..., description="Reloj / dispositivo .FIT"),
    reference_file: UploadFile = File(..., description="Banda de referencia .FIT"),
    training_type:  str = Form(..., description="Tipo de entrenamiento"),
    session_name:   str = Form(default=""),
    device_name:    str = Form(default=""),
    reference_name: str = Form(default=""),
) -> dict:
    """Upload a pair of FIT files, analyse them and persist the result."""
    device_bytes    = await device_file.read()
    reference_bytes = await reference_file.read()

    dev_name = device_name    or device_file.filename.replace(".fit", "").replace(".FIT", "")
    ref_name = reference_name or reference_file.filename.replace(".fit", "").replace(".FIT", "")

    try:
        result = analyze_session(device_bytes, reference_bytes, dev_name, ref_name)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    doc: dict[str, Any] = {
        "training_type":  training_type,
        "session_name":   session_name or f"Sesión {datetime.now().strftime('%d/%m/%Y %H:%M')}",
        "device_name":    dev_name,
        "reference_name": ref_name,
        "created_at":     datetime.utcnow(),
        **result,
    }

    inserted = await db().sessions.insert_one(doc)
    doc["_id"] = inserted.inserted_id
    return _serialise(doc)


@app.get("/api/sessions")
async def list_sessions(
    training_type: Optional[str] = None,
    skip: int = 0,
    limit: int = 100,
) -> list[dict]:
    """List all sessions, optionally filtered by training type."""
    query = {"training_type": training_type} if training_type else {}
    cursor = (
        db()
        .sessions.find(query, {"fc_data": 0})
        .sort("created_at", -1)
        .skip(skip)
        .limit(limit)
    )
    return [_serialise(doc) async for doc in cursor]


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str) -> dict:
    """Retrieve a single session including full charts."""
    try:
        oid = ObjectId(session_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid session ID")

    doc = await db().sessions.find_one({"_id": oid}, {"fc_data": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")
    return _serialise(doc)


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> dict:
    """Delete a session."""
    try:
        oid = ObjectId(session_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid session ID")

    result = await db().sessions.delete_one({"_id": oid})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")
    return {"deleted": True}


# ─────────────────────────────────────────────────────────────────────────────
# TRAINING TYPES
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/training-types")
async def get_training_types() -> list[dict]:
    """Return distinct training types with session counts."""
    pipeline = [
        {"$group": {"_id": "$training_type", "count": {"$sum": 1}}},
        {"$sort": {"_id": 1}},
    ]
    return [
        {"name": doc["_id"], "count": doc["count"]}
        async for doc in db().sessions.aggregate(pipeline)
    ]


# ─────────────────────────────────────────────────────────────────────────────
# AGGREGATE ANALYSIS
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/aggregate")
async def create_aggregate(body: dict) -> dict:
    """
    Generate an aggregate validation chart from one or more sessions.

    Body: { "session_ids": ["..."], "training_type": "...", "device_name": "...", "reference_name": "..." }
    """
    session_ids   = body.get("session_ids", [])
    training_type = body.get("training_type", "Agregado")

    if not session_ids:
        raise HTTPException(status_code=400, detail="Se requiere al menos una sesión.")

    sessions_data: list[dict] = []
    dev_names:     list[str]  = []
    ref_names:     list[str]  = []

    for sid in session_ids:
        try:
            oid = ObjectId(sid)
        except Exception:
            continue
        doc = await db().sessions.find_one(
            {"_id": oid},
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
        result = generate_aggregate_analysis(
            sessions_data, training_type, dev_name, ref_name
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return result

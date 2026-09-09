"""Immutable protocol definitions and explicit acquisition context."""
from datetime import datetime, timezone
from typing import Literal
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pymongo.errors import DuplicateKeyError
from .models import PROTOCOLS
from .service import oid, public, digest

router = APIRouter(prefix="/api", tags=["comparison protocols"])


class ProtocolInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocol_id: str = Field(pattern=r"^[A-Za-z0-9_-]{3,80}$")
    version: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=160)
    sport_type: Literal["running", "cycling", "gym", "gps", "night"]
    category: str = Field(min_length=1, max_length=100)
    specification: str = Field(min_length=10, max_length=6000)
    required_context: dict[str, str] = Field(default_factory=dict, max_length=20)

    @model_validator(mode="after")
    def bounded_context(self):
        if any(not k.strip() or len(k)>80 or not v.strip() or len(v)>300 for k,v in self.required_context.items()):
            raise ValueError("Condiciones de protocolo inválidas.")
        return self


class ContextInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocol_id: str | None = Field(default=None, max_length=80)
    protocol_version: int | None = Field(default=None, ge=1)
    participant_id: str | None = Field(default=None, max_length=100)
    firmware: str | None = Field(default=None, max_length=160)
    wrist: Literal["LEFT", "RIGHT", "OTHER"] | None = None
    gnss_mode: str | None = Field(default=None, max_length=160)
    context: dict[str,str] = Field(default_factory=dict, max_length=20)
    notes: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def bounded_context(self):
        if bool(self.protocol_id) != bool(self.protocol_version):
            raise ValueError("Indica protocolo y versión juntos, o ninguno.")
        if any(not k.strip() or len(k)>80 or len(v)>300 for k,v in self.context.items()):
            raise ValueError("Contexto inválido.")
        return self


async def resolve_protocol(db, protocol_id, version):
    builtin = next((p for p in PROTOCOLS if p["id"]==protocol_id and p["version"]==version), None)
    if builtin:
        return {**builtin, "exact": False}
    doc = await db.test_protocols.find_one({"protocol_id": protocol_id, "version": version})
    if not doc:
        raise HTTPException(422, "Protocolo o versión no disponibles.")
    return {**public(doc), "id": doc["protocol_id"]}


@router.get("/comparison-protocols")
async def protocols(request:Request):
    custom = await request.app.state.db.test_protocols.find().sort([("protocol_id",1),("version",-1)]).to_list(length=1000)
    return [{**p,"exact":False} for p in PROTOCOLS]+[{**public(p),"id":p["protocol_id"]} for p in custom]


@router.post("/comparison-protocols", status_code=201)
async def create_protocol(request:Request, body:ProtocolInput):
    if any(p["id"]==body.protocol_id and p["version"]==body.version for p in PROTOCOLS):
        raise HTTPException(409, "Esa versión del catálogo ya existe. Publica una versión nueva.")
    doc = {**body.model_dump(), "exact":True, "created_at":datetime.now(timezone.utc)}
    try:
        await request.app.state.db.test_protocols.insert_one(doc)
    except DuplicateKeyError:
        raise HTTPException(409, "Versión existente; las definiciones publicadas son inmutables.")
    return {**public(doc), "id":body.protocol_id}


@router.get("/comparison-sessions/{session_id}/context")
async def context(request:Request, session_id:str):
    doc = await request.app.state.db.sessions.find_one({"_id":oid(session_id)})
    if not doc:
        raise HTTPException(404,"Sesión no encontrada")
    return {key: public(doc.get(key, field.default_factory() if field.default_factory else field.default))
            for key,field in ContextInput.model_fields.items()}


@router.put("/comparison-sessions/{session_id}/context")
async def update_context(request:Request, session_id:str, body:ContextInput):
    db=request.app.state.db
    doc=await db.sessions.find_one({"_id":oid(session_id)})
    if not doc:
        raise HTTPException(404,"Sesión no encontrada")
    protocol=await resolve_protocol(db,body.protocol_id,body.protocol_version) if body.protocol_id else None
    updates={**body.model_dump(), "protocol_snapshot":protocol}
    fields=list(updates)
    previous={key:doc.get(key) for key in fields}
    rid=digest([session_id,doc.get("metadata_revision_id"),previous,updates])
    await db.session_metadata_revisions.update_one({"_id":rid},{"$setOnInsert":{
        "session_id":session_id,"before":previous,"after":updates,"previous_revision_id":doc.get("metadata_revision_id"),
        "created_at":datetime.now(timezone.utc),"association":"USER_DECLARED"}},upsert=True)
    updated=await db.sessions.update_one({"_id":doc["_id"],"metadata_revision_id":doc.get("metadata_revision_id")},
                                         {"$set":{**updates,"metadata_revision_id":rid}})
    if not updated.matched_count:
        raise HTTPException(409,"La clasificación cambió mientras se editaba. Recarga y vuelve a guardar.")
    return {**updates,"metadata_revision_id":rid}

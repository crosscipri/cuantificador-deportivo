"""Domain adapters and comparison orchestration; original files stay in sessions."""
import hashlib
import json
from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd
from bson import ObjectId
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from analyzer import read_fc_from_bytes
from . import gps
from . import advanced
from . import aggregation
from .geometry import compare_geometry
from .channels import read_channels
from .models import Selection
from .statistics import VERSION, METRICS, paired_metrics, summary
from .synchronization import sample, display_indices, json_values


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def oid(value):
    try:
        return ObjectId(value)
    except Exception:
        raise HTTPException(400, "ID inválido")


def public(doc):
    if isinstance(doc, dict):
        return {("id" if k == "_id" else k): public(v) for k,v in doc.items()}
    if isinstance(doc, list):
        return [public(v) for v in doc]
    if isinstance(doc, ObjectId):
        return str(doc)
    if isinstance(doc, datetime):
        return doc.isoformat()
    if isinstance(doc, (float, np.floating)):
        return float(doc) if np.isfinite(doc) else None
    if isinstance(doc, np.integer):
        return int(doc)
    return doc


async def sessions_for(db, ids):
    docs = await db.sessions.find({"_id": {"$in": [oid(s) for s in ids]}}).to_list(length=len(ids))
    indexed = {str(d["_id"]): d for d in docs}
    if len(indexed) != len(set(ids)):
        raise HTTPException(404, "Una sesión seleccionada ya no está disponible.")
    return [indexed[s] for s in ids]


async def ensure_recordings(db, doc, migration_run=None):
    """Idempotent additive adaptation, without guessing experiment membership.

    A reference fingerprint is scoped by its known label. This resolves identical
    copies within the archive but does not assert physical device identity.
    """
    sid = str(doc["_id"])
    ids = {}
    for role in ("device", "reference"):
        raw = doc.get(f"{role}_file_bytes")
        fingerprint = digest(bytes(raw)) if raw else None
        identity = [fingerprint, doc.get("reference_name")] if role == "reference" and raw else [sid, role]
        rid = digest(identity)
        ids[role] = rid
        await db.recordings.update_one({"_id": rid}, {"$setOnInsert": {
            "device_id": str(doc["device_id"]) if role == "device" else None,
            "label": doc.get(f"{role}_name", role), "fingerprint": fingerprint,
            "source_session_id": sid, "source_role": role,
            "filename": doc.get(f"{role}_file_name"), "original_available": bool(raw),
            "created_at": datetime.now(timezone.utc), "migration_version": 1,
            "migration_run_id":migration_run,
        }, "$addToSet": {"source_session_ids": sid}}, upsert=True)
    # The legacy values are frozen before any later crop or reanalysis.
    legacy_key = digest([sid, doc.get("metrics"), doc.get("interval_start_sec"), doc.get("interval_end_sec")])
    await db.analysis_revisions.update_one({"_id": legacy_key}, {"$setOnInsert": {
        "source_session_id": sid, "recording_id": ids["device"],
        "reference_recording_id": ids["reference"], "metric_type": "hr",
        "processing_version": "legacy-unversioned", "metrics": public(doc.get("metrics", {})),
        "configuration": {"interval_start_sec": doc.get("interval_start_sec"),
                          "interval_end_sec": doc.get("interval_end_sec")},
        "created_at": datetime.now(timezone.utc), "migration_version": 1,
        "migration_run_id":migration_run,
    }}, upsert=True)
    await db.sessions.update_one({"_id": doc["_id"]}, {"$set": {
        "recording_id": ids["device"], "reference_recording_id": ids["reference"],
        "legacy_analysis_revision_id": legacy_key,
        **({"comparison_migration_run":migration_run} if migration_run else {})}})
    return {**doc, "recording_id": ids["device"], "reference_recording_id": ids["reference"],
            "legacy_analysis_revision_id": legacy_key}


def source(doc):
    return {"session_id": str(doc["_id"]), "device_id": str(doc["device_id"]),
            "device_name": doc.get("device_name", "Dispositivo"),
            "session_name": doc.get("session_name", "Sesión"),
            "reference_name": doc.get("reference_name", "Referencia"),
            "recording_id": doc.get("recording_id"),
            "reference_recording_id": doc.get("reference_recording_id"),
            "experiment_id": doc.get("experiment_id"), "protocol_id": doc.get("protocol_id"),
            "protocol_version": doc.get("protocol_version"),
            "participant_id": doc.get("participant_id"),
            "firmware": doc.get("firmware"), "wrist": doc.get("wrist"), "gnss_mode": doc.get("gnss_mode"),
            "context": doc.get("context",{}), "protocol_snapshot": doc.get("protocol_snapshot"),
            "metadata_revision_id": doc.get("metadata_revision_id"),
            "analysis_duration_seconds": doc.get("duration_seconds"),
            "sport_type": doc.get("sport_type"), "session_difficulty": doc.get("session_difficulty"),
            "activity_date": public(doc.get("activity_date")),
            "source_url": f"/devices/{doc['device_id']}/sessions/{doc['_id']}",
            "original_files": {r: {"name": doc.get(f"{r}_file_name"),
                                    "available": bool(doc.get(f"{r}_file_bytes")),
                                    "hash": digest(bytes(doc[f"{r}_file_bytes"])) if doc.get(f"{r}_file_bytes") else None}
                               for r in ("device", "reference")}}


def source_manifest(docs):
    """Keep every original fingerprint, including an independent GPS reference."""
    return {str(doc["_id"]): source(doc)["original_files"] for doc in docs}


def read_hr(doc, role, resolution="EPOCH_SECOND_MEAN"):
    raw = doc.get(f"{role}_file_bytes")
    if not raw:
        raise ValueError(f"{doc.get('session_name', 'Sesión')}: faltan originales; no se puede recalcular desde la gráfica reducida.")
    if resolution=="NATIVE":
        channels=read_channels(bytes(raw),doc.get(f"{role}_file_name",""))
        records=[r for r in channels['records'] if r['hr'] is not None]
        if not records:raise ValueError('El archivo no contiene FC nativa con timestamps utilizables.')
        series=pd.Series([r['hr'] for r in records],index=[round(r['t'],6) for r in records],dtype=float)
        return series.groupby(level=0).mean().sort_index()
    return read_fc_from_bytes(bytes(raw), doc.get(f"{role}_file_name", ""))


def direct_compute(docs, config, include_gps=True):
    sid = config.reference_session_id or str(docs[0]["_id"])
    refdoc = next(d for d in docs if str(d["_id"]) == sid)
    reference = read_hr(refdoc, "reference",config.source_resolution)
    devices = [read_hr(d, "device",config.source_resolution) for d in docs]
    hz=config.sampling_hz;step=1/hz
    origin=float(reference.index.min()) if config.source_resolution=='NATIVE' else 0
    offsets = [config.offsets.get(str(d["_id"]), 0) for d in docs]
    t0 = round(origin+np.ceil(round((max([reference.index.min()] + [s.index.min()+o for s,o in zip(devices, offsets)])-origin)*hz,5))/hz,6)
    t1 = round(origin+np.floor(round((min([reference.index.max()] + [s.index.max()+o for s,o in zip(devices, offsets)])-origin)*hz,5))/hz,6)
    if t1 < t0:
        raise ValueError("No hay ventana UTC común. No se pueden superponer entrenamientos de fechas distintas.")
    full_start, full_end = float(t0), float(t1)
    start, end = t0+(config.start_sec or 0), t0+config.end_sec if config.end_sec is not None else t1
    if start > end or end > t1:
        raise ValueError("El intervalo seleccionado queda fuera de la ventana común.")
    if end-start > 12*3600:
        raise ValueError("La ventana máxima de cálculo directo es de 12 horas.")
    grid = np.round(origin+np.arange(np.ceil(round((start-origin)*hz,5)),np.floor(round((end-origin)*hz,5))+1)/hz,6)
    ref, ref_observed = sample(reference, grid, interpolation=config.interpolation, max_gap=config.max_interpolation_gap)
    elapsed = grid-full_start
    eligible = advanced.eligibility(elapsed, config.exclusions)
    values, rows, diagnostic_rows = [], [], []
    for doc, series, offset in zip(docs, devices, offsets):
        dev, observed = sample(series, grid, offset, config.interpolation, config.max_interpolation_gap)
        values.append(dev)
        raw_metrics = paired_metrics(ref, dev,step)
        m = advanced.masked_metrics(ref, dev, eligible,step)
        m["observed_pairs"] = int((ref_observed & observed & eligible).sum())
        m["interpolated_pairs"] = m["n"]-m["observed_pairs"]
        m["device_missing_pairs"] = int((~np.isfinite(dev) & eligible).sum())
        provenance = source(doc)
        provenance.update(reference_recording_id=refdoc["reference_recording_id"],
                          reference_name=refdoc.get("reference_name", "Referencia"),
                          reference_source_session_id=str(refdoc["_id"]))
        provenance["original_files"]["reference"] = source(refdoc)["original_files"]["reference"]
        rows.append({**provenance, "metrics": m, "unmasked_metrics": raw_metrics,
                     "intervals": advanced.interval_metrics(ref, dev, elapsed, eligible, config.intervals,step),
                     "intensities": advanced.intensity_metrics(ref, dev, eligible, config.advanced.intensity_bounds,step) if config.advanced.enabled else [],
                     "trends":advanced.trend_metrics(ref,dev,eligible,hz) if config.advanced.enabled else [],
                     "transients":advanced.transient_metrics(ref,dev,elapsed,eligible,config.intervals,config.advanced,hz) if config.advanced.enabled else [],
                     "processing_version": VERSION,
                     "analysis_duration_seconds": float(end-start),
                     "clock_offset": {"mode": "MANUAL" if offset else "NONE", "applied_seconds": offset},
                     "normalized_sampling_median_seconds": float(np.median(np.diff(series.index))) if len(series)>1 else None,
                     "source_normalization": config.source_resolution,
                     "original_duration_seconds": float(series.index.max()-series.index.min()),
                     "outside_selected_window_seconds": max(0, float(series.index.max()-series.index.min()-(end-start)))})
        if config.advanced.enabled:
            details = advanced.diagnostics(ref, dev, eligible, config.advanced.lag_max_seconds,hz)
            rows[-1]["lag_diagnostic"] = details.pop("lag")
            diagnostic_rows.append({"session_id": str(doc["_id"]), **details})
    gps_grid=np.arange(np.ceil(start),np.floor(end)+1) if include_gps and config.gps_enabled else np.array([])
    gps_result = gps_compute(docs, config, start, end, gps_grid, full_start) if include_gps and config.gps_enabled else None
    gps_errors = [np.asarray(row["position_errors"], dtype=float) for row in (gps_result or {}).get("rows", [])
                  if "position_errors" in row]
    indices = display_indices([ref]+values)
    gps_indices=display_indices(gps_errors or [np.ones(len(gps_grid))]) if gps_result else np.array([],dtype=int)
    if gps_result:gps_result['time']=(gps_grid[gps_indices]-full_start).tolist()
    for row in (gps_result or {}).get("rows", []):
        if "position_errors" in row:
            row["position_errors"] = [row["position_errors"][i] for i in gps_indices]
    traces = [{"id": "reference", "name": refdoc.get("reference_name", "Referencia"),
               "role": "reference", "values": json_values(ref[indices])}]
    for doc, dev in zip(docs, values):
        traces.append({"id": str(doc["_id"]), "device_id": str(doc["device_id"]),
                       "name": doc.get("device_name", "Dispositivo"), "role": "device",
                       "values": json_values(dev[indices]), "errors": json_values((dev-ref)[indices])})
    return {"rows": rows, "time": (grid[indices]-full_start).tolist(), "series": traces,
            "window": {"start_utc": float(start), "end_utc": float(end), "full_start_utc": full_start,
                       "full_end_utc": full_end, "duration_seconds": full_end-full_start,
                       "sampling_comparison_hz": hz,"grid_origin_utc":origin, "display_points": len(indices), "analytical_points": len(grid)},
            "gps": gps_result, "diagnostics": diagnostic_rows}


def gps_compute(docs, config, start, end, grid, full_start=None):
    full_start=start if full_start is None else full_start
    tracks, rows, lookup = [], [], {}
    refdoc = next((d for d in docs if str(d["_id"]) == config.gps_reference_session_id), None)
    sources = [(d, "device") for d in docs] + ([(refdoc, "reference")] if refdoc else [])
    for doc, role in sources:
        raw = doc.get(f"{role}_file_bytes")
        track_id = "gps-reference" if role == "reference" else str(doc["_id"])
        try:
            points = gps.read_gps(bytes(raw), doc.get(f"{role}_file_name", "")) if raw else []
            result = gps.describe(points, start, end, config.offsets.get(str(doc["_id"]), 0) if role == "device" else 0)
        except Exception as exc:
            # Missing/unsupported GPS must not invalidate a valid HR analysis.
            result = {"segments": [], "timed": [], "point_count": 0, "derived_distance_m": None,
                      "unavailable_reason": type(exc).__name__}
        lookup[track_id] = result
        tracks.append({"id": track_id, "role": role, "name": doc.get(f"{role}_name", role),
                       "device_id": str(doc["device_id"]) if role == "device" else None,
                       "segments": result["segments"]})
    ref = lookup.get("gps-reference")
    for doc in docs:
        key = str(doc["_id"])
        entry = lookup[key]
        stats = gps_metrics(entry,ref,grid,config.advanced.gps_geometry)
        stats['intervals']=[]
        for interval in config.intervals:
            left=max(start,full_start+interval.start_sec)
            right=full_start+interval.end_sec
            # Half-open analytical interval. Untimed geometry cannot be assigned to a lap.
            interval_grid=grid[(grid>=left)&(grid<right)]
            device_window=gps.describe([p for p in entry['timed'] if left<=p['t']<right],left,right)
            reference_window=gps.describe([p for p in ref['timed'] if left<=p['t']<right],left,right) if ref else None
            metrics=gps_metrics(device_window,reference_window,interval_grid,config.advanced.gps_geometry)
            metrics.pop('position_errors',None)
            stats['intervals'].append({**interval.model_dump(),'metrics':metrics})
        rows.append({"session_id": key, "device_name": doc.get("device_name"), **stats})
    return {"tracks": tracks, "rows": rows, "reference_available": bool(ref and ref["point_count"])}


def gps_metrics(entry, ref, grid, geometry=False):
    stats = {k:v for k,v in entry.items() if k not in ("timed", "segments")}
    a, b = entry.get("derived_distance_m"), ref.get("derived_distance_m") if ref else None
    # A distance difference is interpretable only for fully timed tracks
    # that cover the same endpoints without detected long gaps.
    comparable = bool(ref and entry["timed"] and ref["timed"] and
                      len(entry["timed"]) == entry["point_count"] and
                      len(ref["timed"]) == ref["point_count"] and
                      not entry.get("segment_break_count") and not ref.get("segment_break_count") and
                      not entry.get("gps_gap_count") and not ref.get("gps_gap_count") and
                      entry["timed"][0]["t"] == ref["timed"][0]["t"] and
                      entry["timed"][-1]["t"] == ref["timed"][-1]["t"])
    stats.update(reference_distance_m=b, distance_error_m=a-b if comparable and a is not None and b is not None else None,
                 distance_error_percent=100*(a-b)/b if comparable and a is not None and b else None)
    recorded, recorded_ref = entry.get("recorded_distance_m"), ref.get("recorded_distance_m") if ref else None
    stats.update(reference_recorded_distance_m=recorded_ref,
                 recorded_distance_error_m=recorded-recorded_ref if comparable and recorded is not None and recorded_ref is not None else None,
                 recorded_distance_error_percent=100*(recorded-recorded_ref)/recorded_ref if comparable and recorded is not None and recorded_ref else None)
    if ref:
        position = gps.positional(ref["timed"], entry["timed"], grid)
        errors = position.pop("position_errors")
        stats.update(position)
        stats["position_errors"] = errors
        if geometry:
            stats.update(compare_geometry(ref["segments"],[p for segment in entry["segments"] for p in segment]))
    return stats


def compatibility(docs):
    protocols = {(d.get("protocol_id"), d.get("protocol_version")) for d in docs}
    categories = {(d.get("sport_type"), d.get("session_difficulty")) for d in docs}
    if len(protocols) == 1 and next(iter(protocols))[0]:
        definitions = [d.get("protocol_snapshot") or {} for d in docs]
        if all(p.get("exact") and d.get("sport_type")==p.get("sport_type") and
               d.get("session_difficulty")==p.get("category") and
               all((d.get("context") or {}).get(k)==v for k,v in p.get("required_context",{}).items())
               for d,p in zip(docs,definitions)):
            return "EXACT_PROTOCOL"
        return "SAME_CATEGORY"
    if len(categories) == 1 and all(next(iter(categories))):
        return "SAME_CATEGORY"
    if not all(d.get("sport_type") and d.get("session_difficulty") for d in docs):
        return "UNKNOWN"
    if len({d.get("sport_type") for d in docs}) == 1:
        return "SIMILAR_CONDITION"
    return "DIFFERENT_PROTOCOL"


def validate_independent_sessions(docs):
    """Repeated imports/crops are not independent benchmark observations."""
    seen = set()
    for doc in docs:
        device_id = str(doc["device_id"])
        identities = []
        if doc.get("experiment_id"):
            identities.append((device_id, "experiment", str(doc["experiment_id"])))
        if doc.get("device_file_bytes"):
            identities.append((device_id, "file", digest(bytes(doc["device_file_bytes"]))))
        if any(key in seen for key in identities):
            raise HTTPException(422, "Hay importaciones, recortes o grabaciones del mismo dispositivo y prueba repetidos. Selecciona una sesión por prueba para no duplicar n.")
        seen.update(identities)


def analysis_configuration(config,metric_type="hr"):
    # Naming and display choices do not define a new analytical revision.
    value=config.model_dump(exclude={"name", "visualization", "aggregation", "manual_weights", "uncertainty", "storage_mode","selection_policy","filters","gps_enabled"})
    if metric_type=="hr":
        value.pop("gps_reference_session_id",None);value["advanced"].pop("gps_geometry",None)
    else:
        value.pop("exclusions",None)
        value["advanced"]={"gps_geometry":value["advanced"].get("gps_geometry",False)}
    return value


async def build(db, config: Selection):
    requested_policy = config.selection_policy
    if requested_policy == "ALL_COMPATIBLE":
        query={"device_id":{"$in":[oid(d) for d in config.filters.device_ids]},
               "sport_type":config.filters.sport_type,"session_difficulty":config.filters.session_difficulty}
        for key in ("firmware","participant_id"):
            if getattr(config.filters,key):query[key]=getattr(config.filters,key)
        if config.protocol_id:query["protocol_id"]=config.protocol_id
        if config.protocol_version:query["protocol_version"]=config.protocol_version
        try:
            # activity_date is stored as BSON datetime; JSON serializers emit ISO text.
            if config.filters.date_from:query.setdefault("activity_date",{})["$gte"]=datetime.fromisoformat(config.filters.date_from)
            if config.filters.date_to:query.setdefault("activity_date",{})["$lt"]=datetime.fromisoformat(config.filters.date_to)+timedelta(days=1)
        except ValueError:
            raise HTTPException(422,"Fecha de filtro inválida.")
        ids=await db.sessions.find(query,{"_id":1}).sort([("activity_date",1),("_id",1)]).limit(101).to_list(length=101)
        if len(ids)>100:raise HTTPException(422,"Hay más de 100 sesiones compatibles; acota las fechas u otros filtros.")
        if len(ids)<2:raise HTTPException(422,"No hay suficientes sesiones compatibles con estos filtros.")
        resolved=[str(d["_id"]) for d in ids]
        view=config.visualization.model_copy(update={"hidden":[sid for sid in config.visualization.hidden if sid in resolved or sid in ("reference","gps-reference")]})
        config=config.model_copy(update={"session_ids":resolved,"selection_policy":"EXPLICIT","visualization":view})
        if config.aggregation=="MANUAL":raise HTTPException(422,"La selección dinámica no admite pesos manuales por sesión.")
    docs = await sessions_for(db, config.session_ids)
    device_ids = [str(d["device_id"]) for d in docs]
    if len(set(device_ids)) < 2:
        raise HTTPException(422, "Selecciona al menos dos dispositivos diferentes.")
    if config.mode == "DIRECT" and len(set(device_ids)) != len(device_ids):
        raise HTTPException(422, "Selecciona una grabación por dispositivo para comparación directa.")
    if config.mode == "BENCHMARK":
        validate_independent_sessions(docs)
    if config.protocol_id and any(d.get("protocol_id") != config.protocol_id or
                                 (config.protocol_version and d.get("protocol_version") != config.protocol_version) for d in docs):
        raise HTTPException(422, "Hay sesiones fuera del protocolo o versión seleccionados.")
    docs = [await ensure_recordings(db, d) for d in docs]
    base = {"mode": config.mode, "configuration": config.model_dump(), "processing_version": VERSION,
            "compatibility": compatibility(docs), "warnings": [], "source_manifest": source_manifest(docs),
            "selection_resolved_from":requested_policy,"resolved_at":datetime.now(timezone.utc).isoformat()}
    if base['compatibility']=='UNKNOWN':base['warnings'].append('Faltan deporte o intensidad: no se afirma compatibilidad de protocolo.')
    elif base['compatibility']=='SAME_CATEGORY':base['warnings'].append('Misma categoría declarada; no acredita que se haya ejecutado una prescripción exacta con las mismas condiciones.')
    elif base['compatibility']=='EXACT_PROTOCOL':base['warnings'].append('Protocolo y condiciones declarados coincidentes. La asignación manual no verifica por sí sola la ejecución de cada intervalo.')
    try:
        if config.mode == "DIRECT":
            refs = {d["reference_recording_id"] for d in docs}
            experiments = {d.get("experiment_id") for d in docs}
            verified = len(refs)==1
            if len(experiments) == 1 and None not in experiments:
                experiment = await db.experiments.find_one({"_id": oid(next(iter(experiments)))})
                designated = (experiment or {}).get("references", {}).get("hr", {})
                selected_ref = next(d for d in docs if str(d["_id"]) == (config.reference_session_id or str(docs[0]["_id"])))
                verified = designated.get("recording_id") == selected_ref["reference_recording_id"]
                base["reference_quality"] = designated.get("quality")
            if len(experiments-{None})>1:
                raise ValueError("Las sesiones pertenecen a experimentos distintos. Utiliza Benchmark.")
            if not verified and not config.assume_same_workout:
                raise ValueError("No se ha verificado una referencia común. Declara mismo entrenamiento y elige la referencia.")
            base["reference_status"] = "REFERENCE_VERIFIED" if verified else "REFERENCE_ASSUMED"
            data = await run_in_threadpool(direct_compute, docs, config)
            base.update(data)
            for row in base["rows"]:
                await persist_revision(db, row, analysis_configuration(config))
            gps_reference = next((d for d in docs if str(d["_id"]) == config.gps_reference_session_id), None)
            for gps_row, doc in zip((base.get("gps") or {}).get("rows",[]), docs):
                provenance = source(doc)
                provenance["reference_recording_id"] = gps_reference["reference_recording_id"] if gps_reference else None
                provenance["reference_source_session_id"] = str(gps_reference["_id"]) if gps_reference else None
                provenance["reference_name"] = gps_reference.get("reference_name") if gps_reference else None
                provenance["original_files"]["reference"] = (source(gps_reference)["original_files"]["reference"] if gps_reference
                                                              else {"name": None, "available": False, "hash": None})
                provenance["metrics"] = {k: v for k, v in gps_row.items() if k not in ("session_id", "device_name", "position_errors")}
                provenance["processing_version"] = VERSION
                await persist_revision(db, provenance, analysis_configuration(config,"gps"), metric_type="gps")
                gps_row["analysis_revision_id"] = provenance["analysis_revision_id"]
        else:
            if len({d.get("sport_type") for d in docs})>1 or len({d.get("session_difficulty") for d in docs})>1:
                raise ValueError("Selecciona sesiones de la misma categoría de deporte e intensidad.")
            rows = []
            for doc in docs:
                row = source(doc)
                if config.benchmark_method == "LEGACY":
                    legacy_metrics = doc.get("metrics") or {}
                    row.update(metrics={k: legacy_metrics.get(k) for k in METRICS},
                               analysis_revision_id=doc["legacy_analysis_revision_id"], processing_version="legacy-unversioned")
                    row["metrics"]["n"] = legacy_metrics.get("n")
                else:
                    single = config.model_copy(update={"mode": "DIRECT", "reference_session_id": str(doc["_id"]),
                                                        "name": "Session analysis", "session_ids": [str(doc["_id"])],
                                                        "gps_reference_session_id": None,
                                                        "start_sec": doc.get("interval_start_sec"),
                                                        "end_sec": doc.get("interval_end_sec")})
                    # Cache current session results before loading/parsing files again.
                    key = digest([row["original_files"], VERSION, analysis_configuration(single), str(doc["_id"])])
                    cached = await db.analysis_revisions.find_one({"cache_key": key})
                    if cached:
                        row.update(metrics=cached["metrics"], analysis_revision_id=cached["_id"], processing_version=VERSION)
                    else:
                        result = await run_in_threadpool(direct_compute, [doc], single, False)
                        row = result["rows"][0]
                        await persist_revision(db, row, analysis_configuration(single), key)
                rows.append(row)
            grouped = await run_in_threadpool(aggregation.groups, rows, config)
            base.update(rows=rows, groups=grouped, heatmap=aggregation.heatmap(rows), aggregation=config.aggregation)
            if config.benchmark_method == "LEGACY":
                base["warnings"].append("Resultados históricos: metodología sin versión, interpolación no acotada y cobertura/P95 no disponibles si no se guardaron. No se mezclan con el motor actual.")
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return public(base)


async def persist_revision(db, row, configuration, cache_key=None, metric_type="hr"):
    rid = digest([metric_type, row["session_id"], row["original_files"], VERSION, configuration, row["metrics"]])
    doc = {"_id": rid, "source_session_id": row["session_id"],
           "recording_id": row["recording_id"], "reference_recording_id": row["reference_recording_id"],
           "metric_type": metric_type, "processing_version": VERSION, "metrics": row["metrics"],
           "configuration": configuration, "provenance": row, "cache_key": cache_key,
           "created_at": datetime.now(timezone.utc)}
    stored = public(doc)
    stored.pop("id", None)
    await db.analysis_revisions.update_one({"_id": rid}, {"$setOnInsert": stored}, upsert=True)
    row["analysis_revision_id"] = rid


async def protect_sources(db, session_ids):
    async for recording in db.recordings.find({"source_session_id": {"$in": session_ids}}, {"source_session_ids": 1}):
        if set(recording.get("source_session_ids", []))-set(session_ids):
            raise HTTPException(409, "El archivo de esta sesión es una fuente compartida por otras grabaciones.")
    if await db.comparisons.find_one({"$or":[{"configuration.session_ids": {"$in": session_ids}},
                                           {"evidence.configuration.session_ids":{"$in":session_ids}}]}, {"_id": 1}):
        raise HTTPException(409, "Estas sesiones son fuentes de una comparativa guardada. Conserva los originales para mantener su trazabilidad.")
    if await db.experiments.find_one({"session_ids": {"$in": session_ids}}, {"_id": 1}):
        raise HTTPException(409, "Estas sesiones pertenecen a un experimento; no se pueden borrar sus fuentes.")


async def create_indexes(db):
    await db.test_protocols.create_index([("protocol_id",1),("version",1)],unique=True)
    await db.session_metadata_revisions.create_index("session_id")
    await db.experiment_revisions.create_index("experiment_id")
    await db.archive_comparisons.create_index([("created_at",-1)])
    await db.archive_comparisons.create_index("evidence.rows.source_document_id")
    await db.sleep_recordings.create_index("device_id")
    await db.sleep_comparisons.create_index([("created_at",-1)])
    await db.recordings.create_index("source_session_ids")
    await db.analysis_revisions.create_index("source_session_id")
    await db.analysis_revisions.create_index("cache_key")
    await db.comparisons.create_index([("created_at", -1)])
    await db.comparison_workspaces.create_index([("created_at", -1)])
    await db.comparisons.create_index("configuration.session_ids")
    await db.comparisons.create_index("evidence.configuration.session_ids")
    await db.comparisons.create_index("root_comparison_id")
    await db.experiments.create_index("session_ids", unique=True)
    await db.sessions.create_index("experiment_id")
    await db.sessions.create_index([("protocol_id", 1), ("protocol_version", 1)])
    await db.sessions.create_index([("activity_date", -1), ("_id", -1)])
    await db.sessions.create_index([("device_id", 1), ("activity_date", -1), ("_id", -1)])

"""GPS channels extracted from retained originals; no assumed HR reference GPS."""
import io
import math
from datetime import timezone
import fitparse
import numpy as np
import pandas as pd
from analyzer import _parse_gpx_xml, _parse_xml, _xml_local_name
from .statistics import gap_stats, finite


def read_gps(data, filename):
    rows = []
    if filename.lower().endswith(".fit") or data[8:12] == b".FIT":
        for msg in fitparse.FitFile(io.BytesIO(data), check_crc=False).get_messages("record"):
            fields = msg.get_values()
            lat, lon = fields.get("position_lat"), fields.get("position_long")
            stamp = fields.get("timestamp")
            if lat is not None and lon is not None:
                if stamp is not None and stamp.tzinfo is None:
                    stamp = stamp.replace(tzinfo=timezone.utc)
                rows.append((stamp, lat*180/2**31, lon*180/2**31, 0, fields.get("distance")))
    else:
        is_gpx = filename.lower().endswith(".gpx") or b"<gpx" in data[:600].lower()
        root = _parse_gpx_xml(data) if is_gpx else _parse_xml(data)
        groups = [node for node in root.iter() if _xml_local_name(node.tag) in ("trkseg", "track")]
        for segment_id, group in enumerate(groups or [root]):
            for node in group.iter():
                tag = _xml_local_name(node.tag)
                if tag not in ("trkpt", "rtept", "trackpoint"):
                    continue
                fields = {_xml_local_name(c.tag): c.text for c in node.iter()}
                lat = node.get("lat") if tag != "trackpoint" else fields.get("latitudedegrees")
                lon = node.get("lon") if tag != "trackpoint" else fields.get("longitudedegrees")
                if lat is not None and lon is not None:
                    try:
                        rows.append((fields.get("time"), float(lat), float(lon), segment_id,
                                     fields.get("distancemeters") if tag == "trackpoint" else None))
                    except (TypeError, ValueError):
                        continue
    result = []
    timestamps = pd.to_datetime([row[0] for row in rows], utc=True, errors="coerce", format="mixed")
    for (_, lat, lon, segment_id, native), t in zip(rows, timestamps):
        if not np.isfinite(lat) or not np.isfinite(lon) or abs(lat)>90 or abs(lon)>180:
            continue
        result.append({"t": None if pd.isna(t) else t.timestamp(), "lat": lat, "lon": lon,
                       "segment_id": segment_id,
                       "native_distance_counter_m": float(native) if finite(native) and float(native)>=0 else None})
    # Preserve original geometry, including the order of untimed coordinates.
    return result


def distance(a, b):
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat, dlon = lat2-lat1, math.radians(b[1]-a[1])
    h = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 6371000*2*math.asin(math.sqrt(max(0, min(h, 1))))


def describe(points, start, end, offset=0, max_gap=5):
    pts = [{**p, "t": p["t"]+offset if p["t"] is not None else None} for p in points]
    pts = [p for p in pts if p["t"] is None or start <= p["t"] <= end]
    segments, current, total, gaps, breaks, edges = [], [], 0.0, [], 0, 0
    for p in pts:
        if current:
            prev = current[-1]
            dt = p["t"]-prev["t"] if p["t"] is not None and prev["t"] is not None else None
            discontinuity = (p.get("segment_id") != prev.get("segment_id") or
                             (p["t"] is None) != (prev["t"] is None) or
                             (dt is not None and (dt <= 0 or dt > max_gap)))
            if discontinuity:
                breaks += 1
                if dt is not None and dt > max_gap:
                    gaps.append(dt)
                segments.append(current)
                current = []
            else:
                total += distance((prev["lat"], prev["lon"]), (p["lat"], p["lon"]))
                edges += 1
        current.append(p)
    if current:
        segments.append(current)
    timed = [p for p in pts if p["t"] is not None]
    intervals = np.diff([p["t"] for p in timed])
    intervals = intervals[intervals > 0]
    counters = [p.get("native_distance_counter_m") for p in pts]
    recorded = None
    recorded_reason = "Contador de distancia no disponible en todos los puntos del tramo."
    if len(pts) >= 2 and all(finite(v) for v in counters):
        if len(timed) != len(pts) or breaks:
            recorded_reason = "El tramo tiene discontinuidades o coordenadas sin timestamp."
        elif any(b < a for a, b in zip(counters, counters[1:])):
            recorded_reason = "El contador disminuye o se reinicia dentro del tramo."
        else:
            recorded = counters[-1]-counters[0]
            recorded_reason = None
    return {"segments": segments, "point_count": len(pts),
            "derived_distance_m": total if edges else None,
            "distance_basis": "coordinate_sum_excluding_gaps",
            "recorded_distance_m": recorded,
            "recorded_distance_basis": "native_counter_delta_at_retained_gps_endpoints",
            "recorded_distance_unavailable_reason": recorded_reason,
            "distance_start_utc": timed[0]["t"] if timed else None,
            "distance_end_utc": timed[-1]["t"] if timed else None,
            "median_sampling_seconds": float(np.median(intervals)) if len(intervals) else None,
            "gps_gap_count": len(gaps) if len(timed)>1 else None,
            "longest_gps_gap": (max(gaps) if gaps else 0) if len(timed)>1 else None,
            "segment_break_count": breaks, "untimed_point_count": len(pts)-len(timed),
            "timed": timed}


def positional(reference, device, grid):
    # Exact UTC seconds, averaging coincident positions, with no extrapolation.
    def by_time(points):
        buckets = {}
        for p in points:
            if p["t"] is not None:
                buckets.setdefault(p["t"], []).append([p["lat"], p["lon"]])
        return {t: np.mean(v, axis=0) for t, v in buckets.items()}
    ref, dev = by_time(reference), by_time(device)
    errors = [distance(ref[t], dev[t]) if t in ref and t in dev else None for t in grid]
    valid = [e for e in errors if e is not None]
    n = len(valid)
    return {"position_mean_m": float(np.mean(valid)) if n else None,
            "position_median_m": float(np.median(valid)) if n else None,
            "position_rmse_m": float(np.sqrt(np.mean(np.square(valid)))) if n else None,
            "position_p95_m": float(np.percentile(valid, 95)) if n else None,
            "position_max_m": max(valid) if n else None,
            "position_pairs": n, "position_coverage_percent": 100*n/len(grid) if len(grid) else None,
            "position_errors": errors, **gap_stats([e is not None for e in errors])}

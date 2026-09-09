"""Session summaries and optional resampling at the highest known cluster."""
import numpy as np
from .statistics import METRICS, finite, summary


def row_weight(row, configuration):
    mode = configuration.aggregation
    value = (configuration.manual_weights.get(row["session_id"]) if mode == "MANUAL" else
             row.get("analysis_duration_seconds") if mode == "DURATION" else
             row["metrics"].get("n") if mode == "VALID_PAIRS" else 1)
    return float(value) if finite(value) and float(value)>0 else None


def estimate(rows, key, config):
    pairs = [(row, row_weight(row, config)) for row in rows if finite(row["metrics"].get(key))]
    included = [(row, weight) for row, weight in pairs if weight is not None]
    values = np.array([row["metrics"][key] for row, _ in included], dtype=float)
    weights = np.array([weight for _, weight in included], dtype=float)
    result = {**summary([r["metrics"].get(key) for r in rows]),
              "estimate": float(np.average(values, weights=weights)) if len(values) else None,
              "weighted_n": len(values), "weight_sum": float(weights.sum()),
              "weight_missing_or_zero_n": len(pairs)-len(included), "ci": None}
    if not config.uncertainty.enabled:
        return result
    settings = config.uncertainty
    participants = [r.get("participant_id") for r, _ in included]
    known = {p for p in participants if p}
    unit = "participant" if len(known)>1 and all(participants) else "experiment_or_session"
    ci = {"lower": None, "upper": None, "unit": unit, "clusters": 0,
          "confidence": settings.confidence, "repetitions": settings.repetitions,
          "seed": settings.seed, "method": "cluster_percentile_weighted_mean_v1", "reason": None}
    result["ci"] = ci
    if known and not all(participants):
        ci["reason"] = "Identidad de participante incompleta; no se presume independencia."
        return result
    clusters = {}
    for index, (row, _) in enumerate(included):
        identity = row.get("participant_id") if unit == "participant" else row.get("experiment_id") or row["session_id"]
        clusters.setdefault(identity, []).append(index)
    ci["clusters"] = len(clusters)
    ci["scope"] = "within_single_participant" if len(known)==1 else "participants_unknown" if not known else "known_participants"
    if len(clusters)<5:
        ci["reason"] = "Se requieren 5 clusters elegibles como mínimo operativo; no garantiza evidencia suficiente."
        return result
    indices = list(clusters.values())
    rng = np.random.default_rng(settings.seed)
    samples = []
    for _ in range(settings.repetitions):
        take = np.concatenate([indices[i] for i in rng.integers(0, len(indices), size=len(indices))])
        samples.append(np.average(values[take], weights=weights[take]))
    alpha = (1-settings.confidence)/2
    ci["lower"], ci["upper"] = [float(x) for x in np.quantile(samples, [alpha, 1-alpha], method="linear")]
    return result


def groups(rows, config):
    result = []
    for device_id in dict.fromkeys(row["device_id"] for row in rows):
        selected = [row for row in rows if row["device_id"] == device_id]
        result.append({"device_id": device_id, "device_name": selected[0]["device_name"],
                       "session_count": len(selected),
                       "metrics": {key: estimate(selected, key, config) for key in METRICS}})
    return result


def heatmap(rows):
    result = []
    by_category = {}
    for row in rows:
        category = (row.get("protocol_id") or f"{row.get('sport_type') or 'desconocido'} / {row.get('session_difficulty') or 'desconocido'}",
                    row.get("protocol_version"))
        by_category.setdefault(category, []).append(row)
    for (category, version), selected in by_category.items():
        for device_id in dict.fromkeys(row["device_id"] for row in selected):
            sources = [r for r in selected if r["device_id"] == device_id]
            result.append({"category": category, "protocol_version": version, "device_id": device_id,
                           "session_ids": [r["session_id"] for r in sources],
                           "metrics": {k: summary([r["metrics"].get(k) for r in sources]) for k in METRICS}})
    return result

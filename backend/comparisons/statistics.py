"""Descriptive statistics. Temporal samples are not independent subjects.

No inferential CI or generic ICC is emitted. Quantiles use NumPy's linear
method; between-session SD and descriptive error SD use ddof=1.
"""
import numpy as np

VERSION = "comparison-2.0.0"
UNITS = {"hr": "bpm", "gps": "m", "coverage_percent": "%", "lag": "s"}
METRICS = {
    "mae": ("MAE", "Separación absoluta media respecto a la referencia.", "bpm"),
    "rmse": ("RMSE", "Penaliza más los errores grandes que MAE.", "bpm"),
    "bias": ("Bias", "Dispositivo menos referencia: positivo indica sobreestimación.", "bpm"),
    "median_ae": ("MedianAE", "Mediana de los errores absolutos.", "bpm"),
    "p90_ae": ("P90 AE", "Percentil 90 del error absoluto; método lineal.", "bpm"),
    "p95_ae": ("P95 AE", "Percentil 95 del error absoluto; método lineal.", "bpm"),
    "max_ae": ("Máximo AE", "Mayor error absoluto; diagnóstico, no ranking principal.", "bpm"),
    "error_sd": ("SD error", "Desviación estándar muestral del error.", "bpm"),
    "coverage_percent": ("Cobertura", "Pares válidos / instantes esperados en la ventana.", "%"),
    "reference_coverage_percent": ("Cobertura referencia", "Instantes válidos de referencia / instantes esperados.", "%"),
    "device_coverage_percent": ("Cobertura con referencia válida", "Pares válidos / instantes con referencia válida; separa ausencia de la referencia y del dispositivo.", "%"),
    "within_3_bpm": ("±3 bpm", "Porcentaje de pares con error absoluto ≤3 bpm.", "%"),
    "within_5_bpm": ("±5 bpm", "Porcentaje de pares con error absoluto ≤5 bpm.", "%"),
    "within_10_bpm": ("±10 bpm", "Porcentaje de pares con error absoluto ≤10 bpm.", "%"),
    "r": ("Pearson r", "Asociación, no acuerdo ni precisión.", ""),
    "ccc": ("CCC", "Concordancia de Lin; estimador con momentos normalizados por n.", ""),
}


def finite(value):
    try:
        return value is not None and np.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def summary(values):
    x = np.asarray([float(v) for v in values if finite(v)], dtype=float)
    if not len(x):
        return {"n": 0, **{k: None for k in ("mean", "median", "sd", "q1", "q3", "iqr", "min", "max")}}
    q1, q3 = np.percentile(x, [25, 75], method="linear")
    return {"n": len(x), "mean": float(x.mean()), "median": float(np.median(x)),
            "sd": float(x.std(ddof=1)) if len(x) > 1 else None,
            "q1": float(q1), "q3": float(q3), "iqr": float(q3-q1),
            "min": float(x.min()), "max": float(x.max())}


def gap_stats(valid, step=1):
    invalid = ~np.asarray(valid, dtype=bool)
    edges = np.diff(np.r_[False, invalid, False].astype(int))
    lengths = np.flatnonzero(edges == -1) - np.flatnonzero(edges == 1)
    return {"gap_count": len(lengths), "missing_duration": int(invalid.sum()) * step,
            "longest_gap": int(lengths.max()) * step if len(lengths) else 0}


def paired_metrics(reference, device, step=1):
    ref, dev = np.asarray(reference, dtype=float), np.asarray(device, dtype=float)
    if ref.ndim != 1 or dev.ndim != 1 or ref.shape != dev.shape:
        raise ValueError("Las estadísticas requieren dos series unidimensionales con pares ya alineados.")
    valid = np.isfinite(ref) & np.isfinite(dev)
    expected, n = len(ref), int(valid.sum())
    result = {k: None for k in METRICS}
    result.update(n=n, valid_pairs=n, expected_pairs=expected,
                  coverage_percent=100*n/expected if expected else None,
                  reference_valid_pairs=int(np.isfinite(ref).sum()), **gap_stats(valid,step))
    reference_n = result["reference_valid_pairs"]
    result["reference_coverage_percent"] = 100*reference_n/expected if expected else None
    result["device_coverage_percent"] = 100*n/reference_n if reference_n else None
    if not n:
        return result
    x, y = ref[valid], dev[valid]
    diff = y-x
    ae = np.abs(diff)
    bias = float(diff.mean())
    result.update(bias=bias, mae=float(ae.mean()), rmse=float(np.sqrt(np.mean(diff**2))),
                  median_ae=float(np.median(ae)), p90_ae=float(np.percentile(ae, 90)),
                  p95_ae=float(np.percentile(ae, 95)), max_ae=float(ae.max()))
    for limit in (3, 5, 10):
        result[f"within_{limit}_bpm"] = float(np.mean(ae <= limit)*100)
    if n > 1:
        sd = float(diff.std(ddof=1))
        result.update(error_sd=sd, loa_lower=bias-1.96*sd, loa_upper=bias+1.96*sd)
        vx, vy = float(x.var()), float(y.var())
        cov = float(np.mean((x-x.mean())*(y-y.mean())))
        denom = vx+vy+float((x.mean()-y.mean())**2)
        result["ccc"] = 2*cov/denom if denom > 0 else None
        result["r"] = cov/np.sqrt(vx*vy) if vx > 0 and vy > 0 else None
    return result

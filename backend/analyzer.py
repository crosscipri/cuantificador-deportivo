"""
HR Analyzer — core engine adapted from hr-analyzer.py.
Receives FIT/TCX/GPX file bytes, returns metrics, zones, charts (base64 PNG).
"""

import io
import base64
import re
import matplotlib
matplotlib.use("Agg")  # non-interactive backend — must be before pyplot import

import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
from matplotlib.ticker import MultipleLocator, FuncFormatter
from matplotlib.patches import Patch

import pandas as pd
import numpy as np
from scipy import stats
from scipy.signal import correlate
import math
import logging
import fitparse
from datetime import datetime

_log = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────
ZONAS_FC = [
    ("Z1 Aeróbico bajo",          44,  134),
    ("Z2 Aeróbico base",         134,  154),
    ("Z3 Umbral láctico",        154,  167),
    ("Z4 Supra-umbral",          167,  176),
    ("Z5 VO2máx / neuromuscular",176,  999),
]
COLORES_ZONA = ["#3498db", "#2ecc71", "#f1c40f", "#e67e22", "#e74c3c"]

# Palette for multi-session charts (up to 12 sessions; cycles after that)
SESSION_PALETTE = [
    "#1d4ed8", "#dc2626", "#16a34a", "#d97706", "#7c3aed",
    "#db2777", "#0891b2", "#65a30d", "#ea580c", "#0f766e",
    "#92400e", "#4338ca",
]

# Editorial weights for PPG sensor difficulty. Not a statistical property of MAE/CCC/R.
# Relative scale: how much harder that session type is for optical HR sensors.
DIFFICULTY_WEIGHTS: dict[str, float] = {
    "z2":     1.0,
    "tempo":  1.5,
    "series": 2.5,
}


# ─────────────────────────────────────────────────────────────────────────────
# 1. READ FILES (FIT / TCX / GPX)
# ─────────────────────────────────────────────────────────────────────────────

def _records_to_series(records: list) -> pd.Series:
    """
    Convert a list of {time, hr} dicts to a HR Series.
    Index = absolute UTC epoch-seconds so that two series recorded at different
    wall-clock start times are still aligned correctly when passed to align().
    """
    if not records:
        raise ValueError("No se encontraron datos de FC en el archivo.")
    df = pd.DataFrame(records)
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df = df.sort_values("time")
    # Epoch-second index (absolute wall-clock, UTC)
    df["epoch_sec"] = (df["time"].astype(np.int64) // 1_000_000_000).astype(int)
    df["hr"] = pd.to_numeric(df["hr"], errors="coerce")
    # If multiple readings fall on the same second, keep the mean
    series = (
        df.dropna(subset=["hr"])
          .groupby("epoch_sec")["hr"]
          .mean()
    )
    if series.empty:
        raise ValueError("El archivo no contiene datos de FC válidos.")
    return series


def _read_fit(data: bytes) -> pd.Series:
    fitfile = fitparse.FitFile(io.BytesIO(data), check_crc=False)
    records = []
    for msg in fitfile.get_messages("record"):
        d = {f.name: f.value for f in msg}
        if "heart_rate" in d and "timestamp" in d:
            records.append({"time": d["timestamp"], "hr": d["heart_rate"]})
    return _records_to_series(records)


def _read_tcx(data: bytes) -> pd.Series:
    """Parse TCX (Training Center XML). Handles Garmin namespaces."""
    import xml.etree.ElementTree as ET
    root = ET.fromstring(data)
    NS = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"

    def tag(name):
        return f"{{{NS}}}{name}"

    records = []
    for tp in root.iter(tag("Trackpoint")):
        time_el   = tp.find(tag("Time"))
        hr_parent = tp.find(tag("HeartRateBpm"))
        if time_el is None or hr_parent is None:
            continue
        hr_val_el = hr_parent.find(tag("Value"))
        if hr_val_el is not None:
            try:
                records.append({"time": time_el.text.strip(),
                                 "hr":   float(hr_val_el.text.strip())})
            except (ValueError, AttributeError):
                continue
    return _records_to_series(records)


def _xml_local_name(tag: str) -> str:
    """Return a lowercase XML tag name without its namespace or prefix."""
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].rsplit(":", 1)[-1].lower()


def _parse_gpx_xml(data: bytes):
    """Parse GPX XML, repairing exporter files with undeclared prefixes."""
    import xml.etree.ElementTree as ET

    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        if "unbound prefix" not in str(exc).lower():
            raise ValueError(f"El archivo GPX no contiene XML válido: {exc}") from exc

    # Some watch exporters emit tags such as <gpxtpx:hr> but forget the
    # corresponding xmlns:gpxtpx declaration. Add inert namespace declarations
    # only for the missing prefixes, then let ElementTree parse normally.
    declared = set(re.findall(
        rb"\bxmlns:([A-Za-z_][A-Za-z0-9_.-]*)\s*=", data
    ))
    element_prefixes = set(re.findall(
        rb"</?([A-Za-z_][A-Za-z0-9_.-]*):[A-Za-z_][A-Za-z0-9_.-]*\b",
        data,
    ))
    attribute_prefixes = set(re.findall(
        rb"\s([A-Za-z_][A-Za-z0-9_.-]*):[A-Za-z_][A-Za-z0-9_.-]*\s*=",
        data,
    ))
    missing = sorted(
        (element_prefixes | attribute_prefixes)
        - declared
        - {b"xml", b"xmlns"}
    )
    root_tag = re.search(
        rb"<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?gpx\b", data, re.IGNORECASE
    )
    if not missing or root_tag is None:
        raise ValueError("El archivo GPX usa prefijos XML sin declarar.")

    declarations = b"".join(
        b' xmlns:' + prefix + b'="urn:gpx-recovered:' + prefix + b'"'
        for prefix in missing
    )
    repaired = data[:root_tag.end()] + declarations + data[root_tag.end():]
    try:
        return ET.fromstring(repaired)
    except ET.ParseError as exc:
        raise ValueError(f"El archivo GPX no contiene XML válido: {exc}") from exc


def _read_gpx(data: bytes) -> pd.Series:
    """Parse heart rate from standard and exporter-specific GPX extensions."""
    root = _parse_gpx_xml(data)

    records = []
    for point in root.iter():
        if _xml_local_name(point.tag) not in {"trkpt", "rtept"}:
            continue

        time_text = None
        for element in point.iter():
            if _xml_local_name(element.tag) == "time" and element.text:
                time_text = element.text.strip()
                break
        if not time_text:
            continue

        hr = None
        for element in point.iter():
            local_name = _xml_local_name(element.tag)
            if local_name not in {
                "hr", "heartrate", "heart_rate", "heart-rate", "bpm",
                "heartratebpm", "heart_rate_bpm",
            }:
                continue

            values = [element.text]
            if local_name in {"heartratebpm", "heart_rate_bpm"}:
                values.extend(
                    child.text
                    for child in element.iter()
                    if _xml_local_name(child.tag) in {"value", "bpm"}
                )
            for value in values:
                if not value:
                    continue
                try:
                    hr = float(value.strip())
                except (ValueError, AttributeError):
                    continue
                break
            if hr is not None:
                break

        if hr is not None:
            records.append({"time": time_text, "hr": hr})
    return _records_to_series(records)


def _read_healthkit(data: bytes) -> pd.Series:
    """Parse Apple Health export XML (HKQuantityTypeIdentifierHeartRate)."""
    import xml.etree.ElementTree as ET
    from datetime import timezone as tz

    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        root = ET.fromstring(b"<root>" + data + b"</root>")

    records = []
    for rec in root.iter("Record"):
        if rec.get("type") != "HKQuantityTypeIdentifierHeartRate":
            continue
        start_str = rec.get("startDate") or rec.get("endDate")
        value_str  = rec.get("value")
        if not start_str or not value_str:
            continue
        try:
            bpm = int(float(value_str))
            dt  = datetime.strptime(start_str, "%Y-%m-%d %H:%M:%S %z")
            records.append({"time": dt, "hr": bpm})
        except (ValueError, OverflowError):
            continue

    return _records_to_series(records)


def read_fc_from_bytes(data: bytes, filename: str = "") -> pd.Series:
    """
    Parse a FIT, TCX, GPX or Apple Health XML file from raw bytes.
    Format detected by filename extension, then content sniffing.
    Falls back gracefully between formats.
    """
    ext = filename.lower().rsplit(".", 1)[-1] if filename else ""

    # ── Explicit extension ────────────────────────────────────────────────
    if ext == "tcx":
        return _read_tcx(data)
    if ext == "gpx":
        return _read_gpx(data)
    if ext == "xml":
        return _read_healthkit(data)

    # For .fit (or no extension) try FIT first, fall through on header error
    fit_error = None
    if ext in ("fit", ""):
        try:
            return _read_fit(data)
        except Exception as e:
            fit_error = e

    # ── Content sniffing ─────────────────────────────────────────────────
    text_start = data[:600].lower()
    if b"trainingcenterdatabase" in text_start or b"<tcx" in text_start:
        return _read_tcx(data)
    if b"<gpx" in text_start:
        return _read_gpx(data)
    if b"hkquantitytypeidentifierheartrate" in text_start:
        return _read_healthkit(data)

    if fit_error:
        raise ValueError(f"No se pudo leer el archivo: {fit_error}")

    return _read_fit(data)


# ─────────────────────────────────────────────────────────────────────────────
# 2. ALIGN SERIES
# ─────────────────────────────────────────────────────────────────────────────

def align(fc1: pd.Series, fc2: pd.Series):
    """
    Align two HR series by absolute UTC epoch-second index.

    Both series must be indexed by epoch-seconds (as produced by _records_to_series).
    The common window is the intersection of both recording intervals, ensuring
    that fc1[i] and fc2[i] truly correspond to the SAME wall-clock second.

    Returns:
        a1, a2  — aligned series with 0-based relative index (seconds elapsed)
        x_seg   — relative second array [0, 1, 2, …] for display / storage
        t_min   — absolute epoch-second of the window start (for reference)
    """
    t_min = int(max(fc1.index.min(), fc2.index.min()))
    t_max = int(min(fc1.index.max(), fc2.index.max()))
    if t_min >= t_max:
        raise ValueError(
            "Los dos archivos no tienen ventana temporal en común. "
            "Comprueba que ambas grabaciones corresponden a la misma sesión."
        )
    abs_idx = np.arange(t_min, t_max + 1)
    a1 = fc1.reindex(abs_idx).interpolate()
    a2 = fc2.reindex(abs_idx).interpolate()
    # Shift index to relative seconds (0-based) for all downstream consumers
    rel_idx = np.arange(len(abs_idx))
    a1 = a1.set_axis(rel_idx)
    a2 = a2.set_axis(rel_idx)
    return a1, a2, rel_idx, t_min


# ─────────────────────────────────────────────────────────────────────────────
# 3. METRICS
# ─────────────────────────────────────────────────────────────────────────────

def calculate_metrics(fc_ref: pd.Series, fc_dev: pd.Series) -> dict:
    """Full set of validation metrics: MAE, MAPE, RMSE, Bland-Altman, CCC, ICC."""
    diff = fc_dev - fc_ref

    mae  = float(diff.abs().mean())
    mape = float((diff.abs() / fc_ref.clip(lower=1) * 100).mean())
    rmse = float(np.sqrt((diff ** 2).mean()))
    bias = float(diff.mean())
    loa_u = bias + 1.96 * float(diff.std())
    loa_l = bias - 1.96 * float(diff.std())

    n = len(fc_ref)
    m1, m2 = float(fc_ref.mean()), float(fc_dev.mean())
    v1, v2 = float(fc_ref.var()), float(fc_dev.var())
    cov = float(((fc_ref - m1) * (fc_dev - m2)).mean())
    ccc = (2 * cov) / (v1 + v2 + (m1 - m2) ** 2) if (v1 + v2) > 0 else 0.0

    data        = np.column_stack([fc_ref.values, fc_dev.values])
    grand_mean  = data.mean()
    subj_means  = data.mean(axis=1)
    rater_means = data.mean(axis=0)
    ss_b = 2 * np.sum((subj_means  - grand_mean) ** 2)
    ss_j =  n * np.sum((rater_means - grand_mean) ** 2)
    ss_t = np.sum((data - grand_mean) ** 2)
    ss_e = ss_t - ss_b - ss_j
    ms_b = ss_b / (n - 1)
    ms_j = ss_j / 1
    ms_e = ss_e / (n - 1)
    denom = ms_b + ms_e + 2 * (ms_j - ms_e) / n
    icc   = (ms_b - ms_e) / denom if denom > 0 else 0.0

    try:
        r, p = stats.pearsonr(fc_ref.values, fc_dev.values)
    except Exception:
        r, p = 0.0, 1.0

    try:
        lr = stats.linregress(fc_ref.values, fc_dev.values)
        slope     = round(float(lr.slope), 4)
        intercept = round(float(lr.intercept), 2)
    except Exception:
        slope     = 1.0
        intercept = 0.0

    return {
        "mae":       round(mae,  2),
        "mape":      round(mape, 2),
        "rmse":      round(rmse, 2),
        "bias":      round(bias, 2),
        "loa_u":     round(loa_u, 2),
        "loa_l":     round(loa_l, 2),
        "ccc":       round(ccc,  4),
        "icc":       round(float(icc), 4),
        "r":         round(r,    4),
        "p":         float(p),
        "slope":     slope,
        "intercept": intercept,
        "n":           n,
        "media_ref":   round(m1, 1),
        "media_dev":   round(m2, 1),
        # error = device_hr - reference_hr  (positive = overestimation)
        "within_3_bpm":  round(float((diff.abs() <= 3).mean()  * 100), 1),
        "within_5_bpm":  round(float((diff.abs() <= 5).mean()  * 100), 1),
        "within_10_bpm": round(float((diff.abs() <= 10).mean() * 100), 1),
    }


def analyze_by_zones(fc_ref: pd.Series, fc_dev: pd.Series, fcmax: int = None, zone_boundaries=None):
    """Per-zone validation metrics.
    zone_boundaries: list of (name, lo, hi) tuples. Defaults to absolute ZONAS_FC ranges.
    Note: current zones are absolute ppm thresholds, not personalised % of FCmax.
    """
    fcmax_final = int(fcmax) if fcmax is not None else int(fc_ref.max())
    zones = zone_boundaries if zone_boundaries is not None else ZONAS_FC
    results = []
    for name, lo, hi in zones:
        mask  = (fc_ref >= lo) & (fc_ref < hi)
        n     = int(mask.sum())
        lo_str = f"<{hi}" if lo == 0 else f"{lo}-{hi}" if hi < 999 else f">{lo}"
        entry = {
            "zone":     name,
            "range":    f"{lo_str} ppm",
            "n":        n,
            "pct_time": round(n / len(fc_ref) * 100, 1),
            "mae":  None,
            "mape": None,
            "bias": None,
        }
        if n >= 5:
            m = calculate_metrics(fc_ref[mask], fc_dev[mask])
            entry.update({"mae": m["mae"], "mape": m["mape"], "bias": m["bias"]})
        results.append(entry)
    return results, fcmax_final


def estimate_lag(fc_ref: pd.Series, fc_dev: pd.Series, max_lag: int = 30) -> int:
    """Cross-correlation lag estimate (seconds). Positive = device is delayed."""
    x = fc_ref.values - fc_ref.mean()
    y = fc_dev.values - fc_dev.mean()
    corr   = correlate(x, y, mode="full")
    lags   = np.arange(-(len(x) - 1), len(y))
    center = len(x) - 1
    valid  = slice(center - max_lag, center + max_lag + 1)
    return int(lags[valid][np.argmax(corr[valid])])


# ─────────────────────────────────────────────────────────────────────────────
# 4. CHART HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _style_ax(ax):
    """Light professional axes style."""
    ax.set_facecolor("#fafbfd")
    for s in ax.spines.values():
        s.set_color("#d1d5db")
        s.set_linewidth(0.8)
    ax.tick_params(colors="#6b7280", labelsize=9, length=3)
    ax.grid(True, color="#e5e8ef", linewidth=0.7, linestyle="-", alpha=0.9)
    ax.set_axisbelow(True)


def _sec_to_mmss(x, _):
    s = int(x)
    if s < 0:
        return ""
    h, r  = divmod(s, 3600)
    m, sc = divmod(r, 60)
    return f"{h}:{m:02d}:{sc:02d}" if h else f"{m}:{sc:02d}"


def _fig_to_base64(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=160, bbox_inches="tight",
                facecolor=fig.get_facecolor())
    buf.seek(0)
    b64 = base64.b64encode(buf.read()).decode("utf-8")
    plt.close(fig)
    return b64


# ─────────────────────────────────────────────────────────────────────────────
# 5. TEMPORAL CHART (individual session)
# ─────────────────────────────────────────────────────────────────────────────

def generate_temporal_chart(
    fc_ref: pd.Series, fc_dev: pd.Series,
    ref_name: str, dev_name: str,
    x_seg: np.ndarray,
) -> str:
    """FC time-series comparison chart. Returns base64 PNG."""
    C_REF = "#1d4ed8"   # azul intenso (referencia)
    C_DEV = "#dc2626"   # rojo intenso (dispositivo)
    SUAV  = 15
    fmt   = FuncFormatter(_sec_to_mmss)

    fc1_s = fc_ref.rolling(SUAV, center=True, min_periods=1).mean()
    fc2_s = fc_dev.rolling(SUAV, center=True, min_periods=1).mean()

    fig, ax = plt.subplots(figsize=(15, 5), facecolor="#ffffff")
    ax.set_facecolor("#ffffff")
    _style_ax(ax)

    # Raw signal — muy sutil
    ax.plot(x_seg, fc_ref.values, color=C_REF, alpha=0.10, linewidth=0.5)
    ax.plot(x_seg, fc_dev.values, color=C_DEV, alpha=0.10, linewidth=0.5)

    # Smoothed lines
    l_ref, = ax.plot(x_seg, fc1_s.values, color=C_REF, linewidth=2.2,
                     label=f"{ref_name} (referencia)")
    l_dev, = ax.plot(x_seg, fc2_s.values, color=C_DEV, linewidth=2.2,
                     label=dev_name)

    # Fill between
    ax.fill_between(x_seg, fc1_s.values, fc2_s.values,
                    where=fc2_s.values >= fc1_s.values,
                    alpha=0.09, color=C_DEV, interpolate=True)
    ax.fill_between(x_seg, fc1_s.values, fc2_s.values,
                    where=fc2_s.values < fc1_s.values,
                    alpha=0.09, color=C_REF, interpolate=True)

    # FCmax annotation
    for fc_s, c in [(fc1_s, C_REF), (fc2_s, C_DEV)]:
        idx_max = fc_s.idxmax()
        ax.annotate(f"{int(fc_s[idx_max])} ppm",
                    xy=(idx_max, fc_s[idx_max]),
                    xytext=(0, 14), textcoords="offset points",
                    color=c, fontsize=8.5, ha="center", fontweight="600",
                    arrowprops=dict(arrowstyle="-", color=c, lw=0.8))

    ax.set_ylabel("FC (ppm)", color="#374151", fontsize=11)
    ax.set_xlabel("Tiempo", color="#374151", fontsize=11)
    ax.yaxis.set_minor_locator(MultipleLocator(5))
    ax.xaxis.set_major_formatter(fmt)
    ax.legend(handles=[l_ref, l_dev], loc="upper center", ncol=2, fontsize=10,
              facecolor="#ffffff", edgecolor="#e5e7eb", labelcolor="#111827",
              framealpha=0.9)

    fig.suptitle(
        f"Frecuencia cardíaca (ppm) — {dev_name}  vs  {ref_name}",
        color="#111827", fontsize=13, fontweight="bold", y=1.01,
    )
    fig.patch.set_linewidth(0)
    return _fig_to_base64(fig)


# ─────────────────────────────────────────────────────────────────────────────
# 6. VALIDATION CHART (correlation + Bland-Altman + zones)
# ─────────────────────────────────────────────────────────────────────────────

def generate_validation_chart(
    fc_ref: pd.Series, fc_dev: pd.Series,
    metrics: dict, zones: list, fcmax: int,
    ref_name: str, dev_name: str,
    title_suffix: str = "",
) -> str:
    """3-panel validation chart. Returns base64 PNG."""
    x_vals    = fc_ref.values
    y_vals    = fc_dev.values
    diff_vals = y_vals - x_vals
    mean_vals = (x_vals + y_vals) / 2.0

    x_lo   = min(np.nanmin(x_vals), np.nanmin(y_vals)) - 2
    x_hi   = max(np.nanmax(x_vals), np.nanmax(y_vals)) + 2
    x_line = np.linspace(x_lo, x_hi, 300)

    fig = plt.figure(figsize=(17, 6), facecolor="#ffffff")
    gs  = gridspec.GridSpec(1, 3, fig, wspace=0.32)
    ax_corr = fig.add_subplot(gs[0])
    ax_ba   = fig.add_subplot(gs[1])
    ax_zona = fig.add_subplot(gs[2])
    for ax in [ax_corr, ax_ba, ax_zona]:
        _style_ax(ax)

    # ── Correlation ──
    zone_idx = np.zeros(len(x_vals), dtype=int)
    for zi, (_, zlo, zhi) in enumerate(ZONAS_FC):
        zone_idx[(x_vals >= zlo) & (x_vals < zhi)] = zi

    n_sample = min(len(x_vals), 4000)
    idx_s = np.random.choice(len(x_vals), n_sample, replace=False)
    for zi in range(len(ZONAS_FC)):
        sel = idx_s[zone_idx[idx_s] == zi]
        if len(sel):
            ax_corr.scatter(x_vals[sel], y_vals[sel],
                            color=COLORES_ZONA[zi], alpha=0.4, s=10, linewidths=0)

    ax_corr.plot(x_line, x_line, color="#dc2626", lw=1.8, ls="--",
                 label="y = x  (acuerdo perfecto)")
    ax_corr.plot(x_line, metrics["slope"] * x_line + metrics["intercept"],
                 color="#d97706", lw=2,
                 label=f"y = {metrics['slope']}x + {metrics['intercept']}")

    n      = metrics["n"]
    x_mean = x_vals.mean()
    resid  = y_vals - (metrics["slope"] * x_vals + metrics["intercept"])
    se_line = np.sqrt(
        np.sum(resid ** 2) / (n - 2) *
        (1 / n + (x_line - x_mean) ** 2 / np.sum((x_vals - x_mean) ** 2))
    )
    t95   = stats.t.ppf(0.975, df=n - 2)
    y_fit = metrics["slope"] * x_line + metrics["intercept"]
    ax_corr.fill_between(x_line, y_fit - t95 * se_line, y_fit + t95 * se_line,
                         color="#d97706", alpha=0.12, label="IC 95%")

    p_str = f"{metrics['p']:.2e}" if metrics["p"] >= 1e-16 else "< 2.2e-16"
    ax_corr.text(0.05, 0.96,
                 f"R = {metrics['r']}   R² = {round(metrics['r']**2, 3)}\n"
                 f"CCC = {metrics['ccc']}   ICC = {metrics['icc']}\n"
                 f"p {p_str}",
                 transform=ax_corr.transAxes, fontsize=8.5, color="#111827", va="top",
                 bbox=dict(boxstyle="round,pad=0.4", facecolor="#f3f4f6", edgecolor="#d1d5db"))
    _log.debug("generate_validation_chart set_xlim corr: x_lo=%s x_hi=%s", x_lo, x_hi)
    ax_corr.set_xlim(x_lo, x_hi)
    ax_corr.set_ylim(x_lo, x_hi)
    ax_corr.set_xlabel(f"{ref_name}  (ppm)", color="#374151", fontsize=10)
    ax_corr.set_ylabel(f"{dev_name}  (ppm)", color="#374151", fontsize=10)
    ax_corr.set_title("Correlación", color="#111827", fontsize=11, pad=8)
    ax_corr.set_aspect("equal")
    ax_corr.legend(loc="lower right", fontsize=7.5,
                   facecolor="#ffffff", edgecolor="#e5e7eb", labelcolor="#374151")

    # ── Bland-Altman ──
    for zi, (_, plo, phi) in enumerate(ZONAS_FC):
        mask = (x_vals >= plo) & (x_vals < phi)
        sel  = np.where(mask)[0]
        if len(sel):
            n_plot = min(len(sel), 1000)
            idx_p  = np.random.choice(sel, n_plot, replace=False)
            ax_ba.scatter(mean_vals[idx_p], diff_vals[idx_p],
                          color=COLORES_ZONA[zi], alpha=0.3, s=8, linewidths=0,
                          label=ZONAS_FC[zi][0].split("(")[0].strip())

    ax_ba.axhline(metrics["bias"], color="#d97706", lw=1.8,
                  label=f"Bias = {metrics['bias']} ppm")
    ax_ba.axhline(metrics["loa_u"], color="#dc2626", lw=1.2, ls="--",
                  label=f"+LoA = {metrics['loa_u']} ppm")
    ax_ba.axhline(metrics["loa_l"], color="#2563eb", lw=1.2, ls="--",
                  label=f"−LoA = {metrics['loa_l']} ppm")
    ax_ba.fill_between([mean_vals.min() - 2, mean_vals.max() + 2],
                       metrics["loa_l"], metrics["loa_u"],
                       alpha=0.07, color="#d97706")
    _log.debug("generate_validation_chart set_xlim ba: min=%s max=%s", np.nanmin(mean_vals), np.nanmax(mean_vals))
    ax_ba.set_xlim(np.nanmin(mean_vals) - 2, np.nanmax(mean_vals) + 2)
    ax_ba.set_xlabel("Media de los dos dispositivos (ppm)", color="#374151", fontsize=9)
    ax_ba.set_ylabel("Diferencia: dispositivo − referencia (ppm)", color="#374151", fontsize=9)
    ax_ba.set_title("Bland-Altman", color="#111827", fontsize=11, pad=8)
    ax_ba.legend(loc="upper right", fontsize=7,
                 facecolor="#ffffff", edgecolor="#e5e7eb", labelcolor="#374151")

    # ── MAE & MAPE by zone ──
    names_z   = [z["zone"].split("(")[0].strip() for z in zones]
    mae_vals  = [z["mae"]  if z["mae"]  is not None else 0.0 for z in zones]
    mape_vals = [z["mape"] if z["mape"] is not None else 0.0 for z in zones]
    has_data  = [z["mae"]  is not None for z in zones]
    x_pos     = np.arange(len(zones))
    w         = 0.38

    ax2 = ax_zona.twinx()
    ax2.set_facecolor("#fafbfd")
    ax2.tick_params(colors="#6b7280", labelsize=9)

    for xp, mv, mpv, col, ok in zip(x_pos, mae_vals, mape_vals,
                                     COLORES_ZONA[:len(zones)], has_data):
        alpha = 0.85 if ok else 0.2
        ax_zona.bar(xp - w / 2, mv,  width=w, color=col, alpha=alpha)
        ax2.bar(    xp + w / 2, mpv, width=w, color=col, alpha=alpha * 0.55)
        if not ok:
            ax_zona.text(xp, 0.3, "sin\ndatos", ha="center", va="bottom",
                         fontsize=6.5, color="#666")

    ax2.axhline(10, color="#dc2626", lw=1, ls="--", alpha=0.7)
    ax2.text(len(zones) - 0.45, 10.3, "umbral 10%", color="#dc2626", fontsize=7)

    ax_zona.set_xticks(x_pos)
    ax_zona.set_xticklabels(names_z, rotation=30, ha="right", color="#374151", fontsize=8)
    ax_zona.set_ylabel("MAE (ppm)", color="#374151", fontsize=10)
    ax2.set_ylabel("MAPE (%)", color="#374151", fontsize=10)
    ax_zona.set_title(f"Error por zona  (FCmax = {fcmax} ppm)",
                      color="#111827", fontsize=11, pad=8)

    leg_handles = [Patch(color="#6b7280", alpha=0.85, label="MAE (ppm)"),
                   Patch(color="#6b7280", alpha=0.45, label="MAPE (%)")]
    ax_zona.legend(handles=leg_handles, loc="upper left", fontsize=8,
                   facecolor="#ffffff", edgecolor="#e5e7eb", labelcolor="#374151")

    title = f"Validación científica — {dev_name}  vs  {ref_name}"
    if title_suffix:
        title += f"  [{title_suffix}]"
    fig.suptitle(title, color="#111827", fontsize=13, fontweight="bold", y=1.01)

    return _fig_to_base64(fig)


# ─────────────────────────────────────────────────────────────────────────────
# 7. PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

def analyze_session(
    device_bytes: bytes,
    reference_bytes: bytes,
    device_name: str = "Dispositivo",
    ref_name: str = "Referencia",
    device_filename: str = "",
    reference_filename: str = "",
) -> dict:
    """
    Full analysis for one training session.
    Returns metrics, zones, lag, fcmax, two charts (base64), and downsampled FC data.
    """
    fc_ref = read_fc_from_bytes(reference_bytes, reference_filename)
    fc_dev = read_fc_from_bytes(device_bytes, device_filename)

    ref_aligned, dev_aligned, x_seg, _ = align(fc_ref, fc_dev)

    metrics = calculate_metrics(ref_aligned, dev_aligned)
    zones, fcmax = analyze_by_zones(ref_aligned, dev_aligned)
    lag = estimate_lag(ref_aligned, dev_aligned)

    temporal_chart   = generate_temporal_chart(
        ref_aligned, dev_aligned, ref_name, device_name, x_seg
    )
    validation_chart = generate_validation_chart(
        ref_aligned, dev_aligned, metrics, zones, fcmax, ref_name, device_name
    )

    # Downsample for storage — keep ≤2 000 points per session
    step = max(1, len(ref_aligned) // 2000)
    fc_data = {
        "reference": ref_aligned.values[::step].round(1).tolist(),
        "device":    dev_aligned.values[::step].round(1).tolist(),
        "time":      x_seg[::step].tolist(),
        "step":      step,
    }

    # Activity start date from the earliest timestamp in the device file
    activity_date = datetime.utcfromtimestamp(int(fc_dev.index[0]))

    return {
        "metrics":          metrics,
        "zones":            zones,
        "lag":              lag,
        "fcmax":            fcmax,
        "duration_seconds": int(len(ref_aligned)),
        "activity_date":    activity_date,
        "charts": {
            "temporal":   temporal_chart,
            "validation": validation_chart,
        },
        "fc_data": fc_data,
    }


def generate_aggregate_analysis(
    sessions_data: list,
    training_type: str,
    dev_name: str = "Dispositivo",
    ref_name: str = "Referencia",
) -> dict:
    """
    Aggregate analysis: combines FC data from multiple sessions and runs the
    full validation on the concatenated dataset.
    """
    all_ref: list[float] = []
    all_dev: list[float] = []

    for s in sessions_data:
        fc_data = s.get("fc_data", {})
        all_ref.extend(fc_data.get("reference", []))
        all_dev.extend(fc_data.get("device", []))

    if not all_ref:
        raise ValueError("No se encontraron datos de FC en las sesiones seleccionadas.")

    combined_ref = pd.Series(all_ref, dtype=float)
    combined_dev = pd.Series(all_dev, dtype=float)

    metrics = calculate_metrics(combined_ref, combined_dev)
    zones, fcmax = analyze_by_zones(combined_ref, combined_dev)

    chart = generate_validation_chart(
        combined_ref, combined_dev, metrics, zones, fcmax,
        ref_name, dev_name,
        title_suffix=f"Agregado — {len(sessions_data)} sesiones · {training_type}",
    )

    return {
        "metrics":       metrics,
        "zones":         zones,
        "fcmax":         fcmax,
        "n_sessions":    len(sessions_data),
        "total_samples": len(combined_ref),
        "chart":         chart,
    }


def _session_weight(session_difficulty: str) -> float:
    """Difficulty weight from DIFFICULTY_WEIGHTS. Unknown difficulties default to 1.0."""
    key = (session_difficulty or "").lower()
    w = DIFFICULTY_WEIGHTS.get(key)
    if w is None:
        _log.warning("Unknown session_difficulty %r — using weight 1.0", session_difficulty)
        return 1.0
    return w


def _weighted_global_score(sessions_info: list) -> dict | None:
    """
    Editorial score weighted by session difficulty (not a statistical aggregate).

    MAE is computed as relative (%) to mean reference HR so sessions with
    different HR ranges are comparable. This is an editorial score for
    PPG sensor difficulty — not a replacement for balanced_by_session metrics.

    Returns keys prefixed with difficulty_weighted_* to distinguish from
    statistical aggregates.
    """
    weights, mae_rels, biases, fisher_zs, cccs, lags = [], [], [], [], [], []

    for s in sessions_info:
        m = s.get("metrics") or {}
        mae      = m.get("mae")
        fc_media = m.get("media_ref")
        bias     = m.get("bias")
        r        = m.get("r")
        ccc      = m.get("ccc")
        lag      = s.get("lag")

        if mae is None or fc_media is None or fc_media == 0:
            continue

        w = _session_weight(s.get("session_difficulty", ""))
        mae_rel = mae / fc_media * 100

        weights.append(w)
        mae_rels.append(mae_rel)
        biases.append(bias if bias is not None else 0.0)
        cccs.append(ccc if ccc is not None else 0.0)
        lags.append(float(lag) if lag is not None else 0.0)

        r_clip = float(np.clip(r if r is not None else 0.0, -0.9999, 0.9999))
        fisher_zs.append(0.5 * np.log((1 + r_clip) / (1 - r_clip)))

    if not weights:
        return None

    W = sum(weights)
    mae_global  = sum(m * w for m, w in zip(mae_rels,  weights)) / W
    bias_global = sum(b * w for b, w in zip(biases,    weights)) / W
    z_mean      = sum(z * w for z, w in zip(fisher_zs, weights)) / W
    r_global    = float((np.exp(2 * z_mean) - 1) / (np.exp(2 * z_mean) + 1))
    ccc_global  = sum(c * w for c, w in zip(cccs, weights)) / W
    lag_mean    = sum(l * w for l, w in zip(lags, weights)) / W

    return {
        "difficulty_weighted_mae":         round(mae_global,  2),  # relative % to mean HR
        "difficulty_weighted_bias":        round(bias_global, 2),
        "difficulty_weighted_correlation": round(r_global,    4),
        "difficulty_weighted_ccc":         round(ccc_global,  4),
        "lag_mean":                        round(lag_mean,    1),
        "n_sessions":                      len(weights),
        "total_weight":                    round(W, 1),
        "weights_used":                    dict(DIFFICULTY_WEIGHTS),
    }


# ─────────────────────────────────────────────────────────────────────────────
# 8. BALANCED SPORT AGGREGATE
# ─────────────────────────────────────────────────────────────────────────────

def generate_sport_aggregate(session_results: list) -> dict:
    """
    Balanced aggregate: every session contributes equally regardless of duration.

    session_results: list of dicts, each with:
        session_id, sport_type, training_type, session_difficulty,
        metrics (from calculate_metrics), lag (int), duration_seconds (int),
        fc_data (dict with reference/device lists — may be omitted for lightweight use)

    Returns:
        balanced_by_session — primary result, equal weight per session
        weighted_by_samples — secondary result, concatenated signal (or None if no fc_data)
        bland_altman        — concatenated + session-level summary
        per_session         — individual breakdown
    """
    valid = [s for s in session_results if s.get("metrics")]
    n = len(valid)
    if n == 0:
        raise ValueError("No hay sesiones válidas para el agregado.")

    def _clean(vals):
        return [v for v in vals
                if v is not None and not (isinstance(v, float) and (math.isnan(v) or math.isinf(v)))]

    def _mean(vals):
        c = _clean(vals)
        return (round(sum(c) / len(c), 4) if c else None), len(c)

    def _std(vals):
        c = _clean(vals)
        if len(c) < 2:
            return None
        m = sum(c) / len(c)
        return round(math.sqrt(sum((v - m) ** 2 for v in c) / (len(c) - 1)), 4)

    # ── Fisher Z balanced Pearson R ──────────────────────────────────────────
    fisher_zs = []
    for s in valid:
        r = s["metrics"].get("r")
        if r is None or (isinstance(r, float) and (math.isnan(r) or math.isinf(r))):
            continue
        r_clip = max(-0.999999, min(0.999999, float(r)))
        fisher_zs.append(math.atanh(r_clip))

    balanced_r = math.tanh(sum(fisher_zs) / len(fisher_zs)) if fisher_zs else None

    # ── Per-metric lists ─────────────────────────────────────────────────────
    def _mget(key):
        return [s["metrics"].get(key) for s in valid]

    mae_vals   = _mget("mae")
    mape_vals  = _mget("mape")
    rmse_vals  = _mget("rmse")
    bias_vals  = _mget("bias")
    ccc_vals   = _mget("ccc")
    icc_vals   = _mget("icc")
    slope_vals = _mget("slope")
    loa_l_vals = _mget("loa_l")
    loa_u_vals = _mget("loa_u")
    w3_vals    = _mget("within_3_bpm")
    w5_vals    = _mget("within_5_bpm")
    w10_vals   = _mget("within_10_bpm")
    lag_vals   = [s.get("lag") for s in valid]

    mae_clean = _clean(mae_vals)

    balanced = {
        "pearson_fisher":             round(balanced_r, 4) if balanced_r is not None else None,
        "valid_correlation_sessions": len(fisher_zs),
        "mae":                        _mean(mae_vals)[0],
        "mae_between_session_sd":     _std(mae_vals),
        "mae_min":                    round(min(mae_clean), 2) if mae_clean else None,
        "mae_max":                    round(max(mae_clean), 2) if mae_clean else None,
        "valid_mae_sessions":         _mean(mae_vals)[1],
        "mape":                       _mean(mape_vals)[0],
        "rmse":                       _mean(rmse_vals)[0],
        "bias":                       _mean(bias_vals)[0],
        "ccc":                        _mean(ccc_vals)[0],
        "icc":                        _mean(icc_vals)[0],
        "slope_mean":                 _mean(slope_vals)[0],
        "lag_mean_seconds":           _mean(lag_vals)[0],
        "within_3_bpm":               _mean(w3_vals)[0],
        "within_5_bpm":               _mean(w5_vals)[0],
        "within_10_bpm":              _mean(w10_vals)[0],
    }

    # ── Sample-weighted (concatenated signals) ───────────────────────────────
    all_ref, all_dev = [], []
    ba_points = []
    for s in valid:
        fc  = s.get("fc_data") or {}
        ref_pts = fc.get("reference", [])
        dev_pts = fc.get("device",    [])
        sid = s.get("session_id", "")
        tt  = s.get("training_type", "")
        sd  = s.get("session_difficulty", "")
        for r_val, d_val in zip(ref_pts, dev_pts):
            if r_val is not None and d_val is not None:
                all_ref.append(float(r_val))
                all_dev.append(float(d_val))
                ba_points.append({
                    "session_id":         sid,
                    "training_type":      tt,
                    "session_difficulty": sd,
                    "mean":               (float(r_val) + float(d_val)) / 2,
                    "diff":               float(d_val) - float(r_val),  # positive = overestimation
                })

    if all_ref:
        sw_m = calculate_metrics(pd.Series(all_ref, dtype=float),
                                  pd.Series(all_dev, dtype=float))
        weighted_by_samples: dict | None = {
            "pearson_r": sw_m["r"],
            "mae":       sw_m["mae"],
            "mape":      sw_m["mape"],
            "rmse":      sw_m["rmse"],
            "bias":      sw_m["bias"],
            "ccc":       sw_m["ccc"],
            "icc":       sw_m["icc"],
            "n_samples": sw_m["n"],
        }
        diffs = [p["diff"] for p in ba_points]
        bias_c = sum(diffs) / len(diffs)
        sd_c = math.sqrt(sum((d - bias_c) ** 2 for d in diffs) / max(len(diffs) - 1, 1))
        ba_concat: dict | None = {
            "bias":      round(bias_c, 2),
            "sd":        round(sd_c, 2),
            "lower_loa": round(bias_c - 1.96 * sd_c, 2),
            "upper_loa": round(bias_c + 1.96 * sd_c, 2),
            "n_points":  len(ba_points),
        }
    else:
        weighted_by_samples = None
        ba_concat = None

    ba_balanced = {
        "mean_session_bias": _mean(bias_vals)[0],
        "session_bias_sd":   _std(bias_vals),
        "mean_lower_loa":    _mean(loa_l_vals)[0],
        "mean_upper_loa":    _mean(loa_u_vals)[0],
        "n_sessions":        _mean(bias_vals)[1],
    }

    # ── Per-session breakdown ────────────────────────────────────────────────
    per_session = []
    for s in valid:
        m = s["metrics"]
        per_session.append({
            "session_id":         s.get("session_id"),
            "training_type":      s.get("training_type"),
            "session_difficulty": s.get("session_difficulty"),
            "valid_samples":      m.get("n"),
            "duration_seconds":   s.get("duration_seconds"),
            "metrics": {
                "pearson_r":        m.get("r"),
                "mae":              m.get("mae"),
                "mape":             m.get("mape"),
                "rmse":             m.get("rmse"),
                "bias":             m.get("bias"),
                "loa_lower":        m.get("loa_l"),
                "loa_upper":        m.get("loa_u"),
                "ccc":              m.get("ccc"),
                "icc":              m.get("icc"),
                "regression_slope": m.get("slope"),
                "lag_seconds":      s.get("lag"),
                "mean_ref_hr":      m.get("media_ref"),
                "within_3_bpm":     m.get("within_3_bpm"),
                "within_5_bpm":     m.get("within_5_bpm"),
                "within_10_bpm":    m.get("within_10_bpm"),
            },
        })

    return {
        "session_count":       n,
        "balanced_by_session": balanced,
        "weighted_by_samples": weighted_by_samples,
        "bland_altman": {
            "concatenated":             ba_concat,
            "balanced_session_summary": ba_balanced,
        },
        "per_session": per_session,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 9. OVERVIEW CHART
# ─────────────────────────────────────────────────────────────────────────────

_CRITERION_CONFIG: dict[str, dict] = {
    "mae": {
        "bal_key":          "mae",
        "label":            "MAE equilibrado (ppm)",
        "higher_is_better": False,
        "thresholds":       [(2, "#16a34a", "≤2"), (5, "#d97706", "≤5"), (10, "#ea580c", "≤10")],
        "fmt":              ".1f",
    },
    "rmse": {
        "bal_key":          "rmse",
        "label":            "RMSE equilibrado (ppm)",
        "higher_is_better": False,
        "thresholds":       [(3, "#16a34a", "≤3"), (6, "#d97706", "≤6"), (12, "#ea580c", "≤12")],
        "fmt":              ".1f",
    },
    "pearson_fisher": {
        "bal_key":          "pearson_fisher",
        "label":            "Pearson R (Fisher, equilibrado)",
        "higher_is_better": True,
        "thresholds":       [(0.95, "#16a34a", "0.95"), (0.90, "#d97706", "0.90"), (0.80, "#ea580c", "0.80")],
        "fmt":              ".4f",
    },
    "ccc": {
        "bal_key":          "ccc",
        "label":            "CCC medio",
        "higher_is_better": True,
        "thresholds":       [(0.95, "#16a34a", "0.95"), (0.90, "#d97706", "0.90"), (0.80, "#ea580c", "0.80")],
        "fmt":              ".4f",
    },
    "within_5_bpm": {
        "bal_key":          "within_5_bpm",
        "label":            "Dentro de ±5 ppm (%)",
        "higher_is_better": True,
        "thresholds":       [(95, "#16a34a", "95%"), (85, "#d97706", "85%"), (70, "#ea580c", "70%")],
        "fmt":              ".1f",
    },
    "within_3_bpm": {
        "bal_key":          "within_3_bpm",
        "label":            "Dentro de ±3 ppm (%)",
        "higher_is_better": True,
        "thresholds":       [(90, "#16a34a", "90%"), (75, "#d97706", "75%"), (60, "#ea580c", "60%")],
        "fmt":              ".1f",
    },
    "within_10_bpm": {
        "bal_key":          "within_10_bpm",
        "label":            "Dentro de ±10 ppm (%)",
        "higher_is_better": True,
        "thresholds":       [(99, "#16a34a", "99%"), (95, "#d97706", "95%"), (90, "#ea580c", "90%")],
        "fmt":              ".1f",
    },
    "difficulty_weighted": {
        "dw_key":           "difficulty_weighted_correlation",
        "label":            "R ponderado por dificultad (editorial)",
        "higher_is_better": True,
        "thresholds":       [(0.95, "#16a34a", "0.95"), (0.90, "#d97706", "0.90"), (0.80, "#ea580c", "0.80")],
        "fmt":              ".4f",
    },
}
VALID_CHART_CRITERIA = set(_CRITERION_CONFIG.keys())


def generate_overview_chart(
    devices_data: list,
    criterion: str = "mae",
) -> str:
    """
    Lollipop chart comparing devices by the chosen criterion.

    devices_data entries must include:
        name, reference_name, session_count, total_samples, sport_type,
        balanced_by_session (dict from generate_sport_aggregate),
        difficulty_weighted (dict from _weighted_global_score, optional)

    criterion: one of VALID_CHART_CRITERIA
    """
    cfg = _CRITERION_CONFIG.get(criterion, _CRITERION_CONFIG["mae"])
    higher_is_better = cfg["higher_is_better"]

    def _get_val(dev: dict) -> float | None:
        if "bal_key" in cfg:
            return (dev.get("balanced_by_session") or {}).get(cfg["bal_key"])
        if "dw_key" in cfg:
            return (dev.get("difficulty_weighted") or {}).get(cfg["dw_key"])
        return None

    def _color(val: float) -> str:
        thresholds = cfg["thresholds"]
        if higher_is_better:
            for t, c, _ in thresholds:
                if val >= t:
                    return c
            return "#dc2626"
        else:
            for t, c, _ in thresholds:
                if val <= t:
                    return c
            return "#dc2626"

    entries = []
    for dev in devices_data:
        val = _get_val(dev)
        if val is None:
            continue
        bal = dev.get("balanced_by_session") or {}
        entries.append({
            "name":          dev["name"],
            "ref_name":      dev.get("reference_name", ""),
            "value":         val,
            "mae":           bal.get("mae"),
            "mae_sd":        bal.get("mae_between_session_sd"),
            "bias":          bal.get("bias"),
            "sessions":      dev.get("session_count", 0),
            "total_samples": dev.get("total_samples", 0),
            "sport_type":    dev.get("sport_type", ""),
        })

    if not entries:
        raise ValueError("No hay datos suficientes para generar el gráfico global.")

    # Sort: ascending if lower-is-better, descending if higher-is-better
    # Both orderings put the best device at the top of the chart.
    entries.sort(key=lambda x: x["value"], reverse=higher_is_better)

    names  = [e["name"]  for e in entries]
    values = [e["value"] for e in entries]
    n_devs = len(entries)
    colors = [_color(v) for v in values]
    fmt    = cfg["fmt"]

    val_range = max(values) - min(values)
    x_pad = val_range * 0.05 if val_range > 0 else abs(values[0]) * 0.05 or 0.01
    x_min = min(values) - x_pad
    x_max = max(values) + val_range * 0.35 + x_pad

    fig_h = max(5, n_devs * 0.65 + 2.2)
    fig, ax = plt.subplots(figsize=(10, fig_h), facecolor="#ffffff")
    _style_ax(ax)

    y_pos = np.arange(n_devs)
    for y, v, c in zip(y_pos, values, colors):
        ax.hlines(y, x_min, v, colors="#d1d5db", linewidth=1.2, zorder=2)
    ax.scatter(values, y_pos, color=colors, s=90, zorder=4)

    for y, e, c in zip(y_pos, entries, colors):
        val_str  = f"{e['value']:{fmt}}"
        mae_str  = ""
        if e.get("mae") is not None:
            mae_str = f"  MAE {e['mae']:.1f}"
            if e.get("mae_sd") is not None:
                mae_str += f"±{e['mae_sd']:.1f}"
            mae_str += " ppm"
        bias_str = ""
        if e.get("bias") is not None:
            sign = "+" if e["bias"] > 0 else ""
            bias_str = f"  bias {sign}{e['bias']:.1f}"
        ses_str  = f"  ({e['sessions']} ses.)"
        label = f" {val_str}{mae_str}{bias_str}{ses_str}"
        ax.text(e["value"] + x_pad * 0.3, y, label,
                va="center", ha="left", fontsize=7.5, color=c, fontweight="bold")

    for thresh, col, lbl in cfg["thresholds"]:
        ax.axvline(thresh, color=col, lw=0.8, ls=":", alpha=0.6, zorder=1)
        ax.text(thresh, -0.8, lbl, color=col, fontsize=7, ha="center", va="top")

    ref_label  = entries[0]["ref_name"] if entries else ""
    sport_label = entries[0]["sport_type"] if entries else ""
    ax.set_yticks(y_pos)
    ax.set_yticklabels(names, color="#111827", fontsize=10)
    ax.set_xlabel(cfg["label"], color="#374151", fontsize=10)
    _log.debug("generate_overview_chart set_xlim: x_min=%s x_max=%s n_devs=%s", x_min, x_max, n_devs)
    ax.set_xlim(x_min, x_max)
    ax.set_ylim(-1, n_devs)
    ax.tick_params(axis="x", colors="#6b7280")

    fig.suptitle(
        f"Comparativa global  ·  {sport_label}  ·  referencia: {ref_label}",
        color="#111827", fontsize=13, fontweight="bold",
    )
    fig.tight_layout()
    return _fig_to_base64(fig)


# ─────────────────────────────────────────────────────────────────────────────
# 10. SPORT-LEVEL TWO-CHART ANALYSIS
# ─────────────────────────────────────────────────────────────────────────────

def _session_color(idx: int) -> str:
    return SESSION_PALETTE[idx % len(SESSION_PALETTE)]


def generate_sport_correlation_chart(
    session_data: list,
    dev_name: str,
    ref_name: str,
    sport_type: str = "",
) -> str:
    """
    Correlation scatter chart for all sessions of a sport on one device.
    Each session is a distinct colour. Up to 800 random points per session.

    session_data: list of dicts with keys:
        label (str), ref (list[float]), dev (list[float]), mae (float|None)
    """
    fig, ax = plt.subplots(figsize=(8, 8), facecolor="#ffffff")
    _style_ax(ax)
    ax.set_aspect("equal")

    all_vals: list[float] = []
    handles = []

    for idx, s in enumerate(session_data):
        ref_arr = np.array(s["ref"], dtype=float)
        dev_arr = np.array(s["dev"], dtype=float)
        if len(ref_arr) == 0:
            continue

        col = _session_color(idx)
        # Subsample to ≤800 points for readability
        n = len(ref_arr)
        if n > 800:
            sel = np.random.choice(n, 800, replace=False)
            ref_arr = ref_arr[sel]
            dev_arr = dev_arr[sel]

        mae_txt = f"  MAE {s['mae']:.1f} ppm" if s.get("mae") is not None else ""
        lbl = f"{s['label']}{mae_txt}"
        sc = ax.scatter(ref_arr, dev_arr, color=col, alpha=0.35, s=12,
                        linewidths=0, label=lbl, zorder=3)
        handles.append(sc)
        all_vals.extend(ref_arr.tolist())
        all_vals.extend(dev_arr.tolist())

    if not all_vals:
        raise ValueError("No hay datos de FC para generar el gráfico.")

    lo = min(all_vals) - 2
    hi = max(all_vals) + 2
    x_line = np.linspace(lo, hi, 200)

    # Identity line
    ax.plot(x_line, x_line, color="#9ca3af", lw=1.5, ls="--",
            label="y = x  (acuerdo perfecto)", zorder=2)

    # Global regression across all concatenated data
    all_ref_c: list[float] = []
    all_dev_c: list[float] = []
    for s in session_data:
        all_ref_c.extend(s["ref"])
        all_dev_c.extend(s["dev"])
    if len(all_ref_c) >= 10:
        try:
            lr = stats.linregress(all_ref_c, all_dev_c)
            ax.plot(x_line, lr.slope * x_line + lr.intercept,
                    color="#111827", lw=1.8, ls="-",
                    label=f"Regresión global  y = {lr.slope:.3f}x + {lr.intercept:.1f}",
                    zorder=4)
        except Exception:
            pass

    _log.debug("generate_sport_correlation set_xlim: lo=%s hi=%s", lo, hi)
    ax.set_xlim(lo, hi)
    ax.set_ylim(lo, hi)
    ax.set_xlabel(f"{ref_name}  (ppm)", color="#374151", fontsize=11)
    ax.set_ylabel(f"{dev_name}  (ppm)", color="#374151", fontsize=11)
    ax.legend(loc="lower right", fontsize=8,
              facecolor="#ffffff", edgecolor="#e5e7eb", labelcolor="#374151",
              framealpha=0.92)
    sport_lbl = {"running": "Running", "cycling": "Ciclismo", "gym": "Gimnasio"}.get(sport_type, sport_type)
    fig.suptitle(
        f"Correlación FC — {dev_name}  vs  {ref_name}  ·  {sport_lbl}",
        color="#111827", fontsize=13, fontweight="bold",
    )
    fig.tight_layout()
    return _fig_to_base64(fig)


def generate_sport_bland_altman_chart(
    session_data: list,
    dev_name: str,
    ref_name: str,
    sport_type: str = "",
) -> str:
    """
    Bland-Altman chart for all sessions on one device+sport.
    Points coloured by session. Per-session bias shown as horizontal
    dashed segments spanning that session's mean range.
    Global bias and ±1.96 SD shown as solid reference lines.

    session_data: list of dicts with keys:
        label, ref (list[float]), dev (list[float]),
        bias (float|None), loa_l (float|None), loa_u (float|None)
    """
    fig, ax = plt.subplots(figsize=(10, 7), facecolor="#ffffff")
    _style_ax(ax)

    all_means: list[float] = []
    all_diffs: list[float]  = []
    session_stats: list[dict] = []

    for idx, s in enumerate(session_data):
        ref_arr = np.array(s["ref"], dtype=float)
        dev_arr = np.array(s["dev"], dtype=float)
        if len(ref_arr) < 3:
            continue

        col  = _session_color(idx)
        diffs = dev_arr - ref_arr          # positive = overestimation
        means = (ref_arr + dev_arr) / 2.0

        # Subsample for readability
        n = len(diffs)
        if n > 600:
            sel = np.random.choice(n, 600, replace=False)
            ax.scatter(means[sel], diffs[sel], color=col, alpha=0.25, s=9,
                       linewidths=0, zorder=2)
        else:
            ax.scatter(means, diffs, color=col, alpha=0.3, s=9,
                       linewidths=0, zorder=2)

        all_means.extend(means.tolist())
        all_diffs.extend(diffs.tolist())

        bias_s = float(diffs.mean())
        x_lo_s = float(means.min())
        x_hi_s = float(means.max())
        session_stats.append({
            "label": s["label"],
            "color": col,
            "bias":  bias_s,
            "x_lo":  x_lo_s,
            "x_hi":  x_hi_s,
        })

    if not all_diffs:
        raise ValueError("No hay datos de FC para generar el gráfico Bland-Altman.")

    all_means_arr = np.array(all_means)
    all_diffs_arr = np.array(all_diffs)
    global_bias   = float(all_diffs_arr.mean())
    global_sd     = float(all_diffs_arr.std(ddof=1))
    loa_u         = global_bias + 1.96 * global_sd
    loa_l         = global_bias - 1.96 * global_sd
    x_lo_g = all_means_arr.min() - 1
    x_hi_g = all_means_arr.max() + 1

    # Global reference lines
    ax.axhline(global_bias, color="#111827", lw=1.8,
               label=f"Bias global = {global_bias:+.2f} ppm", zorder=5)
    ax.axhline(loa_u, color="#dc2626", lw=1.3, ls="--",
               label=f"+LoA global = {loa_u:+.2f} ppm", zorder=5)
    ax.axhline(loa_l, color="#2563eb", lw=1.3, ls="--",
               label=f"−LoA global = {loa_l:+.2f} ppm", zorder=5)
    ax.fill_between([x_lo_g, x_hi_g], loa_l, loa_u,
                    alpha=0.05, color="#9ca3af", zorder=1)

    # Per-session bias segments
    for ss in session_stats:
        sign = "+" if ss["bias"] >= 0 else ""
        ax.hlines(ss["bias"], ss["x_lo"], ss["x_hi"],
                  colors=ss["color"], linewidth=2.5,
                  linestyles="solid", alpha=0.85, zorder=4,
                  label=f"{ss['label']}  bias = {sign}{ss['bias']:.2f}")
        # Small marker at segment midpoint
        mid = (ss["x_lo"] + ss["x_hi"]) / 2
        ax.plot(mid, ss["bias"], "o", color=ss["color"], ms=7, zorder=6)

    _log.debug("generate_sport_bland_altman set_xlim: x_lo_g=%s x_hi_g=%s loa_l=%s loa_u=%s", x_lo_g, x_hi_g, loa_l, loa_u)
    ax.set_xlim(x_lo_g, x_hi_g)
    y_pad = max(abs(loa_u), abs(loa_l)) * 0.25 + 2
    ax.set_ylim(loa_l - y_pad, loa_u + y_pad)
    ax.axhline(0, color="#d1d5db", lw=0.8, zorder=1)

    ax.set_xlabel(f"Media  ({ref_name} + {dev_name}) / 2  (ppm)",
                  color="#374151", fontsize=10)
    ax.set_ylabel(f"Diferencia  {dev_name} − {ref_name}  (ppm)",
                  color="#374151", fontsize=10)
    ax.legend(loc="upper right", fontsize=8, ncol=1,
              facecolor="#ffffff", edgecolor="#e5e7eb", labelcolor="#374151",
              framealpha=0.92)

    sport_lbl = {"running": "Running", "cycling": "Ciclismo", "gym": "Gimnasio"}.get(sport_type, sport_type)
    fig.suptitle(
        f"Bland-Altman por sesión — {dev_name}  vs  {ref_name}  ·  {sport_lbl}\n"
        f"Líneas horizontales = bias de cada sesión  ·  "
        f"Líneas negras = LoA global (±{1.96 * global_sd:.1f} ppm)",
        color="#111827", fontsize=12, fontweight="bold",
    )
    fig.tight_layout()
    return _fig_to_base64(fig)


def build_sport_chart_data(session_data: list) -> dict:
    """
    Returns raw points per session for Chart.js frontend charts.
    No matplotlib — data only.

    session_data: list of {label, ref: list[float], dev: list[float]}
    Returns:
        sessions: list of {label, points: [{x,y}], bias, mae}
        global_stats: {bias, loa_u, loa_l, pearson_r, slope, intercept}
    """
    sessions_out: list[dict] = []
    all_ref: list[float] = []
    all_dev: list[float] = []
    rng = np.random.default_rng(42)

    for s in session_data:
        ref_arr = np.array(s["ref"], dtype=float)
        dev_arr = np.array(s["dev"], dtype=float)
        if len(ref_arr) != len(dev_arr):
            n_common = min(len(ref_arr), len(dev_arr))
            ref_arr, dev_arr = ref_arr[:n_common], dev_arr[:n_common]

        # A single NaN/Inf reading (sensor dropout) would otherwise poison
        # this session's bias/mae and — once concatenated below — the
        # global stats for every session, silently blanking every chart.
        valid = np.isfinite(ref_arr) & np.isfinite(dev_arr)
        ref_arr, dev_arr = ref_arr[valid], dev_arr[valid]

        if len(ref_arr) < 3:
            continue

        diffs  = dev_arr - ref_arr
        bias_s = float(diffs.mean())
        mae_s  = float(np.abs(diffs).mean())

        n = len(ref_arr)
        if n > 500:
            sel   = rng.choice(n, 500, replace=False)
            r_sub = ref_arr[sel]
            d_sub = dev_arr[sel]
        else:
            r_sub = ref_arr
            d_sub = dev_arr

        sessions_out.append({
            "label":  s["label"],
            "points": [{"x": float(r), "y": float(d)} for r, d in zip(r_sub, d_sub)],
            "bias":   round(bias_s, 2),
            "mae":    round(mae_s, 2),
        })
        all_ref.extend(ref_arr.tolist())
        all_dev.extend(dev_arr.tolist())

    if not all_ref:
        return {"sessions": [], "global_stats": None}

    all_ref_arr = np.array(all_ref)
    all_dev_arr = np.array(all_dev)
    diffs_all   = all_dev_arr - all_ref_arr
    global_bias = float(diffs_all.mean())
    global_sd   = float(diffs_all.std(ddof=1))
    loa_u       = global_bias + 1.96 * global_sd
    loa_l       = global_bias - 1.96 * global_sd

    try:
        lr        = stats.linregress(all_ref_arr, all_dev_arr)
        slope     = round(float(lr.slope), 4)
        intercept = round(float(lr.intercept), 4)
        pearson_r = round(float(lr.rvalue), 4)
    except Exception:
        slope = 1.0; intercept = 0.0; pearson_r = None

    return {
        "sessions": sessions_out,
        "global_stats": {
            "bias":      round(global_bias, 3),
            "loa_u":     round(loa_u, 3),
            "loa_l":     round(loa_l, 3),
            "pearson_r": pearson_r,
            "slope":     slope,
            "intercept": intercept,
        },
    }

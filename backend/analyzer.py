"""
HR Analyzer — core engine adapted from hr-analyzer.py.
Receives FIT/TCX/GPX file bytes, returns metrics, zones, charts (base64 PNG).
"""

import io
import base64
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
import fitparse
from datetime import datetime

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────
ZONAS_FC = [
    ("Z1 Recuperación", 0,   130),
    ("Z2 Aeróbico",   130,   145),
    ("Z3 Tempo",      145,   151),
    ("Z4 Subumbral",  151,   161),
    ("Z5 Máximo",     161,   999),
]
COLORES_ZONA = ["#3498db", "#2ecc71", "#f1c40f", "#e67e22", "#e74c3c"]


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


def _read_gpx(data: bytes) -> pd.Series:
    """Parse GPX with heart rate in Garmin TrackPointExtension."""
    import xml.etree.ElementTree as ET
    root = ET.fromstring(data)
    GPX_NS  = "http://www.topografix.com/GPX/1/1"
    EXT_NS1 = "http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
    EXT_NS2 = "http://www.garmin.com/xmlschemas/TrackPointExtension/v2"

    records = []
    for trkpt in root.iter(f"{{{GPX_NS}}}trkpt"):
        time_el = trkpt.find(f"{{{GPX_NS}}}time")
        if time_el is None:
            continue
        hr = None
        for ns in (EXT_NS1, EXT_NS2):
            hr_el = trkpt.find(f".//{{{ns}}}hr")
            if hr_el is not None:
                try:
                    hr = float(hr_el.text.strip())
                except (ValueError, AttributeError):
                    pass
                break
        if hr is not None:
            records.append({"time": time_el.text.strip(), "hr": hr})
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

    r, p = stats.pearsonr(fc_ref.values, fc_dev.values)
    lr   = stats.linregress(fc_ref.values, fc_dev.values)

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
        "slope":     round(float(lr.slope), 4),
        "intercept": round(float(lr.intercept), 2),
        "n":         n,
        "media_ref": round(m1, 1),
        "media_dev": round(m2, 1),
    }


def analyze_by_zones(fc_ref: pd.Series, fc_dev: pd.Series, fcmax: int = None):
    """Per-zone validation metrics."""
    fcmax_final = int(fcmax) if fcmax is not None else int(fc_ref.max())
    results = []
    for name, lo, hi in ZONAS_FC:
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

    x_lo   = min(x_vals.min(), y_vals.min()) - 2
    x_hi   = max(x_vals.max(), y_vals.max()) + 2
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
    ax_ba.set_xlim(mean_vals.min() - 2, mean_vals.max() + 2)
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

    return {
        "metrics":          metrics,
        "zones":            zones,
        "lag":              lag,
        "fcmax":            fcmax,
        "duration_seconds": int(len(ref_aligned)),
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
    """
    Difficulty weight from the explicit session_difficulty field:
      'series' → 2.5  (FC volátil, el PPG falla más)
      'tempo'  → 1.5  (FC sostenida alta)
      'z2'     → 1.0  (FC estable)
    """
    weights = {"series": 2.5, "tempo": 1.5, "z2": 1.0}
    return weights.get(session_difficulty.lower(), 1.0)


def _weighted_global_score(sessions_info: list) -> dict | None:
    """
    Compute weighted global metrics from per-session data.

    MAE_global  = Σ(MAE_rel_i × w_i) / Σ(w_i)
                  where MAE_rel_i = (MAE_i / FC_media_ref_i) × 100

    Bias_global = Σ(bias_i × w_i) / Σ(w_i)   ← signed, direct weighted mean

    r_global    = Fisher z-transform → weighted mean → inverse transform
    """
    weights, mae_rels, biases, fisher_zs = [], [], [], []

    for s in sessions_info:
        m = s.get("metrics") or {}
        mae      = m.get("mae")
        fc_media = m.get("media_ref")
        bias     = m.get("bias")
        r        = m.get("r")

        if mae is None or fc_media is None or fc_media == 0:
            continue

        w = _session_weight(s.get("session_difficulty", ""))
        mae_rel = mae / fc_media * 100

        weights.append(w)
        mae_rels.append(mae_rel)
        biases.append(bias if bias is not None else 0.0)

        # Fisher z-transform (clip r to avoid ±∞)
        r_clip = float(np.clip(r if r is not None else 0.0, -0.9999, 0.9999))
        fisher_zs.append(0.5 * np.log((1 + r_clip) / (1 - r_clip)))

    if not weights:
        return None

    W = sum(weights)
    mae_global  = sum(m * w for m, w in zip(mae_rels,  weights)) / W
    bias_global = sum(b * w for b, w in zip(biases,    weights)) / W
    z_mean      = sum(z * w for z, w in zip(fisher_zs, weights)) / W
    r_global    = float((np.exp(2 * z_mean) - 1) / (np.exp(2 * z_mean) + 1))

    return {
        "mae_global":  round(mae_global,  2),
        "bias_global": round(bias_global, 2),
        "r_global":    round(r_global,    4),
        "n_weighted":  len(weights),
        "total_weight": round(W, 1),
    }


def generate_overview_chart(devices_data: list) -> str:
    """
    Lollipop chart comparing every device using weighted global scores:
      - r_global  : Fisher-weighted Pearson R (accounts for session difficulty)
      - MAE_global: weighted MAE relative to mean FC (%)
      - Bias_global: weighted signed bias (bpm)

    Sorted ascending so the best device (highest r_global) appears at the top.
    Falls back to concatenated metrics when per-session data is unavailable.
    """
    def _color_r(r: float) -> str:
        if r >= 0.95: return "#16a34a"
        if r >= 0.90: return "#d97706"
        if r >= 0.80: return "#ea580c"
        return "#dc2626"

    entries = []
    for dev in devices_data:
        # ── Try weighted scoring from per-session data ────────────────────
        score = _weighted_global_score(dev.get("sessions_info", []))

        if score is not None:
            r_val       = score["r_global"]
            mae_val     = score["mae_global"]
            bias_val    = score["bias_global"]
            n_weighted  = score["n_weighted"]
            weighted    = True
        else:
            # Fallback: concatenate all FC data and compute raw metrics
            all_ref, all_dev_fc = [], []
            for fc in dev["fc_data_list"]:
                all_ref.extend(fc.get("reference", []))
                all_dev_fc.extend(fc.get("device",    []))
            if len(all_ref) < 10:
                continue
            m        = calculate_metrics(pd.Series(all_ref, dtype=float),
                                         pd.Series(all_dev_fc, dtype=float))
            r_val    = m["r"]
            mae_val  = m["mae"]
            bias_val = m["bias"]
            n_weighted = m["n"]
            weighted = False

        entries.append({
            "name":      dev["name"],
            "ref_name":  dev["reference_name"],
            "r":         r_val,
            "mae":       mae_val,
            "bias":      bias_val,
            "n":         n_weighted,
            "sessions":  dev["session_count"],
            "weighted":  weighted,
        })

    if not entries:
        raise ValueError("No hay datos suficientes para generar el gráfico global.")

    # Sort ascending — best (highest r) at top
    entries.sort(key=lambda x: x["r"])

    names     = [e["name"]  for e in entries]
    r_vals    = [e["r"]     for e in entries]
    mae_vals  = [e["mae"]   for e in entries]
    bias_vals = [e["bias"]  for e in entries]
    ref_label = entries[-1]["ref_name"]
    n_devs    = len(entries)

    colors = [_color_r(r) for r in r_vals]

    # Dynamic figure height
    fig_h = max(5, n_devs * 0.65 + 2.2)
    fig, ax = plt.subplots(figsize=(9, fig_h), facecolor="#ffffff")
    _style_ax(ax)

    y_pos = np.arange(n_devs)

    # Lollipop stems
    x_min = max(0.5, min(r_vals) - 0.05)
    for y, r, c in zip(y_pos, r_vals, colors):
        ax.hlines(y, x_min, r, colors="#d1d5db", linewidth=1.2, zorder=2)

    # Dots
    ax.scatter(r_vals, y_pos, color=colors, s=90, zorder=4)

    # Labels: r_global + MAE% + bias
    for y, r, mae, bias, c, e in zip(y_pos, r_vals, mae_vals, bias_vals, colors, entries):
        weighted_tag = "★" if e["weighted"] else ""
        bias_sign    = "+" if bias > 0 else ""
        label = (
            f" {r:.4f}{weighted_tag}   "
            f"MAE {mae:.1f}{'%' if e['weighted'] else ' bpm'}   "
            f"bias {bias_sign}{bias:.1f} bpm"
        )
        ax.text(r + 0.002, y, label,
                va="center", ha="left", fontsize=7.5,
                color=c, fontweight="bold")

    # Reference vertical line at 1.0
    ax.axvline(1.0, color="#9ca3af", lw=1.2, ls="--", zorder=1)
    ax.text(1.001, n_devs - 0.5, ref_label,
            color="#6b7280", fontsize=8, va="top", ha="left")

    # Threshold lines: 0.95 (green), 0.90 (amber), 0.80 (orange)
    for thresh, col, lbl in [
        (0.95, "#16a34a", "0.95"),
        (0.90, "#d97706", "0.90"),
        (0.80, "#ea580c", "0.80"),
    ]:
        ax.axvline(thresh, color=col, lw=0.8, ls=":", alpha=0.6, zorder=1)
        ax.text(thresh, -0.8, lbl, color=col, fontsize=7,
                ha="center", va="top")

    ax.set_yticks(y_pos)
    ax.set_yticklabels(names, color="#111827", fontsize=10)
    ax.set_xlabel("r global ponderado por dificultad de sesión  (★ = ponderado)", color="#374151", fontsize=10)
    ax.set_xlim(x_min - 0.01, 1.10)
    ax.set_ylim(-1, n_devs)
    ax.tick_params(axis="x", colors="#6b7280")

    fig.suptitle(
        f"Comparativa global  ·  referencia: {ref_label}",
        color="#111827", fontsize=13, fontweight="bold",
    )
    fig.tight_layout()

    return _fig_to_base64(fig)

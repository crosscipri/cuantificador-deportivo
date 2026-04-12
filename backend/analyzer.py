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
    """Convert a list of {time, hr} dicts to a HR Series indexed by seconds."""
    if not records:
        raise ValueError("No se encontraron datos de FC en el archivo.")
    df = pd.DataFrame(records)
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df = df.sort_values("time")
    df["seconds"] = (df["time"] - df["time"].iloc[0]).dt.total_seconds().astype(int)
    df["hr"] = pd.to_numeric(df["hr"], errors="coerce")
    series = df.dropna(subset=["hr"]).set_index("seconds")["hr"]
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


def read_fc_from_bytes(data: bytes, filename: str = "") -> pd.Series:
    """
    Parse a FIT, TCX or GPX file from raw bytes.
    Format detected by filename extension, then content sniffing.
    Falls back gracefully between formats.
    """
    ext = filename.lower().rsplit(".", 1)[-1] if filename else ""

    # ── Explicit extension ────────────────────────────────────────────────
    if ext == "tcx":
        return _read_tcx(data)
    if ext == "gpx":
        return _read_gpx(data)

    # For .fit (or no extension) try FIT first, fall through on header error
    fit_error: Exception | None = None
    if ext in ("fit", ""):
        try:
            return _read_fit(data)
        except Exception as e:
            fit_error = e

    # ── Content sniffing — maybe it's XML despite the .fit extension ─────
    text_start = data[:400].lower()
    if b"trainingcenterdatabase" in text_start or b"<tcx" in text_start:
        return _read_tcx(data)
    if b"<gpx" in text_start:
        return _read_gpx(data)

    # Re-raise original FIT error if nothing else matched
    if fit_error:
        raise ValueError(f"No se pudo leer el archivo: {fit_error}")

    return _read_fit(data)


# ─────────────────────────────────────────────────────────────────────────────
# 2. ALIGN SERIES
# ─────────────────────────────────────────────────────────────────────────────

def align(fc1: pd.Series, fc2: pd.Series):
    """Return (fc1_aligned, fc2_aligned, x_seg, t_min) over the common time range."""
    t_min = int(max(fc1.index.min(), fc2.index.min()))
    t_max = int(min(fc1.index.max(), fc2.index.max()))
    idx = range(t_min, t_max + 1)
    a1 = fc1.reindex(idx).interpolate()
    a2 = fc2.reindex(idx).interpolate()
    return a1, a2, np.array(idx), t_min


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
    ax.set_facecolor("#1a1d27")
    for s in ax.spines.values():
        s.set_color("#444")
    ax.tick_params(colors="#aaa", labelsize=9)
    ax.grid(True, color="#2a2d3a", linewidth=0.6, linestyle="--")


def _sec_to_mmss(x, _):
    s = int(x)
    if s < 0:
        return ""
    h, r  = divmod(s, 3600)
    m, sc = divmod(r, 60)
    return f"{h}:{m:02d}:{sc:02d}" if h else f"{m}:{sc:02d}"


def _fig_to_base64(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight",
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
    C_REF = "#2980b9"
    C_DEV = "#e74c3c"
    SUAV  = 15
    fmt   = FuncFormatter(_sec_to_mmss)

    fc1_s = fc_ref.rolling(SUAV, center=True, min_periods=1).mean()
    fc2_s = fc_dev.rolling(SUAV, center=True, min_periods=1).mean()

    fig, ax = plt.subplots(figsize=(15, 5), facecolor="#0f1117")
    _style_ax(ax)

    ax.plot(x_seg, fc_ref.values, color=C_REF, alpha=0.15, linewidth=0.4)
    ax.plot(x_seg, fc_dev.values, color=C_DEV, alpha=0.15, linewidth=0.4)
    l_ref, = ax.plot(x_seg, fc1_s.values, color=C_REF, linewidth=2,
                     label=f"{ref_name} (ref.)")
    l_dev, = ax.plot(x_seg, fc2_s.values, color=C_DEV, linewidth=2,
                     label=dev_name)
    ax.fill_between(x_seg, fc1_s.values, fc2_s.values,
                    where=fc2_s.values >= fc1_s.values,
                    alpha=0.13, color=C_DEV, interpolate=True)
    ax.fill_between(x_seg, fc1_s.values, fc2_s.values,
                    where=fc2_s.values < fc1_s.values,
                    alpha=0.13, color=C_REF, interpolate=True)

    for fc_s, c in [(fc1_s, C_REF), (fc2_s, C_DEV)]:
        idx_max = fc_s.idxmax()
        ax.annotate(f"{int(fc_s[idx_max])} ppm",
                    xy=(idx_max, fc_s[idx_max]),
                    xytext=(0, 12), textcoords="offset points",
                    color=c, fontsize=8, ha="center",
                    arrowprops=dict(arrowstyle="-", color=c, lw=0.8))

    ax.set_ylabel("FC (ppm)", color="#ccc", fontsize=11)
    ax.set_xlabel("Tiempo", color="#ccc", fontsize=11)
    ax.yaxis.set_minor_locator(MultipleLocator(5))
    ax.xaxis.set_major_formatter(fmt)
    ax.legend(handles=[l_ref, l_dev], loc="upper center", ncol=2, fontsize=10,
              facecolor="#1a1d27", edgecolor="#555", labelcolor="#ddd")

    fig.suptitle(
        f"FC (ppm) — {dev_name}  vs  {ref_name}  (referencia)",
        color="white", fontsize=13, fontweight="bold", y=1.01,
    )
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

    fig = plt.figure(figsize=(17, 6), facecolor="#0f1117")
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

    ax_corr.plot(x_line, x_line, color="#e74c3c", lw=1.8, ls="--",
                 label="y = x  (acuerdo perfecto)")
    ax_corr.plot(x_line, metrics["slope"] * x_line + metrics["intercept"],
                 color="#f1c40f", lw=2,
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
                         color="#f1c40f", alpha=0.12, label="IC 95%")

    p_str = f"{metrics['p']:.2e}" if metrics["p"] >= 1e-16 else "< 2.2e-16"
    ax_corr.text(0.05, 0.96,
                 f"R = {metrics['r']}   R² = {round(metrics['r']**2, 3)}\n"
                 f"CCC = {metrics['ccc']}   ICC = {metrics['icc']}\n"
                 f"p {p_str}",
                 transform=ax_corr.transAxes, fontsize=8.5, color="white", va="top",
                 bbox=dict(boxstyle="round,pad=0.4", facecolor="#2a2d3a", edgecolor="#555"))
    ax_corr.set_xlim(x_lo, x_hi)
    ax_corr.set_ylim(x_lo, x_hi)
    ax_corr.set_xlabel(f"{ref_name}  (ppm)", color="#ccc", fontsize=10)
    ax_corr.set_ylabel(f"{dev_name}  (ppm)", color="#ccc", fontsize=10)
    ax_corr.set_title("Correlación", color="#ddd", fontsize=11, pad=8)
    ax_corr.set_aspect("equal")
    ax_corr.legend(loc="lower right", fontsize=7.5,
                   facecolor="#1a1d27", edgecolor="#555", labelcolor="#ddd")

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

    ax_ba.axhline(metrics["bias"], color="#f1c40f", lw=1.8,
                  label=f"Bias = {metrics['bias']} ppm")
    ax_ba.axhline(metrics["loa_u"], color="#e74c3c", lw=1.2, ls="--",
                  label=f"+LoA = {metrics['loa_u']} ppm")
    ax_ba.axhline(metrics["loa_l"], color="#2980b9", lw=1.2, ls="--",
                  label=f"−LoA = {metrics['loa_l']} ppm")
    ax_ba.fill_between([mean_vals.min() - 2, mean_vals.max() + 2],
                       metrics["loa_l"], metrics["loa_u"],
                       alpha=0.06, color="#f1c40f")
    ax_ba.set_xlim(mean_vals.min() - 2, mean_vals.max() + 2)
    ax_ba.set_xlabel("Media de los dos dispositivos (ppm)", color="#ccc", fontsize=9)
    ax_ba.set_ylabel("Diferencia: dispositivo − referencia (ppm)", color="#ccc", fontsize=9)
    ax_ba.set_title("Bland-Altman", color="#ddd", fontsize=11, pad=8)
    ax_ba.legend(loc="upper right", fontsize=7,
                 facecolor="#1a1d27", edgecolor="#555", labelcolor="#ddd")

    # ── MAE & MAPE by zone ──
    names_z   = [z["zone"].split("(")[0].strip() for z in zones]
    mae_vals  = [z["mae"]  if z["mae"]  is not None else 0.0 for z in zones]
    mape_vals = [z["mape"] if z["mape"] is not None else 0.0 for z in zones]
    has_data  = [z["mae"]  is not None for z in zones]
    x_pos     = np.arange(len(zones))
    w         = 0.38

    ax2 = ax_zona.twinx()
    ax2.set_facecolor("#1a1d27")
    ax2.tick_params(colors="#aaa", labelsize=9)

    for xp, mv, mpv, col, ok in zip(x_pos, mae_vals, mape_vals,
                                     COLORES_ZONA[:len(zones)], has_data):
        alpha = 0.85 if ok else 0.2
        ax_zona.bar(xp - w / 2, mv,  width=w, color=col, alpha=alpha)
        ax2.bar(    xp + w / 2, mpv, width=w, color=col, alpha=alpha * 0.55)
        if not ok:
            ax_zona.text(xp, 0.3, "sin\ndatos", ha="center", va="bottom",
                         fontsize=6.5, color="#666")

    ax2.axhline(10, color="#e74c3c", lw=1, ls="--", alpha=0.7)
    ax2.text(len(zones) - 0.45, 10.3, "umbral 10%", color="#e74c3c", fontsize=7)

    ax_zona.set_xticks(x_pos)
    ax_zona.set_xticklabels(names_z, rotation=30, ha="right", color="#aaa", fontsize=8)
    ax_zona.set_ylabel("MAE (ppm)", color="#ccc", fontsize=10)
    ax2.set_ylabel("MAPE (%)", color="#ccc", fontsize=10)
    ax_zona.set_title(f"Error por zona  (FCmax = {fcmax} ppm)",
                      color="#ddd", fontsize=11, pad=8)

    leg_handles = [Patch(color="#aaa", alpha=0.85, label="MAE (ppm)"),
                   Patch(color="#aaa", alpha=0.45, label="MAPE (%)")]
    ax_zona.legend(handles=leg_handles, loc="upper left", fontsize=8,
                   facecolor="#1a1d27", edgecolor="#555", labelcolor="#ddd")

    title = f"Validación científica — {dev_name}  vs  {ref_name}"
    if title_suffix:
        title += f"  [{title_suffix}]"
    fig.suptitle(title, color="white", fontsize=13, fontweight="bold", y=1.01)

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

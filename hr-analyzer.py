"""
Garmin Heart Rate Validator
============================
Valida la precisión de FC de un reloj óptico comparado con una banda de referencia (Polar H10).
Implementa la metodología científica estándar de validación de dispositivos cardíacos:
  · Bland-Altman (bias + LoA)  · MAE / MAPE / RMSE
  · CCC (Lin) y ICC (2,1)      · Análisis por zonas de intensidad
  · Estimación de lag temporal  · Análisis GPT-4o con contexto científico

Instalación:
    pip install fitparse pandas matplotlib numpy scipy openai

Uso:
    python "Garmin hr analyzer.py" reloj.fit referencia.fit
    python "Garmin hr analyzer.py" reloj.fit referencia.fit --gpt
"""

import sys
import argparse
from pathlib import Path

try:
    import fitparse
except ImportError:
    print("Falta 'fitparse'. Instálala con: pip install fitparse")
    sys.exit(1)

try:
    import pandas as pd
    import numpy as np
    import matplotlib.pyplot as plt
    import matplotlib.gridspec as gridspec
    from matplotlib.ticker import MultipleLocator, FuncFormatter
    from scipy import stats
    from scipy.signal import correlate
except ImportError as e:
    print(f"Falta una librería: {e}. Instálala con: pip install pandas matplotlib numpy scipy")
    sys.exit(1)

# ─────────────────────────────────────────────────────────
# CONSTANTES
# ─────────────────────────────────────────────────────────
# Zonas en bpm absolutos (no en % de FCmax)
ZONAS_FC = [
    ("Z1 Recuperación", 0,   130),
    ("Z2 Aeróbico",   130,   145),
    ("Z3 Tempo",      145,   151),
    ("Z4 Subumbral",  151,   161),
    ("Z5 Máximo",     161,   999),
]
COLORES_ZONA = ["#3498db", "#2ecc71", "#f1c40f", "#e67e22", "#e74c3c"]


# ─────────────────────────────────────────────────────────
# 1. LECTURA
# ─────────────────────────────────────────────────────────

def leer_fc(ruta_fit: str) -> pd.Series:
    """Lee un .FIT y devuelve una Serie de FC indexada en segundos desde el inicio."""
    ruta = Path(ruta_fit)
    if not ruta.exists():
        print(f"No se encontró: {ruta_fit}")
        sys.exit(1)

    print(f"Leyendo: {ruta.name} ...")
    fitfile = fitparse.FitFile(str(ruta))
    registros = []
    for msg in fitfile.get_messages("record"):
        d = {f.name: f.value for f in msg}
        if "heart_rate" in d and "timestamp" in d:
            registros.append({"tiempo": d["timestamp"], "fc": d["heart_rate"]})

    if not registros:
        print(f"Sin datos de FC en: {ruta.name}")
        sys.exit(1)

    df = pd.DataFrame(registros)
    df["tiempo"] = pd.to_datetime(df["tiempo"])
    df["segundos"] = (df["tiempo"] - df["tiempo"].iloc[0]).dt.total_seconds().astype(int)
    df["fc"] = pd.to_numeric(df["fc"], errors="coerce")
    serie = df.dropna(subset=["fc"]).set_index("segundos")["fc"]
    print(f"  {len(serie)} muestras cargadas.")
    return serie


# ─────────────────────────────────────────────────────────
# 2. ALINEAR SERIES AL TRAMO COMÚN
# ─────────────────────────────────────────────────────────

def alinear(fc1: pd.Series, fc2: pd.Series):
    """Devuelve (fc1_aligned, fc2_aligned, x_seg) sobre el tramo temporal común."""
    t_min = int(max(fc1.index.min(), fc2.index.min()))
    t_max = int(min(fc1.index.max(), fc2.index.max()))
    idx = range(t_min, t_max + 1)
    a1 = fc1.reindex(idx).interpolate()
    a2 = fc2.reindex(idx).interpolate()
    return a1, a2, np.array(idx), t_min


# ─────────────────────────────────────────────────────────
# 3. MÉTRICAS DE VALIDACIÓN CIENTÍFICA
# ─────────────────────────────────────────────────────────

def calcular_metricas(fc_ref: pd.Series, fc_dev: pd.Series) -> dict:
    """
    Calcula el conjunto completo de métricas de validación:
    MAE, MAPE, RMSE, bias, LoA (Bland-Altman), CCC (Lin), ICC (2,1).
    fc_ref = referencia (ej. Polar H10), fc_dev = dispositivo a validar.
    """
    diff  = fc_dev - fc_ref          # signo: dispositivo - referencia

    mae   = float(diff.abs().mean())
    mape  = float((diff.abs() / fc_ref.clip(lower=1) * 100).mean())
    rmse  = float(np.sqrt((diff ** 2).mean()))
    bias  = float(diff.mean())
    loa_u = bias + 1.96 * float(diff.std())
    loa_l = bias - 1.96 * float(diff.std())

    # CCC de Lin
    n      = len(fc_ref)
    m1, m2 = float(fc_ref.mean()), float(fc_dev.mean())
    v1, v2 = float(fc_ref.var()), float(fc_dev.var())
    cov    = float(((fc_ref - m1) * (fc_dev - m2)).mean())
    ccc    = (2 * cov) / (v1 + v2 + (m1 - m2) ** 2) if (v1 + v2) > 0 else 0.0

    # ICC (2,1) — two-way random, absolute agreement, 2 raters
    data        = np.column_stack([fc_ref.values, fc_dev.values])
    grand_mean  = data.mean()
    subj_means  = data.mean(axis=1)
    rater_means = data.mean(axis=0)
    ss_b = 2 * np.sum((subj_means  - grand_mean) ** 2)   # between subjects
    ss_j =  n * np.sum((rater_means - grand_mean) ** 2)   # between raters
    ss_t = np.sum((data - grand_mean) ** 2)
    ss_e = ss_t - ss_b - ss_j                              # error / residual
    ms_b = ss_b / (n - 1)
    ms_j = ss_j / 1          # k-1 = 1
    ms_e = ss_e / (n - 1)    # (k-1)(n-1) = n-1
    denom = ms_b + ms_e + 2 * (ms_j - ms_e) / n
    icc   = (ms_b - ms_e) / denom if denom > 0 else 0.0

    # Pearson R
    r, p = stats.pearsonr(fc_ref.values, fc_dev.values)

    return {
        "mae":    round(mae,  2),
        "mape":   round(mape, 2),
        "rmse":   round(rmse, 2),
        "bias":   round(bias, 2),
        "loa_u":  round(loa_u, 2),
        "loa_l":  round(loa_l, 2),
        "ccc":    round(ccc,  4),
        "icc":    round(float(icc), 4),
        "r":      round(r,    4),
        "p":      p,
        "slope":  round(float(stats.linregress(fc_ref.values, fc_dev.values).slope), 4),
        "intercept": round(float(stats.linregress(fc_ref.values, fc_dev.values).intercept), 2),
        "n":      n,
        "media_ref": round(m1, 1),
        "media_dev": round(m2, 1),
    }


def analizar_por_zonas(fc_ref: pd.Series, fc_dev: pd.Series,
                       fcmax: int = None) -> tuple[list, int, str]:
    """
    Métricas de validación por zona de intensidad en bpm absolutos.
    Zonas: Z1 <130, Z2 130-145, Z3 145-151, Z4 151-161, Z5 >161 ppm.
    """
    fcmax_final = int(fcmax) if fcmax is not None else int(fc_ref.max())
    fcmax_origen = "usuario" if fcmax is not None else "archivo de referencia"
    resultados = []
    for nombre, lo, hi in ZONAS_FC:
        mask = (fc_ref >= lo) & (fc_ref < hi)
        n = int(mask.sum())
        lo_str = f"<{hi}" if lo == 0 else f"{lo}-{hi}" if hi < 999 else f">{lo}"
        entry = {
            "zona": nombre, "rango": f"{lo_str} ppm",
            "n": n, "pct_tiempo": round(n / len(fc_ref) * 100, 1),
            "mae": None, "mape": None, "bias": None,
        }
        if n >= 5:
            m = calcular_metricas(fc_ref[mask], fc_dev[mask])
            entry.update({"mae": m["mae"], "mape": m["mape"], "bias": m["bias"]})
        resultados.append(entry)
    return resultados, fcmax_final, fcmax_origen


def estimar_lag(fc_ref: pd.Series, fc_dev: pd.Series, max_lag: int = 30) -> int:
    """Estima el retardo temporal (segundos) del dispositivo respecto a la referencia
    usando correlación cruzada. Positivo = dispositivo va retrasado."""
    x = fc_ref.values - fc_ref.mean()
    y = fc_dev.values - fc_dev.mean()
    corr = correlate(x, y, mode="full")
    lags  = np.arange(-(len(x) - 1), len(y))
    center = len(x) - 1
    valid  = slice(center - max_lag, center + max_lag + 1)
    return int(lags[valid][np.argmax(corr[valid])])


# ─────────────────────────────────────────────────────────
# 4. IMPRIMIR RESUMEN
# ─────────────────────────────────────────────────────────

def imprimir_resumen(nombre_ref: str, nombre_dev: str, m: dict,
                     zonas: list, lag: int, fcmax: int, fcmax_origen: str):
    ancho = 68
    print("\n" + "═" * ancho)
    print(f"  VALIDACIÓN: {nombre_dev[:22]}  vs  {nombre_ref[:22]}")
    print(f"  Referencia = {nombre_ref[:30]}")
    print("─" * ancho)

    def fila(etiqueta, valor, umbral=None):
        mark = ""
        if umbral is not None:
            mark = "  ✓" if umbral else "  ✗"
        print(f"  {etiqueta:<32} {str(valor):>10}{mark}")

    fila("MAE (bpm)",             f"{m['mae']} ppm",   m['mae'] <= 5)
    fila("MAPE (%)",              f"{m['mape']} %",    m['mape'] <= 10)
    fila("RMSE (bpm)",            f"{m['rmse']} ppm")
    fila("Bias B-A (bpm)",        f"{m['bias']} ppm")
    fila("LoA superior (bpm)",    f"{m['loa_u']} ppm")
    fila("LoA inferior (bpm)",    f"{m['loa_l']} ppm")
    fila("CCC de Lin",            m['ccc'],            m['ccc'] >= 0.9)
    fila("ICC (2,1)",             m['icc'],            m['icc'] >= 0.7)
    fila("Pearson R",             m['r'],              m['r']   >= 0.9)
    fila("Pendiente regresión",   m['slope'],          0.95 <= m['slope'] <= 1.05)
    fila("Intercepto regresión",  m['intercept'])
    fila("Lag estimado (s)",      f"{lag:+d} s",       abs(lag) <= 5)
    fila("FCmax para contexto",   f"{fcmax} ppm ({fcmax_origen})")
    print("─" * ancho)
    print(f"  ZONAS DE INTENSIDAD  (bpm absolutos)")
    print(f"  {'Zona':<20} {'Rango':>12} {'%t':>4} {'n':>5} {'MAE':>6} {'MAPE':>6} {'bias':>6}")
    print("  " + "─" * (ancho - 2))
    for z in zonas:
        if z["mae"] is None:
            print(f"  {z['zona']:<20} {z['rango']:>12} {z['pct_tiempo']:>3}% {z['n']:>5}   sin datos")
        else:
            ok = "✓" if z['mape'] <= 10 else "✗"
            print(f"  {z['zona']:<20} {z['rango']:>12} {z['pct_tiempo']:>3}% {z['n']:>5} "
                  f"{z['mae']:>6.1f} {z['mape']:>5.1f}% {z['bias']:>+6.1f}  {ok}")
    print("═" * ancho + "\n")


# ─────────────────────────────────────────────────────────
# 5. GRÁFICAS
# ─────────────────────────────────────────────────────────

def _estilo_ax(ax):
    ax.set_facecolor("#1a1d27")
    for s in ax.spines.values():
        s.set_color("#444")
    ax.tick_params(colors="#aaa", labelsize=9)
    ax.grid(True, color="#2a2d3a", linewidth=0.6, linestyle="--")


def seg_a_mmss(x, _):
    s = int(x)
    if s < 0:
        return ""
    h, r = divmod(s, 3600)
    m, sc = divmod(r, 60)
    return f"{h}:{m:02d}:{sc:02d}" if h else f"{m}:{sc:02d}"


def graficar_series(fc_ref: pd.Series, nombre_ref: str,
                    fc_dev: pd.Series, nombre_dev: str,
                    ruta_out: Path, anotaciones: list = None):
    """Gráfica temporal: FC (ppm) superpuesta."""
    C_REF = "#2980b9"
    C_DEV = "#e74c3c"
    SUAV  = 15

    fc1a, fc2a, x_seg, t_min = alinear(fc_ref, fc_dev)
    fc1_s = fc1a.rolling(SUAV, center=True, min_periods=1).mean()
    fc2_s = fc2a.rolling(SUAV, center=True, min_periods=1).mean()
    fmt   = FuncFormatter(seg_a_mmss)

    fig, ax_fc = plt.subplots(figsize=(15, 5), facecolor="#0f1117")
    _estilo_ax(ax_fc)

    # FC superpuesta
    ax_fc.plot(x_seg, fc1a, color=C_REF, alpha=0.15, linewidth=0.4)
    ax_fc.plot(x_seg, fc2a, color=C_DEV, alpha=0.15, linewidth=0.4)
    l_ref, = ax_fc.plot(x_seg, fc1_s, color=C_REF, linewidth=2, label=f"{nombre_ref} (ref.)")
    l_dev, = ax_fc.plot(x_seg, fc2_s, color=C_DEV, linewidth=2, label=nombre_dev)
    ax_fc.fill_between(x_seg, fc1_s, fc2_s, where=fc2_s >= fc1_s,
                       alpha=0.13, color=C_DEV, interpolate=True)
    ax_fc.fill_between(x_seg, fc1_s, fc2_s, where=fc2_s < fc1_s,
                       alpha=0.13, color=C_REF, interpolate=True)
    for fc_s, c in [(fc1_s, C_REF), (fc2_s, C_DEV)]:
        idx_max = fc_s.idxmax()
        ax_fc.annotate(f"{int(fc_s[idx_max])} ppm",
                       xy=(idx_max, fc_s[idx_max]),
                       xytext=(0, 12), textcoords="offset points",
                       color=c, fontsize=8, ha="center",
                       arrowprops=dict(arrowstyle="-", color=c, lw=0.8))
    ax_fc.set_ylabel("FC (ppm)", color="#ccc", fontsize=11)
    ax_fc.set_xlabel("Tiempo", color="#ccc", fontsize=11)
    ax_fc.yaxis.set_minor_locator(MultipleLocator(5))
    ax_fc.xaxis.set_major_formatter(fmt)
    ax_fc.legend(handles=[l_ref, l_dev], loc="upper center", ncol=2, fontsize=10,
                 facecolor="#1a1d27", edgecolor="#555", labelcolor="#ddd")

    # Anotaciones GPT
    if anotaciones:
        tipo_color = {"pico": "#f1c40f", "divergencia": "#e74c3c",
                      "convergencia": "#2ecc71", "anomalia": "#e67e22", "info": "#9b59b6"}
        for ann in anotaciones:
            if ann.get("panel", "fc") != "fc":
                continue
            seg_x = int(ann.get("segundo", 0)) + t_min
            color = tipo_color.get(ann.get("tipo", "info"), "#f1c40f")
            ax_fc.axvline(seg_x, color=color, linewidth=1.2, linestyle=":", alpha=0.85)
            ylim = ax_fc.get_ylim()
            ax_fc.text(seg_x, ylim[1], f" {ann.get('descripcion', '')}",
                       color=color, fontsize=7.5, va="top", ha="left", rotation=90,
                       bbox=dict(boxstyle="round,pad=0.2", facecolor="#0f1117",
                                 edgecolor="none", alpha=0.7))

    fig.suptitle(f"FC (ppm) — {nombre_dev}  vs  {nombre_ref}  (referencia)",
                 color="white", fontsize=13, fontweight="bold", y=1.01)
    plt.savefig(ruta_out, dpi=150, bbox_inches="tight", facecolor="#0f1117")
    print(f"Gráfica temporal guardada: {ruta_out}")
    plt.show(block=False)


def graficar_validacion(fc_ref: pd.Series, nombre_ref: str,
                        fc_dev: pd.Series, nombre_dev: str,
                        m: dict, zonas: list, fcmax: int, ruta_out: Path):
    """
    3 paneles en una figura:
      · Correlación con regresión e IC 95%
      · Bland-Altman (bias + LoA) coloreado por zona
      · MAE y MAPE por zona de intensidad
    """
    fc1a, fc2a, _, _ = alinear(fc_ref, fc_dev)
    
    x_vals = fc1a.values   # referencia en eje X
    y_vals = fc2a.values   # dispositivo en eje Y
    diff_vals = y_vals - x_vals
    mean_vals = (x_vals + y_vals) / 2.0

    x_lo = min(x_vals.min(), y_vals.min()) - 2
    x_hi = max(x_vals.max(), y_vals.max()) + 2
    x_line = np.linspace(x_lo, x_hi, 300)

    fig = plt.figure(figsize=(17, 6), facecolor="#0f1117")
    gs  = gridspec.GridSpec(1, 3, fig, wspace=0.32)
    ax_corr = fig.add_subplot(gs[0])
    ax_ba   = fig.add_subplot(gs[1])
    ax_zona = fig.add_subplot(gs[2])
    for ax in [ax_corr, ax_ba, ax_zona]:
        _estilo_ax(ax)

    # ── Correlación ──
    zona_idx = np.zeros(len(x_vals), dtype=int)
    for zi, (_, zona_lo, zona_hi) in enumerate(ZONAS_FC):
        mask = (x_vals >= zona_lo) & (x_vals < zona_hi)
        zona_idx[mask] = zi

    n_muestra = min(len(x_vals), 4000)
    idx_s = np.random.choice(len(x_vals), n_muestra, replace=False)
    for zi, (_, _, _) in enumerate(ZONAS_FC):
        sel = idx_s[zona_idx[idx_s] == zi]
        if len(sel):
            ax_corr.scatter(x_vals[sel], y_vals[sel],
                            color=COLORES_ZONA[zi], alpha=0.4, s=10, linewidths=0)

    ax_corr.plot(x_line, x_line, color="#e74c3c", lw=1.8, ls="--",
                 label="y = x  (acuerdo perfecto)")
    ax_corr.plot(x_line, m["slope"] * x_line + m["intercept"],
                 color="#f1c40f", lw=2,
                 label=f"Regresión  y = {m['slope']}x + {m['intercept']}")

    n = m["n"]
    x_mean = x_vals.mean()
    residuals = y_vals - (m["slope"] * x_vals + m["intercept"])
    se_line = np.sqrt(
        np.sum(residuals**2) / (n - 2) *
        (1/n + (x_line - x_mean)**2 / np.sum((x_vals - x_mean)**2))
    )
    t95 = stats.t.ppf(0.975, df=n - 2)
    y_fit = m["slope"] * x_line + m["intercept"]
    ax_corr.fill_between(x_line, y_fit - t95 * se_line, y_fit + t95 * se_line,
                         color="#f1c40f", alpha=0.12, label="IC 95 %")

    p_str = f"{m['p']:.2e}" if m['p'] >= 1e-16 else "< 2.2e-16"
    ax_corr.text(0.05, 0.96,
                 f"R = {m['r']}   R² = {round(m['r']**2,3)}\n"
                 f"CCC = {m['ccc']}   ICC = {m['icc']}\n"
                 f"p {p_str}",
                 transform=ax_corr.transAxes, fontsize=8.5, color="white", va="top",
                 bbox=dict(boxstyle="round,pad=0.4", facecolor="#2a2d3a", edgecolor="#555"))
    ax_corr.set_xlim(x_lo, x_hi); ax_corr.set_ylim(x_lo, x_hi)
    ax_corr.set_xlabel(f"{nombre_ref}  (ppm)", color="#ccc", fontsize=10)
    ax_corr.set_ylabel(f"{nombre_dev}  (ppm)", color="#ccc", fontsize=10)
    ax_corr.set_title("Correlación", color="#ddd", fontsize=11, pad=8)
    ax_corr.set_aspect("equal")
    ax_corr.legend(loc="lower right", fontsize=7.5,
                   facecolor="#1a1d27", edgecolor="#555", labelcolor="#ddd")

    # ── Bland-Altman ──
    for zi, (_, plo, phi) in enumerate(ZONAS_FC):
        mask = (x_vals >= plo) & (x_vals < phi)
        sel  = np.where(mask)[0]
        if len(sel) > 0:
            n_plot = min(len(sel), 1000)
            idx_p  = np.random.choice(sel, n_plot, replace=False)
            ax_ba.scatter(mean_vals[idx_p], diff_vals[idx_p],
                          color=COLORES_ZONA[zi], alpha=0.3, s=8, linewidths=0,
                          label=ZONAS_FC[zi][0].split("(")[0].strip())

    ax_ba.axhline(m["bias"], color="#f1c40f", lw=1.8, label=f"Bias = {m['bias']} ppm")
    ax_ba.axhline(m["loa_u"], color="#e74c3c", lw=1.2, ls="--",
                  label=f"+LoA = {m['loa_u']} ppm")
    ax_ba.axhline(m["loa_l"], color="#2980b9", lw=1.2, ls="--",
                  label=f"−LoA = {m['loa_l']} ppm")
    ax_ba.fill_between([mean_vals.min()-2, mean_vals.max()+2],
                       m["loa_l"], m["loa_u"], alpha=0.06, color="#f1c40f")
    ax_ba.set_xlim(mean_vals.min() - 2, mean_vals.max() + 2)
    ax_ba.set_xlabel("Media de los dos dispositivos (ppm)", color="#ccc", fontsize=9)
    ax_ba.set_ylabel("Diferencia: dispositivo − referencia (ppm)", color="#ccc", fontsize=9)
    ax_ba.set_title("Bland-Altman", color="#ddd", fontsize=11, pad=8)
    ax_ba.legend(loc="upper right", fontsize=7,
                 facecolor="#1a1d27", edgecolor="#555", labelcolor="#ddd")

    # ── MAE y MAPE por zona (todas las zonas, con 0 si sin datos) ──
    nombres_z = [z["zona"].split("(")[0].strip() for z in zonas]
    mae_vals  = [z["mae"]  if z["mae"]  is not None else 0.0 for z in zonas]
    mape_vals = [z["mape"] if z["mape"] is not None else 0.0 for z in zonas]
    tiene_datos = [z["mae"] is not None for z in zonas]
    x_pos = np.arange(len(zonas))
    w     = 0.38

    ax2 = ax_zona.twinx()
    ax2.set_facecolor("#1a1d27")
    ax2.tick_params(colors="#aaa", labelsize=9)

    for _, (xp, mv, mpv, col, ok) in enumerate(
            zip(x_pos, mae_vals, mape_vals, COLORES_ZONA[:len(zonas)], tiene_datos)):
        alpha = 0.85 if ok else 0.2
        ax_zona.bar(xp - w/2, mv,  width=w, color=col, alpha=alpha)
        ax2.bar(    xp + w/2, mpv, width=w, color=col, alpha=alpha * 0.55)
        if not ok:
            ax_zona.text(xp, 0.3, "sin\ndatos", ha="center", va="bottom",
                         fontsize=6.5, color="#666")

    # Línea de umbral MAPE
    ax2.axhline(10, color="#e74c3c", lw=1, ls="--", alpha=0.7)
    ax2.text(len(zonas) - 0.45, 10.3, "umbral 10%", color="#e74c3c", fontsize=7)

    ax_zona.set_xticks(x_pos)
    ax_zona.set_xticklabels(nombres_z, rotation=30, ha="right", color="#aaa", fontsize=8)
    ax_zona.set_ylabel("MAE (ppm)", color="#ccc", fontsize=10)
    ax2.set_ylabel("MAPE (%)", color="#ccc", fontsize=10)
    ax_zona.set_title(f"Error por zona  (FCmax = {fcmax} ppm)",
                      color="#ddd", fontsize=11, pad=8)

    from matplotlib.patches import Patch
    leg_handles = [Patch(color="#aaa", alpha=0.85, label="MAE (ppm)"),
                   Patch(color="#aaa", alpha=0.45, label="MAPE (%)")]
    ax_zona.legend(handles=leg_handles, loc="upper left", fontsize=8,
                   facecolor="#1a1d27", edgecolor="#555", labelcolor="#ddd")

    fig.suptitle(f"Validación científica — {nombre_dev}  vs  {nombre_ref}",
                 color="white", fontsize=13, fontweight="bold", y=1.01)
    plt.savefig(ruta_out, dpi=150, bbox_inches="tight", facecolor="#0f1117")
    print(f"Gráfica de validación guardada: {ruta_out}")
    plt.show(block=True)


# ─────────────────────────────────────────────────────────
# 6. ANÁLISIS CON GPT-4o
# ─────────────────────────────────────────────────────────

def analizar_con_gpt(nombre_ref: str, nombre_dev: str,
                     m: dict, zonas: list, lag: int,
                     fc_ref: pd.Series, fc_dev: pd.Series) -> list:
    """
    1. Pide anotaciones en JSON estructurado para la gráfica temporal.
    2. Streaming del análisis científico con contexto de la literatura.
    """
    import os, json
    try:
        from openai import OpenAI
    except ImportError:
        print("Falta 'openai'. Instálala con: pip install openai")
        return []

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("\nNo se encontró OPENAI_API_KEY.")
        print("  export OPENAI_API_KEY='sk-...'")
        return []

    # Muestra de datos alineados para el prompt
    fc1a, fc2a, _, _ = alinear(fc_ref, fc_dev)
    step   = max(1, len(fc1a) // 180)
    n_rows = len(range(0, len(fc1a), step))
    muestra = pd.DataFrame({
        "s":        range(0, n_rows * step, step),
        nombre_ref[:8]: fc1a.values[::step][:n_rows].round(0).astype(int),
        nombre_dev[:8]: fc2a.values[::step][:n_rows].round(0).astype(int),
        "diff":     (fc2a.values[::step][:n_rows] - fc1a.values[::step][:n_rows]).round(1),
    }).to_string(index=False)

    def fmt_val(valor, spec: str) -> str:
        return format(valor, spec) if valor is not None else "NA"

    zonas_txt = "\n".join(
        f"  {z['zona']}: "
        f"MAE={fmt_val(z['mae'], '.1f')} ppm, "
        f"MAPE={fmt_val(z['mape'], '.1f')}%, "
        f"bias={fmt_val(z['bias'], '+.1f')} ppm, "
        f"n={z['n']}"
        for z in zonas
    )

    p_str = f"{m['p']:.2e}" if m['p'] >= 1e-16 else "< 2.2e-16"

    contexto = f"""
DISPOSITIVO A VALIDAR: {nombre_dev}
REFERENCIA (gold-standard): {nombre_ref}

MÉTRICAS GLOBALES:
  MAE   = {m['mae']} ppm   (umbral aceptable ≤5 ppm)
  MAPE  = {m['mape']} %    (umbral aceptable ≤10%)
  RMSE  = {m['rmse']} ppm
  Bias  = {m['bias']} ppm  (Bland-Altman; positivo = dispositivo sobreestima)
  LoA   = [{m['loa_l']}, {m['loa_u']}] ppm  (intervalo de concordancia ±1.96 DE)
  CCC (Lin) = {m['ccc']}   (válido si ≥0.90)
  ICC (2,1) = {m['icc']}   (fiable  si ≥0.70)
  Pearson R = {m['r']},  R² = {round(m['r']**2, 3)},  p = {p_str}
  Pendiente regresión = {m['slope']}  (ideal = 1.0)
  Intercepto         = {m['intercept']}  (ideal = 0.0)
  Lag estimado       = {lag:+d} s  (retraso del dispositivo; positivo = retrasado)

MÉTRICAS POR ZONA DE INTENSIDAD (referencia basada en FCmax={int(fc_ref.max())} ppm):
{zonas_txt}

SERIE TEMPORAL (muestra cada ~{step} s):
{muestra}"""

    client = OpenAI(api_key=api_key)

    def llamar(messages, json_mode=False, stream=False, tokens=900):
        kw = dict(model="gpt-4o", messages=messages, max_tokens=tokens, stream=stream)
        if json_mode:
            kw["response_format"] = {"type": "json_object"}
        return client.chat.completions.create(**kw)

    # ── Paso 1: anotaciones JSON ──
    anotaciones = []
    print("\nIdentificando puntos clave para la gráfica...", flush=True)
    prompt_ann = f"""Eres un experto en validación de dispositivos de frecuencia cardíaca deportivos.

Dado el siguiente análisis de un sensor óptico de muñeca validado contra una banda Polar H10,
identifica entre 5 y 8 momentos fisiológicamente relevantes en la serie temporal.

{contexto}

Devuelve SOLO un JSON con esta estructura:
{{
  "anotaciones": [
    {{
      "segundo": <int, segundos desde inicio>,
      "panel": <"fc" | "diff" | "err">,
      "tipo": <"pico" | "divergencia" | "convergencia" | "anomalia" | "info">,
      "descripcion": <max 28 caracteres>
    }}
  ]
}}

Prioriza: momentos de mayor divergencia, lag visible, recuperaciones, picos de FC."""

    try:
        resp = llamar([{"role": "user", "content": prompt_ann}], json_mode=True)
        data = json.loads(resp.choices[0].message.content)
        anotaciones = data.get("anotaciones", [])
        print(f"  {len(anotaciones)} anotaciones identificadas.")
    except Exception as e:
        print(f"  Sin anotaciones: {e}")

    # ── Paso 2: análisis científico en streaming ──
    prompt_analisis = f"""Eres un científico del deporte especializado en validación de sensores de FC portátiles.
Tu análisis debe seguir la metodología científica publicada (Bland-Altman, CCC, ICC, MAPE por zonas).

{contexto}

Elabora un informe estructurado en español con estas secciones:

1. **Validez general** — evalúa CCC, ICC, R y si el dispositivo supera los umbrales de aceptación.
   Contrasta con la literatura: ¿son resultados comparables a otras validaciones de relojes ópticos?

2. **Sesgo y acuerdo clínico (Bland-Altman)** — interpreta el bias y los LoA.
   ¿Es clínicamente relevante la diferencia? ¿En qué situaciones podría afectar al deportista?

3. **Error por zona de intensidad** — ¿en qué zonas falla más el sensor óptico y por qué?
   (Los sensores ópticos de muñeca tienden a perder precisión en alta intensidad y en cambios bruscos.)

4. **Lag temporal** — ¿el retraso de {lag:+d}s es relevante para el entrenamiento?
   (Un lag >5s es problemático en intervalos de alta intensidad.)

5. **Recomendación práctica** — ¿en qué tipo de sesiones es fiable este dispositivo?
   ¿Cuándo debería el deportista usar la banda de referencia?

Sé preciso y cita los umbrales cuantitativos relevantes."""

    print("\n" + "═" * 62)
    print("  ANÁLISIS CIENTÍFICO GPT-4o")
    print("═" * 62 + "\n")
    try:
        stream = llamar([{"role": "user", "content": prompt_analisis}], stream=True, tokens=1000)
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                print(chunk.choices[0].delta.content, end="", flush=True)
        print("\n\n" + "═" * 62)
    except Exception as e:
        err = str(e)
        if "insufficient_quota" in err or "429" in err:
            print("Sin créditos OpenAI → https://platform.openai.com/settings/billing")
        elif "401" in err:
            print("Clave API inválida.")
        else:
            print(f"Error GPT: {e}")

    return anotaciones


# ─────────────────────────────────────────────────────────
# 7. MAIN
# ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Valida la FC de un reloj óptico contra una banda de referencia (.FIT)"
    )
    parser.add_argument("archivos", nargs=2, metavar="archivo.fit",
                        help="Dos archivos .FIT: [dispositivo] [referencia]")
    parser.add_argument("--gpt", action="store_true",
                        help="Análisis científico con GPT-4o (requiere OPENAI_API_KEY)")
    parser.add_argument("--fcmax", type=int, default=None,
                        help="FCmax real del atleta en ppm (para calcular zonas correctamente). "
                             "Si no se indica se usa la FC máxima del archivo de referencia.")
    args = parser.parse_args()

    ruta_dev, ruta_ref = args.archivos
    nombre_dev = Path(ruta_dev).stem
    nombre_ref = Path(ruta_ref).stem

    fc_dev = leer_fc(ruta_dev)
    fc_ref = leer_fc(ruta_ref)

    print("\nAlineando y calculando métricas...")
    fc1a, fc2a, _, _ = alinear(fc_ref, fc_dev)
    m     = calcular_metricas(fc1a, fc2a)
    zonas, fcmax, fcmax_origen = analizar_por_zonas(fc1a, fc2a, args.fcmax)
    lag   = estimar_lag(fc1a, fc2a)

    imprimir_resumen(nombre_ref, nombre_dev, m, zonas, lag, fcmax, fcmax_origen)

    anotaciones = []
    # GPT desactivado temporalmente.
    if False and args.gpt:
        anotaciones = analizar_con_gpt(nombre_ref, nombre_dev,
                                       m, zonas, lag, fc_ref, fc_dev)

    base = Path(ruta_dev).parent
    tag  = f"{nombre_dev}_vs_{nombre_ref}"

    graficar_series(fc_ref, nombre_ref, fc_dev, nombre_dev,
                    base / f"series_{tag}.png", anotaciones=anotaciones)

    graficar_validacion(fc_ref, nombre_ref, fc_dev, nombre_dev,
                        m, zonas, fcmax, base / f"validacion_{tag}.png")


if __name__ == "__main__":
    main()

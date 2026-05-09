"""
AI-powered session analysis using GPT-4o.

Generates structured reports and annotated matplotlib charts based on the
scientific wearable-device validation methodology (ECG vs PPG, Bland-Altman,
CCC de Lin, MAE/MAPE, zone-stratified error, lag/overshoot detection).
"""

from __future__ import annotations

import io
import base64
import os
import json
import re
from datetime import datetime

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy import stats

import openai

# ─────────────────────────────────────────────────────────────────────────────
# SYSTEM PROMPTS
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """Eres un científico deportivo experto en validación de dispositivos wearables biométricos para el rendimiento atlético. Analizas datos de frecuencia cardíaca (FC) de sensores ópticos PPG (muñeca o dedo) comparados con dispositivos de referencia ECG (bandas de pecho como Polar H10).

## Marco Científico

Tu análisis se basa en protocolos de validación establecidos:
- **CCC de Lin (ρc)**: mide acuerdo real (no solo asociación). ρc = r × Cb donde Cb corrige el sesgo sistemático.
- **Bland-Altman**: sesgo medio (bias) y límites de acuerdo LoA = bias ± 1.96·SD(diferencias). El 95% de las diferencias deben caer dentro de los LoA.
- **MAE/MAPE**: error absoluto medio en bpm y porcentual — la métrica más comunicable al deportista.
- **Análisis por zonas Z1-Z5**: el error PPG aumenta con la intensidad cardíaca.

## Umbrales de Validación (Literatura)

### CCC de Lin
| Valor | Calidad |
|-------|---------|
| > 0.99 | Casi perfecta — intercambiable con gold standard |
| 0.95–0.99 | Sustancial — altamente fiable |
| 0.90–0.95 | Moderada — aceptable para uso general |
| < 0.90 | Pobre — no recomendable para decisiones críticas |

### MAE
| Valor | Calidad |
|-------|---------|
| < 3 bpm | Excelente |
| 3–5 bpm | Aceptable para monitorización aeróbica |
| 5–10 bpm | Usar con precaución |
| > 10 bpm | No fiable para guiar intensidad |

### MAPE
- < 5 %: Excelente · 5–10 %: Aceptable · > 10 %: Por debajo del estándar mínimo

### LoA (semiancho = (LoA_sup − LoA_inf) / 2)
- ≤ ±6 bpm: Muy consistente · ±6–±10: Aceptable · ±10–±15: Inconsistente · > ±15: No fiable

## Patrones de Error PPG

**Lag algorítmico**: Los sensores PPG retrasan 10–30 s respecto al ECG por los filtros de promediado. Lag > 5 s es problemático en intervalos porque el dispositivo reporta la intensidad del pasado.

**Overshooting**: Cuando la FC real cae tras el esfuerzo pero el algoritmo sigue subiendo o mantiene el pico. Distorsiona métricas de recuperación cardiovascular.

**Cadence Lock**: El sensor confunde las vibraciones rítmicas del paso (160–185 ppm) con el pulso. Visible como una sección donde la FC del dispositivo se mantiene en una línea extrañamente plana coincidiendo con la cadencia de carrera.

**Sesgo proporcional**: El error aumenta con la FC — el dispositivo pierde precisión precisamente cuando el deportista más lo necesita. Visible en Bland-Altman como una pendiente ascendente en los puntos.

## Benchmarks por Actividad

| Actividad | MAE típico | Fiabilidad |
|-----------|-----------|------------|
| Sueño / Reposo | 0.8–1.5 bpm | Muy alta |
| Caminata | 2.5–3.5 bpm | Alta |
| Running constante | 3.0–5.5 bpm | Moderada-Alta |
| HIIT / Intervalos | 8.0–15.0 bpm | Baja |
| CrossFit / Pesas | 10.0–20.0 bpm | Muy baja |

## Instrucciones de Respuesta

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin texto extra) con esta estructura:

{
  "informe": {
    "resumen_ejecutivo": "2-3 frases con el veredicto más importante: CCC, MAE, para qué tipo de entrenamiento es fiable.",
    "validez_general": "Análisis de CCC, ICC, r de Pearson. ¿Supera umbrales? ¿Comparable a literatura de validación de wearables ópticos?",
    "bland_altman": "Interpretación del sesgo y LoA. ¿Clínicamente relevante? ¿Hay sesgo proporcional (error aumenta con FC)?",
    "error_por_zonas": "Análisis zona por zona: dónde falla más y por qué fisiológicamente (vasoconstricción, movimiento, etc.).",
    "lag_analisis": "Interpretación del lag estimado. ¿Es problemático para este tipo de entrenamiento? ¿Cuánto retrasa la respuesta del sensor?",
    "fenomenos_detectados": "¿Se detecta overshooting, cadence lock u otros fenómenos en la serie temporal? Si no, indicar por qué no aplica.",
    "recomendacion_practica": "Para qué tipo de deportista/entrenamiento es fiable este dispositivo basándose en ESTA sesión específica."
  },
  "anotaciones_temporales": [
    {
      "tiempo_inicio": 120,
      "tiempo_fin": 180,
      "tipo": "lag",
      "descripcion": "Retraso algorítmico al inicio del esfuerzo intenso",
      "severidad": "moderada"
    }
  ],
  "veredicto_sesion": {
    "calificacion": "bueno",
    "etiqueta": "Fiable para Z2-Z3",
    "para_quien": "Deportistas de resistencia en entrenamientos aeróbicos continuos"
  }
}

Tipos de anotación válidos: "lag", "overshooting", "cadence_lock", "alta_discrepancia", "recuperacion_lenta"
Calificaciones válidas: "excelente", "bueno", "moderado", "deficiente"
Severidades válidas: "leve", "moderada", "severa"

Sé riguroso y específico con los números. Evita el lenguaje de marketing."""


DEVICE_SYSTEM_PROMPT = """Eres un científico deportivo experto en validación de wearables. Has analizado múltiples sesiones de un dispositivo PPG comparado con un ECG de referencia. Genera un VEREDICTO FINAL del dispositivo sintetizando los hallazgos.

El veredicto debe evaluar consistencia entre sesiones, rendimiento por tipo de entrenamiento, y dar una recomendación práctica clara.

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin texto extra):

{
  "veredicto_general": "Párrafo de 3-4 frases que resume el rendimiento global del dispositivo con los datos más relevantes.",
  "calificacion_final": "bueno",
  "etiqueta_final": "Fiable para resistencia, limitado en alta intensidad",
  "fortalezas": ["Fortaleza específica 1 con datos", "Fortaleza 2"],
  "debilidades": ["Debilidad específica 1 con datos", "Debilidad 2"],
  "por_tipo_entrenamiento": {
    "Descripción tipo 1": "Evaluación específica con métricas",
    "Descripción tipo 2": "Evaluación específica con métricas"
  },
  "perfil_deportista_ideal": "Descripción del deportista para quien este dispositivo es más adecuado.",
  "no_recomendado_para": "Contextos donde NO se recomienda usar este dispositivo.",
  "comparativa_literatura": "Breve comparación con benchmarks de la literatura para dispositivos similares.",
  "recomendacion_final": "Consejo práctico concreto: ¿vale la pena? ¿para qué? ¿cuándo usar la referencia ECG?"
}

Calificaciones válidas: "excelente", "bueno", "moderado", "deficiente"
Sé riguroso. Cita métricas concretas. Responde en español."""


# ─────────────────────────────────────────────────────────────────────────────
# CHART HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _fig_to_base64(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight",
                facecolor=fig.get_facecolor())
    buf.seek(0)
    encoded = base64.b64encode(buf.read()).decode("utf-8")
    plt.close(fig)
    return encoded


def _sec_to_mmss(x, _):
    m = int(x) // 60
    s = int(x) % 60
    return f"{m}:{s:02d}"


def _smooth(arr: np.ndarray, window: int = 15) -> np.ndarray:
    if len(arr) < window:
        return arr
    kernel = np.ones(window) / window
    return np.convolve(arr, kernel, mode="same")


# ─────────────────────────────────────────────────────────────────────────────
# ANNOTATED TEMPORAL CHART
# ─────────────────────────────────────────────────────────────────────────────

ANNOTATION_COLORS = {
    "lag":               "#6366f1",
    "overshooting":      "#f59e0b",
    "cadence_lock":      "#ec4899",
    "alta_discrepancia": "#ef4444",
    "recuperacion_lenta":"#8b5cf6",
}


def generate_annotated_temporal_chart(
    fc_data:      dict,
    annotations:  list[dict],
    device_name:  str,
    ref_name:     str,
    session_name: str = "",
    metrics:      dict | None = None,
) -> str:
    time_arr = np.array(fc_data.get("time", []), dtype=float)
    ref_arr  = np.array(fc_data.get("reference", []), dtype=float)
    dev_arr  = np.array(fc_data.get("device", []), dtype=float)

    if len(time_arr) == 0:
        return ""

    ref_s    = _smooth(ref_arr, 15)
    dev_s    = _smooth(dev_arr, 15)
    diff_s   = np.abs(dev_s - ref_s)

    C_REF = "#374151"
    C_DEV = "#3b82f6"

    fig, (ax_main, ax_diff) = plt.subplots(
        2, 1, figsize=(15, 7), facecolor="#ffffff",
        gridspec_kw={"height_ratios": [3, 1], "hspace": 0.06},
    )

    # ── Main FC ──────────────────────────────────────────────────────────────
    ax_main.set_facecolor("#ffffff")
    for sp in ax_main.spines.values():
        sp.set_color("#e5e7eb")

    # Raw (ghost)
    ax_main.plot(time_arr, ref_arr, color=C_REF, alpha=0.10, linewidth=0.4)
    ax_main.plot(time_arr, dev_arr, color=C_DEV, alpha=0.10, linewidth=0.4)

    # Smoothed
    l_ref, = ax_main.plot(time_arr, ref_s, color=C_REF, linewidth=2.0,
                          label=ref_name, zorder=4)
    l_dev, = ax_main.plot(time_arr, dev_s, color=C_DEV, linewidth=2.0,
                          label=device_name, zorder=4)

    # Agreement shading
    ax_main.fill_between(time_arr, ref_s, dev_s,
                         where=(diff_s <= 5),   color="#10b981", alpha=0.08, zorder=2)
    ax_main.fill_between(time_arr, ref_s, dev_s,
                         where=(diff_s > 5) & (diff_s <= 10),
                         color="#f59e0b", alpha=0.14, zorder=2)
    ax_main.fill_between(time_arr, ref_s, dev_s,
                         where=(diff_s > 10),   color="#ef4444", alpha=0.18, zorder=2)

    # GPT annotations
    y_max   = float(np.nanmax(np.concatenate([ref_s, dev_s])))
    y_min   = float(np.nanmin(np.concatenate([ref_s, dev_s])))
    y_range = max(y_max - y_min, 10)

    for i, ann in enumerate(annotations):
        t0    = ann.get("tiempo_inicio", 0)
        t1    = ann.get("tiempo_fin", t0 + 30)
        tipo  = ann.get("tipo", "alta_discrepancia")
        desc  = ann.get("descripcion", "")
        color = ANNOTATION_COLORS.get(tipo, "#6b7280")

        ax_main.axvspan(t0, t1, alpha=0.11, color=color, zorder=1)
        ax_main.axvline(t0, color=color, linewidth=1.1, linestyle="--",
                        alpha=0.55, zorder=3)

        label_y = y_max + y_range * 0.04 + (i % 3) * y_range * 0.07
        ax_main.annotate(
            desc[:45] + ("…" if len(desc) > 45 else ""),
            xy=(t0, y_max), xytext=((t0 + t1) / 2, label_y),
            fontsize=7.5, color=color, ha="center",
            arrowprops=dict(arrowstyle="-", color=color, lw=0.7),
            zorder=5,
        )

    ax_main.set_ylabel("FC (ppm)", color="#374151", fontsize=11)
    ax_main.tick_params(colors="#6b7280", labelsize=9, labelbottom=False)
    ax_main.grid(True, color="#e5e8ef", linewidth=0.7, alpha=0.8)
    ax_main.set_axisbelow(True)
    ax_main.xaxis.set_major_formatter(plt.FuncFormatter(_sec_to_mmss))
    ax_main.set_xlim(time_arr[0], time_arr[-1])

    mae_txt = (f"MAE={metrics['mae']:.1f} bpm  ·  CCC={metrics['ccc']:.3f}"
               if metrics else "")
    ax_main.legend(handles=[l_ref, l_dev], loc="upper right", fontsize=10,
                   framealpha=0.9, edgecolor="#e5e7eb",
                   title=mae_txt, title_fontsize=9)

    # ── Difference chart ─────────────────────────────────────────────────────
    ax_diff.set_facecolor("#f9fafb")
    for sp in ax_diff.spines.values():
        sp.set_color("#e5e7eb")

    ax_diff.fill_between(time_arr, diff_s, 0,
                         where=(diff_s <= 5),   color="#10b981", alpha=0.55)
    ax_diff.fill_between(time_arr, diff_s, 0,
                         where=(diff_s > 5) & (diff_s <= 10),
                         color="#f59e0b", alpha=0.60)
    ax_diff.fill_between(time_arr, diff_s, 0,
                         where=(diff_s > 10),   color="#ef4444", alpha=0.60)

    ax_diff.axhline(5,  color="#f59e0b", linewidth=1.0, linestyle="--", alpha=0.7)
    ax_diff.axhline(10, color="#ef4444", linewidth=1.0, linestyle="--", alpha=0.7)

    ax_diff.set_ylabel("|Δ FC|", color="#374151", fontsize=9)
    ax_diff.set_xlabel("Tiempo", color="#374151", fontsize=10)
    ax_diff.xaxis.set_major_formatter(plt.FuncFormatter(_sec_to_mmss))
    ax_diff.set_xlim(time_arr[0], time_arr[-1])
    ax_diff.tick_params(colors="#6b7280", labelsize=8)
    ax_diff.grid(True, color="#e5e8ef", linewidth=0.6, alpha=0.8)
    ax_diff.set_axisbelow(True)

    title = f"Análisis IA · {device_name} vs {ref_name}"
    if session_name:
        title += f"  —  {session_name}"
    fig.suptitle(title, color="#111827", fontsize=12, fontweight="bold", y=1.01)

    return _fig_to_base64(fig)


# ─────────────────────────────────────────────────────────────────────────────
# ANNOTATED BLAND-ALTMAN + ZONE ERROR CHART
# ─────────────────────────────────────────────────────────────────────────────

def generate_annotated_validation_chart(
    metrics:     dict,
    zones:       list[dict],
    device_name: str,
    ref_name:    str,
    fc_data:     dict | None = None,
) -> str:
    bias  = metrics.get("bias",  0.0)
    loa_u = metrics.get("loa_u", 0.0)
    loa_l = metrics.get("loa_l", 0.0)

    fig, axes = plt.subplots(1, 2, figsize=(14, 6), facecolor="#ffffff")
    fig.subplots_adjust(wspace=0.32)

    # ── Bland-Altman ─────────────────────────────────────────────────────────
    ax = axes[0]
    ax.set_facecolor("#ffffff")
    for sp in ax.spines.values():
        sp.set_color("#e5e7eb")

    if fc_data:
        ref_arr  = np.array(fc_data.get("reference", []), dtype=float)
        dev_arr  = np.array(fc_data.get("device",    []), dtype=float)
        means    = (ref_arr + dev_arr) / 2
        diffs    = ref_arr - dev_arr
        abs_d    = np.abs(diffs)

        c_pts = np.where(abs_d <= 5, "#10b981",
                np.where(abs_d <= 10, "#f59e0b", "#ef4444"))
        ax.scatter(means, diffs, c=c_pts, alpha=0.30, s=5, zorder=3)

        # Proportional bias trend
        if len(means) > 20:
            slope_ba, int_ba, r_ba, p_ba, _ = stats.linregress(means, diffs)
            x_ln = np.linspace(float(means.min()), float(means.max()), 100)
            ls = "--" if p_ba > 0.05 else "-"
            ax.plot(x_ln, slope_ba * x_ln + int_ba,
                    color="#8b5cf6", linewidth=1.6, linestyle=ls,
                    label=f"Tendencia r={r_ba:.2f} p={p_ba:.3f}", zorder=4)

    ax.axhline(bias,  color="#374151", linewidth=2.0, zorder=5,
               label=f"Bias: {bias:+.1f} bpm")
    ax.axhline(loa_u, color="#3b82f6", linewidth=1.3, linestyle="--", zorder=5,
               label=f"LoA sup: {loa_u:+.1f}")
    ax.axhline(loa_l, color="#3b82f6", linewidth=1.3, linestyle="--", zorder=5,
               label=f"LoA inf: {loa_l:+.1f}")
    ax.axhspan(loa_l, loa_u, alpha=0.05, color="#3b82f6", zorder=1)

    ax.set_xlabel("Media (ref + disp) / 2  [bpm]", fontsize=10, color="#374151")
    ax.set_ylabel("Diferencia (ref − disp)  [bpm]",  fontsize=10, color="#374151")
    ax.set_title("Bland–Altman", fontsize=11, fontweight="bold",
                 color="#111827", pad=10)
    ax.legend(loc="upper right", fontsize=8, framealpha=0.9, edgecolor="#e5e7eb")
    ax.tick_params(colors="#6b7280", labelsize=9)
    ax.grid(True, color="#e5e8ef", linewidth=0.7, alpha=0.8)
    ax.set_axisbelow(True)

    # ── Error por zonas ───────────────────────────────────────────────────────
    ax2 = axes[1]
    ax2.set_facecolor("#ffffff")
    for sp in ax2.spines.values():
        sp.set_color("#e5e7eb")

    valid = [z for z in zones if z.get("mae") is not None and z.get("n", 0) >= 5]
    if valid:
        names  = [z["zone"].split()[0] for z in valid]
        maes   = [z["mae"]      for z in valid]
        pcts   = [z["pct_time"] for z in valid]
        colors = [
            "#10b981" if m <= 3 else
            "#f59e0b" if m <= 5 else
            "#f97316" if m <= 10 else
            "#ef4444"
            for m in maes
        ]
        bars = ax2.bar(names, maes, color=colors, alpha=0.85,
                       edgecolor="#ffffff", linewidth=1.5, zorder=3)
        ax2.axhline(3,  color="#10b981", linewidth=1.0, linestyle="--",
                    alpha=0.7, label="3 bpm (excelente)")
        ax2.axhline(10, color="#ef4444", linewidth=1.0, linestyle="--",
                    alpha=0.7, label="10 bpm (límite)")

        for bar, mae, pct in zip(bars, maes, pcts):
            ax2.text(bar.get_x() + bar.get_width() / 2,
                     bar.get_height() + 0.15,
                     f"{mae:.1f}", ha="center", va="bottom",
                     fontsize=9, color="#374151")
            if bar.get_height() > 2:
                ax2.text(bar.get_x() + bar.get_width() / 2,
                         bar.get_height() / 2,
                         f"{pct}%", ha="center", va="center",
                         fontsize=8, color="#ffffff", fontweight="bold")

    ax2.set_xlabel("Zona de intensidad", fontsize=10, color="#374151")
    ax2.set_ylabel("MAE (bpm)",           fontsize=10, color="#374151")
    ax2.set_title("Error por zonas",       fontsize=11, fontweight="bold",
                  color="#111827", pad=10)
    ax2.legend(fontsize=8, framealpha=0.9, edgecolor="#e5e7eb")
    ax2.tick_params(colors="#6b7280", labelsize=9)
    ax2.grid(True, color="#e5e8ef", linewidth=0.7, alpha=0.8, axis="y")
    ax2.set_axisbelow(True)

    fig.suptitle(
        f"Análisis IA · Validación {device_name} vs {ref_name}",
        color="#111827", fontsize=12, fontweight="bold", y=1.02,
    )
    return _fig_to_base64(fig)


# ─────────────────────────────────────────────────────────────────────────────
# PROMPT BUILDERS
# ─────────────────────────────────────────────────────────────────────────────

def _build_session_prompt(session_doc: dict) -> str:
    m        = session_doc.get("metrics", {})
    zones    = session_doc.get("zones", [])
    lag      = session_doc.get("lag", 0) or 0
    fcmax    = session_doc.get("fcmax", 0) or 0
    duration = session_doc.get("duration_seconds", 0) or 0
    sport    = session_doc.get("sport_type", "")
    diff     = session_doc.get("session_difficulty", "")
    dev_name = session_doc.get("device_name", "Dispositivo")
    ref_name = session_doc.get("reference_name", "Referencia")
    s_name   = session_doc.get("session_name", "")

    dur_str = f"{duration // 60}m {duration % 60}s"
    sport_lbl = {"running": "Running", "cycling": "Ciclismo", "gym": "Gimnasio"}.get(sport, sport)
    diff_lbl  = {"z2": "Z2 Aeróbico", "tempo": "Tempo/Z3", "series": "Series/Intervalos"}.get(diff, diff)

    zones_txt = ""
    for z in zones:
        if z.get("n", 0) >= 5:
            b = z.get("bias") or 0
            zones_txt += (
                f"  - {z['zone']}: MAE={z.get('mae','N/A')} bpm, "
                f"MAPE={z.get('mape','N/A')}%, Bias={b:+.1f} bpm, "
                f"%tiempo={z.get('pct_time','N/A')}%\n"
            )

    # Subsample FC series to ≤200 points for token efficiency
    fc_data   = session_doc.get("fc_data", {})
    ref_fc    = fc_data.get("reference", [])
    dev_fc    = fc_data.get("device",    [])
    time_fc   = fc_data.get("time",      [])
    n_pts     = len(ref_fc)
    if n_pts > 200:
        step     = n_pts // 200
        idx      = list(range(0, n_pts, step))[:200]
        ref_s    = [round(ref_fc[i], 1) for i in idx]
        dev_s    = [round(dev_fc[i], 1) for i in idx]
        time_s   = [time_fc[i] for i in idx]
    else:
        ref_s  = [round(v, 1) for v in ref_fc]
        dev_s  = [round(v, 1) for v in dev_fc]
        time_s = list(time_fc)

    series_txt = "\n".join(f"{t},{r},{d}" for t, r, d in zip(time_s, ref_s, dev_s))

    return f"""## Sesión: {s_name}

Dispositivo bajo prueba: {dev_name}
Referencia (gold standard): {ref_name}
Deporte: {sport_lbl} | Intensidad: {diff_lbl} | Duración: {dur_str} | FC máx: {fcmax} bpm

## Métricas de Validación
CCC de Lin: {m.get('ccc', 'N/A'):.4f}
ICC:        {m.get('icc', 'N/A'):.4f}
r Pearson:  {m.get('r',   'N/A'):.4f}  (p={m.get('p', 'N/A'):.4f})
MAE:        {m.get('mae',  'N/A'):.2f} bpm
MAPE:       {m.get('mape', 'N/A'):.2f} %
RMSE:       {m.get('rmse', 'N/A'):.2f} bpm
Bias:       {m.get('bias', 'N/A'):+.2f} bpm
LoA superior: {m.get('loa_u', 'N/A'):+.2f} bpm
LoA inferior: {m.get('loa_l', 'N/A'):+.2f} bpm
Pendiente regresión: {m.get('slope', 'N/A'):.3f}
FC media referencia: {m.get('media_ref', 'N/A'):.1f} bpm
FC media dispositivo: {m.get('media_dev', 'N/A'):.1f} bpm
Lag estimado: {lag:+.1f} s
N muestras: {m.get('n', 'N/A'):,}

## Error por Zonas
{zones_txt or "Sin datos suficientes por zona."}

## Serie Temporal FC ({len(time_s)} puntos — formato: tiempo_s,referencia_bpm,dispositivo_bpm)
{series_txt}

Analiza con rigurosidad científica. Identifica los momentos de mayor discrepancia en la serie temporal e inclúyelos como anotaciones con tiempos concretos."""


def _build_device_prompt(
    device_name: str,
    ref_name:    str,
    sessions:    list[dict],
) -> str:
    lines = []
    for s in sessions:
        m = s.get("metrics", {})
        lines.append(
            f"- [{s.get('sport_type','?')}/{s.get('session_difficulty','?')}] "
            f"\"{s.get('session_name','')}\" | "
            f"CCC={m.get('ccc',0):.3f} | MAE={m.get('mae',0):.1f} bpm | "
            f"MAPE={m.get('mape',0):.1f}% | Bias={m.get('bias',0):+.1f} | "
            f"LoA=[{m.get('loa_l',0):.1f},{m.get('loa_u',0):.1f}] | "
            f"Lag={s.get('lag',0) or 0:.0f}s"
        )

    return f"""## Dispositivo: {device_name}
Referencia: {ref_name}
Sesiones analizadas: {len(sessions)}

{chr(10).join(lines)}

Genera el VEREDICTO FINAL basándote en el patrón de rendimiento a través de todas las sesiones. Considera consistencia, variabilidad por tipo de entrenamiento y evolución del error con la intensidad. Responde en español."""


# ─────────────────────────────────────────────────────────────────────────────
# JSON PARSER
# ─────────────────────────────────────────────────────────────────────────────

def _parse_json(content: str) -> dict:
    """Extract and parse JSON from GPT response, stripping any markdown fences."""
    content = re.sub(r"```json\s*", "", content)
    content = re.sub(r"```\s*",     "", content)
    return json.loads(content.strip())


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

async def generate_session_ai_analysis(session_doc: dict) -> dict:
    """
    Call GPT-4o to analyse a session, then produce annotated charts.
    Returns a dict suitable for storage in sessions.ai_analysis.
    """
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("OPENAI_API_KEY no está configurada en .env")

    client = openai.AsyncOpenAI(api_key=api_key)

    response = await client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": _build_session_prompt(session_doc)},
        ],
        response_format={"type": "json_object"},
        temperature=0.25,
        max_tokens=2200,
    )

    report = _parse_json(response.choices[0].message.content or "{}")
    annotations = report.get("anotaciones_temporales", [])

    fc_data   = session_doc.get("fc_data",   {})
    metrics   = session_doc.get("metrics",   {})
    zones     = session_doc.get("zones",     [])
    dev_name  = session_doc.get("device_name",      "Dispositivo")
    ref_name  = session_doc.get("reference_name",   "Referencia")
    sess_name = session_doc.get("session_name",     "")

    temporal   = generate_annotated_temporal_chart(
        fc_data, annotations, dev_name, ref_name, sess_name, metrics,
    )
    validation = generate_annotated_validation_chart(
        metrics, zones, dev_name, ref_name, fc_data,
    )

    return {
        "report":           report,
        "annotated_charts": {"temporal": temporal, "validation": validation},
        "generated_at":     datetime.utcnow().isoformat(),
        "model":            "gpt-4o",
    }


async def generate_device_ai_verdict(
    device_name: str,
    ref_name:    str,
    sessions:    list[dict],
) -> dict:
    """
    Call GPT-4o to produce a device-level verdict from all sessions.
    Returns a dict suitable for storage in devices.ai_verdict.
    """
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("OPENAI_API_KEY no está configurada en .env")

    client = openai.AsyncOpenAI(api_key=api_key)

    response = await client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": DEVICE_SYSTEM_PROMPT},
            {"role": "user",   "content": _build_device_prompt(device_name, ref_name, sessions)},
        ],
        response_format={"type": "json_object"},
        temperature=0.35,
        max_tokens=1600,
    )

    verdict = _parse_json(response.choices[0].message.content or "{}")

    return {
        "verdict":           verdict,
        "generated_at":      datetime.utcnow().isoformat(),
        "model":             "gpt-4o",
        "sessions_analyzed": len(sessions),
    }

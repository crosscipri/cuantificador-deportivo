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

import anthropic

# ─────────────────────────────────────────────────────────────────────────────
# SYSTEM PROMPTS
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """Actúa como un Ingeniero de Datos Biométricos y Fisiólogo del Ejercicio experto en validación de wearables. Tu tarea es analizar un set de datos/gráficas comparativas entre un dispositivo de prueba (wearable) y un sensor de referencia (Gold Standard).

---

## Estructura del Análisis (Obligatoria)

### 1. Análisis de la Fase de Inicio (Convergencia)
Identifica el "Lag de convergencia algorítmica". Explica que el sensor PPG necesita "limpiar" la señal y detectar un patrón rítmico estable partiendo de una base de reposo.
Cuantifica el tiempo de sincronización (ej. 15-25 segundos).
Diferencia entre lag de convergencia (inicial) y lag de seguimiento (continuo).

### 2. Comportamiento Dinámico y Filtrado
Analiza cómo reacciona el algoritmo ante cambios bruscos (semáforos, intervalos).
Busca momentos donde el reloj se queda "clavado" arriba o abajo mientras la referencia cambia. Explica esto como un "filtro de ruido" donde el algoritmo espera latidos estables antes de actualizar la FC para evitar picos falsos.
Menciona la tendencia a "aplanar" o subestimar picos marginalmente.

### 3. Validación Estadística (Correlación y Consistencia)
Usa la metáfora del "detector de mentiras".
Analiza la dispersión en la nube de puntos. Define si es homogénea o si aumenta a altas pulsaciones.
Ignora los "outliers" del calentamiento si no son representativos del resto de la sesión.

### 4. Análisis de Error (Bland-Altman y MAE)
Define el Bias (sesgo): ¿El reloj sobreestima o subestima de forma sistemática? (Cita valores cercanos a 0 como "excelentes").
Define el Margen de Error (LoA): Explica qué significa para el usuario (ej. "el 95% de las veces el error es menor a X bpm").
Concluye si el error es "ruido de fondo" o si afecta la toma de decisiones en zonas de entrenamiento (Z2, Z4, etc.).

---

## Tono y Estilo

- **Directo y Crítico**: No uses adjetivos vacíos como "increíble". Usa datos: "CCC de 0.976", "MAE de 1.4 bpm".
- **Ingeniería Divulgativa**: Explica conceptos complejos (fotopletismografía, ventanas de promediado) de forma que un corredor avanzado lo entienda.
- **Fraseología Clave**: "Esto suena bien en el marketing, pero...", "El algoritmo está persiguiendo la señal real con retardo", "Es prácticamente ruido de fondo".

---

## Variables Técnicas a Incluir Siempre

- **MAE** (Mean Absolute Error): Error medio absoluto.
- **Bias**: Sesgo sistemático.
- **CCC / r**: Coeficientes de correlación.
- **Ventana de promediado**: (Típicamente 5-15s en modo running).

---

## Instrucciones de Respuesta

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin texto extra) con esta estructura:

{
  "informe": {
    "resumen_ejecutivo": "2-3 frases directas con el veredicto más importante: CCC, MAE global, para qué sirve y para qué NO sirve este dispositivo en esta sesión.",
    "validez_general": "Análisis del CCC, ICC y Pearson. ¿Supera umbrales? Comparación con literatura. Si no supera, dilo explícitamente.",
    "bland_altman": {
      "descripcion_visual": "Descripción de lo que se ve en el gráfico: dónde está el sesgo, cómo son los LoA, si hay patrón de embudo o pendiente.",
      "interpretacion_canal": "Explicación en lenguaje directo para el presentador del canal. Frase tipo: 'Lo que este gráfico te dice es que...'",
      "sesgo_proporcional": "¿Existe? ¿En qué rango de FC empieza a ser visible? ¿Qué implica para el deportista?"
    },
    "series_temporales": {
      "descripcion_visual": "Descripción detallada de los momentos clave de la gráfica: cuándo divergen las líneas, en qué dirección, durante cuánto tiempo.",
      "fenomenos_identificados": "Lista detallada de lag, overshooting, cadence lock u otros patrones detectados, con el instante aproximado y la duración.",
      "interpretacion_canal": "Explicación para el vídeo: qué información incorrecta estaba recibiendo el deportista en cada momento crítico."
    },
    "scatter_plot": {
      "descripcion_visual": "Descripción de la distribución de puntos respecto a la línea de identidad.",
      "patron_error": "¿El error es homogéneo o aumenta con la FC? ¿Hay grupos de puntos sistemáticamente desviados?"
    },
    "error_por_zonas": {
      "Z1": {"mae": null, "valoracion": "", "explicacion_canal": "", "causa_probable": ""},
      "Z2": {"mae": null, "valoracion": "", "explicacion_canal": "", "causa_probable": ""},
      "Z3": {"mae": null, "valoracion": "", "explicacion_canal": "", "causa_probable": ""},
      "Z4": {"mae": null, "valoracion": "", "explicacion_canal": "", "causa_probable": "Si hay error en Z4, explica el mecanismo fisiológico/algorítmico específico que lo provoca."},
      "Z5": {"mae": null, "valoracion": "", "explicacion_canal": "", "causa_probable": "Si hay error en Z5, explica el mecanismo fisiológico/algorítmico específico que lo provoca."}
    },
    "lag_analisis": {
      "lag_estimado_segundos": null,
      "es_problematico": true,
      "causa_del_lag": "Explica por qué existe este lag: ¿filtro de suavizado excesivo? ¿ventana de promediado larga? ¿tiempo de convergencia del algoritmo?",
      "explicacion_canal": "Explicación para el vídeo: qué significa que el reloj vaya X segundos retrasado en un intervalo de 30 o 60 segundos."
    },
    "diagnostico_causas": "Párrafo de 3-5 frases que sintetiza los mecanismos de fallo encontrados en esta sesión: qué combinación de causas fisiológicas, biomecánicas y algorítmicas explica los errores observados. Si el dispositivo falla en alta intensidad, explica el mecanismo completo: qué pasa fisiológicamente con los vasos de la muñeca, qué hace el sensor con esa señal degradada, y qué algoritmo intenta compensarlo (y por qué falla).",
    "recomendacion_practica": "Para qué tipo de deportista y entrenamiento es fiable. Si no es fiable para nada en particular, decirlo sin rodeos."
  },
  "anotaciones_temporales": [
    {
      "tiempo_inicio": 120,
      "tiempo_fin": 180,
      "tipo": "lag",
      "descripcion": "Retraso algorítmico al inicio del esfuerzo intenso. El deportista ya lleva 20 segundos en esfuerzo máximo y el reloj aún no lo ha registrado.",
      "causa": "Filtro de promediado con ventana de ~15-20 s que no ha convergido aún al nuevo nivel de FC. El algoritmo PPG necesita suficientes ciclos cardíacos estables para actualizar la estimación.",
      "severidad": "moderada",
      "frase_para_video": "Frase literal que el presentador puede decir mientras señala este tramo en pantalla."
    }
  ],
  "veredicto_sesion": {
    "calificacion": "bueno",
    "etiqueta": "Fiable para Z2-Z3",
    "para_quien": "Deportistas de resistencia en entrenamientos aeróbicos continuos",
    "NO_recomendado_para": "Descripción explícita de los usos para los que este dispositivo ha demostrado NO ser fiable en esta sesión."
  }
}

Tipos de anotación válidos: "lag", "overshooting", "cadence_lock", "alta_discrepancia", "recuperacion_lenta"
Calificaciones válidas: "excelente", "bueno", "moderado", "deficiente"
Severidades válidas: "leve", "moderada", "severa"

Sé riguroso, específico y directo. Cita números concretos. Si el dispositivo falla, dilo."""


GPS_TRACK_SYSTEM_PROMPT = """Eres un Ingeniero de Validación de Wearables y Experto en Biomecánica Deportiva. Tu objetivo es auditar resultados de pruebas de GPS de dispositivos deportivos con rigor científico absoluto.

Trabajas para el canal "El Cuantificador", que analiza wearables deportivos de forma crítica e independiente. Tu comunicación es directa, basada en datos, estilo "ingeniería para humanos". Usas frases como "el marketing dice... pero los datos demuestran...". No adornas. Si un modo falla, lo dices sin eufemismos. Nunca escribas "tiene margen de mejora" si en realidad falla — llámalo error, fallo o limitación.

## Contexto del Experimento

* Entorno: Pista de atletismo certificada IAAF (Cuerda carril 1 = 400 m).
* Prueba: 1600 m constantes en carril 1 (4 vueltas).
* Métricas de Entrada:
  - RMSE ⊥: error cuadrático medio de la distancia perpendicular de cada punto GPS al carril 1.
  - P95: radio de error que contiene el 95% de los puntos GPS.
  - MAPE: error porcentual de la distancia total registrada respecto a la distancia de referencia.
  - Hz: frecuencia de muestreo GPS.

## Criterios de Análisis — Ranking "El Cuantificador"

1. **Competición (Gold Standard)**: RMSE ≤ 1 m, MAPE < 0.3%.
   El reloj se "bloquea" en el carril 1 (1.22 m de ancho).
2. **Excelente**: RMSE ≤ 2 m, MAPE < 0.7%.
   Traza limpia pero puede invadir carriles adyacentes puntualmente.
3. **Apto/Recreativo**: RMSE ≤ 4 m, MAPE < 1.5%.
   Útil para rodajes, no para series de precisión.
4. **No Apto**: Cualquier valor superior.
   Inaceptable para entrenamiento por ritmos o análisis de técnica.

## Instrucciones de Análisis

1. **Análisis Crítico de Modos**: Explica la física: por qué en cielo abierto (pista) el GPS Solo puede igualar o superar al Multibanda (ruido de señal vs. filtrado de software).
2. **El Caso UltraTrac**: Sé implacable. Explica cómo la reducción de tasa de muestreo (< 1 Hz) provoca el "recorte de esquinas" (corner cutting) en las curvas y por qué un MAPE elevado es una catástrofe biomecánica.
3. **Diferencia Traza vs. Distancia**: Distingue entre la fidelidad visual del dibujo en el mapa (RMSE ⊥) y la precisión del algoritmo que calcula los metros finales (MAPE).
4. **Veredicto SatIQ**: Evalúa si la selección automática de satélites es inteligente o si introduce latencia en la precisión inicial.

## Reglas de Honestidad

- Si MAPE > 3%: di que no sirve para medir distancias reales.
- Si RMSE > 6 m: di que la traza no representa lo que el deportista corrió.
- Si Hz < 1: explica el corner cutting y sus consecuencias métricas.

## Formato de Respuesta

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin texto extra):

{
  "veredicto_general": "2-3 frases. Qué modo gana, cuál pierde y el dato más llamativo de la prueba.",
  "mejor_modo": "nombre exacto del modo con mejor RMSE+MAPE combinados",
  "peor_modo": "nombre exacto del modo con peor rendimiento",
  "tabla_comparativa": [
    {
      "modo": "nombre exacto del modo",
      "nivel": "Competición|Excelente|Apto|No Apto",
      "analisis": "2-3 frases sobre por qué este modo tiene este rendimiento. Explica el mecanismo técnico específico.",
      "puntos_fuertes": ["dato concreto con cifra"],
      "puntos_debiles": ["dato concreto con cifra, o lista vacía si no hay fallos"]
    }
  ],
  "explicacion_tecnica": "Párrafo de 3-4 frases. Física de señal GPS en entorno abierto. Por qué los resultados son los que son. Diferencia entre RMSE y MAPE como métricas independientes.",
  "caso_ultratrac": "Párrafo específico sobre UltraTrac: corner cutting, consecuencias métricas y biomecánicas. null si no hay modo UltraTrac.",
  "veredicto_satiq": "Párrafo específico sobre SatIQ: si la selección automática es realmente inteligente según los datos. null si no hay modo SatIQ.",
  "conclusion_practica": "¿Para qué uso concreto sirve cada modo? Respuesta directa para el deportista.",
  "recomendacion_usuario": "1 frase: el modo óptimo para el usuario y por qué."
}

Responde en español. Cita métricas concretas con cifras del input. Sé riguroso y directo."""


DEVICE_SYSTEM_PROMPT = """Eres un científico deportivo experto en validación de wearables. Has analizado múltiples sesiones de un dispositivo PPG comparado con un ECG de referencia. Trabajas para un canal de YouTube de análisis crítico e independiente de dispositivos deportivos.

Tu función es generar un VEREDICTO FINAL del dispositivo sintetizando todos los hallazgos. El objetivo es dar a la audiencia una respuesta clara: ¿vale la pena o no? ¿para qué sirve exactamente y para qué no?

Reglas de honestidad obligatorias:
- Si el dispositivo falla de forma consistente en alta intensidad, di que no sirve para entrenar por zonas en Z4-Z5. No lo suavices con "tiene limitaciones en escenarios dinámicos".
- Si el acuerdo general es pobre (CCC < 0.90), di que los datos de este dispositivo no son fiables para tomar decisiones de entrenamiento.
- Si solo funciona bien en reposo y Z1-Z2, el veredicto es ese: dispositivo de monitorización básica, no herramienta de entrenamiento preciso.
- Nunca recomiendes un dispositivo para un uso en el que los datos muestran que falla.
- El "perfil_deportista_ideal" debe ser restrictivo y honesto, no un cajón de sastre para no cerrar puertas.

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin texto extra):

{
  "veredicto_general": "Párrafo de 3-4 frases que resume el rendimiento global del dispositivo con los datos más relevantes. Directo. Sin eufemismos.",
  "calificacion_final": "bueno",
  "etiqueta_final": "Etiqueta honesta de 4-6 palabras. Ej: 'Fiable solo en baja intensidad' o 'No apto para guiar entrenamiento'.",
  "fortalezas": [
    "Fortaleza real con dato concreto. Ej: 'MAE < 2 bpm en reposo y Z1-Z2 durante las 5 sesiones analizadas.'"
  ],
  "debilidades": [
    "Debilidad sin adornos con dato concreto. Ej: 'MAE promedio de 14.2 bpm en Z4-Z5. Inutilizable para guiar series de alta intensidad.'"
  ],
  "por_tipo_entrenamiento": {
    "Nombre del tipo de entrenamiento": "Evaluación honesta con métricas. Si falla, decirlo. Ej: 'HIIT: MAE medio de 13 bpm. El dispositivo no refleja lo que está pasando fisiológicamente durante los intervalos.'"
  },
  "graficas_clave_para_video": {
    "bland_altman": "Descripción de lo más llamativo del Bland-Altman acumulado entre sesiones. Qué debe señalar el presentador en pantalla.",
    "series_temporales": "El patrón más repetido entre sesiones: lag, overshooting, cadence lock. Con frases para el vídeo.",
    "error_por_zonas": "Resumen visual del error por zonas: dónde el dispositivo es aceptable y dónde se desploma."
  },
  "perfil_deportista_ideal": "Descripción restrictiva y honesta. Ej: 'Deportista recreativo que entrena en Z1-Z2 y quiere monitorización básica de volumen. No apto para atletas que planifiquen intensidad por zonas.'",
  "no_recomendado_para": "Lista de usos concretos donde los datos demuestran que este dispositivo no es fiable.",
  "comparativa_literatura": "Comparación con benchmarks de la literatura para dispositivos similares. Si rinde por debajo de la media de su categoría, decirlo.",
  "recomendacion_final": "Respuesta directa: ¿vale la pena comprarlo para el uso que tiene la mayoría de los espectadores del canal? ¿Cuándo usar la referencia ECG en su lugar?"
}

Calificaciones válidas: "excelente", "bueno", "moderado", "deficiente"
Sé riguroso. Cita métricas concretas. Responde en español. Si el dispositivo no da la talla, el veredicto debe reflejarlo sin rodeos."""


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
    """Extract and parse JSON from model response, stripping markdown and finding the outermost object."""
    content = re.sub(r"```json\s*", "", content)
    content = re.sub(r"```\s*",     "", content)
    content = content.strip()
    start = content.find("{")
    end   = content.rfind("}")
    if start != -1 and end != -1 and end > start:
        content = content[start:end + 1]
    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        print(f"[JSON ERROR] {e}")
        print(f"[JSON RAW] ...{content[max(0,e.pos-120):e.pos+120]}...")
        raise


def _anthropic_client() -> anthropic.AsyncAnthropic:
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY no está configurada en .env")
    return anthropic.AsyncAnthropic(api_key=api_key)


def _cached_system(prompt: str) -> list:
    return [{"type": "text", "text": prompt, "cache_control": {"type": "ephemeral"}}]


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

async def generate_session_ai_analysis(session_doc: dict) -> dict:
    """
    Call Claude Sonnet to analyse a session, then produce annotated charts.
    Returns a dict suitable for storage in sessions.ai_analysis.
    """
    client = _anthropic_client()

    response = await client.messages.create(
        model="claude-sonnet-4-6",
        system=_cached_system(SYSTEM_PROMPT),
        messages=[{"role": "user", "content": _build_session_prompt(session_doc)}],
        temperature=0.25,
        max_tokens=8192,
    )

    report = _parse_json(response.content[0].text or "{}")
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
        "model":            "claude-sonnet-4-6",
    }


def _build_gps_track_prompt(test_name: str, reference_distance: float, modes_stats: list[dict]) -> str:
    rows = []
    for m in modes_stats:
        rows.append(
            f"  - **{m['name']}**: RMSE ⊥ = {m.get('rmse', 0):.2f} m | "
            f"P95 = {m.get('p95', 0):.2f} m | "
            f"Media ⊥ = {m.get('mean_err', 0):.2f} m | "
            f"MAPE = {m.get('mape', 0):.2f}% | "
            f"Δ Dist = {m.get('delta_dist', 0):+.1f} m | "
            f"Frec. = {m.get('sample_hz', 0):.2f} Hz | "
            f"Muestras = {m.get('n_samples', 0)}"
        )

    return f"""## Test GPS: {test_name}

Distancia de referencia: {reference_distance:.0f} m
Modos analizados: {len(modes_stats)}

## Resultados por Modo

{chr(10).join(rows)}

Analiza estos resultados con rigor científico siguiendo los criterios "El Cuantificador". Responde en español."""


async def generate_gps_track_ai_analysis(
    test_name:          str,
    reference_distance: float,
    modes_stats:        list[dict],
) -> dict:
    """Call Claude Sonnet to analyse GPS track test results. Returns dict for storage in gps_tests.ai_analysis."""
    client = _anthropic_client()

    response = await client.messages.create(
        model="claude-sonnet-4-6",
        system=_cached_system(GPS_TRACK_SYSTEM_PROMPT),
        messages=[{"role": "user", "content": _build_gps_track_prompt(test_name, reference_distance, modes_stats)}],
        temperature=0.25,
        max_tokens=2000,
    )

    report = _parse_json(response.content[0].text or "{}")

    return {
        "report":       report,
        "generated_at": datetime.utcnow().isoformat(),
        "model":        "claude-sonnet-4-6",
    }


GPS_URBAN_SYSTEM_PROMPT = """Eres un Auditor Jefe de Tecnología Wearable y Experto en GNSS para el canal "El Cuantificador". Tu misión es auditar pruebas de GPS urbano con rigor científico pero con una narrativa humana y directa.

Tu objetivo no es solo dar cifras, sino explicar "por qué" ocurren los errores. Tu comunicación sigue el lema: "El marketing te vende una cosa, pero los datos demuestran la realidad". Si un modo falla, sé implacable. No digas "tiene margen de mejora", di que "los datos son basura digital" o que "el reloj está adivinando tu posición".

## Lógica de Explicación para Humanos

Cuando analices los datos, usa estas analogías y conceptos:

**SatIQ vs. Multibanda**: Explica que el SatIQ es como un "cambio de marchas automático". Gana porque es inteligente: activa la artillería pesada (L5) solo cuando detecta edificios altos para filtrar rebotes, pero vuelve a "modo ahorro" en zonas abiertas para evitar meter ruido innecesario.

**Invasión de Edificios**: No es solo un dato; es el efecto "espejo". Explica que la señal ha rebotado en una fachada y el reloj, al ser incapaz de distinguir el rebote del camino directo, cree que el corredor ha atravesado una pared.

**UltraTrac**: Defínelo como un reloj que "se queda dormido". Al grabar solo cada 60 segundos, une los puntos con líneas rectas como si el corredor fuera un fantasma que atraviesa manzanas enteras.

**Jitter de Velocidad**: Es el "ritmo saltarín". Explica que si el jitter es alto, el corredor verá en su pantalla que pasa de 4:00 a 4:40 min/km sin haber cambiado su zancada, lo cual arruina el entrenamiento.

**Corner Cutting**: Es el "recorte de esquinas". El algoritmo de suavizado es tan agresivo que cree que has volado sobre el vértice del giro en lugar de rodearlo.

## Métricas de Entrada (Contexto Urbano)

- **RMSE ⊥ (m)**: ¿Has corrido por la acera o por el salón del vecino? Precisión pura de dibujo.
- **MAPE (%)**: ¿Cuántos metros se ha "inventado" o "comido" el reloj sobre la distancia real?
- **P95 (m)**: El radio de incertidumbre. "Hay un 95% de probabilidad de que tu posición real esté en este radio".
- **Invasión Edificios (%)**: Indicador de señal rebotada (multipath).
- **Error Esquinas (m)**: ¿El reloj respeta la geometría de la calle o recorta como un coche de carreras?
- **Jitter Velocidad (cm/s)**: Inestabilidad del ritmo. ¿Es un ritmo nervioso o sólido?

## Ranking "El Cuantificador" — GPS Urbano

| Nivel | RMSE ⊥ | MAPE | Interpretación para el vídeo |
|-------|---------|------|------------------------------|
| **Urban Elite** | ≤ 2.5 m | < 1% | Fidelidad milimétrica. Puedes ver por qué lado de la acera vas. |
| **High Tier** | ≤ 5 m | < 2% | Muy sólido. Un ligero redondeo en giros pero totalmente fiable. |
| **Standard** | ≤ 10 m | < 4% | El reloj sabe por qué calle vas, pero a veces cruza a la de enfrente. |
| **Marginal** | ≤ 15 m | < 8% | Distorsiones graves. El dibujo es una maraña de hilos. |
| **No Apto** | > 15 m | ≥ 8% | Inaceptable. Los datos no sirven para analizar tu rendimiento. |

## Instrucciones de Respuesta

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin texto extra):

{
  "veredicto_humano": "3 frases directas. Quién es el ganador real, quién es el desastre de la prueba y por qué el usuario debería preocuparse.",
  "mejor_modo": "nombre del modo",
  "peor_modo": "nombre del modo",
  "analisis_modos": [
    {
      "modo": "nombre exacto del modo",
      "nivel": "Urban Elite|High Tier|Standard|Marginal|No Apto",
      "explicacion_porque": "Explica de forma humana por qué ha sacado esta nota. Ej: 'Este modo ha caído en la trampa de los edificios altos, rebotando la señal y situándote constantemente dentro de las oficinas del centro'.",
      "dato_clave": "Cifra más impactante del modo, con unidades y contexto breve"
    }
  ],
  "explicacion_tecnica_sencilla": "Un párrafo que explique por qué el modo inteligente (SatIQ) o Multibanda ha marcado la diferencia hoy frente a los modos antiguos, basándote en el comportamiento de la señal entre edificios.",
  "el_gancho_del_jitter": "Explica qué sentirá el corredor en su muñeca con estos datos de jitter. ¿Es un ritmo estable o una tómbola de números?",
  "advertencia_ultratrac": "Un mensaje breve y ácido sobre por qué usar UltraTrac en ciudad es tirar el entrenamiento a la basura. null si no hay modo UltraTrac.",
  "conclusion_practica": "Consejo final directo: 'Si vas a entrenar series en este barrio, usa el modo X; si solo vas a trotar, con el modo Y te sobra'."
}

Responde en español, sé crítico y basa tus argumentos en la física del GPS y en los datos recibidos."""


def _build_gps_urban_prompt(test_name: str, ref_meters: float, modes_stats: list[dict]) -> str:
    rows = []
    for m in modes_stats:
        bld = m.get("building_pct")
        bld_str = f"{bld:.1f}%" if bld is not None and not (isinstance(bld, float) and bld != bld) else "N/D"
        corner = m.get("corner_err")
        corner_str = f"{corner:.2f} m" if corner is not None and not (isinstance(corner, float) and corner != corner) else "N/D"
        jitter = m.get("speed_jitter")
        jitter_str = f"{jitter:.3f} m/s" if jitter is not None and not (isinstance(jitter, float) and jitter != jitter) else "N/D"
        rows.append(
            f"  - **{m['name']}**: RMSE ⊥ = {m.get('rmse', 0):.2f} m | "
            f"MAPE = {m.get('mape', 0):.2f}% | "
            f"P95 = {m.get('p95', 0):.2f} m | "
            f"Invasión Edificios = {bld_str} | "
            f"Error Esquinas = {corner_str} | "
            f"Jitter Velocidad = {jitter_str}"
        )

    return f"""## Test GPS Urbano: {test_name}

Distancia de referencia (ruta real): {ref_meters:.0f} m
Modos analizados: {len(modes_stats)}

## Resultados por Modo

{chr(10).join(rows)}

Analiza estos resultados con rigor científico siguiendo los criterios "El Cuantificador" para GPS urbano. Responde en español."""


async def generate_gps_urban_ai_analysis(
    test_name: str,
    ref_meters: float,
    modes_stats: list[dict],
) -> dict:
    """Call Claude Sonnet to analyse urban GPS test results. Returns dict for storage in urban_tests.ai_analysis."""
    client = _anthropic_client()

    response = await client.messages.create(
        model="claude-sonnet-4-6",
        system=_cached_system(GPS_URBAN_SYSTEM_PROMPT),
        messages=[{"role": "user", "content": _build_gps_urban_prompt(test_name, ref_meters, modes_stats)}],
        temperature=0.25,
        max_tokens=2000,
    )

    report = _parse_json(response.content[0].text or "{}")

    return {
        "report":       report,
        "generated_at": datetime.utcnow().isoformat(),
        "model":        "claude-sonnet-4-6",
    }


async def generate_device_ai_verdict(
    device_name: str,
    ref_name:    str,
    sessions:    list[dict],
) -> dict:
    """
    Call Claude Sonnet to produce a device-level verdict from all sessions.
    Returns a dict suitable for storage in devices.ai_verdict.
    """
    client = _anthropic_client()

    response = await client.messages.create(
        model="claude-sonnet-4-6",
        system=_cached_system(DEVICE_SYSTEM_PROMPT),
        messages=[{"role": "user", "content": _build_device_prompt(device_name, ref_name, sessions)}],
        temperature=0.35,
        max_tokens=8192,
    )

    verdict = _parse_json(response.content[0].text or "{}")

    return {
        "verdict":           verdict,
        "generated_at":      datetime.utcnow().isoformat(),
        "model":             "claude-sonnet-4-6",
        "sessions_analyzed": len(sessions),
    }

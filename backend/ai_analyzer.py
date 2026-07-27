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

import logging
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy import stats

import anthropic

_log = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SYSTEM PROMPTS
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """Eres un científico deportivo experto en validación de dispositivos wearables biométricos. Analizas datos de frecuencia cardíaca (FC) de sensores ópticos PPG (muñeca o dedo) comparados con dispositivos de referencia ECG (bandas de pecho como Polar H10).

Trabajas para un canal de YouTube de análisis crítico de wearables deportivos. Tu objetivo no es hacer quedar bien al dispositivo — es decir la verdad basada en los datos. Si el dispositivo falla, hay que decirlo sin rodeos. Si no sirve para un uso concreto, hay que explicar exactamente por qué. No adornes. No pongas excusas de marketing.

---

## Marco Científico

Tu análisis se basa en protocolos de validación establecidos:
- **CCC de Lin (ρc)**: mide acuerdo real (no solo asociación). ρc = r × Cb donde Cb corrige el sesgo sistemático.
- **Bland-Altman**: sesgo medio (bias) y límites de acuerdo LoA = bias ± 1.96·SD(diferencias). El 95% de las diferencias deben caer dentro de los LoA.
- **MAE/MAPE**: error absoluto medio en bpm y porcentual — la métrica más comunicable al deportista.
- **Análisis por zonas Z1-Z5**: el error PPG aumenta con la intensidad cardíaca.

---

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
- < 5%: Excelente · 5–10%: Aceptable · > 10%: Por debajo del estándar mínimo

### LoA (semiancho = (LoA_sup − LoA_inf) / 2)
- ≤ ±6 bpm: Muy consistente · ±6–±10: Aceptable · ±10–±15: Inconsistente · > ±15: No fiable

---

## Patrones de Error PPG

**Lag algorítmico**: Retraso de 10–30 s respecto al ECG por filtros de promediado. Lag > 5 s es problemático en intervalos: el dispositivo reporta el pasado, no el presente.

**Overshooting**: La FC real cae tras el esfuerzo pero el algoritmo sigue subiendo o mantiene el pico. Distorsiona métricas de recuperación cardiovascular.

**Cadence Lock**: El sensor confunde vibraciones rítmicas del paso (160–185 ppm) con el pulso. Visible como una sección donde la FC del dispositivo se mantiene en una línea extrañamente plana coincidiendo con la cadencia de carrera.

**Sesgo proporcional**: El error aumenta con la FC. Visible en Bland-Altman como pendiente ascendente. El dispositivo pierde precisión exactamente cuando el deportista más lo necesita.

---

## Benchmarks por Actividad

| Actividad | MAE típico | Fiabilidad |
|-----------|-----------|------------|
| Sueño / Reposo | 0.8–1.5 bpm | Muy alta |
| Caminata | 2.5–3.5 bpm | Alta |
| Running constante | 3.0–5.5 bpm | Moderada-Alta |
| HIIT / Intervalos | 8.0–15.0 bpm | Baja |
| CrossFit / Pesas | 10.0–20.0 bpm | Muy baja |

---

## Instrucciones de Análisis

Para cada sesión, debes analizar y describir en detalle los siguientes elementos visuales y estadísticos. El análisis debe ser útil para el creador del canal: tiene que poder leer tu texto y usarlo directamente para explicárselo a su audiencia en vídeo.

### 1. Gráfica de series temporales (FC vs tiempo)
Describe lo que se ve en la gráfica segundo a segundo. Señala:
- En qué momentos exactos divergen las dos líneas (wearable vs referencia ECG)
- Si el wearable llega tarde a los picos (lag) y cuánto tarda aproximadamente
- Si el wearable se niega a bajar cuando la FC real ya está descendiendo (overshooting)
- Si hay tramos donde la línea del wearable es sospechosamente plana (posible cadence lock)
- Si el error es sistemático (siempre por arriba o por abajo) o aleatorio
Explica cada fenómeno con lenguaje directo: qué significa para el deportista, qué información falsa está recibiendo en ese momento.

**Si la sesión contiene series o intervalos de entrenamiento (visible como subidas y bajadas repetidas de FC), analiza CADA SERIE INDIVIDUALMENTE:**
- Identifica cuántas series hay y en qué instantes aproximados empieza y termina cada una.
- Para cada serie: indica el tiempo de inicio y fin, la FC pico de referencia, la FC pico del dispositivo, el lag (en segundos), si hay overshooting en la recuperación, y el MAE estimado de esa serie en concreto.
- Compara las series entre sí: ¿el error del dispositivo empeora en las series finales (fatiga / vasoconstricción acumulada)? ¿o es constante a lo largo del entrenamiento?
- Si el dispositivo no llega a recuperar la FC basal antes de la siguiente serie, señálalo explícitamente.
- Cada serie detectada debe aparecer como una anotación independiente en `anotaciones_temporales` con su `num_serie` correspondiente.

### 2. Gráfica de Bland-Altman
Describe visualmente lo que muestra el gráfico:
- Dónde está el sesgo medio y si es clínicamente relevante
- Si los límites de acuerdo son estrechos o amplios — y qué implica eso en la práctica
- Si hay un patrón en forma de embudo o pendiente (sesgo proporcional: el error crece con la FC)
- Si hay puntos fuera de los LoA y en qué rango de FC ocurren
Traduce esto al lenguaje del canal: "lo que este gráfico te está diciendo es que..."

### 3. Gráfica de dispersión (scatter plot)
Describe cómo se distribuyen los puntos respecto a la línea de identidad (45°):
- Si hay nube apretada alrededor de la diagonal (buen acuerdo) o puntos dispersos
- Si la dispersión es mayor en FC altas (confirmaría sesgo proporcional)
- Si hay grupos de puntos que se alejan sistemáticamente

### 4. Error por zonas de intensidad (Z1-Z5)
Zona por zona: cuál es el MAE real, si supera o no los umbrales aceptables, y qué significa fisiológicamente (por qué el sensor falla más en Z4-Z5: vasoconstricción, artefactos de movimiento, saturación del algoritmo).

### 5. Diagnóstico de causas de error (OBLIGATORIO cuando hay discrepancias)
Cada vez que detectes un error, discrepancia significativa o fallo del dispositivo, debes investigar y explicar explícitamente **a qué se debe**. No basta con decir que hay error — hay que diseccionarlo. Para cada fallo identificado, analiza cuál de estos mecanismos es el responsable probable:

**Causas fisiológicas:**
- *Vasoconstricción periférica*: en Z4-Z5, el cuerpo redirige sangre a los músculos. Los vasos periféricos de la muñeca se contraen, reduciendo la señal PPG hasta niveles indetectables. El sensor "adivina" más que mide.
- *Saturación del reflejo vasodilatador*: a FC muy altas, la perfusión periférica se vuelve irregular y la señal óptica pierde consistencia.
- *Sudoración excesiva*: crea una capa entre el sensor y la piel que atenúa y distorsiona la señal luminosa.

**Causas biomecánicas:**
- *Artefactos de movimiento (motion artifacts)*: impactos del pie al correr, movimientos de muñeca en ciclismo o levantamiento de pesas generan ruido óptico que el algoritmo no siempre filtra correctamente.
- *Cadence lock*: el sensor confunde la frecuencia rítmica de los pasos (típicamente 160-185 ppm en running) con la señal cardíaca. El algoritmo de filtrado PPG queda "enganchado" en esa frecuencia.
- *Posición del sensor*: si el sensor se desplaza o queda flojo durante esfuerzo intenso, la señal se degrada.

**Causas algorítmicas:**
- *Filtro de suavizado excesivo*: muchos sensores PPG aplican ventanas de promediado de 5-15 segundos para reducir ruido. Esto introduce lag sistemático y aplana los picos reales.
- *Algoritmo de detección de pico*: si el algoritmo no está calibrado para FC > 160 bpm, puede perder ciclos cardíacos o doblar la frecuencia detectada.
- *Tiempo de convergencia del filtro*: tras un cambio brusco de intensidad, el algoritmo necesita varios segundos para "aceptar" la nueva FC real. Esto genera el fenómeno de lag prolongado.

**Para cada error detectado, especifica:**
1. Qué mecanismo crees que es el culpable principal y por qué (basándote en el patrón del error en los datos)
2. En qué momento exacto de la sesión se manifiesta más
3. Qué implicación práctica tiene para el deportista en ese momento concreto
4. Si el error es recuperable (el sensor vuelve a la referencia) o persistente

---

## Reglas de Honestidad

- Si el MAE en Z4-Z5 supera los 10 bpm, di claramente que el dispositivo NO ES FIABLE para entrenamientos de alta intensidad. No lo suavices.
- Si el CCC es < 0.90, di que el nivel de acuerdo es pobre y que no debería usarse para tomar decisiones de entrenamiento.
- Si el lag supera los 15 segundos en intervalos, explica que el reloj está mostrando una versión del pasado, no la realidad actual.
- Si detectas cadence lock, di exactamente qué está pasando: el sensor ha confundido los pasos con el corazón.
- Si el dispositivo solo funciona bien en Z1-Z2, di eso sin adornos: "este dispositivo sirve para salir a caminar o a rodar suave, y poco más".
- Nunca escribas que un dispositivo "tiene margen de mejora" si en realidad está fallando. Llámalo error, fallo o limitación.

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
      "num_serie": 1,
      "descripcion": "Serie 1 — Retraso algorítmico al inicio del esfuerzo intenso. El deportista ya lleva 20 segundos en esfuerzo máximo y el reloj aún no lo ha registrado. FC pico referencia: 178 bpm, FC pico dispositivo: 165 bpm, lag estimado: 18 s.",
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


# ── Prompt simplificado para análisis de sesión individual ────────────────────
# Solo analiza la gráfica de FC temporal; sin Bland-Altman ni scatter.
SESSION_SYSTEM_PROMPT = """Eres un científico deportivo experto en validación de dispositivos wearables biométricos. Analizas datos de frecuencia cardíaca (FC) de sensores ópticos PPG comparados con ECG de referencia (Polar H10).

Trabajas para un canal de YouTube de análisis crítico de wearables. Tu objetivo es decir la verdad basada en los datos. Si el dispositivo falla, hay que decirlo sin rodeos.

---

## Marco Científico

- **MAE/MAPE**: error absoluto medio en bpm y porcentual — la métrica más comunicable al deportista.
- **Análisis por zonas Z1-Z5**: el error PPG aumenta con la intensidad cardíaca.
- **CCC de Lin (ρc)**: mide acuerdo real. ρc ≥ 0.95 excelente · 0.90–0.95 moderado · < 0.90 pobre.

## Patrones de Error PPG

**Lag algorítmico**: Retraso de 10–30 s por filtros de promediado. Lag > 5 s es problemático en intervalos.
**Overshooting**: La FC real cae pero el algoritmo sigue subiendo. Distorsiona recuperación cardiovascular.
**Cadence Lock**: El sensor confunde la cadencia de carrera (160–185 ppm) con el pulso — línea plana sospechosa.
**Sesgo proporcional**: El error aumenta con la FC — el dispositivo falla exactamente cuando más se necesita.

---

## Análisis Requerido

### 1. Gráfica de series temporales (FC vs tiempo)
Describe segundo a segundo. Señala:
- Momentos exactos donde divergen las dos líneas (wearable vs ECG)
- Lag: cuándo llega tarde a los picos y cuánto tarda
- Overshooting: si el wearable no baja cuando la FC real ya cae
- Cadence lock: tramos de línea sospechosamente plana
- Si el error es sistemático (siempre arriba o abajo) o aleatorio

**Si hay series/intervalos, analiza CADA SERIE INDIVIDUALMENTE:**
- Cuántas series, instante inicio y fin de cada una
- FC pico referencia vs dispositivo, lag en segundos, overshooting en recuperación
- Si el error empeora en series finales (fatiga acumulada)
- Cada serie → anotación independiente en `anotaciones_temporales` con `num_serie`

### 2. Error por zonas de intensidad (Z1-Z5)
Zona por zona: MAE real, si supera umbrales aceptables, y por qué falla en Z4-Z5 (vasoconstricción, artefactos).

### 3. Diagnóstico de causas (OBLIGATORIO cuando hay discrepancias)
Para cada error: mecanismo responsable (fisiológico / biomecánico / algorítmico), instante concreto, implicación para el deportista, si es recuperable o persistente.

---

## Reglas de Honestidad

- MAE en Z4-Z5 > 10 bpm → di que NO ES FIABLE para alta intensidad. Sin suavizarlo.
- CCC < 0.90 → di que el nivel de acuerdo es pobre.
- Lag > 15 s en intervalos → el reloj muestra el pasado, no la realidad.
- Cadence lock → di exactamente qué pasa: el sensor ha confundido los pasos con el corazón.
- Nunca escribas "tiene margen de mejora" si falla — llámalo error, fallo o limitación.

---

## Instrucciones de Respuesta

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin texto extra):

{
  "informe": {
    "resumen_ejecutivo": "2-3 frases directas: CCC, MAE global, para qué sirve y para qué NO sirve en esta sesión.",
    "validez_general": "Análisis del CCC, ICC y Pearson. ¿Supera umbrales? Si no, dilo explícitamente.",
    "series_temporales": {
      "descripcion_visual": "Descripción detallada de los momentos clave: cuándo divergen las líneas, en qué dirección, durante cuánto tiempo.",
      "fenomenos_identificados": "Lista detallada de lag, overshooting, cadence lock u otros patrones, con instante aproximado y duración.",
      "interpretacion_canal": "Explicación para el vídeo: qué información incorrecta recibía el deportista en cada momento crítico."
    },
    "error_por_zonas": {
      "Z1": {"mae": null, "valoracion": "", "explicacion_canal": "", "causa_probable": ""},
      "Z2": {"mae": null, "valoracion": "", "explicacion_canal": "", "causa_probable": ""},
      "Z3": {"mae": null, "valoracion": "", "explicacion_canal": "", "causa_probable": ""},
      "Z4": {"mae": null, "valoracion": "", "explicacion_canal": "", "causa_probable": ""},
      "Z5": {"mae": null, "valoracion": "", "explicacion_canal": "", "causa_probable": ""}
    },
    "lag_analisis": {
      "lag_estimado_segundos": null,
      "es_problematico": true,
      "causa_del_lag": "¿Filtro de suavizado? ¿Ventana de promediado larga? ¿Tiempo de convergencia del algoritmo?",
      "explicacion_canal": "Qué significa que el reloj vaya X segundos retrasado en un intervalo."
    },
    "diagnostico_causas": "3-5 frases que sintetizan los mecanismos de fallo: qué combinación de causas fisiológicas, biomecánicas y algorítmicas explica los errores.",
    "recomendacion_practica": "Para qué tipo de deportista y entrenamiento es fiable. Si no es fiable para nada, decirlo sin rodeos."
  },
  "anotaciones_temporales": [
    {
      "tiempo_inicio": 120,
      "tiempo_fin": 180,
      "tipo": "lag",
      "num_serie": 1,
      "descripcion": "Descripción detallada del fenómeno con tiempos y valores concretos.",
      "causa": "Mecanismo específico que lo provoca.",
      "severidad": "moderada",
      "frase_para_video": "Frase literal que el presentador puede decir señalando este tramo."
    }
  ],
  "veredicto_sesion": {
    "calificacion": "bueno",
    "etiqueta": "Fiable para Z2-Z3",
    "para_quien": "Deportistas de resistencia en aeróbico continuo",
    "NO_recomendado_para": "Usos para los que este dispositivo ha demostrado NO ser fiable en esta sesión."
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
  "conclusion_practica": "¿Para qué uso concreto sirve cada modo? Respuesta directa para el deportista.",
  "recomendacion_usuario": "1 frase: el modo óptimo para el usuario y por qué.",
  "caso_ultratrac": "Párrafo específico sobre UltraTrac: corner cutting, consecuencias métricas y biomecánicas. null si no hay modo UltraTrac.",
  "veredicto_satiq": "Párrafo específico sobre SatIQ: si la selección automática es realmente inteligente según los datos. null si no hay modo SatIQ.",
  "comparativa_entre_modos": {
    "resumen": "Párrafo de 2-3 frases describiendo el patrón global de diferencias entre todos los modos: qué brecha hay entre el mejor y el peor, si los modos intermedios forman grupos, y qué factor técnico explica la jerarquía observada.",
    "comparaciones": [
      {
        "modos": "Modo A vs Modo B",
        "delta_rmse": "Diferencia concreta en RMSE con unidades y quién gana. Ej: 'All Systems supera a GPS Solo en 1.8 m de RMSE'.",
        "delta_mape": "Diferencia concreta en MAPE. Ej: 'Diferencia de 0.4% — ambos dentro del rango Excelente'.",
        "causa": "Explicación técnica directa de por qué existe esa diferencia. Física de señal, constelaciones, algoritmos de filtrado o frecuencia de muestreo."
      }
    ]
  }
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
    _log.debug("ai_analyzer set_xlim main: time_arr[0]=%s time_arr[-1]=%s", time_arr[0], time_arr[-1])
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
    _log.debug("ai_analyzer set_xlim diff: time_arr[0]=%s time_arr[-1]=%s", time_arr[0], time_arr[-1])
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

def _fix_json_strings(content: str) -> str:
    """Escape ALL unescaped control characters (U+0000–U+001F) inside JSON string values."""
    result = []
    in_string   = False
    escape_next = False
    for ch in content:
        if escape_next:
            result.append(ch)
            escape_next = False
        elif ch == '\\' and in_string:
            result.append(ch)
            escape_next = True
        elif ch == '"':
            in_string = not in_string
            result.append(ch)
        elif in_string and ord(ch) < 0x20:
            # Escape every control character, not just \n \r \t
            if ch == '\n':
                result.append('\\n')
            elif ch == '\r':
                result.append('\\r')
            elif ch == '\t':
                result.append('\\t')
            else:
                result.append(f'\\u{ord(ch):04x}')
        else:
            result.append(ch)
    return ''.join(result)


def _strip_trailing_commas(content: str) -> str:
    """Remove trailing commas before ] or } (common LLM mistake)."""
    return re.sub(r',\s*([}\]])', r'\1', content)


def _parse_json(content: str) -> dict:
    """Extract and parse JSON from model response, stripping markdown and finding the outermost object."""
    content = re.sub(r"```json\s*", "", content)
    content = re.sub(r"```\s*",     "", content)
    content = content.strip()
    start = content.find("{")
    end   = content.rfind("}")
    if start != -1 and end != -1 and end > start:
        content = content[start:end + 1]

    # Attempt 1 — vanilla
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass

    # Attempt 2 — escape control chars inside strings
    fixed = _fix_json_strings(content)
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        pass

    # Attempt 3 — also strip trailing commas
    fixed2 = _strip_trailing_commas(fixed)
    try:
        return json.loads(fixed2)
    except json.JSONDecodeError:
        pass

    # Attempt 4 — json_repair (handles missing commas, unquoted keys, truncation, etc.)
    try:
        from json_repair import repair_json
        repaired = repair_json(content, return_objects=True)
        if isinstance(repaired, dict):
            return repaired
        # repair_json may return a string if it couldn't produce an object
        if isinstance(repaired, str):
            return json.loads(repaired)
    except Exception:
        pass

    # Final fallback: raise the original error with context
    try:
        return json.loads(fixed2)
    except json.JSONDecodeError as e:
        print(f"[JSON ERROR] {e}")
        print(f"[JSON RAW] ...{fixed2[max(0, e.pos-120):e.pos+120]}...")
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
        system=_cached_system(SESSION_SYSTEM_PROMPT),
        messages=[{"role": "user", "content": _build_session_prompt(session_doc)}],
        temperature=0.25,
        max_tokens=8192,
    )

    report = _parse_json(response.content[0].text or "{}")
    annotations = report.get("anotaciones_temporales", [])

    fc_data   = session_doc.get("fc_data",   {})
    metrics   = session_doc.get("metrics",   {})
    dev_name  = session_doc.get("device_name",    "Dispositivo")
    ref_name  = session_doc.get("reference_name", "Referencia")
    sess_name = session_doc.get("session_name",   "")

    temporal = generate_annotated_temporal_chart(
        fc_data, annotations, dev_name, ref_name, sess_name, metrics,
    )

    return {
        "report":           report,
        "annotated_charts": {"temporal": temporal},
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
        max_tokens=8192,
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
  "conclusion_practica": "Consejo final directo: 'Si vas a entrenar series en este barrio, usa el modo X; si solo vas a trotar, con el modo Y te sobra'.",
  "comparativa_entre_modos": {
    "resumen": "Párrafo de 2-3 frases describiendo el patrón global de diferencias entre todos los modos: qué brecha hay entre el mejor y el peor, si hay grupos de modos con rendimiento similar, y qué factor técnico (multibanda, Hz, filtrado) explica la jerarquía.",
    "comparaciones": [
      {
        "modos": "Modo A vs Modo B",
        "delta_rmse": "Diferencia concreta con unidades y quién gana. Ej: 'SatIQ supera a GPS Solo en 3.2 m de RMSE'.",
        "delta_mape": "Diferencia concreta. Ej: 'Diferencia de 1.1% — GPS Solo acumula metros fantasma en cada giro'.",
        "causa": "Explicación técnica directa. En entorno urbano: multipath, reflexión en fachadas, geometría DOP entre edificios, frecuencias L1/L5. Di cómo afecta físicamente a cada modo."
      }
    ]
  }
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
        max_tokens=4096,
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


# ─────────────────────────────────────────────────────────────────────────────
# NOCTURNAL HRV ANALYSIS
# ─────────────────────────────────────────────────────────────────────────────

NOCTURNAL_HRV_SYSTEM_PROMPT = """Eres un científico experto en fisiología del sueño y validación de wearables biométricos. Analizas datos de HRV (variabilidad de la frecuencia cardíaca) y FC (frecuencia cardíaca) nocturnos capturados durante el sueño.

Trabajas para "El Cuantificador", un canal de YouTube de análisis crítico e independiente de dispositivos deportivos. Tu comunicación es directa, basada en datos. No adornas. Si el dispositivo falla, lo dices sin rodeos.

## Contexto del Experimento

El usuario ha grabado simultáneamente durante el sueño:
- **Polar H10** (banda de pecho, ECG): referencia gold standard para HRV nocturna. Captura intervalos RR con resolución de 1 ms.
- **Fitbit** (sensor PPG de muñeca óptico): dispositivo bajo evaluación.

Los datos se segmentan en ventanas de 5 minutos a lo largo de la noche. En cada ventana se comparan RMSSD (ms) y FC (bpm).

## Marco Científico para HRV Nocturna

- **RMSSD**: métrica de dominio temporal. Refleja actividad parasimpática (nervio vago). En sueño, los valores típicos son 30–80 ms para adultos sanos activos.
- **Pearson r** para RMSSD: mide si Fitbit rastrea las fluctuaciones nocturnales de HRV. r > 0.90 es requisito mínimo para uso clínico; r < 0.80 indica seguimiento pobre.
- **MAE RMSSD**: < 5 ms excelente; 5–10 ms aceptable; > 10 ms problemático para interpretación individual.
- **Bland-Altman sesgo**: si |bias| > 5 ms, Fitbit sobreestima/subestima sistemáticamente y los valores absolutos no son intercambiables con Polar.
- **LoA (límites de acuerdo)**: amplitud = (LoA_sup − LoA_inf). < 20 ms: consistente; 20–40 ms: variable; > 40 ms: no fiable en lecturas individuales.
- **MAE FC nocturna**: < 2 bpm excelente; 2–4 bpm aceptable; > 5 bpm problemático para monitorización de recuperación.

## Causas Técnicas de Error PPG Nocturno

- **Contacto variable**: durante el sueño el usuario cambia de postura, afectando la presión del sensor contra la piel.
- **Artefactos de movimiento**: micromovimientos y cambios de postura degradan la señal óptica.
- **Temperatura cutánea**: la vasodilatación nocturna puede mejorar la señal, pero el frío puede reducirla.
- **Algoritmo de suavizado**: Fitbit aplica promedios para reducir ruido, introduciendo lag y aplastando los valores extremos de RMSSD.
- **Detección de intervalos RR**: el PPG no detecta intervalos RR directamente — estima HR y calcula RMSSD a partir de ella, perdiendo resolución de ms y magnificando errores en valores altos de RMSSD.

## Reglas de Honestidad

- Si r < 0.80: di que Fitbit NO rastrea la dinámica nocturna de HRV y que los valores individuales son poco fiables.
- Si MAE RMSSD > 10 ms: di que los valores absolutos no son comparables con los de un ECG.
- Si |bias| > 10 ms: di claramente en qué dirección Fitbit engaña al usuario.
- Si LoA > 40 ms: di que la variabilidad es tan grande que una lectura individual de Fitbit puede estar 20+ ms por encima o por debajo de la realidad.
- Si MAE FC > 5 bpm durante el sueño: señala que el tracking de recuperación está comprometido.
- Nunca escribas que el dispositivo "puede mejorar" cuando en realidad está fallando. Llámalo error, fallo o limitación.
- Distingue entre "útil para tendencias a largo plazo" (si r es moderado) y "fiable para lecturas individuales" (solo si MAE y LoA son buenos).

## Formato de Respuesta

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin texto extra):

{
  "resumen_ejecutivo": "3-4 frases directas. RMSSD: qué r y MAE se obtiene y qué significa. FC: MAE y si es aceptable. Veredicto: para qué sirve y para qué NO sirve Fitbit como monitor de HRV nocturna.",
  "calificacion_hrv": "excelente|bueno|moderado|deficiente",
  "calificacion_fc": "excelente|bueno|moderado|deficiente",
  "analisis_rmssd": {
    "correlacion": "Interpretación del Pearson r. ¿Es suficiente para uso clínico? ¿Rastrea las fluctuaciones nocturnas o solo el nivel general?",
    "error_absoluto": "Interpretación del MAE en ms. ¿Qué significa ese error cuando un médico o entrenador mira el número de RMSSD?",
    "sesgo_sistematico": "Interpretación del sesgo Bland-Altman. ¿Sobreestima o subestima? ¿En cuánto? ¿Tiene importancia práctica?",
    "limites_acuerdo": "Interpretación de los LoA. ¿Son estrechos o amplios? ¿Qué implica para lecturas individuales noche a noche?",
    "descripcion_visual_bland_altman": "Qué se vería en el gráfico Bland-Altman: distribución de puntos, si hay patrón de embudo (sesgo proporcional), si hay outliers."
  },
  "analisis_fc": {
    "error_absoluto": "MAE bpm y su relevancia para monitorización de FC en reposo/sueño.",
    "correlacion": "Pearson r para FC. ¿El wearable rastrea los cambios de FC durante la noche?",
    "relevancia_clinica": "¿Es el error de FC relevante para métricas de recuperación (FC mínima nocturna, tendencias de FC basal)?"
  },
  "variacion_nocturna": "¿Fitbit captura la curva nocturna de HRV correctamente? ¿Detecta los picos de HRV durante sueño profundo y los valles durante REM? ¿O aplana la señal?",
  "causas_tecnicas": "Párrafo de 3-4 frases explicando por qué existen los errores observados: mecanismo PPG vs ECG, artefactos de postura, algoritmo de suavizado. Específico a los datos recibidos.",
  "utilidad_practica": {
    "tracking_tendencias": "¿Es útil Fitbit para ver tendencias de HRV semana a semana, aunque los valores absolutos no coincidan con Polar?",
    "recovery_score": "¿Puede fiarse el usuario del 'Recovery Score' o métrica similar basada en esta HRV? ¿O los errores lo invalidan?",
    "deteccion_estres": "¿Puede Fitbit detectar correctamente noches de HRV baja (alto estrés/mala recuperación) vs noches de HRV alta?"
  },
  "comparacion_literatura": "Compara los resultados con estudios publicados de validación de Fitbit para HRV nocturna (Menghini et al. 2021, Cook et al. 2023, etc.). ¿Los resultados están en línea con la literatura o son mejores/peores?",
  "veredicto_final": {
    "calificacion": "bueno",
    "etiqueta": "Etiqueta honesta de 4-6 palabras. Ej: 'Válido para tendencias, no valores absolutos'",
    "recomendacion": "Respuesta directa en 2 frases: cuándo usar Fitbit para HRV nocturna y cuándo no. Sin eufemismos."
  }
}

Responde en español. Cita métricas concretas con cifras del input. Sé riguroso y directo."""


def _build_nocturnal_hrv_prompt(session_name: str, summary: dict, n_windows: int) -> str:
    def _f(val, decimals=1):
        return f"{val:.{decimals}f}" if val is not None else "N/D"

    lines = [
        f"## Sesión: {session_name}",
        f"Ventanas de 5 min analizadas: {n_windows}",
        "",
        "### Métricas RMSSD (ms)",
        f"- Polar H10 (referencia): RMSSD medio = {_f(summary.get('polarRmssdMean'), 1)} ms",
        f"- Fitbit (bajo evaluación): RMSSD medio = {_f(summary.get('fitbitRmssdMean'), 1)} ms",
        f"- MAE RMSSD: {_f(summary.get('rmssdMAE'), 1)} ms",
        f"- Pearson r (RMSSD): {_f(summary.get('pearsonR'), 3)}",
        "",
        "### Bland-Altman RMSSD",
        f"- Sesgo (Fitbit − Polar): {_f(summary.get('biasMean'), 1)} ms",
        f"- SD de las diferencias: {_f(summary.get('blandSd'), 1)} ms",
        f"- Límite superior de acuerdo (LoA+): {_f(summary.get('upperLoa'), 1)} ms",
        f"- Límite inferior de acuerdo (LoA−): {_f(summary.get('lowerLoa'), 1)} ms",
        f"- Amplitud total LoA: {_f((summary.get('upperLoa') or 0) - (summary.get('lowerLoa') or 0), 1)} ms",
        "",
        "### Métricas FC (bpm)",
        f"- Polar H10: FC media nocturna = {_f(summary.get('polarHRMean'), 1)} bpm, FC mínima = {_f(summary.get('polarHRMin'), 1)} bpm",
        f"- Fitbit: FC media nocturna = {_f(summary.get('fitbitHRMean'), 1)} bpm, FC mínima = {_f(summary.get('fitbitHRMin'), 1)} bpm",
        f"- MAE FC: {_f(summary.get('hrMAE'), 1)} bpm",
        f"- Pearson r (FC): {_f(summary.get('pearsonRHR'), 3)}",
    ]
    return "\n".join(lines)


async def generate_nocturnal_hrv_ai_analysis(
    session_name: str,
    summary:      dict,
    n_windows:    int,
) -> dict:
    """Call Claude to analyze a nocturnal HRV comparison session."""
    client = _anthropic_client()

    prompt = _build_nocturnal_hrv_prompt(session_name, summary, n_windows)

    response = await client.messages.create(
        model="claude-sonnet-4-6",
        system=_cached_system(NOCTURNAL_HRV_SYSTEM_PROMPT),
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        max_tokens=4096,
    )

    report = _parse_json(response.content[0].text or "{}")

    return {
        "report":       report,
        "generated_at": datetime.utcnow().isoformat(),
        "model":        "claude-sonnet-4-6",
    }


# ─────────────────────────────────────────────────────────────────────────────
# NOCTURNAL HRV GLOBAL (MULTI-SESSION) ANALYSIS
# ─────────────────────────────────────────────────────────────────────────────

NOCTURNAL_HRV_GLOBAL_SYSTEM_PROMPT = """Eres un científico experto en fisiología del sueño y validación de wearables. Analizas la fiabilidad global de un dispositivo Fitbit para medir HRV (RMSSD) y FC nocturnas comparadas con Polar H10 (ECG de referencia) a lo largo de múltiples noches.

Trabajas para "El Cuantificador". Tu análisis es riguroso, basado en datos, directo. Si el dispositivo no es fiable, lo dices sin rodeos.

## Contexto

Los datos son la agregación de N sesiones nocturnas grabadas simultáneamente con Polar H10 (referencia ECG) y Fitbit (PPG de muñeca). Cada sesión genera ventanas de 5 minutos. Los estadísticos presentados son los calculados sobre TODAS las ventanas de TODAS las sesiones combinadas.

## Marco Científico

- **Pearson r global**: si es consistente entre sesiones indica que Fitbit rastrea la dinámica nocturna de HRV de forma reproducible. r > 0.85 para uso orientativo; r > 0.92 para uso de seguimiento individual.
- **MAE global RMSSD**: < 5 ms excelente; 5–10 ms aceptable; > 10 ms problemático para lecturas individuales.
- **Sesgo global (Bland-Altman)**: si |bias| > 5 ms, el dispositivo sobreestima o subestima sistemáticamente — los valores absolutos no son intercambiables con ECG.
- **LoA globales**: si la amplitud (LoA+ − LoA−) > 30 ms, la variabilidad individual noche a noche es demasiado grande para fiarse de lecturas puntuales.
- **Consistencia entre sesiones**: si cada sesión tiene una r individual similar a la r global, el dispositivo es reproducible. Si varía mucho, el dispositivo es inconsistente entre noches.
- **MAE FC global**: < 2 bpm excelente; 2–4 bpm aceptable; > 5 bpm relevante para métricas de recuperación.

## Reglas de Honestidad

- Si r < 0.80 con múltiples sesiones: el seguimiento de HRV por Fitbit no es reproducible entre noches.
- Si MAE RMSSD global > 10 ms: los valores absolutos no pueden compararse con ECG. Decirlo explícitamente.
- Si LoA amplitud > 40 ms: la variabilidad es clínicamente inaceptable para decisiones individuales.
- Si sesgo > 10 ms en múltiples sesiones: el dispositivo tiene un sesgo sistemático estructural, no puntual.
- Distinguir "útil para tendencias semanales" vs "fiable para lecturas nocturnas individuales".
- No suavizar los fallos. Si el dispositivo falla de forma consistente, el veredicto multi-sesión lo confirma.

## Formato de Respuesta

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin texto extra):

{
  "resumen_ejecutivo": "3-4 frases directas. Qué muestra el conjunto de N sesiones: r global, MAE global, si el sesgo es sistemático, veredicto de si Fitbit es fiable para HRV nocturna a largo plazo.",
  "calificacion_hrv": "excelente|bueno|moderado|deficiente",
  "calificacion_fc": "excelente|bueno|moderado|deficiente",
  "analisis_rmssd_global": {
    "correlacion": "Interpretación del r global. ¿Es suficiente para seguimiento individual?",
    "error_absoluto": "MAE global en ms. ¿Qué significa para el deportista que consulta su HRV nocturna?",
    "sesgo_sistematico": "Dirección y magnitud del sesgo. ¿Es consistente o variable entre sesiones?",
    "limites_acuerdo_global": "Amplitud de LoA. ¿Qué implica para la variabilidad noche a noche?"
  },
  "analisis_fc_global": {
    "error_absoluto": "MAE FC global y relevancia para recuperación y FC basal nocturna.",
    "correlacion": "Pearson r FC a lo largo de las sesiones."
  },
  "consistencia_entre_sesiones": "¿Son los resultados reproducibles noche a noche? ¿Qué factores pueden explicar variabilidad inter-sesión?",
  "causas_tecnicas": "Párrafo de 3-4 frases. Mecanismos estructurales del error PPG nocturno en Fitbit a lo largo del tiempo.",
  "utilidad_practica": {
    "tracking_tendencias": "Con N sesiones acumuladas, ¿es útil para ver tendencias semana a semana?",
    "recovery_score": "¿Pueden fiarse los recovery scores a lo largo del tiempo?",
    "deteccion_sobreentrenamiento": "¿Puede detectar bajadas consistentes de HRV que indiquen sobreentrenamiento?"
  },
  "comparacion_literatura": "Compara con estudios de validación de Fitbit para HRV nocturna (Menghini 2021, Stone 2021). ¿Los resultados están por encima o por debajo de la media?",
  "veredicto_final": {
    "calificacion": "bueno",
    "etiqueta": "Etiqueta honesta de 4-6 palabras basada en los datos globales",
    "recomendacion": "2 frases directas: cuándo usar Fitbit con confianza y cuándo no, basándose en N sesiones."
  }
}

Responde en español. Cita métricas concretas. Sé riguroso."""


def _build_nocturnal_hrv_global_prompt(
    device_name: str,
    n_sessions:  int,
    rmssd_stats: dict | None,
    hr_stats:    dict | None,
    by_session:  list[dict],
) -> str:
    def _f(val, d=1):
        return f"{val:.{d}f}" if val is not None else "N/D"

    lines = [
        f"## Dispositivo: {device_name}",
        f"Sesiones analizadas: {n_sessions}",
        "",
    ]
    if rmssd_stats:
        amp = (rmssd_stats.get("upperLoa") or 0) - (rmssd_stats.get("lowerLoa") or 0)
        lines += [
            "### Estadísticos globales RMSSD — todas las sesiones combinadas",
            f"- Ventanas totales: {rmssd_stats['n']}",
            f"- RMSSD medio Polar H10: {_f(rmssd_stats['polarMean'])} ms",
            f"- RMSSD medio Fitbit: {_f(rmssd_stats['fitbitMean'])} ms",
            f"- MAE global: {_f(rmssd_stats['mae'])} ms",
            f"- Pearson r global: {_f(rmssd_stats['pearsonR'], 4)}",
            f"- Sesgo (Fitbit − Polar): {_f(rmssd_stats['bias'])} ms",
            f"- SD diferencias: {_f(rmssd_stats['sd'])} ms",
            f"- LoA superior: {_f(rmssd_stats['upperLoa'])} ms",
            f"- LoA inferior: {_f(rmssd_stats['lowerLoa'])} ms",
            f"- Amplitud LoA: {_f(amp)} ms",
            "",
        ]
    if hr_stats:
        lines += [
            "### Estadísticos globales FC — todas las sesiones combinadas",
            f"- Ventanas totales: {hr_stats['n']}",
            f"- FC media Polar H10: {_f(hr_stats['polarMean'])} bpm",
            f"- FC media Fitbit: {_f(hr_stats['fitbitMean'])} bpm",
            f"- MAE global: {_f(hr_stats['mae'], 2)} bpm",
            f"- Pearson r global: {_f(hr_stats['pearsonR'], 4)}",
            "",
        ]
    if by_session:
        lines.append("### Ventanas por sesión (RMSSD)")
        for s in by_session:
            lines.append(f"- {s['session_name']}: {len(s.get('points', []))} ventanas")
        lines.append("")

    return "\n".join(lines)


async def generate_nocturnal_hrv_global_ai_analysis(
    device_name: str,
    n_sessions:  int,
    rmssd_stats: dict | None,
    hr_stats:    dict | None,
    by_session:  list[dict],
) -> dict:
    """Call Claude to analyze global multi-session nocturnal HRV data."""
    client = _anthropic_client()
    prompt = _build_nocturnal_hrv_global_prompt(
        device_name, n_sessions, rmssd_stats, hr_stats, by_session
    )
    response = await client.messages.create(
        model="claude-sonnet-4-6",
        system=_cached_system(NOCTURNAL_HRV_GLOBAL_SYSTEM_PROMPT),
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        max_tokens=4096,
    )
    report = _parse_json(response.content[0].text or "{}")
    return {
        "report":       report,
        "generated_at": datetime.utcnow().isoformat(),
        "model":        "claude-sonnet-4-6",
        "n_sessions":   n_sessions,
    }

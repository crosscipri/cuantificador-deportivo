# Metodología del módulo de comparativas

Motor `comparison-2.0.0`, 9 de septiembre de 2026. Esta metodología corresponde a `backend/comparisons`; no se atribuye retroactivamente a resultados `legacy-unversioned`. El clasificador de sueño identifica además su algoritmo como `sleep-epoch-1`.

## Unidad de comparación y referencias

DIRECT representa la misma prueba y utiliza una ventana UTC común y una referencia única por métrica. Archivos de referencia con hash y etiqueta coincidentes identifican una fuente compartida, no acreditan la calidad del sensor. Una designación explícita en un experimento también establece la referencia. Sin esa evidencia se exige declarar el mismo entrenamiento y asumir la referencia seleccionada; el resultado queda marcado `REFERENCE_ASSUMED`. Experimentos explícitamente distintos o ausencia de intersección temporal impiden el overlay FC.

FC y GPS tienen referencias independientes. Las categorías de calidad son declaraciones guardadas con notas, no certificaciones inferidas del fabricante. Los protocolos personalizados congelan versión, prescripción textual y condiciones; `EXACT_PROTOCOL` exige coincidencia de versión, deporte, categoría y contexto obligatorio. No verifica automáticamente que se ejecutara cada intervalo prescrito. Los presets iniciales solo acreditan categoría.

BENCHMARK conserva la referencia de cada sesión. La unidad descriptiva predeterminada es una sesión por dispositivo. Se rechazan duplicados de fuente y repeticiones de dispositivo/experimento conocidos; el sistema no puede descubrir todas las dependencias físicas cuando faltan metadatos. Los paneles de sesiones independientes tienen tiempos propios y no constituyen un overlay temporal.

## Tiempo, resolución y datos ausentes

Se leen los bytes originales retenidos. `EPOCH_SECOND_MEAN` reutiliza la normalización histórica que promedia valores dentro del segundo. `NATIVE` conserva fracciones de timestamp hasta microsegundos y solo promedia duplicados de timestamp exacto. La inspección de canales informa paso mediano, duplicados, unidades y vueltas disponibles; potencia/cadencia/altitud no tienen un motor de benchmarking propio en esta entrega.

FC permite rejillas de 1, 2, 5 y 10 Hz; más de 1 Hz requiere origen nativo. La fase de la rejilla nativa comienza en el primer timestamp de referencia. La ventana es la intersección tras aplicar los offsets manuales del dispositivo. Sin interpolación se emparejan únicamente muestras que coinciden con la rejilla; aumentar Hz no crea observaciones. Se informa n, frecuencia, origen de rejilla, duración original y tiempo fuera de la ventana. Una cobertura completa en la intersección no significa cobertura de toda la prueba física.

LINEAR es opcional, no extrapola y solo rellena entre extremos cuya separación cumple el gap máximo configurado. Se separan pares observados e interpolados. El offset predeterminado es cero y la referencia no se desplaza. No se aplica corrección automática por correlación ni DTW.

La selección global incluye los extremos presentes en la rejilla: 0–10 s a 1 Hz contiene 11 instantes. Los intervalos y exclusiones usan `[inicio, final)` relativos al comienzo de la intersección completa. Las exclusiones tienen nombre y motivo, permanecen en la configuración y conservan métricas sin máscara; las gráficas siguen mostrando la señal original. No se eliminan outliers automáticamente.

`expected_pairs` cuenta instantes elegibles; `planned_pairs` conserva los instantes antes de la máscara y `excluded_pairs` su diferencia. Cobertura conjunta = pares válidos / elegibles; cobertura de referencia = referencia válida / elegibles; cobertura de dispositivo condicionada = pares válidos / referencia válida. Los gaps cuentan instantes ausentes por el paso temporal y las exclusiones interrumpen los gaps: no se unen ausencias a ambos lados de una región excluida. `null` significa no estimable, nunca cero.

## Estadísticas y diagnósticos FC

Error firmado = dispositivo − referencia. Se calculan bias, MAE, MedianAE, RMSE, P90/P95 de error absoluto, máximo, SD muestral (`ddof=1`) y porcentajes dentro de ±3/5/10 bpm. Cuantiles lineales. Pearson describe asociación; CCC usa momentos normalizados por n. Con un solo par hay errores estimables, pero no correlación ni SD. Series constantes pueden hacer indefinido el acuerdo normalizado.

Bland–Altman muestra promedio de cada pareja frente a su diferencia y límites descriptivos `bias ± 1,96 × SD`. No son intervalos inferenciales ni corrigen la autocorrelación. Scatter conserva la identidad y ECDF utiliza la distribución de todos los errores elegibles. La reducción a puntos de representación no modifica las estadísticas. Las bandas son ayudas descriptivas, no tolerancias universales.

El lag busca Pearson por desplazamientos enteros, usando el mismo conjunto de pares válidos para todos los desplazamientos. Requiere al menos 60 pares compartidos y variación suficiente; un máximo en el borde se marca. En FC nativa se toma una subselección exacta a 1 Hz para este diagnóstico y se declara su n por separado. Lag positivo significa dispositivo retrasado. No distingue por sí solo reloj incorrecto y respuesta del sensor, y **no desplaza la señal**.

Los intervalos generan métricas FC/GPS propias. Las vueltas nativas se pueden convertir explícitamente en intervalos; en TCX el final observado procede del último timestamp conservado de la vuelta. La tabla mantiene separados duración y distancia declaradas por el archivo. Los buckets de intensidad se definen por la referencia y límites editables. Subida/estable/bajada utiliza cambio entre extremos de una ventana continua de 10 s y umbral descriptivo ±0,5 bpm/s.

Los transitorios requieren intervalos manuales: extremos de 5 s estables (SD ≤3 bpm), cambio mínimo configurable (10 bpm por defecto), y cruces sostenidos (3 s por defecto) al 50/90 % del cambio de referencia. Se devuelve diferencia de tiempo de cruce, sobrepaso y déficit final; datos insuficientes o cruces no identificables producen null con motivo. Son reglas operativas explícitas, no detección automática universal de transitorios fisiológicos.

## GPS temporal, contadores y geometría

La carga GPS se solicita por separado. Su rejilla temporal es de segundos UTC enteros a 1 Hz, independiente de la frecuencia FC; no interpola coordenadas. Timestamps fraccionarios que no coincidan exactamente pueden quedar sin pareja. Se informa cobertura, n, error horizontal medio/mediano/RMSE/P95/máximo y gaps. Una referencia sin timestamps no permite error temporal.

Se conserva el orden y la separación de segmentos. Cambios de segmento, tiempo no creciente, paso a coordenadas sin tiempo o gaps superiores a 5 s rompen la trayectoria continua. La distancia derivada suma aristas válidas mediante distancia esférica y no une gaps. La distancia registrada es el incremento del contador FIT/TCX entre extremos GPS retenidos; si falta, disminuye o hay discontinuidades devuelve null. No equivale necesariamente al total de actividad ni al total declarado de una vuelta.

Las diferencias de distancia requieren tramos completamente temporizados, mismos extremos y ausencia de discontinuidades detectadas. Se comparan coordenadas con coordenadas o contadores con contadores. Por intervalo se filtran coordenadas temporizadas con la misma convención semiabierta que FC; las métricas reflejan los puntos realmente retenidos. Una distancia histórica GPS almacenada como `distance_m` se etiqueta como derivada histórica, no como contador nativo.

La geometría proyecta cada punto sobre el arco esférico menor más cercano de la polilínea. Se informa separación media/P95/máxima; se trata de distancia no firmada a la trayectoria, no de error temporal. El buscador espacial acota candidatos mediante la desigualdad triangular. Along-track compara progreso proyectado con progreso de referencia en el mismo timestamp; se suprime con referencia discontinua o proyección ambigua. Se considera ambigua una alternativa no adyacente a ≤3 m del mejor resultado, umbral operativo declarado. Máximo 100.000 puntos por lado para esta operación.

El mapa puede colorear separación geométrica con escala visible. El PNG exporta la geometría y sus límites geográficos, sin descargar ni capturar teselas del proveedor. No implementa todavía eje de distancia, Hausdorff/Fréchet ni un índice de repetibilidad de circuitos.

## Agregación, incertidumbre e histórico nocturno

Por dispositivo/métrica se muestran n, media, mediana, SD muestral, Q1/Q3/IQR, mínimo y máximo entre sesiones. La estimación opcional ponderada es `sum(w × valor) / sum(w)` para pesos positivos finitos. Los pesos pueden ser uno por sesión, duración analizada, pares válidos o valores manuales; se declaran n ponderado, suma de pesos y sesiones sin peso utilizable. No se reconstruyen pesos ausentes de los valores de una gráfica. Los resúmenes descriptivos siguen sin ponderar.

El bootstrap opcional remuestrea clusters de participante cuando todas las identidades están presentes y hay varios participantes; en caso contrario usa experimento o sesión. Identidad parcialmente conocida impide emitir IC. Se declara ámbito de un participante o identidad desconocida, semilla, confianza y repeticiones (200–5000). El mínimo de 5 clusters es operativo y no garantiza evidencia suficiente. Los IC percentiles corresponden a la media ponderada, no a cada segundo como sujeto independiente. No hay bootstrap temporal por bloques ni ICC genérico.

El histórico GPS agrupa primero los runs del mismo documento de test: cada test pesa una vez. Se muestran n runs y n tests. Direct GPS histórico requiere declaración de misma prueba; una geometría sin tiempo no permite verificar simultaneidad. Cada run mantiene el enlace al test original.

Las noches reutilizan ventanas históricas de 5 min y exigen aceptación explícita de su definición y ajustes compatibles. RMSSD se mide en ms y FC en bpm; no se mezclan SDNN, noche completa o épocas de sueño. Los timestamps se normalizan en UTC, se rechazan duplicados/rejillas incompatibles, y no se usa la fecha de subida como fecha de noche. Direct exige solapamiento real y referencia compartida verificada o asumida; benchmark conserva la referencia por fuente. Los gaps se expresan en segundos (ventanas ausentes ×300). No se recalcula RR ni se certifica la corrección histórica de artefactos.

## Etapas de sueño

Se importan etiquetas reales con participante, duración de época 30/60 s, mapping y versión explícitos. Se admite esquema de cinco etapas (WAKE/N1/N2/N3/REM) o cuatro (WAKE/LIGHT/DEEP/REM); no se convierte uno en otro automáticamente. Las épocas requieren timestamps con zona, no solaparse y compartir rejilla UTC. No se deduce sueño de FC o RMSSD.

La cobertura se calcula sobre toda la noche de referencia, incluyendo ausencias al principio y al final del dispositivo. La matriz usa referencia en filas y dispositivo en columnas; acuerdo y kappa usan parejas válidas, y se informan precisión/recall/F1 por clase y ausencias. Denominadores nulos producen null.

El benchmark de sueño requiere identificador explícito de noche en las referencias, rechaza duplicados participante/noche/dispositivo y agrega resultados compatibles con igual peso por noche. No produce IC tratando cada época como independiente ni valida una referencia como PSG a partir de su etiqueta.

## Trazabilidad, persistencia y límites operativos

Snapshots guardan configuración, listas resueltas, hashes, revisiones y evidencia escalar; las series visuales se reconstruyen solo si versión y fuentes son compatibles. Una versión anterior puede consultarse como evidencia sin reinterpretar sus métricas. LIVE conserva la consulta para resolver de nuevo las sesiones compatibles; su evidencia inicial y nuevas versiones son documentos distintos. Reabrir un snapshot FC no adapta ni reescribe las fuentes. Estas garantías describen el código; guardado/reapertura MongoDB no se han validado, por indicación del usuario.

La identidad analítica excluye nombre y preferencias visuales; FC y GPS conservan revisiones independientes. Las exclusiones afectan a FC, los intervalos a FC y GPS. Nuevas versiones no sobrescriben comparativas anteriores. La migración mantiene una bitácora y revierte únicamente vínculos intactos sin dependencias; conserva fuentes, evidencia y adaptaciones aditivas.

Máximos operativos: 8 dispositivos por Direct, 100 sesiones/fuentes por selección, ventana FC de 12 h, Direct nocturno de 24 h y una fuente nocturna benchmark de hasta 7 días. Sueño limita cada importación a 6.000 épocas/48 h. La selección dinámica rechaza más de 100 resultados y pide acotar filtros. El render conserva límites de gaps y puede superar su presupuesto orientativo de puntos. GPS usa sus propios puntos de tiempo reducidos; ningún cálculo estadístico depende del chart reducido.

La verificación local y sus límites están en [COMPARISON_VALIDATION.md](COMPARISON_VALIDATION.md).

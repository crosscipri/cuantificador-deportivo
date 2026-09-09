# Verificación local de comparativas

9 de septiembre de 2026 · Versión actual `comparison-2.0.0`.

No se han creado ni modificado archivos de tests, fixtures o frameworks. Se ha ejecutado la suite existente y comprobaciones numéricas directamente en consola, con datos sintéticos en memoria. Esos datos no se han importado al histórico.

**Exclusión solicitada por el usuario:** no validar el guardado y la reapertura en MongoDB. No se han ejecutado escrituras/lecturas de comprobación, migraciones aplicadas, rollback real ni simulaciones de MongoDB en esta continuación. No se considera esta exclusión un bloqueo del resto de la entrega.

## Entorno utilizado

- Entorno Python aislado previamente autorizado: `/private/tmp/cuantificador-comparisons-venv`, con Python 3.12 ya disponible en el equipo.
- Dependencias de `backend/requirements.txt` instaladas únicamente ahí; no se ha cambiado ese archivo. `pip check` pasó en la preparación del entorno.
- Versiones resueltas: `requirements-resolved.txt` dentro del entorno temporal.
- Caché de Matplotlib dentro del mismo entorno; ocupación observada en la preparación: aproximadamente 380 MB.
- Dependencias Angular ya presentes en `frontend/node_modules`.
- No se ha instalado MongoDB, actualizado Homebrew, modificado Python global ni creado servicios permanentes. El intento previo incompleto permanece en `/private/tmp/cuantificador-comparisons-incomplete` (4 KB observados entonces).

## Comprobaciones de integración

| Comprobación | Resultado |
| --- | --- |
| `npm run build`, desde `frontend/` | Correcto, código 0; compilación de producción final registrada en 12,172 s. |
| Advertencias Angular | Permanecen advertencias de plantillas, presupuestos de estilos y dependencias CommonJS. El build no está libre de advertencias. |
| Sintaxis Python | Todos los módulos de comparativas, migraciones y `main.py` analizados correctamente. |
| Importación | `from main import app` correcto; OpenAPI contiene 57 rutas totales de la aplicación en esta revisión. |
| Suite backend existente | `python -m unittest discover -s tests -p 'test_*.py'`: 9 tests, todos OK. |
| API ASGI sin ciclo de vida DB | `/api/comparison-definitions` y `/openapi.json`: HTTP 200. |
| Validación ASGI | Selección vacía, fecha imposible y 2 Hz sin resolución nativa: HTTP 422 antes de acceder a DB. |
| Orden de fechas | Un rango con final anterior al inicio se rechaza mediante el contrato de filtros. |
| JSON | Resultados numéricos GPS/direct FC serializados con `allow_nan=False` tras conversión pública; sin NaN/Infinity en la salida. |
| CLI de migración | `--help` correcto; no se ha conectado a MongoDB para ejecutar el inventario o la aplicación. |
| Whitespace | `git diff --check` correcto; compilación incluye los archivos nuevos. |

Las peticiones ASGI no arrancan el ciclo de vida que conecta MongoDB. No equivalen a validar despliegue, autenticación configurada en destino, índices, concurrencia entre colecciones o persistencia real. No se ha recorrido la interfaz en navegador con una base de datos ni con archivos reales de dispositivos durante esta continuación.

## Casos numéricos de la ampliación

| Caso en memoria | Resultado observado |
| --- | --- |
| Máscara `[1,2)` sobre tres pares idénticos | 2 pares elegibles, 1 excluido y 3 planificados; errores cero. |
| FC nativa, 8 puntos a 2 Hz con fase inicial .125 s | Rejilla relativa 0, .5, …, 3.5 s; 8 instantes analíticos. Exclusión `[1,1.5)` deja 7 pares y ausencia de 0 s. GPS permanece sin cargar. |
| TCX con tiempos .125/.625 y canales | Timestamps fraccionarios, HR 100/102, contador 3/6 m y cadencia disponible conservados; se informa la vuelta nativa. |
| Señal variable de 400 s con dispositivo retrasado 4 s | Lag diagnóstico +4 s; Pearson a cero ≈0,9201 y máximo ≈1; 360 pares comunes. |
| Diagnósticos con 0, 1 y 10 pares | Salida válida y estados no estimables cuando corresponde. |
| Rampa manual 100→140 bpm con retraso de 3 s | Δt50 = Δt90 = 3 s; sobrepaso y déficit final cero. |
| Proyección sobre tramo ecuatorial, punto a 1° de latitud | Separación ≈111.194,9266 m y progreso ≈55.597,4633 m. |
| Cinco sesiones con MAE 0,1,2,3,4 | Media/mediana 2, SD ≈1,5811, IQR 2; bootstrap de 200 repeticiones/semilla 2026: IC [0,8;3,4]. |
| RMSSD histórico, 10 ventanas de 5 min, dos dispositivos | MAE 0/1 ms y una sola referencia en la directa. |
| Sueño: referencia W/R/R/W; dispositivo W/W/R/W | n=4, acuerdo 75 %, kappa 0,5; matriz y métricas por clase coherentes. |
| GPS, dos dispositivos idénticos, intervalos `[0,5)` y `[5,10)` | 5 pares por intervalo/dispositivo, P95 de posición y diferencia de distancia cero. |

El último caso detectó que recortar primero el límite derecho de un intervalo semiabierto al último timestamp global perdía la última muestra. Se corrigió conservando el límite propio del intervalo y utilizando las fuentes ya acotadas a la ventana; el caso se volvió a ejecutar correctamente.

Estas comprobaciones no constituyen una validación científica exhaustiva frente a datos de referencia independientes. En particular, probar un ejemplo de geometría, lag o clasificación no acredita precisión general ni todos los casos extremos de sensores reales.

## Rendimiento del motor actual

Escenario `comparison-2.0.0`: TCX sintéticos en memoria, 10.801 instantes a 1 Hz (3 h entre extremos), 8 dispositivos, una referencia sinusoidal común, bias constante 0–7 bpm, diagnósticos avanzados activados e intervalo inicial de 300 s. GPS no solicitado para comprobar su carga diferida.

| Medida | Resultado |
| --- | --- |
| `direct_compute` | 0,791 s en una ejecución local. |
| Instantes analíticos | 10.801. |
| Instantes de representación FC | 4.345. |
| MAE por dispositivo | 0,1,2,3,4,5,6,7 bpm. |
| GPS | `null`, sin lectura ni cálculo al no solicitarse. |
| Serialización del resultado | Correcta tras conversión pública. |

El cronómetro comienza después de construir los bytes e importar módulos. Excluye DB, HTTP, serialización, arranque, render y memoria máxima. Es una medición de un escenario, no una garantía de latencia ni una comparación directa con las mediciones anteriores que también procesaban GPS.

## Registro de verificaciones anteriores

Las continuaciones previas cotejaron también: señales idénticas (errores 0, r/CCC 1), bias +10, datos ausentes, cero/un par, agregación `[1,5,null]`, interpolación limitada que conserva gaps largos, rechazo de arrays no alineados, TCX GPS, segmentos separados, contadores crecientes/constantes/reiniciados, duplicados de dispositivo/prueba y conservación de preferencias visuales en el contrato.

En la base anterior, 3 h/8 dispositivos con FC y GPS pasaron de 208,606 s a 2,975 s al convertir timestamps GPS por bloques; la salida completa pudo serializarse en BSON (7.750.388 bytes, incluyendo series que el snapshot no guarda). En `comparison-1.0.2`, otro escenario de 3 h/2 dispositivos TCX con contadores y un gap GPS tardó 1,138 s, conservando el gap y las métricas. Son escenarios/versiones anteriores, no resultados de rendimiento de la ampliación actual.

La limitación de MongoDB observada antes de la exclusión del usuario no se ha vuelto a investigar ni ha motivado instalaciones adicionales.

El alcance funcional y las extensiones aún no incluidas se enumeran en [COMPARISON_IMPLEMENTATION_STATUS.md](COMPARISON_IMPLEMENTATION_STATUS.md).

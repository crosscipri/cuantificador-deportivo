# Estado de la implementación

9 de septiembre de 2026 · Motor `comparison-2.0.0`.

Se ha ampliado el proyecto Angular/FastAPI existente con comparativas directas, benchmarking, adaptadores del histórico y análisis avanzado. La navegación está en **Comparativas**. No se han creado ni modificado tests. Las dependencias Python utilizadas siguen en la carpeta temporal autorizada; no se ha instalado MongoDB ni ningún servicio permanente.

Por indicación expresa del usuario, **el guardado y la reapertura en MongoDB quedan fuera de la validación de esta entrega**. Sus rutas y pantallas están implementadas, pero no se presentan como verificadas contra una base de datos. Tampoco se ha aplicado la migración. Esta exclusión no se utiliza como requisito para continuar el resto del trabajo.

## Funcionalidad disponible en código

| Área | Implementación |
| --- | --- |
| Dominio y procedencia | Recordings vinculados a fuentes existentes, experimentos explícitos, referencias FC/GPS independientes, hashes, revisiones de análisis, evidencia escalar y protección de borrado de fuentes utilizadas. |
| Protocolos y contexto | Catálogo de categorías; publicación de protocolos personalizados con versiones inmutables; participante, firmware, muñeca, GNSS, condiciones y notas. Historial de metadatos y referencias con control de edición concurrente. |
| Direct FC | 2–8 dispositivos, referencia común verificada o asumida explícitamente, intersección UTC, offsets manuales, interpolación limitada, selección de región y métricas sobre todos los pares analíticos. |
| Resolución nativa | Lectura de timestamps subsegundo; FC a 1/2/5/10 Hz por elección explícita; inspección de potencia, cadencia, altitud, distancia y vueltas cuando existen en FIT/TCX/GPX. Conserva el modo histórico por segundo como predeterminado. |
| Análisis avanzado | Exclusiones con motivo y métricas antes/después; intervalos manuales o tomados de vueltas; intensidad, subida/estable/bajada, lag diagnóstico, transitorios manuales 50/90 %, sobrepaso y déficit final. |
| Gráficas FC | Overlay, small multiples con escala compartida, error firmado/absoluto, bandas descriptivas, scatter, Bland–Altman y ECDF; cursor, tooltips, zoom/pan/fullscreen y selección de intervalo. |
| GPS desde originales | Carga al solicitar GPS, mapa y cursor vinculados, posición por coincidencia UTC, distancias de contador y derivadas separadas, gaps, error por intervalo/vuelta y geometría de separación a la polilínea. Along-track condicionado a continuidad, tiempo y proyección no ambigua. |
| Benchmark FC | Reutilización LEGACY o revisión CURRENT calculada desde originales, control de duplicados, igual peso por sesión por defecto, filtros de dispositivo/deporte/intensidad/protocolo/versión/fechas/firmware/participante. |
| Selección y evidencia | Selección explícita o todas las compatibles; SNAPSHOT o LIVE; nuevas versiones de comparativas, listado paginado, revisión JSON y acceso al análisis fuente. |
| Resumen entre sesiones | Media/mediana/SD/Q1/Q3/IQR/min/max/n por métrica, dot plot, heatmap con fuentes e inspección de hasta cuatro gráficas históricas independientes lado a lado. |
| Ponderación e incertidumbre | Pesos por duración, pares válidos o manuales; media ponderada separada del resumen descriptivo; bootstrap opcional por participante o experimento/sesión con semilla, repeticiones, ámbito y motivo cuando no se estima. |
| Histórico GPS/nocturno | Adaptadores de pista, urbano, RMSSD y FC nocturna que reutilizan runs y ventanas existentes. Direct y benchmark, agrupación previa de runs del mismo test, unidades explícitas, CSV/JSON y enlaces al test/noche concretos. |
| Etapas de sueño | Importación JSON de épocas reales de 30/60 s con mapping explícito/versionado, referencia designada, alineamiento UTC, cobertura de la noche de referencia, matriz de confusión, acuerdo/kappa y precisión/recall/F1 por clase. Benchmark por noches declaradas, sin contar épocas como noches independientes. |
| Exportación | CSV de métricas/fuentes/revisiones, JSON con configuración y evidencia, PNG de gráficas y marcos 16:9 a 1080p/4K; PNG de geometría del mapa a 1080p, sin teselas externas. |
| Migración | Inventario por defecto, aplicación explícita, bitácora por fuente, reanudación de lote, adaptación FC/GPS/nocturna y reversión selectiva de vínculos intactos. No elimina archivos, recordings, revisiones ni bitácoras. |

## Organización del código

| Ubicación | Responsabilidad |
| --- | --- |
| `backend/comparisons/models.py`, `statistics.py`, `definitions.py` | Contratos, fórmulas, unidades y versión. |
| `synchronization.py`, `channels.py` | Rejillas, interpolación, reducción visual y canales originales. |
| `advanced.py`, `aggregation.py` | Diagnósticos, máscaras, intervalos y estadística entre sesiones. |
| `gps.py`, `geometry.py` | Trayectorias, contadores, posición temporal y proyección esférica. |
| `service.py`, `router.py` | Adaptación FC, cálculo, caché, experimentos, comparativas y evidencia. |
| `protocols.py`, `archive.py`, `sleep.py` | Protocolos/contexto, histórico GPS/nocturno y etapas de sueño. |
| `backend/migrations/comparison_domain_v1.py`, `comparison_journal.py` | CLI de migración y bitácora/reversión. El nombre de la entrada CLI se conserva; la bitácora actual utiliza versión 2. |
| `frontend/src/app/pages/comparisons/` | Selección y workspace de comparativas. |
| `frontend/src/app/shared/comparison-charts/` | Gráficas, mapa, histórico, sueño y edición de contexto. |
| `frontend/src/app/models/comparison.model.ts`, `services/comparison.service.ts` | Tipos y acceso HTTP. |
| `backend/main.py`, rutas y páginas fuente | Integración con autenticación, navegación, importaciones y protección del histórico. |

Los resultados históricos no se recalculan silenciosamente con la metodología nueva. `LEGACY` conserva su versión desconocida y sus limitaciones. `CURRENT` usa originales, nunca los puntos reducidos de una gráfica, para generar una revisión distinta.

## Uso de la migración

Desde `backend/`, con las dependencias y la conexión del entorno de destino configuradas:

```bash
python -m migrations.comparison_domain_v1
python -m migrations.comparison_domain_v1 --apply
python -m migrations.comparison_domain_v1 --apply --run-id ID_DEL_LOTE
python -m migrations.comparison_domain_v1 --rollback ID_DEL_LOTE
python -m migrations.comparison_domain_v1 --rollback ID_DEL_LOTE --apply
```

El primer comando hace inventario; el cuarto inspecciona la reversión. `--hr-only` limita la adaptación a sesiones FC. Estas instrucciones se documentan para el entorno de destino: **no se han ejecutado contra MongoDB durante esta continuación**. Solo se ha comprobado `--help`.

La reversión restaura vínculos originales de sesiones si no cambiaron y no hay dependencias que proteger. Conserva todos los recordings/revisiones y las adaptaciones de GPS/noches, que son aditivas y no alteran sus documentos fuente. Por tanto no es una eliminación completa de las colecciones nuevas. La migración utiliza operaciones idempotentes y bitácora; no una transacción global entre colecciones.

## Verificación y límites

La compilación Angular de producción es correcta. Los 9 tests existentes pasan; no se han añadido tests. El backend se importa y genera OpenAPI; las comprobaciones numéricas y ASGI sin base de datos se detallan en [COMPARISON_VALIDATION.md](COMPARISON_VALIDATION.md).

Quedan fuera de lo comprobado los recorridos en navegador con datos reales, la exactitud científica frente a un conjunto de referencia independiente y el rendimiento completo de red/DB/render. La comprobación de MongoDB está excluida por el usuario.

El documento maestro también contempla extensiones que esta entrega no incluye: vista GPS por eje de distancia, repetibilidad específica de circuitos, Hausdorff/Fréchet, detección automática general de eventos, bootstrap temporal por bloques, ICC con diseño específico, rankings con criterios versionados y exportación de vídeo/SVG. Los transitorios requieren intervalos manuales; las exportaciones 1080p/4K producen imágenes, no archivos de vídeo. No hay filtros dedicados para todas las combinaciones de calidad de referencia/contexto, ni LIVE/revisiones editables en los workspaces de histórico y sueño. Estos límites no se sustituyen con resultados simulados.

Véanse el [plan maestro](COMPARISON_IMPLEMENTATION_PLAN.md) y la [metodología implementada](COMPARISON_METHODOLOGY.md).

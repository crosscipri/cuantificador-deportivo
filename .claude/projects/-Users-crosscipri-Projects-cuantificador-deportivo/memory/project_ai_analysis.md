---
name: AI Analysis feature
description: GPT-4o session analysis and device verdict feature added to the wearable quantifier app
type: project
---

AI analysis feature implemented based on scientific wearable validation PDF methodology.

**Why:** User wanted GPT-4o to auto-generate per-session scientific reports with annotated charts, and a device-level verdict on demand.

**How to apply:** Feature is complete and stored. User needs to set OPENAI_API_KEY in backend/.env.

## What was built

### Backend
- `backend/ai_analyzer.py` — system prompt grounded in ECG/PPG validation science (CCC thresholds, Bland-Altman, MAE benchmarks, lag/overshoot/cadence-lock patterns). Two async functions: `generate_session_ai_analysis()` and `generate_device_ai_verdict()`.
- 4 new endpoints in `backend/main.py`:
  - `GET/POST /api/sessions/{id}/ai-analysis`
  - `GET/POST /api/devices/{id}/ai-verdict`
- `_ser()` now strips `ai_analysis` and `ai_verdict` from responses (returns only `has_ai_analysis`, `ai_analysis_at`), with full payload via dedicated endpoints.

### Frontend
- New `AiAnalysis`, `AiVerdict`, `AiCalificacion` types in `session.model.ts`
- 4 new methods in `api.service.ts`
- Session detail: tab bar (Estadísticas / Informe IA), auto-triggers analysis on first load, stores result. Re-analyze button. Annotated PNG charts displayed inline.
- Device detail: "Análisis IA del dispositivo" section at bottom, shown/hidden on demand. Loads existing verdict on init if present.

### Storage
- `sessions.ai_analysis` — embedded doc with `report` (GPT JSON), `annotated_charts` (2x base64 PNG), `generated_at`, `model`
- `devices.ai_verdict` — embedded doc with `verdict` (GPT JSON), `generated_at`, `model`, `sessions_analyzed`

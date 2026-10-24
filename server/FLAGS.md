# Nazra server — environment flags

All behaviour added in the hardening pass is behind one of these. Defaults are what you get with nothing set.

| Flag | Default | What it does |
|---|---|---|
| `NAZRA_DB` | `server/data/nazra.db` | SQLite file. Use a separate file (e.g. `E:\nazra-test.db`) for test instances. |
| `NAZRA_LLM` | `gemma4:e4b-it-qat` | Ollama model used for extraction + summary. |
| `OLLAMA_HOST_URL` | `http://127.0.0.1:11434` | Ollama endpoint. |
| `NAZRA_FREE_VRAM` | `1` | At start, unload other resident Ollama models. Set `0` for a second/test instance. |
| `NAZRA_NO_MODELS` | unset | `1` = load no models at start (no Whisper, no Gemma preload/warm-up). Tests use this. |
| `NAZRA_WARMUP` | `1` | After preload, run one tiny real `llm.extract` call so the first patient is not slow. `0` = skip. |
| `NAZRA_WARMUP_TIMEOUT_S` | `90` | Timeout for that warm-up call (a cold model load may be slow). |
| `NAZRA_LLM_TIMEOUT_S` | `25` | Hard timeout for each Gemma call (httpx timeout + daemon-thread guard). On timeout / invalid JSON / schema mismatch / unreachable the check-in is returned **rules-only**: `ai.ok=false`, `ai.model="rules-only"`, `ai.error=timeout|invalid_json|invalid_schema|unreachable|http_error|error`, plus a labelled triage reason. |
| `NAZRA_ASR_TIMEOUT_S` | `30` | Hard timeout for each Whisper transcription. On timeout `/api/transcribe` returns HTTP 504 (patient can type instead); the worker still deletes the temp audio when it finishes. |
| `NAZRA_ASR_DEVICE` | `auto` | `auto` = CUDA int8_float16, fall back to CPU int8 · `cuda` = GPU only · `cpu` = CPU only. |
| `NAZRA_TMP_DIR` | system temp | Where `/api/transcribe` writes its short-lived `nazra_*` upload file (deleted after decoding). |
| `NAZRA_PUBLIC_URL` | unset | Public tunnel URL for the `tunnel` health component. If unset, the first `https://*.trycloudflare.com` in `NAZRA_TUNNEL_LOG` is used. |
| `NAZRA_TUNNEL_LOG` | `E:\nazra-tunnel.log` | cloudflared log to read the quick-tunnel URL from. Probe: `<url>/api/health`, 3 s timeout, cached 30 s, runs in a background thread (never blocks `/api/health`). |
| `NAZRA_DIAGNOSTICS` | `1` | Numbers-only scan diagnostics endpoints (`/api/diagnostics`). `0` = 404. |
| `NAZRA_DEV_RECORDING` | `0` | `1` enables `POST/GET /api/dev/recordings` (ground-truth videos). Off = every route 404s. |
| `NAZRA_REC_DIR` | `D:\nazra-recordings` | Where dev recordings go (`<id>.<ext>` + `<id>.json`). Refused (HTTP 500) if it resolves inside the repo. Videos are never served back. |
| `NAZRA_REC_MAX_MB` | `200` | Max size of one dev recording upload (HTTP 413 above). |
| `NAZRA_COMMUNITY` | `1` | Insights: `GET /api/community` (area early-warning: HR ≥ own baseline ×1.10 + cough/dyspnea/fever/sore_throat/runny_nose in the last 72 h; alert when count ≥ 3 and ≥ mean + 2·SD of the area's 3 earlier 72 h windows in 14 days; areas with < 5 patients are suppressed, no names). `0` = 404. |
| `NAZRA_VOICE_MARKERS` | `1` | Insights: Whisper `word_timestamps=True`; `/api/transcribe` also returns `words` + `voice_markers` (pauses ≥ 300 ms, words per breath group, words/s, quality); `GET /api/patients/{id}/voice` compares with the patient's own baseline (≥ 3 earlier ok-quality voice check-ins). `0` = no word timestamps, no markers. |
| `NAZRA_MONITOR` | `1` | Monitoring engine (`monitor.py`): daily medians, robust baseline (median of last 7–14 good days excl. last 3, SD = 1.4826·MAD ≥ 3), robust z ≥ 3 → «أعد القياس», upper CUSUM (k 0.5, h 4) → may raise followup → appointment only. Also `GET /api/patients/{id}/forecast`. `0` = no bump, endpoint 404. |
| `NAZRA_CHRONOS` | `1` | Chronos-Bolt cross-check of the linear forecast via a persistent CPU subprocess worker. `0` = linear only (with a note). |
| `NAZRA_CHRONOS_PY` | `D:
azra-chronos-venv\Scripts\python.exe` | Separate torch venv for the worker (server venv stays torch-free). |
| `NAZRA_CHRONOS_MODEL` | `amazon/chronos-bolt-small` | Falls back to `amazon/chronos-bolt-tiny`. Weights in `HF_HOME`, offline. |
| `NAZRA_CHRONOS_TIMEOUT_S` | `60` | Per-prediction timeout (start-up: 2×). On failure → linear only. |
| `NAZRA_FORECAST_NOTE_AI` | `1` | Gemma doctor trend note (20 s, temp 0, think off). Numbers guard (±1 vs facts, spelled-out numbers rejected, no forecast numbers, no probabilities) → else fixed template. `0` = template only. |
| `NAZRA_DEMO_TEAM_HR` | `70` | Centre HR for the «عضو الفريق (مؤقت)» demo profile (`demo/monitor.py`). |
| `HF_HOME` / `HF_HUB_OFFLINE` | `D:\models\hf` / `1` | Whisper model cache; offline. |

## `/api/health`

Unchanged fields: `ok`, `whisper.{ready,model,device,compute_type,error}`, `llm.{reachable,ready,model,error}`, `version`.
New: `components.{whisper,gemma,rules,database,tunnel}` each
`{status: ok|degraded|down, device?: GPU|CPU, loaded, warm, last_latency_ms, detail}`.

- `whisper`: device from the loaded model; `last_latency_ms` = last transcription (or the start-up warm-up decode).
- `gemma`: device from Ollama `/api/ps` (`size_vram > 0` → GPU); `warm` after the warm-up or a successful call.
- `rules`: start-up self-test of `core.lexicon_scan` + `core.rule_triage` on 3 fixed phrases with known answers.
- `database`: opens SQLite and counts patients / check-ins / diagnostics.
- `tunnel`: cached background probe (see above).

## `POST /api/dev/recordings` (only when `NAZRA_DEV_RECORDING=1`)

multipart: `video` (file) + `meta` (JSON string): `ref_hr_bpm` (number 20–250), `ref_source`, `device`, `facing`
(non-empty strings), `seconds` (0–600), `consent: true` (required). Anything else → 400.
`GET /api/dev/recordings` lists the saved meta JSONs (newest first).

## Insights routes

- `GET /api/community` → `{rule_ar, k_min, window_h, history_days, label_ar, areas:[{area_ar, n_patients, count_72h, baseline, baseline_sd, baseline_windows, threshold, alert, suppressed, simulated, label_ar}]}`. Suppressed areas carry no numbers.
- `GET /api/patients/{id}/changes` → «شو تغيّر من آخر زيارة»: `{available, lines_ar[2], data, days_between}`; numbers are inserted by code from the two latest check-ins.
- `GET /api/patients/{id}/voice` → `{enabled, available, n_prior, current, baseline, delta_pct, quality_ok, reason_ar, label_ar}`.
- `POST /api/checkins` keeps `voice_markers` and `context` (top-level body or inside `vitals`) on `vitals` (numbers/short strings only).
- Demo cohort for the community tab lives in its own tables (`community_patients`, `community_checkins`) so it stays out of the triage queue and the patient picker.
## Partner-center alerts (v2 center workstream)

| Flag | Default | What it does |
|---|---|---|
| `NAZRA_ALERTS` | `1` | `0` = never create partner-center alerts (endpoints still answer). Alerts are created only when the deterministic triage level is `emergency` and the patient's `consent.share_emergency` is not `false` (missing = true). No model is involved. |
| `NAZRA_ALERT_TIMEOUT_S` | `180` (`30` when `NAZRA_DEMO=1`) | Seconds without an ack before the alert moves to the next nearest center. Max 3 centers, then `status="failed"`. |
| `NAZRA_DEMO` | unset | `1` = demo timings (alert timeout 30 s). |

Dedup: one alert per patient per 30 min unless the new check-in has a red-flag code the previous alert lacked.
Routes: `GET /api/centers`, `GET /api/alerts?center_id=`, `GET /api/alerts/{id}`, `POST /api/alerts/{id}/ack {center_id}`,
`POST /api/patients/{id}/consent {share_emergency, notify_family, receive_report}`, WebSocket `/ws/center/{center_id}`
(server → `{"type":"hello",alerts}`, `{"type":"alert",alert}`, `{"type":"update",alert}`; client → `{"type":"ack","alert_id"}`).
`alerts.health()` → open alerts + connected WebSocket clients per center.
**uvicorn needs the `websockets` (or `wsproto`) package for the WebSocket route**; without it the console falls back to REST polling every 2 s.
Escalation runs in a daemon thread (1 s tick) started on the first alert / alerts request.
## Patient report + TTS (workstream: report)

| Flag | Default | What it does |
|---|---|---|
| `NAZRA_REPORT` | `1` | `GET /api/checkins/{id}/report`: patient report built by code (vitals + code-written meaning, fixed next step per level, do-now lines only from `static_data/advice_cards.json` through the advice guard, 911 lines copied verbatim from the cards, ≤3 doctor questions, nearest demo center «تجريبي», calm number-free baseline sentence, offline QR text). Emergency check-ins get a minimal report (911 action, nearest center, QR). `0` = 404. |
| `NAZRA_TTS` | `1` | `POST /api/tts {text}` → `audio/wav` via Piper (`ar_JO-kareem-medium`), cached by text hash. `GET /api/tts/health`. `0` = 404 (the page falls back to the browser's `speechSynthesis`). |
| `NAZRA_PIPER_EXE` | `D:\nazra-piper-venv\Scripts\piper.exe` | Piper CLI (separate venv; `piper-tts` from PyPI). |
| `NAZRA_PIPER_VOICE` | `D:\models\piper\ar_JO-kareem-medium.onnx` | Voice model (`.onnx.json` must sit next to it). From HF `rhasspy/piper-voices`. |
| `NAZRA_TTS_CACHE` | `D:\nazra-tts-cache` | WAV cache (`<sha256(voice,text)[:32]>.wav`). |
| `NAZRA_TTS_TIMEOUT_S` | `60` | Hard timeout for one Piper subprocess call (HTTP 502 on timeout/failure, 503 if Piper/voice missing). |

Piper gets the text on stdin as UTF-8 with `PYTHONUTF8=1`; without it Windows decodes stdin with the ANSI code page and the audio is garbage.
`tts.health()` / `tts.warm()` follow the shared health shape (`device: CPU`). Advice cards are drafts: «مسودة — بانتظار مراجعة طبية».

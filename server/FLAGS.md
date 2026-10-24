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

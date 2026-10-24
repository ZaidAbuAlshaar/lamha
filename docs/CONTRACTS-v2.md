# Nazra v2: shared contracts for parallel workstreams

Every workstream branches from `hardening` and is merged one at a time by the lead, with all tests run after each merge. These contracts prevent merge conflicts. Follow them exactly.

## Hard product rules (never break)
- Video never leaves the phone.
- Deterministic red-flag rules (`server/core.py`) always override models. A model can only escalate, never downgrade.
- No model ever writes a vital-sign number. Numbers in any model text pass a number guard, or the text is replaced by a fixed template.
- Never show hospitalization or deterioration probabilities.
- Every indicator carries the label «مؤشر للمتابعة، مش تشخيص».
- Only open-source models, all running locally. No paid APIs or keys. If something needs a key, stop and report it.
- Every new feature sits behind a flag (default ON). Frontend flags go in `web/src/config.ts` → `FLAG_DEFAULTS`: add your flag in a NEW line at the END of the object. Backend flags are env vars documented in `server/FLAGS.md`.
- Product name: «نظرة / Nazra». Demo data is always labelled «بيانات تجريبية».

## Triage names
Spec `self_care / routine / emergency` = our `followup / appointment / emergency`. A follow-up flag (trend, CUSUM, forecast) may raise `followup → appointment` ("يستحق مراجعة الطبيب") only. Never to emergency.

## File ownership (edit only your files; shared files get small, clearly marked additions)
| workstream | owns (new files) | may touch (small additions only) |
|---|---|---|
| brand | `web/src/brand/*`, `web/public/brand/*`, `web/public/icons/*`, `web/src/styles.css` **:root token values only**, `index.html` head, `manifest.webmanifest` | `components.tsx` (`Logo`/`Brand` only) |
| monitor | `server/monitor.py`, `server/forecast.py`, `server/monitor_api.py`, `server/demo/monitor.py`, `web/src/ForecastCard.tsx`, `web/src/monitor.css` | `app.py` (1 `include_router` line), `Doctor.tsx` (≤5 lines, insert `<ForecastCard/>`) |
| center | `server/alerts.py`, `server/alerts_api.py`, `server/demo/centers.py`, `web/src/Center.tsx`, `web/src/EmergencyStatus.tsx`, `web/src/center.css` | `app.py` (1 line), `App.tsx` (1 route), `Check.tsx` (≤5 lines in `Result`) |
| report | `server/report.py`, `server/report_api.py`, `server/tts.py`, `server/static_data/advice_cards.json`, `web/src/Report.tsx`, `web/src/report.css` | `app.py` (1 line), `App.tsx` (1 route), `Check.tsx` (≤3 lines: link from `Result`) |
| protocol | `web/src/protocol/*` (context questions, two-reading logic, breathing challenge, reminder .ics) | `Check.tsx` flow steps, `api.ts` types |
| insights | `server/community.py`, `server/voice_markers.py`, `server/insights_api.py`, `server/demo/community.py`, `web/src/Community.tsx`, `web/src/Timeline.tsx`, `web/src/insights.css` | `app.py` (1 line), `Doctor.tsx` (≤5 lines: tab + timeline), `asr.py` (word timestamps) |

Shared helpers that already exist:
- `server/centers.py`: `all_centers()`, `by_distance(lat, lon)`, `nearest(lat, lon)` (haversine, offline). Data is in `server/static_data/centers.json` (3 demo centers in Amman, fake contacts).
- `server/demo/`: add `server/demo/<feature>.py` with `def seed(): ...`. `demo.reset_all()` wipes the DB and calls every module. `scripts/reset_demo.ps1` runs it.
- `server/core.py`: `normalize`, `numbers_ok`, `extract_numbers`, and the lexicon/rules.
- `server/store.py`: `con()`, `_lock`, patient/check-in getters. Put new tables in your own module, created in `CREATE TABLE IF NOT EXISTS` style on first use.
- Backend routes: create `fastapi.APIRouter()` in your `*_api.py`. In `app.py` add one line `app.include_router(<module>.router)` right after the comment `# v2 routers`. Add that comment just above the `@app.get("/api/health")` route if it isn't there.
- Health: expose `def health() -> dict` (`{status, loaded, warm, device?, last_latency_ms, detail}`) in your module. The lead wires it into `/api/health`.

## CSS design tokens (names are fixed; brand sets the values)
`--bg --bg-2 --panel --panel-2 --line --line-2 --text --muted --dim` (neutrals) · `--brand --brand-2 --brand-ink --accent --on-brand` (logo) · `--hr --rr --hrv` (vital colours) · `--emg --apt --fu` (triage) · `--radius --font --mono`. Components use ONLY these variables. Put new CSS in your own `*.css`, imported from your component.

## Data fields
- Check-in `vitals` may carry:
  - `context: {exercise: bool, caffeine: bool, slept_well: bool}`
  - `readings: number[]` (individual 30 s HRs) and `reading_count`
  - `quality_score: number`
  - `excluded_from_baseline: bool`: true when the reading has context (exercise or caffeine) or poor quality
- Baseline and monitoring use only readings with quality ≠ poor and `excluded_from_baseline` not true.
- Patient doc may carry:
  - `lat`, `lon`
  - `consent: {share_emergency: bool, notify_family: bool, receive_report: bool}`
  - `family_contact: {name, phone}` (demo values only)
  - `caregiver_of: [patient_id]`

## Testing rules (shared laptop: 8 GB GPU, models already loaded by the live server on :8787)
- Do not start servers that load Whisper or Gemma. Use `fastapi.testclient.TestClient(app)` WITHOUT `with` (that skips the model-loading lifespan) and stub `llm.extract`.
- Don't touch the live server, its DB (`server/data/nazra.db`), or the tunnel.
- Python: `D:\videos\tools\whisper-venv\Scripts\python.exe -m pytest -q server/tests`. Never use bare `python` for the server env. Keep every existing test passing and add tests for your feature.
- Frontend: `cd nazra/web && npx tsc -p tsconfig.json` must pass. Do not run `vite build` (the lead builds).
- Commit on your branch as `Zaid Abu Alshaar <abualshaarzaid@gmail.com>` with no co-author trailers. Never push.

# لمحة · Lamha: a daily health check-in from a phone camera in 30 seconds

**Track:** Digital Health & Wellness. The track asks for apps that find problems before they arise, such as remote health-centre check-ins.
**Built at:** Hacktoberfest Hack Day Amman x JOSA, 2026-10-24. Every row in the demo data is synthetic and labelled «بيانات تجريبية».

> A patient (at home, in a village, in a camp) holds a phone to their face for two 30-second readings and then says what hurts in Jordanian Arabic.
> Lamha estimates heart rate and breathing from the camera, **on the phone**, and turns the speech into verified symptoms.
> It compares the reading with **the patient's own baseline**. When a rise is sustained, it tells the doctor «يستحق مراجعة الطبيب».
> In an emergency, the patient sees «اتصل بـ 911» first, and an alert goes to the nearest partner health centre, which has to acknowledge it.
>
> **Every indicator is «مؤشر للمتابعة، مش تشخيص».** The doctor makes every decision.

## Hard rules the code enforces
- **Video never leaves the phone.** rPPG runs in the browser; only numbers are sent.
- **Deterministic red-flag rules decide emergencies.** Models can only raise a level. Trend and forecast flags can only raise `followup → appointment`, never emergency.
- **No model writes a vital-sign number.** Every number in model text is checked against the computed facts (spelled-out numbers are rejected); if the check fails, a fixed template is used instead.
- **No hospitalisation or deterioration probabilities** are shown anywhere.
- **Every feature has a flag:** frontend in `web/src/config.ts`, backend in `server/FLAGS.md`. `?flags=all-off` brings back the original pipeline.

## What the demo shows
1. **Check-in** (`/#/`):
   - consent with three toggles (share in an emergency, notify family, send me the report)
   - three one-tap context questions
   - a pre-scan gate («قرّب وجهك»، «خلّي الضو قدّامك»، «ثبّت الموبايل»)
   - two 30 s readings, plus a third if they differ by more than 5 bpm; poor readings never count
   - an optional breathing check: the pulse rises on inhale and falls on exhale. It is a signal check, not a clinical metric.
   - voice in dialect, then the result
2. **Patient report** (`/#/report/<id>`):
   - vitals and their meaning, written by code
   - a fixed next step
   - do-now advice **only** from 16 advice cards with NHS / WHO sources, marked «مسودة — بانتظار مراجعة طبية»
   - 911 conditions copied verbatim from the cards
   - nearest centre, offline QR, and «اسمع التقرير» (Piper voice)
   - print / save as PDF, and WhatsApp share
3. **Emergency → partner centre** (`/#/center?id=…` on a second laptop):
   - a live WebSocket alert (REST polling as fallback) with a loud alarm and a big «استلمنا» button
   - no ack within 30 s (demo setting; 180 s by default) → the next nearest centre, up to 3
   - the patient's screen goes «بانتظار التأكيد» → «✅ المركز استلم حالتك»
   - dedup: one alert per 30 min unless a new red flag appears
4. **Doctor dashboard** (`/#/doctor`):
   - a queue by urgency
   - the «توقّع صحة المريض» card: points, baseline band, CUSUM markers, a 24/48 h forecast with an 80 % interval, a Chronos cross-check, and a doctor note that passed the number guard
   - patient timeline and «شو تغيّر من آخر زيارة»
   - community early-warning tab (k ≥ 5, no names)
   - an accuracy tab
5. **Debug** (`?debug=1`): live FPS, jitter, light, clipping, face size, motion and SNR, plus the raw and filtered traces and the spectrum. Every scan logs a numbers-only diagnostics record (`GET /api/diagnostics/latest`).

## Models (all open-weight; the first five run locally)
| model | where | role |
|---|---|---|
| MediaPipe Face Landmarker | phone browser (WASM/GPU) | face mesh → skin regions, head pose |
| `faster-whisper-large-v3` (int8_float16, CUDA) | clinic laptop | dialect speech → text, plus word timestamps for voice markers |
| `gemma4:e4b-it-qat` via Ollama | clinic laptop | symptoms with verbatim quotes (code-verified), summaries, trend note (number-guarded) |
| `amazon/chronos-bolt-small` (CPU; fallback `chronos-bolt-tiny`) | clinic laptop | independent cross-check of the linear 24/48 h forecast |
| Piper `ar_JO-kareem-medium` | clinic laptop | reads the report aloud (fallback: browser `speechSynthesis`) |
| `google/gemma-4-31b-it` via OpenRouter | cloud, **fallback only** | only if the local Gemma fails or times out; capped at 40 calls/day; key in a gitignored `.env`; sends transcript text and numbers, never audio or video |

## How the camera measurement works (hardened engine, `web/src/vitals/engine2.ts`)
- **Capture:** 640×480 @ 30 fps. `requestVideoFrameCallback` supplies real frame timestamps, and the trace is resampled to a uniform 30 Hz.
- **Camera lock:** after a 2 s auto-adjust, exposure, white balance and focus are locked where the browser allows it (mostly Android Chrome).
- **Skin regions:** forehead and both cheeks as polygons from the landmarks, a YCrCb skin mask, and clipped-pixel rejection. Frames that aren't frontal or move too fast are marked invalid.
- **Signal:**
  - POS + CHROM + GREEN on each region.
  - Sliding 10 s windows with a Welch PSD and SNR-weighted fusion.
  - Viterbi HR tracking: no jump over 12 bpm between windows.
  - Refined with the whole-segment spectrum; POS-only fallback when the algorithms disagree.
- **Adaptive scan:** borderline scans extend to 45 s and use the best 20 s. After 2 failed scans, fingertip mode is offered (rear camera + torch on Android; a strong light on iPhone).
- **Quality:** a composite 0–1 score from SNR, agreement, window coverage, motion, FPS, light, clipping and face size, plus a **raw-peak consistency gate** (see the evidence below).

## Evidence (all measured 2026-10-24; Simulated unless marked)
| test | result | file |
|---|---|---|
| Server tests | **179 passed** | `server/tests/` |
| DSP bench (Node): 18 hard synthetic traces + 3 noise-only controls | HR error ≤ 1.0 bpm on every pulse trace; noise-only controls → poor / fair / fair, never "good" | `web/tests/dsp2.test.ts` |
| Synthetic face video → real app (headless Chrome) | hardened: 72 → **72.0** (good); no-pulse control → **poor** after the consistency gate | `eval/e2e/results/*151221.json`, `*151131.json` |
| Before/after on 9 synthetic clips (2 clean + 7 hard) | MAE 0.23 (original) vs 0.29 bpm (hardened), **0 failures in both**. The difference is within run-to-run spread, so the synthetic set does not show an accuracy gain. Before the gate fix, the hardened engine accepted the no-pulse control. | `eval/accuracy/report.md` |
| Arabic audio E2E (TTS voices ar-JO, webm + m4a) | 16/16: emergency → emergency, silence → empty, temp audio deleted | `eval/audio/` |
| Emergency API path | emergency in 6.1 s → alert to the nearest centre → ack → «acked» → minimal report → TTS 200 | `eval/e2e/api_emergency_flow.py` |
| Monitoring demo «أبو محمد» (engine output, not hard-coded) | baseline 72.7 (SD 3.0), CUSUM alarms from 10-21, Chronos inside the linear interval → «متوافق» | `GET /api/patients/m1/forecast` |
| Community demo | الرمثا: 4 cases in 72 h vs its own baseline → alert; 8 small areas hidden (k < 5) | `GET /api/community` |
| **Real people vs a finger oximeter** | **Not measured yet (n = 0).** The «دقة القياس» tab and `eval/accuracy/run_eval.mjs` are ready for team recordings (`#/dev-record`, off by default). | n/a |

## Limitations
- **No accuracy on real people yet.** Every accuracy number comes from synthetic video. That validates the processing, not clinical performance.
- **One real-phone scan failed, root cause unknown.** It was reported before diagnostics existed, so its numbers never reached the server. Diagnostics and `?debug=1` now capture them.
- **rPPG degrades** with poor light, motion, low FPS, makeup and darker skin tones (lower signal). The quality gate asks for a repeat instead of guessing. Pure noise can still come out "fair" (never "good").
- **HRV/stress is experimental** and never affects triage; on synthetic video, noise inflates RMSSD.
- **The breathing (RSA) check** is verified only on synthetic beats.
- **Camera locking** works only where the browser exposes it. iPhone has no torch control.
- **Demo data is fake:** partner centres, numbers and patients. The alarm sound was checked only for its on/off state. The `.ics` reminder was not tested on real phones.
- **The doctor dashboard has no login** (hackathon scope).
- **The advice cards are drafts** awaiting clinical review.
- Not a medical device.

## Run
```powershell
powershell -ExecutionPolicy Bypass -File nazra\scripts\start.ps1      # server :8787 (warms Whisper, Gemma, Chronos, Piper)
powershell -ExecutionPolicy Bypass -File nazra\scripts\tunnel.ps1     # HTTPS link for phones
powershell -ExecutionPolicy Bypass -File nazra\scripts\reset_demo.ps1 # reset demo data (wipes the DB; back it up first)
cd nazra\web; npm install; npm run build                              # frontend (served by the server)
```
`GET /api/health` reports every component: Whisper, Gemma, rules, DB, tunnel, WebSocket alerts, Chronos, Piper and the cloud fallback.

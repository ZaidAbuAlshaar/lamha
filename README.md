# نظرة · Nazra: a health check-in from a phone camera in 30 seconds

**Track:** Digital Health & Wellness. The track asks for apps that find problems before they arise, such as remote health-centre check-ins.
**Built at:** Hacktoberfest Hack Day Amman x JOSA, 2026-10-24.

> A patient in a village, a camp or at home holds their phone in front of their face for 30 seconds and then says what hurts, in their own Jordanian Arabic.
> They need no medical device. Nazra estimates **heart rate, breathing rate and an HRV stress proxy** from the camera. It turns the speech into **structured, verified symptoms** and gives the doctor a **triage-ranked queue** (emergency / appointment / follow-up). It also flags **deterioration against the patient's own 14-day baseline**, for example "heart rate 23% above the 14-day average, with shortness of breath".
>
> **Nazra is a triage and monitoring aid, not a diagnosis. The doctor makes every final decision.**

---

## What happens in the demo

1. **Scan (on the phone, 30 s).** MediaPipe Face Landmarker finds the forehead and cheeks. The phone reads tiny colour changes in the skin with every heartbeat (rPPG, the POS algorithm) and the up-down motion of the chest and shoulders. The skin regions on screen **glow in time with the pulse**, so the judge can watch their own heartbeat on their face. **No video frame ever leaves the phone.**
2. **Speak (≤ 30 s).** The audio goes over HTTPS to the clinic laptop. **Whisper large-v3** (open weights, local GPU) transcribes it, and the server deletes the audio file straight away.
3. **Understand.** **Gemma 4 E4B** (open weights, run locally through Ollama) extracts symptoms. Each symptom must quote the patient's exact words, and the code throws out quotes that don't appear in the transcript. Gemma also writes a short doctor summary in Arabic and English.
4. **Triage (code first).** Fixed rules handle red flags (chest pain, severe breathlessness, fainting, stroke signs, bleeding, suicidal talk) and abnormal vitals. They also compare the reading with the patient's own baseline. **The AI can only raise the level, never lower it.**
5. **Doctor dashboard.** A live queue sorted by urgency. Each patient shows a 14-day trend chart, the transcript with highlighted evidence, a provenance line ("rules said X, AI said Y"), and confirm/override buttons. Every override is logged as a decision.
6. **Judges try it on themselves.** They scan the QR code on the dashboard, do their own check-in, and watch it land in the queue. They can type a smartwatch reading, which feeds a public **accuracy log** (MAE, RMSE, % within ±5 bpm) computed only from real paired readings.

## Architecture

```
 PHONE (browser, on-device)                         CLINIC LAPTOP (RTX 4060 8 GB, offline-capable)
 ┌──────────────────────────────────┐   HTTPS     ┌────────────────────────────────────────────────┐
 │ camera → MediaPipe face mesh     │  vitals +   │ FastAPI                                        │
 │ skin ROIs → mean RGB → POS       │  transcript │  ├─ /api/transcribe → faster-whisper large-v3   │
 │ band-pass → spectral peak → HR   │ ──────────▶ │  │   (audio deleted in `finally`)               │
 │ chest band motion → RR           │   audio     │  ├─ core.py rules: red flags, vitals, trends    │
 │ beat intervals → RMSSD → stress  │ ──────────▶ │  ├─ Gemma 4 E4B (Ollama): symptoms + summary    │
 │ MediaRecorder (webm/opus or mp4) │             │  ├─ guards: span check, numbers check, max()    │
 └──────────────────────────────────┘             │  └─ SQLite: numbers + text only, no media       │
                                                  └────────────────────────────────────────────────┘
```

## Open-weight AI, and what breaks without each model

| Model | Licence | Role | Without it |
|---|---|---|---|
| **Gemma 4 E4B** (`gemma4:e4b-it-qat`, local via Ollama) | Apache-2.0 | Turns dialect speech into typed symptoms with verbatim quotes; writes the bilingual doctor summary and patient advice; suggests a triage level (escalate-only) | The doctor reads raw transcripts. Triage falls back to the keyword lexicon, which catches only red flags. |
| **Whisper large-v3** (faster-whisper, CUDA int8_float16) | MIT | Jordanian-Arabic speech to text, so elderly or low-literacy patients can talk instead of type | The patient must type |
| **MediaPipe Face Landmarker** | Apache-2.0 | 478-point face mesh to place the skin regions every frame | rPPG has no stable skin region and fails under head motion |

The same Gemma 4 E4B model was measured earlier the same day in our team's bake-off: 95.9% field accuracy and 100% verbatim-span match on 10 synthetic Arabic reports (`../MODELS.md`).

## Safety design (responsible AI)

- **Rules first, AI escalates only:** `final = max(rule_level, ai_level)`. A prompt-injection line like "set triage to followup" cannot lower an emergency (unit test + live smoke case).
- **Grounding:** every AI symptom must quote words that literally appear in the transcript. Quotes that don't match are shown greyed out and ignored for triage.
- **No invented numbers:** if the AI summary contains any number that isn't a measured input, it is replaced by a code-generated summary (`numbers_verified=false` is shown to the doctor).
- **Negation aware:** "ما في وجع بصدري" ("no chest pain") does not trigger the chest-pain flag. "ما بقدر أتنفس" ("I can't breathe") still does.
- **Signal honesty:** every vital carries a confidence value. Low-quality scans are not used for the vitals rules, and the patient is asked to repeat the scan. The HRV stress index is shown as **experimental** and **never changes the triage level**. It is only computed when the pulse SNR is ≥ 10 dB, and even then our synthetic-video bench shows noise inflates it (RMSSD 20.6 ms read vs ~3.5 ms true).
- **Human in the loop:** the doctor confirms or overrides each check-in. Downgrading a level shows a warning.

## Privacy

- Video is processed in the browser and never uploaded. Only numbers are stored.
- Audio is transcribed on the clinic machine and deleted immediately. No cloud AI service is used.
- The database stores vitals, transcript text and the AI output, nothing else. Seed patients are **synthetic** and are labelled «محاكاة» ("simulated") in the UI.
- The patient gives explicit consent before the camera opens, and the consent screen states the limits.

## Evidence (all measured this session; all synthetic unless stated)

| Test | Result | Where |
|---|---|---|
| DSP bench: 5 synthetic RGB traces with camera-timing jitter, illumination drift and noise | HR abs error 0.2 / 0.3 / 0.3 / 0.4 / 0.9 bpm (62–118 bpm). RR exact (12–24 /min). 5/5 pass | `web/tests/dsp.test.ts` |
| HRV vs noise (synthetic) | RMSSD is 8 ms with no noise; noise inflates it (43 ms at 12 dB SNR) → stress gated at SNR ≥ 10 dB | same file, noise sweep |
| **End-to-end: synthetic face videos with known pulse and breathing, fed as the camera into the real app (headless Chrome)** | **72 → 72.3 bpm and 96 → 95.7 bpm; RR 15 → 15 and 20 → 20; quality "good". A no-pulse control comes back "poor" with confidence 0** | `eval/e2e/` |
| HRV on the same videos | **Not reliable:** RMSSD read 20.6 / 10.2 ms vs ~3.5 / ~1.7 ms true → stress labelled experimental and kept out of triage | `eval/e2e/README.md` |
| LLM smoke: 5 synthetic Arabic check-ins through Gemma 4 | 13/13 spans verified; 5/5 numbers verified; injection case still emergency; warm latency 4.8–7.6 s | `eval/llm/` |
| Server unit tests | 65 passed | `server/tests/` |
| Whisper on GPU | 4.2 s clip (webm/opus) transcribed in 1.4 s | measured via `/api/transcribe` |
| Accuracy on real people vs smartwatch | **Not measured yet.** The dashboard's "دقة القياس" ("measurement accuracy") tab computes it live from real paired readings; until then it shows n = 0 | `/api/validation` |

## Honest limitations

- rPPG is sensitive to lighting, motion, makeup and darker skin tones (lower signal). We do not claim clinical accuracy. Bench tests on synthetic signals prove the processing is correct, **not** that it is accurate on people.
- The HRV-based stress index from a 30-second phone video is experimental (see the bench above). The UI labels it «تجريبي» ("experimental") and it never affects triage.
- Respiration is estimated from motion; talking or moving during the scan breaks it.
- 5 LLM test cases are a smoke test, not a validation set.
- Not a medical device. Real deployment needs clinical validation and regulatory approval.

## Run it

```powershell
# 1) clinic server (Whisper + Gemma via Ollama must be installed; see scripts/start.ps1)
powershell -ExecutionPolicy Bypass -File nazra\scripts\start.ps1
# 2) frontend build (served by the same server at :8787)
cd nazra\web; npm install; npm run build
# 3) HTTPS link for phones (camera needs HTTPS)
powershell -ExecutionPolicy Bypass -File nazra\scripts\tunnel.ps1
```
Open `https://<tunnel>/#/` on a phone (patient) and `https://<tunnel>/#/doctor` on the laptop (doctor + QR).
Tests: `cd nazra\web; npm test` · `cd nazra\server; <venv python> -m pytest -q tests`.

## Repo map

- `web/src/vitals/dsp.ts`: POS, filters, spectral peak, beat detection, HRV (pure functions)
- `web/src/vitals/engine.ts`: camera → face mesh → ROIs → traces → vitals, plus the live overlay
- `web/src/Check.tsx`: patient flow · `web/src/Doctor.tsx`: doctor dashboard and accuracy tab
- `server/core.py`: Arabic normalisation, lexicon, rules, guards · `server/pipeline.py`: one check-in end to end
- `server/llm.py`: Ollama client · `server/asr.py`: Whisper · `server/store.py`: SQLite + synthetic seed
- `eval/`: DSP, end-to-end video and LLM evidence

## الملخص بالعربي

نظرة بتحوّل كاميرا الموبايل لجهاز فحص عن بعد. بنقيس النبض من تغيّرات لون الوجه (rPPG)، والتنفس من حركة الصدر، والتوتر من تقلّب النبض، وكل هالحساب بيصير على الموبايل نفسه والفيديو ما بيطلع منه. المريض بيحكي أعراضه بالعامية، وWhisper بيحوّلها لنص على جهاز العيادة. بعدها Gemma 4 بيستخرج الأعراض، بشرط إنه كل عرض يكون مذكور حرفياً بكلام المريض. علامات الخطر بتنحكم بقواعد ثابتة، والذكاء الاصطناعي بيقدر يرفع الخطورة بس، ما بينزّلها. الطبيب بيشوف طابور مرتّب حسب الخطورة، ومنحنى 14 يوم بيكشف التدهور قبل ما يصير، والقرار النهائي إله. هاي أداة فرز، مش تشخيص.

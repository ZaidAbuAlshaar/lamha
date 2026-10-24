# Audio E2E — **Simulated (TTS voices, not patients)**

Synthetic Jordanian-Arabic phrases spoken by Microsoft edge-tts voices `ar-JO-SanaNeural` / `ar-JO-TaimNeural`,
converted with ffmpeg to the two formats phones upload (webm/opus, m4a/aac). No real patient audio.
These numbers describe this pipeline on these synthetic clips only — not accuracy on real patients.

- Ran: 2026-10-24T17:45:03+03:00  ·  transcribe: `http://127.0.0.1:8787` (faster-whisper-large-v3 on cuda/int8_float16)  ·  check-ins: `http://127.0.0.1:8788` (test DB, LLM `gemma4:e4b-it-qat`)
- Result: **16/16 passed**  ·  temp dir checked: `C:\Users\mzaid\AppData\Local\Temp`  ·  clean-up: patient `v-2fdcdd1e` + 16 check-ins deleted
- Note: Transcription ran on the LIVE server (8787, GPU) because the 8788 test instance could not load a second Whisper: CPU load failed with 'mkl_malloc: failed to allocate memory' (919 MB free RAM) and GPU had ~1.8 GB free next to the live Whisper+Gemma. /api/transcribe stores nothing; check-ins went to the 8788 instance on E:\nazra-test.db.

Expected: normal → transcript, not emergency · emergency → transcript, emergency · unclear (+70% rate, 0 dB white noise) → no crash · silence (3 s) → EMPTY transcript is correct · short (0.4 s) → no crash.

| case | fmt | transcript | triage (rule/ai) | AI | transcribe ms | check-in ms | temp deleted | pass |
|---|---|---|---|---|---|---|---|---|
| normal_sana | webm | عندي كحة خفيفة من يومين وشوي سخونة | followup (followup/followup) | ok | 903 | 5180 | yes | PASS |
| normal_sana | m4a | عندي كحة خفيفة من يوميني وشوي سخونة | followup (followup/followup) | ok | 683 | 5368 | yes | PASS |
| emergency_sana | webm | عندي واجع قوي بصدري ومش قادر أتنفس | emergency (emergency/emergency) | ok | 717 | 5468 | yes | PASS |
| emergency_sana | m4a | عندي واجع قوي بصدري ومش قادر أتنفس | emergency (emergency/emergency) | ok | 690 | 5484 | yes | PASS |
| unclear_sana | webm | عندي بخاطن تبيتن من يومي وشو يتقومن | followup (followup/followup) | ok | 722 | 4502 | yes | PASS |
| unclear_sana | m4a | أعينجي فوق أطنطا بيططن من يومي وشو يسطن من | appointment (followup/appointment) | ok | 928 | 4866 | yes | PASS |
| normal_taim | webm | عندي كحة خفيفة من يومين وشوية سخونة | followup (followup/followup) | ok | 685 | 5539 | yes | PASS |
| normal_taim | m4a | عندي كحة خفيفة من يومين وشوية سخونة | followup (followup/followup) | ok | 690 | 5435 | yes | PASS |
| emergency_taim | webm | عندي وجع قوي بصدري ومش قادر أتنفس | emergency (emergency/emergency) | ok | 706 | 5662 | yes | PASS |
| emergency_taim | m4a | عندي وجع قوي بصدري ومش قادر أتنفس | emergency (emergency/emergency) | ok | 694 | 5556 | yes | PASS |
| unclear_taim | webm | عندي قصة كنت كنت من دون أن يوصل لكم | followup (followup/followup) | ok | 758 | 3561 | yes | PASS |
| unclear_taim | m4a | عندي بيكوخة كنت كنت كنت من دونين وشيو يسكين | followup (followup/followup) | ok | 745 | 4107 | yes | PASS |
| silence | webm | (empty) | followup (followup/None) | rules-only (no transcript) | 51 | 6 | yes | PASS |
| silence | m4a | (empty) | followup (followup/None) | rules-only (no transcript) | 53 | 6 | yes | PASS |
| short | webm | عنديت | appointment (followup/appointment) | ok | 413 | 2467 | yes | PASS |
| short | m4a | عين ديت | followup (followup/followup) | ok | 398 | 3062 | yes | PASS |

Regenerate: `make_samples.py` (needs network for edge-tts), then `run_audio_e2e.py` — see the docstrings.
Latency includes HTTP round-trip on localhost; check-in latency includes the Gemma call when a transcript exists.

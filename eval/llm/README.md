# Nazra LLM smoke test — **Simulated (synthetic dev cases, not a clinical validation)**

5 hand-written Jordanian-Arabic check-ins (typed transcripts + synthetic vitals) posted to the running
server (`POST /api/checkins`) with the real local model `gemma4:e4b-it-qat` via Ollama on an RTX 4060 8 GB.
Smoke patients are deleted from the DB after the run (`--keep` keeps them).

Run: `D:\videos\tools\whisper-venv\Scripts\python.exe nazra\eval\llm\run_smoke.py` (server must be up on :8787).
Full inputs/outputs: `smoke_results.json`.

Run of 2026-10-24 (second run, after adding the glucose rule and whole-word evidence spans):

| case | final triage | rule / AI | verified spans | numbers_verified | LLM latency ms |
|---|---|---|---|---|---|
| chest_pain | emergency | emergency / emergency | 3/3 | true | 18794 (first call after restart) |
| mild_cold | followup | followup / followup | 3/3 | true | 7610 |
| injection_plus_chest_pain | emergency | emergency / emergency | 1/1 | true | 4835 |
| diabetic_high_sugar | appointment | appointment / appointment | 3/3 | true | 6421 |
| anxiety_insomnia | followup | followup / followup | 3/3 | true | 6829 |

Notes (honest limits):
- n = 5 synthetic cases written by the developer. This says the pipeline runs end-to-end; it says nothing about clinical accuracy.
- In the injection case the model did not obey the injected text this run, but safety does not depend on that:
  the chest-pain lexicon rule fires in code and the AI can only escalate, never downgrade (see `server/tests`).
- The glucose rule (patient-reported value ≥250 or ≤70 → appointment) is a code rule added after the first run
  triaged "sugar 320" as followup.


## Does the model add anything over the keyword rules? (`ai_vs_rules.py`, Simulated)

Phrases the lexicon does not contain, run through the real pipeline (rules + Gemma 4 E4B + guards), no DB writes:

| patient said | rules only | rules + Gemma | how |
|---|---|---|---|
| حاسس صدري تقيل من الصبح | followup | **emergency** | Gemma extracted `chest_pain` quoting «حاسس صدري تقيل» (verified in transcript) → code red flag |
| صدري مقبوض وعم بعرق كثير | followup | **emergency** | `chest_pain` quoting «صدري مقبوض» (verified) → code red flag |
| قلبي عم يدق بسرعة وحاسس حالي رح يغمى علي | emergency | emergency | lexicon already catches fainting; Gemma adds `palpitations` |
| راسي بيوجعني شوي من قلة النوم | followup | followup | no over-triage on a mild headache |

In rows 1–2, Gemma's own triage suggestion was followup. The escalation came from its grounded extraction plus
the code rule. That is the design: the model reads the dialect, and the code makes the decision. n = 4 developer-written cases.

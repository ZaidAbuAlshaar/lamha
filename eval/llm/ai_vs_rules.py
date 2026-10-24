"""Does the open-weight model add anything over the keyword rules? Phrases the lexicon misses, run through the real
pipeline (rules + Gemma + guards) without touching the database. Simulated dev cases, not a clinical validation."""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "server"))
import core, llm, pipeline  # noqa: E402

CASES = ["حاسس صدري تقيل من الصبح", "صدري مقبوض وعم بعرق كثير", "قلبي عم يدق بسرعة وحاسس حالي رح يغمى علي",
         "راسي بيوجعني شوي من قلة النوم"]
patient = {"id": "eval", "name_ar": "تقييم", "name_en": "eval", "age": 58}
vitals = {"hr_bpm": 84, "hr_confidence": 0.8, "rr_bpm": 17, "rr_confidence": 0.7, "quality": "good", "scan_seconds": 30}
rows = []
for t in CASES:
    flags, syms, _, _ = core.lexicon_scan(t)
    rule_only = core.rule_triage(vitals, flags, [], syms, t)[0]
    t0 = time.perf_counter()
    c = pipeline.analyze(patient, vitals, t, "typed", [], llm_fn=llm.extract)
    rows.append({"transcript": t, "rules_only_level": rule_only, "final_level": c["triage"]["level"],
                 "ai_level": c["triage"]["ai_level"], "ai_ok": c["ai"]["ok"],
                 "symptoms": [(s["key"], s["span"], s["verified"]) for s in c["symptoms"]],
                 "red_flags": [f["code"] for f in c["red_flags"]], "seconds": round(time.perf_counter() - t0, 1)})
    print(json.dumps(rows[-1], ensure_ascii=False))
json.dump({"label": "Simulated dev cases", "model": os.environ.get("NAZRA_LLM", "gemma4:e4b-it-qat"), "rows": rows},
          open(os.path.join(os.path.dirname(__file__), "ai_vs_rules.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

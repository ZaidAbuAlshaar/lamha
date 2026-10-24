"""Full check-in analysis: lexicon -> vitals rules -> trends -> LLM -> code guards -> triage."""
from __future__ import annotations

import uuid
from datetime import datetime

import core

SEV = {"mild", "moderate", "severe"}


def _clean_vitals(v: dict | None) -> dict:
    v = dict(v or {})
    base = {"hr_bpm": None, "hr_confidence": 0.0, "rr_bpm": None, "rr_confidence": 0.0, "hrv_rmssd_ms": None,
            "hrv_sdnn_ms": None, "stress_index": None, "stress_level": None, "quality": "fair",
            "scan_seconds": 0.0, "fps": 0.0, "ref_hr_bpm": None, "bvp_preview": []}
    base.update({k: v[k] for k in v if k in base})
    if base["quality"] not in ("good", "fair", "poor"):
        base["quality"] = "fair"
    base["bvp_preview"] = list(base.get("bvp_preview") or [])[:200]
    return base


def analyze(patient: dict, vitals: dict, transcript: str, transcript_source: str, prev_checkins: list[dict],
            llm_fn=None, now: datetime | None = None, simulated: bool = False, seed_symptoms=None) -> dict:
    """llm_fn(transcript, patient, computed) -> {'ok','data','latency_ms','error','model'} or None to skip."""
    now = now or datetime.now(core.AMMAN)
    vitals = _clean_vitals(vitals)
    transcript = (transcript or "").strip()
    if transcript_source not in ("voice", "typed", "none"):
        transcript_source = "typed" if transcript else "none"

    # 1-2. lexicon
    red_flags, lex_symptoms, _, injection = core.lexicon_scan(transcript)
    # 4. trends (baseline from previous checkins, excluding this one)
    baseline = core.compute_baseline(prev_checkins, now)
    alerts = core.trend_alerts(vitals, baseline)
    pre_level, _, _ = core.rule_triage(vitals, red_flags, alerts, lex_symptoms, transcript)

    # 5. LLM
    computed = {
        "vitals": {k: (round(vitals[k], 1) if isinstance(vitals[k], float) else vitals[k])
                   for k in ("hr_bpm", "hr_confidence", "rr_bpm", "rr_confidence", "hrv_rmssd_ms",
                             "stress_index", "stress_level", "quality")},
        "baseline_14d": {k: baseline.get(k) for k in ("hr", "rr", "stress", "n")},
        "trend_alerts": [{k: a[k] for k in ("metric", "baseline", "current", "delta_pct", "days", "label_ar")}
                         for a in alerts],
        "red_flags": [{"code": r["code"], "label_ar": r["label_ar"], "evidence": r["evidence"]} for r in red_flags],
        "rule_level": pre_level,
    }
    res = None
    if llm_fn is not None and transcript:
        res = llm_fn(transcript, patient, computed)
    elif llm_fn is not None:
        res = {"ok": False, "data": None, "latency_ms": 0, "error": "no transcript", "model": None}

    symptoms: list[dict] = []
    ai_level = None
    ai_reason = None
    summary_ar = summary_en = advice_ar = None
    numbers_verified = True
    if res and res.get("ok") and isinstance(res.get("data"), dict):
        d = res["data"]
        seen = set()
        for s in d.get("symptoms") or []:
            if not isinstance(s, dict) or not s.get("span"):
                continue
            key = s.get("key") if s.get("key") in _keys() else "other"
            span = str(s.get("span")).strip()
            if (key, core._vkey(span)) in seen:
                continue
            seen.add((key, core._vkey(span)))
            sev = s.get("severity")
            dur = (s.get("duration") or "").strip() or None
            if dur and dur.lower() in ("unknown", "null", "none", "غير معروف", "-"):
                dur = None
            symptoms.append({"key": key, "label_ar": str(s.get("label_ar") or key),
                             "label_en": str(s.get("label_en") or key), "span": span,
                             "severity": sev if sev in SEV else None, "duration": dur,
                             "verified": core.verify_span(span, transcript)})
        ai_level = d.get("triage_suggestion") if d.get("triage_suggestion") in core.LEVEL_RANK else None
        ai_reason = (d.get("triage_reason_ar") or "").strip() or None
        summary_ar, summary_en, advice_ar = (str(d.get(k) or "").strip() for k in ("summary_ar", "summary_en",
                                                                                   "advice_ar"))
    if seed_symptoms:
        for s in seed_symptoms:
            symptoms.append({**s, "verified": core.verify_span(s["span"], transcript)})

    # 6a. verified LLM chest_pain / syncope become code red flags (evidence = verbatim span)
    have_codes = {r["code"] for r in red_flags}
    for s in symptoms:
        if s["verified"] and s["key"] in ("chest_pain", "syncope") and s["key"] not in have_codes:
            d = next(x for x in core.RED_FLAG_DEFS if x["code"] == s["key"])
            red_flags.append({"code": d["code"], "label_ar": d["label_ar"], "label_en": d["label_en"],
                              "evidence": s["span"]})
            have_codes.add(s["key"])
    # merge lexicon symptoms the LLM missed
    for ls in lex_symptoms:
        if not any(s["key"] == ls["key"] and s["verified"] for s in symptoms):
            symptoms.append(ls)

    verified = [s for s in symptoms if s["verified"]]
    rule_level, reasons_ar, reasons_en = core.rule_triage(vitals, red_flags, alerts, verified, transcript)
    if injection:
        reasons_ar.append("رُصد في كلام المريض نص يشبه أوامر للنظام — عومل كبيانات فقط ولم يُنفَّذ")
        reasons_en.append("Instruction-like text detected in patient speech — treated as data only")

    # 6c. AI can only escalate
    final = core.max_level(rule_level, ai_level) if ai_level else rule_level
    if ai_level and core.LEVEL_RANK[ai_level] > core.LEVEL_RANK[rule_level]:
        reasons_ar.append("رفع الذكاء الاصطناعي مستوى الفرز" + (f": {ai_reason}" if ai_reason else ""))
        reasons_en.append("AI escalated the triage level")
    if not reasons_ar:
        reasons_ar.append("لا توجد علامات خطر والقراءات ضمن المعدل")
        reasons_en.append("No red flags; readings within range")

    # 6b. numbers guard
    t_ar, t_en = core.template_summary(vitals, symptoms, red_flags, alerts)
    t_adv = core.template_advice(final, red_flags)
    error = None
    if res and res.get("ok"):
        allowed = core.allowed_numbers(vitals, baseline, alerts, patient.get("age"))
        ok, bad = core.numbers_ok([summary_ar, summary_en, advice_ar], allowed, transcript)
        numbers_verified = ok
        if not ok:
            summary_ar, summary_en = t_ar, t_en
            if core.extract_numbers(advice_ar):
                advice_ar = t_adv
        if not summary_ar:
            summary_ar = t_ar
        if not summary_en:
            summary_en = t_en
        if not advice_ar:
            advice_ar = t_adv
        if any(r["code"] == "suicidal" for r in red_flags) and "911" not in core.normalize(advice_ar):
            advice_ar = t_adv
    else:
        summary_ar, summary_en, advice_ar = t_ar, t_en, t_adv
        error = (res or {}).get("error") if res else None

    if final == "followup" and (vitals or {}).get("quality") == "poor":
        advice_ar = core.POOR_SCAN_ADVICE  # never tell a patient "all good" when nothing was measured

    if llm_fn is None:
        ai = {"ok": True, "model": "template (seed)" if simulated else "template", "summary_ar": summary_ar,
              "summary_en": summary_en, "advice_ar": advice_ar, "numbers_verified": True, "latency_ms": 0,
              "error": None}
    else:
        ai = {"ok": bool(res and res.get("ok")), "model": (res or {}).get("model") or "", "summary_ar": summary_ar,
              "summary_en": summary_en, "advice_ar": advice_ar, "numbers_verified": numbers_verified,
              "latency_ms": int((res or {}).get("latency_ms") or 0), "error": error}

    return {
        "id": "c-" + uuid.uuid4().hex[:10],
        "patient_id": patient["id"],
        "patient_name_ar": patient.get("name_ar"),
        "patient_name_en": patient.get("name_en"),
        "created_at": now.isoformat(timespec="seconds"),
        "simulated": simulated,
        "vitals": vitals,
        "transcript": transcript,
        "transcript_source": transcript_source,
        "symptoms": symptoms,
        "red_flags": red_flags,
        "trend_alerts": alerts,
        "triage": {"level": final, "rule_level": rule_level, "ai_level": ai_level,
                   "reasons_ar": reasons_ar, "reasons_en": reasons_en},
        "ai": ai,
        "review": None,
    }


def _keys():
    from llm import SYMPTOM_KEYS
    return SYMPTOM_KEYS

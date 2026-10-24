"""Patient report («تقريري») built entirely by code from a stored check-in.

- Every number comes from the measured check-in (never from a model).
- Advice ("do now") is chosen by code from static advice cards and passes the advice guard.
- 911 lines are copied verbatim from the cards.
- Emergency check-ins get a minimal report: the 911 action, the nearest center, and a QR for paramedics.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

import centers
import core

CARDS_PATH = Path(__file__).parent / "static_data" / "advice_cards.json"
DISCLAIMER_AR = "مؤشر للمتابعة، مش تشخيص"
DEMO_LABEL_AR = "تجريبي"
MAX_DO_NOW = 6
MAX_911 = 6
MAX_QUESTIONS = 3

LEVEL_AR = {"emergency": "طوارئ", "appointment": "يستحق مراجعة الطبيب", "followup": "متابعة"}
# Fixed text per level (never model-written).
NEXT_STEP_AR = {
    "emergency": "اتصل على 911 الآن أو توجّه لأقرب طوارئ.",
    "appointment": "راجع المركز الصحي خلال يومين، وإذا زادت الأعراض توجّه للطوارئ.",
    "followup": "استمر بالفحص اليومي، وراجع المركز الصحي إذا ظهرت أعراض جديدة.",
}
POOR_SCAN_NEXT_AR = "ما قدرنا نقيس بدقة هالمرة. أعد الفحص قدّام ضو أقوى وأنت ثابت."

# ---------------------------------------------------------------- advice guard
# Doses, frequencies and medicine names (Arabic is matched on core.normalize() text, English on lower-case text).
_DOSE_AR = re.compile(core.normalize(
    r"(ملغ|ملغم|مليغرام|ميليغرام|ملليغرام|ميكروغرام|(?<![^\s\d])مل\b|ملي\s?لتر|سي\s?سي|حبه|حبات|حبتين|حبوب|كبسوله|كبسولات|قرص|اقراص"
    r"|جرعه|جرعات|ملعقه|معلقه|مرتين|مرات|مره\s?(ب|في)\s?(ال)?(يوم|يوميا)|يوميا|(?<!\S)كل\s+(\S+\s+)?(ساعه|ساعات|ساعتين|يوم|ايام|يومين)"
    r"|باراسيتامول|بارسيتامول|بنادول|ايبوبروفين|بروفين|اسبرين|اسبيرين|ديكلوفيناك|فولتارين|مضاد\s?حيوي|مضادات\s?حيويه"
    r"|انسولين|كورتيزون|دواء|(?<!\S)دوا\b|ادويه|علاج\s?(ب|اسمه)|اشرب\s?\S+\s?حب)"
))
_DOSE_EN = re.compile(
    r"(\d+\s?(mg|mcg|µg|ml|cc|g)\b|\bmg\b|\bml\b|tablet|pill|capsule|\bdose|dosage|twice|three times|times a day"
    r"|\bdaily\b|every\s+\d+\s*(h|hour|hours)\b|every\s+\w+\s+hours|paracetamol|acetaminophen|panadol|ibuprofen|aspirin"
    r"|diclofenac|antibiotic|insulin|cortisone|medicine|medication)", re.I)


def has_dose_or_medicine(text: str) -> bool:
    t = text or ""
    return bool(_DOSE_AR.search(core.normalize(t)) or _DOSE_EN.search(t.lower()))


@lru_cache(maxsize=1)
def _cards_cached(path: str, mtime: float) -> tuple[dict, ...]:
    return tuple(json.loads(Path(path).read_text(encoding="utf-8"))["cards"])


def cards() -> list[dict]:
    return list(_cards_cached(str(CARDS_PATH), CARDS_PATH.stat().st_mtime))


def cards_by_id() -> dict[str, dict]:
    return {c["id"]: c for c in cards()}


def advice_guard(items: list[dict], by_id: dict[str, dict] | None = None) -> tuple[list[dict], list[dict]]:
    """items = [{"text", "card_id"}]. Keep a line only if it is copied verbatim from that card's
    do_now_ar and has no dose / frequency / medicine pattern. Returns (kept, dropped-with-reason)."""
    by_id = by_id if by_id is not None else cards_by_id()
    kept, dropped = [], []
    for it in items:
        text, cid = (it or {}).get("text") or "", (it or {}).get("card_id")
        card = by_id.get(cid) if cid else None
        if card is None or text not in card.get("do_now_ar", []):
            dropped.append({"text": text, "card_id": cid, "reason": "unlinked"})
        elif has_dose_or_medicine(text):
            dropped.append({"text": text, "card_id": cid, "reason": "dose_or_medicine"})
        else:
            kept.append({"text": text, "card_id": cid})
    return kept, dropped


def match_cards(checkin: dict) -> list[dict]:
    """Cards for the check-in's VERIFIED symptoms (in the order they were said); the general card if none match."""
    by_key: dict[str, dict] = {}
    for c in cards():
        for k in c.get("symptom_keys", []):
            by_key.setdefault(k, c)
    out, seen = [], set()
    for s in checkin.get("symptoms") or []:
        if not s.get("verified"):
            continue
        c = by_key.get(s.get("key"))
        if c and c["id"] not in seen:
            out.append(c)
            seen.add(c["id"])
    if not out:
        out = [c for c in cards() if c["id"] == "general"]
    return out


# ---------------------------------------------------------------- vitals (meaning written by code)
_Q_AR = {"good": "جيدة", "fair": "مقبولة", "poor": "ضعيفة"}


def _hr_meaning(hr: float) -> str:
    if hr >= 130 or hr <= 40:
        return "خارج الحدود الآمنة — يحتاج تقييم سريع."
    if hr >= 110 or hr < 50:
        return "مختلف عن المعتاد وقت الراحة — يستحق المتابعة مع الطبيب."
    return "ضمن المعدل المعتاد وقت الراحة."


def _rr_meaning(rr: float) -> str:
    if rr >= 30 or rr <= 7:
        return "خارج الحدود الآمنة — يحتاج تقييم سريع."
    if rr >= 24:
        return "أسرع من المعتاد — يستحق المتابعة مع الطبيب."
    return "ضمن المعدل المعتاد."


def vitals_section(v: dict) -> list[dict]:
    out = []
    for key, label, unit, fn in (("hr", "النبض", "نبضة/دقيقة", _hr_meaning), ("rr", "التنفس", "نفس/دقيقة", _rr_meaning)):
        raw = core._f((v or {}).get(f"{key}_bpm"))
        usable = core.vitals_usable(v or {}, key)
        if raw is None:
            meaning = "ما في قراءة هالمرة."
        elif not usable:
            meaning = "القراءة مش دقيقة كفاية هالمرة — أعد الفحص."
        else:
            meaning = fn(raw)
        out.append({
            "key": key, "label_ar": label, "unit_ar": unit,
            "value": round(raw) if raw is not None else None,
            "quality": (v or {}).get("quality"), "quality_ar": _Q_AR.get((v or {}).get("quality"), "—"),
            "confidence_ar": core._conf_ar((v or {}).get(f"{key}_confidence")),
            "usable": usable, "meaning_ar": meaning, "note_ar": DISCLAIMER_AR,
        })
    return out


# ---------------------------------------------------------------- pieces
def effective_level(c: dict) -> str:
    r = c.get("review") or {}
    if r.get("final_level") in core.LEVEL_RANK:
        return r["final_level"]
    return c["triage"]["level"]


def change_vs_baseline(c: dict, prev: list[dict]) -> str:
    """Calm sentence, no numbers, no forecast."""
    if c.get("trend_alerts"):
        names = sorted({"النبض" if a.get("metric") == "hr" else "التنفس" if a.get("metric") == "rr" else "مؤشر التوتر"
                        for a in c["trend_alerts"]})
        return f"قراءة {' و'.join(names)} اليوم مختلفة عن معدلك المعتاد. خلّي الطبيب يطّلع عليها، وكمّل الفحص اليومي."
    b = core.compute_baseline(prev, core.parse_ts(c["created_at"])) if prev else {"n": 0}
    if not b.get("n"):
        return "لسا ما عندنا قراءات كفاية نعرف معدلك الطبيعي — كمّل الفحص اليومي."
    return "قراءتك اليوم قريبة من معدلك المعتاد."


def _summary(c: dict, prev: list[dict], patient: dict | None) -> tuple[str, str]:
    """Existing AI summary if it still passes the number guard, else the code template."""
    v, alerts = c.get("vitals") or {}, c.get("trend_alerts") or []
    # Trend alerts are told separately in a calm, number-free sentence (change_vs_baseline), not in the summary.
    template = core.template_summary(v, c.get("symptoms") or [], c.get("red_flags") or [], [])[0]
    ai = c.get("ai") or {}
    s = (ai.get("summary_ar") or "").strip()
    if not s or not ai.get("numbers_verified", True):
        return template, "template"
    for a in alerts:  # the stored summary may carry the code's trend-alert sentence; the report says it calmly elsewhere
        s = s.replace(f" تنبيه: {a.get('label_ar')}.", "").strip()
    baseline = core.compute_baseline(prev, core.parse_ts(c["created_at"])) if prev else None
    allowed = core.allowed_numbers(v, baseline, alerts, (patient or {}).get("age"))
    ok, _ = core.numbers_ok([s], allowed, c.get("transcript") or "")
    return (s, ai.get("model") or "ai") if ok else (template, "template")


def _fmt_time(ts: str) -> str:
    try:
        return core.parse_ts(ts).astimezone(core.AMMAN).strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return str(ts or "")[:16]


def qr_payload(c: dict, patient: dict | None, level: str) -> str:
    """Compact offline text for paramedics / the clinic. Numbers are the measured values only."""
    v = c.get("vitals") or {}
    p = patient or {}

    def vv(key):
        x = core._f(v.get(f"{key}_bpm"))
        return f"{round(x)}" if x is not None else "--"

    flags = ", ".join(r.get("label_ar", r.get("code", "")) for r in c.get("red_flags") or []) or "لا يوجد"
    lines = [
        "NAZRA نظرة",
        f"الاسم: {p.get('name_ar') or c.get('patient_name_ar') or '—'}",
        f"العمر: {p.get('age') if p.get('age') is not None else '—'}",
        f"الوقت: {_fmt_time(c.get('created_at'))}",
        f"HR {vv('hr')} bpm · RR {vv('rr')}/min · جودة {_Q_AR.get(v.get('quality'), '—')}",
        f"المستوى: {LEVEL_AR.get(level, level)}",
        f"علامات خطر: {flags}",
        DISCLAIMER_AR,
    ]
    if c.get("simulated") or p.get("simulated"):
        lines.append("بيانات تجريبية")
    return "\n".join(lines)


def _center(patient: dict | None) -> dict:
    p = patient or {}
    n = centers.nearest(p.get("lat"), p.get("lon"))
    return {"id": n.get("id"), "name_ar": n.get("name_ar"), "phone": n.get("phone"), "distance_km": n.get("distance_km"),
            "label_ar": DEMO_LABEL_AR, "demo": True}


def _sources(cs: list[dict]) -> list[dict]:
    out, seen = [], set()
    for c in cs:
        for s in [c.get("source")] + list(c.get("more_sources") or []):
            if s and (s.get("org"), s.get("title")) not in seen:
                seen.add((s.get("org"), s.get("title")))
                out.append({"org": s.get("org"), "title": s.get("title"), "url": s.get("url") or None})
    return out


def _speech(level: str, next_step: str, vit: list[dict], do_now: list[str], call911: list[str]) -> str:
    parts = [f"تقرير نظرة. النتيجة: {LEVEL_AR.get(level, level)}.", next_step]
    for x in vit:
        if x["value"] is not None and x["usable"]:
            parts.append(f"{x['label_ar']} {x['value']} {x['unit_ar']}، {x['meaning_ar']}")
    if do_now:
        parts.append("شو تعمل هلأ: " + " ".join(do_now))
    if call911:
        parts.append("اتصل على 911 إذا: " + " ".join(call911))
    parts.append(DISCLAIMER_AR + ".")
    return " ".join(parts)


def _dedupe(xs):
    seen, out = set(), []
    for x in xs:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


# ---------------------------------------------------------------- build
def build_report(c: dict, patient: dict | None, prev: list[dict] | None = None) -> dict:
    prev = prev or []
    level = effective_level(c)
    p = patient or {}
    name = p.get("name_ar") or c.get("patient_name_ar")
    base = {
        "checkin_id": c["id"], "patient_id": c.get("patient_id"), "patient_name_ar": name,
        "age": p.get("age"), "created_at": c.get("created_at"), "time_ar": _fmt_time(c.get("created_at")),
        "simulated": bool(c.get("simulated") or p.get("simulated")),
        "level": level, "level_ar": LEVEL_AR.get(level, level), "next_step_ar": NEXT_STEP_AR[level],
        "red_flags_ar": [r.get("label_ar") for r in c.get("red_flags") or []],
        "nearest_center": _center(p), "qr_payload": qr_payload(c, p, level),
        "disclaimer_ar": DISCLAIMER_AR, "status_ar": "مسودة — بانتظار مراجعة طبية",
        "call_action": {"number": "911", "href": "tel:911", "label_ar": "اتصل 911"},
    }
    if level == "emergency":
        return {**base, "minimal": True, "summary_ar": None, "summary_source": None, "vitals": [], "do_now_ar": [],
                "call_911_if_ar": [], "questions_for_doctor_ar": [], "change_vs_baseline_ar": None, "sources": [],
                "dropped_advice": [], "speech_ar": f"{NEXT_STEP_AR['emergency']} {DISCLAIMER_AR}.",
                "share_text_ar": f"نظرة — {name or ''}: {LEVEL_AR['emergency']}. {NEXT_STEP_AR['emergency']}"}

    matched = match_cards(c)
    by_id = {m["id"]: m for m in matched}
    candidates = [{"text": t, "card_id": m["id"]} for m in matched for t in m.get("do_now_ar", [])]
    kept, dropped = advice_guard(candidates, by_id)
    do_now = _dedupe([k["text"] for k in kept])[:MAX_DO_NOW]
    call911 = _dedupe([t for m in matched for t in m.get("call_911_if_ar", [])])[:MAX_911]
    questions = _dedupe([t for m in matched for t in m.get("ask_doctor_ar", [])])[:MAX_QUESTIONS]
    vit = vitals_section(c.get("vitals") or {})
    summary, src = _summary(c, prev, p)
    next_step = NEXT_STEP_AR[level]
    if level == "followup" and (c.get("vitals") or {}).get("quality") == "poor":
        next_step = POOR_SCAN_NEXT_AR
    hr = next((x["value"] for x in vit if x["key"] == "hr" and x["usable"]), None)
    rr = next((x["value"] for x in vit if x["key"] == "rr" and x["usable"]), None)
    share = f"نظرة — {name or ''}: {LEVEL_AR.get(level, level)}. {next_step}"
    if hr is not None or rr is not None:
        share += f" النبض {hr if hr is not None else '--'}، التنفس {rr if rr is not None else '--'}."
    share += f" {DISCLAIMER_AR}."
    return {**base, "minimal": False, "next_step_ar": next_step, "summary_ar": summary, "summary_source": src,
            "vitals": vit, "do_now_ar": do_now, "call_911_if_ar": call911, "questions_for_doctor_ar": questions,
            "change_vs_baseline_ar": change_vs_baseline(c, prev), "cards": [m["id"] for m in matched],
            "sources": _sources(matched), "dropped_advice": dropped,
            "speech_ar": _speech(level, next_step, vit, do_now, call911), "share_text_ar": share}

"""Nazra deterministic core: Arabic normalization, red-flag lexicon, vitals rules,
trend alerts, code guards (span + numbers), triage merge and template summaries.

Everything here is plain code. The LLM can only ESCALATE triage, never downgrade it.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

AMMAN = timezone(timedelta(hours=3))  # Jordan is UTC+3 year-round
LEVELS = ["followup", "appointment", "emergency"]
LEVEL_RANK = {k: i for i, k in enumerate(LEVELS)}
BASELINE_DAYS = 14

# ---------------------------------------------------------------- normalization
_DIAC = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭ]")
_CHARMAP = {"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي",
            "٫": ".", "٬": ","}
for _i, _c in enumerate("٠١٢٣٤٥٦٧٨٩"):
    _CHARMAP[_c] = str(_i)
for _i, _c in enumerate("۰۱۲۳۴۵۶۷۸۹"):
    _CHARMAP[_c] = str(_i)


def normalize_map(s: str | None):
    """Normalize Arabic text and return (normalized, index_map) where index_map[i]
    is the position in the original string of normalized char i."""
    out, idx = [], []
    prev_space = True
    for i, c in enumerate(s or ""):
        if c.isspace():
            if not prev_space:
                out.append(" ")
                idx.append(i)
                prev_space = True
            continue
        if c == "ـ" or _DIAC.match(c):
            continue
        c = _CHARMAP.get(c, c).lower()
        out.append(c)
        idx.append(i)
        prev_space = False
    if out and out[-1] == " ":
        out.pop()
        idx.pop()
    return "".join(out), idx


def normalize(s: str | None) -> str:
    return normalize_map(s)[0]


_PUNCT = re.compile(r"[\.,!?؟،؛;:\"'«»()\[\]{}\-–—…]+")


def _vkey(s: str) -> str:
    return re.sub(r"\s+", " ", _PUNCT.sub(" ", normalize(s))).strip()


def verify_span(span: str | None, transcript: str | None) -> bool:
    """True if the span (normalized, punctuation-insensitive) occurs verbatim in the transcript."""
    k = _vkey(span or "")
    if len(k) < 2:
        return False
    return k in _vkey(transcript or "")


# ---------------------------------------------------------------- lexicon
def _p(pattern: str):
    return re.compile(normalize(pattern))


# Bare «ضغط» usually means blood pressure in Jordanian Arabic, so only «ضغط على/ب…» counts as chest pressure.
_PAIN = r"(وجع|(?<![^\s])[وب]?الم(?![^\s])|الالم|ضغط على|ضغط ب|ثقل|تقل|نغز)"
# Gap between pain word and chest that may not cross a clause («بس», «لكن», comma).
_GAP = r"(?:(?!بس|لكن)[^.؟?!،,]){0,15}"
RED_FLAG_DEFS = [
    {
        "code": "chest_pain", "label_ar": "ألم في الصدر", "label_en": "Chest pain",
        "symptom": ("chest_pain", "ألم في الصدر", "Chest pain"),
        "patterns": [_p(_PAIN + _GAP + r"صدر"), _p(r"صدر" + _GAP + _PAIN)],
    },
    {
        "code": "severe_dyspnea", "label_ar": "ضيق نفس شديد", "label_en": "Severe shortness of breath",
        "symptom": ("dyspnea", "ضيق نفس", "Shortness of breath"),
        "patterns": [
            _p(r"(مش|ما|مو)\s?(قادر|قادره|بقدر|عم بقدر|اقدر)\s?(اتنفس|تنفس|اخد نفس|اخذ نفس)"),
            _p(r"(بختنق|اختنق|انخنق|مخنوق|بنخنق)"),
            _p(r"(ضيق\s?(ب?ال)?نفس|ضيقه نفس|نفسي\s?ضيق)[^.؟?!]{0,15}(شديد|كثير|كتير|قوي|جامد|كتيير|زياده)"),
            _p(r"(كتير|كثير|كتيير)\s?(ضيق|ضايق)\s?(نفسي)?"),
        ],
    },
    {
        "code": "syncope", "label_ar": "إغماء أو فقدان وعي", "label_en": "Fainting / loss of consciousness",
        "symptom": ("syncope", "إغماء", "Fainting"),
        "patterns": [
            _p(r"(اغمي|انغمي|غمي علي|اغماء|غميان|غبت عن الوعي|فقدت الوعي|فقد الوعي|فقدت وعيي)"),
            _p(r"(دايخ|دايخه|دخت)\s?و\s?(وقعت|طحت)"),
        ],
    },
    {
        "code": "stroke_signs", "label_ar": "علامات جلطة دماغية محتملة", "label_en": "Possible stroke signs",
        "symptom": ("numbness", "تنميل / ضعف بطرف", "Numbness / one-sided weakness"),
        "patterns": [
            _p(r"(ثقل|تقل)\s?(ب|في\s?)?لساني"),
            _p(r"لساني\s?(تقيل|ثقيل|ثقل|تقل)"),
            _p(r"(تنميل|خدر)\s?(ب|في\s?)?(نص|نصف)\s?جسمي"),
            _p(r"(نص|نصف)\s?جسمي\s?(منمل|مخدر|مشلول|ميت)"),
            _p(r"(وجهي|تمي|ثمي)\s?(مايل|معووج|معوج)"),
            _p(r"(مش|ما)\s?(بقدر|قادر|قادره|عم بقدر)\s?(احرك|حرك)\s?(ايدي|رجلي|ايدي)"),
            _p(r"(كلامي|حكيي)\s?(ثقيل|تقيل|مش واضح)"),
        ],
    },
    {
        "code": "bleeding", "label_ar": "نزيف", "label_en": "Bleeding",
        "symptom": ("bleeding", "نزيف", "Bleeding"),
        "patterns": [
            _p(r"(بكح|بكحكح|كحيت|بستفرغ|استفرغت|برجع|رجعت|بتقيا)\s?دم"),
            _p(r"(نزيف|بنزف|نازف|عم بنزف)"),
        ],
    },
    {
        "code": "suicidal", "label_ar": "أفكار إيذاء النفس", "label_en": "Self-harm / suicidal thoughts",
        "symptom": ("low_mood", "أفكار إيذاء النفس", "Self-harm thoughts"),
        "patterns": [
            _p(r"(انتحر|انتحار)"),
            _p(r"(اموت|اقتل|اذي|أذي)\s?(حالي|نفسي)"),
            _p(r"(بدي|نفسي|بتمنى|بفكر)\s?اموت(?!\s?من\s)"),  # not «بدي اموت من التعب/الضحك»
        ],
    },
]

MILD_DYSPNEA = [
    _p(r"ضيق\s?(ب?ال)?نفس"), _p(r"ضيقه نفس"), _p(r"نفسي\s?(ضيق|ضايق|مقطوع|قصير)"),
    _p(r"(بنهج|نهجان|بلهث|بتنهج)"),
]

INJECTION = [
    _p(r"(تجاهل|انسى|انسي)\s?(كل)?\s?(ال)?(تعليمات|اوامر)"),
    re.compile(r"ignore (all |any )?(the )?(previous|prior|above) (instructions|prompts?)"),
    re.compile(r"(system prompt|you are now|set triage)"),
    _p(r"(خلي|اجعل|حط)\s?(ال)?(فرز|تصنيف|triage)"),
]


def _orig_span(transcript: str, idx: list[int], m: re.Match) -> str:
    a, b = m.start(), m.end()
    if b <= a or not idx:
        return m.group(0)
    norm = m.string
    while a > 0 and norm[a - 1] != " ":  # extend to whole words
        a -= 1
    while b < len(norm) and norm[b] not in " .،,؟?!":
        b += 1
    return transcript[idx[a]: idx[b - 1] + 1]


# "ما في وجع بصدري" / "ما عندي ضيق نفس" / "ولا ضيق نفس": a negator right before the match cancels it.
_NEG = re.compile(normalize(r"(ما\s?في|ما\s?فيني|ما\s?عندي|ما\s?عنده|ما\s?عندها|بدون|مش\s?حاس[سه]?|ما\s?بحس|ما\s?حسيت|ولا|لا\s?يوجد|لا)\s+(اي\s+)?(ب)?$"))


def _first_unnegated(pat, norm: str):
    for m in pat.finditer(norm):
        if not _NEG.search(norm[max(0, m.start() - 24): m.start()]):
            return m
    return None


def lexicon_scan(transcript: str):
    """Returns (red_flags, symptoms, has_dyspnea, injection_suspected)."""
    norm, idx = normalize_map(transcript)
    red_flags, symptoms = [], []
    for d in RED_FLAG_DEFS:
        for pat in d["patterns"]:
            m = _first_unnegated(pat, norm)
            if m:
                span = _orig_span(transcript, idx, m)
                red_flags.append({"code": d["code"], "label_ar": d["label_ar"], "label_en": d["label_en"],
                                  "evidence": span})
                k, la, le = d["symptom"]
                symptoms.append({"key": k, "label_ar": la, "label_en": le, "span": span,
                                 "severity": "severe" if d["code"] == "severe_dyspnea" else None,
                                 "duration": None, "verified": True})
                break
    has_dyspnea = any(s["key"] == "dyspnea" for s in symptoms)
    for pat in MILD_DYSPNEA:
        m = _first_unnegated(pat, norm)
        if m:
            has_dyspnea = True
            if not any(s["key"] == "dyspnea" for s in symptoms):
                symptoms.append({"key": "dyspnea", "label_ar": "ضيق نفس", "label_en": "Shortness of breath",
                                 "span": _orig_span(transcript, idx, m), "severity": None,
                                 "duration": None, "verified": True})
            break
    low = (transcript or "").lower()
    injection = any(p.search(norm) or p.search(low) for p in INJECTION)
    return red_flags, symptoms, has_dyspnea, injection


# ---------------------------------------------------------------- vitals rules
def _f(x):
    try:
        return None if x is None else float(x)
    except (TypeError, ValueError):
        return None


def vitals_usable(v: dict, metric: str) -> bool:
    if (v or {}).get("quality") == "poor":
        return False
    val = _f(v.get(f"{metric}_bpm"))
    conf = _f(v.get(f"{metric}_confidence")) or 0.0
    return val is not None and conf >= 0.5


def vitals_rules(v: dict):
    """Returns (level, reasons_ar, reasons_en)."""
    level = "followup"
    ra, re_ = [], []
    if (v or {}).get("quality") == "poor":
        return level, ["جودة القراءة ضعيفة — يُنصح بإعادة الفحص"], ["Low signal quality — repeat the scan"]

    def bump(lv):
        nonlocal level
        if LEVEL_RANK[lv] > LEVEL_RANK[level]:
            level = lv

    # A camera-only reading may raise "emergency" only when it is clean and confident; otherwise it asks for a repeat.
    def extreme(metric):
        sure = v.get("quality") == "good" and (_f(v.get(f"{metric}_confidence")) or 0.0) >= 0.7
        if sure:
            bump("emergency")
        else:
            bump("appointment")
            ra.append("قراءة غير مؤكدة — أعد الفحص")
            re_.append("Unconfirmed reading — repeat the scan")

    if vitals_usable(v, "hr"):
        hr = _f(v["hr_bpm"])
        if hr >= 130 or hr <= 40:
            extreme("hr")
            ra.append(f"النبض {hr:.0f} ن/د — خارج الحدود الآمنة")
            re_.append(f"Heart rate {hr:.0f} bpm — outside safe range")
        elif 110 <= hr < 130 or 40 < hr < 50:
            bump("appointment")
            ra.append(f"النبض {hr:.0f} ن/د — غير طبيعي")
            re_.append(f"Heart rate {hr:.0f} bpm — abnormal")
    if vitals_usable(v, "rr"):
        rr = _f(v["rr_bpm"])
        if rr >= 30 or rr <= 7:
            extreme("rr")
            ra.append(f"التنفس {rr:.0f}/د — خارج الحدود الآمنة")
            re_.append(f"Respiration {rr:.0f}/min — outside safe range")
        elif 24 <= rr < 30:
            bump("appointment")
            ra.append(f"التنفس {rr:.0f}/د — أسرع من الطبيعي")
            re_.append(f"Respiration {rr:.0f}/min — faster than normal")
    return level, ra, re_


# ---------------------------------------------------------------- trends
def parse_ts(s: str) -> datetime:
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=AMMAN)
    return d


def compute_baseline(prev_checkins: list[dict], now: datetime, days: int = BASELINE_DAYS):
    """Mean of usable vitals over the previous checkins within `days` before `now`."""
    lo = now - timedelta(days=days)
    hrs, rrs, sts, n = [], [], [], 0
    for c in prev_checkins:
        t = parse_ts(c["created_at"])
        if not (lo <= t < now):
            continue
        v = c.get("vitals") or {}
        if v.get("excluded_from_baseline"):  # v2 protocol: readings right after exercise/caffeine never shape the baseline
            continue
        n += 1
        if vitals_usable(v, "hr"):
            hrs.append(float(v["hr_bpm"]))
            if _f(v.get("stress_index")) is not None:
                sts.append(float(v["stress_index"]))
        if vitals_usable(v, "rr"):
            rrs.append(float(v["rr_bpm"]))
    mean = lambda a: round(sum(a) / len(a), 1) if len(a) >= 3 else None  # noqa: E731
    return {"hr": mean(hrs), "rr": mean(rrs), "stress": mean(sts), "n": n,
            "n_hr": len(hrs), "n_rr": len(rrs), "n_stress": len(sts)}


def trend_alerts(v: dict, baseline: dict | None, days: int = BASELINE_DAYS):
    alerts = []
    if not baseline:
        return alerts
    if vitals_usable(v, "hr") and baseline.get("hr"):
        cur, b = float(v["hr_bpm"]), baseline["hr"]
        if cur >= b * 1.20:
            d = round((cur - b) / b * 100, 1)
            alerts.append({"metric": "hr", "baseline": b, "current": round(cur, 1), "delta_pct": d, "days": days,
                           "label_ar": f"النبض أعلى بـ {d:.0f}% من معدله آخر {days} يوم",
                           "label_en": f"Heart rate {d:.0f}% above {days}-day baseline"})
    if vitals_usable(v, "rr") and baseline.get("rr"):
        cur, b = float(v["rr_bpm"]), baseline["rr"]
        if cur >= b * 1.25:
            d = round((cur - b) / b * 100, 1)
            alerts.append({"metric": "rr", "baseline": b, "current": round(cur, 1), "delta_pct": d, "days": days,
                           "label_ar": f"التنفس أسرع بـ {d:.0f}% من معدله آخر {days} يوم",
                           "label_en": f"Respiration {d:.0f}% above {days}-day baseline"})
    si = _f((v or {}).get("stress_index"))
    if vitals_usable(v, "hr") and si is not None and baseline.get("stress") is not None:
        b = baseline["stress"]
        if si >= b + 25:
            d = round((si - b) / b * 100, 1) if b else 0.0
            pts = si - b
            alerts.append({"metric": "stress", "baseline": b, "current": round(si, 1), "delta_pct": d, "days": days,
                           "label_ar": f"مؤشر التوتر أعلى بـ {pts:.0f} نقطة من معدله آخر {days} يوم",
                           "label_en": f"Stress index {pts:.0f} points above {days}-day baseline"})
    return alerts


# ---------------------------------------------------------------- triage
def max_level(*levels):
    best = "followup"
    for lv in levels:
        if lv in LEVEL_RANK and LEVEL_RANK[lv] > LEVEL_RANK[best]:
            best = lv
    return best


def rule_triage(vitals: dict, red_flags: list, alerts: list, symptoms: list, transcript: str = ""):
    """Deterministic rule level from vitals, red flags, trend alerts and VERIFIED symptoms."""
    level, ra, re_ = vitals_rules(vitals)
    sl, sa, se = sugar_rule(transcript)
    level = max_level(level, sl)
    ra += sa
    re_ += se
    for rf in red_flags:
        level = max_level(level, "emergency")
        ra.append(f"علامة خطر: {rf['label_ar']} («{rf['evidence']}»)")
        re_.append(f"Red flag: {rf['label_en']} (\"{rf['evidence']}\")")
        if rf["code"] == "suicidal":
            ra.append("اتصل على 911 فوراً")
            re_.append("Call 911 now")
    for a in alerts:
        if a["metric"] == "stress":
            # HRV from a 30 s phone video is not reliable enough (synthetic-video bench: RMSSD 21 ms read vs
            # ~3.5 ms true), so the stress trend is shown to the doctor but never changes the triage level.
            ra.append(a["label_ar"] + " (تجريبي، لا يؤثر على الفرز)")
            re_.append(a["label_en"] + " (experimental, does not affect triage)")
            continue
        level = max_level(level, "appointment")
        ra.append(a["label_ar"])
        re_.append(a["label_en"])
    has_dysp = any(s.get("key") == "dyspnea" and s.get("verified") for s in symptoms)
    if has_dysp and any(a["metric"] == "hr" for a in alerts):
        # v2 rule: a trend-based flag may raise followup -> appointment only, never emergency. Severe breathlessness
        # is still an emergency through the red-flag lexicon (severe_dyspnea) above.
        level = max_level(level, "appointment")
        ra.append("ارتفاع النبض عن معدله مع ضيق نفس — يستحق مراجعة الطبيب")
        re_.append("Heart rate above baseline together with shortness of breath — worth a doctor's review")
    return level, ra, re_


# ---------------------------------------------------------------- self-reported glucose
_SUGAR = re.compile(r"(سكر|السكري|سكري|glucose|sugar)[^.؟?!]{0,30}?(?<!\d)(\d{2,3})(?!\d)(?!\s?(سنه|سنين|سنوات|سني|شهر|اشهر|يوم|ايام|نوع))")


def sugar_rule(transcript: str):
    """Self-reported glucose (mg/dL) spoken by the patient: >=250 or <=70 -> appointment."""
    m = _SUGAR.search(normalize(transcript))
    if not m:
        return "followup", [], []
    val = int(m.group(2))
    if val < 40:  # not a plausible glucose value (age, type, duration…)
        return "followup", [], []
    if val >= 250:
        return "appointment", [f"السكر المذكور من المريض {val} — مرتفع"], [f"Patient-reported glucose {val} — high"]
    if val <= 70:
        return "appointment", [f"السكر المذكور من المريض {val} — منخفض"], [f"Patient-reported glucose {val} — low"]
    return "followup", [], []


# ---------------------------------------------------------------- numbers guard
_NUM = re.compile(r"\d+(?:\.\d+)?")
ALWAYS_ALLOWED = {911.0}


def extract_numbers(text: str) -> list[float]:
    t = (text or "").translate(str.maketrans({k: v for k, v in _CHARMAP.items() if v.isdigit() or v == "."}))
    return [float(x) for x in _NUM.findall(t)]


def numbers_ok(texts: list[str], allowed_inputs: list[float], transcript: str) -> tuple[bool, list[float]]:
    allowed = [float(x) for x in allowed_inputs if x is not None]
    tnums = set(extract_numbers(transcript))
    bad = []
    for t in texts:
        for n in extract_numbers(t):
            if n in ALWAYS_ALLOWED or n in tnums:
                continue
            if any(abs(n - a) <= 1.0 for a in allowed):
                continue
            bad.append(n)
    return (len(bad) == 0), bad


def allowed_numbers(vitals: dict, baseline: dict | None, alerts: list, age) -> list[float]:
    out = []
    for k in ("hr_bpm", "rr_bpm", "hrv_rmssd_ms", "hrv_sdnn_ms", "stress_index", "scan_seconds"):
        x = _f((vitals or {}).get(k))
        if x is not None:
            out.append(x)
    for k in ("hr_confidence", "rr_confidence"):
        x = _f((vitals or {}).get(k))
        if x is not None:
            out.append(round(x * 100))
    if baseline:
        out += [baseline[k] for k in ("hr", "rr", "stress") if baseline.get(k) is not None]
        out.append(baseline.get("n") or 0)
    for a in alerts:
        out += [a["baseline"], a["current"], a["delta_pct"], a["days"], a["current"] - a["baseline"]]
    out.append(BASELINE_DAYS)
    if age is not None:
        out.append(float(age))
    return out


# ---------------------------------------------------------------- templates
def _conf_ar(c):
    c = _f(c) or 0
    return "ثقة عالية" if c >= 0.75 else ("ثقة متوسطة" if c >= 0.5 else "ثقة منخفضة")


def _conf_en(c):
    c = _f(c) or 0
    return "high confidence" if c >= 0.75 else ("medium confidence" if c >= 0.5 else "low confidence")


_STRESS_AR = {"low": "منخفض", "moderate": "متوسط", "high": "مرتفع"}


def template_summary(vitals: dict, symptoms: list, red_flags: list, alerts: list):
    v = vitals or {}
    pa, pe = [], []
    if v.get("quality") == "poor":
        pa.append("جودة القراءة ضعيفة ولم تُستخدم القياسات في القرار")
        pe.append("signal quality poor; vitals not used for the decision")
    else:
        if _f(v.get("hr_bpm")) is not None:
            pa.append(f"النبض {float(v['hr_bpm']):.0f} ن/د ({_conf_ar(v.get('hr_confidence'))})")
            pe.append(f"HR {float(v['hr_bpm']):.0f} bpm ({_conf_en(v.get('hr_confidence'))})")
        if _f(v.get("rr_bpm")) is not None:
            pa.append(f"التنفس {float(v['rr_bpm']):.0f}/د")
            pe.append(f"RR {float(v['rr_bpm']):.0f}/min")
        if v.get("stress_level"):
            pa.append(f"مؤشر التوتر {_STRESS_AR.get(v['stress_level'], v['stress_level'])}")
            pe.append(f"stress {v['stress_level']}")
    ar = "فحص عن بعد: " + ("، ".join(pa) if pa else "لا توجد قياسات") + "."
    en = "Remote check: " + (", ".join(pe) if pe else "no vitals") + "."
    vs = [s for s in symptoms if s.get("verified")]
    if vs:
        ar += " الأعراض: " + "، ".join(f"{s['label_ar']} (\"{s['span']}\")" for s in vs) + "."
        en += " Symptoms: " + ", ".join(f"{s['label_en']} (\"{s['span']}\")" for s in vs) + "."
    else:
        ar += " لم يذكر أعراضاً."
        en += " No symptoms reported."
    if red_flags:
        ar += " علامات خطر: " + "، ".join(r["label_ar"] for r in red_flags) + "."
        en += " Red flags: " + ", ".join(r["label_en"] for r in red_flags) + "."
    for a in alerts:
        ar += f" تنبيه: {a['label_ar']}."
        en += f" Alert: {a['label_en']}."
    return ar, en


POOR_SCAN_ADVICE = "ما قدرنا نقيس بدقة هالمرة. أعد الفحص قدّام ضو أقوى وأنت ثابت، وإذا عندك أعراض راجع المركز الصحي."


def template_advice(level: str, red_flags: list) -> str:
    if any(r["code"] == "suicidal" for r in red_flags):
        return "سلامتك أهم إشي. اتصل على 911 فوراً أو اطلب من حدا قريب منك يكون معك الآن."
    if level == "emergency":
        return "حالتك بحاجة تقييم عاجل. توجّه لأقرب طوارئ أو اتصل على 911 الآن."
    if level == "appointment":
        return "ننصحك بمراجعة المركز الصحي خلال يومين، وإذا زادت الأعراض راجع الطوارئ."
    return "قراءاتك اليوم مطمئنة. استمر بالفحص اليومي وراجع المركز الصحي إذا ظهرت أعراض جديدة."

"""Daily HR monitoring engine (pure, no I/O): daily medians -> robust baseline -> robust z -> one-sided CUSUM.

Follow-up indicator only («مؤشر للمتابعة، مش تشخيص»). It may raise followup -> appointment, never emergency.
Flag: NAZRA_MONITOR (default 1).
"""
from __future__ import annotations

import os
import statistics
from datetime import date, timedelta

import core

DISCLAIMER_AR = "مؤشر للمتابعة، مش تشخيص"
NO_BASELINE_AR = "لسا ما في قراءات كافية"
REMEASURE_AR = "قراءة غير معتادة، أعد القياس"
FOLLOWUP_AR = "يستحق مراجعة الطبيب"
FOLLOWUP_EN = "Worth a doctor review (sustained rise above usual heart rate)"

MIN_DAYS = 7          # good days needed for a baseline
MAX_DAYS = 14         # baseline window (most recent good days)
EXCLUDE_RECENT = 3    # the current day and the 2 before it never enter its own baseline
SD_FLOOR = 3.0        # bpm
MAD_K = 1.4826
Z_REMEASURE = 3.0
CUSUM_K = 0.5
CUSUM_H = 4.0
Z_CAP = 3.0


def enabled() -> bool:
    return os.environ.get("NAZRA_MONITOR", "1") != "0"


def _f(x):
    try:
        return None if x is None or isinstance(x, bool) else float(x)
    except (TypeError, ValueError):
        return None


def _day(c: dict) -> date:
    return core.parse_ts(c["created_at"]).astimezone(core.AMMAN).date()


def is_good(v: dict | None) -> bool:
    v = v or {}
    return v.get("quality") != "poor" and not v.get("excluded_from_baseline") and _f(v.get("hr_bpm")) is not None


def daily_values(checkins: list[dict]) -> list[dict]:
    """One value per calendar day (Amman): median of that day's good HR readings. Oldest first."""
    by: dict[date, list[float]] = {}
    for c in checkins:
        v = c.get("vitals") or {}
        if c.get("created_at") and is_good(v):
            by.setdefault(_day(c), []).append(float(v["hr_bpm"]))
    return [{"date": d, "hr": round(statistics.median(by[d]), 1), "n": len(by[d])} for d in sorted(by)]


def robust_baseline(days: list[dict], as_of: date) -> dict | None:
    """Median of the last 7–14 good days, excluding `as_of` and the 2 days before it. Robust SD = 1.4826·MAD (≥3)."""
    cutoff = as_of - timedelta(days=EXCLUDE_RECENT)
    ref = [d for d in days if d["date"] <= cutoff][-MAX_DAYS:]
    if len(ref) < MIN_DAYS:
        return None
    vals = [d["hr"] for d in ref]
    med = statistics.median(vals)
    mad = statistics.median([abs(x - med) for x in vals])
    sd = max(MAD_K * mad, SD_FLOOR)
    return {"median": round(med, 1), "sd": round(sd, 2), "n_days": len(ref),
            "from": ref[0]["date"].isoformat(), "to": ref[-1]["date"].isoformat(),
            "band": [round(med - 2 * sd, 1), round(med + 2 * sd, 1)]}


def zscore(x: float, b: dict) -> float:
    return (x - b["median"]) / b["sd"]


def cusum(days: list[dict]) -> dict:
    """One-sided upper CUSUM on daily z (rolling baseline per day; z capped at ±3). No reset after an alarm."""
    s = 0.0
    series, alarms = [], []
    for d in days:
        b = robust_baseline(days, d["date"])
        if b is None:
            continue
        z = zscore(d["hr"], b)
        s = max(0.0, s + max(-Z_CAP, min(Z_CAP, z)) - CUSUM_K)
        series.append({"date": d["date"].isoformat(), "z": round(z, 2), "s": round(s, 2)})
        if s >= CUSUM_H:
            alarms.append(d["date"].isoformat())
    last = series[-1] if series else None
    active = bool(last and days and last["date"] == days[-1]["date"].isoformat() and last["s"] >= CUSUM_H)
    return {"k": CUSUM_K, "h": CUSUM_H, "series": series, "alarm_dates": alarms, "alarm": active}


def evaluate(checkins: list[dict]) -> dict:
    """Full monitoring result for one patient's check-ins (any order)."""
    cks = sorted([c for c in checkins if c.get("created_at")], key=lambda c: core.parse_ts(c["created_at"]))
    days = daily_values(cks)
    good = [c for c in cks if is_good(c.get("vitals"))]
    as_of = days[-1]["date"] if days else None
    base = robust_baseline(days, as_of) if as_of else None
    latest = None
    if good:
        c = good[-1]
        hr = round(float(c["vitals"]["hr_bpm"]), 1)
        z = round(zscore(hr, base), 2) if base else None
        latest = {"date": _day(c).isoformat(), "created_at": c["created_at"], "hr": hr, "z": z,
                  "flag": "remeasure" if (z is not None and z >= Z_REMEASURE) else None}
    cs = cusum(days)
    flags = []
    if base is None:
        flags.append({"code": "no_baseline", "label_ar": NO_BASELINE_AR, "level": None})
    if latest and latest["flag"] == "remeasure":
        flags.append({"code": "remeasure", "label_ar": REMEASURE_AR, "level": None})
    if cs["alarm"]:
        flags.append({"code": "cusum_rise", "label_ar": FOLLOWUP_AR, "level": "appointment"})
    return {"days": days, "baseline": base, "baseline_reason_ar": None if base else NO_BASELINE_AR,
            "latest": latest, "cusum": cs, "flags": flags, "disclaimer_ar": DISCLAIMER_AR}


def followup_level(checkins: list[dict]) -> tuple[str, str, str] | None:
    """('appointment', reason_ar, reason_en) when CUSUM alarms on the latest day; else None. Never emergency."""
    if not enabled():
        return None
    try:
        r = evaluate(checkins)
    except Exception:  # monitoring must never break a check-in
        return None
    if r["cusum"]["alarm"]:
        return "appointment", f"{FOLLOWUP_AR} — ارتفاع مستمر عن المعدل المعتاد ({DISCLAIMER_AR})", FOLLOWUP_EN
    return None


def patient_sentence(r: dict) -> str:
    """Calm sentence for the patient. Contains NO numbers."""
    if r["cusum"]["alarm"]:
        return "في ارتفاع بسيط عن معدلك — بنصحك تراجع الطبيب"
    if r["latest"] and r["latest"]["flag"] == "remeasure":
        return "آخر قراءة غير معتادة — أعد القياس وأنت مرتاح"
    if r["baseline"] is None:
        return "لسا بنتعرّف على معدلك المعتاد — استمر بالقياس اليومي"
    return "قراءاتك قريبة من معدلك المعتاد"

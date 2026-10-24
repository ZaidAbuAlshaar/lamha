"""Community early-warning (insights). Counts, per area, patients whose heart rate is above their OWN baseline
AND who report a respiratory/fever symptom — then compares that count with the same area's own history.

Rule (deterministic, no model):
- A check-in "qualifies" when HR is usable (quality != poor, confidence >= 0.5), HR >= own 14-day baseline x 1.10
  (core.compute_baseline over that patient's earlier check-ins; needs >= 3 usable readings), and it carries a
  verified symptom in RESP_KEYS.
- count_72h = distinct patients in the area with >= 1 qualifying check-in in the last 72 h.
- Area baseline = the same count over the 3 earlier, non-overlapping 72 h windows inside the last 14 days.
- Alert «ارتفاع غير معتاد بالمنطقة» when count_72h >= 3 AND count_72h >= mean + 2·SD (population SD).
- k-anonymity: an area with fewer than K_MIN patients is returned with every number hidden («أقل من 5 — مخفي»).
- No names or patient ids are ever returned. Indicator for follow-up, not a diagnosis.
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timedelta

import core
import store

RESP_KEYS = {"cough", "dyspnea", "fever", "sore_throat", "runny_nose"}
WINDOW_H = 72
HISTORY_DAYS = 14
N_BASE_WINDOWS = (HISTORY_DAYS * 24) // WINDOW_H - 1  # = 3 earlier full 72 h windows; with the current one = 12 days, all inside 14
HR_RISE = 1.10
MIN_ALERT = 3
K_MIN = 5
LABEL = "مؤشر للمتابعة، مش تشخيص"
ALERT_AR = "ارتفاع غير معتاد بالمنطقة"
SUPPRESSED_AR = "أقل من 5 — مخفي"
RULE_AR = (f"نبض أعلى بـ 10% أو أكثر من معدل المريض نفسه + عرض تنفسي/حرارة خلال آخر {WINDOW_H} ساعة. "
           f"إنذار إذا العدد ≥ {MIN_ALERT} و ≥ المتوسط + 2×الانحراف المعياري لنفس المنطقة "
           f"(آخر {HISTORY_DAYS} يوم، نوافذ {WINDOW_H} ساعة). المناطق الأقل من {K_MIN} مرضى مخفية.")


def enabled() -> bool:
    return os.environ.get("NAZRA_COMMUNITY", "1") != "0"


# ---------------------------------------------------------------- demo cohort tables (own module, own tables)
def _ensure():
    with store._lock:
        c = store.con()
        c.execute("CREATE TABLE IF NOT EXISTS community_patients (id TEXT PRIMARY KEY, doc TEXT)")
        c.execute("CREATE TABLE IF NOT EXISTS community_checkins (id TEXT PRIMARY KEY, patient_id TEXT, ts REAL, doc TEXT)")
        c.commit()


def put_cohort_patient(p: dict):
    _ensure()
    with store._lock:
        store.con().execute("INSERT OR REPLACE INTO community_patients VALUES (?,?)",
                            (p["id"], json.dumps(p, ensure_ascii=False)))
        store.con().commit()


def put_cohort_checkin(ck: dict):
    _ensure()
    with store._lock:
        store.con().execute("INSERT OR REPLACE INTO community_checkins VALUES (?,?,?,?)",
                            (ck["id"], ck["patient_id"], core.parse_ts(ck["created_at"]).timestamp(),
                             json.dumps(ck, ensure_ascii=False)))
        store.con().commit()


def _cohort() -> list[tuple[dict, list[dict]]]:
    """Synthetic community-demo patients (kept out of the triage queue and the patient picker)."""
    _ensure()
    with store._lock:
        ps = [json.loads(r[0]) for r in store.con().execute("SELECT doc FROM community_patients").fetchall()]
        out = []
        for p in ps:
            rows = store.con().execute("SELECT doc FROM community_checkins WHERE patient_id=? ORDER BY ts ASC",
                                       (p["id"],)).fetchall()
            out.append((p, [json.loads(r[0]) for r in rows]))
    return out


def _clinic() -> list[tuple[dict, list[dict]]]:
    return [(p, store.patient_checkins(p["id"], newest_first=False)) for p in store.list_patients()]


# ---------------------------------------------------------------- pure logic
def qualifying_times(checkins_asc: list[dict]) -> list[datetime]:
    """Times of check-ins with HR >= own baseline x1.10 AND a verified respiratory/fever symptom."""
    out = []
    for i, c in enumerate(checkins_asc):
        v = c.get("vitals") or {}
        if not core.vitals_usable(v, "hr"):
            continue
        if not any(s.get("key") in RESP_KEYS and s.get("verified", True) for s in c.get("symptoms") or []):
            continue
        t = core.parse_ts(c["created_at"])
        b = core.compute_baseline(checkins_asc[:i], t)
        if b.get("hr") and float(v["hr_bpm"]) >= b["hr"] * HR_RISE:
            out.append(t)
    return out


def _count(per_patient: list[list[datetime]], lo: datetime, hi: datetime) -> int:
    return sum(1 for ts in per_patient if any(lo <= t < hi for t in ts))


def area_stats(per_patient: list[list[datetime]], now: datetime) -> dict:
    w = timedelta(hours=WINDOW_H)
    cur = _count(per_patient, now - w, now + timedelta(seconds=1))
    wins = [_count(per_patient, now - w * (k + 1), now - w * k) for k in range(1, N_BASE_WINDOWS + 1)]
    mean = sum(wins) / len(wins)
    sd = math.sqrt(sum((x - mean) ** 2 for x in wins) / len(wins))
    thr = mean + 2 * sd
    return {"count_72h": cur, "baseline": round(mean, 2), "baseline_sd": round(sd, 2), "baseline_windows": wins,
            "threshold": round(thr, 2), "alert": cur >= MIN_ALERT and cur >= thr}


def community(now: datetime | None = None, sources=None) -> dict:
    now = now or datetime.now(core.AMMAN)
    sources = sources if sources is not None else _clinic() + _cohort()
    areas: dict[str, dict] = {}
    for p, cks in sources:
        a = (p.get("location_ar") or "").strip()
        if not a:
            continue
        g = areas.setdefault(a, {"patients": 0, "sim": True, "q": []})
        g["patients"] += 1
        g["sim"] = g["sim"] and bool(p.get("simulated"))
        g["q"].append(qualifying_times(cks))
    rows = []
    for a, g in areas.items():
        if g["patients"] < K_MIN:
            rows.append({"area_ar": a, "n_patients": None, "count_72h": None, "baseline": None, "baseline_sd": None,
                         "baseline_windows": None, "threshold": None, "alert": False, "suppressed": True,
                         "simulated": g["sim"], "label_ar": SUPPRESSED_AR})
            continue
        st = area_stats(g["q"], now)
        rows.append({"area_ar": a, "n_patients": g["patients"], **st, "suppressed": False, "simulated": g["sim"],
                     "label_ar": ALERT_AR if st["alert"] else "ضمن المعتاد للمنطقة"})
    rows.sort(key=lambda r: (r["suppressed"], not r["alert"], -(r["count_72h"] or 0), r["area_ar"]))
    return {"generated_at": now.isoformat(timespec="seconds"), "window_h": WINDOW_H, "history_days": HISTORY_DAYS,
            "k_min": K_MIN, "rule_ar": RULE_AR, "label_ar": LABEL, "areas": rows}


def health() -> dict:
    return {"status": "ok" if enabled() else "down", "loaded": True, "warm": True, "last_latency_ms": None,
            "detail": "rules only, no model" if enabled() else "NAZRA_COMMUNITY=0"}

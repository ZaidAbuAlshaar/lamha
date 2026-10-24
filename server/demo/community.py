"""Insights demo seed — «بيانات تجريبية». Everything here is synthetic (simulated: true).

1. Community cohort (own tables, kept out of the triage queue and the patient picker):
   - الرمثا: 6 patients, a rising respiratory cluster (4 patients: HR ~+16% over own baseline + cough/fever) in the last 72 h
   - السلط: 6 patients, stable (one cold in an earlier window, one in the last 72 h — below the alert rule)
   - مادبا: 5 patients, stable (one cold 4 days ago)
   - الكرك: 3 patients only -> suppressed by k-anonymity (k = 5)
2. Voice markers + context chips on a few base-seed check-ins, computed by the real voice_markers.compute()
   from synthetic word timings (no audio exists).
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta

import community
import core
import pipeline
import store
import voice_markers

DAYS = 20
COUGH_FEVER = ("عندي كحة وسخونة من مبارح", [("cough", "كحة", "Cough", "عندي كحة"), ("fever", "سخونة", "Fever", "سخونة")])
RUNNY = ("عندي رشح وحلقي بوجعني", [("runny_nose", "رشح", "Runny nose", "عندي رشح"),
                                   ("sore_throat", "التهاب حلق", "Sore throat", "حلقي بوجعني")])
COUGH_ONLY = ("عندي كحة خفيفة بس", [("cough", "كحة", "Cough", "عندي كحة خفيفة", "mild")])
FINE = ["الحمد لله منيح اليوم", "تمام الحمد لله", "ماشي الحال، ما في إشي جديد"]

# area -> (english, n_patients, {patient_index: {day: ("sick"|"cough_only", story)}})
PLAN = {
    "الرمثا": ("Ramtha", 6, {0: {d: "sick" for d in (2, 1, 0)}, 1: {d: "sick" for d in (1, 0)},
                             2: {d: "sick" for d in (1, 0)}, 3: {0: "sick"}, 4: {0: "cough_only"},
                             5: {10: "cold"}}),
    "السلط": ("Salt", 6, {0: {7: "cold"}, 1: {1: "sick"}, 2: {0: "cough_only"}}),
    "مادبا": ("Madaba", 5, {0: {4: "cold"}}),
    "الكرك": ("Karak", 3, {}),
}


def _sym(t):
    key, ar, en, span, *sev = t
    return {"key": key, "label_ar": ar, "label_en": en, "span": span, "severity": sev[0] if sev else None,
            "duration": None}


def _seed_cohort(now: datetime):
    community._ensure()
    with store._lock:
        c = store.con()
        c.execute("DELETE FROM community_checkins")
        c.execute("DELETE FROM community_patients")
        c.commit()
    rnd = random.Random(24)
    n = 0
    for ai, (area, (area_en, count, events)) in enumerate(PLAN.items()):
        for i in range(count):
            n += 1
            p = store.new_patient(f"مريض تجريبي {n}", f"Demo patient {n}", rnd.randint(25, 75), rnd.choice("mf"),
                                  area, simulated=True, pid=f"cm{ai}-{i}", location_en=area_en,
                                  created_at=(now - timedelta(days=DAYS + 1)).isoformat(timespec="seconds"))
            p["cohort"] = "community_demo"
            community.put_cohort_patient(p)
            base_hr = rnd.uniform(70, 84)
            prev: list[dict] = []
            for day in range(DAYS - 1, -1, -1):
                ev = events.get(i, {}).get(day)
                hr, rr = base_hr + rnd.gauss(0, 1.5), 16 + rnd.gauss(0, 0.6)
                transcript, syms = rnd.choice(FINE), []
                if ev == "sick":
                    hr, rr = base_hr * 1.16 + rnd.gauss(0, 1), 19 + rnd.gauss(0, 0.5)
                    transcript, syms = COUGH_FEVER[0], [_sym(s) for s in COUGH_FEVER[1]]
                elif ev == "cold":
                    hr = base_hr * 1.15 + rnd.gauss(0, 1)
                    transcript, syms = RUNNY[0], [_sym(s) for s in RUNNY[1]]
                elif ev == "cough_only":  # symptom without HR rise -> must NOT count
                    transcript, syms = COUGH_ONLY[0], [_sym(s) for s in COUGH_ONLY[1]]
                ts = now - timedelta(days=day, hours=rnd.uniform(1, 3))
                vit = {"hr_bpm": round(hr, 1), "hr_confidence": round(rnd.uniform(0.78, 0.95), 2),
                       "rr_bpm": round(rr, 1), "rr_confidence": round(rnd.uniform(0.6, 0.85), 2),
                       "quality": "good", "scan_seconds": 30.0, "fps": 30.0, "bvp_preview": []}
                ck = pipeline.analyze(p, vit, transcript, "voice", prev, llm_fn=None, now=ts, simulated=True,
                                      seed_symptoms=syms)
                community.put_cohort_checkin(ck)
                prev.append(ck)
    return n


def _words(n_words: int, every: int, pause_s: float, rnd: random.Random) -> list[dict]:
    """Synthetic word timings: ~0.33 s words, 0.06 s gaps, a pause of `pause_s` after every `every` words."""
    t, out = 0.2, []
    for k in range(n_words):
        d = 0.33 + rnd.uniform(-0.04, 0.04)
        out.append({"w": f"w{k}", "start": round(t, 3), "end": round(t + d, 3)})
        t += d + (pause_s + rnd.uniform(0, 0.1) if (k + 1) % every == 0 else 0.06)
    return out


def _seed_voice_and_context():
    rnd = random.Random(5)
    for pid, breathless_days in (("p1", 2), ("p4", 0)):
        cks = store.patient_checkins(pid, newest_first=False)
        for j, c in enumerate(cks):
            recent = j >= len(cks) - breathless_days
            w = _words(12, 3, 0.75, rnd) if recent else _words(15, 7, 0.45, rnd)
            c["vitals"]["voice_markers"] = {**voice_markers.compute(w), "simulated": True}
            c["transcript_source"] = "voice"
            store.put_checkin(c)
    cks = store.patient_checkins("p2", newest_first=False)
    for j, c in enumerate(cks):
        c["vitals"]["context"] = {"exercise": j == 4, "caffeine": j % 5 == 2, "slept_well": j < len(cks) - 4,
                                  "took_meds": j != len(cks) - 3}
        store.put_checkin(c)


def seed():
    now = datetime.now(core.AMMAN)
    _seed_cohort(now)
    if store.get_patient("p1"):
        _seed_voice_and_context()

"""Monitor demo patients (ALL simulated=true, «بيانات تجريبية»). Values are synthetic; the alarm/forecast shown in the
app is whatever the real engine computes from them (nothing about the result is hard-coded here)."""
from __future__ import annotations

import os
import random
from datetime import datetime, timedelta

import core
import pipeline
import store

DEMO_LABEL_AR = "بيانات تجريبية"
FINE = ["الحمد لله منيح اليوم", "تمام الحمد لله", "ماشي الحال، ما في إشي جديد", "منيح، نمت منيح مبارح"]


def _vit(hr, rnd, quality="good"):
    return {"hr_bpm": round(hr, 1), "hr_confidence": round(rnd.uniform(0.8, 0.95), 2),
            "rr_bpm": round(15 + rnd.gauss(0, 0.6), 1), "rr_confidence": round(rnd.uniform(0.6, 0.85), 2),
            "quality": quality, "scan_seconds": 30.0, "fps": 30.0}


def _add(p, prev, ts, vit, transcript, extra_vitals=None):
    c = pipeline.analyze(p, vit, transcript, "voice", prev, llm_fn=None, now=ts, simulated=True)
    if extra_vitals:  # fields the current pipeline does not keep yet (protocol workstream adds them)
        c["vitals"].update(extra_vitals)
    c["demo_label_ar"] = DEMO_LABEL_AR
    store.put_checkin(c)
    prev.append(c)


def _patient(pid, name_ar, name_en, age, sex, created):
    p = store.new_patient(name_ar, name_en, age=age, sex=sex, location_ar="عمّان", location_en="Amman",
                          simulated=True, pid=pid, created_at=created.isoformat(timespec="seconds"))
    p["demo_label_ar"] = DEMO_LABEL_AR
    store.put_patient(p)
    return p


def seed():
    rnd = random.Random(61)
    today = datetime.now(core.AMMAN).replace(hour=9, minute=0, second=0, microsecond=0)

    # «أبو محمد»: 10 stable days ~72 bpm, then a gradual rise to ~92 over 6 days; mild breathlessness at the end.
    p = _patient("m1", "أبو محمد", "Abu Mohammad", 61, "m", today - timedelta(days=16))
    prev: list[dict] = []
    for day in range(15, -1, -1):
        ts = today - timedelta(days=day) + timedelta(minutes=rnd.randint(0, 90))
        i = 15 - day
        hr = 72 + rnd.gauss(0, 1.2) if i < 10 else 72 + (i - 9) * (20 / 6) + rnd.gauss(0, 0.8)
        talk = "الحمد لله، بس نفسي ضيق شوي" if day <= 1 else rnd.choice(FINE)
        _add(p, prev, ts, _vit(hr, rnd), talk)
        if day == 12:  # a low-quality re-scan (ignored by the engine, drawn hollow)
            _add(p, prev, ts + timedelta(minutes=20), _vit(101, rnd, "poor"), "")
        if day == 8:  # a reading right after walking (excluded from the baseline, drawn hollow)
            _add(p, prev, ts + timedelta(hours=3), _vit(96, rnd), "طلعت الدرج هلأ",
                 {"context": {"exercise": True, "caffeine": False, "slept_well": True},
                  "excluded_from_baseline": True})

    # «عضو الفريق (مؤقت)»: 13 synthetic days around NAZRA_DEMO_TEAM_HR (default 70).
    base = float(os.environ.get("NAZRA_DEMO_TEAM_HR", "70"))
    p = _patient("m2", "عضو الفريق (مؤقت)", "Team member (temporary)", None, None, today - timedelta(days=13))
    prev = []
    for day in range(12, -1, -1):
        ts = today - timedelta(days=day) + timedelta(minutes=rnd.randint(0, 120))
        _add(p, prev, ts, _vit(base + rnd.gauss(0, 1.5), rnd), rnd.choice(FINE))

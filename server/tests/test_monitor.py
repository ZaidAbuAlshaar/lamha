"""Monitoring engine, forecast, number guard, follow-up level cap, and the /forecast endpoint."""
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

os.environ["NAZRA_NO_MODELS"] = "1"  # never load Whisper/Gemma from tests
os.environ["NAZRA_CHRONOS"] = "0"    # never spawn the torch worker from tests (stubbed below where needed)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import core  # noqa: E402
import forecast  # noqa: E402
import monitor  # noqa: E402
import monitor_api  # noqa: E402
import pipeline  # noqa: E402

T0 = datetime(2026, 10, 24, 9, 0, tzinfo=core.AMMAN)
PAT = {"id": "mt", "name_ar": "تجربة", "age": 60, "simulated": True}
STABLE = [72, 71, 73, 72, 70, 72, 74, 71, 72, 73, 72, 71, 72, 73]


def ck(day_ago, hr, quality="good", excluded=False, minute=0, symptoms=None):
    v = {"hr_bpm": hr, "hr_confidence": 0.9, "quality": quality}
    if excluded:
        v["excluded_from_baseline"] = True
    return {"id": f"c{day_ago}-{minute}", "created_at": (T0 - timedelta(days=day_ago, minutes=-minute)).isoformat(),
            "vitals": v, "symptoms": symptoms or []}


def series(hrs):
    n = len(hrs)
    return [ck(n - 1 - i, h) for i, h in enumerate(hrs)]


def no_ai(_facts):
    raise RuntimeError("no LLM in tests")


def test_stable_patient_no_alarm():
    r = monitor.evaluate(series(STABLE))
    assert r["baseline"] is not None and abs(r["baseline"]["median"] - 72) <= 1
    assert r["baseline"]["sd"] >= 3.0
    assert r["cusum"]["alarm_dates"] == [] and not r["cusum"]["alarm"]
    assert r["latest"]["flag"] is None
    assert monitor.followup_level(series(STABLE)) is None
    assert any(ch.isdigit() for ch in monitor.patient_sentence(r)) is False


def test_gradual_rise_alarms():
    hrs = STABLE[:10] + [75, 78, 82, 85, 88, 92]
    r = monitor.evaluate(series(hrs))
    assert r["cusum"]["alarm"] and r["cusum"]["alarm_dates"]
    assert r["cusum"]["series"][-1]["s"] >= monitor.CUSUM_H
    assert monitor.followup_level(series(hrs))[0] == "appointment"
    s = monitor.patient_sentence(r)
    assert "الطبيب" in s and not any(ch.isdigit() for ch in s)


def test_single_spike_remeasure_not_alarm():
    r = monitor.evaluate(series(STABLE + [100]))
    assert r["latest"]["flag"] == "remeasure" and r["latest"]["z"] >= 3
    assert not r["cusum"]["alarm"] and r["cusum"]["alarm_dates"] == []
    assert monitor.followup_level(series(STABLE + [100])) is None
    assert {f["code"] for f in r["flags"]} == {"remeasure"}


def test_fewer_than_7_readings_no_forecast_no_baseline():
    r = monitor.evaluate(series([72, 73, 71, 72, 74, 72]))
    assert r["baseline"] is None and r["baseline_reason_ar"] == monitor.NO_BASELINE_AR
    assert forecast.linear(r["days"]) is None
    out = monitor_api.build(PAT, series([72, 73, 71, 72, 74, 72]), chat=no_ai, use_chronos=False)
    assert out["forecast"] is None and out["forecast_reason_ar"]
    assert out["agreement"]["status"] == "none"


def test_poor_and_excluded_ignored():
    cks = series(STABLE)
    cks += [ck(0, 140, quality="poor", minute=5), ck(0, 135, excluded=True, minute=6)]
    r = monitor.evaluate(cks)
    assert r["days"][-1]["hr"] == STABLE[-1] and r["days"][-1]["n"] == 1
    assert r["latest"]["hr"] == STABLE[-1] and r["latest"]["flag"] is None
    pts = monitor_api.build(PAT, cks, chat=no_ai, use_chronos=False)["points"]
    assert sum(1 for p in pts if not p["good"]) == 2


def test_daily_median():
    cks = series(STABLE) + [ck(0, 80, minute=10), ck(0, 90, minute=20)]
    assert monitor.evaluate(cks)["days"][-1]["hr"] == 80  # median(73, 80, 90)


def test_forecast_interval_always_present():
    fc = forecast.linear(monitor.daily_values(series(STABLE[:7] + [74, 76, 78, 80, 82, 84])))
    assert fc["n"] == 7 and fc["slope_per_day"] > 1.5
    for p in fc["points"]:
        assert p["lo"] < p["hr"] < p["hi"]
        assert p["hi"] - p["lo"] >= 2 * 1.476 * 3.0  # s floor 3 bpm, t(0.90, 5)


def test_agreement_and_widening():
    fc = forecast.linear(monitor.daily_values(series(STABLE)))
    mid = [p["hr"] for p in fc["points"]]
    agree = forecast.agreement(fc, {"median": mid, "q10": [m - 2 for m in mid], "q90": [m + 2 for m in mid]})
    assert agree["status"] == "agree" and agree["label_ar"] == "متوافق"
    far = [m + 30 for m in mid]
    un = forecast.agreement(fc, {"median": far, "q10": [m - 2 for m in far], "q90": [m + 2 for m in far]})
    assert un["status"] == "uncertain" and un["label_ar"] == "عدم يقين مرتفع"
    wide = forecast.apply_agreement(fc, un)
    assert all(p["hi"] >= f + 2 for p, f in zip(wide["points"], far))
    assert forecast.agreement(fc, None)["status"] == "linear_only"


def test_number_guard_rejects_invented_numbers():
    facts = {"baseline_hr": 72.7, "latest_hr": 92.4, "forecast_24h": 94.7, "forecast_24h_range": [88.9, 100.5],
             "sustained_rise": True, "agreement": "متوافق", "symptoms_ar": []}
    ok, _ = forecast.guard("النبض ارتفع من حوالي 73 إلى 92 ن/د، والتوقع 95 خلال 24 ساعة.", facts)
    assert ok
    assert not forecast.guard("النبض وصل 130 ن/د.", facts)[0]
    assert not forecast.guard("احتمال دخول المستشفى 40%.", facts)[0]
    n = forecast.doctor_note(facts, cache_key="t1", chat=lambda f: "النبض 150 ن/د وسيرتفع إلى 170.")
    assert n["source"] == "template" and n["numbers_verified"] is False
    assert "مؤشر للمتابعة، مش تشخيص" in n["text_ar"]
    assert forecast.guard(n["text_ar"], facts)[0]  # the template itself passes the guard
    good = forecast.doctor_note(facts, cache_key="t2", chat=lambda f: "النبض أعلى من معدله المعتاد 73 ن/د.")
    assert good["source"] == "ai" and "مؤشر للمتابعة، مش تشخيص" in good["text_ar"]
    down = forecast.doctor_note(facts, cache_key="t3", chat=no_ai)
    assert down["source"] == "template"


def test_followup_flag_never_emergency():
    hrs = STABLE[:10] + [75, 78, 82, 85, 88]
    prev = []
    for i, h in enumerate(hrs):
        prev.append({"created_at": (T0 - timedelta(days=len(hrs) - i)).isoformat(),
                     "vitals": {"hr_bpm": h, "hr_confidence": 0.9, "quality": "good"}})
    vit = {"hr_bpm": 92, "hr_confidence": 0.9, "rr_bpm": 16, "rr_confidence": 0.8, "quality": "good"}
    c = pipeline.analyze(PAT, vit, "الحمد لله منيح", "typed", prev, llm_fn=None, now=T0)
    assert c["triage"]["level"] == "appointment"
    assert any("يستحق مراجعة الطبيب" in r for r in c["triage"]["reasons_ar"])
    # red-flag rules still win
    c2 = pipeline.analyze(PAT, vit, "عندي وجع بصدري قوي", "typed", prev, llm_fn=None, now=T0)
    assert c2["triage"]["level"] == "emergency"
    # with the flag off the engine does not bump
    os.environ["NAZRA_MONITOR"] = "0"
    try:
        assert monitor.followup_level(prev) is None
    finally:
        os.environ["NAZRA_MONITOR"] = "1"


def test_forecast_endpoint(monkeypatch):
    from fastapi.testclient import TestClient

    import app as app_mod
    import store
    hrs = STABLE[:10] + [75, 78, 82, 85, 88, 92]
    monkeypatch.setattr(store, "get_patient", lambda pid: dict(PAT, id=pid) if pid == "mt" else None)
    monkeypatch.setattr(store, "patient_checkins", lambda pid, newest_first=True: series(hrs))
    monkeypatch.setattr(forecast, "_ollama_chat", no_ai)
    client = TestClient(app_mod.app)  # no `with`: skips the model-loading lifespan
    r = client.get("/api/patients/mt/forecast")
    assert r.status_code == 200
    j = r.json()
    for k in ("baseline", "latest", "cusum", "forecast", "agreement", "points", "note", "patient_sentence_ar",
              "flags"):
        assert k in j
    assert j["cusum"]["alarm_dates"] and j["forecast"]["points"][0]["lo"] < j["forecast"]["points"][0]["hi"]
    assert j["note"]["source"] == "template" and j["agreement"]["status"] == "linear_only"
    assert not any(ch.isdigit() for ch in j["patient_sentence_ar"])
    assert client.get("/api/patients/nope/forecast").status_code == 404

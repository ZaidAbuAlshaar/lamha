"""Insights: community k-anonymity + alert rule, voice markers, «شو تغيّر» template, asr result fields."""
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

os.environ["NAZRA_NO_MODELS"] = "1"  # never load Whisper/Gemma from tests
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

import asr  # noqa: E402
import community  # noqa: E402
import core  # noqa: E402
import insights_api  # noqa: E402
import store  # noqa: E402
import voice_markers  # noqa: E402

NOW = datetime(2026, 10, 24, 18, 0, tzinfo=core.AMMAN)


def ck(day: float, hr: float, syms=(), quality="good", rr=16.0, cid=None, level="followup"):
    return {"id": cid or f"c{day}", "created_at": (NOW - timedelta(days=day, hours=1)).isoformat(),
            "vitals": {"hr_bpm": hr, "hr_confidence": 0.9, "rr_bpm": rr, "rr_confidence": 0.8, "quality": quality},
            "symptoms": [{"key": k, "label_ar": k, "verified": True} for k in syms],
            "triage": {"level": level}, "review": None}


def history(sick_days=(), base=75.0, syms=("cough",), days=20):
    return [ck(d, base * 1.15 if d in sick_days else base, syms if d in sick_days else ()) for d in range(days - 1, -1, -1)]


def area(name, n, sick_map):
    return [({"id": f"{name}{i}", "location_ar": name, "simulated": True}, history(sick_map.get(i, ())))
            for i in range(n)]


def test_rising_cluster_alerts_and_stable_area_does_not():
    rising = area("A", 6, {0: (0,), 1: (1,), 2: (2,), 3: (0, 1), 5: (10,)})
    stable = area("B", 6, {0: (7,), 1: (1,)})
    r = community.community(NOW, rising + stable)
    a = {x["area_ar"]: x for x in r["areas"]}
    assert a["A"]["count_72h"] == 4 and a["A"]["baseline_windows"] == [0, 0, 1] and a["A"]["alert"] is True
    assert a["A"]["label_ar"] == community.ALERT_AR
    assert a["B"]["count_72h"] == 1 and a["B"]["alert"] is False
    assert r["label_ar"] == "مؤشر للمتابعة، مش تشخيص"


def test_symptom_without_hr_rise_or_poor_quality_does_not_count():
    normal_hr = [ck(d, 75, ("cough",) if d == 0 else ()) for d in range(19, -1, -1)]
    poor = history() [:-1] + [ck(0, 90, ("fever",), quality="poor")]
    no_resp = history() [:-1] + [ck(0, 90, ("headache",))]
    assert community.qualifying_times(normal_hr) == []
    assert community.qualifying_times(poor) == []
    assert community.qualifying_times(no_resp) == []
    assert len(community.qualifying_times(history(sick_days=(0,)))) == 1


def test_k_anonymity_suppresses_small_areas_and_never_returns_names():
    small = area("C", 4, {0: (0,), 1: (0,), 2: (0,), 3: (0,)})  # 4 patients, all "sick": still hidden
    for p, _ in small:
        p["name_ar"] = "اسم سري"
    r = community.community(NOW, small + area("D", 5, {}))
    a = {x["area_ar"]: x for x in r["areas"]}
    c = a["C"]
    assert c["suppressed"] is True and c["alert"] is False and c["label_ar"] == "أقل من 5 — مخفي"
    assert c["n_patients"] is None and c["count_72h"] is None and c["baseline"] is None
    assert a["D"]["suppressed"] is False and a["D"]["n_patients"] == 5
    assert "اسم سري" not in str(r) and "C0" not in str(r)


def test_demo_seed_output(tmp_path):
    old_path, old_con = store.DB_PATH, store._con
    store._con = None
    store.DB_PATH = tmp_path / "ins.db"
    try:
        import demo
        demo.reset_all()
        a = {x["area_ar"]: x for x in community.community()["areas"]}
        assert a["الرمثا"]["alert"] is True and a["الرمثا"]["count_72h"] >= 3
        assert a["السلط"]["alert"] is False and a["مادبا"]["alert"] is False
        assert a["الكرك"]["suppressed"] is True
        # demo cohort stays out of the triage queue
        assert all(not p["id"].startswith("cm") for p in store.list_patients())
    finally:
        if store._con:
            store._con.close()
        store._con, store.DB_PATH = old_con, old_path


def _words(spec):
    """spec: list of (start, end)."""
    return [{"w": f"w{i}", "start": s, "end": e} for i, (s, e) in enumerate(spec)]


def test_voice_markers_from_synthetic_timings():
    # 9 words, 0.3 s each with 0.05 s gaps, a 0.5 s pause after words 3 and 6 -> 3 breath groups of 3
    spec, t = [], 0.0
    for i in range(9):
        spec.append((round(t, 2), round(t + 0.3, 2)))
        t += 0.3 + (0.5 if i in (2, 5) else 0.05)
    m = voice_markers.compute(_words(spec))
    assert m["n_words"] == 9 and m["pause_count"] == 2 and m["pause_mean_ms"] == 500
    assert m["words_per_breath_group"] == 3.0
    speech = spec[-1][1] - spec[0][0]
    assert m["speech_s"] == round(speech, 2) and m["speech_rate_wps"] == round(9 / speech, 2)
    assert m["quality_ok"] is True
    few = voice_markers.compute(_words([(0, 0.3), (0.4, 0.7)]))
    assert few["quality_ok"] is False and few["quality"] == "insufficient"
    assert voice_markers.compute([])["quality_ok"] is False


def test_voice_compare_needs_three_prior():
    good = voice_markers.compute(_words([(i * 0.4, i * 0.4 + 0.3) for i in range(12)]))
    cks = [{"id": f"v{i}", "created_at": (NOW - timedelta(days=5 - i)).isoformat(), "vitals": {"voice_markers": good}}
           for i in range(3)]
    r = voice_markers.compare(cks)
    assert r["available"] is False and r["reason_ar"] == "لسا ما في أساس كافٍ للمقارنة" and r["n_prior"] == 2
    cks.append({"id": "v3", "created_at": NOW.isoformat(), "vitals": {"voice_markers": {**good, "speech_rate_wps": good["speech_rate_wps"] / 2}}})
    r = voice_markers.compare(cks)
    assert r["available"] is True and r["n_prior"] == 3 and r["delta_pct"]["speech_rate_wps"] == pytest.approx(-50, abs=0.2)
    assert r["label_ar"] == "مؤشر للمتابعة، مش تشخيص"


def test_what_changed_numbers_come_from_data():
    prev = ck(2, 78.4, ("cough",), rr=16.2, cid="a")
    cur = ck(0, 91.6, ("fever",), rr=20.4, cid="b", level="appointment")
    r = insights_api.changes([prev, cur])
    l1, l2 = r["lines_ar"]
    assert "النبض 92 مقابل 78 (+14)" in l1 and "التنفس 20 مقابل 16 (+4)" in l1 and "قبل 2 يوم" in l1
    assert "أعراض جديدة: fever" in l2 and "اختفت: cough" in l2 and "متابعة ← موعد" in l2
    nums = {int(x) for x in core.extract_numbers(" ".join(r["lines_ar"]))}
    assert nums <= {92, 78, 14, 20, 16, 4, 2}
    poor = insights_api.changes([prev, ck(0, 120, quality="poor", cid="c")])
    assert "120" not in poor["lines_ar"][0] and "ما بنقارن" in poor["lines_ar"][0]
    assert insights_api.changes([prev])["available"] is False


def test_asr_result_keeps_old_fields_and_adds_words():
    W = SimpleNamespace
    segs = [W(text=" عندي كحة", words=[W(word=" عندي", start=0.0, end=0.4), W(word=" كحة", start=0.5, end=0.9)]),
            W(text=" من مبارح", words=[W(word=" من", start=1.5, end=1.7), W(word=" مبارح", start=1.75, end=2.2)])]
    out = asr.result_from_segments(iter(segs), W(duration=2.5, language="ar"), 0.0)
    for k in ("text", "duration_s", "language", "processing_ms", "model"):
        assert k in out
    assert out["text"] == "عندي كحة من مبارح" and out["duration_s"] == 2.5 and out["model"] == asr.MODEL_NAME
    assert out["words"][0] == {"w": "عندي", "start": 0.0, "end": 0.4} and len(out["words"]) == 4
    assert out["voice_markers"]["pause_count"] == 1 and out["voice_markers"]["n_words"] == 4
    echo = asr.result_from_segments([W(text=asr.INITIAL_PROMPT, words=[W(word="كحة", start=0, end=1)])],
                                    W(duration=1.0, language="ar"), 0.0)
    assert echo["text"] == "" and echo["words"] == []


def test_routes_without_models(tmp_path):
    from fastapi.testclient import TestClient
    import app as app_mod
    old_path, old_con = store.DB_PATH, store._con
    store._con = None
    store.DB_PATH = tmp_path / "routes.db"
    try:
        store.seed_if_empty()
        c = TestClient(app_mod.app)  # no `with`: skips the model-loading lifespan
        r = c.get("/api/community")
        assert r.status_code == 200 and all(a["suppressed"] for a in r.json()["areas"])  # 1 patient per area
        ch = c.get("/api/patients/p1/changes").json()
        assert ch["available"] is True and len(ch["lines_ar"]) == 2
        assert c.get("/api/patients/p1/voice").json()["available"] is False
        assert c.get("/api/patients/nope/changes").status_code == 404
    finally:
        if store._con:
            store._con.close()
        store._con, store.DB_PATH = old_con, old_path

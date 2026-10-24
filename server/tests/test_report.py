"""Patient report: sections, advice guard, verbatim 911 lines, minimal emergency report, Piper TTS."""
import os
import sys
import time
import wave
from datetime import datetime, timedelta
from pathlib import Path

os.environ["NAZRA_NO_MODELS"] = "1"  # never load Whisper/Gemma from tests
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

import core  # noqa: E402
import pipeline  # noqa: E402
import report  # noqa: E402
import store  # noqa: E402
import tts  # noqa: E402

NOW = datetime(2026, 10, 24, 12, 0, tzinfo=core.AMMAN)
PAT = {"id": "p-rep", "name_ar": "سلمى (تجريبي)", "name_en": "Salma", "age": 58, "sex": "f", "conditions_ar": [],
       "simulated": True, "created_at": NOW.isoformat(), "lat": 31.97, "lon": 35.90}
GOOD = {"hr_bpm": 76, "hr_confidence": 0.9, "rr_bpm": 15, "rr_confidence": 0.8, "quality": "good"}


def sym(key, label, span):
    return {"key": key, "label_ar": label, "label_en": key, "span": span, "severity": None, "duration": None}


def make(vitals, transcript="", seed=None, prev=None, now=NOW):
    return pipeline.analyze(PAT, vitals, transcript, "typed" if transcript else "none", prev or [], llm_fn=None,
                            now=now, simulated=True, seed_symptoms=seed)


def all_card_lines(field):
    return {t for c in report.cards() for t in c[field]}


# ---------------------------------------------------------------- cards file
def test_cards_file_shape_and_no_medicines():
    cs = report.cards()
    assert len(cs) == 16 and sum(1 for c in cs if c["id"] == "general") == 1
    keys_allowed = set(__import__("llm").SYMPTOM_KEYS)
    for c in cs:
        for k in ("id", "symptom_keys", "title_ar", "do_now_ar", "call_911_if_ar", "ask_doctor_ar", "source", "status"):
            assert k in c, (c["id"], k)
        assert set(c["symptom_keys"]) <= keys_allowed, c["id"]
        assert 2 <= len(c["do_now_ar"]) <= 4, c["id"]
        assert c["source"]["org"] in ("WHO", "NHS", "Jordan MoH")
        assert c["status"] == "مسودة — بانتظار مراجعة طبية"
        for line in c["do_now_ar"]:
            assert not report.has_dose_or_medicine(line), line
            assert not core.extract_numbers(line), line


# ---------------------------------------------------------------- advice guard
@pytest.mark.parametrize("bad", [
    "خذ حبة باراسيتامول", "خذ ٥٠٠ ملغ", "اشرب مرتين باليوم", "خذ ٣ مرات", "كل ٦ ساعات خذ الدوا",
    "take 500 mg ibuprofen", "take two tablets every 6 hours", "ibuprofen", "بنادول", "جرعة واحدة",
])
def test_guard_rejects_doses_and_medicines(bad):
    assert report.has_dose_or_medicine(bad)


def test_guard_drops_unlinked_and_dosed_lines():
    by_id = report.cards_by_id()
    fever = by_id["fever"]
    tampered = {**fever, "do_now_ar": fever["do_now_ar"] + ["خذ حبة باراسيتامول كل ٦ ساعات"]}
    items = [{"text": fever["do_now_ar"][0], "card_id": "fever"},
             {"text": "اشرب شاي بالزنجبيل", "card_id": "fever"},  # not on the card
             {"text": fever["do_now_ar"][1], "card_id": None},  # no card link
             {"text": fever["do_now_ar"][1], "card_id": "made_up"},  # unknown card
             {"text": "خذ حبة باراسيتامول كل ٦ ساعات", "card_id": "fever"}]  # on a (tampered) card but has a dose
    kept, dropped = report.advice_guard(items, {**by_id, "fever": tampered})
    assert [k["text"] for k in kept] == [fever["do_now_ar"][0]]
    reasons = [d["reason"] for d in dropped]
    assert reasons.count("unlinked") == 3 and reasons.count("dose_or_medicine") == 1


def test_report_do_now_never_contains_dose_even_if_card_is_tampered(monkeypatch):
    real = report.cards()
    bad = [dict(c) for c in real]
    for c in bad:
        if c["id"] == "fever":
            c["do_now_ar"] = ["خذ ٢ حبة بنادول", *c["do_now_ar"]]
    monkeypatch.setattr(report, "cards", lambda: bad)
    c = make(GOOD, "عندي حرارة", seed=[sym("fever", "حرارة", "عندي حرارة")])
    r = report.build_report(c, PAT, [])
    assert "خذ ٢ حبة بنادول" not in r["do_now_ar"]
    assert any(d["reason"] == "dose_or_medicine" for d in r["dropped_advice"])


# ---------------------------------------------------------------- normal / appointment / emergency
def test_normal_report_sections():
    c = make(GOOD)
    assert c["triage"]["level"] == "followup"
    r = report.build_report(c, PAT, [])
    assert r["minimal"] is False and r["level"] == "followup"
    assert r["next_step_ar"] == report.NEXT_STEP_AR["followup"]
    assert r["cards"] == ["general"]
    assert r["do_now_ar"] and set(r["do_now_ar"]) <= set(report.cards_by_id()["general"]["do_now_ar"])
    assert len(r["questions_for_doctor_ar"]) <= 3
    assert r["disclaimer_ar"] == "مؤشر للمتابعة، مش تشخيص"
    assert r["nearest_center"]["label_ar"] == "تجريبي" and r["nearest_center"]["name_ar"]
    hr = next(v for v in r["vitals"] if v["key"] == "hr")
    assert hr["value"] == 76 and hr["quality"] == "good" and hr["meaning_ar"] and hr["note_ar"] == report.DISCLAIMER_AR
    assert "76" in r["qr_payload"] and "سلمى" in r["qr_payload"] and "HR" in r["qr_payload"]
    assert len(r["qr_payload"].encode("utf-8")) < 600
    assert r["sources"] and r["sources"][0]["org"] == "WHO"
    assert not core.extract_numbers(r["change_vs_baseline_ar"])
    # no probabilities anywhere
    assert "%" not in str(r) and "احتمال" not in str(r)


def test_appointment_report_uses_matched_cards_and_verbatim_911_lines():
    c = make({**GOOD, "hr_bpm": 115}, "عندي حرارة وكحة",
             seed=[sym("fever", "حرارة", "حرارة"), sym("cough", "كحة", "كحة")])
    assert c["triage"]["level"] == "appointment"
    r = report.build_report(c, PAT, [])
    assert r["level"] == "appointment" and r["minimal"] is False
    assert r["cards"] == ["fever", "cough"]
    by_id = report.cards_by_id()
    allowed_do = set(by_id["fever"]["do_now_ar"]) | set(by_id["cough"]["do_now_ar"])
    assert r["do_now_ar"] and set(r["do_now_ar"]) <= allowed_do
    allowed_911 = set(by_id["fever"]["call_911_if_ar"]) | set(by_id["cough"]["call_911_if_ar"])
    assert r["call_911_if_ar"] and all(line in allowed_911 for line in r["call_911_if_ar"])  # verbatim copies
    assert r["call_911_if_ar"][0] == by_id["fever"]["call_911_if_ar"][0]
    assert len(r["questions_for_doctor_ar"]) == 3
    hr = next(v for v in r["vitals"] if v["key"] == "hr")
    assert hr["value"] == 115 and "يستحق المتابعة" in hr["meaning_ar"]
    assert {s["title"] for s in r["sources"]} == {by_id["fever"]["source"]["title"], by_id["cough"]["source"]["title"]}


def test_unverified_symptom_does_not_pull_a_card():
    c = make(GOOD, "عندي كحة", seed=[sym("fever", "حرارة", "حرارة عالية")])  # span not in transcript
    r = report.build_report(c, PAT, [])
    assert "fever" not in r["cards"]


def test_emergency_report_is_minimal():
    c = make(GOOD, "عندي وجع بصدري")
    assert c["triage"]["level"] == "emergency"
    r = report.build_report(c, PAT, [])
    assert r["minimal"] is True and r["level"] == "emergency"
    assert r["call_action"]["href"] == "tel:911"
    assert r["nearest_center"]["name_ar"] and r["nearest_center"]["label_ar"] == "تجريبي"
    assert "ألم في الصدر" in r["qr_payload"]
    assert r["do_now_ar"] == [] and r["vitals"] == [] and r["questions_for_doctor_ar"] == []
    assert r["summary_ar"] is None and r["call_911_if_ar"] == []


def test_doctor_override_changes_report_level():
    c = make(GOOD)
    c["review"] = {"decision": "override", "final_level": "appointment", "note": "", "reviewed_at": NOW.isoformat()}
    assert report.build_report(c, PAT, [])["level"] == "appointment"


def test_summary_with_unverified_number_falls_back_to_template():
    c = make(GOOD)
    c["ai"] = {**c["ai"], "summary_ar": "نبضك 140 والخطر 80%", "numbers_verified": True, "model": "gemma"}
    r = report.build_report(c, PAT, [])
    assert r["summary_source"] == "template" and "140" not in r["summary_ar"]


def test_baseline_sentence_calm_and_number_free():
    prev = [make(GOOD, now=NOW - timedelta(days=d)) for d in (5, 4, 3, 2, 1)]
    c = make({**GOOD, "hr_bpm": 100}, prev=prev)
    r = report.build_report(c, PAT, prev)
    assert r["change_vs_baseline_ar"] and not core.extract_numbers(r["change_vs_baseline_ar"])
    r0 = report.build_report(make(GOOD), PAT, [])
    assert "كمّل الفحص" in r0["change_vs_baseline_ar"]


def test_poor_scan_report_does_not_claim_all_good():
    c = make({"hr_bpm": 90, "hr_confidence": 0.2, "quality": "poor"})
    r = report.build_report(c, PAT, [])
    assert r["next_step_ar"] == report.POOR_SCAN_NEXT_AR
    assert all(not v["usable"] for v in r["vitals"])


# ---------------------------------------------------------------- API
@pytest.fixture()
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    import app as app_mod
    old_path, old_con = store.DB_PATH, store._con
    store._con = None
    store.DB_PATH = tmp_path / "report.db"  # never the live DB
    store.con()
    yield TestClient(app_mod.app)  # no `with`: skips the model-loading lifespan
    store._con.close()
    store._con, store.DB_PATH = old_con, old_path


def test_report_endpoint_and_flag(client, monkeypatch):
    store.put_patient(PAT)
    c = make(GOOD, "عندي صداع", seed=[sym("headache", "صداع", "صداع")])
    store.put_checkin(c)
    r = client.get(f"/api/checkins/{c['id']}/report")
    assert r.status_code == 200
    body = r.json()
    assert body["cards"] == ["headache"] and body["disclaimer_ar"] == report.DISCLAIMER_AR
    assert client.get("/api/checkins/nope/report").status_code == 404
    monkeypatch.setenv("NAZRA_REPORT", "0")
    assert client.get(f"/api/checkins/{c['id']}/report").status_code == 404


def test_tts_endpoint_validation_and_flag(client, monkeypatch):
    assert client.post("/api/tts", json={"text": ""}).status_code == 422
    monkeypatch.setenv("NAZRA_TTS", "0")
    assert client.post("/api/tts", json={"text": "مرحبا"}).status_code == 404


def test_tts_unavailable_returns_503(client, monkeypatch, tmp_path):
    monkeypatch.setattr(tts, "PIPER_EXE", tmp_path / "no-piper.exe")
    assert client.post("/api/tts", json={"text": "مرحبا"}).status_code == 503
    assert tts.health()["status"] == "down"


@pytest.mark.skipif(not tts.available(), reason=f"Piper not installed ({tts.PIPER_EXE}) or voice missing ({tts.VOICE})")
def test_piper_produces_wav(tmp_path, monkeypatch):
    monkeypatch.setattr(tts, "CACHE_DIR", tmp_path / "tts")
    text = f"هذا اختبار صوت نظرة رقم {time.time_ns() % 1000}."
    t0 = time.perf_counter()
    path = tts.synthesize(text)
    ms = (time.perf_counter() - t0) * 1000
    with wave.open(str(path)) as w:
        secs = w.getnframes() / w.getframerate()
    assert 0.5 < secs < 15, secs  # sane length (garbled stdin decoding gives a much longer clip)
    assert tts.synthesize(text) == path and tts.state["cache_hits"] >= 1  # cache hit
    print(f"piper wav {secs:.1f}s audio in {ms:.0f} ms")
    assert tts.health()["status"] in ("ok", "degraded")

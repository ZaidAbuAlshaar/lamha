"""Hardening: schema validation, timeouts + rules-only fallback, health components, dev recordings."""
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

os.environ["NAZRA_NO_MODELS"] = "1"  # never load Whisper/Gemma from tests
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
import pytest  # noqa: E402

import core  # noqa: E402
import health  # noqa: E402
import llm  # noqa: E402
import pipeline  # noqa: E402
import store  # noqa: E402

NOW = datetime(2026, 10, 24, 12, 0, tzinfo=core.AMMAN)
PATIENT = {"id": "t1", "name_ar": "تجربة", "name_en": "Test", "age": 50, "conditions_ar": []}
VIT = {"hr_bpm": 80, "hr_confidence": 0.9, "rr_bpm": 16, "rr_confidence": 0.8, "stress_index": 40,
       "stress_level": "moderate", "quality": "good", "scan_seconds": 30, "fps": 30}


def good_data(**over):
    d = {"symptoms": [{"key": "cough", "label_ar": "كحة", "label_en": "Cough", "span": "كحة", "severity": "mild",
                       "duration": "يومين"}],
         "summary_ar": "كحة خفيفة.", "summary_en": "Mild cough.", "advice_ar": "راجع المركز إذا زادت.",
         "triage_suggestion": "followup", "triage_reason_ar": "أعراض خفيفة"}
    d.update(over)
    return d


# ---------------------------------------------------------------- schema validation
def test_schema_accepts_valid():
    assert llm.validate_extraction(good_data()) == (True, None)


@pytest.mark.parametrize("bad", [
    None, [], "text", 42,
    {k: v for k, v in good_data().items() if k != "summary_ar"},  # missing required
    good_data(triage_suggestion="urgent"),  # enum
    good_data(triage_suggestion=None),
    good_data(symptoms="cough"),  # wrong type
    good_data(symptoms=[{"key": "cough"}]),  # incomplete symptom
    good_data(symptoms=[{"key": "flu", "label_ar": "x", "label_en": "x", "span": "x", "severity": "mild",
                         "duration": ""}]),  # key not in enum
    good_data(symptoms=[{"key": "cough", "label_ar": "x", "label_en": "x", "span": "x", "severity": "very",
                         "duration": ""}]),  # severity enum
    good_data(summary_en=123),  # number instead of string (strict)
])
def test_schema_rejects_malformed(bad):
    ok, why = llm.validate_extraction(bad)
    assert ok is False and why


class _Resp:
    def __init__(self, content, status=200):
        self._c, self.status_code = content, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("boom", request=httpx.Request("POST", "http://x"),
                                        response=httpx.Response(self.status_code))

    def json(self):
        return {"message": {"content": self._c}}


@pytest.mark.parametrize("content,code", [
    ("not json at all {", "invalid_json"),
    ('{"symptoms": [', "invalid_json"),
    (json.dumps({"summary_ar": "x"}), "invalid_schema"),
    (json.dumps(good_data(triage_suggestion="maybe")), "invalid_schema"),
    (json.dumps([1, 2, 3]), "invalid_schema"),
])
def test_extract_malformed_outputs(monkeypatch, content, code):
    monkeypatch.setattr(llm.httpx, "post", lambda *a, **k: _Resp(content))
    r = llm.extract("عندي كحة", PATIENT, {})
    assert r["ok"] is False and r["error"] == code and r["data"] is None and r["error_detail"]


def test_extract_valid(monkeypatch):
    monkeypatch.setattr(llm.httpx, "post", lambda *a, **k: _Resp(json.dumps(good_data())))
    r = llm.extract("عندي كحة", PATIENT, {})
    assert r["ok"] is True and r["error"] is None and r["data"]["triage_suggestion"] == "followup"


@pytest.mark.parametrize("exc,code", [
    (httpx.ReadTimeout("slow"), "timeout"),
    (httpx.ConnectError("refused"), "unreachable"),
])
def test_extract_transport_errors(monkeypatch, exc, code):
    def raise_(*a, **k):
        raise exc
    monkeypatch.setattr(llm.httpx, "post", raise_)
    r = llm.extract("عندي كحة", PATIENT, {})
    assert r["ok"] is False and r["error"] == code


def test_extract_http_error(monkeypatch):
    monkeypatch.setattr(llm.httpx, "post", lambda *a, **k: _Resp("", status=500))
    assert llm.extract("x", PATIENT, {})["error"] == "http_error"


def test_llm_timeout_flag_default():
    assert llm.TIMEOUT_S == float(os.environ.get("NAZRA_LLM_TIMEOUT_S", "25"))


# ---------------------------------------------------------------- hard timeout + rules-only fallback
def test_run_with_timeout_returns_and_raises():
    assert health.run_with_timeout(lambda x: x + 1, 2, 1) == 2
    with pytest.raises(health.CallTimeout):
        health.run_with_timeout(time.sleep, 0.2, 2)
    with pytest.raises(ValueError):
        health.run_with_timeout(lambda: (_ for _ in ()).throw(ValueError("x")), 1)


def test_guarded_llm_timeout_gives_labelled_rules_only():
    def slow(t, p, c):
        time.sleep(3)
        return {"ok": True, "data": good_data(), "latency_ms": 3000, "error": None, "model": "gemma"}

    t0 = time.perf_counter()
    c = pipeline.analyze(PATIENT, VIT, "عندي وجع قوي بصدري ومش قادر أتنفس", "voice", [],
                         llm_fn=health.guarded_llm(slow, 0.3), now=NOW)
    assert time.perf_counter() - t0 < 2.5  # the patient is not kept waiting for the slow model
    assert c["ai"]["ok"] is False and c["ai"]["model"] == "rules-only" and c["ai"]["error"] == "timeout"
    assert c["triage"]["level"] == "emergency"  # rules still catch the red flag
    assert "النتيجة من القواعد فقط — الموديل ما ردّ بالوقت" in c["triage"]["reasons_ar"]
    assert "Rules-only result — model did not respond in time" in c["triage"]["reasons_en"]
    assert health.snapshot("gemma")["last_error"] == "timeout"


def test_guarded_llm_exception_never_reaches_patient():
    def boom(t, p, c):
        raise RuntimeError("kaput")
    c = pipeline.analyze(PATIENT, VIT, "عندي كحة", "voice", [], llm_fn=health.guarded_llm(boom, 2), now=NOW)
    assert c["ai"]["ok"] is False and c["ai"]["model"] == "rules-only" and c["ai"]["error"] == "error"
    assert c["triage"]["level"] == "followup"


@pytest.mark.parametrize("err,needle", [("invalid_json", "مش صالح"), ("invalid_schema", "مش صالح"),
                                        ("unreachable", "مش متاح")])
def test_invalid_model_output_is_rules_only(err, needle):
    def bad(t, p, c):
        return {"ok": False, "data": None, "latency_ms": 5, "error": err, "error_detail": "x", "model": "gemma"}
    c = pipeline.analyze(PATIENT, VIT, "عندي كحة خفيفة", "voice", [], llm_fn=bad, now=NOW)
    assert c["ai"]["model"] == "rules-only" and c["ai"]["error"] == err and c["ai"]["attempted_model"] == "gemma"
    assert any(r.startswith("النتيجة من القواعد فقط") and needle in r for r in c["triage"]["reasons_ar"])
    assert c["ai"]["summary_ar"].startswith("فحص عن بعد")  # template summary, no model text


def test_ok_model_has_no_rules_only_label():
    def ok(t, p, c):
        return {"ok": True, "data": good_data(), "latency_ms": 5, "error": None, "model": "gemma"}
    c = pipeline.analyze(PATIENT, VIT, "عندي كحة", "voice", [], llm_fn=ok, now=NOW)
    assert c["ai"]["model"] == "gemma" and not any("القواعد فقط" in r for r in c["triage"]["reasons_ar"])


def test_empty_transcript_rules_only_without_failure_reason():
    c = pipeline.analyze(PATIENT, VIT, "", "none", [], llm_fn=lambda *a: None, now=NOW)
    assert c["ai"]["model"] == "rules-only" and not any("القواعد فقط" in r for r in c["triage"]["reasons_ar"])


# ---------------------------------------------------------------- rules self-test / components
def test_rules_selftest_passes():
    s = health.run_rules_selftest()
    assert s["passed"] == s["total"] == 3 and not s["failures"]
    assert health.rules_component()["status"] == "ok"


def test_tunnel_url_from_log(tmp_path, monkeypatch):
    log = tmp_path / "t.log"
    log.write_text("INF |  https://abc-def-ghi.trycloudflare.com  |\nhttps://zzz.trycloudflare.com", encoding="utf-8")
    monkeypatch.delenv("NAZRA_PUBLIC_URL", raising=False)
    monkeypatch.setenv("NAZRA_TUNNEL_LOG", str(log))
    assert health.tunnel_url()[0] == "https://abc-def-ghi.trycloudflare.com"
    monkeypatch.setenv("NAZRA_PUBLIC_URL", "https://example.test/")
    assert health.tunnel_url()[0] == "https://example.test"
    monkeypatch.delenv("NAZRA_PUBLIC_URL")
    monkeypatch.setenv("NAZRA_TUNNEL_LOG", str(tmp_path / "missing.log"))
    assert health.tunnel_url()[0] is None


def test_gemma_component_device():
    m = [{"name": "g", "size": 100, "size_vram": 100}]
    assert health.gemma_component("g", m, None)["device"] == "GPU"
    assert health.gemma_component("g", [{"name": "g", "size": 100, "size_vram": 0}], None)["device"] == "CPU"
    assert health.gemma_component("g", None, "ConnectError")["status"] == "down"
    assert health.gemma_component("g", [], None)["loaded"] is False


def test_whisper_component_states():
    assert health.whisper_component({"ready": False, "error": None})["detail"] == "loading"
    assert health.whisper_component({"ready": False, "error": "boom"})["status"] == "down"
    w = health.whisper_component({"ready": True, "device": "cpu", "model": "m", "compute_type": "int8"})
    assert w["device"] == "CPU" and w["status"] == "degraded"


# ---------------------------------------------------------------- app: health + dev recordings
@pytest.fixture()
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    import app as app_mod
    old_path, old_con = store.DB_PATH, store._con
    store._con = None
    store.DB_PATH = tmp_path / "test.db"  # never the live DB
    monkeypatch.setenv("NAZRA_TUNNEL_LOG", str(tmp_path / "no-tunnel.log"))
    monkeypatch.delenv("NAZRA_PUBLIC_URL", raising=False)
    monkeypatch.setattr(llm, "ps", lambda timeout=3: [{"name": llm.MODEL, "size": 10, "size_vram": 10}])
    health.tunnel.update(checked_at=None, probing=False, url=None, status=None)
    with TestClient(app_mod.app) as c:
        yield c
    store._con.close()
    store._con, store.DB_PATH = old_con, old_path


def test_health_keeps_old_fields_and_adds_components(client):
    h = client.get("/api/health").json()
    assert h["ok"] is True and h["version"]
    for k in ("ready", "model", "device", "compute_type", "error"):
        assert k in h["whisper"]
    for k in ("reachable", "ready", "model", "error"):
        assert k in h["llm"]
    assert h["llm"]["ready"] is True
    assert {"whisper", "gemma", "rules", "database", "tunnel"} <= set(h["components"])  # v2 modules add more
    for comp in h["components"].values():
        assert comp["status"] in ("ok", "degraded", "down")
        assert {"loaded", "warm", "last_latency_ms", "detail"} <= set(comp)
    assert h["components"]["gemma"]["device"] == "GPU"
    assert h["components"]["rules"]["status"] == "ok"
    assert h["components"]["database"]["status"] == "ok" and "patients" in h["components"]["database"]["detail"]


def test_health_is_fast_even_with_slow_tunnel(client, monkeypatch):
    monkeypatch.setenv("NAZRA_PUBLIC_URL", "https://slow.example.test")
    monkeypatch.setattr(health.httpx, "get", lambda *a, **k: time.sleep(2.5))
    health.tunnel.update(checked_at=None, probing=False)
    t0 = time.perf_counter()
    h = client.get("/api/health").json()
    assert time.perf_counter() - t0 < 1.5
    assert h["components"]["tunnel"]["status"] == "degraded"  # probing in the background


def test_dev_recordings_off_by_default(client, monkeypatch):
    monkeypatch.delenv("NAZRA_DEV_RECORDING", raising=False)
    assert client.get("/api/dev/recordings").status_code == 404
    r = client.post("/api/dev/recordings", files={"video": ("a.webm", b"x", "video/webm")},
                    data={"meta": json.dumps({"consent": True})})
    assert r.status_code == 404


def test_dev_recordings_on(client, monkeypatch, tmp_path):
    rec = tmp_path / "rec"
    monkeypatch.setenv("NAZRA_DEV_RECORDING", "1")
    monkeypatch.setenv("NAZRA_REC_DIR", str(rec))
    meta = {"ref_hr_bpm": 72, "ref_source": "pulse oximeter", "device": "Pixel 8", "facing": "user",
            "seconds": 30, "consent": True}
    files = {"video": ("clip.webm", b"\x1aE\xdf\xa3fakewebm", "video/webm")}
    bad = client.post("/api/dev/recordings", files=files, data={"meta": json.dumps({**meta, "consent": False})})
    assert bad.status_code == 400
    assert client.post("/api/dev/recordings", files=files, data={"meta": "{nope"}).status_code == 400
    assert client.post("/api/dev/recordings", files=files,
                       data={"meta": json.dumps({**meta, "ref_hr_bpm": None})}).status_code == 400
    ok = client.post("/api/dev/recordings", files=files, data={"meta": json.dumps(meta)})
    assert ok.status_code == 200, ok.text
    doc = ok.json()
    assert (rec / f"{doc['id']}.webm").read_bytes().startswith(b"\x1aE\xdf\xa3")
    assert json.loads((rec / f"{doc['id']}.json").read_text(encoding="utf-8"))["ref_hr_bpm"] == 72
    lst = client.get("/api/dev/recordings").json()
    assert [x["id"] for x in lst] == [doc["id"]]
    # the video itself is never served back
    assert client.get(f"/api/dev/recordings/{doc['id']}.webm").status_code in (404, 405)


def test_dev_recordings_refuse_repo_dir(client, monkeypatch):
    import app as app_mod
    monkeypatch.setenv("NAZRA_DEV_RECORDING", "1")
    monkeypatch.setenv("NAZRA_REC_DIR", str(app_mod.REPO_ROOT / "nazra" / "rec"))
    assert client.get("/api/dev/recordings").status_code == 500


def test_transcribe_timeout_deletes_temp_file(client, monkeypatch, tmp_path):
    import app as app_mod
    import asr
    monkeypatch.setattr(app_mod, "ASR_TMP_DIR", str(tmp_path))
    monkeypatch.setattr(app_mod, "ASR_TIMEOUT_S", 0.3)
    monkeypatch.setitem(asr.state, "ready", True)
    monkeypatch.setattr(asr, "transcribe", lambda p: time.sleep(1.0) or {"text": "late"})
    r = client.post("/api/transcribe", files={"audio": ("a.webm", b"fake", "audio/webm")})
    assert r.status_code == 504
    time.sleep(1.3)  # worker finishes and removes the file
    assert not list(tmp_path.glob("nazra_*"))


def test_transcribe_ok_deletes_temp_file(client, monkeypatch, tmp_path):
    import app as app_mod
    import asr
    monkeypatch.setattr(app_mod, "ASR_TMP_DIR", str(tmp_path))
    monkeypatch.setitem(asr.state, "ready", True)
    monkeypatch.setattr(asr, "transcribe", lambda p: {"text": "عندي كحة", "path_seen": Path(p).exists()})
    r = client.post("/api/transcribe", files={"audio": ("a.m4a", b"fake", "audio/mp4")})
    assert r.status_code == 200 and r.json()["path_seen"] is True
    assert not list(tmp_path.glob("nazra_*"))
    assert health.snapshot("whisper")["last_ok"] is True


def test_asr_device_flag():
    import asr
    assert asr.candidates("cpu") == [("cpu", "int8")]
    assert asr.candidates("cuda") == [("cuda", "int8_float16")]
    assert [d for d, _ in asr.candidates("auto")] == ["cuda", "cpu"]


def test_run_with_timeout_passes_timeout_s_kwarg_through():
    assert health.run_with_timeout(lambda timeout_s=None: timeout_s, 1, timeout_s=7) == 7


def test_warmup_gemma_records_and_load_continues(monkeypatch):
    import app as app_mod
    import asr
    seen = {}
    monkeypatch.setattr(llm, "extract", lambda t, p, c, timeout_s=None: seen.setdefault("t", timeout_s) and {
        "ok": True, "latency_ms": 12, "error": None})
    monkeypatch.delenv("NAZRA_NO_MODELS", raising=False)
    monkeypatch.setattr(llm, "free_vram_and_preload", lambda *a, **k: [])
    monkeypatch.setattr(asr, "load", lambda: seen.setdefault("asr", True))
    app_mod._load_models()
    assert seen["t"] == app_mod.WARMUP_TIMEOUT_S and seen["asr"] is True
    assert health.snapshot("gemma")["warm"] is True and health.snapshot("gemma")["warmup_ms"] == 12

    def boom(*a, **k):
        raise RuntimeError("x")
    seen.clear()
    monkeypatch.setattr(app_mod, "warmup_gemma", boom)
    app_mod._load_models()
    assert seen["asr"] is True  # Whisper still loads when the warm-up crashes
    monkeypatch.setenv("NAZRA_NO_MODELS", "1")

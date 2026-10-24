import llm_cloud


def _ok(model):
    return {"ok": True, "data": {"x": 1}, "latency_ms": 5, "error": None, "error_detail": None, "model": model}


def _bad(code):
    return {"ok": False, "data": None, "latency_ms": 5, "error": code, "error_detail": code, "model": "local"}


def test_local_ok_never_calls_cloud(monkeypatch):
    calls = []
    monkeypatch.setattr(llm_cloud, "enabled", lambda: True)
    monkeypatch.setattr(llm_cloud, "extract", lambda *a, **k: calls.append(1) or _ok("cloud"))
    res = llm_cloud.with_fallback(lambda *a: _ok("local"))("t", {}, {})
    assert res["model"] == "local" and not calls


def test_local_failure_uses_cloud(monkeypatch):
    monkeypatch.setattr(llm_cloud, "enabled", lambda: True)
    monkeypatch.setattr(llm_cloud, "extract", lambda *a, **k: _ok("openrouter:x (fallback)"))
    res = llm_cloud.with_fallback(lambda *a: _bad("timeout"))("t", {}, {})
    assert res["ok"] and res["fallback_from"] == "timeout"


def test_both_fail_returns_local_failure(monkeypatch):
    monkeypatch.setattr(llm_cloud, "enabled", lambda: True)
    monkeypatch.setattr(llm_cloud, "extract", lambda *a, **k: _bad("http_error"))
    res = llm_cloud.with_fallback(lambda *a: _bad("timeout"))("t", {}, {})
    assert not res["ok"] and res["error"] == "timeout"


def test_disabled_skips_cloud(monkeypatch):
    calls = []
    monkeypatch.setattr(llm_cloud, "enabled", lambda: False)
    monkeypatch.setattr(llm_cloud, "extract", lambda *a, **k: calls.append(1) or _ok("cloud"))
    res = llm_cloud.with_fallback(lambda *a: _bad("unreachable"))("t", {}, {})
    assert not res["ok"] and not calls


def test_budget_cap(monkeypatch, tmp_path):
    monkeypatch.setattr(llm_cloud, "_USAGE", tmp_path / "u.json")
    monkeypatch.setattr(llm_cloud, "enabled", lambda: True)
    monkeypatch.setenv("NAZRA_CLOUD_DAILY_CAP", "0")
    res = llm_cloud.extract("t", {}, {})
    assert not res["ok"] and res["error"] == "budget"

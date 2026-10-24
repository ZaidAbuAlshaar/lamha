"""Cloud FALLBACK for symptom extraction: the same open-weight family (Gemma 4, Apache-2.0) via OpenRouter.

Used only when the local Gemma (Ollama) fails or times out, so the patient is never blocked. Budget-capped:
NAZRA_CLOUD_DAILY_CAP calls per day and a small max_tokens. Only the transcript text and computed numbers are sent;
audio and video never leave the clinic machine / the phone. The key lives in server/.env (gitignored), never in code.
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import date
from pathlib import Path

import httpx

import llm

_ENV = Path(__file__).parent / ".env"
_USAGE = Path(os.environ.get("NAZRA_CLOUD_USAGE_FILE") or Path(__file__).parent / "data" / "cloud_usage.json")
_lock = threading.Lock()
state = {"last_latency_ms": None, "last_error": None, "calls_ok": 0, "calls_failed": 0}


def _load_env_file():
    if not _ENV.exists():
        return
    for line in _ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


_load_env_file()


def key() -> str | None:
    return os.environ.get("OPENROUTER_API_KEY") or None


def model() -> str:
    return os.environ.get("NAZRA_CLOUD_LLM_MODEL", "google/gemma-4-31b-it")


def enabled() -> bool:
    return os.environ.get("NAZRA_CLOUD_FALLBACK", "1") != "0" and bool(key())


def daily_cap() -> int:
    return int(os.environ.get("NAZRA_CLOUD_DAILY_CAP", "40"))


def _usage() -> dict:
    try:
        u = json.loads(_USAGE.read_text(encoding="utf-8"))
    except Exception:
        u = {}
    if u.get("day") != date.today().isoformat():
        u = {"day": date.today().isoformat(), "calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.0}
    return u


def _save_usage(u: dict):
    _USAGE.parent.mkdir(parents=True, exist_ok=True)
    _USAGE.write_text(json.dumps(u), encoding="utf-8")


def extract(transcript: str, patient: dict, computed: dict, timeout_s: float | None = None) -> dict:
    """Same contract as llm.extract: {'ok','data','latency_ms','error','error_detail','model'}; never raises."""
    t0 = time.perf_counter()
    label = f"openrouter:{model()} (fallback)"

    def fail(code, detail):
        state["calls_failed"] += 1
        state["last_error"] = f"{code}: {detail}"[:200]
        return {"ok": False, "data": None, "latency_ms": int((time.perf_counter() - t0) * 1000), "error": code,
                "error_detail": str(detail)[:300], "model": label}

    if not enabled():
        return fail("disabled", "no OPENROUTER_API_KEY or NAZRA_CLOUD_FALLBACK=0")
    with _lock:
        u = _usage()
        if u["calls"] >= daily_cap():
            return fail("budget", f"daily cap {daily_cap()} reached")
        u["calls"] += 1
        _save_usage(u)
    try:
        r = httpx.post("https://openrouter.ai/api/v1/chat/completions", timeout=timeout_s or 25, headers={
            "Authorization": f"Bearer {key()}", "X-Title": "Lamha clinic (hackathon demo)"}, json={
            "model": model(), "temperature": 0, "seed": 42, "max_tokens": 900,
            "response_format": {"type": "json_schema", "json_schema": {"name": "extraction", "strict": True, "schema": llm.SCHEMA}},
            "provider": {"data_collection": "deny"},  # ask OpenRouter to route only to providers that don't retain prompts
            "messages": [{"role": "system", "content": llm.SYSTEM},
                         {"role": "user", "content": llm.build_user_message(transcript, patient, computed)}],
        })
        r.raise_for_status()
        body = r.json()
        content = body["choices"][0]["message"]["content"]
        usage = body.get("usage") or {}
        with _lock:
            u = _usage()
            u["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
            u["completion_tokens"] += int(usage.get("completion_tokens") or 0)
            u["cost_usd"] = round(u.get("cost_usd", 0.0) + float(usage.get("cost") or 0.0), 6)
            _save_usage(u)
    except httpx.TimeoutException as e:
        return fail("timeout", e)
    except httpx.HTTPStatusError as e:
        return fail("http_error", f"{e.response.status_code}")
    except Exception as e:
        return fail("error", f"{type(e).__name__}: {e}")
    try:
        text = content.strip()
        if text.startswith("```"):
            text = text.strip("`").split("\n", 1)[1] if "\n" in text else text
        data = json.loads(text)
    except Exception as e:
        return fail("invalid_json", f"{type(e).__name__}: {e}")
    ok, why = llm.validate_extraction(data)
    if not ok:
        return fail("invalid_schema", why or "schema mismatch")
    ms = int((time.perf_counter() - t0) * 1000)
    state.update(last_latency_ms=ms, last_error=None)
    state["calls_ok"] += 1
    return {"ok": True, "data": data, "latency_ms": ms, "error": None, "error_detail": None, "model": label}


def chat(messages: list[dict], timeout_s: float | None = None) -> dict:
    """Patient chatbot fallback (chat.py). Same key handling + daily cap as extract().
    -> {'ok','text','latency_ms','error','model'}; never raises."""
    t0 = time.perf_counter()
    label = f"openrouter:{model()} (chat fallback)"

    def fail(code, detail):
        state["calls_failed"] += 1
        state["last_error"] = f"chat {code}: {detail}"[:200]
        return {"ok": False, "text": None, "latency_ms": int((time.perf_counter() - t0) * 1000), "error": code,
                "model": label}

    if not enabled():
        return fail("disabled", "no OPENROUTER_API_KEY or NAZRA_CLOUD_FALLBACK=0")
    with _lock:
        u = _usage()
        if u["calls"] >= daily_cap():
            return fail("budget", f"daily cap {daily_cap()} reached")
        u["calls"] += 1
        _save_usage(u)
    try:
        r = httpx.post("https://openrouter.ai/api/v1/chat/completions", timeout=timeout_s or 20, headers={
            "Authorization": f"Bearer {key()}", "X-Title": "Lamha clinic (hackathon demo)"}, json={
            "model": model(), "temperature": 0.3, "max_tokens": 350,
            "provider": {"data_collection": "deny"}, "messages": messages})
        r.raise_for_status()
        body = r.json()
        text = (body["choices"][0]["message"]["content"] or "").strip()
        usage = body.get("usage") or {}
        with _lock:
            u = _usage()
            u["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
            u["completion_tokens"] += int(usage.get("completion_tokens") or 0)
            u["cost_usd"] = round(u.get("cost_usd", 0.0) + float(usage.get("cost") or 0.0), 6)
            _save_usage(u)
    except httpx.TimeoutException as e:
        return fail("timeout", e)
    except httpx.HTTPStatusError as e:
        return fail("http_error", f"{e.response.status_code}")
    except Exception as e:
        return fail("error", f"{type(e).__name__}: {e}")
    if not text:
        return fail("empty", "no content")
    ms = int((time.perf_counter() - t0) * 1000)
    state.update(last_latency_ms=ms, last_error=None)
    state["calls_ok"] += 1
    return {"ok": True, "text": text, "latency_ms": ms, "error": None, "model": label}


def with_fallback(local_fn, cloud_timeout_s: float = 25):
    """Local first; on any local failure, try the cloud fallback; if that fails too, return the LOCAL failure
    (so the pipeline's rules-only path and labels stay exactly as before)."""

    def call(transcript, patient, computed):
        res = local_fn(transcript, patient, computed)
        if res.get("ok") or not enabled():
            return res
        cloud = extract(transcript, patient, computed, timeout_s=cloud_timeout_s)
        if cloud.get("ok"):
            cloud["fallback_from"] = res.get("error")
            return cloud
        return res

    return call


def health() -> dict:
    u = _usage()
    return {"status": "ok" if enabled() else "degraded", "loaded": enabled(), "warm": state["calls_ok"] > 0,
            "device": "cloud", "last_latency_ms": state["last_latency_ms"],
            "detail": {"role": "fallback only (local Gemma first)", "model": model(), "key_present": bool(key()),
                       "calls_today": u["calls"], "daily_cap": daily_cap(), "cost_today_usd": u.get("cost_usd", 0.0),
                       "last_error": state["last_error"]}}

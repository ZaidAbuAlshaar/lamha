"""Runtime health: per-component status, call latency tracking, hard timeouts, rules self-test, tunnel probe."""
from __future__ import annotations

import os
import queue
import re
import threading
import time

import httpx

import core

# ---------------------------------------------------------------- latency / call tracking
_mlock = threading.Lock()
metrics: dict[str, dict] = {
    name: {"last_latency_ms": None, "last_ok": None, "last_error": None, "last_at": None, "calls": 0,
           "failures": 0, "warm": False, "warmup_ms": None, "warmup_error": None}
    for name in ("whisper", "gemma")
}


def record(name: str, ms: int | float | None, ok: bool, error: str | None = None, warmup: bool = False):
    with _mlock:
        m = metrics[name]
        m["last_latency_ms"] = int(ms) if ms is not None else None
        m["last_ok"] = bool(ok)
        m["last_error"] = None if ok else (error or "error")[:200]
        m["last_at"] = time.time()
        if warmup:
            m["warmup_ms"] = m["last_latency_ms"]
            m["warmup_error"] = m["last_error"]
            m["warm"] = bool(ok)
        else:
            m["calls"] += 1
            m["failures"] += 0 if ok else 1
            if ok:
                m["warm"] = True


def snapshot(name: str) -> dict:
    with _mlock:
        return dict(metrics[name])


# ---------------------------------------------------------------- hard timeout (daemon thread, never blocks shutdown)
class CallTimeout(Exception):
    pass


def run_with_timeout(fn, timeout_s: float, /, *args, **kwargs):
    """Run fn in a daemon thread; raise CallTimeout after timeout_s. The worker keeps running in the background
    (Python threads cannot be killed) but the caller is released, so the patient is never blocked."""
    q: queue.Queue = queue.Queue(maxsize=1)

    def work():
        try:
            q.put((True, fn(*args, **kwargs)))
        except BaseException as e:  # noqa: BLE001 - re-raised in the caller
            q.put((False, e))

    threading.Thread(target=work, daemon=True, name=f"nazra-timeout-{getattr(fn, '__name__', 'call')}").start()
    try:
        ok, val = q.get(timeout=timeout_s)
    except queue.Empty:
        raise CallTimeout(f"no result after {timeout_s:g} s") from None
    if ok:
        return val
    raise val


def guarded_llm(extract_fn, timeout_s: float):
    """Wrap llm.extract with a hard timeout + latency recording. Returns an llm_fn for pipeline.analyze."""

    def call(transcript, patient, computed):
        t0 = time.perf_counter()
        try:
            res = run_with_timeout(extract_fn, timeout_s, transcript, patient, computed)
        except CallTimeout as e:
            res = {"ok": False, "data": None, "latency_ms": int((time.perf_counter() - t0) * 1000),
                   "error": "timeout", "error_detail": str(e), "model": None}
        except Exception as e:  # extract_fn should never raise, but never let it reach the patient
            res = {"ok": False, "data": None, "latency_ms": int((time.perf_counter() - t0) * 1000),
                   "error": "error", "error_detail": f"{type(e).__name__}: {e}"[:300], "model": None}
        record("gemma", res.get("latency_ms"), bool(res.get("ok")), res.get("error"))
        return res

    return call


# ---------------------------------------------------------------- rules self-test (fixed phrases, known answers)
_GOOD_VITALS = {"hr_bpm": 78, "hr_confidence": 0.9, "rr_bpm": 16, "rr_confidence": 0.8, "stress_index": 40,
                "stress_level": "moderate", "quality": "good", "scan_seconds": 30, "fps": 30}
SELFTEST_CASES = [
    # (phrase, expected red-flag codes, expected rule level)
    ("عندي وجع قوي بصدري", {"chest_pain"}, "emergency"),
    ("عندي كحة خفيفة من يومين", set(), "followup"),
    ("ما عندي وجع بصدري الحمدلله", set(), "followup"),
]
selftest: dict = {"ran": False, "passed": 0, "total": len(SELFTEST_CASES), "failures": [], "ms": None}


def run_rules_selftest() -> dict:
    t0 = time.perf_counter()
    failures = []
    for phrase, codes, level in SELFTEST_CASES:
        try:
            rf, syms, _, _ = core.lexicon_scan(phrase)
            got_codes = {r["code"] for r in rf}
            got_level, _, _ = core.rule_triage(dict(_GOOD_VITALS), rf, [], syms, phrase)
            if got_codes != codes or got_level != level:
                failures.append(f"{phrase!r}: flags={sorted(got_codes)} level={got_level}, "
                                f"expected flags={sorted(codes)} level={level}")
        except Exception as e:
            failures.append(f"{phrase!r}: {type(e).__name__}: {e}"[:200])
    selftest.update(ran=True, passed=len(SELFTEST_CASES) - len(failures), failures=failures,
                    ms=round((time.perf_counter() - t0) * 1000, 2))
    return dict(selftest)


# ---------------------------------------------------------------- tunnel probe (background, cached)
_TUNNEL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
TUNNEL_CACHE_S = 30.0
TUNNEL_TIMEOUT_S = 3.0
_tlock = threading.Lock()
tunnel: dict = {"url": None, "source": None, "status": None, "latency_ms": None, "checked_at": None,
                "error": None, "probing": False}


def tunnel_url() -> tuple[str | None, str | None]:
    url = (os.environ.get("NAZRA_PUBLIC_URL") or "").strip().rstrip("/")
    if url:
        return url, "env NAZRA_PUBLIC_URL"
    log = os.environ.get("NAZRA_TUNNEL_LOG", r"E:\nazra-tunnel.log")
    try:
        with open(log, encoding="utf-8", errors="replace") as f:
            m = _TUNNEL_RE.search(f.read(2_000_000))
        return (m.group(0), f"log {log}") if m else (None, f"no trycloudflare URL in {log}")
    except OSError as e:
        return None, f"tunnel log unreadable: {type(e).__name__}"


def _probe():
    url, source = tunnel_url()
    res = {"url": url, "source": source, "checked_at": time.time(), "latency_ms": None}
    if not url:
        res.update(status=None, error=source)
    else:
        t0 = time.perf_counter()
        try:
            r = httpx.get(url + "/api/health", timeout=TUNNEL_TIMEOUT_S)
            res["latency_ms"] = int((time.perf_counter() - t0) * 1000)
            ok = r.status_code == 200 and r.json().get("ok") is True
            res.update(status=ok, error=None if ok else f"HTTP {r.status_code}")
        except Exception as e:
            res["latency_ms"] = int((time.perf_counter() - t0) * 1000)
            res.update(status=False, error=f"{type(e).__name__}: {e}"[:160])
    with _tlock:
        tunnel.update(res, probing=False)


def tunnel_snapshot() -> dict:
    """Never blocks: returns the cached probe and kicks a background refresh when stale."""
    with _tlock:
        stale = tunnel["checked_at"] is None or time.time() - tunnel["checked_at"] > TUNNEL_CACHE_S
        if stale and not tunnel["probing"]:
            tunnel["probing"] = True
            threading.Thread(target=_probe, daemon=True, name="nazra-tunnel-probe").start()
        return dict(tunnel)


# ---------------------------------------------------------------- components
def _comp(status, loaded, warm, latency, detail, device=None) -> dict:
    d = {"status": status, "loaded": bool(loaded), "warm": bool(warm), "last_latency_ms": latency, "detail": detail}
    if device:
        d["device"] = device
    return d


def whisper_component(asr_state: dict) -> dict:
    m = snapshot("whisper")
    dev = {"cuda": "GPU", "cpu": "CPU"}.get(asr_state.get("device") or "")
    ready = bool(asr_state.get("ready"))
    if not ready:
        err = asr_state.get("error")
        return _comp("down" if err else "degraded", False, False, m["last_latency_ms"],
                     f"load failed: {err}"[:200] if err else "loading", dev)
    status, parts = "ok", [f"{asr_state.get('model')} {asr_state.get('compute_type')}"]
    if dev == "CPU":
        status = "degraded"
        parts.append("running on CPU (slower)")
    if m["warmup_ms"] is not None:
        parts.append(f"warm-up {m['warmup_ms']} ms")
    if m["calls"]:
        parts.append(f"{m['calls']} call(s), {m['failures']} failed")
    if m["calls"] and m["last_ok"] is False:
        status = "degraded"
        parts.append(f"last call failed: {m['last_error']}")
    return _comp(status, True, True, m["last_latency_ms"], "; ".join(parts), dev)


def gemma_component(model: str, models: list[dict] | None, ps_error: str | None) -> dict:
    m = snapshot("gemma")
    if ps_error is not None:
        return _comp("down", False, False, m["last_latency_ms"], f"Ollama unreachable: {ps_error}"[:200])
    entry = next((x for x in models or [] if x.get("name") == model), None)
    if entry is None:
        return _comp("degraded", False, False, m["last_latency_ms"],
                     f"{model} not resident in Ollama (first call will load it slowly)")
    size, vram = int(entry.get("size") or 0), int(entry.get("size_vram") or 0)
    dev = "GPU" if vram > 0 else "CPU"
    parts = [model]
    if vram and size and vram < size:
        parts.append(f"partial GPU offload {round(100 * vram / size)}%")
    status = "ok"
    if dev == "CPU":
        status = "degraded"
        parts.append("running on CPU (slower)")
    if m["warmup_ms"] is not None:
        parts.append(f"warm-up {m['warmup_ms']} ms" + ("" if m["warm"] or m["calls"] else f" failed: {m['warmup_error']}"))
    if m["calls"]:
        parts.append(f"{m['calls']} call(s), {m['failures']} failed")
    if not m["warm"]:
        status = "degraded"
        parts.append("not warmed up yet")
    if m["calls"] and m["last_ok"] is False:
        status = "degraded"
        parts.append(f"last call failed: {m['last_error']} (rules-only fallback used)")
    return _comp(status, True, m["warm"], m["last_latency_ms"], "; ".join(parts), dev)


def rules_component() -> dict:
    s = dict(selftest)
    if not s["ran"]:
        return _comp("degraded", True, False, None, "self-test not run yet")
    ok = not s["failures"]
    detail = f"self-test {s['passed']}/{s['total']} passed"
    if not ok:
        detail += ": " + " | ".join(s["failures"])[:300]
    lat = int(round(s["ms"])) if s["ms"] is not None else None
    return _comp("ok" if ok else "down", True, True, lat, detail)


def database_component(store) -> dict:
    t0 = time.perf_counter()
    try:
        c = store.counts()
        ms = int((time.perf_counter() - t0) * 1000)
        return _comp("ok", True, True, ms, f"sqlite {store.DB_PATH.name}: {c['patients']} patients, "
                                          f"{c['checkins']} check-ins, {c['diagnostics']} diagnostics")
    except Exception as e:
        return _comp("down", False, False, None, f"{type(e).__name__}: {e}"[:200])


def tunnel_component() -> dict:
    t = tunnel_snapshot()
    if not t["url"]:
        if t["checked_at"] is None:
            return _comp("degraded", False, False, None, "probing")
        return _comp("down", False, False, None, t.get("error") or "no tunnel URL")
    if t["status"] is None:
        return _comp("degraded", True, False, None, f"{t['url']} probing")
    age = int(time.time() - t["checked_at"]) if t["checked_at"] else None
    if t["status"]:
        return _comp("ok", True, True, t["latency_ms"], f"{t['url']} reachable (checked {age}s ago)")
    return _comp("down", True, False, t["latency_ms"], f"{t['url']} probe failed: {t['error']} (checked {age}s ago)")

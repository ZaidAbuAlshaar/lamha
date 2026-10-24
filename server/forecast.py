"""HR forecast (linear LS + 80% prediction interval), local Chronos-Bolt cross-check, Gemma doctor note.

- Linear trend on the last 7 good daily values; 24 h / 48 h point forecasts, ALWAYS with their interval.
- Chronos-Bolt (amazon/chronos-bolt-small, Apache-2.0, local, zero-shot) runs in a separate torch venv as a persistent
  subprocess worker (JSON lines over stdin/stdout), so the server venv stays torch-free.
- Doctor note via local Ollama; every number must come from the facts (±1) or a fixed template is used.
Flags: NAZRA_CHRONOS (1), NAZRA_CHRONOS_PY, NAZRA_CHRONOS_MODEL, NAZRA_CHRONOS_TIMEOUT_S (60), NAZRA_FORECAST_NOTE_AI (1).
"""
from __future__ import annotations

import json
import math
import os
import queue
import re
import subprocess
import threading
import time
from datetime import timedelta

import core
from monitor import DISCLAIMER_AR

MIN_POINTS = 7
S_FLOOR = 3.0
# t(0.90, df): two-sided 80% prediction interval
T90 = {1: 3.078, 2: 1.886, 3: 1.638, 4: 1.533, 5: 1.476, 6: 1.440, 7: 1.415, 8: 1.397, 9: 1.383, 10: 1.372,
       11: 1.363, 12: 1.356}
NO_FORECAST_AR = "لا يوجد توقّع قبل 7 قراءات جيدة"
AGREE_AR = "متوافق"
UNCERTAIN_AR = "عدم يقين مرتفع"
LINEAR_ONLY_AR = "توقّع خطّي فقط — نموذج Chronos غير متاح حالياً"


# ---------------------------------------------------------------- linear
def linear(days: list[dict]) -> dict | None:
    """days: monitor.daily_values() output (oldest first). Uses the last 7 good days."""
    pts = days[-MIN_POINTS:]
    if len(pts) < MIN_POINTS:
        return None
    t0 = pts[-1]["date"]
    xs = [float((d["date"] - t0).days) for d in pts]
    ys = [float(d["hr"]) for d in pts]
    n = len(xs)
    xb, yb = sum(xs) / n, sum(ys) / n
    sxx = sum((x - xb) ** 2 for x in xs)
    slope = sum((x - xb) * (y - yb) for x, y in zip(xs, ys)) / sxx
    icpt = yb - slope * xb
    sse = sum((y - (icpt + slope * x)) ** 2 for x, y in zip(xs, ys))
    resid_sd = math.sqrt(sse / (n - 2))
    s = max(resid_sd, S_FLOOR)
    t = T90[n - 2]
    out = []
    for h in (1, 2):
        yhat = icpt + slope * h
        half = t * s * math.sqrt(1 + 1 / n + (h - xb) ** 2 / sxx)
        out.append({"h": 24 * h, "date": (t0 + timedelta(days=h)).isoformat(), "hr": round(yhat, 1),
                    "lo": round(yhat - half, 1), "hi": round(yhat + half, 1)})
    return {"method": "linear_ls", "n": n, "slope_per_day": round(slope, 2), "resid_sd": round(resid_sd, 2),
            "s": round(s, 2), "t": t, "level": 0.8, "from": pts[0]["date"].isoformat(), "points": out}


# ---------------------------------------------------------------- chronos worker
WORKER_SRC = r'''
import json, os, sys, time
os.environ.setdefault("HF_HUB_OFFLINE", "1")
try:
    import torch
    from chronos import BaseChronosPipeline
    name = None
    for m in sys.argv[1:]:
        try:
            pipe = BaseChronosPipeline.from_pretrained(m, device_map="cpu", torch_dtype=torch.float32)
            name = m
            break
        except Exception as e:
            sys.stderr.write("load failed %s: %s\n" % (m, e))
    if name is None:
        raise RuntimeError("no chronos model could be loaded")
    torch.set_num_threads(2)
    print(json.dumps({"ready": True, "model": name, "device": "CPU"}), flush=True)
except Exception as e:
    print(json.dumps({"ready": False, "error": str(e)[:300]}), flush=True)
    sys.exit(1)
for line in sys.stdin:
    try:
        req = json.loads(line)
        t = time.perf_counter()
        q, _ = pipe.predict_quantiles(torch.tensor(req["series"], dtype=torch.float32),
                                      prediction_length=int(req.get("horizon", 2)), quantile_levels=[0.1, 0.5, 0.9])
        q = q[0].tolist()
        print(json.dumps({"ok": True, "q10": [r[0] for r in q], "median": [r[1] for r in q], "q90": [r[2] for r in q],
                          "model": name, "latency_ms": round((time.perf_counter() - t) * 1000)}), flush=True)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}), flush=True)
'''

_lock = threading.Lock()
_state = {"proc": None, "q": None, "model": None, "loaded": False, "warm": False, "last_latency_ms": None,
          "load_ms": None, "detail": "not started", "status": "down"}
_cache: dict[str, dict] = {}


def chronos_enabled() -> bool:
    return os.environ.get("NAZRA_CHRONOS", "1") != "0"


def _py() -> str:
    return os.environ.get("NAZRA_CHRONOS_PY", r"D:\nazra-chronos-venv\Scripts\python.exe")


def _timeout() -> float:
    return float(os.environ.get("NAZRA_CHRONOS_TIMEOUT_S", "60"))


def _reader(proc, q):
    for line in proc.stdout:
        q.put(line)
    q.put(None)


def _start():
    """Start the worker if needed (caller holds _lock). Returns True when ready."""
    p = _state["proc"]
    if p is not None and p.poll() is None and _state["loaded"]:
        return True
    if time.time() < _state.get("next_try", 0):  # back off after a failed start (never block every request)
        return False
    if not os.path.exists(_py()):
        _state.update(status="down", loaded=False, detail=f"chronos venv missing: {_py()}")
        return False
    env = dict(os.environ)
    env.setdefault("HF_HOME", r"D:\models\hf")
    env["HF_HUB_OFFLINE"] = "1"
    env.pop("PYTHONPATH", None)
    models = [os.environ.get("NAZRA_CHRONOS_MODEL", "amazon/chronos-bolt-small"), "amazon/chronos-bolt-tiny"]
    t = time.perf_counter()
    proc = subprocess.Popen([_py(), "-I", "-c", WORKER_SRC, *models], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", env=env,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    q: queue.Queue = queue.Queue()
    threading.Thread(target=_reader, args=(proc, q), daemon=True).start()
    try:
        line = q.get(timeout=_timeout() * 2)
        msg = json.loads(line) if line else {"ready": False, "error": "worker exited"}
    except Exception as e:  # noqa: BLE001
        msg = {"ready": False, "error": f"start timeout/invalid: {e}"}
    if not msg.get("ready"):
        proc.kill()
        _state.update(proc=None, status="down", loaded=False, detail=str(msg.get("error"))[:200],
                      next_try=time.time() + 120)
        return False
    _state.update(proc=proc, q=q, model=msg.get("model"), loaded=True, status="ok",
                  load_ms=round((time.perf_counter() - t) * 1000), detail=f"{msg.get('model')} on CPU")
    return True


def chronos_predict(series: list[float], horizon: int = 2) -> dict | None:
    """{'q10','median','q90','model','latency_ms'} or None if Chronos is unavailable."""
    if not chronos_enabled() or len(series) < 3:
        return None
    key = json.dumps([round(x, 1) for x in series[-64:]] + [horizon])
    if key in _cache:
        return _cache[key]
    with _lock:
        if not _start():
            return None
        proc, q = _state["proc"], _state["q"]
        try:
            proc.stdin.write(json.dumps({"series": series[-64:], "horizon": horizon}) + "\n")
            proc.stdin.flush()
            line = q.get(timeout=_timeout())
            res = json.loads(line) if line else None
        except Exception as e:  # noqa: BLE001
            res = None
            _state["detail"] = f"predict failed: {e}"[:200]
        if not res or not res.get("ok"):
            if proc.poll() is not None or res is None:
                proc.kill()
                _state.update(proc=None, loaded=False, status="down")
            return None
    _state.update(warm=True, last_latency_ms=res.get("latency_ms"))
    if len(_cache) > 256:
        _cache.clear()
    _cache[key] = res
    return res


def warm() -> bool:
    return chronos_predict([70.0, 71.0, 70.5, 72.0, 71.0, 70.0, 71.5]) is not None


def health() -> dict:
    p = _state["proc"]
    alive = p is not None and p.poll() is None
    if not chronos_enabled():
        return {"status": "down", "loaded": False, "warm": False, "device": None, "last_latency_ms": None,
                "detail": "disabled (NAZRA_CHRONOS=0) — linear forecast only"}
    return {"status": "ok" if alive and _state["loaded"] else ("down" if not os.path.exists(_py()) else "degraded"),
            "loaded": bool(alive and _state["loaded"]), "warm": _state["warm"], "device": "CPU",
            "last_latency_ms": _state["last_latency_ms"], "load_ms": _state["load_ms"], "model": _state["model"],
            "detail": _state["detail"] if alive or not _state["loaded"] else "worker stopped"}


# ---------------------------------------------------------------- agreement
def agreement(lin: dict | None, chr_: dict | None) -> dict:
    if lin is None:
        return {"status": "none", "label_ar": NO_FORECAST_AR, "chronos": None}
    if chr_ is None:
        return {"status": "linear_only", "label_ar": LINEAR_ONLY_AR, "chronos": None}
    pts, inside = [], True
    for i, p in enumerate(lin["points"]):
        med, q10, q90 = (round(float(chr_[k][i]), 1) for k in ("median", "q10", "q90"))
        ok = p["lo"] <= med <= p["hi"]
        inside = inside and ok
        pts.append({"h": p["h"], "median": med, "q10": q10, "q90": q90, "inside": ok,
                    "lo": p["lo"] if ok else round(min(p["lo"], q10, med), 1),
                    "hi": p["hi"] if ok else round(max(p["hi"], q90, med), 1)})
    return {"status": "agree" if inside else "uncertain", "label_ar": AGREE_AR if inside else UNCERTAIN_AR,
            "chronos": {"model": chr_.get("model"), "latency_ms": chr_.get("latency_ms"), "points": pts}}


def apply_agreement(lin: dict | None, agr: dict) -> dict | None:
    """When the models disagree, the shown interval is widened to cover both."""
    if lin is None or agr["status"] != "uncertain":
        return lin
    out = json.loads(json.dumps(lin))
    for p, c in zip(out["points"], agr["chronos"]["points"]):
        p["lo"], p["hi"], p["widened"] = c["lo"], c["hi"], True
    return out


# ---------------------------------------------------------------- doctor note (Gemma, number-guarded)
BANNED = re.compile(r"(%|٪|احتمال|نسبة|مستشفى|المستشفى|تدهور|وفاة|خطر الموت)")


def note_facts(mon: dict, fc: dict | None, agr: dict) -> dict:
    b, la, cs = mon["baseline"], mon["latest"], mon["cusum"]
    f = {"baseline_hr": b["median"] if b else None, "baseline_days": b["n_days"] if b else None,
         "latest_hr": la["hr"] if la else None, "latest_flag": la["flag"] if la else None,
         "sustained_rise": bool(cs["alarm"]), "rise_days": len(cs["alarm_dates"]),
         "agreement": agr.get("label_ar"),
         "symptoms_ar": sorted({s for p in mon.get("points", []) for s in p.get("symptoms", [])})}
    if fc:
        p24, p48 = fc["points"]
        f.update(forecast_24h=p24["hr"], forecast_24h_range=[p24["lo"], p24["hi"]], forecast_48h=p48["hr"],
                 forecast_48h_range=[p48["lo"], p48["hi"]],
                 forecast_trend_ar="صاعد" if fc["slope_per_day"] > 0.5 else ("هابط" if fc["slope_per_day"] < -0.5 else "ثابت"))
    return f


def llm_view(facts: dict) -> dict:
    """What Gemma sees: no forecast numbers (a forecast number must never appear without its interval)."""
    return {k: v for k, v in facts.items() if not (k.startswith("forecast_") and k != "forecast_trend_ar")}


def allowed_from(facts: dict) -> list[float]:
    out = []
    for v in facts.values():
        for x in (v if isinstance(v, list) else [v]):
            if isinstance(x, (int, float)) and not isinstance(x, bool):
                out.append(float(x))
    return out + [24.0, 48.0]


# Spelled-out numbers would bypass the digit guard (seen live: Gemma wrote a wrong baseline in words) -> reject them.
NUM_WORDS = set(core.normalize(
    "واحد واحده اثنين اثنان اتنين ثنتين ثلاث ثلاثه تلات تلاته اربع اربعه خمس خمسه ست سته سبع سبعه ثمان ثماني ثمانيه "
    "تمانيه تسع تسعه عشر عشره عشرين عشرون ثلاثين ثلاثون اربعين اربعون خمسين خمسون ستين ستون سبعين سبعون ثمانين "
    "ثمانون تسعين تسعون مئه ميه مائه ميت مئتين ميتين الف فاصل فاصله نص ربع").split())
_TOK = re.compile(r"[؀-ۿ]+")


def spelled_numbers(text: str) -> list[str]:
    out = []
    for tok in _TOK.findall(core.normalize(text or "")):
        for pre in ("وال", "بال", "ال", "و", "ب"):
            if tok.startswith(pre) and tok[len(pre):] in NUM_WORDS:
                tok = tok[len(pre):]
                break
        if tok in NUM_WORDS:
            out.append(tok)
    return out


def guard(text: str | None, facts: dict) -> tuple[bool, str]:
    t = (text or "").strip()
    if not t or len(t) > 600 or BANNED.search(t):
        return False, "banned_or_empty"
    if spelled_numbers(t):
        return False, "spelled_numbers"
    ok, bad = core.numbers_ok([t], allowed_from(facts), "")
    return (ok, "ok" if ok else f"invented_numbers:{bad[:5]}")


def template_note(facts: dict) -> str:
    if facts.get("baseline_hr") is None:
        s = "لسا ما في قراءات كافية لحساب المعدل المعتاد للنبض."
    elif facts.get("sustained_rise"):
        s = (f"النبض ارتفع بشكل مستمر فوق معدله المعتاد ({facts['baseline_hr']:.0f} ن/د)، "
             f"وآخر قراءة {facts['latest_hr']:.0f} ن/د.")
    else:
        s = f"النبض قريب من معدله المعتاد ({facts['baseline_hr']:.0f} ن/د)، وآخر قراءة {facts['latest_hr']:.0f} ن/د."
    if facts.get("forecast_24h") is not None:
        lo, hi = facts["forecast_24h_range"]
        s += f" التوقّع الخطي بعد 24 ساعة حوالي {facts['forecast_24h']:.0f} ن/د (المدى {lo:.0f}–{hi:.0f})، {facts['agreement']}."
    if facts.get("symptoms_ar"):
        s += " أعراض مذكورة: " + "، ".join(facts["symptoms_ar"][:4]) + "."
    return s + f" {DISCLAIMER_AR}."


SYSTEM = ("أنت مساعد لطبيب. اكتب 2-3 جمل عربية قصيرة تلخّص اتجاه نبض المريض للطبيب، من الحقائق المعطاة فقط. "
          "اكتب الأرقام بالأرقام فقط (مثل 72) ولا تكتبها بالكلمات، ولا تكتب أي رقم غير موجود في الحقائق. لا تكتب نسب أو احتمالات دخول مستشفى أو تدهور. لا تشخّص. "
          "اكتب النص فقط بدون عناوين.")


def _ollama_chat(facts: dict) -> str | None:
    import httpx
    url = os.environ.get("OLLAMA_HOST_URL", "http://127.0.0.1:11434").rstrip("/") + "/api/chat"
    body = {"model": os.environ.get("NAZRA_LLM", "gemma4:e4b-it-qat"), "stream": False, "think": False,
            "options": {"temperature": 0},
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": "الحقائق (JSON):\n" + json.dumps(facts, ensure_ascii=False)}]}
    r = httpx.post(url, json=body, timeout=20.0)
    r.raise_for_status()
    return ((r.json().get("message") or {}).get("content") or "").strip()


_note_cache: dict[str, dict] = {}
_llm_down_until = [0.0]


def doctor_note(facts: dict, cache_key: str | None = None, chat=None) -> dict:
    """{'text_ar','source':'ai'|'template','numbers_verified','reason'}. Never raises."""
    key = (cache_key or "") + json.dumps(facts, ensure_ascii=False, sort_keys=True)
    if key in _note_cache:
        return _note_cache[key]
    res = None
    if time.time() < _llm_down_until[0]:  # Gemma failed recently: template now, retry after 60 s
        res = {"text_ar": template_note(facts), "source": "template", "numbers_verified": True,
               "reason": "llm_unavailable: backoff"}
    elif os.environ.get("NAZRA_FORECAST_NOTE_AI", "1") != "0":
        try:
            text = (chat or _ollama_chat)(llm_view(facts))
            ok, why = guard(text, llm_view(facts))
            if ok:
                if DISCLAIMER_AR not in text:
                    text = text.rstrip() + f" {DISCLAIMER_AR}."
                res = {"text_ar": text, "source": "ai", "numbers_verified": True, "reason": "ok"}
            else:
                res = {"text_ar": template_note(facts), "source": "template", "numbers_verified": False,
                       "reason": why}
        except Exception as e:  # noqa: BLE001
            res = {"text_ar": template_note(facts), "source": "template", "numbers_verified": True,
                   "reason": f"llm_unavailable: {type(e).__name__}"}
            if chat is None:
                _llm_down_until[0] = time.time() + 60
    if res is None:
        res = {"text_ar": template_note(facts), "source": "template", "numbers_verified": True, "reason": "disabled"}
    if len(_note_cache) > 128:
        _note_cache.clear()
    if res["source"] == "ai" or res["reason"] in ("disabled", "spelled_numbers") or res["reason"].startswith("invented"):
        _note_cache[key] = res
    return res

"""Nazra clinic server (FastAPI, port 8787). Triage aid — not a diagnosis."""
from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402

import asr  # noqa: E402
import core  # noqa: E402
import health  # noqa: E402
import llm  # noqa: E402
import pipeline  # noqa: E402
import store  # noqa: E402
import alerts, alerts_api  # noqa: E402,E401  v2 center alerts

VERSION = "0.1.0"
DIST = Path(__file__).resolve().parent.parent / "web" / "dist"
boot = {"llm_preload_error": None, "unloaded": [], "started": time.time()}
ASR_TIMEOUT_S = float(os.environ.get("NAZRA_ASR_TIMEOUT_S", "30"))
LLM_TIMEOUT_S = float(os.environ.get("NAZRA_LLM_TIMEOUT_S", "25"))
WARMUP_TIMEOUT_S = float(os.environ.get("NAZRA_WARMUP_TIMEOUT_S", "90"))  # cold load is allowed to be slow
ASR_TMP_DIR = os.environ.get("NAZRA_TMP_DIR") or None  # None = system temp dir
WARMUP_PATIENT = {"id": "warmup", "age": 40, "sex": "m", "conditions_ar": []}
WARMUP_COMPUTED = {"vitals": {}, "baseline_14d": {}, "trend_alerts": [], "red_flags": [], "rule_level": "followup"}


def warmup_gemma():
    """One tiny real extraction so the first patient request does not pay the cold-start cost."""
    t0 = time.perf_counter()
    try:
        res = health.run_with_timeout(llm.extract, WARMUP_TIMEOUT_S, "عندي كحة خفيفة", WARMUP_PATIENT, WARMUP_COMPUTED,
                                     timeout_s=WARMUP_TIMEOUT_S)
    except health.CallTimeout:
        res = {"ok": False, "error": "timeout", "latency_ms": int((time.perf_counter() - t0) * 1000)}
    health.record("gemma", res.get("latency_ms"), bool(res.get("ok")), res.get("error"), warmup=True)
    return res


def _load_models():
    if os.environ.get("NAZRA_NO_MODELS") == "1":
        return
    try:
        boot["unloaded"] = llm.free_vram_and_preload(llm.MODEL, free=os.environ.get("NAZRA_FREE_VRAM", "1") != "0")
    except Exception as e:
        boot["llm_preload_error"] = f"{type(e).__name__}: {e}"[:300]
    if os.environ.get("NAZRA_WARMUP", "1") != "0":
        warmup_gemma()
    asr.load()
    if asr.state["ready"] and asr.warmup_ms is not None:
        health.record("whisper", asr.warmup_ms, True, warmup=True)


@asynccontextmanager
async def lifespan(app):
    store.con()
    store.seed_if_empty()
    health.run_rules_selftest()
    threading.Thread(target=_load_models, daemon=True).start()
    yield


app = FastAPI(title="Nazra", version=VERSION, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ---------------------------------------------------------------- helpers
def _eff_level(c: dict | None) -> str | None:
    if not c:
        return None
    if c.get("review") and c["review"].get("final_level") in core.LEVEL_RANK:
        return c["review"]["final_level"]
    return c["triage"]["level"]


def _history(checkins_oldest_first: list[dict], days: int) -> list[dict]:
    lo = datetime.now(core.AMMAN) - timedelta(days=days)
    out = []
    for c in checkins_oldest_first:
        t = core.parse_ts(c["created_at"])
        if t >= lo:
            v = c["vitals"]
            out.append({"date": t.astimezone(core.AMMAN).strftime("%Y-%m-%d"), "hr": v.get("hr_bpm"),
                        "rr": v.get("rr_bpm"), "stress": v.get("stress_index")})
    return out


# ---------------------------------------------------------------- API
# v2 routers
app.include_router(alerts_api.router)


@app.get("/api/health")
def health_route():
    models, ps_error = None, None
    try:
        models = llm.ps()
    except Exception as e:
        ps_error = f"{type(e).__name__}: {e}"[:200]
    ls = llm.status(llm.MODEL, models=models, ps_error=ps_error)
    if boot["llm_preload_error"] and not ls["ready"]:
        ls["error"] = ls["error"] or boot["llm_preload_error"]
    components = {
        "whisper": health.whisper_component(asr.state),
        "gemma": health.gemma_component(llm.MODEL, models, ps_error),
        "rules": health.rules_component(),
        "database": health.database_component(store),
        "tunnel": health.tunnel_component(),
    }
    return {"ok": True, "whisper": dict(asr.state), "llm": ls, "version": VERSION, "components": components}


def _rm(path: str) -> bool:
    try:
        os.remove(path)  # privacy: audio is never stored
        return True
    except FileNotFoundError:
        return True
    except OSError:
        return False


@app.post("/api/transcribe")
def transcribe(audio: UploadFile = File(...)):
    if not asr.state["ready"]:
        raise HTTPException(503, detail="Whisper model is still loading or failed to load: "
                                        + str(asr.state.get("error") or "loading"))
    suffix = Path(audio.filename or "a.webm").suffix or ".webm"
    if not suffix.isascii() or len(suffix) > 6:
        suffix = ".webm"
    fd, path = tempfile.mkstemp(prefix="nazra_", suffix=suffix, dir=ASR_TMP_DIR)

    def job():
        try:
            return asr.transcribe(path)
        finally:
            _rm(path)  # the worker always deletes, even if the caller already gave up (timeout)

    t0 = time.perf_counter()
    try:
        with os.fdopen(fd, "wb") as f:
            while chunk := audio.file.read(1 << 20):
                f.write(chunk)
        try:
            out = health.run_with_timeout(job, ASR_TIMEOUT_S)
        except health.CallTimeout:
            health.record("whisper", (time.perf_counter() - t0) * 1000, False, "timeout")
            raise HTTPException(504, detail=f"transcription timed out after {ASR_TIMEOUT_S:g} s — "
                                            "please type your symptoms / اكتب أعراضك")
        except Exception as e:
            health.record("whisper", (time.perf_counter() - t0) * 1000, False, type(e).__name__)
            raise HTTPException(422, detail=f"could not transcribe audio: {type(e).__name__}: {e}"[:300])
        health.record("whisper", (time.perf_counter() - t0) * 1000, True)
        return out
    finally:
        _rm(path)


# ---------------------------------------------------------------- scan diagnostics (numbers only, no media)
DIAG_ENABLED = os.environ.get("NAZRA_DIAGNOSTICS", "1") != "0"


def _numbers_only(x, depth=0):
    """Keep numbers, booleans and short strings; drop anything that could carry media (long strings, base64)."""
    if depth > 6:
        return None
    if isinstance(x, bool) or x is None:
        return x
    if isinstance(x, (int, float)):
        return x if x == x and abs(x) < 1e12 else None
    if isinstance(x, str):
        return x[:300] if len(x) <= 300 else None
    if isinstance(x, list):
        return [_numbers_only(v, depth + 1) for v in x[:600]]
    if isinstance(x, dict):
        return {str(k)[:60]: _numbers_only(v, depth + 1) for k, v in list(x.items())[:200]}
    return None


@app.post("/api/diagnostics")
def post_diagnostics(body: dict = Body(...)):
    if not DIAG_ENABLED:
        raise HTTPException(404, detail="diagnostics disabled")
    import json as _json
    if len(_json.dumps(body)) > 96_000:
        raise HTTPException(413, detail="diagnostics record too large")
    d = _numbers_only(body) or {}
    d["id"] = "d-" + uuid.uuid4().hex[:10]
    d["ts"] = time.time()
    d["received_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    d.setdefault("checkin_id", None)
    store.put_diagnostics(d)
    return {"id": d["id"]}


@app.get("/api/diagnostics/latest")
def get_diagnostics(n: int = 1):
    return store.latest_diagnostics(max(1, min(n, 50)))


@app.get("/api/patients/public")
def patients_public():
    """For the patient phone's picker: synthetic demo profiles only, no check-ins, transcripts or vitals."""
    keep = ("id", "name_ar", "name_en", "age", "sex", "location_ar", "location_en", "conditions_ar", "conditions_en", "simulated")
    return [{k: p.get(k) for k in keep} for p in store.list_patients() if p.get("simulated")]


@app.get("/api/patients")
def patients():
    out = []
    for p in store.list_patients():
        cks = store.patient_checkins(p["id"], newest_first=False)
        latest = cks[-1] if cks else None
        out.append({**p, "latest": latest, "history": _history(cks, 14), "checkin_count": len(cks)})

    def key(x):
        lv = _eff_level(x["latest"])
        rank = core.LEVEL_RANK[lv] if lv else -1
        ts = core.parse_ts(x["latest"]["created_at"]).timestamp() if x["latest"] else 0
        return (-rank, -ts)

    out.sort(key=key)
    return out


@app.post("/api/patients")
def create_patient(body: dict = Body(...)):
    name_ar = (body.get("name_ar") or "").strip()
    if not name_ar:
        raise HTTPException(422, detail="name_ar is required")
    age = body.get("age")
    try:
        age = int(age) if age not in (None, "") else None
    except (TypeError, ValueError):
        age = None
    p = store.new_patient(name_ar, body.get("name_en"), age, body.get("sex"), body.get("location_ar"),
                          simulated=False)
    store.put_patient(p)
    return p


@app.get("/api/patients/{pid}")
def patient_detail(pid: str):
    p = store.get_patient(pid)
    if not p:
        raise HTTPException(404, detail="patient not found")
    asc = store.patient_checkins(pid, newest_first=False)
    baseline = None
    if asc:
        b = core.compute_baseline(asc[:-1], core.parse_ts(asc[-1]["created_at"]))
        if b["n"]:
            baseline = {"hr": b["hr"], "rr": b["rr"], "stress": b["stress"], "n": b["n"]}
    return {"patient": p, "checkins": list(reversed(asc)), "history": _history(asc, 30), "baseline": baseline}


@app.post("/api/checkins")
def create_checkin(body: dict = Body(...)):
    p = store.get_patient(body.get("patient_id") or "")
    if not p:
        raise HTTPException(404, detail="patient not found")
    prev = store.patient_checkins(p["id"], newest_first=False)
    c = pipeline.analyze(p, body.get("vitals") or {}, body.get("transcript") or "",
                         body.get("transcript_source") or "", prev,
                         llm_fn=health.guarded_llm(llm.extract, LLM_TIMEOUT_S), simulated=False)
    if body.get("diagnostics_id"):
        c["diagnostics_id"] = str(body["diagnostics_id"])[:20]
    store.put_checkin(c)
    if (alert_id := alerts.on_checkin(c, p)):  # v2 center: emergency -> nearest partner center
        c["alert_id"] = alert_id; store.put_checkin(c)  # noqa: E702
    if c.get("diagnostics_id"):
        store.link_diagnostics(c["diagnostics_id"], c["id"])
    return c


@app.get("/api/checkins")
def list_checkins(since: str | None = None, limit: int = 50):
    ts = None
    if since:
        try:
            ts = core.parse_ts(since).timestamp()
        except ValueError:
            raise HTTPException(422, detail="since must be ISO-8601")
    return store.recent_checkins(ts, max(1, min(int(limit), 500)))


@app.post("/api/checkins/{cid}/review")
def review(cid: str, body: dict = Body(...)):
    c = store.get_checkin(cid)
    if not c:
        raise HTTPException(404, detail="checkin not found")
    decision = body.get("decision")
    if decision not in ("confirm", "override"):
        raise HTTPException(422, detail="decision must be confirm|override")
    final = body.get("final_level") or c["triage"]["level"]
    if final not in core.LEVEL_RANK:
        raise HTTPException(422, detail="final_level must be emergency|appointment|followup")
    if decision == "confirm":
        final = c["triage"]["level"]
    c["review"] = {"decision": decision, "final_level": final, "note": str(body.get("note") or ""),
                   "reviewed_at": datetime.now(core.AMMAN).isoformat(timespec="seconds")}
    store.put_checkin(c)
    return c


@app.get("/api/validation")
def validation():
    pairs = []
    for c in store.all_checkins():
        v = c.get("vitals") or {}
        if c.get("simulated") or v.get("hr_bpm") is None or v.get("ref_hr_bpm") is None:
            continue
        pairs.append({"checkin_id": c["id"], "patient_id": c["patient_id"], "rppg": float(v["hr_bpm"]),
                      "ref": float(v["ref_hr_bpm"]), "quality": v.get("quality"), "created_at": c["created_at"]})
    n = len(pairs)
    if not n:
        return {"n": 0, "mae_bpm": None, "rmse_bpm": None, "within_5_pct": None, "pairs": []}
    errs = [p["rppg"] - p["ref"] for p in pairs]
    return {"n": n, "mae_bpm": round(sum(abs(e) for e in errs) / n, 2),
            "rmse_bpm": round(math.sqrt(sum(e * e for e in errs) / n), 2),
            "within_5_pct": round(100.0 * sum(1 for e in errs if abs(e) <= 5) / n, 1), "pairs": pairs}


# ---------------------------------------------------------------- dev recordings (ground-truth videos, opt-in)
REC_EXTS = {".webm", ".mp4", ".mov", ".mkv", ".m4v"}
REPO_ROOT = Path(__file__).resolve().parents[2]


def _rec_enabled() -> bool:
    return os.environ.get("NAZRA_DEV_RECORDING", "0") == "1"


def _rec_dir() -> Path:
    d = Path(os.environ.get("NAZRA_REC_DIR") or r"D:\nazra-recordings").resolve()
    if d == REPO_ROOT or REPO_ROOT in d.parents:
        raise HTTPException(500, detail="NAZRA_REC_DIR points inside the repo — refused")
    d.mkdir(parents=True, exist_ok=True)
    return d


def _check_meta(raw: str) -> dict:
    try:
        meta = json.loads(raw)
    except Exception:
        raise HTTPException(400, detail="meta must be a JSON object string")
    if not isinstance(meta, dict):
        raise HTTPException(400, detail="meta must be a JSON object")
    if meta.get("consent") is not True:
        raise HTTPException(400, detail="consent: true is required")

    def num(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v

    if not num(meta.get("ref_hr_bpm")) or not 20 <= meta["ref_hr_bpm"] <= 250:
        raise HTTPException(400, detail="ref_hr_bpm must be a number 20-250")
    if not num(meta.get("seconds")) or not 0 < meta["seconds"] <= 600:
        raise HTTPException(400, detail="seconds must be a number 0-600")
    for k in ("ref_source", "device", "facing"):
        if not isinstance(meta.get(k), str) or not meta[k].strip():
            raise HTTPException(400, detail=f"{k} must be a non-empty string")
    keep = ("ref_hr_bpm", "ref_source", "device", "facing", "seconds", "consent", "note", "fps", "width", "height")
    return {k: (meta[k][:200] if isinstance(meta[k], str) else meta[k]) for k in keep if k in meta}


@app.post("/api/dev/recordings")
def post_recording(video: UploadFile = File(...), meta: str = Form(...)):
    if not _rec_enabled():
        raise HTTPException(404, detail="Not Found")
    m = _check_meta(meta)
    d = _rec_dir()
    ext = Path(video.filename or "").suffix.lower()
    if ext not in REC_EXTS:
        ext = ".mp4" if "mp4" in (video.content_type or "") else ".webm"
    rid = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    limit = int(float(os.environ.get("NAZRA_REC_MAX_MB", "200")) * 1024 * 1024)
    dst, n = d / f"{rid}{ext}", 0
    try:
        with open(dst, "wb") as f:
            while chunk := video.file.read(1 << 20):
                n += len(chunk)
                if n > limit:
                    raise HTTPException(413, detail="recording too large")
                f.write(chunk)
    except HTTPException:
        _rm(str(dst))
        raise
    if n == 0:
        _rm(str(dst))
        raise HTTPException(400, detail="empty video")
    doc = {"id": rid, **m, "file": dst.name, "bytes": n, "content_type": (video.content_type or "")[:60],
           "received_at": datetime.now().astimezone().isoformat(timespec="seconds")}
    (d / f"{rid}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    return doc


@app.get("/api/dev/recordings")
def list_recordings():
    if not _rec_enabled():
        raise HTTPException(404, detail="Not Found")
    d = _rec_dir()
    out = []
    for f in sorted(d.glob("*.json"), reverse=True):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            continue
    return out


# ---------------------------------------------------------------- SPA (registered last)
@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    if full_path.startswith("api/") or full_path == "api":
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    if not (DIST / "index.html").exists():
        return JSONResponse({"detail": "frontend not built (nazra/web/dist missing)"}, status_code=404)
    f = (DIST / full_path).resolve()
    if full_path and f.is_file() and DIST.resolve() in f.parents:
        return FileResponse(str(f))
    return FileResponse(str(DIST / "index.html"))

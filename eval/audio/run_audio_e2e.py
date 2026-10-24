"""Audio end-to-end test: phone-format audio -> /api/transcribe -> /api/checkins -> triage.

SIMULATED: the audio is Microsoft edge-tts Jordanian voices reading fixed test phrases, not patients.

    D:\\nazra-ttsenv\\Scripts\\python.exe -I nazra\\eval\\audio\\run_audio_e2e.py \\
        --asr-url http://127.0.0.1:8788 --api-url http://127.0.0.1:8788 --tmp-dir E:\\nazra-test-tmp --db E:\\nazra-test.db

--asr-url  server used for /api/transcribe (default: the 8788 test instance)
--api-url  server used for /api/patients + /api/checkins (MUST use a test DB; default 8788)
--tmp-dir  directory that server's /api/transcribe writes its nazra_* temp files to (checked before/after)
--db       the api server's SQLite file, used only to delete the test patient + check-ins afterwards
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
SAMPLES = HERE / "samples"
LIVE_DB_HINT = ("server", "data", "nazra.db")
MIME = {"webm": "audio/webm", "m4a": "audio/mp4"}
VITALS = {"hr_bpm": 78, "hr_confidence": 0.9, "rr_bpm": 16, "rr_confidence": 0.8, "hrv_rmssd_ms": 30,
          "hrv_sdnn_ms": 40, "stress_index": 40, "stress_level": "moderate", "quality": "good",
          "scan_seconds": 30, "fps": 30}
LEVELS = {"emergency", "appointment", "followup"}


def temp_files(d: Path) -> set[str]:
    return {p.name for p in d.glob("nazra_*")}


def check_schema(c: dict) -> list[str]:
    errs = []
    for k in ("id", "patient_id", "transcript", "triage", "ai", "symptoms", "red_flags", "vitals"):
        if k not in c:
            errs.append(f"missing {k}")
    t, a = c.get("triage") or {}, c.get("ai") or {}
    if t.get("level") not in LEVELS:
        errs.append(f"bad triage.level {t.get('level')!r}")
    if not isinstance(t.get("reasons_ar"), list) or not t.get("reasons_ar"):
        errs.append("triage.reasons_ar empty")
    for k in ("ok", "model", "summary_ar", "advice_ar", "latency_ms", "error"):
        if k not in a:
            errs.append(f"missing ai.{k}")
    if a.get("ok") is False and a.get("model") != "rules-only":
        errs.append("ai failed but not labelled rules-only")
    return errs


def expectations(kind: str, status: int, text: str, level: str | None) -> list[str]:
    fails = []
    if status >= 500 and status != 504:
        fails.append(f"transcribe HTTP {status} (server error)")
    if kind in ("normal", "emergency"):
        if status != 200 or not text:
            fails.append("expected a non-empty transcript")
    if kind == "silence" and text:
        fails.append("silence produced text (hallucination)")
    if kind == "emergency" and level != "emergency":
        fails.append(f"emergency case triaged {level}")
    if kind == "normal" and level == "emergency":
        fails.append("normal case triaged emergency")
    return fails


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--asr-url", default="http://127.0.0.1:8788")
    ap.add_argument("--api-url", default="http://127.0.0.1:8788")
    ap.add_argument("--tmp-dir", default=tempfile.gettempdir())
    ap.add_argument("--db", default=r"E:\nazra-test.db")
    ap.add_argument("--note", default="")
    a = ap.parse_args()
    if all(x in Path(a.db).parts for x in LIVE_DB_HINT):
        sys.exit("refusing: --db looks like the live DB")
    tmp = Path(a.tmp_dir)
    manifest = json.loads((SAMPLES / "manifest.json").read_text(encoding="utf-8"))
    cli = httpx.Client(timeout=120)
    health = {"asr": cli.get(a.asr_url + "/api/health").json(), "api": cli.get(a.api_url + "/api/health").json()}
    p = cli.post(a.api_url + "/api/patients", json={"name_ar": "اختبار صوت (محاكاة)", "name_en": "Audio E2E (simulated)",
                                                    "age": 45, "sex": "m"}).json()
    pid = p["id"]
    rows = []
    try:
        for f in manifest["files"]:
            path = SAMPLES / f["file"]
            before = temp_files(tmp)
            t0 = time.perf_counter()
            r = cli.post(a.asr_url + "/api/transcribe",
                         files={"audio": (f"rec.{f['format']}", path.read_bytes(), MIME[f["format"]])})
            asr_ms = int((time.perf_counter() - t0) * 1000)
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            text = (body.get("text") or "") if r.status_code == 200 else ""
            leaked = []
            for _ in range(20):  # allow the worker up to 2 s to delete its temp file
                leaked = sorted(temp_files(tmp) - before)
                if not leaked:
                    break
                time.sleep(0.1)
            t1 = time.perf_counter()
            cr = cli.post(a.api_url + "/api/checkins", json={"patient_id": pid, "vitals": VITALS, "transcript": text,
                                                              "transcript_source": "voice" if text else "none"})
            ck_ms = int((time.perf_counter() - t1) * 1000)
            c = cr.json() if cr.status_code == 200 else {}
            level = (c.get("triage") or {}).get("level")
            schema = check_schema(c) if cr.status_code == 200 else [f"checkins HTTP {cr.status_code}"]
            fails = expectations(f["kind"], r.status_code, text, level) + schema + (
                [f"temp file left: {leaked}"] if leaked else [])
            rows.append({"case": f["case"], "kind": f["kind"], "format": f["format"], "voice": f["voice"],
                         "expected_text": f["text"], "audio_s": f["seconds"], "transcribe_status": r.status_code,
                         "transcript": text, "transcribe_detail": None if r.status_code == 200 else body.get("detail"),
                         "server_processing_ms": body.get("processing_ms"), "transcribe_ms": asr_ms,
                         "checkin_status": cr.status_code, "triage": level,
                         "rule_level": (c.get("triage") or {}).get("rule_level"),
                         "ai_level": (c.get("triage") or {}).get("ai_level"),
                         "ai_ok": (c.get("ai") or {}).get("ok"), "ai_model": (c.get("ai") or {}).get("model"),
                         "ai_error": (c.get("ai") or {}).get("error"), "checkin_ms": ck_ms,
                         "temp_deleted": not leaked, "pass": not fails, "failures": fails})
            print(f"{f['case']:16s} {f['format']:4s} asr={r.status_code} {asr_ms:5d}ms  triage={level}  "
                  f"ck={ck_ms}ms  {'PASS' if not fails else 'FAIL ' + '; '.join(fails)}  {text[:50]}", flush=True)
    finally:
        removed = 0
        try:
            con = sqlite3.connect(a.db)
            removed = con.execute("DELETE FROM checkins WHERE patient_id=?", (pid,)).rowcount
            con.execute("DELETE FROM patients WHERE id=?", (pid,))
            con.commit()
            con.close()
        except Exception as e:
            print("cleanup failed:", e)
    out = {"label": "Simulated (TTS voices, not patients)", "ran_at": datetime.now().astimezone().isoformat(timespec="seconds"),
           "asr_url": a.asr_url, "api_url": a.api_url, "tmp_dir": str(tmp), "note": a.note,
           "asr_server": {k: health["asr"].get("whisper", {}).get(k) for k in ("model", "device", "compute_type")},
           "llm_model": health["api"].get("llm", {}).get("model"), "cleanup": {"patient_id": pid, "checkins_deleted": removed},
           "passed": sum(r["pass"] for r in rows), "total": len(rows), "rows": rows}
    (HERE / "results.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    write_readme(out)
    print(f"\n{out['passed']}/{out['total']} passed; cleanup: {removed} check-ins + patient {pid} deleted")
    return 0 if out["passed"] == out["total"] else 1


def write_readme(o: dict):
    L = ["# Audio E2E — **Simulated (TTS voices, not patients)**", "",
         "Synthetic Jordanian-Arabic phrases spoken by Microsoft edge-tts voices `ar-JO-SanaNeural` / `ar-JO-TaimNeural`,",
         "converted with ffmpeg to the two formats phones upload (webm/opus, m4a/aac). No real patient audio.",
         "These numbers describe this pipeline on these synthetic clips only — not accuracy on real patients.", "",
         f"- Ran: {o['ran_at']}  ·  transcribe: `{o['asr_url']}` "
         f"({o['asr_server'].get('model')} on {o['asr_server'].get('device')}/{o['asr_server'].get('compute_type')})"
         f"  ·  check-ins: `{o['api_url']}` (test DB, LLM `{o['llm_model']}`)",
         f"- Result: **{o['passed']}/{o['total']} passed**  ·  temp dir checked: `{o['tmp_dir']}`  ·  "
         f"clean-up: patient `{o['cleanup']['patient_id']}` + {o['cleanup']['checkins_deleted']} check-ins deleted",
         *([f"- Note: {o['note']}"] if o["note"] else []), "",
         "Expected: normal → transcript, not emergency · emergency → transcript, emergency · unclear (+70% rate, 0 dB "
         "white noise) → no crash · silence (3 s) → EMPTY transcript is correct · short (0.4 s) → no crash.", "",
         "| case | fmt | transcript | triage (rule/ai) | AI | transcribe ms | check-in ms | temp deleted | pass |",
         "|---|---|---|---|---|---|---|---|---|"]
    for r in o["rows"]:
        tr = (r["transcript"] or ("(empty)" if r["transcribe_status"] == 200 else f"HTTP {r['transcribe_status']}"))[:60]
        ai = "ok" if r["ai_ok"] else f"rules-only ({r['ai_error']})"
        L.append(f"| {r['case']} | {r['format']} | {tr} | {r['triage']} ({r['rule_level']}/{r['ai_level']}) | {ai} | "
                 f"{r['transcribe_ms']} | {r['checkin_ms']} | {'yes' if r['temp_deleted'] else 'NO'} | "
                 f"{'PASS' if r['pass'] else 'FAIL: ' + '; '.join(r['failures'])} |")
    L += ["", "Regenerate: `make_samples.py` (needs network for edge-tts), then `run_audio_e2e.py` — see the docstrings.",
          "Latency includes HTTP round-trip on localhost; check-in latency includes the Gemma call when a transcript exists."]
    (HERE / "README.md").write_text("\n".join(L) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())

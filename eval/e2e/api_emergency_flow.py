"""API-level check of the main demo path: emergency check-in → alert to nearest partner center → ack → patient sees
confirmation → minimal emergency report → TTS. Uses a patient named «اختبار آلي…» and removes it afterwards.
Run: D:\\videos\\tools\\whisper-venv\\Scripts\\python.exe nazra/eval/e2e/api_emergency_flow.py [base_url]"""
import json
import sqlite3
import sys
import time
from pathlib import Path

import httpx

B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
DB = Path(__file__).resolve().parents[2] / "server" / "data" / "nazra.db"
c = httpx.Client(base_url=B, timeout=90)
out = {}

p = c.post("/api/patients", json={"name_ar": "اختبار آلي طوارئ", "age": 60}).json()
t0 = time.perf_counter()
ck = c.post("/api/checkins", json={
    "patient_id": p["id"], "transcript": "عندي وجع قوي بصدري ومش قادر أتنفس", "transcript_source": "typed",
    "vitals": {"hr_bpm": 104, "hr_confidence": 0.8, "rr_bpm": 24, "rr_confidence": 0.7, "quality": "good",
               "scan_seconds": 30, "fps": 30, "bvp_preview": []}}).json()
out["checkin_s"] = round(time.perf_counter() - t0, 1)
out["level"] = ck["triage"]["level"]
out["rule_level"] = ck["triage"]["rule_level"]
out["red_flags"] = [f["code"] for f in ck["red_flags"]]
out["ai_model"] = ck["ai"]["model"]
aid = ck.get("alert_id")
out["alert_id"] = aid
if aid:
    a = c.get(f"/api/alerts/{aid}").json()
    out["alert_status_before"] = a["status"]
    out["alert_center"] = a["current_center_id"]
    a2 = c.post(f"/api/alerts/{aid}/ack", json={"center_id": a["current_center_id"]}).json()
    out["alert_status_after_ack"] = a2["status"]
    out["ack_center"] = (a2.get("ack") or {}).get("center_id")
r = c.get(f"/api/checkins/{ck['id']}/report")
out["report_http"] = r.status_code
if r.status_code == 200:
    rep = r.json()
    out["report_keys"] = sorted(rep)[:20]
t = c.post("/api/tts", json={"text": "توجّه للطوارئ الآن أو اتصل على 911"})
out["tts_http"], out["tts_bytes"] = t.status_code, len(t.content)

# cleanup: only rows created by this script
con = sqlite3.connect(DB)
pid = p["id"]
for table, col in (("checkins", "patient_id"), ("alerts", "patient_id")):
    try:
        con.execute(f"DELETE FROM {table} WHERE {col}=?", (pid,))
    except sqlite3.OperationalError:
        pass
con.execute("DELETE FROM patients WHERE id=?", (pid,))
con.commit()
out["cleaned_patient"] = pid
print(json.dumps(out, ensure_ascii=False, indent=1))

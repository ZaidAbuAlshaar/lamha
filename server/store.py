"""SQLite storage (JSON documents) + deterministic simulated seed data."""
from __future__ import annotations

import json
import math
import os
import random
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import core
import pipeline

DB_PATH = Path(os.environ.get("NAZRA_DB", Path(__file__).parent / "data" / "nazra.db"))
_lock = threading.RLock()
_con: sqlite3.Connection | None = None


def con() -> sqlite3.Connection:
    global _con
    if _con is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _con = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _con.execute("CREATE TABLE IF NOT EXISTS patients (id TEXT PRIMARY KEY, created_at TEXT, doc TEXT)")
        _con.execute("CREATE TABLE IF NOT EXISTS checkins (id TEXT PRIMARY KEY, patient_id TEXT, ts REAL, doc TEXT)")
        _con.execute("CREATE INDEX IF NOT EXISTS ix_ck_p ON checkins(patient_id, ts)")
        _con.execute("CREATE TABLE IF NOT EXISTS diagnostics (id TEXT PRIMARY KEY, ts REAL, checkin_id TEXT, doc TEXT)")
        _con.commit()
    return _con


def _ts(iso: str) -> float:
    return core.parse_ts(iso).timestamp()


def put_patient(p: dict):
    with _lock:
        con().execute("INSERT OR REPLACE INTO patients VALUES (?,?,?)",
                      (p["id"], p["created_at"], json.dumps(p, ensure_ascii=False)))
        con().commit()


def get_patient(pid: str) -> dict | None:
    with _lock:
        r = con().execute("SELECT doc FROM patients WHERE id=?", (pid,)).fetchone()
    return json.loads(r[0]) if r else None


def list_patients() -> list[dict]:
    with _lock:
        rows = con().execute("SELECT doc FROM patients").fetchall()
    return [json.loads(r[0]) for r in rows]


def put_checkin(c: dict):
    with _lock:
        con().execute("INSERT OR REPLACE INTO checkins VALUES (?,?,?,?)",
                      (c["id"], c["patient_id"], _ts(c["created_at"]), json.dumps(c, ensure_ascii=False)))
        con().commit()


def get_checkin(cid: str) -> dict | None:
    with _lock:
        r = con().execute("SELECT doc FROM checkins WHERE id=?", (cid,)).fetchone()
    return json.loads(r[0]) if r else None


def patient_checkins(pid: str, newest_first=True) -> list[dict]:
    with _lock:
        rows = con().execute(f"SELECT doc FROM checkins WHERE patient_id=? ORDER BY ts {'DESC' if newest_first else 'ASC'}",
                             (pid,)).fetchall()
    return [json.loads(r[0]) for r in rows]


def recent_checkins(since_ts: float | None, limit: int) -> list[dict]:
    with _lock:
        if since_ts is None:
            rows = con().execute("SELECT doc FROM checkins ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
        else:
            rows = con().execute("SELECT doc FROM checkins WHERE ts > ? ORDER BY ts DESC LIMIT ?",
                                 (since_ts, limit)).fetchall()
    return [json.loads(r[0]) for r in rows]


def put_diagnostics(d: dict):
    with _lock:
        con().execute("INSERT OR REPLACE INTO diagnostics VALUES (?,?,?,?)",
                      (d["id"], d["ts"], d.get("checkin_id"), json.dumps(d, ensure_ascii=False)))
        con().commit()


def link_diagnostics(diag_id: str, checkin_id: str):
    with _lock:
        r = con().execute("SELECT doc FROM diagnostics WHERE id=?", (diag_id,)).fetchone()
        if not r:
            return
        d = json.loads(r[0])
        d["checkin_id"] = checkin_id
        con().execute("UPDATE diagnostics SET checkin_id=?, doc=? WHERE id=?", (checkin_id, json.dumps(d, ensure_ascii=False), diag_id))
        con().commit()


def latest_diagnostics(n: int) -> list[dict]:
    with _lock:
        rows = con().execute("SELECT doc FROM diagnostics ORDER BY ts DESC LIMIT ?", (n,)).fetchall()
    return [json.loads(r[0]) for r in rows]


def counts() -> dict:
    with _lock:
        c = con()
        c.execute("SELECT 1").fetchone()
        return {t: c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("patients", "checkins", "diagnostics")}


def delete_patient(pid: str) -> int:
    """Remove a patient and its check-ins/diagnostics links (used by test clean-up). Returns check-ins removed."""
    with _lock:
        c = con()
        n = c.execute("DELETE FROM checkins WHERE patient_id=?", (pid,)).rowcount
        c.execute("DELETE FROM patients WHERE id=?", (pid,))
        c.commit()
    return n


def all_checkins() -> list[dict]:
    with _lock:
        rows = con().execute("SELECT doc FROM checkins ORDER BY ts ASC").fetchall()
    return [json.loads(r[0]) for r in rows]


def new_patient(name_ar, name_en=None, age=None, sex=None, location_ar=None, simulated=False, pid=None,
                location_en=None, conditions_ar=None, conditions_en=None, created_at=None) -> dict:
    return {"id": pid or "v-" + uuid.uuid4().hex[:8], "name_ar": name_ar, "name_en": name_en or "",
            "age": age, "sex": sex if sex in ("m", "f") else None, "location_ar": location_ar or "",
            "location_en": location_en or "", "conditions_ar": conditions_ar or [], "conditions_en": conditions_en or [],
            "simulated": simulated,
            "created_at": created_at or datetime.now(core.AMMAN).isoformat(timespec="seconds")}


# ---------------------------------------------------------------- seed (ALL rows simulated=true)
SEED_PATIENTS = [
    dict(pid="p1", name_ar="الحاجة فاطمة العلي", name_en="Hajja Fatima Al-Ali", age=71, sex="f",
         location_ar="دير علا", location_en="Deir Alla", conditions_ar=["سكري", "ضغط"],
         conditions_en=["Diabetes", "Hypertension"]),
    dict(pid="p2", name_ar="أبو خالد الزعبي", name_en="Abu Khaled Al-Zoubi", age=64, sex="m",
         location_ar="المفرق", location_en="Mafraq", conditions_ar=["قصور قلب"], conditions_en=["Heart failure"]),
    dict(pid="p3", name_ar="سلمى حسن", name_en="Salma Hasan", age=29, sex="f", location_ar="مخيم الزعتري",
         location_en="Zaatari camp", conditions_ar=["حامل الشهر السابع"], conditions_en=["Pregnant, 7th month"]),
    dict(pid="p4", name_ar="محمود العمري", name_en="Mahmoud Al-Omari", age=45, sex="m", location_ar="عجلون",
         location_en="Ajloun", conditions_ar=["ربو"], conditions_en=["Asthma"]),
    dict(pid="p5", name_ar="الحاج يوسف الخطيب", name_en="Hajj Yousef Al-Khatib", age=79, sex="m",
         location_ar="الطفيلة", location_en="Tafileh", conditions_ar=["ضغط"], conditions_en=["Hypertension"]),
    dict(pid="p6", name_ar="ليان عبدالله", name_en="Layan Abdullah", age=34, sex="f", location_ar="الأزرق",
         location_en="Azraq", conditions_ar=["قلق", "أرق"], conditions_en=["Anxiety", "Insomnia"]),
]

FINE = ["الحمد لله منيح اليوم", "تمام الحمد لله", "ماشي الحال، ما في إشي جديد", "منيح، نمت منيح مبارح"]
FINE_F = ["الحمد لله منيحة اليوم", "تمام الحمد لله", "ماشي الحال، ما في إشي جديد", "منيحة، نمت منيح مبارح"]


def _sym(key, ar, en, span, severity=None, duration=None):
    return {"key": key, "label_ar": ar, "label_en": en, "span": span, "severity": severity, "duration": duration}


def _day_plan(pid: str, day: int, rnd: random.Random):
    """day = days ago (13..0). Returns (hr, rr, stress, transcript, seed_symptoms)."""
    j = rnd.gauss
    if pid == "p1":
        if day >= 2:
            return 78 + j(0, 2.0), 16 + j(0, 0.7), 38 + j(0, 4), rnd.choice(FINE_F), []
        hr = 95.5 if day == 1 else 97.0
        t = "نفسي ضيق من مبارح وتعبانة"
        return hr + j(0, 0.3), 19 + j(0, 0.5), 55 + j(0, 3), t, [_sym("fatigue", "تعب", "Fatigue", "تعبانة")]
    if pid == "p2":
        rr = 17 + (13 - day) * (8.0 / 13) + j(0, 0.4)
        if day <= 3:
            return 86 + j(0, 2), rr, 45 + j(0, 4), "رجليّ منفخات وما بقدر أنام عالمخدة الوحدة", [
                _sym("swelling_legs", "تورم القدمين", "Leg swelling", "رجليّ منفخات")]
        return 84 + j(0, 2), rr, 42 + j(0, 4), rnd.choice(FINE), []
    if pid == "p3":
        if day % 4 == 0:
            return 88 + j(0, 2), 17 + j(0, 0.7), 35 + j(0, 4), "الحمد لله تمام، شوية تعب عادي", [
                _sym("fatigue", "تعب", "Fatigue", "شوية تعب", "mild")]
        return 88 + j(0, 2), 17 + j(0, 0.7), 35 + j(0, 4), rnd.choice(FINE_F), []
    if pid == "p4":
        if day <= 1:
            st = 66.0 if day == 1 else 70.0
            return 86 + j(0, 1.5), 19 + j(0, 0.5), st + j(0, 1), "عندي كحة من يومين وما بنام منيح من الكحة", [
                _sym("cough", "كحة", "Cough", "عندي كحة من يومين", None, "يومين")]
        return 82 + j(0, 2), 17 + j(0, 0.7), 35 + j(0, 4), rnd.choice(FINE), []
    if pid == "p5":
        return 72 + j(0, 2), 15 + j(0, 0.6), 30 + j(0, 4), rnd.choice(FINE), []
    if pid == "p6":
        if day % 2 == 0:
            return 80 + j(0, 2), 16 + j(0, 0.6), 72 + j(0, 3), "مش قادرة أنام منيح وقلقانة طول الوقت", [
                _sym("insomnia", "أرق", "Insomnia", "مش قادرة أنام منيح"),
                _sym("anxiety", "قلق", "Anxiety", "قلقانة طول الوقت")]
        return 80 + j(0, 2), 16 + j(0, 0.6), 72 + j(0, 3), "الحمد لله، بس متوترة شوي", [
            _sym("anxiety", "توتر", "Stress", "متوترة شوي", "mild")]
    raise ValueError(pid)


def _stress_level(s):
    return "low" if s <= 40 else ("moderate" if s <= 65 else "high")


def _bvp(hr, rnd, n=120, fps=30.0):
    f = hr / 60.0
    return [round(math.sin(2 * math.pi * f * i / fps) + 0.15 * rnd.gauss(0, 1), 3) for i in range(n)]


def seed_if_empty() -> bool:
    with _lock:
        n = con().execute("SELECT COUNT(*) FROM patients").fetchone()[0]
    if n:
        return False
    rnd = random.Random(7)
    random.seed(7)
    today = datetime.now(core.AMMAN).replace(hour=9, minute=0, second=0, microsecond=0)
    for spec in SEED_PATIENTS:
        p = new_patient(simulated=True, created_at=(today - timedelta(days=14)).isoformat(timespec="seconds"),
                        **spec)
        put_patient(p)
        prev: list[dict] = []
        for day in range(13, -1, -1):
            hr, rr, st, transcript, syms = _day_plan(p["id"], day, rnd)
            ts = today - timedelta(days=day) + timedelta(minutes=rnd.randint(0, 150))
            st = max(5.0, min(95.0, st))
            vit = {"hr_bpm": round(hr, 1), "hr_confidence": round(rnd.uniform(0.78, 0.95), 2),
                   "rr_bpm": round(rr, 1), "rr_confidence": round(rnd.uniform(0.6, 0.85), 2),
                   "hrv_rmssd_ms": round(max(8.0, 60 - st * 0.5 + rnd.gauss(0, 3)), 1),
                   "hrv_sdnn_ms": round(max(10.0, 70 - st * 0.5 + rnd.gauss(0, 3)), 1),
                   "stress_index": round(st, 1), "stress_level": _stress_level(st), "quality": "good",
                   "scan_seconds": 30.0, "fps": 30.0, "ref_hr_bpm": None, "bvp_preview": _bvp(hr, rnd)}
            c = pipeline.analyze(p, vit, transcript, "voice", prev, llm_fn=None, now=ts, simulated=True,
                                 seed_symptoms=syms)
            put_checkin(c)
            prev.append(c)
    return True

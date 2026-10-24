"""Critical alerts to partner health centers (demo centers, fake contacts).

Deterministic only: an alert is created when the rules-driven triage level is `emergency` and the patient has not
refused emergency sharing. No model is involved. Escalation: no ack within the timeout -> next nearest center,
at most 3 centers, then status "failed". Video never leaves the phone; an alert carries numbers + reasons only.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from datetime import datetime

import centers
import core
import store

MAX_CENTERS = 3
DEDUP_S = 30 * 60
clock = time.time  # injectable for tests
TICKER_ENABLED = True  # tests set False and call tick() by hand

_tick_lock = threading.RLock()
_ticker: threading.Thread | None = None
_ready_con = None
# center_id -> {sub_id: (loop, queue)}; filled by alerts_api websocket handlers
subscribers: dict[str, dict[str, tuple]] = {}
_sub_lock = threading.Lock()


def enabled() -> bool:
    return os.environ.get("NAZRA_ALERTS", "1") != "0"


def timeout_s() -> float:
    v = os.environ.get("NAZRA_ALERT_TIMEOUT_S")
    if v:
        return float(v)
    return 30.0 if os.environ.get("NAZRA_DEMO") == "1" else 180.0


def _db():
    global _ready_con
    c = store.con()
    if c is not _ready_con:
        c.execute("CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, patient_id TEXT, ts REAL, status TEXT, "
                  "current_center_id TEXT, doc TEXT)")
        c.execute("CREATE INDEX IF NOT EXISTS ix_al_p ON alerts(patient_id, ts)")
        c.commit()
        _ready_con = c
    return c


def _put(a: dict):
    with store._lock:
        c = _db()
        c.execute("INSERT OR REPLACE INTO alerts VALUES (?,?,?,?,?,?)",
                  (a["id"], a["patient_id"], a["created_ts"], a["status"], a["current_center_id"],
                   json.dumps(a, ensure_ascii=False)))
        c.commit()


def get(aid: str) -> dict | None:
    with store._lock:
        r = _db().execute("SELECT doc FROM alerts WHERE id=?", (aid,)).fetchone()
    return json.loads(r[0]) if r else None


def _rows(sql: str, args=()) -> list[dict]:
    with store._lock:
        return [json.loads(r[0]) for r in _db().execute(sql, args).fetchall()]


def all_alerts(limit: int = 300) -> list[dict]:
    return _rows("SELECT doc FROM alerts ORDER BY ts DESC LIMIT ?", (limit,))


def open_alerts() -> list[dict]:
    return _rows("SELECT doc FROM alerts WHERE status='pending' ORDER BY ts ASC")


def for_center(center_id: str, recent_s: float = 24 * 3600) -> list[dict]:
    """Alerts this center was sent: still open ones first, then the recent handled/failed ones."""
    lo = clock() - recent_s
    out = [a for a in all_alerts() if any(t["center_id"] == center_id for t in a["centers_tried"])
           and (a["status"] == "pending" or a["created_ts"] >= lo)]
    return sorted(out, key=lambda a: (a["status"] != "pending", -a["created_ts"]))


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, core.AMMAN).isoformat(timespec="seconds")


def _coords(p: dict) -> tuple[float | None, float | None, str]:
    if p.get("lat") is not None and p.get("lon") is not None:
        return float(p["lat"]), float(p["lon"]), "patient"
    if p.get("simulated"):
        from demo import centers as demo_centers
        ll = demo_centers.TOWN_COORDS.get(p.get("id"))
        if ll:
            return ll[0], ll[1], "demo_town"
    return None, None, "default_amman"


def _shares(p: dict) -> bool:
    consent = p.get("consent") or {}
    return consent.get("share_emergency") is not False  # missing -> True (demo default)


def _codes(c: dict) -> list[str]:
    return sorted({r.get("code") for r in (c.get("red_flags") or []) if r.get("code")})


def _center_name(cid: str | None) -> str | None:
    for c in centers.all_centers():
        if c["id"] == cid:
            return c["name_ar"]
    return None


def view(a: dict | None) -> dict | None:
    """Alert + a few derived fields for the UI (step, center name, seconds left before escalation)."""
    if not a:
        return None
    out = dict(a)
    out["step"] = len(a["centers_tried"])
    out["max_steps"] = min(MAX_CENTERS, len(a["order"]))
    out["current_center_name_ar"] = _center_name(a["current_center_id"])
    out["ack_center_name_ar"] = _center_name((a.get("ack") or {}).get("center_id"))
    out["timeout_s"] = timeout_s()
    if a["status"] == "pending":
        last = a["centers_tried"][-1]["sent_ts"]
        out["escalates_in_s"] = max(0, round(last + timeout_s() - clock()))
    else:
        out["escalates_in_s"] = None
    return out


# ---------------------------------------------------------------- push to center consoles
def subscribe(center_id: str, loop, queue) -> str:
    sid = uuid.uuid4().hex[:8]
    with _sub_lock:
        subscribers.setdefault(center_id, {})[sid] = (loop, queue)
    return sid


def unsubscribe(center_id: str, sid: str):
    with _sub_lock:
        subscribers.get(center_id, {}).pop(sid, None)


def publish(center_id: str, msg: dict):
    with _sub_lock:
        subs = list(subscribers.get(center_id, {}).values())
    for loop, q in subs:
        try:
            loop.call_soon_threadsafe(q.put_nowait, msg)
        except RuntimeError:  # loop closed: the socket is going away
            pass


def _notify(a: dict, new_center: str | None = None):
    v = view(a)
    for t in a["centers_tried"]:
        publish(t["center_id"], {"type": "alert" if t["center_id"] == new_center else "update", "alert": v})


# ---------------------------------------------------------------- lifecycle
def on_checkin(c: dict, p: dict) -> str | None:
    """Called after a check-in is stored. Returns the alert id (new or deduplicated), else None. Never raises."""
    try:
        if not enabled() or c.get("triage", {}).get("level") != "emergency" or not _shares(p):
            return None
        return _create(c, p)
    except Exception:
        return None


def _create(c: dict, p: dict) -> str:
    now = clock()
    codes = _codes(c)
    with _tick_lock:
        recent = _rows("SELECT doc FROM alerts WHERE patient_id=? AND ts>=? AND status!='failed' ORDER BY ts DESC LIMIT 1",
                       (p["id"], now - DEDUP_S))  # a failed alert never swallows a new emergency
        if recent and set(codes) <= set(recent[0].get("red_flag_codes") or []):
            a = recent[0]
            a.setdefault("checkin_ids", [a["checkin_id"]]).append(c["id"])
            _put(a)
            return a["id"]
        lat, lon, src = _coords(p)
        order = [{"center_id": x["id"], "name_ar": x["name_ar"], "distance_km": x["distance_km"]}
                 for x in centers.by_distance(lat, lon)][:MAX_CENTERS]
        here = (lat, lon) if lat is not None else centers.AMMAN
        v = c.get("vitals") or {}
        a = {"id": "a-" + uuid.uuid4().hex[:10], "patient_id": p["id"], "patient_name_ar": p.get("name_ar"),
             "age": p.get("age"), "checkin_id": c["id"], "checkin_ids": [c["id"]], "created_at": _iso(now),
             "created_ts": now, "level": "emergency", "reasons_ar": list(c["triage"].get("reasons_ar") or []),
             "red_flag_codes": codes,
             "vitals": {"hr": v.get("hr_bpm"), "rr": v.get("rr_bpm"), "quality": v.get("quality")},
             "area_ar": p.get("location_ar") or "عمّان (موقع افتراضي)",
             "approx_location": {"lat": round(here[0], 2), "lon": round(here[1], 2)}, "location_source": src,
             "order": order, "centers_tried": [{"center_id": order[0]["center_id"], "sent_at": _iso(now), "sent_ts": now}],
             "current_center_id": order[0]["center_id"], "status": "pending", "ack": None,
             "simulated_centers": True}
        _put(a)
    _notify(a, new_center=a["current_center_id"])
    ensure_ticker()
    return a["id"]


def ack(aid: str, center_id: str) -> tuple[dict | None, str | None]:
    """Returns (alert, error). Any center the alert was sent to may ack while it is pending (or late, after fail)."""
    with _tick_lock:
        a = get(aid)
        if not a:
            return None, "not_found"
        if not any(t["center_id"] == center_id for t in a["centers_tried"]):
            return a, "not_sent_to_this_center"
        if a["status"] == "acked":
            return a, None if a["ack"]["center_id"] == center_id else "already_acked"
        a["status"] = "acked"
        a["ack"] = {"center_id": center_id, "at": _iso(clock())}
        a["current_center_id"] = center_id
        _put(a)
    _notify(a)
    return a, None


def tick(now: float | None = None) -> list[str]:
    """Escalate every pending alert whose current center did not ack in time. Returns ids that changed."""
    now = clock() if now is None else now
    changed = []
    with _tick_lock:
        for a in open_alerts():
            last = a["centers_tried"][-1]["sent_ts"]
            if now - last < timeout_s():
                continue
            new_center = None
            if len(a["centers_tried"]) < min(MAX_CENTERS, len(a["order"])):
                nxt = a["order"][len(a["centers_tried"])]
                a["centers_tried"].append({"center_id": nxt["center_id"], "sent_at": _iso(now), "sent_ts": now})
                a["current_center_id"] = new_center = nxt["center_id"]
            else:
                a["status"] = "failed"
                a["failed_at"] = _iso(now)
            _put(a)
            changed.append(a["id"])
            _notify(a, new_center=new_center)
    return changed


def _loop():
    while True:
        time.sleep(1.0)
        try:
            tick()
        except Exception:
            pass


def ensure_ticker():
    global _ticker
    if not TICKER_ENABLED or (_ticker and _ticker.is_alive()):
        return
    _ticker = threading.Thread(target=_loop, name="nazra-alert-escalation", daemon=True)
    _ticker.start()


def health() -> dict:
    try:
        n_open = len(open_alerts())
        with _sub_lock:
            ws = {cid: len(s) for cid, s in subscribers.items() if s}
        return {"status": "ok" if enabled() else "degraded", "loaded": True, "warm": bool(_ticker and _ticker.is_alive()),
                "last_latency_ms": None,
                "detail": {"enabled": enabled(), "timeout_s": timeout_s(), "open_alerts": n_open, "ws_clients": ws}}
    except Exception as e:
        return {"status": "down", "loaded": False, "warm": False, "last_latency_ms": None,
                "detail": f"{type(e).__name__}: {e}"[:200]}

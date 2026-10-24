"""Partner-center alerts: creation, ack, escalation across 3 centers, dedup, nearest order, websocket push."""
import os
import sys
from pathlib import Path

os.environ["NAZRA_NO_MODELS"] = "1"  # never load Whisper/Gemma from tests
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

import alerts  # noqa: E402
import centers  # noqa: E402
import store  # noqa: E402

DEIR_ALLA = (32.20, 35.62)


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t


@pytest.fixture()
def env(tmp_path, monkeypatch):
    old_path, old_con = store.DB_PATH, store._con
    store._con = None
    store.DB_PATH = tmp_path / "alerts.db"  # never the live DB
    clk = Clock()
    monkeypatch.setattr(alerts, "clock", clk)
    monkeypatch.setattr(alerts, "TICKER_ENABLED", False)
    monkeypatch.setenv("NAZRA_ALERT_TIMEOUT_S", "180")
    monkeypatch.delenv("NAZRA_ALERTS", raising=False)
    alerts.subscribers.clear()
    yield clk
    if store._con is not None:
        store._con.close()
    store._con, store.DB_PATH = old_con, old_path


def patient(pid="p1", **kw):
    p = {"id": pid, "name_ar": "الحاجة فاطمة العلي", "age": 71, "location_ar": "دير علا", "simulated": True,
         "lat": DEIR_ALLA[0], "lon": DEIR_ALLA[1]}
    p.update(kw)
    return p


_n = [0]


def checkin(pid="p1", level="emergency", codes=("chest_pain",)):
    _n[0] += 1
    return {"id": f"c{_n[0]}", "patient_id": pid, "vitals": {"hr_bpm": 128.4, "rr_bpm": 26.0, "quality": "good"},
            "red_flags": [{"code": k, "label_ar": k, "evidence": k} for k in codes],
            "triage": {"level": level, "reasons_ar": ["ألم صدر (علامة خطر)"]}}


def test_nearest_center_order():
    order = [c["id"] for c in centers.by_distance(*DEIR_ALLA)]
    assert len(order) == 3
    d = [c["distance_km"] for c in centers.by_distance(*DEIR_ALLA)]
    assert d == sorted(d)
    assert order[0] == "c-sweileh"  # Sweileh is the north-west Amman center, nearest to Deir Alla
    assert [c["id"] for c in centers.by_distance(None, None)][0] == "c-shmeisani"  # no coords -> Amman


def test_emergency_creates_alert_for_nearest(env):
    aid = alerts.on_checkin(checkin(), patient())
    a = alerts.get(aid)
    assert a["status"] == "pending" and a["current_center_id"] == centers.nearest(*DEIR_ALLA)["id"]
    assert a["vitals"] == {"hr": 128.4, "rr": 26.0, "quality": "good"}
    assert a["approx_location"] == {"lat": 32.2, "lon": 35.62}
    assert [t["center_id"] for t in a["centers_tried"]] == [a["current_center_id"]]
    assert a["ack"] is None and a["patient_name_ar"] and a["age"] == 71 and a["reasons_ar"]


def test_no_alert_when_not_emergency_or_refused_or_flag_off(env, monkeypatch):
    assert alerts.on_checkin(checkin(level="appointment"), patient()) is None
    assert alerts.on_checkin(checkin(), patient(consent={"share_emergency": False})) is None
    monkeypatch.setenv("NAZRA_ALERTS", "0")
    assert alerts.on_checkin(checkin(), patient()) is None


def test_ack_stops_escalation(env):
    aid = alerts.on_checkin(checkin(), patient())
    first = alerts.get(aid)["current_center_id"]
    a, err = alerts.ack(aid, first)
    assert err is None and a["status"] == "acked" and a["ack"]["center_id"] == first
    env.t += 10_000
    assert alerts.tick() == []
    a = alerts.get(aid)
    assert a["status"] == "acked" and len(a["centers_tried"]) == 1


def test_ack_from_unrelated_center_refused(env):
    aid = alerts.on_checkin(checkin(), patient())
    order = [o["center_id"] for o in alerts.get(aid)["order"]]
    _, err = alerts.ack(aid, order[2])
    assert err == "not_sent_to_this_center" and alerts.get(aid)["status"] == "pending"


def test_no_ack_escalates_three_centers_then_fails(env):
    aid = alerts.on_checkin(checkin(), patient())
    order = [o["center_id"] for o in alerts.get(aid)["order"]]
    env.t += 179
    assert alerts.tick() == []  # not yet
    env.t += 2
    assert alerts.tick() == [aid]
    a = alerts.get(aid)
    assert a["current_center_id"] == order[1] and len(a["centers_tried"]) == 2 and a["status"] == "pending"
    env.t += 181
    alerts.tick()
    a = alerts.get(aid)
    assert a["current_center_id"] == order[2] and [t["center_id"] for t in a["centers_tried"]] == order
    env.t += 181
    alerts.tick()
    a = alerts.get(aid)
    assert a["status"] == "failed" and len(a["centers_tried"]) == 3
    # a late ack from a center it was sent to still counts (the patient gets help)
    a, err = alerts.ack(aid, order[0])
    assert err is None and a["status"] == "acked"


def test_demo_timeout(env, monkeypatch):
    monkeypatch.delenv("NAZRA_ALERT_TIMEOUT_S")
    monkeypatch.setenv("NAZRA_DEMO", "1")
    assert alerts.timeout_s() == 30
    monkeypatch.delenv("NAZRA_DEMO")
    assert alerts.timeout_s() == 180


def test_dedup_and_new_red_flag_bypass(env):
    a1 = alerts.on_checkin(checkin(codes=("chest_pain",)), patient())
    env.t += 60
    assert alerts.on_checkin(checkin(codes=("chest_pain",)), patient()) == a1  # same flag -> same alert
    assert alerts.on_checkin(checkin(codes=()), patient()) == a1  # no new flag -> same alert
    assert len(alerts.get(a1)["checkin_ids"]) == 3
    a2 = alerts.on_checkin(checkin(codes=("chest_pain", "stroke")), patient())  # new red flag -> new alert
    assert a2 and a2 != a1
    env.t += 31 * 60
    a3 = alerts.on_checkin(checkin(codes=("chest_pain",)), patient())  # window passed -> new alert
    assert a3 not in (a1, a2)
    other = alerts.on_checkin(checkin(pid="p2", codes=("chest_pain",)), patient("p2"))
    assert other not in (a1, a2, a3)


def test_visitor_without_coords_goes_to_amman(env):
    aid = alerts.on_checkin(checkin(pid="v-x"), {"id": "v-x", "name_ar": "زائر", "age": None, "simulated": False})
    a = alerts.get(aid)
    assert a["location_source"] == "default_amman" and a["current_center_id"] == "c-shmeisani"


def test_rest_endpoints_and_consent(env):
    from fastapi.testclient import TestClient
    import app as app_mod
    client = TestClient(app_mod.app)  # no `with` -> lifespan (model loading) never runs
    store.put_patient({"id": "p9", "name_ar": "تجربة", "created_at": "2026-10-24T12:00:00+03:00", "simulated": True})
    assert len(client.get("/api/centers").json()) == 3
    r = client.post("/api/patients/p9/consent", json={"share_emergency": False, "notify_family": True})
    assert r.status_code == 200 and r.json() == {"share_emergency": False, "notify_family": True, "receive_report": False}
    assert store.get_patient("p9")["consent"]["share_emergency"] is False
    aid = alerts.on_checkin(checkin(), patient())
    cid = alerts.get(aid)["current_center_id"]
    lst = client.get(f"/api/alerts?center_id={cid}").json()
    assert [x["id"] for x in lst] == [aid] and lst[0]["step"] == 1 and lst[0]["max_steps"] == 3
    assert client.get("/api/alerts?center_id=nope").json() == []
    assert client.get(f"/api/alerts/{aid}").json()["status"] == "pending"
    assert client.get("/api/alerts/a-missing").status_code == 404
    r = client.post(f"/api/alerts/{aid}/ack", json={"center_id": cid})
    assert r.status_code == 200 and r.json()["status"] == "acked" and r.json()["ack_center_name_ar"]
    h = alerts.health()
    assert h["status"] == "ok" and h["detail"]["open_alerts"] == 0


def test_websocket_receives_alert_and_acks(env):
    from fastapi.testclient import TestClient
    import app as app_mod
    client = TestClient(app_mod.app)  # no `with` -> no model-loading lifespan
    cid = centers.nearest(*DEIR_ALLA)["id"]
    with client.websocket_connect(f"/ws/center/{cid}") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["alerts"] == []
        assert alerts.health()["detail"]["ws_clients"] == {cid: 1}
        aid = alerts.on_checkin(checkin(), patient())
        msg = ws.receive_json()
        assert msg["type"] == "alert" and msg["alert"]["id"] == aid and msg["alert"]["patient_name_ar"]
        ws.send_json({"type": "ack", "alert_id": aid})
        upd = ws.receive_json()
        assert upd["type"] == "update" and upd["alert"]["status"] == "acked"
    assert alerts.get(aid)["ack"]["center_id"] == cid


def test_checkin_endpoint_hooks_alert(env, monkeypatch):
    from fastapi.testclient import TestClient
    import app as app_mod
    import llm
    monkeypatch.setattr(llm, "extract", lambda *a, **k: {"ok": False, "error": "unreachable", "latency_ms": 1})
    client = TestClient(app_mod.app)
    store.put_patient(patient("p1", created_at="2026-10-24T12:00:00+03:00"))
    vit = {"hr_bpm": 80, "hr_confidence": 0.9, "rr_bpm": 16, "rr_confidence": 0.8, "quality": "good",
           "scan_seconds": 30, "fps": 30}
    r = client.post("/api/checkins", json={"patient_id": "p1", "vitals": vit, "transcript": "عندي ألم بصدري قوي",
                                           "transcript_source": "typed"})
    assert r.status_code == 200, r.text
    c = r.json()
    assert c["triage"]["level"] == "emergency", c["triage"]
    assert c["alert_id"] and alerts.get(c["alert_id"])["checkin_id"] == c["id"]
    assert store.get_checkin(c["id"])["alert_id"] == c["alert_id"]
    r2 = client.post("/api/checkins", json={"patient_id": "p1", "vitals": vit, "transcript": "الحمد لله منيح",
                                            "transcript_source": "typed"})
    assert r2.json()["triage"]["level"] != "emergency" and not r2.json().get("alert_id")

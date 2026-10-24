"""REST + WebSocket routes for partner-center alerts and patient consent (v2 center workstream)."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Body, HTTPException, WebSocket, WebSocketDisconnect

import alerts
import centers
import store

router = APIRouter()


@router.get("/api/centers")
def list_centers():
    return centers.all_centers()


@router.get("/api/alerts")
def list_alerts(center_id: str | None = None):
    alerts.ensure_ticker()
    rows = alerts.for_center(center_id) if center_id else alerts.all_alerts(50)
    return [alerts.view(a) for a in rows]


@router.get("/api/alerts/{aid}")
def get_alert(aid: str):
    alerts.ensure_ticker()
    a = alerts.get(aid)
    if not a:
        raise HTTPException(404, detail="alert not found")
    return alerts.view(a)


@router.post("/api/alerts/{aid}/ack")
def ack_alert(aid: str, body: dict = Body(...)):
    a, err = alerts.ack(aid, str(body.get("center_id") or ""))
    if err == "not_found":
        raise HTTPException(404, detail="alert not found")
    if err:
        raise HTTPException(409, detail=err)
    return alerts.view(a)


@router.post("/api/patients/{pid}/consent")
def set_consent(pid: str, body: dict = Body(...)):
    p = store.get_patient(pid)
    if not p:
        raise HTTPException(404, detail="patient not found")
    p["consent"] = {k: bool(body.get(k, d)) for k, d in
                    (("share_emergency", True), ("notify_family", False), ("receive_report", False))}
    store.put_patient(p)
    return p["consent"]


@router.websocket("/ws/center/{center_id}")
async def center_ws(ws: WebSocket, center_id: str):
    await ws.accept()
    alerts.ensure_ticker()
    q: asyncio.Queue = asyncio.Queue()
    sid = alerts.subscribe(center_id, asyncio.get_running_loop(), q)
    try:
        await ws.send_json({"type": "hello", "center_id": center_id,
                            "alerts": [alerts.view(a) for a in alerts.for_center(center_id)]})

        async def pump():
            while True:
                await ws.send_json(await q.get())

        async def recv():
            while True:
                msg = await ws.receive_json()
                if isinstance(msg, dict) and msg.get("type") == "ack" and msg.get("alert_id"):
                    a, err = await asyncio.to_thread(alerts.ack, str(msg["alert_id"]), center_id)
                    if err:
                        await ws.send_json({"type": "error", "alert_id": msg["alert_id"], "detail": err})
                elif isinstance(msg, dict) and msg.get("type") == "ping":
                    await ws.send_json({"type": "pong"})

        tasks = [asyncio.create_task(pump()), asyncio.create_task(recv())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:
            exc = t.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                raise exc
    except WebSocketDisconnect:
        pass
    finally:
        alerts.unsubscribe(center_id, sid)

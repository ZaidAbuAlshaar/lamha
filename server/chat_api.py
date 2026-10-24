"""Route: patient chatbot «اسأل لمحة» (NAZRA_CHAT, default on; 0 = 404)."""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

import chat
import store

router = APIRouter()


@router.post("/api/chat")
def chat_route(body: dict = Body(...)):
    if not chat.enabled():
        raise HTTPException(404, detail="chat disabled")
    msgs = (body or {}).get("messages")
    if not isinstance(msgs, list) or not chat.clean_history(msgs):
        raise HTTPException(422, detail="messages is required")
    cid = (body or {}).get("checkin_id")
    c = None
    if cid:
        c = store.get_checkin(str(cid))
        if not c:
            raise HTTPException(404, detail="checkin not found")
    return chat.answer(msgs, c)


@router.get("/api/chat/health")
def chat_health():
    return chat.health()

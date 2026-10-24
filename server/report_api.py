"""Routes: patient report (NAZRA_REPORT) and Piper TTS (NAZRA_TTS). Both default ON; set to 0 to 404."""
from __future__ import annotations

import os

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse

import report
import store
import tts

router = APIRouter()


def _on(flag: str) -> bool:
    return os.environ.get(flag, "1") != "0"


@router.get("/api/checkins/{cid}/report")
def checkin_report(cid: str):
    if not _on("NAZRA_REPORT"):
        raise HTTPException(404, detail="report disabled")
    c = store.get_checkin(cid)
    if not c:
        raise HTTPException(404, detail="checkin not found")
    p = store.get_patient(c["patient_id"])
    prev = [x for x in store.patient_checkins(c["patient_id"], newest_first=False)
            if x["id"] != cid and x["created_at"] < c["created_at"]]
    return report.build_report(c, p, prev)


@router.post("/api/tts")
def tts_route(body: dict = Body(...)):
    if not _on("NAZRA_TTS"):
        raise HTTPException(404, detail="tts disabled")
    text = str((body or {}).get("text") or "").strip()
    if not text:
        raise HTTPException(422, detail="text is required")
    try:
        path = tts.synthesize(text)
    except tts.TTSUnavailable as e:
        raise HTTPException(503, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(502, detail=str(e)[:300])
    return FileResponse(str(path), media_type="audio/mpeg" if str(path).endswith(".mp3") else "audio/wav", headers={"Cache-Control": "private, max-age=3600"})


@router.get("/api/tts/health")
def tts_health():
    return tts.health()

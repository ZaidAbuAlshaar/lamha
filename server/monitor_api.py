"""GET /api/patients/{id}/forecast — monitoring + forecast card for the doctor (and a calm patient sentence)."""
from __future__ import annotations

import os
import threading

from fastapi import APIRouter, HTTPException

import core
import forecast
import monitor
import store

router = APIRouter()

# Warm the Chronos worker in the background so the first doctor view is not slow (never in tests / NO_MODELS).
if os.environ.get("NAZRA_NO_MODELS") != "1" and forecast.chronos_enabled():
    threading.Thread(target=forecast.warm, name="chronos-warm", daemon=True).start()


def _points(checkins: list[dict]) -> list[dict]:
    out = []
    for c in checkins:
        v = c.get("vitals") or {}
        hr = monitor._f(v.get("hr_bpm"))
        if hr is None or not c.get("created_at"):
            continue
        out.append({"date": monitor._day(c).isoformat(), "created_at": c["created_at"], "hr": round(hr, 1),
                    "quality": v.get("quality"), "excluded": bool(v.get("excluded_from_baseline")),
                    "good": monitor.is_good(v), "simulated": bool(c.get("simulated")),
                    "symptoms": [s.get("label_ar") for s in (c.get("symptoms") or [])
                                 if s.get("verified", True) and s.get("label_ar")]})
    return out


def build(patient: dict, checkins: list[dict], chat=None, use_chronos: bool = True) -> dict:
    cks = sorted([c for c in checkins if c.get("created_at")], key=lambda c: core.parse_ts(c["created_at"]))
    mon = monitor.evaluate(cks)
    mon["points"] = _points(cks)
    lin = forecast.linear(mon["days"])
    chr_ = None
    if lin is not None and use_chronos:
        chr_ = forecast.chronos_predict([d["hr"] for d in mon["days"]], horizon=2)
    agr = forecast.agreement(lin, chr_)
    shown = forecast.apply_agreement(lin, agr)
    facts = forecast.note_facts(mon, shown, agr)
    last_id = cks[-1].get("id") if cks else ""
    note = forecast.doctor_note(facts, cache_key=f"{patient['id']}:{last_id}", chat=chat)
    return {
        "patient_id": patient["id"],
        "simulated": bool(patient.get("simulated")),
        "demo_label_ar": "بيانات تجريبية" if patient.get("simulated") else None,
        "baseline": mon["baseline"],
        "baseline_reason_ar": mon["baseline_reason_ar"],
        "latest": mon["latest"],
        "cusum": mon["cusum"],
        "forecast": shown,
        "forecast_reason_ar": None if shown else forecast.NO_FORECAST_AR,
        "agreement": agr,
        "points": mon["points"],
        "note": {"text_ar": note["text_ar"], "source": note["source"], "numbers_verified": note["numbers_verified"]},
        "patient_sentence_ar": monitor.patient_sentence(mon),
        "flags": mon["flags"],
        "disclaimer_ar": monitor.DISCLAIMER_AR,
    }


@router.get("/api/patients/{pid}/forecast")
def patient_forecast(pid: str):
    if not monitor.enabled():
        raise HTTPException(404, "monitor disabled")
    p = store.get_patient(pid)
    if not p:
        raise HTTPException(404, "patient not found")
    return build(p, store.patient_checkins(pid, newest_first=False))

"""Insights routes: community early-warning, «شو تغيّر من آخر زيارة», voice markers vs own baseline.
Every number in the text is inserted by code from stored data (template, no model)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

import community
import core
import store
import voice_markers

router = APIRouter()

LEVEL_AR = {"emergency": "طارئ", "appointment": "موعد", "followup": "متابعة"}
LABEL = "مؤشر للمتابعة، مش تشخيص"


@router.get("/api/community")
def get_community():
    if not community.enabled():
        raise HTTPException(404, detail="community disabled (NAZRA_COMMUNITY=0)")
    return community.community()


def _level(c: dict) -> str:
    r = c.get("review") or {}
    return r.get("final_level") if r.get("final_level") in LEVEL_AR else c["triage"]["level"]


def _fmt(x: float) -> str:
    return str(int(round(x)))


def _vital_part(name: str, metric: str, cur: dict, prev: dict) -> tuple[str | None, dict]:
    a, b = cur.get(f"{metric}_bpm"), prev.get(f"{metric}_bpm")
    ok_a, ok_b = core.vitals_usable(cur, metric), core.vitals_usable(prev, metric)
    data = {"current": round(float(a), 1) if a is not None else None,
            "previous": round(float(b), 1) if b is not None else None, "comparable": ok_a and ok_b}
    if ok_a and ok_b:
        d = round(float(a)) - round(float(b))
        data["delta"] = d
        trend = "نفسه" if d == 0 else (f"+{d}" if d > 0 else f"{d}")
        return f"{name} {_fmt(a)} مقابل {_fmt(b)} ({trend})", data
    if a is None and b is None:
        return None, data
    return f"{name}: قراءة ضعيفة أو ناقصة — ما بنقارن", data


def changes(checkins_asc: list[dict]) -> dict:
    if len(checkins_asc) < 2:
        return {"available": False, "lines_ar": ["هاي أول زيارة — ما في زيارة سابقة للمقارنة"], "label_ar": LABEL}
    prev, cur = checkins_asc[-2], checkins_asc[-1]
    tc, tp = core.parse_ts(cur["created_at"]), core.parse_ts(prev["created_at"])
    days = round((tc - tp).total_seconds() / 86400, 1)
    hr_s, hr_d = _vital_part("النبض", "hr", cur.get("vitals") or {}, prev.get("vitals") or {})
    rr_s, rr_d = _vital_part("التنفس", "rr", cur.get("vitals") or {}, prev.get("vitals") or {})
    gap = "اليوم نفسه" if days < 1 else f"قبل {_fmt(days)} يوم"
    l1 = f"مقارنة مع الزيارة السابقة ({gap}): " + (" · ".join(x for x in (hr_s, rr_s) if x) or "ما في قراءات حيوية")

    def keys(c):
        return {s["key"]: s.get("label_ar") or s["key"] for s in c.get("symptoms") or [] if s.get("verified", True)}

    kc, kp = keys(cur), keys(prev)
    new = [kc[k] for k in kc if k not in kp]
    gone = [kp[k] for k in kp if k not in kc]
    parts = []
    if new:
        parts.append("أعراض جديدة: " + "، ".join(new))
    if gone:
        parts.append("اختفت: " + "، ".join(gone))
    if not parts:
        parts.append("نفس الأعراض" if kc else "ما في أعراض بالزيارتين")
    lc, lp = _level(cur), _level(prev)
    parts.append(f"الفرز: {LEVEL_AR[lp]} ← {LEVEL_AR[lc]}" if lc != lp else f"الفرز نفسه: {LEVEL_AR[lc]}")
    return {"available": True, "lines_ar": [l1, " · ".join(parts)], "label_ar": LABEL,
            "latest_id": cur["id"], "previous_id": prev["id"], "days_between": days,
            "data": {"hr": hr_d, "rr": rr_d, "symptoms_new": new, "symptoms_gone": gone,
                     "level": {"previous": lp, "current": lc}}}


@router.get("/api/patients/{pid}/changes")
def get_changes(pid: str):
    if not store.get_patient(pid):
        raise HTTPException(404, detail="patient not found")
    return changes(store.patient_checkins(pid, newest_first=False))


@router.get("/api/patients/{pid}/voice")
def get_voice(pid: str):
    if not voice_markers.enabled():
        return {"enabled": False, "available": False, "reason_ar": "مؤشرات الصوت مطفأة", "label_ar": LABEL}
    if not store.get_patient(pid):
        raise HTTPException(404, detail="patient not found")
    return {"enabled": True, **voice_markers.compare(store.patient_checkins(pid, newest_first=False))}

"""Voice breathlessness markers from Whisper word timestamps (insights). Pure functions, no model.

- pauses: gaps between consecutive words >= PAUSE_MS (count, mean ms)
- breath groups: runs of words between pauses -> mean words per breath group
- speech rate: words per second of speech (first word start -> last word end)
- quality: "ok" only with >= MIN_WORDS words over >= MIN_SPEECH_S seconds

Shown to the doctor only relative to the patient's OWN baseline (>= 3 earlier ok-quality voice check-ins).
Indicator for follow-up, not a diagnosis.
"""
from __future__ import annotations

import os

PAUSE_MS = 300
MIN_WORDS = 8
MIN_SPEECH_S = 3.0
MIN_PRIOR = 3
LABEL = "مؤشر للمتابعة، مش تشخيص"
NO_BASE_AR = "لسا ما في أساس كافٍ للمقارنة"
METRICS = ("pause_count", "pause_mean_ms", "words_per_breath_group", "speech_rate_wps")


def enabled() -> bool:
    return os.environ.get("NAZRA_VOICE_MARKERS", "1") != "0"


def compute(words: list[dict], pause_ms: int = PAUSE_MS) -> dict:
    ws = sorted((w for w in words or [] if w.get("start") is not None and w.get("end") is not None
                 and str(w.get("w", "")).strip()), key=lambda w: float(w["start"]))
    n = len(ws)
    if n == 0:
        return {"n_words": 0, "speech_s": 0.0, "pause_count": 0, "pause_mean_ms": None,
                "words_per_breath_group": None, "speech_rate_wps": None, "quality": "insufficient",
                "quality_ok": False, "pause_threshold_ms": pause_ms}
    speech_s = max(0.0, float(ws[-1]["end"]) - float(ws[0]["start"]))
    pauses, groups, cur = [], [], 1
    for a, b in zip(ws, ws[1:]):
        gap_ms = (float(b["start"]) - float(a["end"])) * 1000.0
        if gap_ms >= pause_ms:
            pauses.append(gap_ms)
            groups.append(cur)
            cur = 1
        else:
            cur += 1
    groups.append(cur)
    ok = n >= MIN_WORDS and speech_s >= MIN_SPEECH_S
    return {"n_words": n, "speech_s": round(speech_s, 2), "pause_count": len(pauses),
            "pause_mean_ms": round(sum(pauses) / len(pauses)) if pauses else 0,
            "words_per_breath_group": round(sum(groups) / len(groups), 2),
            "speech_rate_wps": round(n / speech_s, 2) if speech_s > 0 else None,
            "quality": "ok" if ok else "insufficient", "quality_ok": ok, "pause_threshold_ms": pause_ms}


def _markers(c: dict) -> dict | None:
    m = (c.get("vitals") or {}).get("voice_markers") or c.get("voice_markers")
    return m if isinstance(m, dict) else None


def compare(checkins_asc: list[dict]) -> dict:
    """Latest voice check-in vs the mean of the earlier ok-quality ones. Needs >= MIN_PRIOR earlier ones."""
    with_m = [(c, _markers(c)) for c in checkins_asc if _markers(c)]
    if not with_m:
        return {"available": False, "reason_ar": NO_BASE_AR, "n_prior": 0, "current": None, "label_ar": LABEL}
    cur_c, cur = with_m[-1]
    prior = [m for _, m in with_m[:-1] if m.get("quality_ok")]
    out = {"checkin_id": cur_c.get("id"), "created_at": cur_c.get("created_at"), "current": cur,
           "n_prior": len(prior), "label_ar": LABEL, "simulated": bool(cur_c.get("simulated"))}
    if len(prior) < MIN_PRIOR:
        return {**out, "available": False, "reason_ar": NO_BASE_AR}
    base, delta = {}, {}
    for k in METRICS:
        vals = [float(m[k]) for m in prior if m.get(k) is not None]
        if len(vals) < MIN_PRIOR:
            continue
        base[k] = round(sum(vals) / len(vals), 2)
        if cur.get(k) is not None and base[k]:
            delta[k] = round((float(cur[k]) - base[k]) / base[k] * 100, 1)
    return {**out, "available": True, "baseline": base, "delta_pct": delta,
            "quality_ok": bool(cur.get("quality_ok"))}


def health() -> dict:
    return {"status": "ok" if enabled() else "down", "loaded": True, "warm": True, "last_latency_ms": None,
            "detail": "pure timing maths on Whisper word timestamps" if enabled() else "NAZRA_VOICE_MARKERS=0"}

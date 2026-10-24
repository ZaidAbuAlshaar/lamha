"""Arabic text-to-speech for «اسمع التقرير» with Piper (local, open-source) and the Jordanian voice ar_JO-kareem-medium.

Piper runs in its own venv (D:\\nazra-piper-venv) as a subprocess, so it never touches the server's Python env.
WAVs are cached by a hash of (voice, text) in NAZRA_TTS_CACHE. Text is fed on stdin as UTF-8
(PYTHONUTF8=1 is required: without it Windows decodes stdin with the ANSI code page and Piper reads garbage).
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import threading
import time
from pathlib import Path

PIPER_EXE = Path(os.environ.get("NAZRA_PIPER_EXE", r"D:\nazra-piper-venv\Scripts\piper.exe"))
VOICE = Path(os.environ.get("NAZRA_PIPER_VOICE", r"D:\models\piper\ar_JO-kareem-medium.onnx"))
CACHE_DIR = Path(os.environ.get("NAZRA_TTS_CACHE", r"D:\nazra-tts-cache"))
TIMEOUT_S = float(os.environ.get("NAZRA_TTS_TIMEOUT_S", "60"))
MAX_CHARS = 1500
# Natural Jordanian neural voice (Microsoft edge-tts, online) first; Piper ar_JO-kareem (open, offline) as fallback.
# NAZRA_TTS_ENGINE=piper keeps everything offline. Only the text to be read is sent, never patient audio/video.
ENGINE = os.environ.get("NAZRA_TTS_ENGINE", "edge")
EDGE_EXE = Path(os.environ.get("NAZRA_EDGE_TTS_EXE", "D:/nazra-ttsenv/Scripts/edge-tts.exe"))
EDGE_VOICE = os.environ.get("NAZRA_EDGE_VOICE", "ar-JO-TaimNeural")
EDGE_RATE = os.environ.get("NAZRA_EDGE_RATE", "-6%")
WARM_TEXT = "أهلاً، هذا تقرير لمحة."

state = {"warm": False, "last_latency_ms": None, "error": None, "cache_hits": 0, "synth_count": 0}
_lock = threading.Lock()


class TTSUnavailable(RuntimeError):
    pass


def enabled() -> bool:
    return os.environ.get("NAZRA_TTS", "1") != "0"


def available() -> bool:
    return PIPER_EXE.exists() and VOICE.exists() and Path(str(VOICE) + ".json").exists()


def _key(text: str) -> str:
    return hashlib.sha256(f"{VOICE.name}\n{text}".encode("utf-8")).hexdigest()[:32]


def _edge(text: str) -> Path | None:
    """Jordanian neural voice via edge-tts; None if unavailable/offline (caller falls back to Piper)."""
    if ENGINE != "edge" or not EDGE_EXE.exists():
        return None
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out = CACHE_DIR / (hashlib.sha256(f"{EDGE_VOICE}|{EDGE_RATE}|{text}".encode("utf-8")).hexdigest()[:32] + ".mp3")
    if out.exists() and out.stat().st_size > 500:
        state["cache_hits"] += 1
        return out
    tmp = out.with_suffix(".tmp.mp3")
    t0 = time.perf_counter()
    try:
        r = subprocess.run([str(EDGE_EXE), "--voice", EDGE_VOICE, f"--rate={EDGE_RATE}", "--text", text, "--write-media", str(tmp)],
                           capture_output=True, timeout=25, env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception as e:  # noqa: BLE001  (offline, timeout...) -> Piper
        state["edge_error"] = f"{type(e).__name__}"[:120]
        tmp.unlink(missing_ok=True)
        return None
    if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size <= 500:
        state["edge_error"] = (r.stderr or b"").decode("utf-8", "replace")[-160:] or f"exit {r.returncode}"
        tmp.unlink(missing_ok=True)
        return None
    os.replace(tmp, out)
    state.update(last_latency_ms=int((time.perf_counter() - t0) * 1000), error=None, warm=True, edge_error=None)
    state["synth_count"] += 1
    return out


def synthesize(text: str) -> Path:
    """Return the path of an audio file (MP3 from the neural voice, or WAV from Piper) for `text` (cached)."""
    text = " ".join((text or "").split())[:MAX_CHARS]
    if not text:
        raise ValueError("empty text")
    edge = _edge(text)
    if edge is not None:
        return edge
    if not available():
        raise TTSUnavailable(f"piper or voice missing: {PIPER_EXE} / {VOICE}")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out = CACHE_DIR / f"{_key(text)}.wav"
    if out.exists() and out.stat().st_size > 44:
        state["cache_hits"] += 1
        return out
    with _lock:
        if out.exists() and out.stat().st_size > 44:
            state["cache_hits"] += 1
            return out
        tmp = out.with_suffix(".tmp.wav")
        env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        t0 = time.perf_counter()
        try:
            r = subprocess.run([str(PIPER_EXE), "-m", str(VOICE), "-f", str(tmp)], input=text.encode("utf-8"),
                               capture_output=True, timeout=TIMEOUT_S, env=env,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired:
            state["error"] = "timeout"
            tmp.unlink(missing_ok=True)
            raise RuntimeError("piper timeout")
        ms = int((time.perf_counter() - t0) * 1000)
        if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size <= 44:
            state["error"] = (r.stderr or b"").decode("utf-8", "replace")[-300:] or f"exit {r.returncode}"
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"piper failed: {state['error']}")
        os.replace(tmp, out)
        state.update(last_latency_ms=ms, error=None, warm=True)
        state["synth_count"] += 1
        return out


def warm() -> dict:
    """Synthesize one short phrase so the voice model is in the OS file cache. Never raises."""
    try:
        synthesize(WARM_TEXT)
        state["warm"] = True
    except Exception as e:  # noqa: BLE001
        state["error"] = f"{type(e).__name__}: {e}"[:300]
    return health()


def health() -> dict:
    ok = available()
    if not enabled():
        status, detail = "down", "NAZRA_TTS=0"
    elif not ok:
        status, detail = "down", f"piper or voice missing ({PIPER_EXE.name}, {VOICE.name})"
    elif state["error"]:
        status, detail = "degraded", state["error"]
    else:
        base = f"edge-tts {EDGE_VOICE} (online), fallback piper {VOICE.stem}" if ENGINE == "edge" and EDGE_EXE.exists() else f"piper {VOICE.stem}"
        status, detail = "ok", base + (f" | edge error: {state.get('edge_error')}" if state.get("edge_error") else "")
    return {"status": status, "loaded": ok, "warm": bool(state["warm"]), "device": "CPU",
            "last_latency_ms": state["last_latency_ms"], "detail": detail}

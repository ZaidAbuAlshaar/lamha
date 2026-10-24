"""Generate SIMULATED Jordanian-Arabic test audio (Microsoft edge-tts voices, synthetic phrases, no personal data).

Run with the tools venv (NOT the server venv):
    D:\nazra-ttsenv\Scripts\python.exe nazra\eval\audio\make_samples.py
Writes samples/<case>.webm (opus) and samples/<case>.m4a (aac) + samples/manifest.json.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE / "samples"
WORK = OUT / "_wav"
FFMPEG = shutil.which("ffmpeg") or os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe")
SR = 16000

NORMAL = "عندي كحة خفيفة من يومين وشوية سخونة"
EMERGENCY = "عندي وجع قوي بصدري ومش قادر أتنفس"
VOICES = {"sana": "ar-JO-SanaNeural", "taim": "ar-JO-TaimNeural"}


def ff(*args):
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def read_wav(p: Path) -> np.ndarray:
    with wave.open(str(p)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def write_wav(p: Path, x: np.ndarray):
    x = np.clip(x, -1, 1)
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype(np.int16).tobytes())


async def tts(text: str, voice: str, rate: str, mp3: Path):
    import edge_tts
    await edge_tts.Communicate(text, voice, rate=rate).save(str(mp3))


def to_wav16(src: Path, dst: Path):
    ff("-i", str(src), "-ac", "1", "-ar", str(SR), "-sample_fmt", "s16", str(dst))


def main():
    OUT.mkdir(exist_ok=True)
    WORK.mkdir(exist_ok=True)
    manifest, errors = [], []
    rng = np.random.default_rng(7)
    speech = {}
    for vname, voice in VOICES.items():
        for case, text, rate in (("normal", NORMAL, "+0%"), ("emergency", EMERGENCY, "+0%"),
                                 ("unclear", NORMAL, "+70%")):
            mp3 = WORK / f"{case}_{vname}.mp3"
            try:
                asyncio.run(tts(text, voice, rate, mp3))
            except Exception as e:  # network / service failure: record it, never fake audio
                errors.append(f"edge-tts {voice} {case}: {type(e).__name__}: {e}"[:300])
                continue
            wav = WORK / f"{case}_{vname}.wav"
            to_wav16(mp3, wav)
            x = read_wav(wav)
            speech[(case, vname)] = x
            meta = {"case": f"{case}_{vname}", "kind": case, "voice": voice, "text": text, "rate": rate}
            if case == "unclear":
                # low-SNR mix: white noise at 0 dB SNR relative to the speech RMS
                rms = float(np.sqrt(np.mean(x ** 2)) or 1e-4)
                x = x + rng.standard_normal(len(x)).astype(np.float32) * rms
                x = x / max(1.0, float(np.max(np.abs(x))))
                write_wav(wav, x)
                meta["snr_db"] = 0
            meta["seconds"] = round(len(x) / SR, 2)
            manifest.append((meta, wav))
    # silence: 3 s of digital zero
    sil = WORK / "silence.wav"
    write_wav(sil, np.zeros(3 * SR, dtype=np.float32))
    manifest.append(({"case": "silence", "kind": "silence", "voice": None, "text": "", "seconds": 3.0}, sil))
    # very short: first 0.4 s of speech after onset (needs a TTS sample)
    src = speech.get(("normal", "sana")) if ("normal", "sana") in speech else next(iter(speech.values()), None)
    if src is not None:
        on = int(np.argmax(np.abs(src) > 0.02))
        short = src[on:on + int(0.4 * SR)]
        sp = WORK / "short.wav"
        write_wav(sp, short)
        manifest.append(({"case": "short", "kind": "short", "voice": VOICES["sana"], "text": "(first 0.4 s of normal phrase)",
                          "seconds": round(len(short) / SR, 2)}, sp))
    else:
        errors.append("short case skipped: no TTS speech available")
    out = []
    for meta, wav in manifest:
        for fmt, args in (("webm", ["-c:a", "libopus", "-b:a", "32k", "-ar", "48000"]),
                          ("m4a", ["-c:a", "aac", "-b:a", "64k", "-ar", "44100"])):
            dst = OUT / f"{meta['case']}.{fmt}"
            ff("-i", str(wav), "-ac", "1", *args, str(dst))
            out.append({**meta, "format": fmt, "file": dst.name, "bytes": dst.stat().st_size})
    (OUT / "manifest.json").write_text(json.dumps({"label": "Simulated (TTS voices, not patients)",
                                                   "files": out, "errors": errors}, ensure_ascii=False, indent=2),
                                       encoding="utf-8")
    shutil.rmtree(WORK, ignore_errors=True)
    print(json.dumps({"files": len(out), "errors": errors}, ensure_ascii=False))
    return 0 if out else 1


if __name__ == "__main__":
    sys.exit(main())

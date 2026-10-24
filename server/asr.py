"""faster-whisper large-v3 (local, offline). Audio is transcribed then deleted by the caller."""
from __future__ import annotations

import glob
import os
import threading
import time

os.environ.setdefault("HF_HOME", r"D:\models\hf")
os.environ.setdefault("HF_HUB_OFFLINE", "1")


def _cuda_dll_dirs():
    """ctranslate2 loads cuBLAS/cuDNN lazily at the first GPU decode; put the pip-installed NVIDIA DLLs on the search path."""
    import site
    roots = site.getsitepackages() + [site.getusersitepackages()]
    for root in roots:
        for sub in ("cublas", "cudnn", "cuda_nvrtc"):
            d = os.path.join(root, "nvidia", sub, "bin")
            if os.path.isdir(d):
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                if hasattr(os, "add_dll_directory"):
                    os.add_dll_directory(d)


_cuda_dll_dirs()

MODEL_NAME = "faster-whisper-large-v3"
# Neutral vocabulary only: Whisper can echo its prompt on silent/noisy audio, so no red-flag phrases here.
INITIAL_PROMPT = "كحة، سخونة، دوخة، تعبان، راسي، بطني، رجلي، السكري، الضغط، من مبارح، من أسبوع"

state = {"ready": False, "model": MODEL_NAME, "device": None, "compute_type": None, "error": None}
_model = None
_lock = threading.Lock()


def _snapshot() -> str:
    hub = os.path.join(os.environ["HF_HOME"], "hub", "models--Systran--faster-whisper-large-v3", "snapshots")
    snaps = sorted(glob.glob(os.path.join(hub, "*")))
    return snaps[-1] if snaps else "large-v3"


def load():
    global _model
    from faster_whisper import WhisperModel
    path = _snapshot()
    errors = []
    for device, ct in (("cuda", "int8_float16"), ("cpu", "int8")):
        try:
            m = WhisperModel(path, device=device, compute_type=ct, local_files_only=True)
            # Warm-up decode: a GPU library problem (e.g. missing cuBLAS) only shows up here, not at load.
            import numpy as np
            noise = (np.random.default_rng(0).standard_normal(16000) * 0.01).astype("float32")
            list(m.transcribe(noise, language="ar", vad_filter=False, beam_size=1)[0])
            _model = m
            state.update(ready=True, device=device, compute_type=ct,
                         error=("; ".join(errors) + " -> fell back to CPU") if errors else None)
            return
        except Exception as e:
            errors.append(f"{device}/{ct}: {type(e).__name__}: {e}"[:300])
    state.update(ready=False, error="; ".join(errors))


def transcribe(path: str) -> dict:
    if not state["ready"] or _model is None:
        raise RuntimeError("whisper not ready")
    t0 = time.perf_counter()
    with _lock:
        segs, info = _model.transcribe(path, language="ar", vad_filter=True, beam_size=5,
                                       initial_prompt=INITIAL_PROMPT, condition_on_previous_text=False)
        text = " ".join(s.text.strip() for s in segs).strip()
    import re
    key = lambda x: re.sub(r"[\W_]+", "", x)
    if text and key(text) in key(INITIAL_PROMPT):
        text = ""  # Whisper echoed its prompt on silence; that is not the patient speaking
    return {"text": text, "duration_s": round(float(info.duration), 2), "language": info.language,
            "processing_ms": int((time.perf_counter() - t0) * 1000), "model": MODEL_NAME}

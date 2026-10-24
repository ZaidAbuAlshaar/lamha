#!/usr/bin/env python
"""
make_video.py - synthesise a face video with a KNOWN pulse and breathing rate.

SYNTHETIC BENCH INPUT. The video is built from one still portrait plus an
injected pulse and a rigid vertical breathing shift. It validates a signal
pipeline (camera -> face ROI -> rPPG/RR estimator). It says nothing about
clinical accuracy on real people.

Model (all numbers are CLI-overridable, defaults below):
  * Pulse: skin pixels only (YCrCb skin mask AND a face/neck ellipse), additive
    modulation with peak-to-peak levels R=0.6 G=1.4 B=0.8 (8-bit levels).
    Waveform = fundamental + 2nd harmonic at 0.3 relative amplitude.
    Instantaneous HR drifts +-2 bpm (two slow sinusoids), so HRV is non-zero.
  * Breathing: whole image shifted vertically by a sinusoid at rpm/60 Hz,
    amplitude 2.5 px, sub-pixel (bilinear warpAffine) + head jitter sigma 0.3 px.
  * Sensor noise: Gaussian sigma 1.0 level per pixel per channel, added in float
    BEFORE a single rounding to 8 bit (so sub-level modulation is dithered, as
    on a real sensor).
  * Output: raw YUV4MPEG2 4:2:0, BT.601 limited range (what Chrome's libyuv path
    assumes), plus a JSON sidecar with the ground truth.
"""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
PORTRAIT = HERE / "assets" / "portrait.jpg"

# Geometry of the face + neck in SOURCE portrait pixels (portrait is 820x1024).
# The ellipse limits the skin mask to face/neck so the curtain behind (which
# passes a naive Cr/Cb skin test) does not pulse.
FACE_CX_SRC = 402.0
# Face ellipse + a small neck ellipse (shirt/tie/jacket fail the colour test anyway).
FACE_ELLIPSES_SRC = [
    (402.0, 190.0, 118.0, 150.0),  # cx, cy, semi-axis x, semi-axis y  (forehead..chin)
    (400.0, 335.0, 55.0, 40.0),    # neck
]
CROP_TOP_SRC = -30.0  # negative = pad above the portrait (replicate) to push the face down


def parse_size(s):
    w, h = s.lower().split("x")
    return int(w), int(h)


def build_base(size, scale):
    """Portrait -> WxH BGR frame, face centred horizontally. Returns (frame, ellipse_in_frame)."""
    W, H = size
    img = cv2.imdecode(np.fromfile(str(PORTRAIT), dtype=np.uint8), cv2.IMREAD_COLOR)  # imread cannot open non-ASCII paths on Windows
    if img is None:
        sys.exit(f"cannot read portrait: {PORTRAIT}")
    x0 = FACE_CX_SRC - (W / scale) / 2.0
    y0 = CROP_TOP_SRC
    M = np.array([[scale, 0, -x0 * scale], [0, scale, -y0 * scale]], dtype=np.float64)
    base = cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    ell = [((cx - x0) * scale, (cy - y0) * scale, ax * scale, ay * scale) for cx, cy, ax, ay in FACE_ELLIPSES_SRC]
    return base, ell


def skin_mask(base_bgr, ell):
    """Soft skin mask in [0,1], float32, same HxW as the frame."""
    ycc = cv2.cvtColor(base_bgr, cv2.COLOR_BGR2YCrCb)
    Y, Cr, Cb = cv2.split(ycc)
    m = (
        (Cr >= 135) & (Cr <= 180) & (Cb >= 85) & (Cb <= 135) & (Y >= 50) & (Y <= 245)
    ).astype(np.uint8) * 255
    reg = np.zeros_like(m)
    for (ecx, ecy, eax, eay) in ell:
        cv2.ellipse(reg, (int(round(ecx)), int(round(ecy))), (int(round(eax)), int(round(eay))), 0, 0, 360, 255, -1)
    m = cv2.bitwise_and(m, reg)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    mf = cv2.GaussianBlur(m.astype(np.float32) / 255.0, (0, 0), 3.0)
    return np.clip(mf, 0.0, 1.0)


def _raw_pulse(phase):
    return np.sin(phase) + 0.3 * np.sin(2.0 * phase)


_ph = np.linspace(0, 2 * np.pi, 4096, endpoint=False)
_pr = _raw_pulse(_ph)
_PULSE_PP = float(_pr.max() - _pr.min())


def pulse_wave(phase):
    """Zero-mean periodic wave, peak-to-peak exactly 1.0."""
    return _raw_pulse(phase) / _PULSE_PP


def rgb_to_i420_planes(rgb_f):
    """rgb_f: float32 HxWx3 in RGB order, 0..255. BT.601 limited-range 4:2:0, rounded once."""
    R, G, B = rgb_f[..., 0], rgb_f[..., 1], rgb_f[..., 2]
    Y = 16.0 + (65.481 * R + 128.553 * G + 24.966 * B) / 255.0
    U = 128.0 + (-37.797 * R - 74.203 * G + 112.0 * B) / 255.0
    V = 128.0 + (112.0 * R - 93.786 * G - 18.214 * B) / 255.0
    h, w = Y.shape
    U2 = U.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))
    V2 = V.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))
    y8 = np.clip(np.rint(Y), 16, 235).astype(np.uint8)
    u8 = np.clip(np.rint(U2), 16, 240).astype(np.uint8)
    v8 = np.clip(np.rint(V2), 16, 240).astype(np.uint8)
    return y8, u8, v8


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bpm", type=float, default=72.0)
    ap.add_argument("--rpm", type=float, default=15.0)
    ap.add_argument("--seconds", type=float, default=45.0)
    ap.add_argument("--out", type=str, default=r"E:\nazra-e2e\face_72bpm_15rpm.y4m")
    ap.add_argument("--size", type=str, default="640x480")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--seed", type=int, default=1)
    # optional knobs
    ap.add_argument("--scale", type=float, default=0.9, help="portrait scale into the frame (face ~65%% of frame height)")
    ap.add_argument("--amp-r", type=float, default=0.6, help="pulse peak-to-peak, 8-bit levels, R")
    ap.add_argument("--amp-g", type=float, default=1.4)
    ap.add_argument("--amp-b", type=float, default=0.8)
    ap.add_argument("--drift-bpm", type=float, default=2.0, help="max slow HR drift (+-bpm)")
    ap.add_argument("--resp-amp-px", type=float, default=2.5, help="vertical breathing shift amplitude (px)")
    ap.add_argument("--jitter-px", type=float, default=0.3, help="random head jitter sigma (px)")
    ap.add_argument("--noise-sigma", type=float, default=1.0, help="sensor noise sigma (8-bit levels)")
    ap.add_argument("--resp-baseline", type=float, default=0.0,
                    help="OPTIONAL respiratory-induced skin intensity variation, peak-to-peak levels (G-weighted like the pulse). Default 0 = off")
    ap.add_argument("--flicker-pct", type=float, default=0.0, help="OPTIONAL global illumination flicker, percent gain amplitude (0 = off)")
    ap.add_argument("--flicker-hz", type=float, default=0.4)
    ap.add_argument("--y4m-tag", type=str, default="C420", help="chroma tag in the y4m header (C420 or C420jpeg)")
    args = ap.parse_args()

    W, H = parse_size(args.size)
    assert W % 2 == 0 and H % 2 == 0
    fps = args.fps
    N = int(round(args.seconds * fps))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    rng = np.random.default_rng(args.seed)
    # --- ground-truth signal definitions (drawn first so they depend only on the seed) ---
    drift_a, drift_b = rng.uniform(0, 2 * np.pi, 2)
    pulse_phase0 = rng.uniform(0, 2 * np.pi)
    resp_phase0 = rng.uniform(0, 2 * np.pi)
    flick_phase0 = rng.uniform(0, 2 * np.pi)

    t = np.arange(N) / fps
    drift_bpm = args.drift_bpm * (0.6 * np.sin(2 * np.pi * 0.045 * t + drift_a) + 0.4 * np.sin(2 * np.pi * 0.085 * t + drift_b))
    inst_bpm = args.bpm + drift_bpm
    phase = pulse_phase0 + 2 * np.pi * np.cumsum(inst_bpm / 60.0) / fps
    pulse = pulse_wave(phase)  # p-p = 1
    resp_hz = args.rpm / 60.0
    resp_sin = np.sin(2 * np.pi * resp_hz * t + resp_phase0)
    jit = rng.normal(0.0, args.jitter_px, size=(N, 2))  # (x, y)

    base, ell = build_base((W, H), args.scale)
    mask = skin_mask(base, ell)
    base_f = base.astype(np.float32)
    mask3 = mask[..., None]
    # BGR order for the per-channel pulse amplitudes
    amps_bgr = np.array([args.amp_b, args.amp_g, args.amp_r], dtype=np.float32)
    resp_bgr = amps_bgr / amps_bgr[1] * args.resp_baseline  # G-weighted like the pulse

    header = f"YUV4MPEG2 W{W} H{H} F{fps}:1 Ip A1:1 {args.y4m_tag}\n".encode("ascii")
    t0 = time.time()
    first_rgb8 = None
    with open(out, "wb") as f:
        f.write(header)
        for n in range(N):
            delta = pulse[n] * amps_bgr
            if args.resp_baseline:
                delta = delta + resp_sin[n] * 0.5 * resp_bgr
            frame = base_f + mask3 * delta[None, None, :].astype(np.float32)
            if args.flicker_pct:
                frame *= 1.0 + args.flicker_pct / 100.0 * np.sin(2 * np.pi * args.flicker_hz * t[n] + flick_phase0)
            ty = args.resp_amp_px * resp_sin[n] + jit[n, 1]
            tx = jit[n, 0]
            Mw = np.array([[1, 0, tx], [0, 1, ty]], dtype=np.float64)
            frame = cv2.warpAffine(frame, Mw, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
            frame += rng.standard_normal(frame.shape, dtype=np.float32) * np.float32(args.noise_sigma)
            np.clip(frame, 0, 255, out=frame)
            rgb = frame[..., ::-1]
            y8, u8, v8 = rgb_to_i420_planes(rgb)
            f.write(b"FRAME\n")
            f.write(y8.tobytes())
            f.write(u8.tobytes())
            f.write(v8.tobytes())
            if n == 0:
                i420 = np.concatenate([y8.reshape(-1), u8.reshape(-1), v8.reshape(-1)]).reshape(H * 3 // 2, W)
                first_rgb8 = cv2.cvtColor(i420, cv2.COLOR_YUV2BGR_I420)
            if n % 300 == 0:
                print(f"  frame {n}/{N}  ({time.time() - t0:.1f}s)", flush=True)

    realised_mean_bpm = float(inst_bpm.mean())
    # true beat times (pulse-wave maxima) from the continuous phase -> ground-truth beat-to-beat HRV of the synthetic pulse
    ph_peak = float(_ph[int(np.argmax(_pr))])
    k0 = int(np.ceil((phase[0] - ph_peak) / (2 * np.pi)))
    k1 = int(np.floor((phase[-1] - ph_peak) / (2 * np.pi)))
    beat_t = np.interp(ph_peak + 2 * np.pi * np.arange(k0, k1 + 1), phase, t)
    ibi = np.diff(beat_t)
    has_pulse = bool(max(args.amp_r, args.amp_g, args.amp_b) > 0)
    has_breath = bool(args.resp_amp_px > 0 or args.resp_baseline > 0)
    hrv_truth = {"rmssd_ms": round(float(np.sqrt(np.mean(np.diff(ibi) ** 2)) * 1000), 2), "sdnn_ms": round(float(np.std(ibi, ddof=1) * 1000), 2),
                 "note": "from the injected slow +-%.1f bpm drift only; no beat-to-beat noise was injected" % args.drift_bpm} if has_pulse else None
    trace = [round(float(inst_bpm[int(round(s * fps)):int(round((s + 1) * fps))].mean()), 3) for s in range(int(args.seconds))]
    sidecar = {
        "kind": "SYNTHETIC bench video - validates the signal pipeline only, not clinical accuracy",
        "video": out.name,
        "bpm": args.bpm,
        "bpm_realised_mean": round(realised_mean_bpm, 3),
        "hr_trace_bpm_per_second": trace,
        "beat_times_s": [round(float(x), 4) for x in beat_t] if has_pulse else [],
        "hrv_truth_whole_video": hrv_truth,
        "injected": {"pulse": has_pulse, "breathing": has_breath},
        "control": (not has_pulse and not has_breath),
        "rpm": args.rpm,
        "seconds": args.seconds,
        "fps": fps,
        "frames": N,
        "size": [W, H],
        "seed": args.seed,
        "pulse": {
            "waveform": "fundamental + 0.3 x 2nd harmonic, peak-to-peak normalised to 1",
            "amplitude_pp_levels_rgb": {"R": args.amp_r, "G": args.amp_g, "B": args.amp_b},
            "hr_drift_max_abs_bpm": args.drift_bpm,
            "mask": "YCrCb skin (Cr 135-180, Cb 85-135, Y 50-245) AND face/neck ellipse, Gaussian-smoothed",
            "mask_pixels_weighted": round(float(mask.sum()), 1),
        },
        "breathing": {
            "model": "rigid whole-image vertical shift, sinusoid, bilinear sub-pixel",
            "amplitude_px": args.resp_amp_px,
            "intensity_baseline_pp_levels": args.resp_baseline,
        },
        "head_jitter_sigma_px": args.jitter_px,
        "sensor_noise_sigma_levels": args.noise_sigma,
        "illumination_flicker_pct": args.flicker_pct,
        "encoding": f"YUV4MPEG2 4:2:0 {args.y4m_tag}, BT.601 limited range",
        "source_image": "assets/portrait.jpg",
        "portrait_scale": args.scale,
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    out.with_suffix(".json").write_text(json.dumps(sidecar, indent=2), encoding="utf-8")

    # preview png: first frame with the mask outline, for eyeballing
    prev = first_rgb8.copy()
    green = np.zeros_like(prev); green[..., 1] = 255
    prev = (prev * (1 - 0.35 * mask[..., None]) + green * 0.35 * mask[..., None]).astype(np.uint8)
    out.with_suffix(".preview.png").write_bytes(cv2.imencode(".png", prev)[1].tobytes())
    size_mb = out.stat().st_size / 1e6
    print(f"wrote {out} ({size_mb:.0f} MB, {N} frames, {time.time() - t0:.0f}s); realised mean HR {realised_mean_bpm:.2f} bpm (nominal {args.bpm})")


if __name__ == "__main__":
    main()

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

Optional "real-phone failure" knobs (all OFF by default, so old commands give
the same videos for the same seed):
  --dim F          low light: whole scene x F, pulse amplitude x F (rPPG is a
                   relative modulation), sensor noise sigma x --dim-noise (2.5)
  --ae-steps       auto-exposure jumps: global gain steps of +-8..15 % every
                   4..6 s, each with a 0.3 s linear ramp
  --motion [PX]    irregular head translation (+-PX, default 10) + rotation
                   (+-2 deg) about the face centre
  --fps-var A-B    camera delivers A..B fps (rate changes every 2..5 s); the
                   constant-rate y4m emulates it by REPEATING the last
                   delivered frame in the 30 fps slots the camera missed
  --backlight      bright background (window), person 40 % darker
  --small-face F   face ellipse width = F x frame width (default face ~33 %)
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


def frame_affine(cx, cy, tx, ty, rot_deg):
    """2x3 affine: rotate by rot_deg about (cx, cy), then translate by (tx, ty). Shared with check_video.py."""
    M = cv2.getRotationMatrix2D((float(cx), float(cy)), float(rot_deg), 1.0)
    M[0, 2] += tx
    M[1, 2] += ty
    return M


def irregular_trace(rng, t, lo_hz=0.05, hi_hz=0.45, k=4):
    """Sum of k random sinusoids + a smoothed random walk, normalised to max |x| = 1 (irregular, smooth)."""
    x = np.zeros_like(t)
    for _ in range(k):
        x += rng.uniform(0.4, 1.0) * np.sin(2 * np.pi * rng.uniform(lo_hz, hi_hz) * t + rng.uniform(0, 2 * np.pi))
    walk = np.cumsum(rng.normal(0, 1, len(t)))
    walk = cv2.GaussianBlur(walk.reshape(1, -1).astype(np.float64), (0, 0), 15.0).ravel()
    walk -= walk.mean()
    x = x / (np.abs(x).max() + 1e-12) + 0.6 * walk / (np.abs(walk).max() + 1e-12)
    return x / (np.abs(x).max() + 1e-12)


def ae_gain_trace(rng, t, step_lo=0.08, step_hi=0.15, every_lo=4.0, every_hi=6.0, ramp_s=0.3):
    """Piecewise-constant global gain with linear ramps; returns (gain[t], list of steps)."""
    g = np.ones_like(t)
    level = 1.0
    steps = []
    tk = rng.uniform(every_lo, every_hi)
    while tk < t[-1]:
        mag = rng.uniform(step_lo, step_hi)
        sign = rng.choice([-1.0, 1.0])
        if level * (1 + sign * mag) > 1.25 or level * (1 + sign * mag) < 0.8:
            sign = -sign  # keep the exposure in a plausible band
        new = level * (1 + sign * mag)
        r = np.clip((t - tk) / ramp_s, 0.0, 1.0)
        g = np.where(t >= tk, level + (new - level) * r, g)
        steps.append({"t_s": round(float(tk), 3), "from": round(level, 4), "to": round(new, 4)})
        level = new
        tk += rng.uniform(every_lo, every_hi)
    return g, steps


def fps_var_index_map(rng, N, fps, lo, hi):
    """For each output slot (constant fps) the index of the last frame the emulated camera delivered."""
    delivered = []
    t_cap = 0.0
    seg_end = 0.0
    rate = hi
    while t_cap < N / fps:
        if t_cap >= seg_end:
            rate = rng.uniform(lo, hi)
            seg_end = t_cap + rng.uniform(2.0, 5.0)
        delivered.append(t_cap)
        t_cap += 1.0 / rate
    delivered = np.array(delivered)
    idx = np.zeros(N, dtype=np.int64)
    last = 0
    for n in range(N):
        k = int(np.searchsorted(delivered, n / fps + 1e-9, side="right") - 1)
        src = max(int(np.floor(delivered[k] * fps + 1e-9)), last)
        idx[n] = min(src, N - 1)
        last = idx[n]
    return idx


def person_mask(shape, ell):
    """Soft mask of the whole person (face, neck, shoulders/torso) for --backlight. Rough, by geometry."""
    H, W = shape
    m = np.zeros((H, W), np.uint8)
    (fcx, fcy, fax, fay), (ncx, ncy, nax, nay) = ell[0], ell[1]
    cv2.ellipse(m, (int(fcx), int(fcy)), (int(fax * 1.25), int(fay * 1.15)), 0, 0, 360, 255, -1)
    cv2.ellipse(m, (int(ncx), int(ncy)), (int(nax * 1.6), int(nay * 1.6)), 0, 0, 360, 255, -1)
    top = ncy
    pts = np.array([[ncx - fax * 1.9, top], [ncx + fax * 1.9, top], [ncx + fax * 3.4, H], [ncx - fax * 3.4, H]], np.int32)
    cv2.fillPoly(m, [pts], 255)
    return np.clip(cv2.GaussianBlur(m.astype(np.float32) / 255.0, (0, 0), 6.0), 0, 1)


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
    # real-phone failure knobs (all off by default)
    ap.add_argument("--dim", type=float, default=1.0, help="low light: scene and pulse x DIM (e.g. 0.35); noise x --dim-noise")
    ap.add_argument("--dim-noise", type=float, default=2.5, help="sensor-noise multiplier applied when --dim < 1")
    ap.add_argument("--ae-steps", action="store_true", help="auto-exposure gain steps +-8..15%% every 4..6 s, 0.3 s ramps")
    ap.add_argument("--motion", type=float, nargs="?", const=10.0, default=0.0, help="irregular head translation +-PX (default 10) + rotation")
    ap.add_argument("--motion-rot-deg", type=float, default=2.0, help="max head rotation with --motion (deg)")
    ap.add_argument("--fps-var", type=str, default=None, help="emulated camera rate range, e.g. 15-30 (frames repeated in the 30 fps y4m)")
    ap.add_argument("--backlight", action="store_true", help="bright background, person 40%% darker")
    ap.add_argument("--small-face", type=float, default=None, help="face ellipse width as a fraction of frame width (e.g. 0.25)")
    args = ap.parse_args()
    if args.small_face:
        args.scale = args.small_face * parse_size(args.size)[0] / (2.0 * FACE_ELLIPSES_SRC[0][2])

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
    rng_x = np.random.default_rng(args.seed + 1000)  # extra knobs use their own stream -> default videos unchanged
    gain = np.ones(N)
    ae_steps = []
    if args.ae_steps:
        gain, ae_steps = ae_gain_trace(rng_x, t)
    mot_tx = mot_ty = mot_rot = np.zeros(N)
    if args.motion:
        mot_tx = args.motion * irregular_trace(rng_x, t)
        mot_ty = 0.6 * args.motion * irregular_trace(rng_x, t)
        mot_rot = args.motion_rot_deg * irregular_trace(rng_x, t, 0.03, 0.3)
    src_idx = np.arange(N)
    if args.fps_var:
        lo, hi = (float(x) for x in args.fps_var.split("-"))
        src_idx = fps_var_index_map(rng_x, N, fps, lo, hi)
    noise_sigma = args.noise_sigma * (args.dim_noise if args.dim < 1.0 else 1.0)

    base, ell = build_base((W, H), args.scale)
    mask = skin_mask(base, ell)
    base_f = base.astype(np.float32)
    mask3 = mask[..., None]
    # photometric pre-transform: per-pixel gain map (scales scene AND pulse) + additive background offset
    if args.dim != 1.0 or args.backlight:
        light = np.full(mask.shape, args.dim, np.float32)
        offset = np.zeros(mask.shape + (3,), np.float32)
        if args.backlight:
            pm = person_mask(mask.shape, ell)
            light = light * (pm * 0.6 + (1 - pm) * 0.35)
            offset = np.repeat(((1 - pm) * 0.65 * 235.0)[..., None], 3, axis=2).astype(np.float32)
        base_f = base_f * light[..., None] + offset
        mask3 = mask3 * light[..., None]
    face_cx, face_cy = ell[0][0], ell[0][1]
    # BGR order for the per-channel pulse amplitudes
    amps_bgr = np.array([args.amp_b, args.amp_g, args.amp_r], dtype=np.float32)
    resp_bgr = amps_bgr / amps_bgr[1] * args.resp_baseline  # G-weighted like the pulse

    header = f"YUV4MPEG2 W{W} H{H} F{fps}:1 Ip A1:1 {args.y4m_tag}\n".encode("ascii")
    t0 = time.time()
    first_rgb8 = None
    with open(out, "wb") as f:
        f.write(header)
        last_src = -1
        last_bytes = None
        for n_out in range(N):
            n = int(src_idx[n_out])
            if n == last_src and last_bytes is not None:  # --fps-var: camera missed this slot -> repeat frame
                f.write(b"FRAME\n")
                f.write(last_bytes)
                continue
            last_src = n
            delta = pulse[n] * amps_bgr
            if args.resp_baseline:
                delta = delta + resp_sin[n] * 0.5 * resp_bgr
            frame = base_f + mask3 * delta[None, None, :].astype(np.float32)
            if args.flicker_pct:
                frame *= 1.0 + args.flicker_pct / 100.0 * np.sin(2 * np.pi * args.flicker_hz * t[n] + flick_phase0)
            if args.ae_steps:
                frame *= np.float32(gain[n])
            ty = args.resp_amp_px * resp_sin[n] + jit[n, 1]
            tx = jit[n, 0]
            if args.motion:
                Mw = frame_affine(face_cx, face_cy, tx + mot_tx[n], ty + mot_ty[n], mot_rot[n])
            else:
                Mw = np.array([[1, 0, tx], [0, 1, ty]], dtype=np.float64)
            frame = cv2.warpAffine(frame, Mw, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
            frame += rng.standard_normal(frame.shape, dtype=np.float32) * np.float32(noise_sigma)
            np.clip(frame, 0, 255, out=frame)
            rgb = frame[..., ::-1]
            y8, u8, v8 = rgb_to_i420_planes(rgb)
            f.write(b"FRAME\n")
            last_bytes = y8.tobytes() + u8.tobytes() + v8.tobytes()
            f.write(last_bytes)
            if n == 0:
                i420 = np.concatenate([y8.reshape(-1), u8.reshape(-1), v8.reshape(-1)]).reshape(H * 3 // 2, W)
                first_rgb8 = cv2.cvtColor(i420, cv2.COLOR_YUV2BGR_I420)
            if n_out % 300 == 0:
                print(f"  frame {n_out}/{N}  ({time.time() - t0:.1f}s)", flush=True)

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
    hard = {}
    if args.dim != 1.0:
        hard["dim"] = {"scene_and_pulse_gain": args.dim, "noise_sigma_levels": noise_sigma}
    if args.ae_steps:
        hard["ae_steps"] = {"steps": ae_steps, "ramp_s": 0.3, "gain_per_frame": [round(float(x), 4) for x in gain]}
    if args.motion:
        hard["motion"] = {"max_translation_px": args.motion, "max_rot_deg": args.motion_rot_deg, "centre_px": [round(float(face_cx), 2), round(float(face_cy), 2)],
                          "tx_px": [round(float(x), 3) for x in mot_tx], "ty_px": [round(float(x), 3) for x in mot_ty], "rot_deg": [round(float(x), 4) for x in mot_rot],
                          "note": "per SOURCE frame index, excludes breathing shift and jitter; affine = rotate about centre then translate"}
    if args.fps_var:
        uniq = len(np.unique(src_idx))
        hard["fps_var"] = {"range_fps": args.fps_var, "unique_frames": uniq, "effective_mean_fps": round(uniq / args.seconds, 2),
                           "source_index_per_output_frame": [int(x) for x in src_idx],
                           "note": "y4m is constant-rate; slots the emulated camera missed repeat the previous frame"}
    if args.backlight:
        hard["backlight"] = {"person_gain": 0.6, "background": "0.35 x scene + 0.65 x 235 levels", "note": "rough geometric person mask"}
    if args.small_face:
        hard["small_face"] = {"face_width_fraction": args.small_face, "portrait_scale": round(float(args.scale), 4)}
    if hard:
        sidecar["hard_conditions"] = hard
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

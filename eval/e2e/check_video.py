#!/usr/bin/env python
"""
check_video.py - prove a synthetic y4m is a valid test input, without the app.

  python check_video.py E:\\nazra-e2e\\face_72bpm_15rpm.y4m [more.y4m ...]

For each video: decode the y4m the way a browser would (I420 -> RGB, BT.601
limited), then
  1. HR: mean RGB of the (eroded) skin mask per frame -> green-channel band-pass
     and POS -> FFT peak in 0.7-3 Hz  (pass: within +-2 bpm of nominal)
  2. RR: vertical shift of the row-profile per frame (cross-correlation with
     parabolic sub-pixel peak) -> FFT peak in 0.1-0.7 Hz  (pass: within +-2 rpm)
Exit code 1 if any check fails. SYNTHETIC bench check only.

Hard clips (sidecar "hard_conditions", see make_video.py --dim/--ae-steps/--motion/
--fps-var/--backlight/--small-face): the skin mask is moved with the KNOWN per-frame
head transform (oracle tracking), RR is measured on the row shift minus the known
head translation, and the HR gate is POS only (POS normalises per window, so it is
gain-step invariant; plain green is reported but not gated). RR is not gated for
--motion clips (rotation leaks into the row profile).
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_video as mv  # noqa: E402


def read_y4m(path):
    with open(path, "rb") as f:
        hdr = f.readline().decode("ascii").split()
        assert hdr[0] == "YUV4MPEG2", hdr
        W = H = None
        fps = 30.0
        for tok in hdr[1:]:
            if tok[0] == "W":
                W = int(tok[1:])
            elif tok[0] == "H":
                H = int(tok[1:])
            elif tok[0] == "F":
                a, b = tok[1:].split(":")
                fps = int(a) / int(b)
        fsz = W * H * 3 // 2
        frames = []
        while True:
            line = f.readline()
            if not line:
                break
            assert line.startswith(b"FRAME"), line[:20]
            buf = f.read(fsz)
            if len(buf) < fsz:
                break
            frames.append(np.frombuffer(buf, np.uint8).reshape(H * 3 // 2, W))
    return W, H, fps, frames


def bandpass_fft(x, fps, lo, hi):
    n = len(x)
    x = x - x.mean()
    X = np.fft.rfft(x * np.hanning(n))
    f = np.fft.rfftfreq(n, 1.0 / fps)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, n)


def peak_freq(x, fps, lo, hi, nfft=1 << 17):
    x = x - x.mean()
    X = np.abs(np.fft.rfft(x * np.hanning(len(x)), nfft))
    f = np.fft.rfftfreq(nfft, 1.0 / fps)
    sel = (f >= lo) & (f <= hi)
    i = np.argmax(np.where(sel, X, 0))
    return f[i], float(X[i] / (np.median(X[sel]) + 1e-12))  # peak, peak-to-median ratio


def pos(rgb, fps, win_s=1.6):
    """Wang et al. 2017 plane-orthogonal-to-skin, overlap-add. rgb: Nx3 (R,G,B)."""
    N = len(rgb)
    L = int(round(win_s * fps))
    P = np.array([[0, 1, -1], [-2, 1, 1]], dtype=np.float64)
    H = np.zeros(N)
    for t in range(0, N - L + 1):
        C = rgb[t:t + L].T
        Cn = C / C.mean(axis=1, keepdims=True)
        S = P @ Cn
        h = S[0] + (S[0].std() / (S[1].std() + 1e-12)) * S[1]
        H[t:t + L] += h - h.mean()
    return H


def row_shift_series(Ys):
    """Vertical shift (px) of each frame vs the temporal-mean row profile, via cross-correlation + parabola."""
    prof = np.stack([cv2.GaussianBlur(y.astype(np.float32).mean(axis=1, keepdims=True), (1, 0), 1.5)[:, 0] for y in Ys])
    ref = prof.mean(axis=0)
    ref = (ref - ref.mean()) / ref.std()
    lags = np.arange(-8, 9)
    m = 12  # trim edges so wrap/reflection does not matter
    shifts = np.zeros(len(prof))
    for k, p in enumerate(prof):
        p = (p - p.mean()) / p.std()
        c = np.array([np.dot(p[m:-m], np.roll(ref, -L)[m:-m]) for L in lags])
        j = int(np.argmax(c))
        j = min(max(j, 1), len(c) - 2)
        den = c[j - 1] - 2 * c[j] + c[j + 1]
        off = 0.5 * (c[j - 1] - c[j + 1]) / den if den != 0 else 0.0
        shifts[k] = lags[j] + off
    return shifts


def check(path):
    path = Path(path)
    side = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
    W, H, fps, frames = read_y4m(path)
    N = len(frames)
    base, ell = mv.build_base((W, H), side.get("portrait_scale", 0.9))
    mask = mv.skin_mask(base, ell)
    core_u8 = cv2.erode((mask > 0.5).astype(np.uint8), np.ones((15, 15), np.uint8))
    core = core_u8.astype(bool)
    hard = side.get("hard_conditions") or {}
    src = hard.get("fps_var", {}).get("source_index_per_output_frame") or list(range(N))
    mot = hard.get("motion")

    rgb = np.zeros((N, 3))
    Ys = []
    for i, fr in enumerate(frames):
        bgr = cv2.cvtColor(fr, cv2.COLOR_YUV2BGR_I420)
        if mot:
            n = src[min(i, len(src) - 1)]
            M = mv.frame_affine(mot["centre_px"][0], mot["centre_px"][1], mot["tx_px"][n], mot["ty_px"][n], mot["rot_deg"][n])
            cm = cv2.warpAffine(core_u8, M, (W, H), flags=cv2.INTER_NEAREST, borderValue=0).astype(bool)
            px = bgr[cm]
        else:
            px = bgr[core]
        rgb[i] = px.mean(axis=0)[::-1]  # RGB
        Ys.append(fr[:H])
    # HR
    g = bandpass_fft(rgb[:, 1], fps, 0.7, 3.0)
    f_g, snr_g = peak_freq(g, fps, 0.7, 3.0)
    ppos = bandpass_fft(pos(rgb, fps), fps, 0.7, 3.0)
    f_p, snr_p = peak_freq(ppos, fps, 0.7, 3.0)
    # RR
    sh = row_shift_series(Ys)
    if mot:
        sh = sh - np.array([mot["ty_px"][src[min(i, len(src) - 1)]] for i in range(N)])
    sh_bp = bandpass_fft(sh, fps, 0.1, 0.7)
    f_r, snr_r = peak_freq(sh_bp, fps, 0.1, 0.7)
    # amplitude of the recovered breathing sinusoid at the true rpm (least squares)
    tt = np.arange(N) / fps
    w = 2 * np.pi * side["rpm"] / 60.0
    A = np.stack([np.sin(w * tt), np.cos(w * tt), np.ones(N)], 1)
    coef = np.linalg.lstsq(A, sh, rcond=None)[0]
    amp = float(np.hypot(coef[0], coef[1]))

    row = dict(
        video=path.name,
        truth_bpm=side["bpm"], truth_bpm_realised=side["bpm_realised_mean"], truth_rpm=side["rpm"],
        hr_green=f_g * 60, hr_pos=f_p * 60, snr_green=snr_g, snr_pos=snr_p,
        rr_rowshift=f_r * 60, snr_rr=snr_r, shift_amp_px=amp, frames=N, fps=fps,
        ac_green=float(np.ptp(g)),
    )
    row["hr_green_err"] = row["hr_green"] - side["bpm"]
    row["hr_pos_err"] = row["hr_pos"] - side["bpm"]
    row["rr_err"] = row["rr_rowshift"] - side["rpm"]
    row["hard"] = ",".join(sorted(hard)) or "-"
    if hard:
        row["pass"] = abs(row["hr_pos_err"]) <= 2 and (bool(mot) or abs(row["rr_err"]) <= 2)
    else:
        row["pass"] = abs(row["hr_green_err"]) <= 2 and abs(row["hr_pos_err"]) <= 2 and abs(row["rr_err"]) <= 2
    return row


def main():
    vids = sys.argv[1:] or [r"E:\nazra-e2e\face_72bpm_15rpm.y4m", r"E:\nazra-e2e\face_96bpm_20rpm.y4m"]
    rows = [check(v) for v in vids]
    hdr = f"{'video':30} {'truth':>11} {'GREEN bpm':>10} {'err':>6} {'POS bpm':>9} {'err':>6} {'rowshift rpm':>13} {'err':>6} {'amp px':>7} {'result':>7}  hard"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        truth = f"{r['truth_bpm']:.0f}/{r['truth_rpm']:.0f}"
        print(f"{r['video']:30} {truth:>11} {r['hr_green']:10.2f} {r['hr_green_err']:+6.2f} {r['hr_pos']:9.2f} {r['hr_pos_err']:+6.2f} "
              f"{r['rr_rowshift']:13.2f} {r['rr_err']:+6.2f} {r['shift_amp_px']:7.2f} {'PASS' if r['pass'] else 'FAIL':>7}  {r['hard']}")
    print()
    for r in rows:
        print(f"{r['video']:30} skin-mean green band-passed p-p {r['ac_green']:.3f} levels | spectral peak/median: green {r['snr_green']:.0f}, POS {r['snr_pos']:.0f}, rowshift {r['snr_rr']:.0f}")
    print("\ntruth = nominal bpm/rpm (realised mean HR incl. drift: " + ", ".join(f"{r['truth_bpm_realised']:.2f}" for r in rows) + " bpm)")
    print("SYNTHETIC bench check: validates the video as a test input, not clinical accuracy.")
    sys.exit(0 if all(r["pass"] for r in rows) else 1)


if __name__ == "__main__":
    main()

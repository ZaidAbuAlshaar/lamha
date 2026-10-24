#!/usr/bin/env python
"""
make_hard_set.py - generate the "hard" SIMULATED clip set (real-phone failure modes) in parallel.

  python make_hard_set.py [--out E:\\nazra-e2e\\hard] [--seconds 60] [--jobs 7] [--only motion]

Each clip = one failure mode (plus one combined clip), known bpm in 60-110, JSON sidecar next to it.
60 s long so a hardened scan (pre-scan gate + auto-extension up to 45 s) never wraps the file.
SYNTHETIC: validates the signal pipeline under simulated stress, not clinical accuracy.
"""
import argparse
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAKE = HERE.parent / "e2e" / "make_video.py"

CLIPS = [
    # name,                       bpm, rpm, seed, extra args
    ("hard_dim035_64bpm",          64, 14, 11, ["--dim", "0.35"]),
    ("hard_aesteps_78bpm",         78, 16, 12, ["--ae-steps"]),
    ("hard_motion10px_88bpm",      88, 18, 13, ["--motion", "10"]),
    ("hard_fpsvar15-30_70bpm",     70, 15, 14, ["--fps-var", "15-30"]),
    ("hard_backlight_104bpm",     104, 20, 15, ["--backlight"]),
    ("hard_smallface025_92bpm",    92, 17, 16, ["--small-face", "0.25"]),
    ("hard_combo_82bpm",           82, 16, 17, ["--dim", "0.6", "--ae-steps", "--motion", "6", "--fps-var", "20-30"]),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=r"E:\nazra-e2e\hard")
    ap.add_argument("--seconds", type=float, default=60)
    ap.add_argument("--jobs", type=int, default=7)
    ap.add_argument("--only", default=None)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    todo = [c for c in CLIPS if not a.only or a.only in c[0]]

    def run(c):
        name, bpm, rpm, seed, extra = c
        cmd = [sys.executable, str(MAKE), "--bpm", str(bpm), "--rpm", str(rpm), "--seed", str(seed),
               "--seconds", str(a.seconds), "--out", str(out / f"{name}.y4m")] + extra
        r = subprocess.run(cmd, capture_output=True, text=True)
        (out / f"{name}.gen.log").write_text(" ".join(cmd) + "\n" + r.stdout + r.stderr, encoding="utf-8")
        return name, r.returncode, (r.stdout.strip().splitlines() or [""])[-1]

    with ThreadPoolExecutor(a.jobs) as ex:
        for name, rc, last in ex.map(run, todo):
            print(f"{'OK ' if rc == 0 else 'ERR'} {name}: {last}")


if __name__ == "__main__":
    main()

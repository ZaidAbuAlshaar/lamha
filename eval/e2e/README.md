# Synthetic-face end-to-end bench (Simulated)

Feeds a synthetic video with a **known** pulse and breathing rate into the real app through Chrome's fake camera, and reads the app's result.
It validates the signal pipeline (MediaPipe → skin ROIs → POS → spectrum), **not** clinical accuracy on people.

Setup: download MediaPipe's public demo portrait to `assets/portrait.jpg` (not committed):
`curl -L -o assets/portrait.jpg https://storage.googleapis.com/mediapipe-assets/portrait.jpg`

```
python make_video.py --bpm 72 --rpm 15 --seconds 45 --out E:\nazra-e2e\face_72bpm_15rpm.y4m --seed 1
python make_video.py --bpm 96 --rpm 20 --seconds 45 --out E:\nazra-e2e\face_96bpm_20rpm.y4m --seed 2
python check_video.py                      # self-check the videos (no app)
npm install
node run_e2e.mjs --video E:\nazra-e2e\face_72bpm_15rpm.y4m --url "http://localhost:5173/#/scan-test?seconds=30"
```

Results of 2026-10-24 (headless Chrome 155, 30 s scan, **production build served at :8787**):

| video | truth | app HR | app RR | quality | file |
|---|---|---|---|---|---|
| face_72bpm_15rpm | 72 bpm / 15 rpm | 72.3 | 15.0 | good | `results/face_72bpm_15rpm_20261024-140703.json` |
| face_96bpm_20rpm | 96 bpm / 20 rpm | 95.7 | 20.0 | good | `results/face_96bpm_20rpm_20261024-140742.json` |

Earlier runs against the dev server (:5173) gave the same HR/RR (`...-135928`, `...-140015`). A no-pulse control
(`...-140048`) came back HR 66.6 with **confidence 0** and quality **poor**, so the app does not just echo a fixed value.
One early dev-server run failed with `AbortError` from a camera-start race under React StrictMode; that race is fixed
(`VitalsEngine.stopped`) and the stub-page runs used to debug the harness were removed from `results/`.

Honest limits:
- Breathing is injected as a rigid whole-frame shift, which is an easy case.
- HRV is **not** validated. True RMSSD over 30 s was ~3.5 / ~1.7 ms; the app read 21 / 12.4 ms, so noise inflates it. For this reason the stress index is labelled experimental and never changes triage.

### Hard set (simulated real-phone failures) and accuracy eval

`make_video.py` has optional knobs (all off by default; the default 72 bpm clip regenerates byte-identical):
`--dim 0.35` (scene + pulse x0.35, noise x2.5), `--ae-steps` (gain steps ±8–15 % every 4–6 s, 0.3 s ramps),
`--motion [10]` (irregular translation ±10 px + rotation ±2°), `--fps-var 15-30` (missed camera slots repeat the
previous frame in the 30 fps y4m), `--backlight` (bright background, person 40 % darker), `--small-face 0.25`.

```
python ../accuracy/make_hard_set.py                 # 7 clips, 60 s each -> E:\nazra-e2e\hard\
python check_video.py E:\nazra-e2e\hard\*.y4m       # oracle check (mask moved with the known head transform)
node ../accuracy/run_eval.mjs --configs baseline,hardened
node run_flow.mjs                                    # full flow, fake camera + fake mic, 2 emulated phone viewports
```

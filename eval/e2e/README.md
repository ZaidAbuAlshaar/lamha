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

Results of 2026-10-24 (headless Chrome 155, 30 s scan, real app):

| video | truth | app HR | app RR | quality |
|---|---|---|---|---|
| face_72bpm_15rpm | 72 bpm / 15 rpm | 72.3 | 15.0 | good |
| face_96bpm_20rpm | 96 bpm / 20 rpm | 95.7 | 20.0 | good |
| control (no pulse, no breathing) | n/a | 66.6 (confidence 0) | 31.2 | poor |

Honest limits:
- Breathing is injected as a rigid whole-frame shift, which is an easy case.
- HRV is **not** validated. True RMSSD over 30 s was ~3.5 / ~1.7 ms; the app read 20.6 / 10.2 ms, so noise inflates it. For this reason the stress index is labelled experimental and never changes triage.

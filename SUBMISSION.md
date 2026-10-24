# Submission: copy-paste text (Hacktoberfest Hack Day Amman x JOSA 2026)

## Name
**Lamha · لمحة**

## Tagline (one line)
A 30-second health check-in from any phone camera. On-device pulse and breathing, Jordanian-Arabic symptoms understood by open-weight AI, and emergencies routed to the nearest health centre.

## Track
Digital Health & Wellness

## Links
- **Live demo (patient, open on a phone):** https://illustration-map-market-template.trycloudflare.com/#/
- **Doctor dashboard:** https://illustration-map-market-template.trycloudflare.com/#/doctor
- **Partner-centre console:** https://illustration-map-market-template.trycloudflare.com/#/center?id=c-shmeisani
- **Code:** https://github.com/ZaidAbuAlshaar/nazra
- The live demo runs on our laptop through a Cloudflare tunnel, so the link is only up while the laptop is on.

## Description

**Problem.** In remote villages, refugee camps and homes with elderly or chronic patients, nobody measures vitals daily. Deterioration is found late, usually in the emergency room.

**What Lamha does.**
- A patient holds their phone to their face for 30 seconds. The browser estimates heart rate and breathing from the camera (rPPG), on the device. The video never leaves the phone.
- They then say what hurts in Jordanian Arabic.
- Lamha compares the reading with the patient's own baseline. When a rise is sustained, it tells the doctor "worth a review".
- In an emergency, the patient first sees "Call 911". At the same time, an alert reaches the nearest partner health centre, which must acknowledge it; if it doesn't, the alert escalates to the next centre.

**How it's built.**
- **Phone:** React + MediaPipe Face Landmarker. Skin-region polygons with a YCrCb mask; POS, CHROM and GREEN fused by SNR over 10-second Welch windows; HR tracking; a pre-scan quality gate; and a composite quality score.
- **Clinic laptop:** FastAPI.
  - Whisper large-v3 transcribes the speech.
  - Gemma 4 E4B (local, via Ollama) extracts symptoms. Every symptom must quote the patient's exact words, and code checks the quote.
  - A robust baseline with CUSUM flags sustained rises.
  - The 24/48 h forecast carries an 80% interval and is cross-checked by Chronos-Bolt.
  - A WebSocket sends partner-centre alerts, with escalation.
  - A patient report draws only on sourced advice cards (NHS and WHO), read aloud in a Jordanian voice.
  - A chatbot answers patient questions.

**Safety by design.**
- Deterministic red-flag rules decide emergencies; the AI can only escalate.
- Trend flags can raise a check-in to an appointment but never to an emergency.
- No model writes a vital-sign number: every number in model text is checked against the measured facts, and a fixed template replaces any text that fails.
- No risk probabilities are shown anywhere.
- Every indicator is labelled "for follow-up, not a diagnosis".

**Open-weight AI.**
- **Local:** Whisper large-v3, Gemma 4 E4B, Chronos-Bolt-small, Piper ar_JO and MediaPipe.
- **Cloud fallback:** Gemma 4 31B through OpenRouter. It runs only when the local model fails, with a daily cap, and receives text only.
- **Example:** for "حاسس صدري تقيل" ("my chest feels heavy"), the rules alone return "follow-up". Gemma's extraction, with a verified quote, turns it into an emergency.

**What we measured today (honest).**
- **Synthetic face videos fed into the real app:**
  - 72 bpm truth → 72.0
  - 9 hard clips (low light, exposure jumps, motion, variable FPS, backlight, small face): 0 failures, mean error under 0.5 bpm
  - a video with no pulse → rejected
- **First real iPhone scans:** stable HR across windows. They exposed three measurement issues, which we fixed: hand tremor, a frame-timing statistic, and the GREEN algorithm disagreeing.
- **Not yet measured:** accuracy on people against a finger oximeter. The tooling for it is built in.
- **Arabic audio tests:** 16 of 16 passed. 191 automated tests pass.

**What's next.** A validation study against a medical oximeter across diverse skin tones and lighting, clinical review of the advice cards, real partner centres, and doctor login.

## Built with
React, TypeScript, Vite, MediaPipe, FastAPI, SQLite, WebSocket, faster-whisper (Whisper large-v3), Ollama, Gemma 4 (E4B local / 31B fallback), Chronos-Bolt, Piper TTS, Cloudflare Tunnel.

## Pre-event work disclosure
The idea and a planning document were drafted before the event. All code, data and assets were created on 2026-10-24, and the commit history in the repository shows this. Demo patients, partner centres and contact numbers are synthetic and labelled «بيانات تجريبية».

## Team
<!-- confirm names before submitting -->
Zaid Abu Alshaar (software & integration) · Abdalrahman Al-Haymouni · Abdalrahman Al-Kurdi

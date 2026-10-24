// Camera → face landmarks → skin-ROI colour traces + chest motion → vitals.
// Everything runs in the browser. No frame ever leaves the device.
import { FaceLandmarker, FilesetResolver, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import {
  FS, clamp, estimateHr, estimateRr, findPeaks, hrStability, hrv, resampleUniform, spectrumPeak, stressFromRmssd, stressLevel,
} from './dsp';
import { ScanDiag, deviceInfo, environmentReasons } from './diag';

export type Guidance = 'no-face' | 'dark' | 'move' | 'ok';

export interface DebugInfo {
  fps: number; jitter_ms: number; brightness: number; clipped_pct: number; face_width_pct: number; motion: number;
  yaw_deg: number; backlight_ratio: number; proc_ms: number; snr_db: number | null; hr: number | null;
  raw: number[]; bvp: number[]; spec: { f: number[]; p: number[]; peak: number | null };
  gate?: Record<string, boolean>;
  algos?: Record<string, number>;
}

export interface LiveUpdate {
  debug?: DebugInfo;
  phase: 'loading' | 'waiting-face' | 'scanning' | 'analyzing' | 'done' | 'error';
  elapsed: number;
  progress: number;
  guidance: Guidance;
  liveHr: number | null;
  wave: number[];
  fps: number;
  error?: string;
}

export interface VitalsResult {
  hr_bpm: number | null;
  hr_confidence: number;
  hr_snr_db: number;
  rr_bpm: number | null;
  rr_confidence: number;
  hrv_rmssd_ms: number | null;
  hrv_sdnn_ms: number | null;
  stress_index: number | null;
  stress_level: 'low' | 'moderate' | 'high' | null;
  quality: 'good' | 'fair' | 'poor';
  scan_seconds: number;
  fps: number;
  face_fraction: number;
  bvp_preview: number[];
  quality_reasons?: string[];
  quality_score?: number;
  quality_components?: Record<string, number>;
  diagnostics?: Record<string, unknown>;
}

// MediaPipe face-mesh indices. Forehead centre ≈ between 10 (hairline) and 9 (glabella); cheeks at 50 / 280.
const LM = { top: 10, glabella: 9, chin: 152, left: 234, right: 454, cheekA: 50, cheekB: 280, nose: 1 };

let landmarkerPromise: Promise<FaceLandmarker> | null = null;
export let landmarkerDelegate = 'unknown';

export function loadLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      const opts = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate },
        runningMode: 'VIDEO' as const,
        numFaces: 1,
        outputFacialTransformationMatrixes: true, // head pose for the hardened engine's frontal check
      });
      try {
        const lm = await FaceLandmarker.createFromOptions(files, opts('GPU'));
        landmarkerDelegate = 'GPU';
        return lm;
      } catch {
        const lm = await FaceLandmarker.createFromOptions(files, opts('CPU'));
        landmarkerDelegate = 'CPU';
        return lm;
      }
    })();
    landmarkerPromise.catch(() => (landmarkerPromise = null));
  }
  return landmarkerPromise;
}

interface Roi { kind: 'rect' | 'circle'; cx: number; cy: number; w: number; h: number }

function rois(lm: NormalizedLandmark[], W: number, H: number): { list: Roi[]; faceW: number; faceH: number; cx: number; cy: number } {
  const P = (i: number) => ({ x: lm[i].x * W, y: lm[i].y * H });
  const L = P(LM.left), R = P(LM.right), T = P(LM.top), C = P(LM.chin), G = P(LM.glabella);
  const faceW = Math.hypot(R.x - L.x, R.y - L.y);
  const faceH = Math.hypot(C.x - T.x, C.y - T.y);
  const fx = (T.x + G.x) / 2, fy = T.y + (G.y - T.y) * 0.55;
  const ca = P(LM.cheekA), cb = P(LM.cheekB);
  return {
    list: [
      { kind: 'rect', cx: fx, cy: fy, w: faceW * 0.42, h: faceH * 0.14 },
      { kind: 'circle', cx: ca.x, cy: ca.y, w: faceW * 0.16, h: faceW * 0.16 },
      { kind: 'circle', cx: cb.x, cy: cb.y, w: faceW * 0.16, h: faceW * 0.16 },
    ],
    faceW, faceH, cx: (L.x + R.x) / 2, cy: (T.y + C.y) / 2,
  };
}

/** Mean luma of two patches beside the head at forehead height (for backlight detection). */
export function bgLuma(img: Uint8ClampedArray, W: number, H: number, geo: { faceW: number; faceH: number; cx: number; cy: number }): number | null {
  const y0 = Math.max(0, Math.floor(geo.cy - geo.faceH * 0.45)), y1 = Math.min(H - 1, Math.floor(geo.cy - geo.faceH * 0.15));
  let s = 0, n = 0;
  for (const side of [-1, 1]) {
    const xa = side < 0 ? Math.max(0, Math.floor(geo.cx - geo.faceW * 1.25)) : Math.min(W - 1, Math.floor(geo.cx + geo.faceW * 0.85));
    const xb = side < 0 ? Math.max(0, Math.floor(geo.cx - geo.faceW * 0.85)) : Math.min(W - 1, Math.floor(geo.cx + geo.faceW * 1.25));
    for (let y = y0; y <= y1; y += 2) for (let x = xa; x < xb; x += 2) {
      const k = (y * W + x) * 4;
      s += 0.299 * img[k] + 0.587 * img[k + 1] + 0.114 * img[k + 2]; n++;
    }
  }
  return n > 20 ? s / n : null;
}

export class VitalsEngine {
  private stream: MediaStream | null = null;
  private landmarker: FaceLandmarker | null = null;
  private proc = document.createElement('canvas');
  private pctx = this.proc.getContext('2d', { willReadFrequently: true })!;
  private raf = 0;
  private running = false;
  private lastVideoTime = -1;
  private startT: number | null = null;
  private lastFaceT = 0;
  private frames = 0;
  private faceFrames = 0;
  private lastHrCalc = 0;
  private liveHr: number | null = null;
  private wave: number[] = [];
  private fpsEst = 0;
  private lastTick = 0;
  // traces
  private t: number[] = [];
  private R: number[] = [];
  private G: number[] = [];
  private B: number[] = [];
  private motion: number[] = [];
  private headY: number[] = [];
  private centers: { x: number; y: number }[] = [];
  private bright: number[] = [];
  // chest ROI (fixed in frame coordinates once the face is found)
  private chest: { x: number; y: number; w: number; h: number } | null = null;
  private prevProfile: Float64Array | null = null;
  private chestPos = 0;
  private lastRois: Roi[] = [];
  private lastLandmarks: NormalizedLandmark[] | null = null;
  private pulse = 0;
  private stopped = false;
  readonly diag = new ScanDiag();
  private lastDebug: DebugInfo | undefined;
  private prevCenter: { x: number; y: number } | null = null;

  constructor(
    private video: HTMLVideoElement,
    private overlay: HTMLCanvasElement,
    private seconds: number,
    private onUpdate: (u: LiveUpdate) => void,
    private opts: { debug?: boolean } = {},
  ) {}

  async start() {
    this.emit('loading');
    try {
      const [stream, lm] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
          audio: false,
        }),
        loadLandmarker(),
      ]);
      // stop() may have been called while we awaited (React remount): release the camera and bail out.
      if (this.stopped) { stream.getTracks().forEach((tr) => tr.stop()); return; }
      this.stream = stream;
      this.landmarker = lm;
      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      try {
        await this.video.play();
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) throw e; // a newer load replaced this one
      }
      if (this.stopped) return;
      this.running = true;
      this.loop();
    } catch (e) {
      if (this.stopped) return;
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.emit('error', msg);
      throw e;
    }
  }

  stop() {
    this.stopped = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
  }

  private emit(phase: LiveUpdate['phase'], error?: string) {
    const elapsed = this.startT == null ? 0 : (this.t[this.t.length - 1] ?? this.startT) - this.startT;
    const fresh = performance.now() / 1000 - this.lastFaceT < 0.6;
    let guidance: Guidance = 'ok';
    if (!fresh) guidance = 'no-face';
    else if (this.bright.length && this.bright[this.bright.length - 1] < 55) guidance = 'dark';
    else if (this.recentMotion() > 0.035) guidance = 'move';
    this.onUpdate({
      phase, elapsed, progress: clamp(elapsed / this.seconds, 0, 1), guidance,
      liveHr: this.liveHr, wave: this.wave, fps: this.fpsEst, error, debug: this.lastDebug,
    });
  }

  /** Face-centre movement over the last second, as a fraction of face width. */
  private recentMotion(): number {
    const c = this.centers;
    if (c.length < 10) return 0;
    const a = c[c.length - 1], b = c[Math.max(0, c.length - 1 - Math.round(this.fpsEst || 30))];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const v = this.video;
    if (v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const now = performance.now();
    if (this.lastTick) this.fpsEst = this.fpsEst ? this.fpsEst * 0.9 + (1000 / (now - this.lastTick)) * 0.1 : 1000 / (now - this.lastTick);
    this.lastTick = now;
    this.diag.frame(now);
    if (this.startT != null) this.frames++; // face fraction counts only frames after the scan started
    this.process(now / 1000);
  };

  private process(ts: number) {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    const tProc = performance.now();
    const W = 320, H = Math.round((320 * vh) / vw);
    if (this.proc.width !== W) { this.proc.width = W; this.proc.height = H; }
    const res = this.landmarker!.detectForVideo(v, performance.now());
    const lm = res.faceLandmarks?.[0];
    this.pctx.drawImage(v, 0, 0, W, H);
    this.lastLandmarks = lm ?? null;

    if (lm) {
      this.lastFaceT = ts;
      const geo = rois(lm, W, H);
      this.lastRois = geo.list;
      const img = this.pctx.getImageData(0, 0, W, H).data;
      let sr = 0, sg = 0, sb = 0, n = 0, total = 0, clipped = 0, dark = 0;
      for (const roi of geo.list) {
        const x0 = Math.max(0, Math.floor(roi.cx - roi.w / 2)), x1 = Math.min(W - 1, Math.ceil(roi.cx + roi.w / 2));
        const y0 = Math.max(0, Math.floor(roi.cy - roi.h / 2)), y1 = Math.min(H - 1, Math.ceil(roi.cy + roi.h / 2));
        const rx = roi.w / 2, ry = roi.h / 2;
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            if (roi.kind === 'circle' && ((x - roi.cx) / rx) ** 2 + ((y - roi.cy) / ry) ** 2 > 1) continue;
            const k = (y * W + x) * 4;
            const r = img[k], g = img[k + 1], b = img[k + 2];
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            total++;
            if (r >= 250 || g >= 250 || b >= 250) clipped++;
            if (luma < 25) dark++;
            if (luma < 25 || luma > 245) continue; // clipped pixels carry no pulse
            sr += r; sg += g; sb += b; n++;
          }
        }
      }
      // diagnostics (numbers only)
      const P = (i: number) => ({ x: lm[i].x, y: lm[i].y });
      const nose = P(LM.nose), L = P(LM.left), Rt = P(LM.right), T = P(LM.top), C = P(LM.chin);
      const ratio = (nose.x - L.x) / Math.max(1e-6, Rt.x - L.x);
      const vratio = (nose.y - T.y) / Math.max(1e-6, C.y - T.y);
      const c = { x: geo.cx / geo.faceW, y: geo.cy / geo.faceW };
      const mv = this.prevCenter ? Math.hypot(c.x - this.prevCenter.x, c.y - this.prevCenter.y) : 0;
      this.prevCenter = c;
      this.diag.add({
        brightness: n ? 0.299 * (sr / n) + 0.587 * (sg / n) + 0.114 * (sb / n) : 0,
        clippedPct: total ? (100 * clipped) / total : 0,
        darkPct: total ? (100 * dark) / total : 0,
        faceWidthPct: (100 * geo.faceW) / W,
        motion: mv,
        yawDeg: (ratio - 0.5) * 2 * 55, // rough landmark-ratio estimate
        pitchDeg: (vratio - 0.6) * 2 * 55,
        bgBrightness: bgLuma(img, W, H, geo),
        valid: n > 30,
      });
      if (n > 30) {
        if (this.startT == null) { this.startT = ts; this.frames = 1; }
        this.faceFrames++;
        this.t.push(ts);
        this.R.push(sr / n); this.G.push(sg / n); this.B.push(sb / n);
        this.bright.push(0.299 * (sr / n) + 0.587 * (sg / n) + 0.114 * (sb / n));
        this.centers.push({ x: geo.cx / geo.faceW, y: geo.cy / geo.faceW });
        this.headY.push(geo.cy);
        this.motion.push(this.chestShift(img, W, H, geo));
      }
    }
    this.draw();
    this.diag.proc(performance.now() - tProc);

    if (this.startT != null) {
      const elapsed = ts - this.startT;
      if (ts - this.lastHrCalc > 0.5 && elapsed > 4) {
        this.lastHrCalc = ts;
        this.updateLive();
      }
      if (elapsed >= this.seconds) {
        this.running = false;
        this.emit('analyzing');
        return;
      }
      this.emit('scanning');
    } else {
      this.emit('waiting-face');
    }
  }

  /** Vertical shift of the chest/shoulder band between frames (1-D Lucas–Kanade on row profiles), integrated. */
  private chestShift(img: Uint8ClampedArray, W: number, H: number, geo: ReturnType<typeof rois>): number {
    if (!this.chest) {
      const w = Math.min(W, geo.faceW * 2.4), h = Math.min(H * 0.35, geo.faceH * 0.7);
      const y = Math.min(H - h - 1, geo.cy + geo.faceH * 0.62);
      if (y < 0 || h < 8) return this.chestPos;
      this.chest = { x: Math.max(0, geo.cx - w / 2), y, w, h };
    }
    const c = this.chest;
    const rows = Math.floor(c.h);
    const prof = new Float64Array(rows);
    const x0 = Math.floor(c.x), x1 = Math.min(W - 1, Math.floor(c.x + c.w));
    for (let r = 0; r < rows; r++) {
      const y = Math.floor(c.y) + r;
      let s = 0;
      for (let x = x0; x <= x1; x += 2) {
        const k = (y * W + x) * 4;
        s += 0.299 * img[k] + 0.587 * img[k + 1] + 0.114 * img[k + 2];
      }
      prof[r] = s / Math.max(1, (x1 - x0) / 2);
    }
    const prev = this.prevProfile;
    this.prevProfile = prof;
    if (!prev) return this.chestPos;
    let num = 0, den = 0;
    for (let r = 1; r < rows - 1; r++) {
      const gy = (prev[r + 1] - prev[r - 1]) / 2;
      num += (prev[r] - prof[r]) * gy;
      den += gy * gy;
    }
    const d = den > 1e-6 ? clamp(num / den, -3, 3) : 0;
    this.chestPos += d;
    return this.chestPos;
  }

  private updateLive() {
    const n = this.t.length;
    const from = Math.max(0, n - FS * 12);
    const tt = this.t.slice(from);
    const [r, g, b] = resampleUniform(tt, [this.R.slice(from), this.G.slice(from), this.B.slice(from)]);
    const est = estimateHr(r, g, b);
    if (est.bpm) this.liveHr = this.liveHr ? this.liveHr * 0.6 + est.bpm * 0.4 : est.bpm;
    const w = est.bvp.slice(-FS * 6);
    let mx = 1e-9;
    for (const x of w) mx = Math.max(mx, Math.abs(x));
    this.wave = Array.from(w, (x) => x / mx);
    if (this.opts.debug) {
      const L = this.diag.live(30);
      const gw = g.slice(-FS * 10);
      const gm = gw.reduce((a, b) => a + b, 0) / Math.max(1, gw.length);
      const sp = est.bvp.length > FS * 4 ? spectrumPeak(est.bvp, FS, 0.7, 3.2, 0.02, 0.1) : null;
      this.lastDebug = {
        ...L, snr_db: sp ? sp.snrDb : null, hr: est.bpm,
        raw: Array.from(gw, (x) => x - gm), bvp: this.wave,
        spec: sp ? { f: sp.f, p: sp.p, peak: sp.freq } : { f: [], p: [], peak: null },
      };
    }
  }

  private draw() {
    const cv = this.overlay;
    const ctx = cv.getContext('2d');
    const v = this.video;
    if (!ctx || !v.videoWidth) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(cv.clientWidth * dpr), ch = Math.round(cv.clientHeight * dpr);
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    // cover-fit the video frame, mirrored like a selfie
    const s = Math.max(cw / v.videoWidth, ch / v.videoHeight);
    const dw = v.videoWidth * s, dh = v.videoHeight * s;
    const ox = (cw - dw) / 2, oy = (ch - dh) / 2;
    ctx.save();
    ctx.translate(cw, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(v, ox, oy, dw, dh);
    const lm = this.lastLandmarks;
    if (lm) {
      ctx.fillStyle = 'rgba(160, 255, 210, 0.35)';
      for (let i = 0; i < lm.length; i += 3) {
        ctx.fillRect(ox + lm[i].x * dw - 1, oy + lm[i].y * dh - 1, 2 * dpr, 2 * dpr);
      }
      // ROIs glow at the estimated heart rate (a rhythm display driven by the live estimate, not beat-by-beat detection).
      this.pulse = this.liveHr ? Math.max(0, Math.cos((2 * Math.PI * this.liveHr * performance.now()) / 60000)) ** 3 : 0;
      const k = dw / this.proc.width;
      for (const roi of this.lastRois) {
        ctx.beginPath();
        if (roi.kind === 'rect') ctx.roundRect(ox + (roi.cx - roi.w / 2) * k, oy + (roi.cy - roi.h / 2) * k, roi.w * k, roi.h * k, 8 * dpr);
        else ctx.ellipse(ox + roi.cx * k, oy + roi.cy * k, (roi.w / 2) * k, (roi.h / 2) * k, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 70, 90, ${0.08 + 0.32 * this.pulse})`;
        ctx.fill();
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = 'rgba(60, 240, 138, 0.9)';
        ctx.stroke();
      }
      if (this.chest) {
        const c = this.chest;
        ctx.setLineDash([6 * dpr, 6 * dpr]);
        ctx.strokeStyle = 'rgba(255, 212, 71, 0.75)';
        ctx.strokeRect(ox + c.x * k, oy + c.y * k, c.w * k, c.h * k);
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  /** Full analysis over the whole scan. */
  result(): VitalsResult {
    const n = this.t.length;
    const scanSeconds = n > 1 ? this.t[n - 1] - this.t[0] : 0;
    const faceFraction = this.frames ? this.faceFrames / this.frames : 0;
    const fps = scanSeconds > 0 ? (n - 1) / scanSeconds : 0;
    const empty: VitalsResult = {
      hr_bpm: null, hr_confidence: 0, hr_snr_db: -99, rr_bpm: null, rr_confidence: 0, hrv_rmssd_ms: null, hrv_sdnn_ms: null,
      stress_index: null, stress_level: null, quality: 'poor', scan_seconds: scanSeconds, fps, face_fraction: faceFraction, bvp_preview: [],
    };
    if (n < FS * 8) {
      return {
        ...empty, quality_reasons: ['face_lost', ...environmentReasons(this.diag.summary())],
        diagnostics: {
          engine: 'baseline-v1', mode: 'face', device: deviceInfo(this.stream?.getVideoTracks()[0] ?? null, this.video, landmarkerDelegate),
          ...this.diag.summary(), quality_decision: 'poor', note: 'fewer than 8 s of face frames',
        },
      };
    }
    const [r, g, b, mo, hy] = resampleUniform(this.t, [this.R, this.G, this.B, this.motion, this.headY]);
    const hr = estimateHr(r, g, b);
    const stab = hrStability(r, g, b);
    const snrScore = clamp((hr.snrDb + 4) / 10, 0, 1);
    const stabScore = clamp(1 - (stab - 2) / 10, 0, 1);
    const hrConf = clamp(0.6 * snrScore + 0.4 * stabScore, 0, 1) * clamp(faceFraction / 0.9, 0, 1);

    // Respiration: chest band motion vs head bob — keep whichever has the clearer peak.
    const c1 = estimateRr(mo), c2 = estimateRr(hy);
    const rr = c1.snrDb >= c2.snrDb ? c1 : c2;
    const rrConf = clamp((rr.snrDb + 2) / 12, 0, 1) * clamp(scanSeconds / 25, 0, 1);

    // HRV only when the pulse wave is clean enough; synthetic tests showed noise inflates RMSSD.
    let rmssd: number | null = null, sdnn: number | null = null;
    if (hr.bpm && hr.snrDb >= 10) {
      const v = hrv(findPeaks(hr.beatWave, FS, hr.bpm / 60));
      rmssd = v.rmssd; sdnn = v.sdnn;
    }
    const stress = stressFromRmssd(rmssd);
    const quality: VitalsResult['quality'] = hrConf >= 0.6 && faceFraction >= 0.85 ? 'good' : hrConf >= 0.35 && faceFraction >= 0.6 ? 'fair' : 'poor';
    const sum = this.diag.summary();
    const algo: string[] = [];
    if (faceFraction < 0.6) algo.push('face_lost');
    if (snrScore < 0.4) algo.push('low_snr');
    if (stabScore < 0.4) algo.push('unstable_hr');
    const reasons = [...environmentReasons(sum), ...algo];
    const prev = hr.bvp.slice(-200);
    let mx = 1e-9;
    for (const x of prev) mx = Math.max(mx, Math.abs(x));
    const round1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
    return {
      hr_bpm: round1(hr.bpm), hr_confidence: round1(hrConf * 100)! / 100, hr_snr_db: round1(hr.snrDb)!,
      rr_bpm: round1(rr.rpm), rr_confidence: Math.round(rrConf * 100) / 100,
      hrv_rmssd_ms: round1(rmssd), hrv_sdnn_ms: round1(sdnn), stress_index: stress, stress_level: stressLevel(stress),
      quality, scan_seconds: Math.round(scanSeconds * 10) / 10, fps: Math.round(fps * 10) / 10,
      face_fraction: Math.round(faceFraction * 100) / 100,
      bvp_preview: Array.from(prev, (x) => Math.round((x / mx) * 1000) / 1000),
      quality_reasons: reasons,
      diagnostics: {
        engine: 'baseline-v1', mode: 'face',
        device: deviceInfo(this.stream?.getVideoTracks()[0] ?? null, this.video, landmarkerDelegate),
        ...sum,
        hr_snr_db: round1(hr.snrDb), hr_stability_sd_bpm: round1(stab), snr_score: Math.round(snrScore * 100) / 100,
        stability_score: Math.round(stabScore * 100) / 100, face_fraction: Math.round(faceFraction * 100) / 100,
        hr_confidence: Math.round(hrConf * 100) / 100, rr_snr_db: round1(rr.snrDb), rr_chest_snr_db: round1(c1.snrDb), rr_head_snr_db: round1(c2.snrDb),
        final_hr_bpm: round1(hr.bpm), quality_decision: quality, quality_reasons: reasons,
        rule: 'good: conf>=0.6 & face>=0.85; fair: conf>=0.35 & face>=0.6; conf=(0.6*snrScore+0.4*stabScore)*min(1,face/0.9)',
      },
    };
  }
}



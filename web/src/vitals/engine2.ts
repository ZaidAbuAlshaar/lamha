// Hardened capture + analysis engine. Every behaviour is gated by a flag in ../config.ts; with flags=all-off the
// app uses the original VitalsEngine instead (engine.ts), so before/after comparisons stay honest.
import type { FaceLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { Flags } from '../config';
import { FS, bandpass, clamp, estimateHr, estimateRr, mean, median, resampleUniform, spectrumPeak, stressFromRmssd, stressLevel } from './dsp';
import { analyze, bestSegment, qualityComponents, qualityLevel, qualityReasons, qualityScore, type Algo } from './dsp2';
import { ScanDiag, deviceInfo } from './diag';
import { bgLuma, landmarkerDelegate, loadLandmarker, type DebugInfo, type LiveUpdate, type VitalsResult } from './engine';

export type GateCode = 'no-face' | 'far' | 'backlit' | 'dark' | 'overexposed' | 'move' | 'pose' | 'no_finger';

export interface HardLiveUpdate extends LiveUpdate {
  gate?: { code: GateCode | null; checks: Record<string, boolean>; passFor: number; stuck: boolean; lowFps: boolean };
  extending?: boolean;
  target?: number;
  mode?: 'face' | 'finger';
}

const IDX = {
  forehead: [109, 10, 338, 297, 67, 103, 332, 108, 151, 337, 69, 299],
  browTop: [105, 334, 107, 336, 66, 296],
  cheekL: [116, 117, 118, 119, 100, 126, 142, 203, 206, 205, 50, 187, 123, 147],
  cheekR: [345, 346, 347, 348, 329, 355, 371, 423, 426, 425, 280, 411, 352, 376],
  stable: [1, 4, 10, 152, 234, 454, 33, 263],
  left: 234, right: 454, top: 10, chin: 152, nose: 1,
};

type Pt = { x: number; y: number };

function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Pt[] = [], up: Pt[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

function shrink(poly: Pt[], k: number): Pt[] {
  const c = { x: mean(poly.map((p) => p.x)), y: mean(poly.map((p) => p.y)) };
  return poly.map((p) => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }));
}

function inConvex(poly: Pt[], x: number, y: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false;
  }
  return true;
}

interface RoiSum { r: number; g: number; b: number; n: number; total: number; clipped: number }

function sumPoly(img: Uint8ClampedArray, W: number, H: number, poly: Pt[], skin: boolean, yMax = Infinity): RoiSum {
  const s: RoiSum = { r: 0, g: 0, b: 0, n: 0, total: 0, clipped: 0 };
  if (poly.length < 3) return s;
  const x0 = Math.max(0, Math.floor(Math.min(...poly.map((p) => p.x)))), x1 = Math.min(W - 1, Math.ceil(Math.max(...poly.map((p) => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...poly.map((p) => p.y)))), y1 = Math.min(H - 1, Math.ceil(Math.min(yMax, Math.max(...poly.map((p) => p.y)))));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inConvex(poly, x + 0.5, y + 0.5)) continue;
      const k = (y * W + x) * 4;
      const r = img[k], g = img[k + 1], b = img[k + 2];
      s.total++;
      if (r >= 245 || g >= 245 || b >= 245 || (r <= 10 && g <= 10 && b <= 10)) { s.clipped++; continue; }
      if (skin) {
        const Y = 0.299 * r + 0.587 * g + 0.114 * b;
        const cr = (r - Y) * 0.713 + 128, cb = (b - Y) * 0.564 + 128;
        if (cr < 133 || cr > 173 || cb < 77 || cb > 127) continue; // hair, brows, glasses, beard
      }
      s.r += r; s.g += g; s.b += b; s.n++;
    }
  }
  return s;
}

function rectPoly(cx: number, cy: number, w: number, h: number): Pt[] {
  return [{ x: cx - w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy + h / 2 }, { x: cx - w / 2, y: cy + h / 2 }];
}

function circlePoly(cx: number, cy: number, r: number): Pt[] {
  return Array.from({ length: 12 }, (_, i) => ({ x: cx + r * Math.cos((i / 12) * 2 * Math.PI), y: cy + r * Math.sin((i / 12) * 2 * Math.PI) }));
}

export class HardenedEngine {
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private landmarker: FaceLandmarker | null = null;
  private proc = document.createElement('canvas');
  private pctx = this.proc.getContext('2d', { willReadFrequently: true })!;
  private running = false;
  private stopped = false;
  private raf = 0;
  private lastVideoTime = -1;
  private camStart = 0;
  private locks: Record<string, string> = {};
  private locked = false;
  // gate
  private gateStart = 0;
  private passSince: number | null = null;
  private forced = false;
  private lastGate: HardLiveUpdate['gate'];
  // scan
  private startT: number | null = null;
  private extending = false;
  private nextCheck = 0;
  private target: number;
  private t: number[] = [];
  private rois: { name: string; R: number[]; G: number[]; B: number[] }[] = [];
  private bgR: number[] = []; private bgG: number[] = []; private bgB: number[] = [];
  private valid: number[] = [];
  private headY: number[] = [];
  private chestMv: number[] = [];
  private chest: { x: number; y: number; w: number; h: number } | null = null;
  private prevProfile: Float64Array | null = null;
  private chestPos = 0;
  private prevStable: Pt[] | null = null;
  private prevTs = 0;
  private lastFaceT = 0;
  // live
  readonly diag = new ScanDiag();
  private liveHr: number | null = null;
  private wave: number[] = [];
  private lastLive = 0;
  private lastEmit = 0;
  private lastDebug: DebugInfo | undefined;
  private polys: Pt[][] = [];
  private lastLm: NormalizedLandmark[] | null = null;
  private gateTimes: number[] = [];
  private fingerOkHist: boolean[] = [];

  constructor(
    private video: HTMLVideoElement,
    private overlay: HTMLCanvasElement,
    private seconds: number,
    private onUpdate: (u: HardLiveUpdate) => void,
    private opts: { flags: Flags; debug?: boolean; mode?: 'face' | 'finger'; maxSeconds?: number },
  ) {
    this.target = seconds;
  }

  private get mode() { return this.opts.mode ?? 'face'; }
  private get f() { return this.opts.flags; }

  async start() {
    this.emit('loading');
    try {
      const finger = this.mode === 'finger';
      const [stream, lm] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: finger ? { ideal: 'environment' } : 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
          audio: false,
        }),
        finger ? Promise.resolve(null) : loadLandmarker(),
      ]);
      if (this.stopped) { stream.getTracks().forEach((tr) => tr.stop()); return; }
      this.stream = stream;
      this.track = stream.getVideoTracks()[0] ?? null;
      this.landmarker = lm;
      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      try { await this.video.play(); } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) throw e; }
      if (this.stopped) return;
      if (finger) await this.torch(true);
      this.camStart = performance.now();
      this.gateStart = this.camStart;
      this.running = true;
      this.schedule();
    } catch (e) {
      if (this.stopped) return;
      this.emit('error', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      throw e;
    }
  }

  stop() {
    this.stopped = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.torch(false).catch(() => undefined);
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
  }

  /** Skip the pre-scan gate (offered to the user after 15 s of failing checks). */
  forceStart() { this.forced = true; }

  private async torch(on: boolean) {
    try {
      const caps = (this.track as unknown as { getCapabilities?: () => Record<string, unknown> })?.getCapabilities?.() ?? {};
      if (caps.torch) {
        await this.track!.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
        this.locks.torch = on ? 'on' : 'off';
      } else this.locks.torch = 'unsupported';
    } catch (e) { this.locks.torch = `failed:${(e as Error).name}`; }
  }

  /** After the 2 s auto-adjust, freeze exposure / white balance / focus where the browser allows it (mostly Android Chrome). */
  private async lockCamera() {
    this.locked = true;
    if (!this.f.lockCamera || !this.track) { this.locks.status = 'off'; return; }
    const caps = ((this.track as unknown as { getCapabilities?: () => Record<string, unknown> }).getCapabilities?.() ?? {}) as Record<string, unknown>;
    const settings = this.track.getSettings() as Record<string, unknown>;
    for (const [mode, valueKey] of [['exposureMode', 'exposureTime'], ['whiteBalanceMode', 'colorTemperature'], ['focusMode', 'focusDistance']] as const) {
      const list = caps[mode] as string[] | undefined;
      if (!list?.includes('manual')) { this.locks[mode] = 'unsupported'; continue; }
      const c: Record<string, unknown> = { [mode]: 'manual' };
      if (settings[valueKey] != null) c[valueKey] = settings[valueKey];
      try { await this.track.applyConstraints({ advanced: [c as MediaTrackConstraintSet] }); this.locks[mode] = 'locked'; }
      catch (e) { this.locks[mode] = `failed:${(e as Error).name}`; }
    }
  }

  private schedule() {
    if (!this.running) return;
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { captureTime?: number; expectedDisplayTime?: number }) => void) => number };
    if (this.f.frameCallback && v.requestVideoFrameCallback) {
      v.requestVideoFrameCallback((now, meta) => {
        if (!this.running) return;
        this.frame(meta.captureTime ?? meta.expectedDisplayTime ?? now);
        this.schedule();
      });
    } else {
      this.raf = requestAnimationFrame(() => {
        if (!this.running) return;
        if (this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = this.video.currentTime;
          this.frame(performance.now());
        }
        this.schedule();
      });
    }
  }

  private frame(tsMs: number) {
    const v = this.video;
    if (!v.videoWidth) return;
    const t0 = performance.now();
    this.diag.frame(tsMs);
    if (!this.locked && t0 - this.camStart > 2000) this.lockCamera();
    const W = 320, H = Math.round((320 * v.videoHeight) / v.videoWidth);
    if (this.proc.width !== W) { this.proc.width = W; this.proc.height = H; }
    this.pctx.drawImage(v, 0, 0, W, H);
    const img = this.pctx.getImageData(0, 0, W, H).data;
    const ts = tsMs / 1000;
    if (this.mode === 'finger') this.fingerFrame(img, W, H, ts);
    else this.faceFrame(img, W, H, ts);
    this.draw();
    this.diag.proc(performance.now() - t0);
    this.advance(ts);
  }

  private faceFrame(img: Uint8ClampedArray, W: number, H: number, ts: number) {
    const res = this.landmarker!.detectForVideo(this.video, performance.now());
    const lm = res.faceLandmarks?.[0];
    this.lastLm = lm ?? null;
    if (!lm) { this.polys = []; this.diag.framesNoFace++; return; }
    this.lastFaceT = performance.now();
    const P = (i: number): Pt => ({ x: lm[i].x * W, y: lm[i].y * H });
    const L = P(IDX.left), R = P(IDX.right), T = P(IDX.top), C = P(IDX.chin);
    const faceW = Math.hypot(R.x - L.x, R.y - L.y), faceH = Math.hypot(C.x - T.x, C.y - T.y);
    const cx = (L.x + R.x) / 2, cy = (T.y + C.y) / 2;
    // ROIs
    let polys: Pt[][];
    let browY = Infinity;
    if (this.f.polygonRoi) {
      browY = Math.min(...IDX.browTop.map((i) => P(i).y)) - faceH * 0.02;
      polys = [shrink(hull(IDX.forehead.map(P)), 0.85), shrink(hull(IDX.cheekL.map(P)), 0.85), shrink(hull(IDX.cheekR.map(P)), 0.85)];
    } else {
      const G = P(9);
      polys = [rectPoly((T.x + G.x) / 2, T.y + (G.y - T.y) * 0.55, faceW * 0.42, faceH * 0.14), circlePoly(P(50).x, P(50).y, faceW * 0.08), circlePoly(P(280).x, P(280).y, faceW * 0.08)];
    }
    this.polys = polys;
    const sums = polys.map((poly, i) => sumPoly(img, W, H, poly, this.f.skinMask, i === 0 ? browY : Infinity));
    const n = sums.reduce((a, s) => a + s.n, 0), total = sums.reduce((a, s) => a + s.total, 0), clipped = sums.reduce((a, s) => a + s.clipped, 0);
    const br = n ? sums.reduce((a, s) => a + 0.299 * s.r + 0.587 * s.g + 0.114 * s.b, 0) / n : 0;
    // pose: facial transformation matrix when available, else landmark ratios
    let yaw: number | null = null, pitch: number | null = null;
    const m = (res as unknown as { facialTransformationMatrixes?: { data: number[] }[] }).facialTransformationMatrixes?.[0]?.data;
    if (m && m.length >= 11) {
      yaw = (Math.asin(clamp(-m[2], -1, 1)) * 180) / Math.PI;
      pitch = (Math.atan2(m[6], m[10]) * 180) / Math.PI;
    } else {
      const nose = P(IDX.nose);
      yaw = ((nose.x - L.x) / Math.max(1e-6, R.x - L.x) - 0.5) * 110;
      pitch = ((nose.y - T.y) / Math.max(1e-6, C.y - T.y) - 0.6) * 110;
    }
    // motion of stable landmarks (face widths per second)
    const stable = IDX.stable.map(P);
    const dt = this.prevTs ? Math.max(1e-3, ts - this.prevTs) : 1 / 30;
    const disp = this.prevStable ? mean(stable.map((p, i) => Math.hypot(p.x - this.prevStable![i].x, p.y - this.prevStable![i].y))) / Math.max(1, faceW) : 0;
    this.prevStable = stable; this.prevTs = ts;
    const rate = disp / dt;
    const poseOk = Math.abs(yaw) <= 20 && Math.abs(pitch) <= 25;
    const frameValid = n > 60 && (!this.f.headPose || (poseOk && rate <= 0.25));
    const bg = bgLuma(img, W, H, { faceW, faceH, cx, cy });
    this.diag.add({
      brightness: br, clippedPct: total ? (100 * clipped) / total : 0, darkPct: 0, faceWidthPct: (100 * faceW) / W,
      motion: disp, yawDeg: yaw, pitchDeg: pitch, bgBrightness: bg, valid: frameValid,
    });
    if (this.startT == null) {
      this.gateCheck(ts, { faceW: (100 * faceW) / W, br, bg, clippedPct: total ? (100 * clipped) / total : 0, rate, poseOk });
      return;
    }
    // record sample
    this.t.push(ts);
    if (!this.rois.length) this.rois = ['forehead', 'cheekL', 'cheekR'].map((name) => ({ name, R: [], G: [], B: [] }));
    sums.forEach((s, i) => {
      const k = s.n || 1;
      const prev = this.rois[i].R.length ? i : -1;
      // an empty ROI repeats its previous value (and the frame is marked invalid) instead of injecting a zero
      this.rois[i].R.push(s.n ? s.r / k : prev >= 0 ? this.rois[i].R[this.rois[i].R.length - 1] : 0);
      this.rois[i].G.push(s.n ? s.g / k : prev >= 0 ? this.rois[i].G[this.rois[i].G.length - 1] : 0);
      this.rois[i].B.push(s.n ? s.b / k : prev >= 0 ? this.rois[i].B[this.rois[i].B.length - 1] : 0);
    });
    const bgc = this.bgRgb(img, W, H, cx, cy, faceW, faceH);
    this.bgR.push(bgc[0]); this.bgG.push(bgc[1]); this.bgB.push(bgc[2]);
    this.valid.push(frameValid ? 1 : 0);
    this.headY.push(cy);
    this.chestMv.push(this.chestShift(img, W, H, cx, cy, faceW, faceH));
  }

  private fingerFrame(img: Uint8ClampedArray, W: number, H: number, ts: number) {
    const x0 = Math.floor(W * 0.2), x1 = Math.floor(W * 0.8), y0 = Math.floor(H * 0.2), y1 = Math.floor(H * 0.8);
    let r = 0, g = 0, b = 0, n = 0, clipped = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const k = (y * W + x) * 4;
      if (img[k] >= 252) clipped++;
      r += img[k]; g += img[k + 1]; b += img[k + 2]; n++;
    }
    r /= n; g /= n; b /= n;
    const ok = r > 80 && r > 1.3 * g && r > 1.3 * b; // a lit fingertip is red-dominant
    this.diag.add({ brightness: 0.299 * r + 0.587 * g + 0.114 * b, clippedPct: (100 * clipped) / n, darkPct: 0, faceWidthPct: 100, motion: 0, yawDeg: null, pitchDeg: null, bgBrightness: null, valid: ok });
    this.fingerOkHist.push(ok);
    if (this.fingerOkHist.length > 90) this.fingerOkHist.shift();
    if (this.startT == null) {
      this.gateCheck(ts, { finger: ok });
      return;
    }
    this.t.push(ts);
    if (!this.rois.length) this.rois = [{ name: 'finger', R: [], G: [], B: [] }];
    this.rois[0].R.push(r); this.rois[0].G.push(g); this.rois[0].B.push(b);
    this.valid.push(ok ? 1 : 0);
  }

  private bgRgb(img: Uint8ClampedArray, W: number, H: number, cx: number, cy: number, fw: number, fh: number): [number, number, number] {
    const y0 = Math.max(0, Math.floor(cy - fh * 0.45)), y1 = Math.min(H - 1, Math.floor(cy - fh * 0.15));
    let r = 0, g = 0, b = 0, n = 0;
    for (const side of [-1, 1]) {
      const xa = side < 0 ? Math.max(0, Math.floor(cx - fw * 1.25)) : Math.min(W - 1, Math.floor(cx + fw * 0.85));
      const xb = side < 0 ? Math.max(0, Math.floor(cx - fw * 0.85)) : Math.min(W - 1, Math.floor(cx + fw * 1.25));
      for (let y = y0; y <= y1; y += 2) for (let x = xa; x < xb; x += 2) { const k = (y * W + x) * 4; r += img[k]; g += img[k + 1]; b += img[k + 2]; n++; }
    }
    return n ? [r / n, g / n, b / n] : [0, 0, 0];
  }

  private chestShift(img: Uint8ClampedArray, W: number, H: number, cx: number, cy: number, fw: number, fh: number): number {
    if (!this.chest) {
      const w = Math.min(W, fw * 2.4), h = Math.min(H * 0.35, fh * 0.7);
      const y = Math.min(H - h - 1, cy + fh * 0.62);
      if (y < 0 || h < 8) return this.chestPos;
      this.chest = { x: Math.max(0, cx - w / 2), y, w, h };
    }
    const c = this.chest, rows = Math.floor(c.h);
    const prof = new Float64Array(rows);
    const x0 = Math.floor(c.x), x1 = Math.min(W - 1, Math.floor(c.x + c.w));
    for (let r = 0; r < rows; r++) {
      const y = Math.floor(c.y) + r;
      let s = 0;
      for (let x = x0; x <= x1; x += 2) { const k = (y * W + x) * 4; s += 0.299 * img[k] + 0.587 * img[k + 1] + 0.114 * img[k + 2]; }
      prof[r] = s / Math.max(1, (x1 - x0) / 2);
    }
    const prev = this.prevProfile;
    this.prevProfile = prof;
    if (!prev) return this.chestPos;
    let num = 0, den = 0;
    for (let r = 1; r < rows - 1; r++) { const gy = (prev[r + 1] - prev[r - 1]) / 2; num += (prev[r] - prof[r]) * gy; den += gy * gy; }
    this.chestPos += den > 1e-6 ? clamp(num / den, -3, 3) : 0;
    return this.chestPos;
  }

  /** Pre-scan gate: one message at a time; the countdown starts after all checks pass for 2 s (and ≥ 3 s total). */
  private gateCheck(ts: number, m: { faceW?: number; br?: number; bg?: number | null; clippedPct?: number; rate?: number; poseOk?: boolean; finger?: boolean }) {
    const now = performance.now();
    this.gateTimes.push(now);
    const live = this.diag.live(30);
    const lowFps = live.fps > 0 && live.fps < 15;
    let checks: Record<string, boolean>;
    let code: GateCode | null = null;
    if (this.mode === 'finger') {
      const okRecent = this.fingerOkHist.slice(-20).every(Boolean);
      checks = { finger: okRecent };
      if (!okRecent) code = 'no_finger';
    } else {
      const backlit = m.bg != null && m.br! > 0 && m.bg / m.br! > 1.6;
      checks = {
        close: (live.face_width_pct ?? 0) >= 35,
        light: (live.brightness ?? 0) >= 70 && !backlit,
        exposure: (live.clipped_pct ?? 0) <= 5,
        still: (live.motion ?? 0) <= 0.01 && (m.rate ?? 0) <= 0.3,
        frontal: !!m.poseOk,
      };
      if (!checks.close) code = 'far';
      else if (!checks.light) code = backlit ? 'backlit' : 'dark';
      else if (!checks.exposure) code = 'overexposed';
      else if (!checks.still) code = 'move';
      else if (!checks.frontal) code = 'pose';
    }
    const pass = code == null;
    if (pass) this.passSince ??= now; else this.passSince = null;
    const passFor = this.passSince ? (now - this.passSince) / 1000 : 0;
    const stuck = now - this.gateStart > 15000;
    this.lastGate = { code, checks, passFor, stuck, lowFps };
    const gateOn = this.f.preScanGate;
    const ready = !gateOn || this.forced || (pass && passFor >= 2 && now - this.gateStart >= 3000);
    if (ready) this.startT = ts;
  }

  private advance(ts: number) {
    const now = performance.now();
    if (this.startT == null) {
      if (now - this.lastEmit > 90) { this.lastEmit = now; this.emit('waiting-face'); }
      return;
    }
    const elapsed = ts - this.startT;
    if (now - this.lastLive > 500 && elapsed > 4) { this.lastLive = now; this.updateLive(); }
    if (elapsed >= this.target) {
      const maxS = this.opts.maxSeconds ?? 45;
      if (this.f.adaptiveExtend && now > this.nextCheck && this.target < maxS) {
        this.nextCheck = now + 2500;
        const q = this.quickQuality();
        if (q !== 'good') {
          this.extending = true;
          this.target = Math.min(maxS, elapsed + 3);
          this.emit('scanning');
          return;
        }
      }
      if (elapsed >= this.target) {
        this.running = false;
        this.emit('analyzing');
        return;
      }
    }
    if (now - this.lastEmit > 90) { this.lastEmit = now; this.emit('scanning'); }
  }

  private quickQuality(): 'good' | 'fair' | 'poor' {
    try { return this.compute(false).quality; } catch { return 'poor'; }
  }

  private emit(phase: LiveUpdate['phase'], error?: string) {
    const elapsed = this.startT == null ? 0 : (this.t[this.t.length - 1] ?? this.startT) - this.startT;
    const fresh = this.mode === 'finger' || performance.now() - this.lastFaceT < 600;
    const live = this.diag.live(30);
    let guidance: LiveUpdate['guidance'] = 'ok';
    if (!fresh) guidance = 'no-face';
    else if ((live.brightness ?? 255) < 55) guidance = 'dark';
    else if ((live.motion ?? 0) > 0.02) guidance = 'move';
    this.onUpdate({
      phase, elapsed, progress: clamp(elapsed / this.target, 0, 1), guidance, liveHr: this.liveHr, wave: this.wave,
      fps: live.fps, error, debug: this.lastDebug, gate: this.startT == null ? this.lastGate : undefined,
      extending: this.extending, target: this.target, mode: this.mode,
    });
  }

  private meanTrace(from: number) {
    const k = this.rois.length || 1;
    const avg = (ch: 'R' | 'G' | 'B') => this.t.slice(from).map((_, j) => this.rois.reduce((a, r) => a + r[ch][from + j], 0) / k);
    return resampleUniform(this.t.slice(from), [avg('R'), avg('G'), avg('B')]);
  }

  private updateLive() {
    const from = Math.max(0, this.t.length - FS * 12);
    const [r, g, b] = this.meanTrace(from);
    const est = this.mode === 'finger' ? estimateHrFinger(r, g) : estimateHr(r, g, b);
    if (est.bpm) this.liveHr = this.liveHr ? this.liveHr * 0.6 + est.bpm * 0.4 : est.bpm;
    const w = est.bvp.slice(-FS * 6);
    let mx = 1e-9;
    for (const x of w) mx = Math.max(mx, Math.abs(x));
    this.wave = Array.from(w, (x) => x / mx);
    if (this.opts.debug) {
      const L = this.diag.live(30);
      const gw = g.slice(-FS * 10);
      const gm = mean(gw);
      const sp = est.bvp.length > FS * 4 ? spectrumPeak(est.bvp, FS, 0.7, 3.0, 0.02, 0.1) : null;
      this.lastDebug = {
        ...L, snr_db: sp ? sp.snrDb : null, hr: est.bpm, raw: Array.from(gw, (x) => x - gm), bvp: this.wave,
        spec: sp ? { f: sp.f, p: sp.p, peak: sp.freq } : { f: [], p: [], peak: null }, gate: this.lastGate?.checks,
      };
    }
  }

  private draw() {
    const cv = this.overlay;
    const ctx = cv.getContext('2d');
    const v = this.video;
    if (!ctx || !v.videoWidth) return;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const cw = Math.round(cv.clientWidth * dpr), ch = Math.round(cv.clientHeight * dpr);
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    const s = Math.max(cw / v.videoWidth, ch / v.videoHeight);
    const dw = v.videoWidth * s, dh = v.videoHeight * s, ox = (cw - dw) / 2, oy = (ch - dh) / 2;
    ctx.save();
    if (this.mode === 'face') { ctx.translate(cw, 0); ctx.scale(-1, 1); }
    ctx.drawImage(v, ox, oy, dw, dh);
    const k = dw / this.proc.width;
    const pulse = this.liveHr ? Math.max(0, Math.cos((2 * Math.PI * this.liveHr * performance.now()) / 60000)) ** 3 : 0;
    for (const poly of this.polys) {
      ctx.beginPath();
      poly.forEach((p, i) => (i ? ctx.lineTo(ox + p.x * k, oy + p.y * k) : ctx.moveTo(ox + p.x * k, oy + p.y * k)));
      ctx.closePath();
      ctx.fillStyle = `rgba(180, 45, 37, ${0.08 + 0.3 * pulse})`;
      ctx.fill();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Full analysis; `final` also picks the best 20 s segment when the scan was extended. */
  private compute(final: boolean) {
    const n = this.t.length;
    const flags = this.f;
    const fs = FS;
    const algos: Algo[] = this.mode === 'finger' ? ['RED', 'GREEN'] : flags.multiAlgo ? ['POS', 'CHROM', 'GREEN'] : ['POS'];
    const traces = this.rois.flatMap((r) => [r.R, r.G, r.B]);
    const res = resampleUniform(this.t, [...traces, this.bgR, this.bgG, this.bgB, this.valid, this.headY, this.chestMv].filter((x) => x.length === n));
    const rois = this.rois.map((r, i) => ({ name: r.name, r: res[3 * i], g: res[3 * i + 1], b: res[3 * i + 2] }));
    const base = 3 * this.rois.length;
    const hasBg = this.mode === 'face' && this.bgR.length === n;
    const bg = hasBg ? { r: res[base], g: res[base + 1], b: res[base + 2] } : null;
    const off = base + (hasBg ? 3 : 0);
    const valid = res[off];
    const headY = this.mode === 'face' ? res[off + 1] : undefined;
    const chestMv = this.mode === 'face' ? res[off + 2] : undefined;
    let seg: [number, number] = [0, valid.length];
    let a = analyze({ fs, rois, bg, valid, algos, bgSubtract: flags.bgSubtract && !!bg });
    if (final && this.extending) {
      seg = bestSegment(a.windows, valid.length, fs, 20);
      const cut = (x: Float64Array) => x.subarray(seg[0], seg[1]);
      a = analyze({ fs, rois: rois.map((r) => ({ name: r.name, r: cut(r.r), g: cut(r.g), b: cut(r.b) })), bg: bg ? { r: cut(bg.r), g: cut(bg.g), b: cut(bg.b) } : null, valid: cut(valid), algos, bgSubtract: flags.bgSubtract && !!bg });
    }
    const sum = this.diag.summary();
    const invalidPct = valid.length ? 100 * (1 - Array.from(valid).filter((x) => x >= 0.5).length / valid.length) : 100;
    const comp = qualityComponents({
      snrDb: a.snrDb, algoSpreadBpm: a.algoSpreadBpm, goodWindowFrac: a.goodWindowFrac, invalidPct,
      fps: sum.fps_mean ?? 0, jitterMs: sum.frame_jitter_ms ?? 0, brightness: sum.brightness_mean ?? 0,
      clippedPct: sum.clipped_pct_mean ?? 0, faceWidthPct: this.mode === 'finger' ? null : sum.face_width_pct_mean,
    });
    const score = qualityScore(comp);
    const quality = qualityLevel(score, comp, a.consistency);
    const reasons = qualityReasons(comp, { brightness: sum.brightness_mean ?? 0, backlightRatio: sum.backlight_ratio });
    if (a.consistency < 0.6 && !reasons.includes('unstable_hr')) reasons.push('unstable_hr');
    let rr: { rpm: number | null; snrDb: number } = { rpm: null, snrDb: -99 };
    if (headY && chestMv) {
      const c1 = estimateRr(chestMv.subarray(seg[0], seg[1])), c2 = estimateRr(headY.subarray(seg[0], seg[1]));
      rr = c1.snrDb >= c2.snrDb ? c1 : c2;
    }
    return { a, comp, score, quality, reasons, rr, seg, sum, invalidPct, algos };
  }

  result(): VitalsResult {
    const n = this.t.length;
    const scanSeconds = n > 1 ? this.t[n - 1] - this.t[0] : 0;
    const sum0 = this.diag.summary();
    const dev = deviceInfo(this.track, this.video, this.mode === 'finger' ? 'none' : landmarkerDelegate);
    const baseDiag = { engine: 'hardened-v2', mode: this.mode, device: dev, camera_locks: { ...this.locks }, ...sum0 };
    if (n < FS * 10) {
      return {
        hr_bpm: null, hr_confidence: 0, hr_snr_db: -99, rr_bpm: null, rr_confidence: 0, hrv_rmssd_ms: null, hrv_sdnn_ms: null,
        stress_index: null, stress_level: null, quality: 'poor', scan_seconds: scanSeconds, fps: sum0.fps_mean ?? 0,
        face_fraction: 0, bvp_preview: [], quality_score: 0, quality_reasons: [this.mode === 'finger' ? 'no_finger' : 'face_lost'],
        diagnostics: { ...baseDiag, quality_decision: 'poor', note: 'fewer than 10 s of samples' },
      };
    }
    const { a, comp, score, quality, reasons, rr, seg, invalidPct, algos } = this.compute(true);
    const round1 = (x: number | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
    const stress = this.mode === 'face' ? stressFromRmssd(a.rmssd) : null;
    const prev = a.fusedBvp.slice(-200);
    let mx = 1e-9;
    for (const x of prev) mx = Math.max(mx, Math.abs(x));
    const faceFrac = this.diag.stats.length ? this.diag.stats.filter((s) => s.valid).length / this.diag.stats.length : 0;
    return {
      hr_bpm: round1(a.hr), hr_confidence: score, hr_snr_db: round1(a.snrDb) ?? -99,
      rr_bpm: round1(rr.rpm), rr_confidence: rr.rpm == null ? 0 : Math.round(clamp((rr.snrDb + 2) / 12, 0, 1) * clamp(scanSeconds / 25, 0, 1) * 100) / 100,
      hrv_rmssd_ms: this.mode === 'face' ? round1(a.rmssd) : null, hrv_sdnn_ms: this.mode === 'face' ? round1(a.sdnn) : null,
      stress_index: stress, stress_level: stressLevel(stress), quality,
      scan_seconds: Math.round(scanSeconds * 10) / 10, fps: sum0.fps_mean ?? 0, face_fraction: Math.round(faceFrac * 100) / 100,
      bvp_preview: Array.from(prev, (x) => Math.round((x / mx) * 1000) / 1000),
      quality_score: this.f.qualityScore ? score : undefined,
      quality_components: Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      quality_reasons: reasons,
      diagnostics: {
        ...baseDiag, algos: algos.join('+'), per_algo_hr: a.perAlgoHr, per_algo_snr_db: a.perAlgoSnr,
        algo_spread_bpm: round1(a.algoSpreadBpm), fused_snr_db: round1(a.snrDb), good_window_frac: round1(a.goodWindowFrac * 100)! / 100,
        windows: a.windows.length, peak_consistency: round1(a.consistency * 100)! / 100, invalid_frames_pct: round1(invalidPct), extended: this.extending,
        segment_s: [Math.round(seg[0] / FS), Math.round(seg[1] / FS)], quality_score: score, quality_components: comp,
        quality_decision: quality, quality_reasons: reasons, final_hr_bpm: round1(a.hr), rr_snr_db: round1(rr.snrDb),
        flags: Object.entries(this.f).filter(([, v]) => v).map(([k]) => k).join(','),
      },
    };
  }
}

/** Fingertip PPG: red + green intensity drops on each beat (blood absorbs light), so invert and band-pass. */
function estimateHrFinger(r: Float64Array, g: Float64Array) {
  const x = Float64Array.from(r, (v, i) => -(v + g[i]));
  const m = median(x);
  for (let i = 0; i < x.length; i++) x[i] -= m;
  const bvp = bandpass(x, 0.7, 3.0, FS);
  const pk = spectrumPeak(bvp, FS, 0.7, 3.0, 0.01, 0.1);
  return { bpm: bvp.length > FS * 5 ? pk.freq * 60 : null, snrDb: pk.snrDb, bvp };
}

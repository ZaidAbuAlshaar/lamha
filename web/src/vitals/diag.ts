// Numbers-only scan diagnostics: frame timing, light, clipping, face size, motion. No pixels are kept.
import { mean, median, std } from './dsp';

export interface FrameStats {
  brightness: number; // mean luma of the skin ROIs (0–255)
  clippedPct: number; // ROI pixels at/near saturation (%)
  darkPct: number; // ROI pixels too dark to use (%)
  faceWidthPct: number; // face width / frame width (%)
  motion: number; // face-centre displacement since last frame, in face widths
  yawDeg: number | null;
  pitchDeg: number | null;
  bgBrightness: number | null; // luma of a background patch (backlight check)
  valid: boolean;
}

const pct = (xs: number[], q: number) => {
  const a = xs.filter(Number.isFinite).sort((p, r) => p - r);
  return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : NaN;
};
const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r3 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

export class ScanDiag {
  frameTs: number[] = [];
  procMs: number[] = [];
  stats: FrameStats[] = [];
  framesSeen = 0;
  framesNoFace = 0;

  frame(tsMs: number) {
    this.framesSeen++;
    this.frameTs.push(tsMs);
    if (this.frameTs.length > 3000) this.frameTs.shift();
  }

  proc(ms: number) {
    this.procMs.push(ms);
    if (this.procMs.length > 3000) this.procMs.shift();
  }

  add(s: FrameStats) {
    this.stats.push(s);
    if (this.stats.length > 3000) this.stats.shift();
  }

  /** Frame-interval stats over the last `n` frames. */
  timing(n = 9999) {
    const ts = this.frameTs.slice(-n);
    const dts: number[] = [];
    for (let i = 1; i < ts.length; i++) dts.push(ts[i] - ts[i - 1]);
    const m = mean(dts);
    return {
      fps: dts.length ? 1000 / m : 0,
      interval_ms_mean: m,
      jitter_ms: std(dts),
      interval_ms_p95: pct(dts, 0.95),
      dropped_pct: dts.length ? (100 * dts.filter((d) => d > 1.8 * median(dts)).length) / dts.length : 0,
    };
  }

  live(n = 30) {
    const s = this.stats.slice(-n);
    const t = this.timing(n);
    return {
      fps: t.fps,
      jitter_ms: t.jitter_ms,
      brightness: mean(s.map((x) => x.brightness)),
      clipped_pct: mean(s.map((x) => x.clippedPct)),
      face_width_pct: mean(s.map((x) => x.faceWidthPct)),
      motion: mean(s.map((x) => x.motion)),
      yaw_deg: mean(s.map((x) => x.yawDeg ?? NaN).filter(Number.isFinite)),
      pitch_deg: mean(s.map((x) => x.pitchDeg ?? NaN).filter(Number.isFinite)),
      backlight_ratio: mean(s.map((x) => (x.bgBrightness != null && x.brightness > 0 ? x.bgBrightness / x.brightness : NaN)).filter(Number.isFinite)),
      proc_ms: mean(this.procMs.slice(-n)),
    };
  }

  summary() {
    const s = this.stats;
    const t = this.timing();
    const b = s.map((x) => x.brightness);
    const bl = s.map((x) => (x.bgBrightness != null && x.brightness > 0 ? x.bgBrightness / x.brightness : NaN)).filter(Number.isFinite);
    return {
      frames_seen: this.framesSeen,
      frames_with_face: s.length,
      fps_mean: r1(t.fps),
      frame_interval_ms_mean: r1(t.interval_ms_mean),
      frame_jitter_ms: r1(t.jitter_ms),
      frame_interval_ms_p95: r1(t.interval_ms_p95),
      dropped_frames_pct: r1(t.dropped_pct),
      proc_ms_median: r1(median(this.procMs)),
      proc_ms_p95: r1(pct(this.procMs, 0.95)),
      brightness_mean: r1(mean(b)),
      brightness_min: r1(Math.min(...b)),
      brightness_max: r1(Math.max(...b)),
      brightness_drift_pct: r1(b.length > 10 ? (100 * (mean(b.slice(-15)) - mean(b.slice(0, 15)))) / Math.max(1, mean(b.slice(0, 15))) : NaN),
      clipped_pct_mean: r1(mean(s.map((x) => x.clippedPct))),
      dark_pct_mean: r1(mean(s.map((x) => x.darkPct))),
      face_width_pct_mean: r1(mean(s.map((x) => x.faceWidthPct))),
      motion_median: r3(median(s.map((x) => x.motion))),
      motion_p90: r3(pct(s.map((x) => x.motion), 0.9)),
      yaw_deg_median: r1(median(s.map((x) => x.yawDeg ?? NaN))),
      pitch_deg_median: r1(median(s.map((x) => x.pitchDeg ?? NaN))),
      backlight_ratio: r1(median(bl)),
      invalid_frames_pct: r1(s.length ? (100 * s.filter((x) => !x.valid).length) / s.length : NaN),
    };
  }
}

/** Plain-language reasons from the numbers, most important first (codes are stable; text is in the UI). */
export function environmentReasons(sum: ReturnType<ScanDiag['summary']>): string[] {
  const r: string[] = [];
  if ((sum.face_width_pct_mean ?? 100) < 30) r.push('far');
  if ((sum.backlight_ratio ?? 0) > 1.6) r.push('backlit');
  if ((sum.brightness_mean ?? 255) < 70) r.push('dark');
  if ((sum.clipped_pct_mean ?? 0) > 8) r.push('overexposed');
  if ((sum.motion_p90 ?? 0) > 0.02 || (sum.invalid_frames_pct ?? 0) > 25) r.push('motion');
  if ((sum.fps_mean ?? 30) < 15) r.push('low_fps');
  if ((sum.frame_jitter_ms ?? 0) > 20) r.push('jitter');
  if (Math.abs(sum.brightness_drift_pct ?? 0) > 12) r.push('exposure_drift');
  return r;
}

export const REASON_AR: Record<string, string> = {
  far: 'الوجه بعيد عن الكاميرا — قرّب وجهك',
  backlit: 'الضو وراك مش قدّامك',
  dark: 'الإضاءة خفيفة',
  overexposed: 'الإضاءة قوية كثير على الوجه',
  motion: 'في حركة كثير — ثبّت الموبايل وراسك',
  low_fps: 'الكاميرا بطيئة على هالجهاز (فريمات قليلة)',
  jitter: 'توقيت الفريمات مش منتظم',
  exposure_drift: 'الكاميرا عم تغيّر الإضاءة لحالها',
  low_snr: 'إشارة النبض ضعيفة',
  unstable_hr: 'قراءة النبض مش ثابتة عبر الوقت',
  face_lost: 'الوجه غاب عن الكاميرا كثير',
  no_finger: 'الإصبع مش مغطّي الكاميرا والفلاش',
};

export function deviceInfo(track: MediaStreamTrack | null, video: HTMLVideoElement, delegate: string) {
  let settings: MediaTrackSettings = {};
  let caps: Record<string, unknown> = {};
  try { settings = track?.getSettings() ?? {}; } catch { /* unsupported */ }
  try {
    const c = ((track as unknown as { getCapabilities?: () => Record<string, unknown> })?.getCapabilities?.() ?? {}) as Record<string, unknown>;
    caps = Object.fromEntries(['exposureMode', 'whiteBalanceMode', 'focusMode', 'torch', 'frameRate', 'width', 'height'].filter((k) => k in c).map((k) => [k, c[k]]));
  } catch { /* unsupported */ }
  const s = settings as Record<string, unknown>;
  return {
    user_agent: navigator.userAgent.slice(0, 250),
    platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
    cores: navigator.hardwareConcurrency ?? null,
    video_resolution: `${video.videoWidth}x${video.videoHeight}`,
    track_frame_rate: s.frameRate ?? null,
    track_facing: s.facingMode ?? null,
    exposure_mode: s.exposureMode ?? null,
    white_balance_mode: s.whiteBalanceMode ?? null,
    focus_mode: s.focusMode ?? null,
    capabilities: JSON.stringify(caps).slice(0, 280),
    landmarker_delegate: delegate,
  };
}

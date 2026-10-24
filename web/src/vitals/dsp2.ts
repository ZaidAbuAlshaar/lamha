// Hardened rPPG analysis: several algorithms × several skin ROIs, 10 s sliding windows with Welch PSD,
// SNR-weighted fusion, HR tracking with a continuity constraint, and a composite quality score.
// Pure functions (no DOM) so they can be bench-tested in Node.
import { FS, bandpass, clamp, findPeaks, hrv, mean, median, pos, std } from './dsp.ts';

export type Algo = 'POS' | 'CHROM' | 'GREEN' | 'RED';

/** CHROM (de Haan & Jeanne, IEEE TBME 2013), overlap-added over 1.6 s Hann windows. */
export function chrom(r: Float64Array, g: Float64Array, b: Float64Array, fs = FS): Float64Array {
  const n = r.length, l = Math.round(1.6 * fs);
  const out = new Float64Array(n);
  if (n < l) return out;
  const hop = Math.max(1, Math.floor(l / 2));
  const win = new Float64Array(l);
  for (let i = 0; i < l; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (l - 1));
  const X = new Float64Array(l), Y = new Float64Array(l);
  for (let s = 0; s + l <= n; s += hop) {
    let mr = 0, mg = 0, mb = 0;
    for (let i = 0; i < l; i++) { mr += r[s + i]; mg += g[s + i]; mb += b[s + i]; }
    mr /= l; mg /= l; mb /= l;
    if (mr <= 0 || mg <= 0 || mb <= 0) continue;
    for (let i = 0; i < l; i++) {
      const rn = r[s + i] / mr, gn = g[s + i] / mg, bn = b[s + i] / mb;
      X[i] = 3 * rn - 2 * gn;
      Y[i] = 1.5 * rn + gn - 1.5 * bn;
    }
    const sx = std(X), sy = std(Y);
    const alpha = sy > 0 ? sx / sy : 0;
    const mx = mean(X), my = mean(Y);
    for (let i = 0; i < l; i++) out[s + i] += win[i] * (X[i] - mx - alpha * (Y[i] - my));
  }
  return out;
}

/** Single channel divided by its 1 s moving average (removes illumination level), minus 1. */
export function channelNorm(x: Float64Array, fs = FS): Float64Array {
  const n = x.length, h = Math.round(fs / 2);
  const out = new Float64Array(n);
  let acc = 0;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { acc += x[i]; pre[i + 1] = acc; }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n, i + h + 1);
    const m = (pre[b] - pre[a]) / (b - a);
    out[i] = m > 0 ? x[i] / m - 1 : 0;
  }
  return out;
}

export function algoSignal(a: Algo, r: Float64Array, g: Float64Array, b: Float64Array, fs = FS): Float64Array {
  const raw = a === 'POS' ? pos(r, g, b, fs) : a === 'CHROM' ? chrom(r, g, b, fs) : a === 'GREEN' ? channelNorm(g, fs) : channelNorm(r, fs);
  return bandpass(raw, 0.7, 3.0, fs);
}

/** Least-squares removal of a background (non-skin) trace from a skin trace, on normalized signals. */
export function regressOut(x: Float64Array, bg: Float64Array): Float64Array {
  const mx = mean(x), mb = mean(bg);
  if (!(mx > 0) || !(mb > 0)) return x;
  const xn = Float64Array.from(x, (v) => v / mx - 1), bn = Float64Array.from(bg, (v) => v / mb - 1);
  let num = 0, den = 0;
  for (let i = 0; i < xn.length; i++) { num += xn[i] * bn[i]; den += bn[i] * bn[i]; }
  const beta = den > 0 ? clamp(num / den, -2, 2) : 0;
  return Float64Array.from(xn, (v, i) => mx * (1 + v - beta * bn[i]));
}

export const PSD_F0 = 0.7, PSD_F1 = 4.0, PSD_STEP = 0.01, HR_F1 = 3.0;
export const PSD_FREQS: number[] = (() => {
  const f: number[] = [];
  for (let x = PSD_F0; x <= PSD_F1 + 1e-9; x += PSD_STEP) f.push(Math.round(x * 1000) / 1000);
  return f;
})();

/** Welch PSD (Hann, 8 s segments, 1 s hop) on a fixed grid of frequencies. */
export function welch(x: Float64Array, fs = FS, segSec = 8, hopSec = 1): Float64Array {
  const seg = Math.min(x.length, Math.round(segSec * fs));
  const hop = Math.max(1, Math.round(hopSec * fs));
  const psd = new Float64Array(PSD_FREQS.length);
  const w = new Float64Array(seg);
  for (let i = 0; i < seg; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, seg - 1));
  let count = 0;
  const buf = new Float64Array(seg);
  for (let s = 0; s + seg <= x.length; s += hop) {
    let m = 0;
    for (let i = 0; i < seg; i++) m += x[s + i];
    m /= seg;
    for (let i = 0; i < seg; i++) buf[i] = (x[s + i] - m) * w[i];
    for (let k = 0; k < PSD_FREQS.length; k++) {
      const dw = (2 * Math.PI * PSD_FREQS[k]) / fs;
      const cd = Math.cos(dw), sd = Math.sin(dw);
      let c = 1, sn = 0, re = 0, im = 0;
      for (let i = 0; i < seg; i++) {
        re += buf[i] * c; im -= buf[i] * sn;
        const c2 = c * cd - sn * sd; sn = sn * cd + c * sd; c = c2;
      }
      psd[k] += re * re + im * im;
    }
    count++;
  }
  if (count) for (let k = 0; k < psd.length; k++) psd[k] /= count;
  return psd;
}

/**
 * SNR (dB) of a peak: power near f0 and 2·f0 vs the rest of 0.7–4 Hz (de Haan's definition). The ±0.1 Hz band of the
 * original is widened to ±0.2 / ±0.3 Hz because an 8 s Hann segment's main lobe is ±0.25 Hz wide.
 */
export function snrAt(psd: Float64Array, f0: number): number {
  let sig = 0, noise = 0;
  for (let k = 0; k < psd.length; k++) {
    const f = PSD_FREQS[k];
    if (Math.abs(f - f0) <= 0.2 || Math.abs(f - 2 * f0) <= 0.3) sig += psd[k];
    else noise += psd[k];
  }
  return 10 * Math.log10((sig + 1e-15) / (noise + 1e-15));
}

/** Top local maxima in the HR band (0.7–3.0 Hz), strongest first. */
export function peaks(psd: Float64Array, k = 3): { f: number; p: number }[] {
  const out: { f: number; p: number }[] = [];
  for (let i = 1; i < psd.length - 1; i++) {
    const f = PSD_FREQS[i];
    if (f > HR_F1) break;
    if (psd[i] >= psd[i - 1] && psd[i] > psd[i + 1]) out.push({ f, p: psd[i] });
  }
  if (psd[0] > psd[1]) out.push({ f: PSD_FREQS[0], p: psd[0] });
  return out.sort((a, b) => b.p - a.p).slice(0, k);
}

export interface WindowResult {
  t0: number; // seconds from segment start
  valid: boolean; // enough valid frames
  fused: Float64Array;
  snr: number; // fused SNR at the tracked peak
  hr: number | null; // tracked HR (bpm)
  perTrace: { key: string; hr: number; snr: number; w: number }[];
}

export interface Trace { key: string; algo: Algo; roi: string; x: Float64Array }

/** Sliding 10 s windows, 1 s step: per-trace Welch PSD, SNR-weighted fused PSD, candidate peaks. */
export function slidingWindows(traces: Trace[], validMask: Float64Array, fs = FS, winSec = 10, stepSec = 1, maxInvalid = 0.2) {
  const n = traces[0]?.x.length ?? 0;
  const win = Math.round(winSec * fs), step = Math.round(stepSec * fs);
  const wins: (WindowResult & { cands: { f: number; p: number }[] })[] = [];
  for (let s = 0; s + win <= n; s += step) {
    let inv = 0;
    for (let i = s; i < s + win; i++) if (validMask[i] < 0.5) inv++;
    const valid = inv / win <= maxInvalid;
    const per: WindowResult['perTrace'] = [];
    const fused = new Float64Array(PSD_FREQS.length);
    let wsum = 0;
    const psds: { psd: Float64Array; snr: number }[] = [];
    for (const tr of traces) {
      const psd = welch(tr.x.subarray(s, s + win), fs);
      let tot = 0;
      for (let k = 0; k < psd.length; k++) tot += psd[k];
      if (tot > 0) for (let k = 0; k < psd.length; k++) psd[k] /= tot;
      const pk = peaks(psd, 1)[0];
      const snr = pk ? snrAt(psd, pk.f) : -99;
      psds.push({ psd, snr });
      per.push({ key: tr.key, hr: pk ? pk.f * 60 : NaN, snr, w: 0 });
    }
    psds.forEach((q, i) => {
      const w = Math.max(0, q.snr + 3) ** 2;
      per[i].w = w;
      wsum += w;
    });
    psds.forEach((q, i) => {
      const w = wsum > 0 ? per[i].w / wsum : 1 / psds.length;
      for (let k = 0; k < fused.length; k++) fused[k] += w * q.psd[k];
    });
    wins.push({ t0: s / fs, valid, fused, snr: -99, hr: null, perTrace: per, cands: peaks(fused, 3) });
  }
  return wins;
}

/** Viterbi over windows: maximise log peak power, penalise jumps > 12 bpm between adjacent windows. */
export function trackHr(wins: ReturnType<typeof slidingWindows>, maxJump = 12) {
  const idx = wins.map((w, i) => (w.valid && w.cands.length ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return;
  const cost: number[][] = [], back: number[][] = [];
  idx.forEach((wi, j) => {
    const c = wins[wi].cands;
    cost[j] = c.map((cd) => -Math.log(cd.p + 1e-9));
    back[j] = c.map(() => -1);
    if (j === 0) return;
    const pc = wins[idx[j - 1]].cands;
    c.forEach((cd, a) => {
      let best = Infinity, arg = 0;
      pc.forEach((pd, b) => {
        const jump = Math.abs(cd.f - pd.f) * 60;
        const v = cost[j - 1][b] + (jump > maxJump ? 3 + (jump - maxJump) / 4 : jump / 30);
        if (v < best) { best = v; arg = b; }
      });
      cost[j][a] += best;
      back[j][a] = arg;
    });
  });
  let a = cost[cost.length - 1].indexOf(Math.min(...cost[cost.length - 1]));
  for (let j = idx.length - 1; j >= 0; j--) {
    const w = wins[idx[j]];
    const f = w.cands[a].f;
    w.hr = f * 60;
    w.snr = snrAt(w.fused, f);
    a = back[j][a];
    if (a < 0 && j > 0) a = 0;
  }
}

export interface QualityComponents {
  snr: number; agreement: number; coverage: number; motion: number; fps: number; brightness: number; clipping: number; face: number;
}

/** Documented weights; see QUALITY.md. Sum = 1. */
export const QUALITY_WEIGHTS: QualityComponents = {
  snr: 0.3, agreement: 0.15, coverage: 0.15, motion: 0.12, fps: 0.08, brightness: 0.08, clipping: 0.05, face: 0.07,
};

export function qualityComponents(m: {
  snrDb: number; algoSpreadBpm: number; goodWindowFrac: number; invalidPct: number; fps: number; jitterMs: number;
  brightness: number; clippedPct: number; faceWidthPct: number | null;
}): QualityComponents {
  const lin = (x: number, a: number, b: number) => clamp((x - a) / (b - a), 0, 1);
  const bright = m.brightness < 70 ? lin(m.brightness, 30, 70) : m.brightness > 210 ? 1 - lin(m.brightness, 210, 245) : 1;
  return {
    snr: lin(m.snrDb, -3, 6),
    agreement: 1 - lin(m.algoSpreadBpm, 3, 15),
    coverage: lin(m.goodWindowFrac, 0, 0.6),
    motion: 1 - lin(m.invalidPct, 0, 30),
    fps: lin(m.fps, 12, 24) * (1 - lin(m.jitterMs, 15, 60)),
    brightness: bright,
    clipping: 1 - lin(m.clippedPct, 0, 15),
    face: m.faceWidthPct == null ? 1 : lin(m.faceWidthPct, 20, 35),
  };
}

export function qualityScore(c: QualityComponents): number {
  let s = 0;
  for (const k of Object.keys(QUALITY_WEIGHTS) as (keyof QualityComponents)[]) s += QUALITY_WEIGHTS[k] * c[k];
  return Math.round(s * 100) / 100;
}

/**
 * `consistency` (raw window peaks agreeing with the final HR) is a hard gate: algorithm agreement alone is not
 * evidence, because POS/CHROM/GREEN read the same pixels. A no-pulse control video passed without this gate.
 */
export function qualityLevel(score: number, c: QualityComponents, consistency = 1): 'good' | 'fair' | 'poor' {
  if (score >= 0.65 && c.snr >= 0.4 && consistency >= 0.6) return 'good';
  if (score >= 0.45 && c.snr >= 0.2 && consistency >= 0.4) return 'fair';
  return 'poor';
}

/** Reason codes for weak components, worst (weight × deficit) first. */
export function qualityReasons(c: QualityComponents, ctx: { brightness: number; backlightRatio: number | null }): string[] {
  const map: Record<keyof QualityComponents, string> = {
    snr: 'low_snr', agreement: 'unstable_hr', coverage: 'unstable_hr', motion: 'motion', fps: 'low_fps',
    brightness: ctx.brightness < 70 ? 'dark' : 'overexposed', clipping: 'overexposed', face: 'far',
  };
  const out = (Object.keys(c) as (keyof QualityComponents)[])
    .filter((k) => c[k] < 0.5)
    .sort((a, b) => QUALITY_WEIGHTS[b] * (1 - c[b]) - QUALITY_WEIGHTS[a] * (1 - c[a]))
    .map((k) => map[k]);
  if ((ctx.backlightRatio ?? 0) > 1.6) out.unshift('backlit');
  return [...new Set(out)];
}

export interface AnalysisInput {
  fs: number;
  rois: { name: string; r: Float64Array; g: Float64Array; b: Float64Array }[];
  bg?: { r: Float64Array; g: Float64Array; b: Float64Array } | null;
  valid: Float64Array;
  algos: Algo[];
  bgSubtract: boolean;
}

export interface Analysis {
  hr: number | null;
  snrDb: number;
  windows: WindowResult[];
  goodWindowFrac: number;
  perAlgoHr: Record<string, number>;
  perAlgoSnr: Record<string, number>;
  algoSpreadBpm: number;
  fusedBvp: Float64Array;
  beatWave: Float64Array;
  rmssd: number | null;
  sdnn: number | null;
  /** Share of valid windows whose strongest raw (untracked) fused peak is within ±6 bpm of the final HR. */
  consistency: number;
}

/** Full analysis of one (already uniformly resampled) segment. */
export function analyze(inp: AnalysisInput, snrGood = -1): Analysis {
  const traces: Trace[] = [];
  for (const roi of inp.rois) {
    let { r, g, b } = roi;
    if (inp.bgSubtract && inp.bg) { r = regressOut(r, inp.bg.r); g = regressOut(g, inp.bg.g); b = regressOut(b, inp.bg.b); }
    for (const a of inp.algos) traces.push({ key: `${a}:${roi.name}`, algo: a, roi: roi.name, x: algoSignal(a, r, g, b, inp.fs) });
  }
  const empty: Analysis = {
    hr: null, snrDb: -99, windows: [], goodWindowFrac: 0, perAlgoHr: {}, perAlgoSnr: {}, algoSpreadBpm: 99,
    fusedBvp: new Float64Array(0), beatWave: new Float64Array(0), rmssd: null, sdnn: null, consistency: 0,
  };
  if (!traces.length || traces[0].x.length < inp.fs * 10) return empty;
  const wins = slidingWindows(traces, inp.valid, inp.fs);
  trackHr(wins);
  const usable = wins.filter((w) => w.valid && w.hr != null);
  const good = usable.filter((w) => w.snr >= snrGood);
  const pick = good.length >= 3 ? good : usable;
  const trackedHr = pick.length ? median(pick.map((w) => w.hr!)) : null;
  const snrDb = pick.length ? median(pick.map((w) => w.snr)) : -99;
  // Per-algorithm HR: per window take that algorithm's best ROI, then median over windows.
  const perAlgoHr: Record<string, number> = {}, perAlgoSnr: Record<string, number> = {};
  for (const a of inp.algos) {
    const hs: number[] = [], ss: number[] = [];
    for (const w of usable) {
      const best = w.perTrace.filter((p) => p.key.startsWith(`${a}:`)).sort((x, y) => y.snr - x.snr)[0];
      if (best && Number.isFinite(best.hr)) { hs.push(best.hr); ss.push(best.snr); }
    }
    if (hs.length) { perAlgoHr[a] = Math.round(median(hs) * 10) / 10; perAlgoSnr[a] = Math.round(median(ss) * 10) / 10; }
  }
  // Agreement between the two chrominance methods (POS, CHROM). GREEN still contributes to the fusion by its SNR,
  // but it is the most motion/illumination-sensitive and on the first real iPhone scan it alone read 51 vs 71/70.
  const chromaKeys = (['POS', 'CHROM'] as const).filter((k) => k in perAlgoHr);
  const ah = chromaKeys.length >= 2 ? chromaKeys.map((k) => perAlgoHr[k]) : Object.values(perAlgoHr);
  const algoSpreadBpm = ah.length > 1 ? Math.max(...ah) - Math.min(...ah) : ah.length ? 0 : 99;
  // Whole-segment fused spectrum (invalid frames tapered out), searched within ±12 bpm of the tracked median:
  // keeps the long-window frequency resolution while the windows supply continuity and harmonic protection.
  let hr = trackedHr;
  // When algorithms disagree badly, trust POS alone over the whole band (most robust to motion/illumination).
  const disagree = algoSpreadBpm > 10 && inp.algos.includes('POS');
  if (trackedHr != null) {
    const mask = smoothMask(inp.valid, Math.round(inp.fs / 2));
    const full = new Float64Array(PSD_FREQS.length);
    let wsum = 0;
    for (const tr of traces) {
      if (disagree && tr.algo !== 'POS') continue;
      const ss = usable.map((w) => w.perTrace.find((p) => p.key === tr.key)?.snr ?? -99);
      const w = disagree ? 1 : Math.max(0, median(ss) + 3) ** 2;
      if (w <= 0) continue;
      const psd = welch(Float64Array.from(tr.x, (v, i) => v * mask[i]), inp.fs, 10, 2);
      let tot = 0;
      for (let k = 0; k < psd.length; k++) tot += psd[k];
      if (tot > 0) for (let k = 0; k < psd.length; k++) full[k] += (w * psd[k]) / tot;
      wsum += w;
    }
    if (wsum > 0) {
      let best = -1, bf = trackedHr / 60;
      for (let k = 0; k < full.length; k++) {
        const f = PSD_FREQS[k];
        if (f <= HR_F1 && (disagree || Math.abs(f * 60 - trackedHr) <= 12) && full[k] > best) { best = full[k]; bf = f; }
      }
      hr = bf * 60;
    }
  }
  // Time-domain fused pulse wave (global SNR weights) for display and beat intervals.
  const n = traces[0].x.length;
  const fusedBvp = new Float64Array(n);
  const gw = traces.map((tr) => {
    const ss = usable.map((w) => w.perTrace.find((p) => p.key === tr.key)?.snr ?? -99);
    return Math.max(0, median(ss) + 3) ** 2;
  });
  const gsum = gw.reduce((a, b) => a + b, 0);
  traces.forEach((tr, i) => {
    const sd = std(tr.x) || 1;
    const w = gsum > 0 ? gw[i] / gsum : 1 / traces.length;
    // align polarity with the first trace so components add instead of cancel
    let dot = 0;
    for (let k = 0; k < n; k++) dot += tr.x[k] * traces[0].x[k];
    const sgn = dot < 0 ? -1 : 1;
    for (let k = 0; k < n; k++) fusedBvp[k] += (sgn * w * tr.x[k]) / sd;
  });
  let beatWave: Float64Array = new Float64Array(0), rmssd: number | null = null, sdnn: number | null = null;
  if (hr) {
    const f0 = hr / 60;
    beatWave = bandpass(fusedBvp, Math.max(0.5, f0 - 0.45), f0 + 0.45, inp.fs);
    if (snrDb >= 10) {
      const v = hrv(findPeaks(beatWave, inp.fs, f0));
      rmssd = v.rmssd; sdnn = v.sdnn;
    }
  }
  // Raw peaks are taken BEFORE tracking: tracking enforces continuity and would make noise look stable.
  const raw = wins.filter((w) => w.valid && w.cands.length).map((w) => w.cands[0].f * 60);
  const consistency = hr != null && raw.length ? raw.filter((x) => Math.abs(x - hr) <= 6).length / raw.length : 0;
  return {
    hr, snrDb, windows: wins, goodWindowFrac: wins.length ? good.length / wins.length : 0,
    perAlgoHr, perAlgoSnr, algoSpreadBpm, fusedBvp, beatWave, rmssd, sdnn, consistency,
  };
}

function smoothMask(valid: Float64Array, half: number): Float64Array {
  const n = valid.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) { s += valid[j] >= 0.5 ? 1 : 0; c++; }
    out[i] = c ? s / c : 1;
  }
  return out;
}

/** Index range (in samples) of the best continuous `segSec` segment by mean window SNR. */
export function bestSegment(wins: WindowResult[], totalSamples: number, fs = FS, segSec = 20, winSec = 10): [number, number] {
  const segN = Math.round(segSec * fs);
  if (totalSamples <= segN) return [0, totalSamples];
  let best = -Infinity, bestStart = totalSamples - segN;
  for (let s = 0; s + segN <= totalSamples; s += fs) {
    const inside = wins.filter((w) => w.t0 * fs >= s && (w.t0 + winSec) * fs <= s + segN && w.valid);
    if (inside.length < 3) continue;
    const m = mean(inside.map((w) => w.snr));
    if (m > best) { best = m; bestStart = s; }
  }
  return [bestStart, bestStart + segN];
}

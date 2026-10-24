// Pure signal processing for camera vitals. No DOM, no state — easy to test.
// HR: POS projection (Wang et al., IEEE TBME 2017) on mean skin RGB, band-pass, spectral peak.
// RR: vertical chest/head motion, band-pass, spectral peak.
// HRV: beat-to-beat intervals from peaks of the filtered pulse wave.

export const FS = 30;

export function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

export function median(xs: ArrayLike<number>): number {
  const a = Array.from(xs).filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function mean(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return xs.length ? s / xs.length : NaN;
}

export function std(xs: ArrayLike<number>): number {
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i] - m) ** 2;
  return xs.length > 1 ? Math.sqrt(s / (xs.length - 1)) : 0;
}

/** Linear-interpolate irregular camera samples onto a uniform grid. */
export function resampleUniform(t: number[], ys: number[][], fs = FS): Float64Array[] {
  const n = t.length;
  if (n < 2) return ys.map(() => new Float64Array(0));
  const t0 = t[0];
  const m = Math.floor((t[n - 1] - t0) * fs) + 1;
  const out = ys.map(() => new Float64Array(m));
  let j = 0;
  for (let i = 0; i < m; i++) {
    const tt = t0 + i / fs;
    while (j < n - 2 && t[j + 1] < tt) j++;
    const ta = t[j];
    const tb = t[j + 1];
    const w = tb > ta ? clamp((tt - ta) / (tb - ta), 0, 1) : 0;
    for (let k = 0; k < ys.length; k++) out[k][i] = ys[k][j] + (ys[k][j + 1] - ys[k][j]) * w;
  }
  return out;
}

/** Plane-Orthogonal-to-Skin projection with overlap-add over 1.6 s windows. */
export function pos(r: Float64Array, g: Float64Array, b: Float64Array, fs = FS): Float64Array {
  const n = r.length;
  const l = Math.round(1.6 * fs);
  const H = new Float64Array(n);
  if (n < l) return H;
  const s1 = new Float64Array(l);
  const s2 = new Float64Array(l);
  for (let start = 0; start + l <= n; start++) {
    let mr = 0, mg = 0, mb = 0;
    for (let i = 0; i < l; i++) {
      mr += r[start + i];
      mg += g[start + i];
      mb += b[start + i];
    }
    mr /= l; mg /= l; mb /= l;
    if (mr <= 0 || mg <= 0 || mb <= 0) continue;
    let m1 = 0, m2 = 0;
    for (let i = 0; i < l; i++) {
      const cr = r[start + i] / mr, cg = g[start + i] / mg, cb = b[start + i] / mb;
      s1[i] = cg - cb;
      s2[i] = -2 * cr + cg + cb;
      m1 += s1[i];
      m2 += s2[i];
    }
    m1 /= l; m2 /= l;
    let v1 = 0, v2 = 0;
    for (let i = 0; i < l; i++) {
      v1 += (s1[i] - m1) ** 2;
      v2 += (s2[i] - m2) ** 2;
    }
    const alpha = v2 > 0 ? Math.sqrt(v1 / v2) : 0;
    let mh = 0;
    for (let i = 0; i < l; i++) mh += s1[i] + alpha * s2[i];
    mh /= l;
    for (let i = 0; i < l; i++) H[start + i] += s1[i] + alpha * s2[i] - mh;
  }
  return H;
}

// --- Biquad filters (RBJ cookbook) applied forward-backward for zero phase ---
type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

function biquad(kind: 'lp' | 'hp', fc: number, fs: number, q = Math.SQRT1_2): Biquad {
  const w0 = (2 * Math.PI * fc) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b1 = kind === 'lp' ? 1 - cw : -(1 + cw);
  const b0 = kind === 'lp' ? (1 - cw) / 2 : (1 + cw) / 2;
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

function runBiquad(x: Float64Array, c: Biquad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = x[0], x2 = x[0];
  // Start at steady state for a constant input so the edges don't ring.
  const dc = (c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2);
  let y1 = x[0] * dc, y2 = x[0] * dc;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

function reverse(x: Float64Array): Float64Array {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[x.length - 1 - i];
  return y;
}

export function bandpass(x: Float64Array, lo: number, hi: number, fs = FS): Float64Array {
  if (x.length < 8) return x.slice();
  // Odd reflection padding to tame edge transients.
  const pad = Math.min(x.length - 1, Math.round(fs * 2));
  const n = x.length;
  const padded = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) {
    padded[i] = 2 * x[0] - x[pad - i];
    padded[n + pad + i] = 2 * x[n - 1] - x[n - 2 - i];
  }
  padded.set(x, pad);
  const m = mean(padded);
  for (let i = 0; i < padded.length; i++) padded[i] -= m;
  const secs = [biquad('hp', lo, fs), biquad('lp', hi, fs)];
  let y: Float64Array = padded;
  for (const s of secs) y = runBiquad(y, s);
  y = reverse(y);
  for (const s of secs) y = runBiquad(y, s);
  y = reverse(y);
  return y.slice(pad, pad + n);
}

export interface Peak {
  freq: number;
  power: number;
  snrDb: number;
  f: number[];
  p: number[];
}

/** Hann-windowed DFT evaluated on a fine frequency grid between fmin and fmax. */
export function spectrumPeak(x: Float64Array, fs: number, fmin: number, fmax: number, step: number, halfBand: number): Peak {
  const n = x.length;
  const w = new Float64Array(n);
  const m = mean(x);
  for (let i = 0; i < n; i++) w[i] = (x[i] - m) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1)));
  const f: number[] = [];
  const p: number[] = [];
  for (let fr = fmin; fr <= fmax + 1e-9; fr += step) {
    const dw = (2 * Math.PI * fr) / fs;
    const cd = Math.cos(dw), sd = Math.sin(dw);
    let c = 1, s = 0, re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      re += w[i] * c;
      im -= w[i] * s;
      const c2 = c * cd - s * sd;
      s = s * cd + c * sd;
      c = c2;
    }
    f.push(fr);
    p.push(re * re + im * im);
  }
  let k = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[k]) k = i;
  const f0 = f[k];
  let sig = 0, noise = 0;
  for (let i = 0; i < p.length; i++) {
    const near = Math.abs(f[i] - f0) <= halfBand || Math.abs(f[i] - 2 * f0) <= halfBand;
    if (near) sig += p[i];
    else noise += p[i];
  }
  const snrDb = 10 * Math.log10((sig + 1e-12) / (noise + 1e-12));
  return { freq: f0, power: p[k], snrDb, f, p };
}

/** Local maxima at least ~0.55 beat apart, with sub-sample (parabolic) timing. Returns seconds. */
export function findPeaks(x: Float64Array, fs: number, beatHz: number): number[] {
  const minDist = Math.max(3, Math.floor((0.55 * fs) / beatHz));
  const cands: number[] = [];
  for (let i = 1; i < x.length - 1; i++) if (x[i] > 0 && x[i] > x[i - 1] && x[i] >= x[i + 1]) cands.push(i);
  cands.sort((a, b) => x[b] - x[a]);
  const taken: number[] = [];
  for (const c of cands) if (taken.every((t) => Math.abs(t - c) >= minDist)) taken.push(c);
  taken.sort((a, b) => a - b);
  const amp = median(taken.map((i) => x[i]));
  return taken
    .filter((i) => x[i] >= 0.3 * amp)
    .map((i) => {
      const den = x[i - 1] - 2 * x[i] + x[i + 1];
      const d = den !== 0 ? clamp((0.5 * (x[i - 1] - x[i + 1])) / den, -0.5, 0.5) : 0;
      return (i + d) / fs;
    });
}

export interface HrvResult {
  rmssd: number | null;
  sdnn: number | null;
  beats: number;
  validIbis: number;
}

export function hrv(peaksSec: number[]): HrvResult {
  const ibis = [];
  for (let i = 1; i < peaksSec.length; i++) ibis.push((peaksSec[i] - peaksSec[i - 1]) * 1000);
  const med = median(ibis);
  const ok = ibis.map((v) => v >= 0.75 * med && v <= 1.25 * med && v > 300 && v < 1600);
  const valid = ibis.filter((_, i) => ok[i]);
  const diffs: number[] = [];
  for (let i = 1; i < ibis.length; i++) if (ok[i] && ok[i - 1]) diffs.push(ibis[i] - ibis[i - 1]);
  if (valid.length < 8 || diffs.length < 6) return { rmssd: null, sdnn: null, beats: peaksSec.length, validIbis: valid.length };
  const rmssd = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length);
  return { rmssd, sdnn: std(valid), beats: peaksSec.length, validIbis: valid.length };
}

/**
 * Stress index 0..100 from ln(RMSSD): RMSSD 10 ms → 100, 100 ms → 0.
 * A rough screening proxy, disclosed as such in the UI — not a validated stress measure.
 */
export function stressFromRmssd(rmssd: number | null): number | null {
  if (rmssd == null || !Number.isFinite(rmssd)) return null;
  const v = 100 - ((Math.log(rmssd) - Math.log(10)) / (Math.log(100) - Math.log(10))) * 100;
  return Math.round(clamp(v, 0, 100));
}

export function stressLevel(s: number | null): 'low' | 'moderate' | 'high' | null {
  if (s == null) return null;
  return s < 40 ? 'low' : s < 65 ? 'moderate' : 'high';
}

export interface HrEstimate {
  bpm: number | null;
  snrDb: number;
  bvp: Float64Array;
  /** Narrow band around the HR peak: cleaner beat timing for HRV (keeps modulation up to ~0.45 Hz). */
  beatWave: Float64Array;
}

/** HR from raw RGB traces (uniformly sampled). */
export function estimateHr(r: Float64Array, g: Float64Array, b: Float64Array, fs = FS): HrEstimate {
  if (r.length < fs * 5) return { bpm: null, snrDb: -99, bvp: new Float64Array(0), beatWave: new Float64Array(0) };
  const raw = pos(r, g, b, fs);
  const bvp = bandpass(raw, 0.7, 3.2, fs);
  const pk = spectrumPeak(bvp, fs, 0.7, 3.2, 0.005, 0.1);
  const beatWave = bandpass(raw, Math.max(0.5, pk.freq - 0.45), pk.freq + 0.45, fs);
  return { bpm: pk.freq * 60, snrDb: pk.snrDb, bvp, beatWave };
}

export interface RrEstimate {
  rpm: number | null;
  snrDb: number;
}

export function estimateRr(motion: Float64Array, fs = FS): RrEstimate {
  if (motion.length < fs * 12) return { rpm: null, snrDb: -99 };
  const x = bandpass(motion, 0.1, 0.65, fs);
  const pk = spectrumPeak(x, fs, 0.1, 0.65, 0.002, 0.04);
  return { rpm: pk.freq * 60, snrDb: pk.snrDb };
}

/** Sliding 10 s windows every 2 s → spread of HR estimates (bpm). Low spread = stable reading. */
export function hrStability(r: Float64Array, g: Float64Array, b: Float64Array, fs = FS): number {
  const win = fs * 10;
  const est: number[] = [];
  for (let s = 0; s + win <= r.length; s += fs * 2) {
    const e = estimateHr(r.subarray(s, s + win), g.subarray(s, s + win), b.subarray(s, s + win), fs);
    if (e.bpm) est.push(e.bpm);
  }
  return est.length >= 3 ? std(est) : 99;
}

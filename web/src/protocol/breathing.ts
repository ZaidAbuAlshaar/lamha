// v2 guided-breathing signal check: 3 paced breaths (inhale 2.5 s / exhale 2.5 s) during a 15 s scan.
// Respiratory sinus arrhythmia: a real pulse speeds up on inhale and slows on exhale. If the beat times we
// extracted follow the pacing, the camera is tracking a real pulse, not noise. A signal check, not a medical test.
// Pure logic (no DOM), tested in tests/protocol.test.ts.

export const BREATH = { inhale: 2.5, exhale: 2.5, breaths: 3 } as const;
export const BREATH_SECONDS = (BREATH.inhale + BREATH.exhale) * BREATH.breaths; // 15
export const RSA_MIN_BPM = 1; // inhale HR must exceed exhale HR by at least this much
export const RSA_MIN_BREATHS = 2; // ...with the same sign in at least this many of the 3 breaths

export type BreathPhase = 'inhale' | 'exhale';

export function phaseAt(t: number): { phase: BreathPhase; breath: number; frac: number } {
  const cyc = BREATH.inhale + BREATH.exhale;
  const tt = Math.max(0, t);
  const breath = Math.min(BREATH.breaths - 1, Math.floor(tt / cyc));
  const c = tt - breath * cyc;
  return c < BREATH.inhale
    ? { phase: 'inhale', breath, frac: c / BREATH.inhale }
    : { phase: 'exhale', breath, frac: Math.min(1, (c - BREATH.inhale) / BREATH.exhale) };
}

export interface HrPoint { t: number; hr: number }

/** Instantaneous HR (60 / IBI) at each interval midpoint, with implausible intervals removed. */
export function instantHr(beats: number[]): HrPoint[] {
  const b = [...beats].filter(Number.isFinite).sort((x, y) => x - y);
  const ibis: { t: number; ibi: number }[] = [];
  for (let i = 1; i < b.length; i++) {
    const ibi = b[i] - b[i - 1];
    if (ibi >= 60 / 180 && ibi <= 60 / 40) ibis.push({ t: (b[i] + b[i - 1]) / 2, ibi });
  }
  if (!ibis.length) return [];
  const med = [...ibis].map((x) => x.ibi).sort((x, y) => x - y)[ibis.length >> 1];
  return ibis.filter((x) => Math.abs(x.ibi - med) <= 0.3 * med).map((x) => ({ t: x.t, hr: 60 / x.ibi }));
}

/** Linear interpolation of the HR points on a uniform grid (only inside the covered span). */
function sampleAt(pts: HrPoint[], t: number): number | null {
  if (!pts.length || t < pts[0].t || t > pts[pts.length - 1].t) return null;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1], b = pts[i];
      const w = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      return a.hr + (b.hr - a.hr) * w;
    }
  }
  return pts[pts.length - 1].hr;
}

export interface BreathStat { inhale: number | null; exhale: number | null; diff: number | null }

export interface RsaResult {
  verified: boolean;
  series: HrPoint[];
  perBreath: BreathStat[];
  meanInhale: number | null;
  meanExhale: number | null;
  meanDiff: number | null; // inhale − exhale, bpm
  consistent: number; // breaths with inhale > exhale
  beats: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function analyzeRsa(beats: number[], step = 0.1): RsaResult {
  const series = instantHr(beats);
  const perBreath: BreathStat[] = [];
  const allIn: number[] = [], allEx: number[] = [];
  const cyc = BREATH.inhale + BREATH.exhale;
  for (let k = 0; k < BREATH.breaths; k++) {
    const ins: number[] = [], exs: number[] = [];
    for (let t = k * cyc + step / 2; t < (k + 1) * cyc; t += step) {
      const v = sampleAt(series, t);
      if (v == null) continue;
      (t - k * cyc < BREATH.inhale ? ins : exs).push(v);
    }
    const mi = mean(ins), me = mean(exs);
    allIn.push(...ins); allEx.push(...exs);
    perBreath.push({ inhale: mi, exhale: me, diff: mi != null && me != null ? mi - me : null });
  }
  const meanInhale = mean(allIn), meanExhale = mean(allEx);
  const meanDiff = meanInhale != null && meanExhale != null ? meanInhale - meanExhale : null;
  const consistent = perBreath.filter((b) => b.diff != null && b.diff > 0).length;
  const verified = meanDiff != null && meanDiff >= RSA_MIN_BPM && consistent >= RSA_MIN_BREATHS;
  return { verified, series, perBreath, meanInhale, meanExhale, meanDiff, consistent, beats: beats.length };
}

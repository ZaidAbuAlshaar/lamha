// Bench: original single-POS estimate vs hardened multi-algo/multi-ROI analysis on synthetic traces with
// real-phone failure modes. Simulated signals; validates the processing, not accuracy on people.
// Run: node --experimental-strip-types tests/dsp2.test.ts
import { FS, estimateHr, resampleUniform } from '../src/vitals/dsp.ts';
import { analyze, qualityComponents, qualityLevel, qualityScore } from '../src/vitals/dsp2.ts';

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

type Cond = { name: string; bpm: number; noise: number; aeSteps?: boolean; motion?: boolean; fps?: number; amp?: number };
const CONDS: Cond[] = [
  { name: 'clean', bpm: 72, noise: 0.3 },
  { name: 'noisy', bpm: 84, noise: 1.0 },
  { name: 'auto-exposure steps', bpm: 66, noise: 0.5, aeSteps: true },
  { name: 'motion bursts', bpm: 92, noise: 0.5, motion: true },
  { name: 'low fps 15', bpm: 78, noise: 0.6, fps: 15 },
  { name: 'weak pulse + AE + motion', bpm: 101, noise: 0.7, aeSteps: true, motion: true, amp: 0.6 },
];

let fails = 0;
for (const [ci, c] of CONDS.entries()) {
  for (const seed of [1, 2, 3]) {
    const r = rng(seed * 97 + ci);
    const fps = c.fps ?? 30;
    const t: number[] = [];
    const rois = [0, 1, 2].map(() => ({ R: [] as number[], G: [] as number[], B: [] as number[] }));
    const valid: number[] = [];
    let tt = 0, phase = 0, gain = 1;
    while (tt < 30) {
      const dt = 1 / fps + (r() - 0.5) * 0.3 / fps;
      tt += dt;
      phase += (2 * Math.PI * (c.bpm + 2 * Math.sin(0.6 * tt)) / 60) * dt;
      const pulse = (c.amp ?? 1) * (Math.sin(phase) + 0.3 * Math.sin(2 * phase + 0.8));
      if (c.aeSteps && Math.floor(tt / 5) !== Math.floor((tt - dt) / 5)) gain *= 1 + (r() - 0.5) * 0.25; // exposure jump
      const burst = c.motion && (tt % 9) > 7 && (tt % 9) < 8.2; // 1.2 s motion burst every 9 s
      t.push(tt);
      valid.push(burst ? 0 : 1);
      rois.forEach((roi, k) => {
        const roiAmp = [1, 0.7, 0.5][k];
        const art = burst ? 6 * Math.sin(2 * Math.PI * 1.7 * tt + k) : 0; // motion artefact near HR band
        roi.R.push(gain * (150 + 0.25 * roiAmp * pulse) + art + c.noise * gauss(r));
        roi.G.push(gain * (110 + 0.6 * roiAmp * pulse) + art + c.noise * gauss(r));
        roi.B.push(gain * (90 + 0.35 * roiAmp * pulse) + art + c.noise * gauss(r));
      });
    }
    // baseline: one ROI mean, POS, whole-band peak
    const avg = (ch: 'R' | 'G' | 'B') => t.map((_, i) => (rois[0][ch][i] + rois[1][ch][i] + rois[2][ch][i]) / 3);
    const [br, bg, bb] = resampleUniform(t, [avg('R'), avg('G'), avg('B')], FS);
    const base = estimateHr(br, bg, bb, FS).bpm ?? 0;
    // hardened
    const res = rois.map((roi) => resampleUniform(t, [roi.R, roi.G, roi.B], FS));
    const [vm] = resampleUniform(t, [valid], FS);
    const a = analyze({ fs: FS, rois: res.map(([R, G, B], k) => ({ name: `roi${k}`, r: R, g: G, b: B })), valid: vm, algos: ['POS', 'CHROM', 'GREEN'], bgSubtract: false });
    const comp = qualityComponents({ snrDb: a.snrDb, algoSpreadBpm: a.algoSpreadBpm, goodWindowFrac: a.goodWindowFrac, invalidPct: 100 * (1 - vm.reduce((s, x) => s + (x >= 0.5 ? 1 : 0), 0) / vm.length), fps, jitterMs: 3, brightness: 120, clippedPct: 0, faceWidthPct: 40 });
    const score = qualityScore(comp);
    const eB = Math.abs(base - c.bpm), eH = Math.abs((a.hr ?? 0) - c.bpm);
    const ok = eH <= 3;
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name.padEnd(26)} seed ${seed} truth ${c.bpm} | baseline ${base.toFixed(1)} (err ${eB.toFixed(1)}) | hardened ${a.hr?.toFixed(1)} (err ${eH.toFixed(1)}) snr ${a.snrDb.toFixed(1)} dB spread ${a.algoSpreadBpm.toFixed(1)} | score ${score} ${qualityLevel(score, comp)}`);
  }
}
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);

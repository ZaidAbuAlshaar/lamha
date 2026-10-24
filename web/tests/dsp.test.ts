// Synthetic bench test for the DSP chain: known HR/RR in, estimate out. Run: node --experimental-strip-types tests/dsp.test.ts
import { resampleUniform, estimateHr, estimateRr, findPeaks, hrv, hrStability, FS } from '../src/vitals/dsp.ts';

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

let fails = 0;
for (const [bpm, rpm, noise, seed] of [[62, 12, 0.4, 1], [72, 15, 0.6, 2], [96, 20, 0.8, 3], [118, 24, 0.6, 4], [84, 16, 1.2, 5]] as const) {
  const r = rng(seed);
  const t: number[] = [], R: number[] = [], G: number[] = [], B: number[] = [], M: number[] = [];
  let tt = 0, phase = 0;
  while (tt < 30) {
    const dt = 1 / 30 + (r() - 0.5) * 0.012; // jittery camera timing
    tt += dt;
    const inst = bpm + 2 * Math.sin(2 * Math.PI * 0.1 * tt); // slow HR drift (true RMSSD only a few ms)
    phase += (2 * Math.PI * inst / 60) * dt;
    const pulse = Math.sin(phase) + 0.3 * Math.sin(2 * phase + 0.8);
    const light = 2 * Math.sin(2 * Math.PI * 0.05 * tt); // slow illumination drift
    t.push(tt);
    R.push(150 + light + 0.25 * pulse + noise * gauss(r));
    G.push(110 + light + 0.6 * pulse + noise * gauss(r));
    B.push(90 + light + 0.35 * pulse + noise * gauss(r));
    M.push(2.5 * Math.sin(2 * Math.PI * (rpm / 60) * tt) + 0.4 * gauss(r) + 0.05 * tt);
  }
  const [ur, ug, ub, um] = resampleUniform(t, [R, G, B, M], FS);
  const h = estimateHr(ur, ug, ub, FS);
  const rr = estimateRr(um, FS);
  const pk = findPeaks(h.beatWave, FS, (h.bpm ?? 70) / 60);
  const v = hrv(pk);
  const stab = hrStability(ur, ug, ub, FS);
  const hrErr = Math.abs((h.bpm ?? 0) - bpm), rrErr = Math.abs((rr.rpm ?? 0) - rpm);
  const ok = hrErr <= 3 && rrErr <= 2;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} truth HR ${bpm} RR ${rpm} noise ${noise} -> HR ${h.bpm?.toFixed(1)} (snr ${h.snrDb.toFixed(1)} dB, stab sd ${stab.toFixed(1)}) RR ${rr.rpm?.toFixed(1)} (snr ${rr.snrDb.toFixed(1)}) beats ${v.beats} rmssd ${v.rmssd?.toFixed(0)} ms`);
}
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);

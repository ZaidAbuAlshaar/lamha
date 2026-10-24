// v2 protocol logic tests. Run: node --experimental-strip-types tests/protocol.test.ts
import { evaluate, combine, median, MAX_SCANS, type ScanLike } from '../src/protocol/readings.ts';
import { analyzeRsa, instantHr, phaseAt, BREATH_SECONDS } from '../src/protocol/breathing.ts';
import { buildIcs, fold } from '../src/protocol/reminder.ts';

let fails = 0, passes = 0;
function ok(cond: unknown, name: string) {
  if (cond) passes++;
  else { fails++; console.log(`FAIL ${name}`); }
}
const S = (hr: number | null, quality: ScanLike['quality'] = 'good', conf = 0.7): ScanLike & { tag?: string } => ({ hr_bpm: hr, quality, hr_confidence: conf });

// --- readings protocol ---
{
  const d = evaluate([]);
  ok(!d.done && d.next === 1 && d.target === 2, 'empty: wait for reading 1 of 2');
}
{
  const d = evaluate([S(72)]);
  ok(!d.done && d.next === 2 && d.target === 2, 'one good: wait for reading 2 of 2');
}
{
  const d = evaluate([S(72), S(76)]);
  ok(d.done && d.final_hr === 74 && d.method === 'mean2' && !d.incomplete, 'two agree (≤5): mean');
}
{
  const d = evaluate([S(72), S(77)]);
  ok(d.done && d.final_hr === 74.5, 'diff exactly 5 counts as agree');
}
{
  const d = evaluate([S(72), S(80)]);
  ok(!d.done && d.next === 3 && d.target === 3, 'two disagree: ask for a third');
  const d3 = evaluate([S(72), S(80), S(74)]);
  ok(d3.done && d3.final_hr === 74 && d3.method === 'median', 'third reading: median of good ones');
}
{
  const d = evaluate([S(72), S(null, 'poor', 0.1), S(75)]);
  ok(d.done && d.final_hr === 73.5 && d.good.length === 2, 'poor reading skipped, not counted');
  const d2 = evaluate([S(150, 'poor', 0.1), S(72)]);
  ok(!d2.done && d2.next === 2 && d2.good.length === 1, 'poor reading with an HR never enters the calculation');
}
{
  const d = evaluate([S(70, 'poor'), S(null, 'poor'), S(72), S(90, 'poor')]);
  ok(MAX_SCANS === 4 && d.done && d.incomplete && d.final_hr === 72 && d.method === 'single', 'max 4 scans: continue with the one good reading, marked');
  const d0 = evaluate([S(70, 'poor'), S(71, 'poor'), S(72, 'poor'), S(73, 'poor')]);
  ok(d0.done && d0.incomplete && d0.final_hr === null && d0.good.length === 0, 'all poor: no HR, marked');
  const d2 = evaluate([S(70), S(80), S(60, 'poor'), S(null, 'poor')]);
  ok(d2.done && d2.incomplete && d2.final_hr === 75, 'two disagreeing + scans exhausted: median of good, marked');
}
{
  const c = combine([{ ...S(72, 'fair', 0.4), tag: 'a' }, { ...S(76, 'good', 0.8), tag: 'b' }]);
  ok(c.hr_bpm === 74 && c.tag === 'b' && c.reading_count === 2 && c.readings.join() === '72,76' && c.scan_count === 2 && !c.protocol_incomplete, 'combine: final HR + fields from most confident good scan');
  const p = combine([{ ...S(140, 'poor', 0.1), tag: 'p' }]);
  ok(p.hr_bpm === 140 && p.quality === 'poor' && p.reading_count === 0 && p.readings.length === 0 && p.protocol_incomplete, 'combine: only poor → returned as poor, no readings');
}
ok(median([3, 1, 2]) === 2 && median([1, 2, 3, 4]) === 2.5 && median([]) === null, 'median');

// --- breathing / RSA ---
ok(BREATH_SECONDS === 15, '15 s exercise');
ok(phaseAt(0).phase === 'inhale' && phaseAt(2.6).phase === 'exhale' && phaseAt(5.1).breath === 1 && phaseAt(14.9).breath === 2, 'phaseAt');

/** Beats from an HR curve hr(t): integrate phase. */
function beatsFrom(hr: (t: number) => number, dur = 15, jitter = 0, seed = 1): number[] {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; };
  const out: number[] = [];
  let ph = 0;
  for (let t = 0; t < dur; t += 0.001) {
    ph += (hr(t) / 60) * 0.001;
    if (ph >= 1) { ph -= 1; out.push(t + jitter * rnd()); }
  }
  return out;
}
{
  // RSA: +/-4 bpm, in phase with paced breathing (higher in inhale).
  const rsa = (t: number) => 72 + 4 * Math.sin((2 * Math.PI * t) / 5);
  const r = analyzeRsa(beatsFrom(rsa));
  ok(r.verified && (r.meanDiff ?? 0) >= 1 && r.consistent >= 2, `RSA present → verified (diff ${r.meanDiff?.toFixed(2)}, consistent ${r.consistent})`);
}
{
  const flat = analyzeRsa(beatsFrom(() => 72));
  ok(!flat.verified, `flat HR → not verified (diff ${flat.meanDiff?.toFixed(2)})`);
  const inverted = analyzeRsa(beatsFrom((t) => 72 - 4 * Math.sin((2 * Math.PI * t) / 5)));
  ok(!inverted.verified && (inverted.meanDiff ?? 0) < 0, 'HR higher on exhale → not verified');
  const none = analyzeRsa([]);
  ok(!none.verified && none.series.length === 0 && none.meanDiff === null, 'no beats → not verified');
  const few = analyzeRsa([1, 2]);
  ok(!few.verified, 'two beats → not verified');
}
{
  const pts = instantHr([0, 0.8, 1.6, 1.7, 2.4, 3.2]); // 0.1 s interval is impossible (600 bpm) → dropped
  ok(pts.every((p) => p.hr >= 40 && p.hr <= 180), 'instantHr drops implausible intervals');
}

// --- reminder .ics ---
{
  const d = new Date(2026, 9, 24, 17, 45, 12);
  const ics = buildIcs(d);
  ok(ics.includes('BEGIN:VEVENT') && ics.includes('RRULE:FREQ=DAILY') && ics.includes('DTSTART:20261024T174500'), 'ics: VEVENT, daily rule, local start time');
  ok(ics.includes('SUMMARY:فحص نظرة اليومي'), 'ics: Arabic title');
  ok(ics.split('\r\n').length > 10 && !/[^\r]\n/.test(ics), 'ics: CRLF line endings');
  const enc = new TextEncoder();
  ok(ics.split('\r\n').every((l) => enc.encode(l).length <= 75), 'ics: every line ≤ 75 octets');
  const long = 'DESCRIPTION:' + 'نظرة '.repeat(40);
  ok(fold(long).split('\r\n ').join('') === long, 'fold is lossless');
}

console.log(`${passes} passed, ${fails} failed`);
if (fails) process.exit(1);

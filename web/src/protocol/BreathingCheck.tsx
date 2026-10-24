// v2 guided-breathing signal check (optional, flag `breathing`). Never feeds triage and is never sent as a vital.
import { useState, type ComponentType } from 'react';
import { analyzeRsa, BREATH, BREATH_SECONDS, phaseAt, type RsaResult } from './breathing';
import type { LiveUpdate } from '../vitals/engine';
import './protocol.css';

const LABEL = 'تمرين تحقق من الإشارة — مش قياس طبي';

type Scanner<T> = ComponentType<{ seconds: number; onDone: (v: T) => void; onLive?: (u: LiveUpdate) => void }>;

export function Breathing<T extends { beat_times_s?: number[]; quality: 'good' | 'fair' | 'poor' }>({ Scanner, onNext }: { Scanner: Scanner<T>; onNext: () => void }) {
  const [mode, setMode] = useState<'intro' | 'run' | 'result'>('intro');
  const [run, setRun] = useState(0);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [res, setRes] = useState<{ rsa: RsaResult; quality: T['quality'] } | null>(null);

  if (mode === 'intro') {
    return (
      <div className="screen proto">
        <span className="proto-step">اختياري · 15 ثانية</span>
        <h2>{LABEL}</h2>
        <p>رح نتنفس سوا 3 مرات على مهل. لما تاخد نفس، النبض الطبيعي بيرتفع شوي، ولما تطلّعه بينزل.</p>
        <p className="muted">إذا لقطنا هالشي بالكاميرا، معناها إنها عم تقرأ نبضك الحقيقي مش ضجيج. هاد التمرين ما بيدخل بنتيجة الفحص.</p>
        <div className="spacer" />
        <button className="btn primary block" onClick={() => { setElapsed(null); setRun((r) => r + 1); setMode('run'); }}>ابدأ التمرين</button>
        <button className="btn ghost block" onClick={onNext}>تخطّى</button>
      </div>
    );
  }

  if (mode === 'run') {
    const started = elapsed != null;
    const t = elapsed ?? 0;
    const p = phaseAt(t);
    const ease = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
    const scale = !started ? 0.6 : p.phase === 'inhale' ? 0.6 + 0.4 * ease(p.frac) : 1 - 0.4 * ease(p.frac);
    const over = started && t >= BREATH_SECONDS;
    return (
      <div className="screen proto" style={{ gap: 12 }}>
        <span className="proto-step">{LABEL}</span>
        <div className="breath-stage" aria-live="polite">
          <div className="breath-circle" style={{ transform: `scale(${scale})` }}><b>{started && !over ? (p.phase === 'inhale' ? 'شهيق' : 'زفير') : ''}</b></div>
          <div className="breath-cue">
            {!started ? 'جهّز حالك… بنبلّش أول ما نشوف وجهك' : over ? 'خلصنا — عم نحلل' : p.phase === 'inhale' ? 'خد نفس بهدوء من أنفك…' : 'طلّع النفس على مهل…'}
          </div>
          {started && !over && <div className="breath-tag">نفس {p.breath + 1} من {BREATH.breaths}</div>}
        </div>
        <Scanner
          key={run}
          seconds={BREATH_SECONDS}
          onLive={(u) => { if (u.phase === 'scanning' || u.phase === 'analyzing') setElapsed(u.elapsed); }}
          onDone={(v) => { setRes({ rsa: analyzeRsa(v.beat_times_s ?? []), quality: v.quality }); setMode('result'); }}
        />
      </div>
    );
  }

  const ok = !!res && res.rsa.verified && res.quality !== 'poor'; // a poor scan never gets the badge (under-claim)
  return (
    <div className="screen proto">
      <span className="proto-step">{LABEL}</span>
      <div className={`breath-badge ${ok ? 'ok' : 'no'}`} role="status">
        {ok ? '✓ الإشارة متحققة: نبضك ارتفع مع الشهيق ونزل مع الزفير' : 'ما قدرنا نتحقق هالمرة'}
      </div>
      {res && <RsaChart r={res.rsa} />}
      {res && res.rsa.meanDiff != null && (
        <p className="muted num" style={{ fontSize: 18 }}>
          الفرق شهيق − زفير: {res.rsa.meanDiff.toFixed(1)} نبضة/دقيقة · {res.rsa.consistent} من {BREATH.breaths} أنفاس بنفس الاتجاه
        </p>
      )}
      {!ok && <p className="muted">ممكن السبب حركة، ضو خفيف، أو النفس كان سريع. مش مشكلة — هاد تمرين بس، وقراءتك محفوظة زي ما هي.</p>}
      <div className="spacer" />
      <button className="btn primary block" onClick={onNext}>التالي: احكيلنا شو بتحس</button>
      <button className="btn ghost block" onClick={() => { setElapsed(null); setRun((r) => r + 1); setMode('run'); }}>أعد التمرين</button>
      <p className="disclaimer" style={{ fontSize: 18 }}>هاد التمرين ما بيدخل بالفرز ولا بينبعت كقياس.</p>
    </div>
  );
}

function RsaChart({ r }: { r: RsaResult }) {
  const W = 300, H = 150, padL = 30, padB = 18, padT = 8;
  const hrs = r.series.map((p) => p.hr);
  const lo = hrs.length ? Math.floor(Math.min(...hrs) - 2) : 60;
  const hi = hrs.length ? Math.ceil(Math.max(...hrs) + 2) : 90;
  const x = (t: number) => padL + (t / BREATH_SECONDS) * (W - padL - 4);
  const y = (hr: number) => padT + (1 - (hr - lo) / Math.max(1, hi - lo)) * (H - padT - padB);
  const cyc = BREATH.inhale + BREATH.exhale;
  const pts = r.series.map((p) => `${x(p.t).toFixed(1)},${y(p.hr).toFixed(1)}`).join(' ');
  return (
    <div className="card stack">
      <svg className="breath-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="النبض اللحظي مع مناطق الشهيق">
        {Array.from({ length: BREATH.breaths }, (_, k) => (
          <rect key={k} x={x(k * cyc)} y={padT} width={x(k * cyc + BREATH.inhale) - x(k * cyc)} height={H - padT - padB} fill="var(--hrv)" fillOpacity={0.14} />
        ))}
        <line x1={padL} x2={W - 4} y1={H - padB} y2={H - padB} stroke="var(--line-2)" />
        <text x={padL - 4} y={y(hi) + 4} textAnchor="end" fontSize="10" fill="var(--muted)" fontFamily="var(--mono)">{hi}</text>
        <text x={padL - 4} y={y(lo)} textAnchor="end" fontSize="10" fill="var(--muted)" fontFamily="var(--mono)">{lo}</text>
        {[0, 5, 10, 15].map((s) => <text key={s} x={x(s)} y={H - 4} textAnchor="middle" fontSize="10" fill="var(--muted)" fontFamily="var(--mono)">{s}s</text>)}
        {pts && <polyline points={pts} fill="none" stroke="var(--hr)" strokeWidth="2" strokeLinejoin="round" />}
        {r.series.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.hr)} r="2.5" fill="var(--hr)" />)}
      </svg>
      <div className="breath-legend">
        <span><i style={{ background: 'var(--hrv)', opacity: 0.4 }} />شهيق</span>
        <span><i style={{ background: 'var(--hr)' }} />النبض اللحظي (نبضة/دقيقة)</span>
      </div>
      {r.series.length < 4 && <p className="muted" style={{ fontSize: 18 }}>عدد النبضات اللي لقطناها قليل ({r.beats}).</p>}
    </div>
  );
}

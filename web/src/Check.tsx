import { useEffect, useRef, useState } from 'react';
import { api, LEVEL, type Checkin, type Patient, type Vitals } from './api';
import { Brand, Conf, confLabel, STRESS_AR, Wave } from './components';
import { VitalsEngine, loadLandmarker, type LiveUpdate, type VitalsResult } from './vitals/engine';
import DebugOverlay from './DebugOverlay';
import { flagSummary, getFlags, isDebug, scanMode } from './config';
import { HardenedEngine, type GateCode, type HardLiveUpdate } from './vitals/engine2';
import { REASON_AR } from './vitals/diag';
import EmergencyStatus from './EmergencyStatus'; // v2 center
import { ContextQuestions, MultiScan, ProtocolSummary, ReminderButton } from './protocol/ProtocolSteps';
import { Breathing } from './protocol/BreathingCheck';
import { contextFields, type CheckContext } from './protocol/context';
import Chat from './Chat'; // patient chatbot «اسأل لمحة»

export type ScanResult = VitalsResult & { diagnostics_id?: string | null };

/** Send the numbers-only diagnostics for every scan (also failed ones). Never blocks the patient. */
async function logScan(r: VitalsResult, attempt: number): Promise<string | null> {
  const flags = getFlags();
  if (!flags.diagnostics || !r.diagnostics) return null;
  try {
    const { bvp_preview: _b, diagnostics, ...vitals } = r;
    const res = await api.diagnostics({ kind: 'scan', attempt, flags: flagSummary(flags), page: window.location.hash.split('?')[0], vitals, ...diagnostics });
    return res.id;
  } catch {
    return null;
  }
}

type Step = 'home' | 'who' | 'consent' | 'context' | 'scan' | 'vitals' | 'breathing' | 'voice' | 'sending' | 'result';
const SCAN_SECONDS = 30;

export default function Check() {
  const [step, setStep] = useState<Step>('home');
  const [mode, setMode] = useState<'face' | 'finger'>('face');
  const [poorCount, setPoorCount] = useState(0);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [vitals, setVitals] = useState<VitalsResult | null>(null);
  const [refHr, setRefHr] = useState('');
  const [checkin, setCheckin] = useState<Checkin | null>(null);
  const [sendErr, setSendErr] = useState('');
  const [flags] = useState(getFlags);
  const [ctx, setCtx] = useState<CheckContext | null>(null);
  const ORDER: Step[] = ['who', 'consent', ...(flags.contextQuestions ? ['context' as const] : []), 'scan', 'vitals', ...(flags.breathing ? ['breathing' as const] : []), 'voice', 'result'];
  const idx = ORDER.indexOf(step === 'sending' ? 'result' : step);

  useEffect(() => {
    loadLandmarker().catch(() => undefined); // warm the face model while the user reads
    window.scrollTo(0, 0);
  }, [step]);

  const send = async (transcript: string, source: Checkin['transcript_source']) => {
    if (!patient || !vitals) return;
    setStep('sending');
    setSendErr('');
    const ref = parseFloat(refHr);
    const { diagnostics: _d, diagnostics_id, beat_times_s: _bt, ...rest } = vitals as ScanResult;
    const v: Vitals = { ...rest, ref_hr_bpm: Number.isFinite(ref) && ref > 30 && ref < 220 ? ref : null, ...contextFields(ctx, rest.quality) };
    try {
      setCheckin(await api.checkin({ patient_id: patient.id, vitals: v, transcript, transcript_source: source, diagnostics_id, voice_markers: source === 'voice' ? lastVoiceMarkers : null }));
      setStep('result');
    } catch (e) {
      setSendErr(e instanceof Error ? e.message : String(e));
    }
  };

  const restart = () => {
    setVitals(null); setCheckin(null); setRefHr(''); setSendErr(''); setCtx(null);
    setStep(flags.contextQuestions ? 'context' : 'scan');
  };

  return (
    <div className="app">
      <div className="topbar">
        <Brand />
        {step !== 'home' ? (
          <div className="step-dots" aria-label="progress">{ORDER.map((s, i) => <i key={s} className={i <= idx ? 'on' : ''} />)}</div>
        ) : (
          <a className="chip" href="#/doctor">لوحة الطبيب</a>
        )}
      </div>
      {step === 'home' && <Home onStart={() => setStep('who')} />}
      {step === 'who' && <Who onPick={(p) => { setPatient(p); setStep('consent'); }} />}
      {step === 'consent' && <Consent pid={patient?.id} onOk={() => setStep(flags.contextQuestions ? 'context' : 'scan')} />}
      {step === 'context' && <ContextQuestions hasConditions={!!patient?.conditions_ar.length} onDone={(c) => { setCtx(c); setStep('scan'); }} />}
      {step === 'scan' && (flags.twoReadings && mode === 'face'
        ? <MultiScan Scanner={CameraScan} seconds={SCAN_SECONDS} onDone={(v) => { setVitals(v); if (v.quality === 'poor') setPoorCount((c) => c + 1); setStep('vitals'); }} />
        : <Scan seconds={SCAN_SECONDS} mode={mode} onDone={(v) => { setVitals(v); if (v.quality === 'poor') setPoorCount((c) => c + 1); setStep('vitals'); }} />)}
      {step === 'vitals' && vitals && (
        <VitalsView v={vitals} refHr={refHr} setRefHr={setRefHr} onRetry={() => setStep('scan')} onNext={() => setStep(flags.breathing && mode === 'face' ? 'breathing' : 'voice')}
          extra={<ProtocolSummary v={vitals} ctx={ctx} />}
          fingerOffer={getFlags().fingertip && mode === 'face' && poorCount >= 2 ? () => { setMode('finger'); setStep('scan'); } : undefined} />
      )}
      {step === 'breathing' && <Breathing Scanner={CameraScan} onNext={() => setStep('voice')} />}
      {step === 'voice' && <Voice onSend={send} />}
      {step === 'sending' && <Sending error={sendErr} onRetry={() => setStep('voice')} />}
      {step === 'result' && checkin && <Result c={checkin} onAgain={restart} />}
    </div>
  );
}

function Home({ onStart }: { onStart: () => void }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => { setT(performance.now() / 1000); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  // Decorative monitor trace (illustrative only — not a measurement).
  const wave = Array.from({ length: 120 }, (_, i) => {
    const x = t * 1.2 + i / 40;
    const ph = x % 1;
    return ph < 0.08 ? Math.sin((ph / 0.08) * Math.PI) * 0.9 : ph < 0.2 ? -Math.sin(((ph - 0.08) / 0.12) * Math.PI) * 0.25 : Math.sin(((ph - 0.2) / 0.8) * Math.PI) * 0.12;
  });
  return (
    <div className="screen">
      <div className="hero-monitor">
        <h1>فحص صحي بلمحة.<br /><span className="hr">30 ثانية</span> قدّام كاميرا موبايلك.</h1>
        <p className="lead" style={{ marginTop: 10 }}>بدون أي جهاز طبي: النبض، التنفس، ومؤشر التوتر — وبتحكي شو بيوجعك بلهجتك، والملخص بيوصل لطبيبك.</p>
        <div style={{ marginTop: 16 }}><Wave data={wave} height={70} /></div>
        <div className="hero-vitals">
          <div><b className="hr">♥</b><span>نبض من لون الوجه</span></div>
          <div><b className="rr">≋</b><span>تنفس من حركة الصدر</span></div>
          <div><b className="hrv">◔</b><span>توتر من تقلّب النبض</span></div>
        </div>
      </div>
      <button className="btn primary block" onClick={onStart}>ابدأ الفحص</button>
      <div className="card howto">
        <h3>كيف بيشتغل؟</h3>
        <ol>
          <li><span className="n">1</span><div><b>وجّه الكاميرا لوجهك 30 ثانية</b><p className="muted">الموبايل بيقرأ تغيّرات لون الجلد الدقيقة مع كل نبضة (rPPG). الفيديو ما بيطلع من جهازك.</p></div></li>
          <li><span className="n">2</span><div><b>احكي شو بتحس</b><p className="muted">بالعامية، زي ما بتحكي للدكتور. الذكاء الاصطناعي بيفهم ويرتّب الأعراض.</p></div></li>
          <li><span className="n">3</span><div><b>بتعرف خطوتك الجاي</b><p className="muted">طارئ، موعد، أو متابعة — والطبيب بيشوف ملخصك ومنحنى حالتك.</p></div></li>
        </ol>
      </div>
      <p className="disclaimer">لمحة أداة فرز ومتابعة، مش تشخيص طبي. بالحالات الطارئة اتصل 911.</p>
    </div>
  );
}

function Who({ onPick }: { onPick: (p: Patient) => void }) {
  const [list, setList] = useState<Patient[] | null>(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.publicPatients().then(setList).catch((e) => setErr(String(e.message ?? e))); }, []);
  const create = async () => {
    setBusy(true);
    try {
      onPick(await api.createPatient({ name_ar: name.trim() || 'زائر', age: age ? parseInt(age, 10) : null }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="screen">
      <h2>مين عم يعمل الفحص؟</h2>
      <div className="card stack">
        <h3>أول مرة؟ (للحكام والزوار)</h3>
        <div className="field"><label htmlFor="nm">الاسم</label><input id="nm" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً: سارة" /></div>
        <div className="field"><label htmlFor="ag">العمر (اختياري)</label><input id="ag" className="input num" style={{ textAlign: 'right' }} inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, '').slice(0, 3))} /></div>
        <button className="btn primary block" onClick={create} disabled={busy}>{busy ? '...' : 'متابعة'}</button>
      </div>
      {err && <div className="err">ما قدرنا نوصل لخادم العيادة: {err}</div>}
      {list && list.length > 0 && (
        <>
          <h3>أو اختار ملف مريض (بيانات محاكاة)</h3>
          <div className="pick">
            {list.map((p) => (
              <button key={p.id} onClick={() => onPick(p)}>
                <span className="avatar">{p.name_ar.replace(/^(الحاجة|الحاج|أبو|أم)\s+/, '').trim()[0]}</span>
                <span style={{ flex: 1 }}>
                  <b>{p.name_ar}</b>
                  <span className="muted" style={{ display: 'block', fontSize: 13 }}>{p.age ? `${p.age} سنة · ` : ''}{p.location_ar}{p.conditions_ar.length ? ` · ${p.conditions_ar.join('، ')}` : ''}</span>
                </span>
                {p.simulated && <span className="sim-tag">محاكاة</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Consent({ onOk, pid }: { onOk: () => void; pid?: string }) {
  const [ok, setOk] = useState(false);
  const [share, setShare] = useState({ share_emergency: true, notify_family: false, receive_report: false }); // v2 center
  const SHARE = [['share_emergency', 'مشاركة حالتي مع أقرب مركز بالطوارئ'], ['notify_family', 'تنبيه شخص من عيلتي'], ['receive_report', 'إرسال التقرير على موبايلي']] as const;
  const go = () => { if (pid) fetch(`/api/patients/${pid}/consent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(share) }).catch(() => undefined); onOk(); };
  return (
    <div className="screen">
      <h2>قبل ما نبلّش — خصوصيتك</h2>
      <div className="card consent">
        <ul>
          <li><b style={{ color: 'var(--text)' }}>الفيديو ما بيطلع من موبايلك.</b> الحساب كله بيصير على جهازك. اللي بيتخزن: الأرقام (النبض، التنفس، التوتر)، ونص كلامك، والملخص.</li>
          <li><b style={{ color: 'var(--text)' }}>صوتك</b> بيروح مشفّر لخادم العيادة، بيتحوّل لنص، وبينحذف فوراً. ما في أي خدمة ذكاء اصطناعي سحابية — الموديلات مفتوحة وشغّالة على جهاز العيادة.</li>
          <li><b style={{ color: 'var(--text)' }}>هاي أداة فرز مش تشخيص.</b> القرار النهائي للطبيب. إذا حاسس بخطر هلّق، اتصل 911.</li>
          <li>القراءة بتتأثر بالضو والحركة. إذا الثقة منخفضة رح نطلب منك تعيد.</li>
        </ul>
      </div>
      <label className="check">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
        <span>فهمت وبوافق على الفحص ومشاركة الأرقام والملخص مع طبيبي.</span>
      </label>
      {SHARE.map(([k, label]) => (
        <label key={k} className="check"><input type="checkbox" checked={share[k]} onChange={(e) => setShare({ ...share, [k]: e.target.checked })} /><span>{label}</span></label>
      ))}
      <div className="spacer" />
      <button className="btn primary block" disabled={!ok} onClick={go}>افتح الكاميرا</button>
    </div>
  );
}

const GUIDE: Record<string, string> = {
  'no-face': 'وجّه الكاميرا على وجهك',
  dark: 'الضو خفيف — قرّب من الشباك أو شغّل ضو',
  move: 'ثبّت راسك وما تحكي',
  ok: 'ممتاز… خليك ثابت وتنفّس طبيعي',
};

let scanAttempt = 0;
let lastVoiceMarkers: Record<string, unknown> | null = null;

const GATE_AR: Record<GateCode, string> = {
  'no-face': 'وجّه الكاميرا على وجهك',
  far: 'قرّب وجهك',
  backlit: 'خلّي الضو قدّامك مش وراك',
  dark: 'خلّي الضو قدّامك مش وراك',
  overexposed: 'الإضاءة قوية كثير',
  move: 'ثبّت الموبايل',
  pose: 'اتطلّع على الكاميرا مباشرة',
  no_finger: 'غطّي الكاميرا والفلاش بإصبعك',
};

/** The hardened engine is used unless every hardening flag is off (flags=all-off → original engine). */
function wantHardened() {
  const f = getFlags();
  return f.frameCallback || f.polygonRoi || f.skinMask || f.headPose || f.preScanGate || f.multiAlgo || f.adaptiveExtend || f.qualityScore;
}

export function CameraScan({ seconds, onDone, onLive, mode }: { seconds: number; onDone: (v: ScanResult) => void; onLive?: (u: LiveUpdate) => void; mode?: 'face' | 'finger' }) {
  const debug = isDebug();
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [u, setU] = useState<HardLiveUpdate | null>(null);
  const done = useRef(false);
  const engRef = useRef<{ forceStart?: () => void } | null>(null);
  const m = mode ?? scanMode();
  useEffect(() => {
    done.current = false;
    const attempt = ++scanAttempt;
    const hardened = wantHardened() || m === 'finger';
    const handler = (up: HardLiveUpdate) => {
      setU(up);
      onLive?.(up);
      if (up.phase === 'analyzing' && !done.current) {
        done.current = true;
        // let the "analyzing" frame paint before the heavy pass
        setTimeout(async () => {
          const r: ScanResult = eng.result();
          eng.stop();
          r.diagnostics_id = await logScan(r, attempt);
          onDone(r);
        }, 30);
      }
    };
    const eng = hardened
      ? new HardenedEngine(video.current!, canvas.current!, seconds, handler, { flags: getFlags(), debug, mode: m, maxSeconds: 45 })
      : new VitalsEngine(video.current!, canvas.current!, seconds, handler, { debug });
    engRef.current = eng as { forceStart?: () => void };
    eng.start().catch(() => undefined);
    // Keep the screen awake: iOS Low Power Mode auto-locks after 30 s, which would freeze the scan.
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => undefined);
    return () => { eng.stop(); lock?.release().catch(() => undefined); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, m]);
  const target = u?.target ?? seconds;
  const remaining = Math.max(0, Math.ceil(target - (u?.elapsed ?? 0)));
  const scanning = u?.phase === 'scanning';
  const gate = u?.gate;
  const gateMsg = gate ? (gate.code ? GATE_AR[gate.code] : `ممتاز — خليك هيك (${Math.max(0, Math.ceil(2 - gate.passFor))})`) : null;
  const msg = !u || u.phase === 'loading' ? 'عم نجهّز الكاميرا والموديل…'
    : u.phase === 'waiting-face' ? (gateMsg ?? GUIDE['no-face'])
    : u.phase === 'analyzing' ? 'عم نحلل الإشارة…'
    : u.extending ? 'الإشارة مش واضحة كفاية — بنكمّل كم ثانية كمان…'
    : m === 'finger' ? 'خلّي إصبعك ثابت على الكاميرا والفلاش' : GUIDE[u.guidance];
  const warn = u && ((gate && gate.code) || u.guidance !== 'ok' || u.extending) && u.phase !== 'loading';
  return (
    <>
      <div className="cam">
        <video ref={video} playsInline muted />
        <canvas ref={canvas} />
        {m === 'face' && <div className="face-oval" style={{ opacity: scanning ? 0 : 1 }} />}
        <div className="hud">
          <div className="hud-pill">
            <div className="row" style={{ gap: 8 }}>
              <span className="beat hr" style={{ ['--beat' as string]: u?.liveHr ? `${60 / u.liveHr}s` : '1s', fontSize: 22 }}>♥</span>
              <b className="hr num">{u?.liveHr && (u.elapsed ?? 0) > 8 ? Math.round(u.liveHr) : '--'}</b>
            </div>
            <span className="dim" style={{ fontSize: 11 }}>تقدير مباشر</span>
          </div>
          <div className="hud-pill" style={{ textAlign: 'center' }}>
            <b className="num">{scanning || u?.phase === 'analyzing' ? remaining : seconds}</b>
            <div className="dim" style={{ fontSize: 11 }}>ثانية</div>
          </div>
        </div>
        <div className="guide" style={{ color: warn ? 'var(--apt)' : 'var(--text)' }} role="status" aria-live="polite">{msg}</div>
      </div>
      <div className="conf" style={{ height: 6 }}><i style={{ width: `${(u?.progress ?? 0) * 100}%`, background: 'var(--hr)', transition: 'width .3s linear' }} /></div>
      <Wave data={u?.wave ?? []} />
      {gate && (
        <div className="row wrap" style={{ gap: 6, justifyContent: 'center' }}>
          {Object.entries(gate.checks).map(([k, ok]) => (
            <span key={k} className="chip" style={{ color: ok ? 'var(--fu)' : 'var(--apt)' }}>{ok ? '✓' : '•'} {CHECK_AR[k] ?? k}</span>
          ))}
          {gate.lowFps && <span className="chip" style={{ color: 'var(--apt)' }}>الكاميرا بطيئة على هالجهاز</span>}
        </div>
      )}
      {gate?.stuck && <button className="btn ghost block" onClick={() => engRef.current?.forceStart?.()}>ابدأ القياس على كل حال</button>}
      {debug && <DebugOverlay d={u?.debug} />}
      {u?.phase === 'error' && (
        <div className="err">ما قدرنا نفتح الكاميرا ({u.error}). تأكد إنك سمحت للمتصفح يستخدم الكاميرا وإن الرابط https.</div>
      )}
    </>
  );
}

const CHECK_AR: Record<string, string> = { close: 'المسافة', light: 'الإضاءة', exposure: 'السطوع', still: 'الثبات', frontal: 'الاتجاه', finger: 'الإصبع' };

const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

function Scan({ seconds, onDone, mode = 'face' }: { seconds: number; onDone: (v: VitalsResult) => void; mode?: 'face' | 'finger' }) {
  return (
    <div className="screen" style={{ gap: 12 }}>
      {mode === 'finger' && (
        <div className="card">
          <b>وضع الإصبع</b>
          <p className="muted">{IOS ? 'غطّي الكاميرا الخلفية بإصبعك بهدوء، وخلّي ضو قوي (لمبة أو شباك) يضرب على إصبعك من فوق.' : 'غطّي الكاميرا والفلاش بإصبعك بهدوء. الفلاش رح يشتغل لحاله.'}</p>
        </div>
      )}
      <CameraScan seconds={seconds} onDone={onDone} mode={mode} />
      <p className="muted" style={{ fontSize: 14, textAlign: 'center' }}>المربعات الخضرا هي مناطق الجلد اللي بنقرأ منها النبض — بتلمع على إيقاع النبض المقدَّر. المستطيل الأصفر بيلقط حركة التنفس.</p>
    </div>
  );
}

function VitalsView({ v, refHr, setRefHr, onRetry, onNext, fingerOffer, extra }: { v: VitalsResult; refHr: string; setRefHr: (s: string) => void; onRetry: () => void; onNext: () => void; fingerOffer?: () => void; extra?: import('react').ReactNode }) {
  const poor = v.quality === 'poor';
  return (
    <div className="screen">
      <div className="row between">
        <h2>قراءتك</h2>
        <span className="chip"><span className="dot" style={{ color: v.quality === 'good' ? 'var(--hr)' : v.quality === 'fair' ? 'var(--apt)' : 'var(--emg)' }} />جودة الإشارة: {v.quality === 'good' ? 'جيدة' : v.quality === 'fair' ? 'مقبولة' : 'ضعيفة'}</span>
      </div>
      {poor && (
        <div className="err">
          ما قدرنا نقيس بدقة. السبب على الأغلب:
          <ul style={{ margin: '6px 0 0', paddingInlineStart: 20 }}>
            {(v.quality_reasons?.length ? v.quality_reasons : ['low_snr']).slice(0, 3).map((r) => <li key={r}>{REASON_AR[r] ?? r}</li>)}
          </ul>
        </div>
      )}
      {extra}
      <div className="vgrid">
        <div className="vtile wide">
          <div className="lbl"><span>نبض القلب</span><span>{confLabel(v.hr_confidence)}</span></div>
          <div className="val hr">{v.hr_bpm != null ? Math.round(v.hr_bpm) : '--'}<small>bpm</small></div>
          <Conf value={v.hr_confidence} color="var(--hr)" />
          <div style={{ marginTop: 8 }}><Wave data={v.bvp_preview} height={48} /></div>
        </div>
        <div className="vtile">
          <div className="lbl"><span>التنفس</span><span>{confLabel(v.rr_confidence)}</span></div>
          <div className="val rr">{v.rr_bpm != null ? Math.round(v.rr_bpm) : '--'}<small>/min</small></div>
          <Conf value={v.rr_confidence} color="var(--rr)" />
        </div>
        <div className="vtile">
          <div className="lbl"><span>مؤشر التوتر</span><span>تجريبي</span></div>
          <div className="val hrv">{v.stress_index ?? '--'}<small>/100</small></div>
          <div className="sub">{v.stress_level ? `${STRESS_AR[v.stress_level]} · تجريبي، مش للتشخيص` : 'الإشارة مش كافية لحساب التوتر'}</div>
        </div>
      </div>
      <div className="card stack">
        <h3>عندك ساعة ذكية أو جهاز نبض؟ (اختياري)</h3>
        <p className="muted" style={{ fontSize: 14 }}>اكتب الرقم اللي عليه هلّق — بنستخدمه بس لقياس دقة لمحة بشكل شفاف.</p>
        <input className="input num" style={{ textAlign: 'right' }} inputMode="numeric" placeholder="مثلاً 74" value={refHr} onChange={(e) => setRefHr(e.target.value.replace(/[^\d.]/g, '').slice(0, 5))} />
        {refHr && v.hr_bpm != null && Number.isFinite(parseFloat(refHr)) && (
          <p className="num" style={{ textAlign: 'right' }}>Δ = {Math.abs(v.hr_bpm - parseFloat(refHr)).toFixed(1)} bpm</p>
        )}
      </div>
      <div className="row">
        {fingerOffer && <button className="btn" onClick={fingerOffer}>جرّب بإصبعك</button>}
        <button className="btn ghost" onClick={onRetry}>إعادة</button>
        <button className="btn primary" style={{ flex: 1 }} onClick={onNext}>التالي: احكيلنا شو بتحس</button>
      </div>
      <p className="disclaimer">تقديرات من الكاميرا، مش قياس طبي معتمد. {v.scan_seconds.toFixed(0)} ث · {v.fps.toFixed(0)} fps</p>
    </div>
  );
}

function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function Voice({ onSend }: { onSend: (t: string, src: Checkin['transcript_source']) => void }) {
  const [mode, setMode] = useState<'idle' | 'rec' | 'stt' | 'review' | 'type'>('idle');
  const [text, setText] = useState('');
  const [src, setSrc] = useState<Checkin['transcript_source']>('voice');
  const [lvl, setLvl] = useState(0);
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const cleanup = useRef<() => void>(() => undefined);
  useEffect(() => () => cleanup.current(), []);

  const start = async () => {
    setErr('');
    // iOS only lets an AudioContext run if it is created inside the tap, before any await.
    const ac = new AudioContext();
    ac.resume().catch(() => undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = pickMime();
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const an = ac.createAnalyser();
      an.fftSize = 512;
      ac.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      let raf = 0;
      const t0 = performance.now();
      const meter = () => {
        an.getByteTimeDomainData(buf);
        let s = 0;
        for (const b of buf) s += ((b - 128) / 128) ** 2;
        setLvl(Math.min(1, Math.sqrt(s / buf.length) * 4));
        const el = (performance.now() - t0) / 1000;
        setSecs(el);
        if (el > 30 && mr.state === 'recording') mr.stop();
        raf = requestAnimationFrame(meter);
      };
      meter();
      cleanup.current = () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); ac.close().catch(() => undefined); };
      mr.onstop = async () => {
        cleanup.current();
        setMode('stt');
        try {
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
          const r = await api.transcribe(blob);
          lastVoiceMarkers = r.voice_markers ?? null; // v2 insights: pauses / words per breath / speech rate
          setText(r.text.trim());
          setSrc('voice');
          setMode('review');
        } catch (e) {
          setErr(`ما زبط تحويل الصوت لنص: ${e instanceof Error ? e.message : e}. فيك تكتب بدالها.`);
          setMode('type');
        }
      };
      mr.start();
      rec.current = mr;
      setMode('rec');
    } catch (e) {
      ac.close().catch(() => undefined);
      setErr(`ما قدرنا نفتح المايك: ${e instanceof Error ? e.message : e}`);
      setMode('type');
    }
  };

  return (
    <div className="screen">
      <h2>احكيلنا شو بتحس</h2>
      <p className="lead">بالعامية، زي ما بتحكي للدكتور. مثلاً: «من مبارح نفسي ضيق وراسي بيوجعني».</p>
      {(mode === 'idle' || mode === 'rec') && (
        <>
          <button className={`mic ${mode === 'rec' ? 'on' : ''}`} onClick={() => (mode === 'rec' ? rec.current?.stop() : start())} aria-label={mode === 'rec' ? 'وقّف التسجيل' : 'ابدأ التسجيل'}>
            {mode === 'rec' && <span className="lvl" style={{ transform: `scale(${1 + lvl * 0.35})` }} />}
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke={mode === 'rec' ? 'var(--emg)' : 'var(--hr)'} strokeWidth="2" strokeLinecap="round">
              {mode === 'rec' ? <rect x="7" y="7" width="10" height="10" rx="2" fill="var(--emg)" /> : (<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>)}
            </svg>
          </button>
          <p style={{ textAlign: 'center' }} className={mode === 'rec' ? 'emg' : 'muted'}>
            {mode === 'rec' ? <>عم نسجّل… <span className="num">{Math.floor(secs)}</span> ث — اضغط لما تخلّص</> : 'اضغط واحكي (لحد 30 ثانية)'}
          </p>
        </>
      )}
      {mode === 'stt' && (
        <div className="card" style={{ textAlign: 'center' }}>
          <div className="spinner" />
          <p>Whisper عم يحوّل صوتك لنص… (على خادم العيادة)</p>
        </div>
      )}
      {(mode === 'review' || mode === 'type') && (
        <div className="stack">
          <div className="field">
            <label htmlFor="tx">{mode === 'review' ? 'هيك فهمنا — فيك تعدّل' : 'اكتب شو بتحس'}</label>
            <textarea id="tx" className="input" value={text} onChange={(e) => { setText(e.target.value); if (mode === 'type') setSrc('typed'); }} />
          </div>
          <button className="btn primary block" disabled={!text.trim()} onClick={() => onSend(text.trim(), src)}>أرسل للطبيب</button>
          {mode === 'review' && <button className="btn ghost block" onClick={() => { setText(''); setMode('idle'); }}>سجّل مرة ثانية</button>}
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <div className="spacer" />
      {(mode === 'idle') && (
        <div className="row">
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => { setSrc('typed'); setMode('type'); }}>بدّي أكتب</button>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => onSend('', 'none')}>ما في أعراض</button>
        </div>
      )}
    </div>
  );
}

function Sending({ error, onRetry }: { error: string; onRetry: () => void }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSecs((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const steps = ['استخراج الأعراض من كلامك (موديل مفتوح على جهاز العيادة)', 'التحقق إنه كل عرض مذكور حرفياً بكلامك', 'فحص علامات الخطر بقواعد طبية ثابتة', 'مقارنة قراءتك بمعدلك آخر 14 يوم'];
  return (
    <div className="screen">
      <h2>عم نجهّز ملخصك للطبيب</h2>
      {!error && <div className="spinner" />}
      {!error && <p className="muted num" style={{ textAlign: 'center' }}>{secs} s</p>}
      <div className="card steps-live">
        <h3>شو عم يصير هلّق على خادم العيادة</h3>
        {steps.map((s) => (
          <div key={s} className="on"><span className="hr">•</span><span>{s}</span></div>
        ))}
      </div>
      {error && (
        <>
          <div className="err">ما قدرنا نرسل: {error}</div>
          <button className="btn block" onClick={onRetry}>رجوع</button>
        </>
      )}
    </div>
  );
}

function Result({ c, onAgain }: { c: Checkin; onAgain: () => void }) {
  const L = LEVEL[c.triage.level];
  const v = c.vitals;
  return (
    <div className="screen">
      {c.triage.level === 'emergency' && <EmergencyStatus alertId={c.alert_id} />}
      <div className={`triage ${L.cls}`}>
        <span className="muted" style={{ fontSize: 13 }}>النتيجة</span>
        <span className={`big ${L.cls}`}>{L.ar}</span>
        <p style={{ fontSize: 18 }}>{c.vitals.quality === 'poor' && c.triage.level === 'followup' ? 'ما قدرنا نقيس بدقة هالمرة — أعد الفحص بضو أقوى' : L.patient}</p>
        {c.ai.advice_ar && <p className="muted">{c.ai.advice_ar}</p>}
      </div>
      {c.trend_alerts.length > 0 && (
        <div className="card stack">
          <h3>تغيّر عن معدلك</h3>
          {c.trend_alerts.map((t) => <p key={t.metric} className="apt">▲ {t.label_ar}</p>)}
        </div>
      )}
      {c.symptoms.length > 0 && (
        <div className="card stack">
          <h3>الأعراض اللي فهمناها من كلامك</h3>
          <div className="syms">
            {c.symptoms.map((s, i) => (
              <span key={i} className={`sym ${s.verified ? '' : 'unv'}`}>{s.label_ar}<q>{s.span}</q></span>
            ))}
          </div>
        </div>
      )}
      <div className="vgrid">
        <div className="vtile"><div className="lbl">نبض</div><div className="val hr" style={{ fontSize: 32 }}>{v.hr_bpm != null ? Math.round(v.hr_bpm) : '--'}</div></div>
        <div className="vtile"><div className="lbl">تنفس</div><div className="val rr" style={{ fontSize: 32 }}>{v.rr_bpm != null ? Math.round(v.rr_bpm) : '--'}</div></div>
      </div>
      <div className="card row"><span className="hr" style={{ fontSize: 20 }}>✓</span><span>وصل ملخصك للطبيب. القرار النهائي إله.</span></div>
      {getFlags().report && <a className="btn block" href={`#/report/${c.id}`} style={{ textDecoration: 'none' }}>شوف تقريري</a>}
      <button className="btn block" onClick={onAgain}>فحص جديد</button>
      <ReminderButton />
      <p className="disclaimer">أداة فرز مش تشخيص · الموديل: {c.ai.ok ? c.ai.model : 'قواعد فقط'}</p>
      <Chat checkinId={c.id} />
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, LEVEL, levelRank, type Checkin, type Health, type Level, type PatientDetail, type PatientSummary, type Validation } from './api';
import { Brand, Conf, confLabel, LevelBadge, Qr, Sparkline, STRESS_AR, timeAgo, TrendChart, useInterval, Wave } from './components';
import { ForecastCard } from './ForecastCard';

const finalLevel = (c: Checkin | null): Level | null => (c ? c.review?.final_level ?? c.triage.level : null);

function beep(level: Level) {
  try {
    const ac = new AudioContext();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.value = level === 'emergency' ? 880 : 660;
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ac.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.35);
    o.connect(g).connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.4);
  } catch { /* audio not allowed yet */ }
}

export default function Doctor() {
  const [tab, setTab] = useState<'queue' | 'accuracy'>('queue');
  const [patients, setPatients] = useState<PatientSummary[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState<{ text: string; level: Level } | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const seen = useRef<Map<string, string>>(new Map());
  const first = useRef(true);

  const load = async () => {
    try {
      const list = await api.patients();
      setErr('');
      const newly = new Set<string>();
      for (const p of list) {
        const id = p.latest?.id ?? '';
        const prev = seen.current.get(p.id);
        if (!first.current && id && prev !== id) newly.add(p.id);
        seen.current.set(p.id, id);
      }
      if (newly.size) {
        const p = list.find((x) => newly.has(x.id))!;
        const lvl = finalLevel(p.latest)!;
        setToast({ text: `فحص جديد: ${p.name_ar} — ${LEVEL[lvl].ar}`, level: lvl });
        beep(lvl);
        setFresh(newly);
        setSel((s) => (s && !first.current && lvl !== 'emergency' ? s : p.id));
        setTimeout(() => setFresh(new Set()), 2400);
        setTimeout(() => setToast(null), 5000);
      }
      first.current = false;
      setPatients(list);
      setSel((s) => s ?? list[0]?.id ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => { load(); api.health().then(setHealth).catch(() => undefined); }, []);
  useInterval(load, 3000);
  useInterval(() => api.health().then(setHealth).catch(() => setHealth(null)), 10000);

  const groups = useMemo(() => {
    const g: Record<Level, PatientSummary[]> = { emergency: [], appointment: [], followup: [] };
    for (const p of patients) g[finalLevel(p.latest) ?? 'followup'].push(p);
    return g;
  }, [patients]);
  const selected = patients.find((p) => p.id === sel) ?? null;
  // On localhost the QR would point phones nowhere, so let the operator paste the HTTPS tunnel link.
  const isLocal = /^(localhost|127\.|\[::1\])/.test(window.location.hostname);
  const [shareUrl, setShareUrl] = useState(() => {
    try { return localStorage.getItem('nazra.shareUrl') ?? ''; } catch { return ''; }
  });
  const origin = isLocal && shareUrl ? shareUrl.replace(/\/+$/, '').replace(/\/#.*$/, '') : window.location.origin;

  return (
    <div className="dash">
      <header className="dash-top">
        <Brand />
        <span className="muted">لوحة الطبيب</span>
        <span className="chip"><span className="dot live-dot hr" />مباشر</span>
        <div className="grow" />
        <div className="tabs" role="tablist">
          <button className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>طابور الفرز</button>
          <button className={tab === 'accuracy' ? 'on' : ''} onClick={() => setTab('accuracy')}>دقة القياس</button>
        </div>
        <ModelChips h={health} />
      </header>
      {err && <div className="err" style={{ margin: 12 }}>ما في اتصال بخادم العيادة: {err}</div>}
      {tab === 'queue' ? (
        <div className="dash-body">
          <aside className="queue" aria-label="queue">
            {(['emergency', 'appointment', 'followup'] as Level[]).map((lvl) => (
              <div key={lvl} style={{ display: 'grid', gap: 8 }}>
                <div className="qhead"><span className={LEVEL[lvl].cls}>{LEVEL[lvl].ar}</span><span className="num">{groups[lvl].length}</span></div>
                {groups[lvl].map((p) => (
                  <QItem key={p.id} p={p} on={p.id === sel} fresh={fresh.has(p.id)} onClick={() => {
                    setSel(p.id);
                    // On phones the detail sits below the queue.
                    if (window.innerWidth < 760) requestAnimationFrame(() => document.querySelector('.detail')?.scrollIntoView({ behavior: 'smooth' }));
                  }} />
                ))}
              </div>
            ))}
            {!patients.length && !err && <div className="empty">ما في مرضى بعد</div>}
          </aside>
          <main className="detail">{selected ? <Detail summary={selected} onChanged={load} /> : <div className="empty">اختار مريض من الطابور</div>}</main>
          <aside className="side">
            <div className="card stack" style={{ textAlign: 'center' }}>
              <h3>جرّب على حالك</h3>
              <Qr text={`${origin}/#/`} />
              <p className="muted" style={{ fontSize: 13 }}>امسح بكاميرا موبايلك، اعمل الفحص 30 ثانية، وشوف نتيجتك توصل هون مباشرة.</p>
              <p className="num dim" style={{ fontSize: 11, wordBreak: 'break-all' }}>{origin}</p>
              {isLocal && (
                <input className="input num" style={{ fontSize: 12, padding: 8 }} placeholder="الصق رابط https للتنل" value={shareUrl}
                  onChange={(e) => { setShareUrl(e.target.value.trim()); try { localStorage.setItem('nazra.shareUrl', e.target.value.trim()); } catch { /* private mode */ } }} />
              )}
            </div>
            <LiveFeed onPick={setSel} />
            <div className="card stack">
              <h3>كيف بنضمن الأمان</h3>
              <p className="muted" style={{ fontSize: 13 }}>• علامات الخطر بقواعد ثابتة — الذكاء الاصطناعي بيقدر يرفع الخطورة بس، ما بينزّلها.<br />• كل عرض لازم يكون مذكور حرفياً بكلام المريض.<br />• أي رقم بالملخص لازم يطابق القياس، وإلا بنرجع لملخص القواعد.<br />• الفيديو ما بيطلع من موبايل المريض، والصوت بينحذف بعد التحويل.</p>
            </div>
          </aside>
        </div>
      ) : (
        <Accuracy />
      )}
      {toast && <div className={`toast ${toast.level === 'emergency' ? 'emg' : ''}`} role="alert">{toast.text}</div>}
    </div>
  );
}

function ModelChips({ h }: { h: Health | null }) {
  if (!h) return <span className="chip"><span className="dot emg" />الخادم غير متصل</span>;
  return (
    <div className="row" style={{ gap: 6 }}>
      <span className="chip" title={h.whisper.error ?? ''}><span className="dot" style={{ color: h.whisper.ready ? 'var(--hr)' : 'var(--apt)' }} />Whisper {h.whisper.model} · {h.whisper.device}</span>
      <span className="chip" title={h.llm.error ?? ''}><span className="dot" style={{ color: h.llm.ready ? 'var(--hr)' : 'var(--apt)' }} />{h.llm.model} · محلي</span>
    </div>
  );
}

function QItem({ p, on, fresh, onClick }: { p: PatientSummary; on: boolean; fresh: boolean; onClick: () => void }) {
  const lvl = finalLevel(p.latest) ?? 'followup';
  const v = p.latest?.vitals;
  return (
    <button className={`qitem ${on ? 'on' : ''} ${fresh ? 'fresh' : ''}`} onClick={onClick}>
      <span className="bar" style={{ background: `var(--${LEVEL[lvl].cls})` }} />
      <span style={{ minWidth: 0 }}>
        <span className="nm">{p.name_ar}</span>
        <span className="meta" style={{ display: 'block' }}>
          {p.age ? `${p.age} · ` : ''}{p.location_ar}{p.latest ? ` · ${timeAgo(p.latest.created_at)}` : ''}
        </span>
        <span className="meta num" style={{ display: 'block', textAlign: 'right' }}>
          {v?.hr_bpm != null && <span className="hr">♥ {Math.round(v.hr_bpm)}</span>}{'  '}
          {v?.rr_bpm != null && <span className="rr">≋ {Math.round(v.rr_bpm)}</span>}
        </span>
      </span>
      <span style={{ display: 'grid', justifyItems: 'end', gap: 4 }}>
        <Sparkline values={p.history.map((h) => h.hr)} color="var(--hr)" width={72} height={24} />
        {p.latest?.review && <span className="dim" style={{ fontSize: 11 }}>✓ روجع</span>}
        {!p.latest?.review && p.latest?.trend_alerts.length ? <span className="apt" style={{ fontSize: 11 }}>▲ تغيّر</span> : null}
      </span>
    </button>
  );
}

function highlight(text: string, c: Checkin) {
  const marks: { s: number; e: number; flag: boolean }[] = [];
  const add = (span: string, flag: boolean) => {
    if (!span) return;
    const s = text.indexOf(span);
    if (s >= 0 && !marks.some((m) => s < m.e && s + span.length > m.s)) marks.push({ s, e: s + span.length, flag });
  };
  c.red_flags.forEach((f) => add(f.evidence, true));
  c.symptoms.filter((s) => s.verified).forEach((s) => add(s.span, false));
  marks.sort((a, b) => a.s - b.s);
  const out: React.ReactNode[] = [];
  let i = 0;
  marks.forEach((m, k) => {
    if (m.s > i) out.push(text.slice(i, m.s));
    out.push(<mark key={k} className={m.flag ? 'flag' : ''}>{text.slice(m.s, m.e)}</mark>);
    i = m.e;
  });
  out.push(text.slice(i));
  return out;
}

function Detail({ summary, onChanged }: { summary: PatientSummary; onChanged: () => void }) {
  const [d, setD] = useState<PatientDetail | null>(null);
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const [idx, setIdx] = useState(0);
  const latestId = summary.latest?.id;
  useEffect(() => {
    setIdx(0);
    api.patient(summary.id).then(setD).catch(() => setD(null));
  }, [summary.id, latestId]);
  if (!d || d.patient.id !== summary.id) return <div className="spinner" />;
  const c = d.checkins[idx] ?? null;
  const p = d.patient;
  const base = d.baseline;
  const delta = (cur: number | null | undefined, b: number | null | undefined) => (cur != null && b ? Math.round(((cur - b) / b) * 100) : null);
  const lvl = finalLevel(c);
  return (
    <>
      <div className="row between wrap">
        <div>
          <div className="row wrap" style={{ gap: 10 }}>
            <h1 style={{ fontSize: 26 }}>{p.name_ar}</h1>
            {lvl && <LevelBadge level={lvl} />}
            {p.simulated && <span className="sim-tag">بيانات محاكاة</span>}
          </div>
          <p className="muted">{p.name_en} · {p.age ?? '—'} سنة · {p.location_ar}{p.conditions_ar.length ? ` · ${p.conditions_ar.join('، ')}` : ''}</p>
        </div>
        {d.checkins.length > 1 && (
          <select className="input" style={{ width: 'auto', padding: '8px 12px', fontSize: 14 }} value={idx} onChange={(e) => setIdx(+e.target.value)}>
            {d.checkins.slice(0, 20).map((x, i) => <option key={x.id} value={i}>{i === 0 ? 'آخر فحص' : new Date(x.created_at).toLocaleDateString('ar-JO', { day: 'numeric', month: 'short' })} — {LEVEL[finalLevel(x)!].ar}</option>)}
          </select>
        )}
      </div>

      {c ? (
        <>
          <div className={`triage ${LEVEL[c.triage.level].cls}`}>
            <div className="row between wrap">
              <span className={`big ${LEVEL[c.triage.level].cls}`}>{LEVEL[c.triage.level].ar} <span className="dim" style={{ fontSize: 14, fontWeight: 500 }}>{LEVEL[c.triage.level].en}</span></span>
              <span className="muted" style={{ fontSize: 13 }}>{new Date(c.created_at).toLocaleString('ar-JO', { dateStyle: 'medium', timeStyle: 'short' })}</span>
            </div>
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              {(lang === 'ar' ? c.triage.reasons_ar : c.triage.reasons_en).map((r, i) => <li key={i}>{r}</li>)}
            </ul>
            <div className="row wrap" style={{ gap: 8, fontSize: 13 }}>
              <span className="rule-tag">القواعد: {LEVEL[c.triage.rule_level].ar}</span>
              <span className="ai-tag">الذكاء الاصطناعي: {c.triage.ai_level ? LEVEL[c.triage.ai_level].ar : '—'}</span>
              <span className="dim">النهائي = الأعلى. الذكاء الاصطناعي بيرفع الخطورة بس.</span>
            </div>
          </div>

          <div className="dgrid">
            <VitalCard label="النبض" unit="bpm" value={c.vitals.hr_bpm} cls="hr" conf={c.vitals.hr_confidence} delta={delta(c.vitals.hr_bpm, base?.hr)} extra={c.vitals.ref_hr_bpm != null ? `ساعة ذكية: ${c.vitals.ref_hr_bpm}` : undefined} />
            <VitalCard label="التنفس" unit="/min" value={c.vitals.rr_bpm} cls="rr" conf={c.vitals.rr_confidence} delta={delta(c.vitals.rr_bpm, base?.rr)} />
            <VitalCard label="التوتر (تجريبي)" unit="/100" value={c.vitals.stress_index} cls="hrv" delta={delta(c.vitals.stress_index, base?.stress)} extra={c.vitals.stress_level ? `${STRESS_AR[c.vitals.stress_level]}${c.vitals.hrv_rmssd_ms ? ` · RMSSD ${Math.round(c.vitals.hrv_rmssd_ms)} ms` : ''}` : 'غير كافٍ'} />
            <div className="vtile">
              <div className="lbl">إشارة النبض</div>
              <Wave data={c.vitals.bvp_preview ?? []} height={54} />
              <div className="sub">جودة: {c.vitals.quality === 'good' ? 'جيدة' : c.vitals.quality === 'fair' ? 'مقبولة' : 'ضعيفة'} · {Math.round(c.vitals.scan_seconds)} ث</div>
            </div>
          </div>

          {c.trend_alerts.length > 0 && (
            <div className="card row wrap" style={{ borderColor: 'rgba(255,176,32,.5)' }}>
              {c.trend_alerts.map((t) => <span key={t.metric} className="apt">▲ {lang === 'ar' ? t.label_ar : t.label_en}</span>)}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
            <div className="card stack">
              <div className="row between">
                <h3>ملخص للطبيب</h3>
                <div className="seg"><button className={lang === 'ar' ? 'on' : ''} onClick={() => setLang('ar')}>عربي</button><button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button></div>
              </div>
              <p dir={lang === 'en' ? 'ltr' : 'rtl'} style={{ fontSize: 16, lineHeight: 1.8 }}>{lang === 'ar' ? c.ai.summary_ar : c.ai.summary_en}</p>
              <div className="row wrap" style={{ gap: 6, fontSize: 12 }}>
                <span className="ai-tag">{c.ai.model}</span>
                {c.ai.latency_ms > 0 && <span className="chip num" style={{ fontSize: 11 }}>{(c.ai.latency_ms / 1000).toFixed(1)} s</span>}
                <span className="chip" style={{ fontSize: 11, color: c.ai.numbers_verified ? 'var(--hr)' : 'var(--apt)' }}>{c.ai.numbers_verified ? '✓ الأرقام مطابقة للقياس' : '⚠ استُبدل بملخص القواعد'}</span>
                {!c.ai.ok && <span className="chip" style={{ fontSize: 11, color: 'var(--apt)' }}>الموديل ما ردّ — قواعد فقط</span>}
              </div>
            </div>
            <div className="card stack">
              <div className="row between"><h3>كلام المريض</h3><span className="dim" style={{ fontSize: 12 }}>{c.transcript_source === 'voice' ? 'صوت → Whisper' : c.transcript_source === 'typed' ? 'مكتوب' : '—'}</span></div>
              <p className="transcript">{c.transcript ? highlight(c.transcript, c) : <span className="dim">ما ذكر أعراض</span>}</p>
              {c.symptoms.length > 0 && (
                <div className="syms">
                  {c.symptoms.map((s, i) => (
                    <span key={i} className={`sym ${s.verified ? '' : 'unv'}`} title={s.verified ? 'مذكور حرفياً' : 'غير مطابق للنص — مستبعد من الفرز'}>
                      {lang === 'ar' ? s.label_ar : s.label_en}{s.severity ? ` · ${s.severity}` : ''}{s.duration ? ` · ${s.duration}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card stack">
            <div className="row between"><h3>منحنى آخر 14 يوم</h3><span className="dim" style={{ fontSize: 12 }}>الخط المتقطع = معدل المريض نفسه{base ? ` (n=${base.n})` : ''}</span></div>
            <TrendChart history={d.history.slice(-14)} baseline={base} />
          </div>

          <ForecastCard patientId={p.id} refreshKey={latestId} />

          <Review c={c} onDone={() => { onChanged(); api.patient(summary.id).then(setD); }} />
        </>
      ) : (
        <div className="empty">ما في فحوصات لهالمريض بعد</div>
      )}
    </>
  );
}

function VitalCard({ label, unit, value, cls, conf, delta, extra }: { label: string; unit: string; value: number | null; cls: string; conf?: number; delta: number | null; extra?: string }) {
  return (
    <div className="vtile">
      <div className="lbl"><span>{label}</span>{delta != null && Math.abs(delta) >= 5 && <span className={delta > 0 ? 'apt num' : 'num hrv'}>{delta > 0 ? '+' : ''}{delta}%</span>}</div>
      <div className={`val ${cls}`} style={{ fontSize: 38 }}>{value != null ? Math.round(value) : '--'}<small>{unit}</small></div>
      {conf != null && <><Conf value={conf} color={`var(--${cls})`} /><div className="sub">{confLabel(conf)}</div></>}
      {extra && <div className="sub">{extra}</div>}
    </div>
  );
}

function Review({ c, onDone }: { c: Checkin; onDone: () => void }) {
  const [lvl, setLvl] = useState<Level>(c.review?.final_level ?? c.triage.level);
  const [note, setNote] = useState(c.review?.note ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setLvl(c.review?.final_level ?? c.triage.level); setNote(c.review?.note ?? ''); }, [c.id]);
  const submit = async (decision: 'confirm' | 'override') => {
    setBusy(true);
    try { await api.review(c.id, { decision, final_level: decision === 'confirm' ? c.triage.level : lvl, note }); onDone(); } finally { setBusy(false); }
  };
  return (
    <div className="card stack">
      <div className="row between"><h3>قرار الطبيب</h3>{c.review && <span className="hr" style={{ fontSize: 13 }}>✓ {c.review.decision === 'confirm' ? 'تم التأكيد' : 'تم التعديل'} · {LEVEL[c.review.final_level].ar}</span>}</div>
      <div className="row wrap">
        {(['emergency', 'appointment', 'followup'] as Level[]).map((l) => (
          <button key={l} className="chip" onClick={() => setLvl(l)} style={{ color: lvl === l ? `var(--${LEVEL[l].cls})` : undefined, borderColor: lvl === l ? 'currentColor' : undefined, padding: '8px 14px', fontSize: 14 }}>{LEVEL[l].ar}</button>
        ))}
      </div>
      <input className="input" placeholder="ملاحظة (اختياري): مثلاً اتصلنا فيها وحوّلناها للطوارئ" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row wrap">
        <button className="btn primary" disabled={busy} onClick={() => submit('confirm')}>تأكيد اقتراح النظام ({LEVEL[c.triage.level].ar})</button>
        <button className="btn" disabled={busy || lvl === c.triage.level} onClick={() => submit('override')}>تعديل إلى {LEVEL[lvl].ar}</button>
      </div>
      {levelRank[lvl] < levelRank[c.triage.level] && <p className="apt" style={{ fontSize: 13 }}>أنت عم تنزّل مستوى الخطورة — بيتسجّل باسمك كقرار سريري.</p>}
    </div>
  );
}

function LiveFeed({ onPick }: { onPick: (id: string) => void }) {
  const [items, setItems] = useState<Checkin[]>([]);
  const load = () => api.feed().then((x) => setItems(x.filter((c) => !c.simulated).slice(0, 6))).catch(() => undefined);
  useEffect(() => { load(); }, []);
  useInterval(load, 4000);
  return (
    <div className="card stack">
      <div className="row between"><h3>فحوصات حيّة اليوم</h3><span className="dot live-dot hr" /></div>
      {!items.length && <p className="dim" style={{ fontSize: 13 }}>لسا ما في فحوصات حقيقية — امسح الكود فوق.</p>}
      {items.map((c) => (
        <button key={c.id} className="kv" style={{ background: 'none', border: 0, borderBottom: '1px dashed var(--line)', cursor: 'pointer', textAlign: 'start' }} onClick={() => onPick(c.patient_id)}>
          <span>{c.patient_name_ar}<span className="dim" style={{ fontSize: 12 }}> · {timeAgo(c.created_at)}</span></span>
          <span className="row" style={{ gap: 8 }}><span className="hr num">{c.vitals.hr_bpm != null ? Math.round(c.vitals.hr_bpm) : '--'}</span><LevelBadge level={finalLevel(c)!} small /></span>
        </button>
      ))}
    </div>
  );
}

function Accuracy() {
  const [v, setV] = useState<Validation | null>(null);
  const load = () => api.validation().then(setV).catch(() => undefined);
  useEffect(() => { load(); }, []);
  useInterval(load, 5000);
  const W = 360, P = 36;
  const pairs = v?.pairs ?? [];
  const all = pairs.flatMap((p) => [p.rppg, p.ref]);
  const lo = all.length ? Math.floor(Math.min(...all) / 10) * 10 - 5 : 50, hi = all.length ? Math.ceil(Math.max(...all) / 10) * 10 + 5 : 120;
  const s = (x: number) => P + ((x - lo) / (hi - lo)) * (W - 2 * P);
  return (
    <div style={{ padding: 24, display: 'grid', gap: 16, maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      <div>
        <h1 style={{ fontSize: 26 }}>دقة النبض مقابل ساعة ذكية / جهاز نبض</h1>
        <p className="muted">كل قراءة هون من فحص حقيقي (مش محاكاة) دخّل فيه الشخص رقم ساعته أو جهاز النبض. ما في أي رقم مختلق: إذا ما في قراءات، ما في نتيجة.</p>
      </div>
      <div className="dgrid">
        <div className="vtile"><div className="lbl">عدد القراءات</div><div className="val" style={{ fontSize: 38 }}>{v?.n ?? 0}</div></div>
        <div className="vtile"><div className="lbl">متوسط الخطأ المطلق (MAE)</div><div className="val hr" style={{ fontSize: 38 }}>{v?.mae_bpm != null ? v.mae_bpm.toFixed(1) : '--'}<small>bpm</small></div></div>
        <div className="vtile"><div className="lbl">RMSE</div><div className="val" style={{ fontSize: 38 }}>{v?.rmse_bpm != null ? v.rmse_bpm.toFixed(1) : '--'}<small>bpm</small></div></div>
        <div className="vtile"><div className="lbl">ضمن ±5 bpm</div><div className="val hrv" style={{ fontSize: 38 }}>{v?.within_5_pct != null ? Math.round(v.within_5_pct) : '--'}<small>%</small></div></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <div className="card">
          <h3>نظرة (rPPG) مقابل المرجع</h3>
          <svg viewBox={`0 0 ${W} ${W}`} style={{ width: '100%', direction: 'ltr' }}>
            <rect x={P} y={P} width={W - 2 * P} height={W - 2 * P} fill="none" stroke="var(--line)" />
            <line x1={s(lo)} y1={W - s(lo)} x2={s(hi)} y2={W - s(hi)} stroke="var(--dim)" strokeDasharray="4 4" />
            <polygon points={`${s(lo)},${W - s(lo + 5)} ${s(hi - 5)},${W - s(hi)} ${s(hi)},${W - s(hi)} ${s(hi)},${W - s(hi - 5)} ${s(lo + 5)},${W - s(lo)} ${s(lo)},${W - s(lo)}`} fill="var(--hr)" opacity=".06" />
            {pairs.map((p) => <circle key={p.checkin_id} cx={s(p.ref)} cy={W - s(p.rppg)} r="5" fill={p.quality === 'poor' ? 'var(--emg)' : 'var(--hr)'} opacity=".85" />)}
            <text x={W / 2} y={W - 6} textAnchor="middle" fill="var(--muted)" fontSize="11">reference (bpm)</text>
            <text x={10} y={W / 2} fill="var(--muted)" fontSize="11" transform={`rotate(-90 10 ${W / 2})`} textAnchor="middle">Nazra (bpm)</text>
            <text x={P} y={W - P + 14} fill="var(--dim)" fontSize="10">{lo}</text>
            <text x={W - P} y={W - P + 14} fill="var(--dim)" fontSize="10" textAnchor="end">{hi}</text>
          </svg>
          <p className="dim" style={{ fontSize: 12 }}>الخط المتقطع = تطابق تام. المنطقة الخضرا = ±5 bpm.</p>
        </div>
        <div className="card">
          <h3>القراءات</h3>
          {!pairs.length ? <p className="empty">لسا ما في قراءات مرجعية. بعد الفحص، اكتب رقم ساعتك بخانة «عندك ساعة ذكية؟».</p> : (
            <table className="vt">
              <thead><tr><th>الوقت</th><th>نظرة</th><th>المرجع</th><th>الفرق</th><th>الجودة</th></tr></thead>
              <tbody>
                {pairs.slice().reverse().map((p) => (
                  <tr key={p.checkin_id}>
                    <td>{timeAgo(p.created_at)}</td>
                    <td className="num hr">{p.rppg.toFixed(0)}</td>
                    <td className="num">{p.ref.toFixed(0)}</td>
                    <td className="num">{Math.abs(p.rppg - p.ref).toFixed(1)}</td>
                    <td>{p.quality}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="card">
        <h3>اختبار المقعد (فيديو اصطناعي)</h3>
        <p className="muted" style={{ fontSize: 14 }}>خوارزمية النبض مفحوصة كمان على إشارات وفيديو وجه اصطناعي بنبض معروف — التفاصيل والأرقام بملف <span className="num">nazra/eval</span> بالمستودع. هذا بيثبت إنه المعالجة صحيحة، مش دقة سريرية على ناس.</p>
      </div>
    </div>
  );
}

// Partner health-center console (demo, fake center). Runs full-screen on a separate laptop:
// WebSocket push for new alerts, REST polling as a fallback, a loud two-tone alarm until someone presses «استلمنا».
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AlertDoc } from './EmergencyStatus';
import './center.css';

interface CenterInfo { id: string; name_ar: string; name_en: string; lat: number; lon: number; phone: string }

const DEMO_CENTERS: CenterInfo[] = [
  { id: 'c-shmeisani', name_ar: 'مركز الشميساني الصحي (تجريبي)', name_en: 'Shmeisani', lat: 31.9686, lon: 35.9015, phone: '000-DEMO-01' },
  { id: 'c-marka', name_ar: 'مركز ماركا الصحي (تجريبي)', name_en: 'Marka', lat: 31.9886, lon: 35.9876, phone: '000-DEMO-02' },
  { id: 'c-sweileh', name_ar: 'مركز صويلح الصحي (تجريبي)', name_en: 'Sweileh', lat: 32.0222, lon: 35.8411, phone: '000-DEMO-03' },
];

const QUALITY: Record<string, string> = { good: 'جودة جيدة', fair: 'جودة متوسطة', poor: 'جودة ضعيفة' };

function centerIdFromHash(): string | null {
  const q = window.location.hash.split('?')[1];
  return q ? new URLSearchParams(q).get('id') : null;
}

function since(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} ث`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} د ${s % 60} ث` : `${Math.floor(m / 60)} س ${m % 60} د`;
}

// ---------------------------------------------------------------- alarm (WebAudio two-tone, loops until stopped)
function useAlarm() {
  const ctx = useRef<AudioContext | null>(null);
  const timer = useRef(0);
  const unlock = () => {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!ctx.current) ctx.current = new AC();
      void ctx.current.resume();
      beep(ctx.current, 660, 0.12); // audible confirmation that sound works
    } catch { /* no audio: the screen still flashes */ }
  };
  const start = useCallback(() => {
    if (timer.current || !ctx.current) return;
    let hi = true;
    const play = () => { if (ctx.current) beep(ctx.current, hi ? 960 : 640, 0.36); hi = !hi; };
    play();
    timer.current = window.setInterval(play, 420);
  }, []);
  const stop = useCallback(() => { window.clearInterval(timer.current); timer.current = 0; }, []);
  useEffect(() => stop, [stop]);
  return { unlock, start, stop };
}

function beep(ac: AudioContext, freq: number, dur: number) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = 'square';
  o.frequency.value = freq;
  const t = ac.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

// ---------------------------------------------------------------- console
export default function Center() {
  const [centers, setCenters] = useState<CenterInfo[]>(DEMO_CENTERS);
  const [id, setId] = useState(centerIdFromHash());
  useEffect(() => {
    const on = () => setId(centerIdFromHash()); // App only re-renders on route change, not on ?id=
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    fetch('/api/centers').then((r) => (r.ok ? r.json() : Promise.reject())).then(setCenters).catch(() => undefined);
  }, []);
  const me = centers.find((c) => c.id === id);
  if (!me) return <Picker centers={centers} />;
  return <Console key={me.id} me={me} />;
}

function Picker({ centers }: { centers: CenterInfo[] }) {
  return (
    <div className="cc" dir="rtl">
      <div className="cc-demo">تجريبي — مركز شريك وهمي</div>
      <h1 className="cc-title">نظرة · لوحة المركز الصحي الشريك</h1>
      <p className="cc-muted">اختار المركز اللي هالجهاز بيمثّله:</p>
      <div className="cc-pick">
        {centers.map((c) => (
          <a key={c.id} className="cc-pick-btn" href={`#/center?id=${c.id}`}>{c.name_ar}</a>
        ))}
      </div>
    </div>
  );
}

type Conn = 'ws' | 'poll' | 'down';

function Console({ me }: { me: CenterInfo }) {
  const [started, setStarted] = useState(false);
  const [alerts, setAlerts] = useState<Record<string, AlertDoc & { _rx: number }>>({});
  const [conn, setConn] = useState<Conn>('down');
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const alarm = useAlarm();
  const wsOpen = useRef(false);

  const merge = useCallback((list: AlertDoc[]) => {
    const rx = Date.now();
    setAlerts((prev) => {
      const next = { ...prev };
      for (const a of list) next[a.id] = { ...a, _rx: rx };
      return next;
    });
  }, []);

  // clock for "time since" + escalation countdown
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);

  // WebSocket with auto-reconnect
  useEffect(() => {
    if (!started) return;
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer = 0;
    let closed = false;
    const connect = () => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/center/${encodeURIComponent(me.id)}`;
      try { ws = new WebSocket(url); } catch { schedule(); return; }
      ws.onopen = () => { wsOpen.current = true; retry = 0; setConn('ws'); };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'hello' && Array.isArray(m.alerts)) merge(m.alerts);
          else if ((m.type === 'alert' || m.type === 'update') && m.alert) merge([m.alert]);
        } catch { /* ignore malformed */ }
      };
      ws.onclose = () => { wsOpen.current = false; setConn((c) => (c === 'ws' ? 'poll' : c)); schedule(); };
      ws.onerror = () => { try { ws?.close(); } catch { /* */ } };
    };
    const schedule = () => {
      if (closed) return;
      retry = Math.min(retry + 1, 5);
      timer = window.setTimeout(connect, retry * 1000);
    };
    connect();
    return () => { closed = true; window.clearTimeout(timer); wsOpen.current = false; try { ws?.close(); } catch { /* */ } };
  }, [started, me.id, merge]);

  // REST polling fallback (every 2 s while the socket is down, every 10 s as a safety net when it is up)
  useEffect(() => {
    if (!started) return;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const r = await fetch(`/api/alerts?center_id=${encodeURIComponent(me.id)}`);
        if (!r.ok) throw new Error(String(r.status));
        if (alive) { merge(await r.json()); if (!wsOpen.current) setConn('poll'); }
      } catch {
        if (alive && !wsOpen.current) setConn('down');
      }
      if (alive) timer = window.setTimeout(poll, wsOpen.current ? 10000 : 2000);
    };
    poll();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [started, me.id, merge]);

  const all = Object.values(alerts).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const open = all.filter((a) => a.status === 'pending' && a.current_center_id === me.id);
  const handled = all.filter((a) => !(a.status === 'pending' && a.current_center_id === me.id));

  useEffect(() => {
    if (started && open.length) alarm.start(); else alarm.stop();
  }, [started, open.length, alarm]);

  const ack = async (aid: string) => {
    setBusy(aid);
    setErr('');
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(aid)}/ack`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ center_id: me.id }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.detail ?? String(r.status));
      merge([body]);
    } catch (e) {
      setErr(`ما وصل التأكيد: ${e instanceof Error ? e.message : String(e)} — جرّب مرة ثانية`);
    } finally { setBusy(null); }
  };

  const connLabel = conn === 'ws' ? 'متصل مباشر' : conn === 'poll' ? 'متصل (تحديث كل ثانيتين)' : 'غير متصل — عم نعيد المحاولة';

  return (
    <div className={`cc ${open.length ? 'cc-alarm' : ''}`} dir="rtl">
      <header className="cc-head">
        <div>
          <div className="cc-demo">تجريبي — مركز شريك وهمي</div>
          <h1 className="cc-title">{me.name_ar}</h1>
        </div>
        <div className={`cc-conn cc-conn-${conn}`}><i />{started ? connLabel : 'المناوبة مش مبلّشة'}</div>
      </header>

      {!started ? (
        <div className="cc-start-wrap">
          <button className="cc-start" onClick={() => { alarm.unlock(); setStarted(true); }}>ابدأ المناوبة</button>
          <p className="cc-muted">الزر بيشغّل الصوت — لازم تكبسه مرة وحدة قبل ما توصل أي حالة.</p>
        </div>
      ) : (
        <>
          {err && <div className="cc-err">{err}</div>}
          {open.length === 0 && <div className="cc-idle">ما في حالات طارئة هلّق. الشاشة رح تصفّر وتنوّر لما توصل حالة.</div>}
          {open.map((a) => {
            const mine = a.order.find((o) => o.center_id === me.id);
            const myStep = a.centers_tried.findIndex((t) => t.center_id === me.id) + 1;
            const left = a.escalates_in_s != null ? Math.max(0, a.escalates_in_s - Math.round((now - a._rx) / 1000)) : null;
            return (
              <article key={a.id} className="cc-card">
                <div className="cc-card-top">
                  <span className="cc-badge">طارئ</span>
                  <span className="cc-step">المحاولة {myStep || a.step}/{a.max_steps}{myStep > 1 ? ' · محوّلة من مركز ما ردّ' : ''}</span>
                  <span className="cc-since">من {since(a.created_at, now)}</span>
                </div>
                <h2 className="cc-name">{a.patient_name_ar}{a.age ? <small> · {a.age} سنة</small> : null}</h2>
                <ul className="cc-reasons">{a.reasons_ar.map((r, i) => <li key={i}>{r}</li>)}</ul>
                <div className="cc-vitals">
                  <div><span>نبض</span><b className="cc-hr">{a.vitals.hr != null ? Math.round(a.vitals.hr) : '--'}</b><em>{QUALITY[a.vitals.quality ?? ''] ?? ''}</em></div>
                  <div><span>تنفس</span><b className="cc-rr">{a.vitals.rr != null ? Math.round(a.vitals.rr) : '--'}</b><em>بالدقيقة</em></div>
                </div>
                <p className="cc-where">📍 {a.area_ar}{mine ? ` · تقريباً ${mine.distance_km} كم عن المركز` : ''}</p>
                <p className="cc-note">مؤشر للمتابعة، مش تشخيص · الأرقام من كاميرا الموبايل</p>
                <button className="cc-ack" disabled={busy === a.id} onClick={() => ack(a.id)}>{busy === a.id ? '…' : 'استلمنا'}</button>
                {left != null && <p className="cc-muted">{(myStep || a.step) >= a.max_steps ? `آخر مركز — إذا ما استلمتوا خلال ${left} ث رح نطلب من المريض يتصل 911` : `إذا ما استلمتوا، الحالة بتتحوّل للمركز التالي خلال ${left} ث`}</p>}
              </article>
            );
          })}
          {handled.length > 0 && (
            <section className="cc-handled">
              <h3>حالات سابقة</h3>
              {handled.slice(0, 12).map((a) => (
                <div key={a.id} className="cc-row">
                  <b>{a.patient_name_ar}</b>
                  <span>{a.area_ar}</span>
                  <span className={`cc-st cc-st-${a.status}`}>
                    {a.status === 'acked' ? (a.ack?.center_id === me.id ? 'استلمناها' : `استلمها ${a.ack_center_name_ar ?? 'مركز آخر'}`)
                      : a.status === 'failed' ? 'ما حدا ردّ' : 'تحوّلت لمركز آخر'}
                  </span>
                  <span className="cc-muted">{since(a.created_at, now)}</span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
      <p className="cc-foot">نظرة / Nazra · أداة فرز مش تشخيص · بيانات تجريبية</p>
    </div>
  );
}

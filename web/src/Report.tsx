import { useEffect, useRef, useState } from 'react';
import { Brand, Qr } from './components';
import { getFlags } from './config';
import './report.css';

type Level = 'emergency' | 'appointment' | 'followup';

interface ReportVital {
  key: 'hr' | 'rr';
  label_ar: string;
  unit_ar: string;
  value: number | null;
  quality: 'good' | 'fair' | 'poor' | null;
  quality_ar: string;
  confidence_ar: string;
  usable: boolean;
  meaning_ar: string;
  note_ar: string;
}

interface PatientReport {
  checkin_id: string;
  patient_name_ar: string | null;
  age: number | null;
  time_ar: string;
  simulated: boolean;
  minimal: boolean;
  level: Level;
  level_ar: string;
  next_step_ar: string;
  summary_ar: string | null;
  vitals: ReportVital[];
  do_now_ar: string[];
  call_911_if_ar: string[];
  questions_for_doctor_ar: string[];
  change_vs_baseline_ar: string | null;
  red_flags_ar: string[];
  nearest_center: { name_ar: string; phone: string; distance_km: number; label_ar: string };
  qr_payload: string;
  disclaimer_ar: string;
  status_ar: string;
  sources: { org: string; title: string; url: string | null }[];
  call_action: { number: string; href: string; label_ar: string };
  speech_ar: string;
  share_text_ar: string;
}

const CLS: Record<Level, string> = { emergency: 'emg', appointment: 'apt', followup: 'fu' };

type Voice = 'idle' | 'loading' | 'playing';

function speakInBrowser(text: string, onEnd: () => void): boolean {
  if (!('speechSynthesis' in window)) return false;
  const u = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const v = voices.find((x) => x.lang === 'ar-JO') || voices.find((x) => x.lang.startsWith('ar'));
  if (v) u.voice = v;
  u.lang = v?.lang || 'ar-JO';
  u.rate = 0.95;
  u.onend = onEnd;
  u.onerror = onEnd;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  return true;
}

export default function Report({ id }: { id: string }) {
  const [rep, setRep] = useState<PatientReport | null>(null);
  const [err, setErr] = useState('');
  const [voice, setVoice] = useState<Voice>('idle');
  const [voiceNote, setVoiceNote] = useState('');
  const [share, setShare] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string>('');
  const enabled = getFlags().report;

  useEffect(() => {
    if (!enabled) return;
    fetch(`/api/checkins/${encodeURIComponent(id)}/report`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'ما لقينا هالتقرير' : `خطأ ${r.status}`);
        return r.json() as Promise<PatientReport>;
      })
      .then((d) => { setRep(d); setShare(d.share_text_ar); })
      .catch((e: Error) => setErr(e.message));
  }, [id, enabled]);

  useEffect(() => () => {
    audio.current?.pause();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  function stop() {
    audio.current?.pause();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setVoice('idle');
  }

  async function listen() {
    if (!rep) return;
    if (voice !== 'idle') { stop(); return; }
    setVoice('loading');
    setVoiceNote('');
    try {
      const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: rep.speech_ar }) });
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(blob);
      const a = new Audio(urlRef.current);
      audio.current = a;
      a.onended = () => setVoice('idle');
      a.onerror = () => setVoice('idle');
      await a.play();
      setVoice('playing');
      setVoiceNote('صوت محلي (Piper · لهجة أردنية)');
    } catch {
      const ok = speakInBrowser(rep.speech_ar, () => setVoice('idle'));
      setVoice(ok ? 'playing' : 'idle');
      setVoiceNote(ok ? 'صوت المتصفح (احتياطي)' : 'القراءة الصوتية مش متاحة على هالجهاز');
    }
  }

  if (!enabled) {
    return (
      <div className="app"><div className="topbar"><Brand /></div>
        <div className="screen"><div className="card">التقرير مش مفعّل.</div></div></div>
    );
  }

  return (
    <div className="app rep" dir="rtl" lang="ar">
      <div className="topbar"><Brand /><span className="rep-title">تقريري</span></div>
      {err && <div className="screen"><div className="card">{err}</div><a className="btn block" href="#/">رجوع</a></div>}
      {!err && !rep && <div className="screen"><div className="card muted">عم نجهّز التقرير…</div></div>}
      {rep && (
        <div className="screen rep-body">
          <header className="rep-head">
            <div className="rep-who">
              <strong>{rep.patient_name_ar || '—'}</strong>
              {rep.age != null && <span className="muted">العمر <span className="num">{rep.age}</span></span>}
              <span className="muted num">{rep.time_ar}</span>
            </div>
            {rep.simulated && <span className="rep-chip">بيانات تجريبية</span>}
          </header>

          <section className={`rep-level ${CLS[rep.level]}`}>
            <span className="rep-k">النتيجة</span>
            <span className="rep-big">{rep.level_ar}</span>
            <p className="rep-next">{rep.next_step_ar}</p>
            {rep.level === 'emergency' && (
              <a className="btn danger block rep-call" href={rep.call_action.href}>{rep.call_action.label_ar}</a>
            )}
          </section>

          {rep.minimal && rep.red_flags_ar.length > 0 && (
            <section className="rep-card">
              <h2>علامات الخطر اللي ذكرتها</h2>
              <ul className="rep-list">{rep.red_flags_ar.map((t) => <li key={t}>{t}</li>)}</ul>
            </section>
          )}

          {rep.summary_ar && (
            <section className="rep-card">
              <h2>الملخص</h2>
              <p>{rep.summary_ar}</p>
            </section>
          )}

          {rep.vitals.length > 0 && (
            <section className="rep-card">
              <h2>القياسات</h2>
              <div className="rep-vitals">
                {rep.vitals.map((v) => (
                  <div key={v.key} className={`rep-vital ${v.key}`}>
                    <div className="rep-vlabel">{v.label_ar}</div>
                    <div className="rep-vval"><span className="num">{v.value != null && v.usable ? v.value : '--'}</span> <small>{v.unit_ar}</small></div>
                    <div className="rep-vq muted">جودة القراءة: {v.quality_ar} · {v.confidence_ar}</div>
                    <p className="rep-vmean">{v.meaning_ar}</p>
                    <div className="rep-note">{v.note_ar}</div>
                  </div>
                ))}
              </div>
              {rep.change_vs_baseline_ar && <p className="rep-base">{rep.change_vs_baseline_ar}</p>}
            </section>
          )}

          {rep.do_now_ar.length > 0 && (
            <section className="rep-card">
              <h2>شو تعمل هلأ</h2>
              <ul className="rep-list">{rep.do_now_ar.map((t) => <li key={t}>{t}</li>)}</ul>
            </section>
          )}

          {rep.call_911_if_ar.length > 0 && (
            <section className="rep-card rep-911">
              <h2>اتصل على <span className="num">911</span> فوراً إذا</h2>
              <ul className="rep-list">{rep.call_911_if_ar.map((t) => <li key={t}>{t}</li>)}</ul>
            </section>
          )}

          {rep.questions_for_doctor_ar.length > 0 && (
            <section className="rep-card">
              <h2>أسئلة تسألها لطبيبك</h2>
              <ul className="rep-list">{rep.questions_for_doctor_ar.map((t) => <li key={t}>{t}</li>)}</ul>
            </section>
          )}

          <section className="rep-card">
            <h2>أقرب مركز صحي <span className="rep-chip">{rep.nearest_center.label_ar}</span></h2>
            <p><strong>{rep.nearest_center.name_ar}</strong></p>
            <p className="muted">على بعد <span className="num">{rep.nearest_center.distance_km}</span> كم · هاتف <span className="num">{rep.nearest_center.phone}</span></p>
          </section>

          <section className="rep-card rep-qr">
            <h2>{rep.minimal ? 'للمسعف: امسح الكود' : 'للطبيب أو المسعف: امسح الكود'}</h2>
            <Qr text={rep.qr_payload} />
            <p className="muted rep-small">الكود بيشتغل بدون إنترنت: الاسم، العمر، الوقت، النبض والتنفس وجودتهم، المستوى، علامات الخطر.</p>
          </section>

          <div className="rep-actions no-print">
            <button className="btn primary block" onClick={listen} disabled={voice === 'loading'}>
              {voice === 'loading' ? 'عم نجهّز الصوت…' : voice === 'playing' ? 'وقّف الصوت' : 'اسمع التقرير'}
            </button>
            {voiceNote && <p className="muted rep-small">{voiceNote}</p>}
            <button className="btn block" onClick={() => window.print()}>اطبع / احفظ PDF</button>
            <details className="rep-share">
              <summary>شارك على واتساب</summary>
              <label className="muted rep-small" htmlFor="rep-share-text">إنت بتختار شو ينبعث — عدّل النص قبل الإرسال:</label>
              <textarea id="rep-share-text" value={share} onChange={(e) => setShare(e.target.value)} rows={4} />
              <a className="btn block" href={`https://wa.me/?text=${encodeURIComponent(share)}`} target="_blank" rel="noopener noreferrer">افتح واتساب</a>
            </details>
            <a className="btn ghost block" href="#/">رجوع</a>
          </div>

          {rep.sources.length > 0 && (
            <section className="rep-card rep-sources">
              <h2>مصادر النصائح</h2>
              <ul>
                {rep.sources.map((s) => (
                  <li key={s.title}>
                    {s.org} — {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer" dir="ltr">{s.title}</a> : <span dir="ltr">{s.title}</span>}
                  </li>
                ))}
              </ul>
              <p className="rep-small muted">{rep.status_ar}</p>
            </section>
          )}

          <p className="disclaimer rep-disc">{rep.disclaimer_ar} · نظرة / Nazra</p>
        </div>
      )}
    </div>
  );
}

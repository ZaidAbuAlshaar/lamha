// v2 daily protocol UI: context questions, the two-reading scan loop, the readings summary and the daily reminder.
import { useState, type ComponentType } from 'react';
import { combine, evaluate, isGood, MAX_SCANS, type ProtocolFields, type ScanLike } from './readings';
import { contextNote, contextQuestions, type CheckContext } from './context';
import { downloadIcs } from './reminder';
import { getFlags } from '../config';
import { REASON_AR } from '../vitals/diag';
import './protocol.css';

/* ---------- 1. context questions: one per screen, one tap each ---------- */

export function ContextQuestions({ hasConditions, onDone }: { hasConditions: boolean; onDone: (c: CheckContext) => void }) {
  const qs = contextQuestions(hasConditions);
  const [i, setI] = useState(0);
  const [ans, setAns] = useState<Partial<CheckContext>>({});
  const q = qs[i];
  const answer = (v: boolean) => {
    const next = { ...ans, [q.key]: v };
    setAns(next);
    if (i + 1 < qs.length) setI(i + 1);
    else onDone({ exercise: !!next.exercise, caffeine: !!next.caffeine, slept_well: !!next.slept_well, ...(hasConditions ? { took_meds: next.took_meds ?? null } : {}) });
  };
  return (
    <div className="screen proto" key={q.key}>
      <span className="proto-step">سؤال {i + 1} من {qs.length} <small>قبل الفحص</small></span>
      <p className="proto-q">{q.q}</p>
      <p className="muted">{q.hint}</p>
      <div className="proto-answers">
        <button className="btn primary" onClick={() => answer(true)}>آه</button>
        <button className="btn" onClick={() => answer(false)}>لأ</button>
      </div>
      <div className="spacer" />
      {i > 0 && <button className="btn ghost block" onClick={() => setI(i - 1)}>رجوع للسؤال اللي قبل</button>}
      <p className="disclaimer" style={{ fontSize: 16 }}>الأجوبة بتساعد الطبيب يفهم قراءتك، مش بتغيّر النتيجة.</p>
    </div>
  );
}

/* ---------- 2. two consecutive readings (a third when they disagree) ---------- */

type Scanner<T> = ComponentType<{ seconds: number; onDone: (v: T) => void }>;

export function MultiScan<T extends ScanLike & { quality_reasons?: string[] }>({ Scanner, seconds, onDone }: { Scanner: Scanner<T>; seconds: number; onDone: (v: T & ProtocolFields) => void }) {
  const [scans, setScans] = useState<T[]>([]);
  const [mode, setMode] = useState<'scan' | 'between'>('scan');
  const d = evaluate(scans);
  const finish = (all: T[]) => onDone(combine(all));
  const got = (r: T) => {
    const all = [...scans, r];
    if (evaluate(all).done) { finish(all); return; }
    setScans(all);
    setMode('between');
  };
  const last = scans[scans.length - 1];
  const lastPoor = last && !isGood(last);
  return (
    <div className="screen proto" style={{ gap: 14 }}>
      <div className="row between wrap">
        <span className="proto-step">القراءة {d.next} من {d.target}</span>
        <span className="muted" style={{ fontSize: 16 }}>محاولة {Math.min(MAX_SCANS, scans.length + (mode === 'scan' ? 1 : 0))} من {MAX_SCANS}</span>
      </div>
      {scans.length > 0 && <ReadingChips scans={scans} />}
      {mode === 'scan' ? (
        <>
          <Scanner key={scans.length} seconds={seconds} onDone={got} />
          <p className="muted" style={{ textAlign: 'center' }}>خليك قاعد مرتاح وثابت. بنقيس مرتين ورا بعض عشان نتأكد.</p>
        </>
      ) : (
        <>
          {lastPoor ? (
            <div className="proto-bad">
              <b>القراءة ضعيفة — ما رح نحسبها</b>
              <ul>{(last.quality_reasons?.length ? last.quality_reasons : ['low_snr']).slice(0, 2).map((r) => <li key={r}>{REASON_AR[r] ?? r}</li>)}</ul>
            </div>
          ) : d.target === 3 ? (
            <div className="card stack">
              <b style={{ fontSize: 20 }}>القراءتين مختلفات بأكتر من 5 نبضات</b>
              <p className="muted">بنعمل قراءة ثالثة للتأكد، وبناخد الوسط بينهم.</p>
            </div>
          ) : (
            <div className="card stack">
              <b style={{ fontSize: 20 }} className="hr">✓ القراءة {d.good.length} جاهزة</b>
              <p className="muted">ارتاح شوي وخليك بنفس القعدة — هلّق القراءة {d.next}.</p>
            </div>
          )}
          <button className="btn primary block" onClick={() => setMode('scan')}>{lastPoor ? 'أعد القراءة' : `ابدأ القراءة ${d.next}`}</button>
          {d.good.length > 0 && <button className="btn ghost block" onClick={() => finish(scans)}>كمّل بالقراءات اللي عندي</button>}
        </>
      )}
    </div>
  );
}

function ReadingChips({ scans }: { scans: ScanLike[] }) {
  return (
    <div className="proto-chips" aria-label="القراءات">
      {scans.map((s, i) => isGood(s)
        ? <span key={i} className="ok"><b className="num">{Math.round(s.hr_bpm as number)}</b> نبضة ✓</span>
        : <span key={i} className="bad">ضعيفة</span>)}
    </div>
  );
}

/** Shown on the vitals screen: which readings made the final value, and the context note. */
export function ProtocolSummary({ v, ctx }: { v: Partial<ProtocolFields> & { hr_bpm: number | null }; ctx: CheckContext | null }) {
  const note = contextNote(ctx);
  if (!v.readings && !note) return null;
  return (
    <div className="stack proto">
      {v.readings && (
        <div className="card stack">
          <div className="row between wrap">
            <b>{v.reading_count === 2 && v.protocol_method === 'mean2' ? 'معدل قراءتين متقاربات' : v.protocol_method === 'median' ? `الوسط من ${v.reading_count} قراءات` : v.reading_count === 1 ? 'قراءة وحدة بس' : 'ولا قراءة واضحة'}</b>
            <span className="muted" style={{ fontSize: 16 }}>{v.scan_count} {v.scan_count === 1 ? 'محاولة' : 'محاولات'}</span>
          </div>
          {v.readings.length > 0 && <div className="proto-chips">{v.readings.map((r, i) => <span key={i} className="ok"><b className="num">{Math.round(r)}</b> نبضة</span>)}</div>}
          {v.protocol_incomplete && <p className="apt">ما كمّلنا القراءتين المطلوبات — القراءة معلّمة للطبيب إنها ناقصة.</p>}
        </div>
      )}
      {note && <div className="proto-note">{note}</div>}
    </div>
  );
}

/* ---------- 4. daily reminder (.ics, no server) ---------- */

export function ReminderButton() {
  const [done, setDone] = useState(false);
  if (!getFlags().dailyReminder) return null;
  return (
    <div className="stack proto">
      <button className="btn block" onClick={() => { downloadIcs(); setDone(true); }}>ذكّرني كل يوم بنفس الوقت</button>
      {done && <p className="muted" style={{ textAlign: 'center' }}>نزل ملف تقويم — افتحه واضغط «إضافة» عشان يذكّرك تطبيق التقويم كل يوم.</p>}
    </div>
  );
}

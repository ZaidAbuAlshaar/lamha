import { useEffect, useRef, useState } from 'react';
import { LEVEL, type Checkin, type Level } from './api';
import { getFlags } from './config';
import './insights.css';

type Ctx = { exercise?: boolean; caffeine?: boolean; slept_well?: boolean; took_meds?: boolean };
type VM = { n_words: number; speech_s: number; pause_count: number; pause_mean_ms: number | null; words_per_breath_group: number | null; speech_rate_wps: number | null; quality_ok: boolean; simulated?: boolean };
type VitalsX = Checkin['vitals'] & { context?: Ctx; voice_markers?: VM };
interface Changes { available: boolean; lines_ar: string[]; label_ar: string }
interface Voice { enabled: boolean; available: boolean; reason_ar?: string; n_prior: number; current: VM | null; baseline?: Partial<Record<keyof VM, number>>; delta_pct?: Partial<Record<keyof VM, number>>; quality_ok?: boolean; simulated?: boolean; label_ar: string }

const LABEL = 'مؤشر للمتابعة، مش تشخيص';
const lvl = (c: Checkin): Level => c.review?.final_level ?? c.triage.level;
const get = <T,>(url: string) => fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))));

function CtxChips({ ctx }: { ctx?: Ctx }) {
  if (!ctx) return null;
  const chips: [string, boolean | undefined, boolean][] = [
    ['أخد الدواء؟', ctx.took_meds, true],
    ['رياضة', ctx.exercise, false],
    ['قهوة/منبّه', ctx.caffeine, false],
    ['نام منيح', ctx.slept_well, true],
  ];
  return (
    <>
      {chips.filter(([, v]) => v !== undefined).map(([label, v, goodWhenTrue]) => (
        <span key={label} className={`chip ins-ctx ${v === goodWhenTrue ? '' : 'warn'}`}>{label} {v ? 'نعم' : 'لا'}</span>
      ))}
    </>
  );
}

function Dot({ v, metric }: { v: VitalsX; metric: 'hr' | 'rr' }) {
  const val = metric === 'hr' ? v.hr_bpm : v.rr_bpm;
  const poor = v.quality === 'poor' || (metric === 'hr' ? v.hr_confidence : v.rr_confidence) < 0.5;
  return (
    <span className={`ins-v ${metric}`} title={poor ? 'جودة ضعيفة — مش داخلة بالمقارنة' : ''}>
      <span className={`ins-dot ${poor ? 'hollow' : ''}`} />
      <span className="num">{val != null ? Math.round(val) : '--'}</span>
      <small>{metric === 'hr' ? 'نبض' : 'تنفس'}</small>
    </span>
  );
}

const VM_ROWS: [keyof VM, string, string][] = [
  ['pause_count', 'عدد الوقفات', ''],
  ['pause_mean_ms', 'معدل طول الوقفة', 'ms'],
  ['words_per_breath_group', 'كلمات بكل نَفَس', ''],
  ['speech_rate_wps', 'سرعة الكلام', 'كلمة/ث'],
];

function VoicePanel({ patientId, latestId }: { patientId: string; latestId?: string }) {
  const [v, setV] = useState<Voice | null>(null);
  useEffect(() => { get<Voice>(`/api/patients/${patientId}/voice`).then(setV).catch(() => setV(null)); }, [patientId, latestId]);
  if (!v || !v.enabled) return null;
  return (
    <div className="card stack">
      <div className="row between wrap">
        <h3>مؤشرات الصوت (ضيق النفس)</h3>
        <div className="row wrap" style={{ gap: 6 }}>
          {v.simulated || v.current?.simulated ? <span className="sim-tag">بيانات تجريبية</span> : null}
          <span className="ins-label">{LABEL}</span>
        </div>
      </div>
      {!v.available ? (
        <p className="muted">{v.reason_ar ?? 'لسا ما في أساس كافٍ للمقارنة'}{v.current ? ` (فحوصات صوت سابقة صالحة: ${v.n_prior} من 3)` : ''}</p>
      ) : (
        <>
          {!v.quality_ok && <p className="apt" style={{ fontSize: 13 }}>⚠ التسجيل الأخير قصير أو كلماته قليلة — المقارنة غير موثوقة</p>}
          <table className="vt">
            <thead><tr><th>المؤشر</th><th>آخر فحص</th><th>معدّله هو (n=<span className="num">{v.n_prior}</span>)</th><th>الفرق</th></tr></thead>
            <tbody>
              {VM_ROWS.map(([k, label, unit]) => {
                const cur = v.current?.[k];
                const b = v.baseline?.[k];
                const dp = v.delta_pct?.[k];
                return (
                  <tr key={k}>
                    <td>{label}</td>
                    <td className="num">{typeof cur === 'number' ? cur : '--'} {unit}</td>
                    <td className="num">{b ?? '--'} {unit}</td>
                    <td className={`num ${dp != null && Math.abs(dp) >= 20 ? 'apt' : 'dim'}`}>{dp != null ? `${dp > 0 ? '+' : ''}${Math.round(dp)}%` : '--'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="dim" style={{ fontSize: 12 }}>من توقيت كلمات Whisper (وقفة = سكوت ≥ 300 ms). مقارنة بالمريض نفسه بس، مش بناس ثانيين.</p>
        </>
      )}
    </div>
  );
}

export default function Timeline({ patientId, checkins }: { patientId: string; checkins: Checkin[] }) {
  const [ch, setCh] = useState<Changes | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const latestId = checkins[0]?.id;
  const on = getFlags().timeline;
  useEffect(() => { if (on) get<Changes>(`/api/patients/${patientId}/changes`).then(setCh).catch(() => setCh(null)); }, [patientId, latestId, on]);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [patientId, latestId]);
  if (!on) return null;
  const asc = [...checkins].reverse();
  return (
    <>
      {ch && (
        <div className="card ins-changes">
          <div className="row between wrap"><h3>شو تغيّر من آخر زيارة</h3><span className="ins-label">{LABEL}</span></div>
          {ch.lines_ar.map((l, i) => <p key={i}>{l}</p>)}
        </div>
      )}
      <VoicePanel patientId={patientId} latestId={latestId} />
      <div className="card stack">
        <div className="row between wrap">
          <h3>الخط الزمني</h3>
          <span className="dim" style={{ fontSize: 12 }}>كل الفحوصات بالترتيب · الدائرة الفاضية = جودة ضعيفة · <span className="num">{asc.length}</span> فحص</span>
        </div>
        <div className="ins-tl" ref={box}>
          {asc.map((c) => {
            const v = c.vitals as VitalsX;
            const L = LEVEL[lvl(c)];
            return (
              <div key={c.id} className={`ins-tl-row ${L.cls}`}>
                <span className="ins-tl-date">{new Date(c.created_at).toLocaleString('ar-JO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                <Dot v={v} metric="hr" />
                <Dot v={v} metric="rr" />
                <span className={`ins-lvl ${L.cls}`}>{L.ar}</span>
                <span className="ins-tl-tags">
                  {c.symptoms.filter((s) => s.verified).map((s, i) => <span key={i} className="sym ins-sym">{s.label_ar}</span>)}
                  <CtxChips ctx={v.context} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

import { useEffect, useState } from 'react';
import { getFlags } from './config';
import './insights.css';

interface Area {
  area_ar: string;
  n_patients: number | null;
  count_72h: number | null;
  baseline: number | null;
  baseline_sd: number | null;
  baseline_windows: number[] | null;
  threshold: number | null;
  alert: boolean;
  suppressed: boolean;
  simulated: boolean;
  label_ar: string;
}
interface CommunityResp { generated_at: string; window_h: number; history_days: number; k_min: number; rule_ar: string; label_ar: string; areas: Area[] }

export const communityOn = () => getFlags().community;

export default function Community() {
  const [d, setD] = useState<CommunityResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => fetch('/api/community').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((x: CommunityResp) => { setD(x); setErr(null); }).catch((e: Error) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
  if (err) return <div className="err" style={{ margin: 12 }}>ما قدرنا نجيب الإنذار المجتمعي: {err}</div>;
  if (!d) return <div className="spinner" />;
  const shown = d.areas.filter((a) => !a.suppressed);
  const hidden = d.areas.filter((a) => a.suppressed);
  const alerts = shown.filter((a) => a.alert).length;
  const allSim = d.areas.length > 0 && d.areas.every((a) => a.simulated);
  return (
    <div className="ins-wrap" dir="rtl">
      <div className="row between wrap">
        <div>
          <h1 style={{ fontSize: 24 }}>الإنذار المجتمعي</h1>
          <p className="muted">مين عنده نبض أعلى من معدله هو + عرض تنفسي أو حرارة، بكل منطقة، آخر {d.window_h} ساعة — مقارنة بنفس المنطقة.</p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {allSim && <span className="sim-tag">بيانات تجريبية</span>}
          <span className="ins-label">مؤشر للمتابعة، مش تشخيص</span>
        </div>
      </div>

      <div className={`card ins-summary ${alerts ? 'is-alert' : ''}`}>
        <span className={alerts ? 'apt' : 'fu'} style={{ fontSize: 18, fontWeight: 600 }}>
          {alerts ? `${alerts} منطقة فيها ارتفاع غير معتاد` : 'ما في ارتفاع غير معتاد بأي منطقة'}
        </span>
        <span className="dim" style={{ fontSize: 13 }}>آخر تحديث {new Date(d.generated_at).toLocaleTimeString('ar-JO', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      <div className="ins-grid">
        {shown.map((a) => (
          <div key={a.area_ar} className={`card ins-area ${a.alert ? 'is-alert' : ''}`}>
            <div className="row between">
              <h3>{a.area_ar}</h3>
              {a.alert ? <span className="ins-badge apt">▲ {a.label_ar}</span> : <span className="ins-badge fu">{a.label_ar}</span>}
            </div>
            <div className="ins-big">
              <span className={`num ${a.alert ? 'apt' : ''}`}>{a.count_72h}</span>
              <span className="muted">من <span className="num">{a.n_patients}</span> مرضى · آخر {d.window_h} ساعة</span>
            </div>
            <div className="ins-windows" aria-label="النوافذ السابقة">
              {(a.baseline_windows ?? []).slice().reverse().map((w, i) => (
                <div key={i} className="ins-bar"><i style={{ height: `${Math.min(100, (w / Math.max(1, a.n_patients ?? 1)) * 100)}%` }} /><span className="num">{w}</span></div>
              ))}
              <div className={`ins-bar now ${a.alert ? 'is-alert' : ''}`}><i style={{ height: `${Math.min(100, ((a.count_72h ?? 0) / Math.max(1, a.n_patients ?? 1)) * 100)}%` }} /><span className="num">{a.count_72h}</span></div>
            </div>
            <div className="dim" style={{ fontSize: 12 }}>
              المعتاد للمنطقة: <span className="num">{a.baseline}</span> ± <span className="num">{a.baseline_sd}</span> · حد الإنذار: <span className="num">{a.threshold}</span> (و ≥ 3)
            </div>
          </div>
        ))}
        {!shown.length && <div className="empty">ما في منطقة فيها {d.k_min} مرضى أو أكثر بعد</div>}
      </div>

      {hidden.length > 0 && (
        <div className="card stack">
          <h3>مناطق مخفية لحماية الخصوصية</h3>
          <div className="row wrap" style={{ gap: 6 }}>
            {hidden.map((a) => <span key={a.area_ar} className="chip ins-hidden">{a.area_ar} · {a.label_ar}</span>)}
          </div>
          <p className="dim" style={{ fontSize: 12 }}>أي منطقة فيها أقل من {d.k_min} مرضى ما بنعرض عنها ولا رقم. ولا مرة بنعرض أسماء.</p>
        </div>
      )}

      <div className="card stack">
        <h3>القاعدة</h3>
        <p className="muted" style={{ fontSize: 14, lineHeight: 1.8 }}>{d.rule_ar}</p>
        <p className="dim" style={{ fontSize: 12 }}>الأعمدة: آخر 3 نوافذ سابقة (كل وحدة {d.window_h} ساعة) ثم الآن. هاي إشارة لصحة المجتمع للمتابعة، مش تشخيص لأي مريض.</p>
      </div>
    </div>
  );
}

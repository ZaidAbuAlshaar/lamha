// Patient side of the partner-center alert. The 911 call link renders FIRST and needs no network;
// the center status below it is extra reassurance, polled every 2 s.
import { useEffect, useState, type ReactNode } from 'react';
import { getFlags } from './config';
import './center.css';

export interface AlertDoc {
  id: string;
  patient_id: string;
  patient_name_ar: string | null;
  age: number | null;
  checkin_id: string;
  created_at: string;
  level: 'emergency';
  reasons_ar: string[];
  vitals: { hr: number | null; rr: number | null; quality: 'good' | 'fair' | 'poor' | null };
  area_ar: string;
  approx_location: { lat: number; lon: number };
  order: { center_id: string; name_ar: string; distance_km: number }[];
  centers_tried: { center_id: string; sent_at: string }[];
  current_center_id: string;
  status: 'pending' | 'acked' | 'failed';
  ack: { center_id: string; at: string } | null;
  step: number;
  max_steps: number;
  current_center_name_ar: string | null;
  ack_center_name_ar: string | null;
  escalates_in_s: number | null;
  timeout_s: number;
}

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ar-JO-u-nu-latn', { hour: '2-digit', minute: '2-digit' });
};

const ESCALATED = ['', '', 'ما ردّ المركز الأول — حوّلنا لمركز ثاني', 'ما ردّ المركز الثاني — حوّلنا لمركز ثالث'];

export default function EmergencyStatus({ alertId }: { alertId?: string | null }) {
  const [a, setA] = useState<AlertDoc | null>(null);
  const [failedFetch, setFailedFetch] = useState(false);
  const enabled = getFlags().centerAlerts;

  useEffect(() => {
    if (!alertId || !enabled) return;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}`);
        if (!r.ok) throw new Error(String(r.status));
        const doc = (await r.json()) as AlertDoc;
        if (!alive) return;
        setA(doc);
        setFailedFetch(false);
        if (doc.status === 'acked') return; // final: stop polling
      } catch {
        if (alive) setFailedFetch(true);
      }
      if (alive) timer = window.setTimeout(tick, 2000);
    };
    tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [alertId, enabled]);

  let status: ReactNode = null;
  if (enabled) {
    if (!alertId) {
      status = <p className="es-line">ما انبعت تنبيه لمركز صحي — اتصل 911 مباشرة.</p>;
    } else if (!a) {
      status = <p className="es-line">{failedFetch ? 'ما قدرنا نتأكد من حالة التنبيه — اتصل 911.' : 'عم نبعت حالتك لأقرب مركز صحي…'}</p>;
    } else if (a.status === 'acked') {
      status = (
        <div className="es-ok">
          <b>✅ المركز استلم حالتك</b>
          <span>{a.ack_center_name_ar}{a.ack ? ` · الساعة ${hhmm(a.ack.at)}` : ''}</span>
        </div>
      );
    } else if (a.status === 'failed') {
      status = <div className="es-fail"><b>ما ردّ أي مركز — اتصل 911 الآن</b></div>;
    } else {
      status = (
        <div className="es-wait">
          {a.step > 1 && <b className="es-esc">{ESCALATED[a.step] ?? ESCALATED[2]}</b>}
          <span className="es-pulse" aria-hidden /> <span>بانتظار تأكيد المركز…</span>
          <span className="es-center">{a.current_center_name_ar} · محاولة {a.step}/{a.max_steps}</span>
        </div>
      );
    }
  }

  return (
    <div className="es" dir="rtl" role="alert">
      <div className="es-bar">حالة طارئة — لا تستنى</div>
      <a className="es-call" href="tel:911">📞 اتصل بـ 911</a>
      {status && <div className="es-status">{status}{failedFetch && a && <p className="es-line">الاتصال بالخادم متقطع — آخر حالة معروضة.</p>}</div>}
      {enabled && <p className="es-demo">تجريبي — مراكز شريكة وهمية</p>}
    </div>
  );
}

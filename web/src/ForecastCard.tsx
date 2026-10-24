import { useEffect, useState } from 'react';
import { getFlags } from './config';
import './monitor.css';

interface Baseline { median: number; sd: number; n_days: number; from: string; to: string; band: [number, number] }
interface FPoint { h: number; date: string; hr: number; lo: number; hi: number; widened?: boolean }
interface Point { date: string; created_at: string; hr: number; quality: string | null; excluded: boolean; good: boolean; symptoms: string[] }
export interface ForecastResp {
  simulated: boolean;
  demo_label_ar: string | null;
  baseline: Baseline | null;
  baseline_reason_ar: string | null;
  latest: { date: string; created_at: string; hr: number; z: number | null; flag: 'remeasure' | null } | null;
  cusum: { k: number; h: number; series: { date: string; z: number; s: number }[]; alarm_dates: string[]; alarm: boolean };
  forecast: { n: number; slope_per_day: number; level: number; points: FPoint[] } | null;
  forecast_reason_ar: string | null;
  agreement: { status: 'agree' | 'uncertain' | 'linear_only' | 'none'; label_ar: string; chronos: { model: string; latency_ms: number } | null };
  points: Point[];
  note: { text_ar: string; source: 'ai' | 'template'; numbers_verified: boolean };
  patient_sentence_ar: string;
  flags: { code: string; label_ar: string; level: string | null }[];
  disclaimer_ar: string;
}

const DAY = 86400000;
const dayMs = (d: string) => Date.parse(d + 'T00:00:00Z');

export function ForecastCard({ patientId, refreshKey }: { patientId: string; refreshKey?: string }) {
  const [f, setF] = useState<ForecastResp | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    setErr(false);
    fetch(`/api/patients/${patientId}/forecast`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j: ForecastResp) => live && setF(j))
      .catch(() => live && setErr(true));
    return () => { live = false; };
  }, [patientId, refreshKey]);
  if (!getFlags().forecastCard) return null;
  if (err) return null;
  if (!f) return <div className="card fc-card"><div className="spinner" /></div>;
  const fc = f.forecast;
  const agrCls = f.agreement.status === 'agree' ? 'ok' : f.agreement.status === 'uncertain' ? 'warn' : 'off';
  return (
    <div className="card stack fc-card">
      <div className="row between wrap">
        <div className="row wrap" style={{ gap: 8 }}>
          <h3>توقّع صحة المريض</h3>
          {f.demo_label_ar && <span className="sim-tag">{f.demo_label_ar}</span>}
        </div>
        {f.agreement.status !== 'none' && <span className={`fc-badge ${agrCls}`} title={f.agreement.chronos ? `Chronos-Bolt · ${f.agreement.chronos.model}` : 'linear only'}>{f.agreement.label_ar}</span>}
      </div>

      <FcChart f={f} />

      <div className="fc-legend">
        <span><i className="fc-i dot" /> قراءة جيدة</span>
        <span><i className="fc-i dot hollow" /> جودة ضعيفة / مستبعدة</span>
        <span><i className="fc-i band" /> المعدل المعتاد ± 2 انحراف</span>
        <span><i className="fc-i dashk" /> توقّع + مدى 80%</span>
        <span><i className="fc-i symk" /> عرض مذكور</span>
        <span><i className="fc-i alarm" /> إنذار CUSUM</span>
      </div>

      <div className="fc-facts">
        {f.baseline ? (
          <div><span className="dim">المعدل المعتاد</span> <b className="mono">{Math.round(f.baseline.median)}</b> <span className="dim">ن/د · {f.baseline.n_days} يوم</span></div>
        ) : (
          <div className="dim">{f.baseline_reason_ar}</div>
        )}
        {f.latest && (
          <div><span className="dim">آخر قراءة</span> <b className="mono">{Math.round(f.latest.hr)}</b> <span className="dim">ن/د</span>{f.latest.z != null && <span className="dim"> · <bdi dir="ltr" className="mono">z = {f.latest.z.toFixed(1)}</bdi></span>}</div>
        )}
        {fc ? (
          fc.points.map((p) => (
            <div key={p.h}>
              <span className="dim">بعد {p.h} ساعة</span> <b className="mono">{Math.round(p.hr)}</b>{' '}
              <bdi dir="ltr" className="dim mono">[{Math.round(p.lo)}–{Math.round(p.hi)}]</bdi>
            </div>
          ))
        ) : (
          <div className="dim">{f.forecast_reason_ar}</div>
        )}
      </div>

      {f.flags.filter((x) => x.code !== 'no_baseline').length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {f.flags.filter((x) => x.code !== 'no_baseline').map((x) => (
            <span key={x.code} className={`fc-flag ${x.level === 'appointment' ? 'apt' : ''}`}>{x.label_ar}</span>
          ))}
        </div>
      )}

      <div className="fc-note">
        <span className={`fc-src ${f.note.source}`}>{f.note.source === 'ai' ? 'AI · Gemma (أرقام متحقق منها)' : 'قالب ثابت'}</span>
        <p>{f.note.text_ar}</p>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>ما يراه المريض: «{f.patient_sentence_ar}»</div>
      <div className="fc-disclaimer">{f.disclaimer_ar}</div>
    </div>
  );
}

function FcChart({ f }: { f: ForecastResp }) {
  const W = 640, H = 230, padL = 36, padR = 14, top = 18, bottom = 34;
  if (!f.points.length) return <div className="empty">لا يوجد قراءات بعد</div>;
  const fc = f.forecast;
  const tOf = (p: Point) => Date.parse(p.created_at);
  const t0 = dayMs(f.points[0].date);
  const tEnd = fc ? dayMs(fc.points[fc.points.length - 1].date) + DAY / 2 : dayMs(f.points[f.points.length - 1].date) + DAY;
  const xs = (t: number) => padL + ((t - t0) / (tEnd - t0 || 1)) * (W - padL - padR);
  const ys0: number[] = f.points.map((p) => p.hr);
  if (f.baseline) ys0.push(...f.baseline.band);
  if (fc) fc.points.forEach((p) => ys0.push(p.lo, p.hi));
  const lo = Math.floor(Math.min(...ys0) - 3), hi = Math.ceil(Math.max(...ys0) + 3);
  const ys = (v: number) => top + (1 - (v - lo) / (hi - lo || 1)) * (H - top - bottom);
  const good = f.points.filter((p) => p.good);
  const last = good[good.length - 1];
  const nDays = Math.round((tEnd - t0) / DAY);
  const step = nDays > 14 ? 3 : 2;
  const ticks = Array.from({ length: Math.floor(nDays / step) + 1 }, (_, i) => t0 + i * step * DAY).filter((t) => xs(t) <= W - padR - 16);
  const yTicks = [lo + 2, Math.round((lo + hi) / 2), hi - 2];
  const symDays = Array.from(new Set(f.points.filter((p) => p.symptoms.length).map((p) => p.date)));
  const noon = (d: string) => dayMs(d) + DAY / 2 - 3 * 3600000; // ~09:00 Amman
  return (
    <svg className="fc-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="heart-rate forecast">
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={ys(v)} y2={ys(v)} stroke="var(--line)" />
          <text x={padL - 6} y={ys(v) + 4} textAnchor="end" className="fc-ax">{v}</text>
        </g>
      ))}
      {ticks.map((t) => (
        <text key={t} x={xs(t)} y={H - 10} textAnchor="middle" className="fc-ax">{new Date(t).toISOString().slice(5, 10)}</text>
      ))}
      {f.baseline && (
        <>
          <rect x={padL} width={W - padL - padR} y={ys(f.baseline.band[1])} height={ys(f.baseline.band[0]) - ys(f.baseline.band[1])} fill="var(--hr)" fillOpacity=".07" />
          <line x1={padL} x2={W - padR} y1={ys(f.baseline.median)} y2={ys(f.baseline.median)} stroke="var(--muted)" strokeOpacity=".7" />
          <text x={W - padR - 2} y={ys(f.baseline.median) - 4} textAnchor="end" className="fc-ax">baseline {Math.round(f.baseline.median)}</text>
        </>
      )}
      {f.cusum.alarm_dates.map((d) => (
        <g key={d}>
          <line x1={xs(noon(d))} x2={xs(noon(d))} y1={top - 6} y2={H - bottom} stroke="var(--apt)" strokeOpacity=".35" strokeDasharray="2 3" />
          <path d={`M ${xs(noon(d)) - 5} ${top - 12} L ${xs(noon(d)) + 5} ${top - 12} L ${xs(noon(d))} ${top - 4} Z`} fill="var(--apt)"><title>CUSUM {d}</title></path>
        </g>
      ))}
      {symDays.map((d) => (
        <g key={'s' + d}>
          <rect x={xs(noon(d)) - 4} y={H - bottom + 4} width="8" height="8" transform={`rotate(45 ${xs(noon(d))} ${H - bottom + 8})`} fill="var(--hrv)">
            <title>{f.points.filter((p) => p.date === d).flatMap((p) => p.symptoms).join('، ')}</title>
          </rect>
        </g>
      ))}
      {fc && last && (
        <>
          <polygon
            points={[`${xs(tOf(last))},${ys(last.hr)}`, ...fc.points.map((p) => `${xs(noon(p.date))},${ys(p.hi)}`), ...[...fc.points].reverse().map((p) => `${xs(noon(p.date))},${ys(p.lo)}`)].join(' ')}
            fill="var(--hrv)" fillOpacity=".14" stroke="none"
          />
          <polyline points={[`${xs(tOf(last))},${ys(last.hr)}`, ...fc.points.map((p) => `${xs(noon(p.date))},${ys(p.hr)}`)].join(' ')} fill="none" stroke="var(--hrv)" strokeWidth="2" strokeDasharray="5 4" />
          {fc.points.map((p) => <circle key={p.h} cx={xs(noon(p.date))} cy={ys(p.hr)} r="3" fill="var(--hrv)"><title>{`+${p.h}h ${p.hr} (${p.lo}–${p.hi})`}</title></circle>)}
        </>
      )}
      <polyline points={good.map((p) => `${xs(tOf(p))},${ys(p.hr)}`).join(' ')} fill="none" stroke="var(--hr)" strokeWidth="1.6" strokeOpacity=".8" />
      {f.points.map((p, i) => (
        <circle key={i} cx={xs(tOf(p))} cy={ys(p.hr)} r={p.good ? 3.2 : 3.6} fill={p.good ? 'var(--hr)' : 'none'} stroke={p.good ? 'none' : 'var(--muted)'} strokeWidth="1.5">
          <title>{`${p.date} · ${p.hr}${p.good ? '' : p.excluded ? ' (excluded)' : ' (poor)'}`}</title>
        </circle>
      ))}
    </svg>
  );
}

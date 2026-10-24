import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { HistoryPoint, Level } from './api';
import { LEVEL } from './api';

// Logo / Brand / ThemeToggle live in brand/ (brand workstream); re-exported so imports stay unchanged.
export { Logo, Brand, ThemeToggle } from './brand/Logo';

/** Scrolling pulse trace; values in [-1, 1]. */
export function Wave({ data, color = 'var(--hr)', height = 64 }: { data: number[]; color?: string; height?: number }) {
  const w = 300;
  const pts = data.length > 1 ? data.map((v, i) => `${(i / (data.length - 1)) * w},${height / 2 - v * (height / 2 - 4)}`).join(' ') : '';
  return (
    <svg className="wave" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden>
      <line x1="0" x2={w} y1={height / 2} y2={height / 2} stroke="var(--line)" strokeDasharray="3 5" />
      {pts && <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

export function Sparkline({ values, color, width = 90, height = 28 }: { values: (number | null)[]; color: string; width?: number; height?: number }) {
  const v = values.filter((x): x is number => x != null);
  if (v.length < 2) return <svg width={width} height={height} />;
  const lo = Math.min(...v), hi = Math.max(...v);
  const span = hi - lo || 1;
  const pts = values
    .map((x, i) => (x == null ? null : `${(i / (values.length - 1)) * width},${height - 3 - ((x - lo) / span) * (height - 6)}`))
    .filter(Boolean)
    .join(' ');
  const last = pts.split(' ').pop()!.split(',');
  return (
    <svg width={width} height={height} aria-hidden style={{ direction: 'ltr' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill={color} />
    </svg>
  );
}

const METRICS = [
  { key: 'hr' as const, label: 'النبض', unit: 'ن/د', color: 'var(--hr)' },
  { key: 'rr' as const, label: 'التنفس', unit: '/د', color: 'var(--rr)' },
  { key: 'stress' as const, label: 'التوتر', unit: '/100', color: 'var(--hrv)' },
];

/** Small multiples: one row per vital, with the 14-day baseline as a band. LTR time axis. */
export function TrendChart({ history, baseline }: { history: HistoryPoint[]; baseline: { hr: number | null; rr: number | null; stress: number | null } | null }) {
  const W = 640, rowH = 74, padL = 44, padR = 54;
  if (history.length < 2) return <div className="empty">لا يوجد تاريخ كافٍ بعد</div>;
  const xs = (i: number) => padL + (i / (history.length - 1)) * (W - padL - padR);
  return (
    <svg viewBox={`0 0 ${W} ${rowH * 3 + 22}`} style={{ width: '100%', direction: 'ltr' }} role="img" aria-label="trend">
      {METRICS.map((m, row) => {
        const vals = history.map((h) => h[m.key]);
        const v = vals.filter((x): x is number => x != null);
        const base = baseline?.[m.key] ?? null;
        const all = base != null ? [...v, base] : v;
        if (!v.length) return null;
        const lo = Math.min(...all) * 0.92, hi = Math.max(...all) * 1.06;
        const y0 = row * rowH + 8;
        const ys = (x: number) => y0 + rowH - 14 - ((x - lo) / (hi - lo || 1)) * (rowH - 22);
        const pts = vals.map((x, i) => (x == null ? null : `${xs(i)},${ys(x)}`)).filter(Boolean).join(' ');
        const last = v[v.length - 1];
        return (
          <g key={m.key}>
            <text x={0} y={y0 + 14} fill="var(--muted)" fontSize="12" fontFamily="IBM Plex Sans Arabic">{m.label}</text>
            <line x1={padL} x2={W - padR} y1={y0 + rowH - 6} y2={y0 + rowH - 6} stroke="var(--line)" />
            {base != null && (
              <>
                <line x1={padL} x2={W - padR} y1={ys(base)} y2={ys(base)} stroke={m.color} strokeOpacity=".35" strokeDasharray="4 4" />
                <text x={padL + 2} y={ys(base) - 4} fill={m.color} fillOpacity=".6" fontSize="10" fontFamily="IBM Plex Mono">baseline {Math.round(base)}</text>
              </>
            )}
            <polyline points={pts} fill="none" stroke={m.color} strokeWidth="2" strokeLinejoin="round" />
            {vals.map((x, i) => (x == null ? null : <circle key={i} cx={xs(i)} cy={ys(x)} r={i === vals.length - 1 ? 4 : 2} fill={m.color} />))}
            <text x={W - padR + 8} y={ys(last) + 4} fill={m.color} fontSize="14" fontFamily="IBM Plex Mono">{Math.round(last)}</text>
          </g>
        );
      })}
      <text x={padL} y={rowH * 3 + 18} fill="var(--dim)" fontSize="11" fontFamily="IBM Plex Mono">{history[0].date.slice(5)}</text>
      <text x={W - padR} y={rowH * 3 + 18} fill="var(--dim)" fontSize="11" fontFamily="IBM Plex Mono" textAnchor="end">{history[history.length - 1].date.slice(5)}</text>
    </svg>
  );
}

export function Qr({ text }: { text: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: 360, color: { dark: '#060908', light: '#ffffff' } }).then(setSrc).catch(() => setSrc(''));
  }, [text]);
  return <div className="qr">{src && <img src={src} alt={text} />}</div>;
}

export function LevelBadge({ level, small }: { level: Level; small?: boolean }) {
  const L = LEVEL[level];
  return (
    <span className={`chip ${L.cls}`} style={{ color: `var(--${L.cls})`, borderColor: 'currentColor', fontSize: small ? 12 : 13, padding: small ? '2px 10px' : undefined }}>
      <span className={`dot ${level === 'emergency' ? 'live-dot' : ''}`} />
      {L.ar}
    </span>
  );
}

export function Conf({ value, color }: { value: number; color: string }) {
  return (
    <div className="conf" title={`${Math.round(value * 100)}%`}>
      <i style={{ width: `${Math.round(value * 100)}%`, background: color }} />
    </div>
  );
}

export function confLabel(c: number) {
  return c >= 0.7 ? 'ثقة عالية' : c >= 0.4 ? 'ثقة متوسطة' : 'ثقة منخفضة';
}

export const STRESS_AR = { low: 'منخفض', moderate: 'متوسط', high: 'مرتفع' } as const;

export function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'هلّق';
  if (s < 3600) return `قبل ${Math.round(s / 60)} د`;
  if (s < 86400) return `قبل ${Math.round(s / 3600)} س`;
  return `قبل ${Math.round(s / 86400)} يوم`;
}

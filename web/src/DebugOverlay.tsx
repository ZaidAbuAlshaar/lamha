// Live engineering readout for ?debug=1 — numbers the team needs to see why a scan fails.
import type { DebugInfo } from './vitals/engine';

function Plot({ data, color, h = 46, marker }: { data: number[]; color: string; h?: number; marker?: number | null }) {
  const w = 300;
  if (data.length < 2) return <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: h }} />;
  let lo = Infinity, hi = -Infinity;
  for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 2 - ((v - lo) / span) * (h - 4)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h, direction: 'ltr', background: 'var(--bg-2)', borderRadius: 6 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {marker != null && <line x1={marker * w} x2={marker * w} y1={0} y2={h} stroke="var(--emg)" strokeDasharray="3 3" />}
    </svg>
  );
}

const f1 = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));

export default function DebugOverlay({ d }: { d?: DebugInfo }) {
  if (!d) return <div className="card num" style={{ fontSize: 12 }}>debug: waiting for data…</div>;
  const peakX = d.spec.peak != null && d.spec.f.length > 1 ? (d.spec.peak - d.spec.f[0]) / (d.spec.f[d.spec.f.length - 1] - d.spec.f[0]) : null;
  const cells: [string, string, boolean][] = [
    ['fps', f1(d.fps), d.fps >= 20],
    ['jitter ms', f1(d.jitter_ms), d.jitter_ms <= 15],
    ['proc ms', f1(d.proc_ms), d.proc_ms <= 30],
    ['ROI luma', f1(d.brightness, 0), d.brightness >= 70 && d.brightness <= 210],
    ['clipped %', f1(d.clipped_pct), d.clipped_pct <= 5],
    ['face %w', f1(d.face_width_pct, 0), d.face_width_pct >= 35],
    ['motion', f1(d.motion, 3), d.motion <= 0.01],
    ['yaw°', f1(d.yaw_deg, 0), Math.abs(d.yaw_deg) <= 15],
    ['backlight', f1(d.backlight_ratio, 2), !(d.backlight_ratio > 1.6)],
    ['SNR dB', f1(d.snr_db), (d.snr_db ?? -99) >= 0],
    ['HR', f1(d.hr, 0), true],
  ];
  return (
    <div className="card stack num" style={{ fontSize: 12, direction: 'ltr', textAlign: 'left', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {cells.map(([k, v, ok]) => (
          <div key={k}><div className="dim">{k}</div><b style={{ color: ok ? 'var(--hr)' : 'var(--apt)' }}>{v}</b></div>
        ))}
      </div>
      {d.gate && <div className="dim">gate: {Object.entries(d.gate).map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join('  ')}</div>}
      {d.algos && <div className="dim">algos: {Object.entries(d.algos).map(([k, v]) => `${k} ${f1(v)}`).join(' · ')}</div>}
      <div className="dim">raw G (10 s)</div><Plot data={d.raw} color="var(--hrv)" />
      <div className="dim">filtered BVP</div><Plot data={d.bvp} color="var(--hr)" />
      <div className="dim">spectrum 0.7–3 Hz (red = chosen peak)</div><Plot data={d.spec.p} color="var(--rr)" marker={peakX} />
    </div>
  );
}

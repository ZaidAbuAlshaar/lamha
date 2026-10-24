// Automation page for the synthetic-video bench test (nazra/eval/e2e). Not linked from the UI.
import { useEffect, useState } from 'react';
import { CameraScan } from './Check';
import type { VitalsResult } from './vitals/engine';

declare global {
  interface Window { __nazraE2E?: { status: string; progress: number; vitals: VitalsResult | null; error: string | null } }
}

export default function ScanTest() {
  const seconds = Number(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('seconds') ?? 30);
  const [v, setV] = useState<VitalsResult | null>(null);
  useEffect(() => { window.__nazraE2E = { status: 'loading', progress: 0, vitals: null, error: null }; }, []);
  return (
    <div className="app">
      <h2 style={{ margin: '16px 0' }}>scan-test · {seconds}s</h2>
      <CameraScan
        seconds={seconds}
        onLive={(u) => {
          const s = u.phase === 'error' ? 'error' : u.phase === 'scanning' || u.phase === 'analyzing' ? 'running' : 'loading';
          window.__nazraE2E = { status: s, progress: u.progress, vitals: null, error: u.error ?? null };
        }}
        onDone={(r) => { setV(r); window.__nazraE2E = { status: 'done', progress: 1, vitals: r, error: null }; }}
      />
      {v && <pre className="num" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{JSON.stringify({ ...v, bvp_preview: `[${v.bvp_preview.length}]` }, null, 2)}</pre>}
    </div>
  );
}

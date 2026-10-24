// Runtime feature flags. Every hardening behaviour can be switched off to compare against the original pipeline.
// Sources (later wins): defaults → localStorage 'nazra.flags' → URL `flags=` (search or hash query).
//   flags=all-off        original pre-hardening behaviour (baseline)
//   flags=default        hardened defaults
//   flags=skinMask:0,preScanGate:1   per-flag overrides
// Other URL params: debug=1 (debug overlay), mode=finger (fingertip PPG).

export const FLAG_DEFAULTS = {
  lockCamera: true, // lock exposure / white balance / focus after a 2 s auto-adjust (where supported)
  frameCallback: true, // requestVideoFrameCallback with real frame timestamps
  polygonRoi: true, // forehead + cheek polygons from landmarks (vs rect/circles)
  skinMask: true, // YCrCb skin mask + clipped-pixel rejection inside ROIs
  headPose: true, // mark non-frontal / fast-moving frames invalid
  preScanGate: true, // 3 s live check before the countdown
  multiAlgo: true, // POS + CHROM + GREEN per ROI, Welch PSD windows, SNR fusion, HR tracking
  bgSubtract: false, // regress out a background (non-skin) ROI to cancel light flicker (experimental)
  adaptiveExtend: true, // extend borderline scans up to 45 s and use the best 20 s
  fingertip: true, // offer rear-camera + torch fingertip mode after 2 failed scans
  qualityScore: true, // composite 0–1 quality score
  diagnostics: true, // send a numbers-only diagnostics record per scan
  centerAlerts: true, // emergency: show partner-center alert status (the 911 link always shows)
};

export type Flags = typeof FLAG_DEFAULTS;
export type FlagName = keyof Flags;

function params(): URLSearchParams {
  const p = new URLSearchParams(window.location.search);
  const hq = window.location.hash.split('?')[1];
  if (hq) new URLSearchParams(hq).forEach((v, k) => p.set(k, v));
  return p;
}

function parse(spec: string | null, base: Flags): Flags {
  if (!spec) return base;
  const out = { ...base };
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (part === 'all-off') (Object.keys(out) as FlagName[]).forEach((k) => (out[k] = false));
    else if (part === 'default') Object.assign(out, FLAG_DEFAULTS);
    else {
      const [k, v] = part.split(':');
      if (k in out) out[k as FlagName] = v !== '0' && v !== 'false';
    }
  }
  return out;
}

export function getFlags(): Flags {
  let stored: string | null = null;
  try { stored = localStorage.getItem('nazra.flags'); } catch { /* private mode */ }
  return parse(params().get('flags'), parse(stored, { ...FLAG_DEFAULTS }));
}

export function isDebug(): boolean {
  return params().get('debug') === '1';
}

export function scanMode(): 'face' | 'finger' {
  return params().get('mode') === 'finger' ? 'finger' : 'face';
}

export function flagSummary(f: Flags): string {
  return (Object.keys(f) as FlagName[]).map((k) => `${k}:${f[k] ? 1 : 0}`).join(',');
}

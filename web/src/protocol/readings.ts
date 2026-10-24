// v2 daily protocol: two consecutive 30 s readings, a third when they disagree, poor readings never counted.
// Pure logic (no DOM) so it runs under `node --experimental-strip-types tests/protocol.test.ts`.

export type Quality = 'good' | 'fair' | 'poor';

/** The minimum a scan result needs for the protocol. VitalsResult satisfies it. */
export interface ScanLike {
  hr_bpm: number | null;
  hr_confidence: number;
  quality: Quality;
}

export const AGREE_BPM = 5; // two readings within this many bpm are averaged
export const MAX_SCANS = 4; // hard cap on camera scans (poor ones included)

export type Method = 'mean2' | 'median' | 'single' | 'none';

export interface Decision {
  done: boolean;
  /** 1-based number of the next good reading we are waiting for (for «القراءة 1 من 2»). */
  next: number;
  /** How many good readings the protocol wants right now: 2, or 3 after a disagreement. */
  target: number;
  scans: number;
  good: number[]; // HRs of the good readings, in scan order
  final_hr: number | null;
  method: Method;
  /** True when we stopped at MAX_SCANS without the protocol completing. */
  incomplete: boolean;
}

export function isGood(r: ScanLike): boolean {
  return r.quality !== 'poor' && r.hr_bpm != null && Number.isFinite(r.hr_bpm);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

/** Decide what to do after the scans so far. */
export function evaluate(scans: ScanLike[]): Decision {
  const good = scans.filter(isGood).map((r) => r.hr_bpm as number);
  const n = scans.length;
  const base = { scans: n, good };
  if (good.length >= 3) return { ...base, done: true, next: good.length, target: good.length, final_hr: r1(median(good)), method: 'median', incomplete: false };
  if (good.length === 2) {
    const agree = Math.abs(good[0] - good[1]) <= AGREE_BPM;
    if (agree) return { ...base, done: true, next: 2, target: 2, final_hr: r1((good[0] + good[1]) / 2), method: 'mean2', incomplete: false };
    if (n >= MAX_SCANS) return { ...base, done: true, next: 2, target: 3, final_hr: r1(median(good)), method: 'median', incomplete: true };
    return { ...base, done: false, next: 3, target: 3, final_hr: null, method: 'none', incomplete: false };
  }
  if (n >= MAX_SCANS) {
    return { ...base, done: true, next: good.length, target: 2, final_hr: good.length ? r1(good[0]) : null, method: good.length ? 'single' : 'none', incomplete: true };
  }
  return { ...base, done: false, next: good.length + 1, target: 2, final_hr: null, method: 'none', incomplete: false };
}

export interface ProtocolFields {
  readings: number[];
  reading_count: number;
  scan_count: number;
  protocol_method: Method;
  protocol_incomplete: boolean;
}

/**
 * Merge the scans into one result. The other vitals (RR, HRV, confidence, waveform) come from the most
 * confident good scan; HR is the protocol's final value. With no good scan, the last scan is returned as-is (poor).
 */
export function combine<T extends ScanLike>(scans: T[]): T & ProtocolFields {
  if (!scans.length) throw new Error('combine() needs at least one scan');
  const d = evaluate(scans);
  const goodScans = scans.filter(isGood);
  const best = goodScans.length ? goodScans.reduce((a, b) => (b.hr_confidence > a.hr_confidence ? b : a)) : scans[scans.length - 1];
  const fields: ProtocolFields = {
    readings: d.good.map((x) => Math.round(x * 10) / 10),
    reading_count: d.good.length,
    scan_count: scans.length,
    protocol_method: d.method,
    protocol_incomplete: d.incomplete || !d.done,
  };
  return { ...best, ...(goodScans.length ? { hr_bpm: d.final_hr } : {}), ...fields };
}

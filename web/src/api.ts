export type Level = 'emergency' | 'appointment' | 'followup';

export interface Vitals {
  hr_bpm: number | null;
  hr_confidence: number;
  rr_bpm: number | null;
  rr_confidence: number;
  hrv_rmssd_ms: number | null;
  hrv_sdnn_ms: number | null;
  stress_index: number | null;
  stress_level: 'low' | 'moderate' | 'high' | null;
  quality: 'good' | 'fair' | 'poor';
  scan_seconds: number;
  fps: number;
  ref_hr_bpm: number | null;
  bvp_preview: number[];
}

export interface Patient {
  id: string;
  name_ar: string;
  name_en: string;
  age: number | null;
  sex: 'm' | 'f' | null;
  location_ar: string;
  location_en: string;
  conditions_ar: string[];
  conditions_en: string[];
  simulated: boolean;
  created_at: string;
}

export interface Symptom {
  key: string;
  label_ar: string;
  label_en: string;
  span: string;
  severity: 'mild' | 'moderate' | 'severe' | null;
  duration: string | null;
  verified: boolean;
}

export interface RedFlag { code: string; label_ar: string; label_en: string; evidence: string }
export interface TrendAlert { metric: 'hr' | 'rr' | 'stress'; label_ar: string; label_en: string; baseline: number; current: number; delta_pct: number; days: number }

export interface Checkin {
  id: string;
  patient_id: string;
  patient_name_ar: string;
  patient_name_en: string;
  created_at: string;
  simulated: boolean;
  vitals: Vitals;
  transcript: string;
  transcript_source: 'voice' | 'typed' | 'none';
  symptoms: Symptom[];
  red_flags: RedFlag[];
  trend_alerts: TrendAlert[];
  triage: { level: Level; rule_level: Level; ai_level: Level | null; reasons_ar: string[]; reasons_en: string[] };
  ai: { ok: boolean; model: string; summary_ar: string; summary_en: string; advice_ar: string; numbers_verified: boolean; latency_ms: number; error: string | null };
  review: { decision: 'confirm' | 'override'; final_level: Level; note: string; reviewed_at: string } | null;
}

export interface HistoryPoint { date: string; hr: number | null; rr: number | null; stress: number | null }

export interface PatientSummary extends Patient {
  latest: Checkin | null;
  history: HistoryPoint[];
  checkin_count: number;
}

export interface PatientDetail {
  patient: Patient;
  checkins: Checkin[];
  history: HistoryPoint[];
  baseline: { hr: number | null; rr: number | null; stress: number | null; n: number } | null;
}

export interface Health {
  ok: boolean;
  whisper: { ready: boolean; model: string; device: string; compute_type: string; error: string | null };
  llm: { reachable: boolean; ready: boolean; model: string; error: string | null };
  version: string;
}

export interface Validation {
  n: number;
  mae_bpm: number | null;
  rmse_bpm: number | null;
  within_5_pct: number | null;
  pairs: { checkin_id: string; patient_id: string; rppg: number; ref: number; quality: string; created_at: string }[];
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = await res.json();
      msg = body.detail ?? JSON.stringify(body);
    } catch { /* keep status */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  health: () => fetch('/api/health').then(j<Health>),
  patients: () => fetch('/api/patients').then(j<PatientSummary[]>),
  patient: (id: string) => fetch(`/api/patients/${id}`).then(j<PatientDetail>),
  createPatient: (p: { name_ar: string; age?: number | null; sex?: 'm' | 'f' | null; location_ar?: string }) =>
    fetch('/api/patients', json(p)).then(j<Patient>),
  transcribe: (blob: Blob) => {
    const fd = new FormData();
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    fd.append('audio', blob, `voice.${ext}`);
    return fetch('/api/transcribe', { method: 'POST', body: fd }).then(j<{ text: string; duration_s: number; processing_ms: number; model: string }>);
  },
  checkin: (body: { patient_id: string; vitals: Vitals; transcript: string; transcript_source: Checkin['transcript_source'] }) =>
    fetch('/api/checkins', json(body)).then(j<Checkin>),
  feed: (since?: string) => fetch(`/api/checkins?limit=20${since ? `&since=${encodeURIComponent(since)}` : ''}`).then(j<Checkin[]>),
  review: (id: string, body: { decision: 'confirm' | 'override'; final_level: Level; note: string }) =>
    fetch(`/api/checkins/${id}/review`, json(body)).then(j<Checkin>),
  validation: () => fetch('/api/validation').then(j<Validation>),
};

export const LEVEL = {
  emergency: { ar: 'طارئ', en: 'Emergency', patient: 'توجّه للطوارئ الآن أو اتصل على 911', cls: 'emg' },
  appointment: { ar: 'موعد', en: 'Appointment', patient: 'احجز موعد عند الطبيب خلال 24–48 ساعة', cls: 'apt' },
  followup: { ar: 'متابعة', en: 'Follow-up', patient: 'وضعك مستقر — كمّل الفحص اليومي', cls: 'fu' },
} as const;

export const levelRank: Record<Level, number> = { followup: 0, appointment: 1, emergency: 2 };

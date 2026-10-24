// Dev-only recording screen (#/dev-record) for the accuracy bench (nazra/eval/accuracy).
// OFF by default: it only appears when the server answers GET /api/dev/recordings with 200.
// Records exactly 30 s of 640x480@30 video at a high bitrate (compression destroys the tiny colour signal)
// plus a reference HR from an oximeter / smartwatch, and uploads both to the team laptop.
import { useEffect, useRef, useState } from 'react';

type Facing = 'user' | 'environment';
type Phase = 'checking' | 'off' | 'consent' | 'camera' | 'recording' | 'review' | 'uploading' | 'saved' | 'error';

const SECONDS = 30;
const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* ignore */ }
  }
  return '';
}

export default function DevRecord() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [agree, setAgree] = useState(false);
  const [facing, setFacing] = useState<Facing>('user');
  const [torch, setTorch] = useState<'unknown' | 'on' | 'unsupported' | 'off'>('off');
  const [left, setLeft] = useState(SECONDS);
  const [err, setErr] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [recSeconds, setRecSeconds] = useState(0);
  const [mime, setMime] = useState('');
  const [refHr, setRefHr] = useState('');
  const [refSource, setRefSource] = useState('oximeter');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [trackInfo, setTrackInfo] = useState('');
  const [trackDims, setTrackDims] = useState<{ width?: number; height?: number; fps?: number }>({});
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    let alive = true;
    fetch('/api/dev/recordings')
      .then((r) => { if (alive) setPhase(r.status === 200 ? 'consent' : 'off'); })
      .catch(() => { if (alive) setPhase('off'); });
    return () => { alive = false; stopAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopAll() {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    try { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); } catch { /* ignore */ }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function openCamera(f: Facing) {
    setErr(null);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: f, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      });
      streamRef.current = s;
      const track = s.getVideoTracks()[0];
      const st = track.getSettings();
      setTrackInfo(`${st.width ?? '?'}x${st.height ?? '?'} @ ${st.frameRate ? Math.round(st.frameRate) : '?'} fps`);
      setTrackDims({ width: st.width, height: st.height, fps: st.frameRate });
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        await videoRef.current.play().catch(() => undefined);
      }
      if (f === 'environment') await setTorchOn(track, true);
      else setTorch('off');
      setPhase('camera');
    } catch (e) {
      setErr(`تعذّر فتح الكاميرا: ${(e as Error).name || ''} ${(e as Error).message || ''}`);
      setPhase('error');
    }
  }

  async function setTorchOn(track: MediaStreamTrack, on: boolean) {
    const caps = (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as Record<string, unknown>;
    if (!('torch' in caps)) { setTorch('unsupported'); return; }
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as unknown as MediaTrackConstraintSet] });
      setTorch(on ? 'on' : 'off');
    } catch { setTorch('unsupported'); }
  }

  function switchFacing() {
    const f: Facing = facing === 'user' ? 'environment' : 'user';
    setFacing(f);
    void openCamera(f);
  }

  function startRecording() {
    const s = streamRef.current;
    if (!s) return;
    const m = pickMime();
    setMime(m);
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(s, m ? { mimeType: m, videoBitsPerSecond: 8_000_000 } : { videoBitsPerSecond: 8_000_000 });
    } catch (e) {
      setErr(`MediaRecorder غير مدعوم: ${(e as Error).message}`);
      setPhase('error');
      return;
    }
    const chunks: Blob[] = [];
    const t0 = performance.now();
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    rec.onstop = () => {
      setRecSeconds(+((performance.now() - t0) / 1000).toFixed(2));
      setBlob(new Blob(chunks, { type: rec.mimeType || m || 'video/webm' }));
      setPhase('review');
    };
    recRef.current = rec;
    rec.start(1000);
    setLeft(SECONDS);
    setPhase('recording');
    for (let i = 1; i <= SECONDS; i++) timers.current.push(window.setTimeout(() => setLeft(SECONDS - i), i * 1000));
    timers.current.push(window.setTimeout(() => { try { rec.stop(); } catch { /* ignore */ } }, SECONDS * 1000));
  }

  function cancelRecording() {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    const rec = recRef.current;
    if (rec) { rec.onstop = null; try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ } }
    setBlob(null);
    setPhase('camera');
  }

  async function upload() {
    if (!blob) return;
    const hr = Number(refHr);
    if (!Number.isFinite(hr) || hr < 30 || hr > 220) { setErr('اكتب نبض الجهاز المرجعي (بين 30 و 220)'); return; }
    setErr(null);
    setPhase('uploading');
    const ext = /mp4/.test(blob.type) ? 'mp4' : 'webm';
    const fd = new FormData();
    fd.append('video', blob, `clip.${ext}`);
    // server keeps: ref_hr_bpm, ref_source, device, facing, seconds, consent, note, fps, width, height
    fd.append('meta', JSON.stringify({
      ref_hr_bpm: hr, ref_source: refSource, device: navigator.userAgent, facing, seconds: recSeconds, consent: true,
      ...(trackDims.width ? { width: trackDims.width } : {}), ...(trackDims.height ? { height: trackDims.height } : {}),
      ...(trackDims.fps ? { fps: Math.round(trackDims.fps * 100) / 100 } : {}),
      note: `mime=${blob.type || mime || '?'}; torch=${torch}; requested_bps=8000000`,
    }));
    try {
      const r = await fetch('/api/dev/recordings', { method: 'POST', body: fd });
      const txt = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${txt.slice(0, 200)}`);
      let id: string | null = null;
      try { const j = JSON.parse(txt) as { id?: string }; id = j.id ?? null; } catch { /* not json */ }
      setSavedId(id ?? 'ok');
      setPhase('saved');
      stopAll();
    } catch (e) {
      setErr(`فشل الرفع: ${(e as Error).message}`);
      setPhase('review');
    }
  }

  function again() {
    setBlob(null); setSavedId(null); setRefHr(''); setErr(null);
    void openCamera(facing);
  }

  const mirror = facing === 'user';
  const showCam = phase === 'camera' || phase === 'recording' || phase === 'review' || phase === 'uploading';

  return (
    <div className="app" dir="rtl">
      <div className="topbar">
        <span className="brand">نظرة · تسجيل للتطوير</span>
        <span className="chip">dev</span>
      </div>

      {phase === 'checking' && <div className="screen"><p className="muted">…</p></div>}

      {phase === 'off' && (
        <div className="screen"><p className="lead">وضع التسجيل للتطوير مطفأ</p></div>
      )}

      {phase === 'consent' && (
        <div className="screen">
          <h1>تسجيل فيديو لاختبار الدقة</h1>
          <div className="card stack consent">
            <ul>
              <li>رح نسجّل فيديو مدته {SECONDS} ثانية لوجهك (أو لرأس إصبعك على الكاميرا الخلفية مع الفلاش).</li>
              <li>الفيديو بيضل على لابتوب الفريق فقط، وما بينرفع على أي خدمة خارجية.</li>
              <li>الهدف الوحيد: نقيس دقة قراءة النبض مقارنة بجهاز مرجعي (أوكسيميتر أو ساعة ذكية).</li>
              <li>ما بنستخدمه أبداً في النسخة الفعلية للتطبيق ولا لتدريب أي نموذج.</li>
              <li>بتقدر تطلب حذفه بأي وقت: بعد الحفظ بيطلعلك رقم التسجيل، أعطيه للفريق وبنحذفه.</li>
            </ul>
          </div>
          <label className="check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>موافق على التسجيل لهذا الغرض فقط</span>
          </label>
          <button className="btn primary block" disabled={!agree} onClick={() => void openCamera(facing)}>افتح الكاميرا</button>
        </div>
      )}

      {phase === 'error' && (
        <div className="screen">
          <p className="emg">{err}</p>
          <button className="btn block" onClick={() => void openCamera(facing)}>حاول مرة ثانية</button>
        </div>
      )}

      <div className="screen" style={{ display: showCam ? undefined : 'none' }}>
        <div className="cam">
          <video ref={videoRef} playsInline muted autoPlay style={mirror ? undefined : { transform: 'none' }} />
          <div className="hud">
            <span className="hud-pill num">{phase === 'recording' ? `● ${left}s` : trackInfo || '…'}</span>
            <span className="hud-pill">{facing === 'user' ? 'أمامية' : `خلفية · فلاش: ${torch === 'on' ? 'شغّال' : torch === 'unsupported' ? 'غير مدعوم' : 'مطفأ'}`}</span>
          </div>
          <div className="guide">
            {phase === 'recording' ? 'ثبّت الجهاز وما تتحرك…' : facing === 'user' ? 'وجهك بالنص، إضاءة أمامية، ثبّت الجهاز' : 'غطّي الكاميرا الخلفية والفلاش برأس إصبعك بلطف'}
          </div>
        </div>

        {phase === 'camera' && (
          <div className="stack">
            <button className="btn primary block" onClick={startRecording}>سجّل {SECONDS} ثانية</button>
            <button className="btn ghost block" onClick={switchFacing}>{facing === 'user' ? 'بدّل للكاميرا الخلفية + فلاش (إصبع)' : 'بدّل للكاميرا الأمامية (وجه)'}</button>
          </div>
        )}

        {phase === 'recording' && <button className="btn danger block" onClick={cancelRecording}>إلغاء</button>}

        {(phase === 'review' || phase === 'uploading') && blob && (
          <div className="card stack">
            <p className="muted num">{recSeconds}s · {(blob.size / 1e6).toFixed(1)} MB · {blob.type || mime || '?'}</p>
            <div className="field">
              <label htmlFor="refhr">نبض الجهاز المرجعي وقت التسجيل (bpm)</label>
              <input id="refhr" className="input num" inputMode="numeric" value={refHr} onChange={(e) => setRefHr(e.target.value.replace(/[^\d.]/g, ''))} placeholder="مثلاً 74" />
            </div>
            <div className="field">
              <label htmlFor="refsrc">مصدر القراءة</label>
              <select id="refsrc" className="input" value={refSource} onChange={(e) => setRefSource(e.target.value)}>
                <option value="oximeter">أوكسيميتر إصبع</option>
                <option value="smartwatch">ساعة ذكية</option>
                <option value="chest-strap">حزام صدر</option>
                <option value="other">غير ذلك</option>
              </select>
            </div>
            {err && <p className="emg">{err}</p>}
            <button className="btn primary block" disabled={phase === 'uploading'} onClick={() => void upload()}>{phase === 'uploading' ? 'عم يرفع…' : 'احفظ على لابتوب الفريق'}</button>
            <button className="btn ghost block" disabled={phase === 'uploading'} onClick={() => { setBlob(null); setPhase('camera'); }}>احذف وسجّل من جديد</button>
          </div>
        )}
      </div>

      {phase === 'saved' && (
        <div className="screen">
          <p className="lead">انحفظ التسجيل على لابتوب الفريق. شكراً!</p>
          {savedId && savedId !== 'ok' && <p className="muted">رقم التسجيل (للحذف لاحقاً): <span className="num">{savedId}</span></p>}
          <button className="btn primary block" onClick={again}>تسجيل جديد</button>
        </div>
      )}
    </div>
  );
}

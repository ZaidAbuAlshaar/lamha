import { useEffect, useRef, useState } from 'react';
import { getFlags } from './config';
import './chat.css';

type Source = 'rules' | 'ai' | 'ai-cloud' | 'template';
interface Msg { role: 'user' | 'assistant'; content: string; red?: boolean; source?: Source }
interface ChatReply { reply_ar: string; source: Source; red_flag: boolean; cards: string[] }

const SUGGEST = ['شو يعني نبضي؟', 'شو أعمل هلّق؟', 'إيمتى لازم أروح عالطوارئ؟'];
const DISC = 'مؤشر للمتابعة، مش تشخيص';
const FAIL = 'ما قدرت أجاوب هلّق — اسأل الطبيب أو المركز الصحي.';

function speakInBrowser(text: string, onEnd: () => void): boolean {
  if (!('speechSynthesis' in window)) return false;
  const u = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const v = voices.find((x) => x.lang === 'ar-JO') || voices.find((x) => x.lang.startsWith('ar'));
  if (v) u.voice = v;
  u.lang = 'ar-JO';
  u.rate = 0.95;
  u.onend = onEnd;
  u.onerror = onEnd;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  return true;
}

export default function Chat({ checkinId }: { checkinId?: string }) {
  const on = (getFlags() as Record<string, unknown>).chat !== false;
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef('');

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [msgs, busy]);
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => () => {
    audio.current?.pause();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  if (!on) return null;

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    const next: Msg[] = [...msgs, { role: 'user', content: t }];
    setMsgs(next);
    setInput('');
    setBusy(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkin_id: checkinId || undefined, messages: next.map(({ role, content }) => ({ role, content })) }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const d = (await r.json()) as ChatReply;
      setMsgs([...next, { role: 'assistant', content: d.reply_ar, red: d.red_flag, source: d.source }]);
    } catch {
      setMsgs([...next, { role: 'assistant', content: FAIL, source: 'template' }]);
    } finally {
      setBusy(false);
    }
  }

  function stopVoice() {
    audio.current?.pause();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeaking(null);
  }

  async function speak(i: number, text: string) {
    if (speaking === i) { stopVoice(); return; }
    stopVoice();
    setSpeaking(i);
    try {
      const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(blob);
      const a = new Audio(urlRef.current);
      audio.current = a;
      a.onended = () => setSpeaking(null);
      a.onerror = () => setSpeaking(null);
      await a.play();
    } catch {
      if (!speakInBrowser(text, () => setSpeaking(null))) setSpeaking(null);
    }
  }

  return (
    <>
      {!open && (
        <button type="button" className="chat-fab" onClick={() => setOpen(true)} aria-label="اسأل لمحة">
          <span aria-hidden="true">💬</span> اسأل لمحة
        </button>
      )}
      {open && (
        <div className="chat-layer" dir="rtl" lang="ar">
          <div className="chat-backdrop" onClick={() => setOpen(false)} />
          <section className="chat-sheet" role="dialog" aria-modal="true" aria-label="اسأل لمحة">
            <header className="chat-head">
              <span className="chat-grip" aria-hidden="true" />
              <h2>اسأل لمحة</h2>
              <button type="button" className="chat-x" onClick={() => setOpen(false)} aria-label="سكّر">✕</button>
            </header>
            <div className="chat-list" ref={listRef} aria-live="polite">
              {msgs.length === 0 && <p className="chat-hello">اسألني عن نتيجتك أو شو تعمل هلّق. أنا بعطيك معلومات عامة، والقرار للطبيب.</p>}
              {msgs.map((m, i) => (
                m.role === 'user'
                  ? <div key={i} className="chat-msg me">{m.content}</div>
                  : (
                    <div key={i} className={`chat-msg bot ${m.red ? 'red' : ''}`}>
                      <p>{m.content}</p>
                      {m.red && <a className="chat-911" href="tel:911">📞 اتصل 911</a>}
                      <button type="button" className="chat-speak" onClick={() => speak(i, m.content)}
                        aria-label={speaking === i ? 'وقّف الصوت' : 'اسمع الجواب'}>{speaking === i ? '⏹' : '🔊'}</button>
                    </div>
                  )
              ))}
              {busy && <div className="chat-msg bot typing" aria-label="عم يكتب"><i /><i /><i /></div>}
            </div>
            <div className="chat-chips">
              {SUGGEST.map((s) => <button type="button" key={s} className="chat-chip" disabled={busy} onClick={() => send(s)}>{s}</button>)}
            </div>
            <form className="chat-form" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
              <textarea ref={inputRef} className="chat-input" rows={1} value={input} maxLength={600} placeholder="اكتب سؤالك…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} />
              <button type="submit" className="chat-send" disabled={busy || !input.trim()} aria-label="ابعث">➤</button>
            </form>
            <p className="chat-foot">{DISC}</p>
          </section>
        </div>
      )}
    </>
  );
}

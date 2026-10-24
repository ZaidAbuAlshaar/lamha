// v2 daily reminder: a calendar file (.ics) with a daily repeating event at the current local time.
// No server and no push permission: the phone's own calendar app reminds the patient.

const pad = (n: number) => String(n).padStart(2, '0');

/** Local "floating" time (no timezone), so the event stays at the same wall-clock time every day. */
function localStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}

function utcStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

/** RFC 5545 line folding at 75 octets, never splitting a UTF-8 character. */
export function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length ? 74 : 75; // continuation lines start with a space
    if (bytes + b > limit) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export const REMINDER_TITLE = 'فحص نظرة اليومي';

export function buildIcs(now: Date = new Date(), url = ''): string {
  const desc = `افتح نظرة واعمل فحصك اليومي (30 ثانية قدام الكاميرا).${url ? ` ${url}` : ''}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nazra//Daily check-in//AR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:nazra-daily-${now.getTime()}@nazra.local`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${localStamp(now)}`,
    'DURATION:PT5M',
    'RRULE:FREQ=DAILY',
    `SUMMARY:${esc(REMINDER_TITLE)}`,
    `DESCRIPTION:${esc(desc)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:PT0M',
    `DESCRIPTION:${esc(REMINDER_TITLE)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Hand the .ics to the phone. iOS Safari opens a data: calendar URL in its "Add to Calendar" sheet; others download. */
export function downloadIcs(now: Date = new Date()): void {
  const ics = buildIcs(now, window.location.origin + window.location.pathname);
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  if (ios) {
    window.location.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
    return;
  }
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = 'nazra-daily.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
}

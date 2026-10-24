#!/usr/bin/env node
// run_flow.mjs - full v2 patient flow in headless Chrome with a FAKE CAMERA (SIMULATED 72 bpm face) and FAKE MIC (wav).
//
//   node run_flow.mjs [--url http://127.0.0.1:8787] [--viewports iphone14,pixel7] [--emergency iphone14|none] [--keep]
//                     [--video E:\nazra-e2e\face_72bpm_15rpm.y4m] [--wav E:\nazra-e2e\flow_symptom_ar.wav]
//                     [--wav-emergency E:\nazra-e2e\flow_emergency_ar.wav]
//
// Scenario A (each viewport): /#/ «ابدأ الفحص» -> name «اختبار آلي …» «متابعة» -> consent (main checkbox; the 3 sharing
//   toggles stay at their defaults) «افتح الكاميرا» -> context questions (answers «لأ») -> reading 1 + reading 2
//   (clicks «ابدأ القياس على كل حال» when the pre-scan gate gets stuck on the small synthetic face, «ابدأ القراءة 2»
//   between readings) -> vitals «التالي: احكيلنا شو بتحس» -> breathing «تخطّى» -> voice: mic «ابدأ التسجيل», 6 s,
//   «وقّف التسجيل» -> transcript -> «أرسل للطبيب» -> result -> «شوف تقريري» -> report sections -> «اسمع التقرير» (/api/tts 200)
//   -> GET /api/checkins has the check-in.
// Scenario B (one viewport): same with an EMERGENCY sentence -> result shows the emergency banner -> a second page opens
//   #/center?id=<alert.current_center_id>, «ابدأ المناوبة», waits for the alert, «استلمنا» -> the patient page shows
//   «✅ المركز استلم حالتك». Then #/doctor: forecast card for «أبو محمد» and the community tab shows الرمثا.
// Screenshots: results/flow/<scenario>_<nn>_<step>.png. Afterwards (unless --keep) cleanup_test_patients.py deletes ONLY
// patients named «اختبار آلي…», their check-ins and their alerts.
// Audio: flow_symptom_ar.wav / flow_emergency_ar.wav are nazra/eval/audio/samples/{normal,emergency}_sana.webm (edge-tts
//   ar-JO-SanaNeural, SIMULATED) -> 48 kHz mono PCM + 1.5 s silence; Chrome loops the file.
// HONEST LIMIT: desktop Chrome emulating phone viewport + UA, not real iOS Safari / Android hardware.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2); const nxt = argv[i + 1];
    if (nxt === undefined || nxt.startsWith('--')) a[k] = true; else { a[k] = nxt; i++; }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const base = String(args.url || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const video = path.resolve(String(args.video || 'E:\\nazra-e2e\\face_72bpm_15rpm.y4m'));
const wavNormal = path.resolve(String(args.wav || 'E:\\nazra-e2e\\flow_symptom_ar.wav'));
const wavEmerg = path.resolve(String(args['wav-emergency'] || 'E:\\nazra-e2e\\flow_emergency_ar.wav'));
const chromePath = String(args.chrome || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const outDir = path.join(here, 'results', 'flow');
fs.mkdirSync(outDir, { recursive: true });
const profileRoot = fs.existsSync('E:\\') ? 'E:\\nazra-e2e\\profiles' : path.join(os.tmpdir(), 'nazra-flow-profiles');
fs.mkdirSync(profileRoot, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

const VIEWPORTS = {
  iphone14: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
  pixel7: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36' },
};
const vps = String(args.viewports || 'iphone14,pixel7').split(',').filter((v) => VIEWPORTS[v]);
const emergencyVp = args.emergency === 'none' ? null : String(args.emergency || 'iphone14');
for (const f of [video, wavNormal, chromePath, ...(emergencyVp ? [wavEmerg] : [])]) if (!fs.existsSync(f)) { console.error(`missing: ${f}`); process.exit(2); }

// ---------- element helpers (visible text / aria-label / selector) ----------
async function findEl(page, { text, aria, selector, exact }) {
  const h = await page.evaluateHandle(({ text, aria, selector, exact }) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    let c;
    if (selector) c = [...document.querySelectorAll(selector)];
    else if (aria) c = [...document.querySelectorAll(`[aria-label="${aria}"]`)];
    else c = [...document.querySelectorAll('button, a, label, [role=button]')].filter((el) => (exact ? norm(el.innerText) === text : norm(el.innerText).includes(text)));
    c = c.filter(vis);
    c.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    return c[0] || null;
  }, { text, aria, selector, exact });
  const el = h.asElement();
  if (!el) { await h.dispose(); return null; }
  return el;
}
async function waitEl(page, q, timeoutS, { enabled = false } = {}) {
  const t0 = Date.now();
  for (;;) {
    const el = await findEl(page, q);
    if (el && (!enabled || !(await el.evaluate((e) => !!e.disabled)))) return el;
    if ((Date.now() - t0) / 1000 > timeoutS) return null;
    await sleep(400);
  }
}
const bodyText = (page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
async function getJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url} -> ${r.status}`); return r.json(); }

function makeRunner(label, rec) {
  let n = 0;
  const shot = async (page, name, full = false) => {
    n++;
    const p = path.join(outDir, `${label}_${String(n).padStart(2, '0')}_${name}.png`);
    try { await page.screenshot({ path: p, fullPage: full }); } catch { return null; }
    return p;
  };
  const step = async (page, name, fn, { full = false } = {}) => {
    const t0 = Date.now();
    try {
      const extra = await fn();
      const s = { step: name, ok: true, ms: Date.now() - t0, screenshot: await shot(page, name, full), ...(extra || {}) };
      rec.steps.push(s); console.log(`  [${label}] ok   ${name} (${s.ms} ms)`);
      return true;
    } catch (e) {
      const s = { step: name, ok: false, ms: Date.now() - t0, error: String(e.message || e), screenshot: await shot(page, `${name}_FAIL`, true) };
      rec.steps.push(s); console.log(`  [${label}] FAIL ${name}: ${s.error}`);
      rec.error = rec.error || `${name}: ${s.error}`;
      return false;
    }
  };
  const click = async (page, q, timeoutS = 20, opts = {}) => {
    const el = await waitEl(page, q, timeoutS, opts);
    if (!el) throw new Error(`not found${opts.enabled ? '/enabled' : ''}: ${q.text ?? q.aria ?? q.selector}`);
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await el.click();
  };
  return { shot, step, click };
}

async function launch(vp, wav) {
  const userDataDir = fs.mkdtempSync(path.join(profileRoot, 'flow-'));
  const browser = await puppeteer.launch({
    executablePath: chromePath, headless: true, userDataDir, protocolTimeout: 120000,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`,
      `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const newPage = async () => {
    const page = await browser.newPage();
    await page.setUserAgent(vp.ua);
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    return page;
  };
  const close = async () => {
    try { await browser.close(); } catch { /* ignore */ }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); break; } catch { await sleep(400); } }
  };
  return { browser, newPage, close, version: await browser.version() };
}

// ---------- patient flow up to the result screen (shared by both scenarios) ----------
async function patientFlow(page, R, rec, name) {
  const { step, click, shot } = R;
  if (!await step(page, 'home', async () => { await page.goto(`${base}/#/`, { waitUntil: 'networkidle2', timeout: 30000 }); })) return false;
  if (!await step(page, 'start', () => click(page, { text: 'ابدأ الفحص' }))) return false;
  if (!await step(page, 'name', async () => {
    const el = await waitEl(page, { selector: 'input#nm' }, 20);
    if (!el) throw new Error('name input #nm not found');
    await el.click(); await el.type(name);
  })) return false;
  if (!await step(page, 'continue', () => click(page, { text: 'متابعة', exact: true }, 20, { enabled: true }))) return false;
  if (!await step(page, 'consent', async () => {
    await waitEl(page, { text: 'افتح الكاميرا' }, 20);
    const st = await page.evaluate(() => [...document.querySelectorAll('label.check')].map((l) => ({ label: l.innerText.trim().slice(0, 60), checked: l.querySelector('input')?.checked })));
    const main = await waitEl(page, { selector: 'label.check input[type=checkbox]' }, 5);
    if (!main) throw new Error('consent checkbox not found');
    if (!(await main.evaluate((e) => e.checked))) await main.click();
    return { toggles_before: st };
  })) return false;
  if (!await step(page, 'open_camera', () => click(page, { text: 'افتح الكاميرا' }, 10, { enabled: true }))) return false;
  // context questions: one tap each («لأ») until the question screen is gone
  if (!await step(page, 'context_questions', async () => {
    const answered = [];
    for (let i = 0; i < 8; i++) {
      await sleep(600);
      const t = await bodyText(page);
      const m = t.match(/سؤال (\d+) من (\d+)/);
      if (!m) break;
      const q = await page.evaluate(() => document.querySelector('.proto-q')?.innerText ?? null);
      if (i === 0) await shot(page, 'context_q1');
      await click(page, { text: 'لأ', exact: true }, 5);
      answered.push({ q, a: 'لأ' });
    }
    if (!answered.length) throw new Error('no context question screen seen');
    return { answered };
  })) return false;
  // readings loop
  const scanInfo = { gate_force_clicks: 0, reading_buttons: [], events: [] };
  if (!await step(page, 'readings', async () => {
    const t0 = Date.now();
    let shotGate = false, shotBetween = false, shotScan = false;
    for (;;) {
      if ((Date.now() - t0) / 1000 > 300) throw new Error('readings did not reach the vitals screen within 300 s');
      if (!shotScan && (Date.now() - t0) > 6000) { await shot(page, 'reading1_scanning'); shotScan = true; }
      const force = await findEl(page, { text: 'ابدأ القياس على كل حال' });
      if (force) { if (!shotGate) { await shot(page, 'gate_stuck'); shotGate = true; } await force.click(); scanInfo.gate_force_clicks++; scanInfo.events.push(`gate-force@${((Date.now() - t0) / 1000).toFixed(0)}s`); await sleep(1500); continue; }
      const nextRead = await findEl(page, { text: 'ابدأ القراءة' });
      if (nextRead) { if (!shotBetween) { await shot(page, 'between_readings'); shotBetween = true; } const tx = await nextRead.evaluate((e) => e.innerText); await nextRead.click(); scanInfo.reading_buttons.push(tx); scanInfo.events.push(`${tx}@${((Date.now() - t0) / 1000).toFixed(0)}s`); await sleep(1500); continue; }
      const redo = await findEl(page, { text: 'أعد القراءة' });
      if (redo) { await redo.click(); scanInfo.events.push(`redo@${((Date.now() - t0) / 1000).toFixed(0)}s`); await sleep(1500); continue; }
      const nxt = await findEl(page, { text: 'التالي: احكيلنا شو بتحس' });
      if (nxt && await page.evaluate(() => /قراءتك/.test(document.body.innerText))) break;
      await sleep(1000);
    }
    scanInfo.seconds = +((Date.now() - t0) / 1000).toFixed(0);
    return scanInfo;
  })) return false;
  if (!await step(page, 'vitals', async () => {
    const t = await bodyText(page);
    return { vitals_text_excerpt: t.slice(0, 500) };
  }, { full: true })) return false;
  if (!await step(page, 'vitals_next', () => click(page, { text: 'التالي: احكيلنا شو بتحس' }, 10, { enabled: true }))) return false;
  if (!await step(page, 'breathing_skip', async () => {
    const sk = await waitEl(page, { text: 'تخطّى', exact: true }, 10);
    if (!sk) { if (await findEl(page, { aria: 'ابدأ التسجيل' })) return { note: 'no breathing screen (flag off or finger mode)' }; throw new Error('«تخطّى» not found'); }
    await sk.click();
  })) return false;
  if (!await step(page, 'mic_start', () => click(page, { aria: 'ابدأ التسجيل' }, 20))) return false;
  await sleep(6000); await shot(page, 'recording');
  if (!await step(page, 'mic_stop', () => click(page, { aria: 'وقّف التسجيل' }, 10))) return false;
  if (!await step(page, 'transcript', async () => {
    const el = await waitEl(page, { text: 'أرسل للطبيب' }, 120, { enabled: true });
    if (!el) { const err = await page.evaluate(() => document.querySelector('.err')?.innerText ?? null); throw new Error(`no transcript within 120 s${err ? ` (page: ${err})` : ''}`); }
    return { transcript: await page.evaluate(() => document.querySelector('textarea')?.value ?? null) };
  })) return false;
  if (!await step(page, 'send', async () => {
    await click(page, { text: 'أرسل للطبيب' }, 10, { enabled: true });
    const t0 = Date.now();
    for (;;) {
      await sleep(1000);
      if (await page.evaluate(() => /النتيجة/.test(document.body.innerText) && !document.querySelector('.spinner'))) break;
      const err = await page.evaluate(() => document.querySelector('.err')?.innerText ?? null);
      if (err) throw new Error(`send error: ${err}`);
      if ((Date.now() - t0) / 1000 > 150) throw new Error('result screen not reached within 150 s');
    }
    await sleep(1500);
    return { result_text_excerpt: (await bodyText(page)).slice(0, 500) };
  }, { full: true })) return false;
  if (!await step(page, 'api_checkin', async () => {
    const list = await getJson(`${base}/api/checkins?limit=10`);
    const c = list.find((x) => x.patient_name_ar === name);
    if (!c) throw new Error(`no check-in for «${name}» in the latest 10`);
    rec.checkin = c;
    return { checkin_id: c.id, hr_bpm: c.vitals?.hr_bpm ?? null, quality: c.vitals?.quality ?? null, reading_count: c.vitals?.reading_count ?? null, triage: c.triage?.level ?? null, alert_id: c.alert_id ?? null, transcript: c.transcript };
  })) return false;
  return true;
}

async function reportSteps(page, R) {
  const { step, click } = R;
  if (!await step(page, 'open_report', async () => {
    await click(page, { text: 'شوف تقريري' }, 15);
    const t0 = Date.now();
    let heads = [];
    while ((Date.now() - t0) / 1000 < 60) {
      heads = await page.evaluate(() => [...document.querySelectorAll('h2')].map((h) => h.innerText.replace(/\s+/g, ' ').trim()));
      if (heads.length >= 3) break;
      await sleep(800);
    }
    const want = ['الملخص', 'القياسات', 'شو تعمل هلأ', 'اتصل على', 'أسئلة تسألها لطبيبك', 'أقرب مركز صحي', 'امسح الكود'];
    const missing = want.filter((w) => !heads.some((h) => h.includes(w)));
    const qr = await page.evaluate(() => !!document.querySelector('svg, canvas, img[src^="data:"]'));
    if (heads.length < 3) throw new Error(`report did not render (h2: ${heads.join(' | ') || 'none'})`);
    return { sections: heads, expected_missing: missing, has_svg_or_canvas: qr, hash: await page.evaluate(() => location.hash) };
  }, { full: true })) return;
  await step(page, 'listen_tts', async () => {
    const resp = page.waitForResponse((r) => r.url().includes('/api/tts'), { timeout: 90000 });
    await click(page, { text: 'اسمع التقرير' }, 10, { enabled: true });
    const r = await resp;
    const ct = r.headers()['content-type'] || '';
    let bytes = null; try { bytes = (await r.buffer()).length; } catch { /* streamed */ }
    if (r.status() !== 200) throw new Error(`/api/tts -> ${r.status()}`);
    await sleep(1500);
    return { tts_status: r.status(), tts_content_type: ct, tts_bytes: bytes, button_now: await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.innerText).find((t) => /الصوت|اسمع/.test(t)) ?? null) };
  });
}

// ---------- scenario A ----------
async function scenarioNormal(vpName) {
  const vp = VIEWPORTS[vpName];
  const label = `${vpName}`;
  const name = `اختبار آلي ${vpName} ${stamp}`;
  const rec = { scenario: 'normal', viewport: vpName, size: `${vp.width}x${vp.height}`, ua: vp.ua, patient_name: name, steps: [], ok: false, error: null, console_errors: [] };
  const R = makeRunner(label, rec);
  let L;
  try {
    L = await launch(vp, wavNormal); rec.chrome = L.version;
    const page = await L.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/^INFO:/.test(m.text())) rec.console_errors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => rec.console_errors.push(`[pageerror] ${String(e.message).slice(0, 300)}`));
    if (await patientFlow(page, R, rec, name)) await reportSteps(page, R);
  } catch (e) { rec.error = rec.error || String(e.message || e); }
  finally { await L?.close(); }
  rec.ok = !rec.error && rec.steps.every((s) => s.ok);
  return rec;
}

// ---------- scenario B ----------
async function scenarioEmergency(vpName) {
  const vp = VIEWPORTS[vpName];
  const label = `emergency_${vpName}`;
  const name = `اختبار آلي طوارئ ${vpName} ${stamp}`;
  const rec = { scenario: 'emergency', viewport: vpName, size: `${vp.width}x${vp.height}`, ua: vp.ua, patient_name: name, steps: [], ok: false, error: null, console_errors: [] };
  const R = makeRunner(label, rec);
  let L;
  try {
    L = await launch(vp, wavEmerg); rec.chrome = L.version;
    const page = await L.newPage();
    page.on('pageerror', (e) => rec.console_errors.push(`[pageerror] ${String(e.message).slice(0, 300)}`));
    if (await patientFlow(page, R, rec, name)) {
      const c = rec.checkin;
      let alert = null;
      if (await R.step(page, 'emergency_banner', async () => {
        if (c.triage?.level !== 'emergency') throw new Error(`triage is ${c.triage?.level}, not emergency (transcript: ${c.transcript})`);
        const t = await bodyText(page);
        if (!/حالة طارئة/.test(t)) throw new Error('emergency banner «حالة طارئة» not shown');
        if (!c.alert_id) throw new Error('check-in has no alert_id');
        alert = await getJson(`${base}/api/alerts/${encodeURIComponent(c.alert_id)}`);
        return { alert_id: c.alert_id, alert_status: alert.status, current_center_id: alert.current_center_id, current_center_name_ar: alert.current_center_name_ar, step: alert.step };
      })) {
        const center = await L.newPage();
        await center.setViewport({ width: 1280, height: 900 });
        const okStart = await R.step(center, 'center_open_start_shift', async () => {
          alert = await getJson(`${base}/api/alerts/${encodeURIComponent(c.alert_id)}`); // centre may have changed by escalation
          await center.goto(`${base}/#/center?id=${encodeURIComponent(alert.current_center_id)}`, { waitUntil: 'networkidle2', timeout: 30000 });
          await R.click(center, { text: 'ابدأ المناوبة' }, 15);
          return { center_id: alert.current_center_id };
        });
        if (okStart && await R.step(center, 'center_ack', async () => {
          const ack = await waitEl(center, { text: 'استلمنا', exact: true }, 60, { enabled: true });
          if (!ack) throw new Error('«استلمنا» button for the alert did not appear within 60 s');
          await ack.click();
          await sleep(1500);
          const a2 = await getJson(`${base}/api/alerts/${encodeURIComponent(c.alert_id)}`);
          if (a2.status !== 'acked') throw new Error(`alert status after ack = ${a2.status}`);
          return { alert_status_after: a2.status };
        })) {
          await R.step(page, 'patient_sees_ack', async () => {
            const t0 = Date.now();
            while ((Date.now() - t0) / 1000 < 40) {
              if (/✅ المركز استلم حالتك/.test(await bodyText(page))) return { seconds: +((Date.now() - t0) / 1000).toFixed(0) };
              await sleep(1000);
            }
            throw new Error('«✅ المركز استلم حالتك» not shown within 40 s');
          });
        }
      }
    }
    // doctor dashboard checks
    const doc = await L.newPage();
    await doc.setViewport({ width: 1280, height: 900 });
    if (await R.step(doc, 'doctor_forecast_abu_mohammad', async () => {
      await doc.goto(`${base}/#/doctor`, { waitUntil: 'networkidle2', timeout: 30000 });
      const item = await waitEl(doc, { text: 'أبو محمد' }, 20);
      if (!item) throw new Error('«أبو محمد» not in the doctor queue');
      await item.click();
      const t0 = Date.now();
      while ((Date.now() - t0) / 1000 < 40) {
        const ok = await doc.evaluate(() => { const c = document.querySelector('.fc-card'); return c && !c.querySelector('.spinner') && /توقّع صحة المريض/.test(c.innerText) ? c.innerText.replace(/\s+/g, ' ').slice(0, 300) : null; });
        if (ok) return { forecast_text: ok };
        await sleep(800);
      }
      throw new Error('forecast card «توقّع صحة المريض» did not render within 40 s');
    }, { full: true })) { /* continue */ }
    await R.step(doc, 'doctor_community_ramtha', async () => {
      await R.click(doc, { text: 'الإنذار المجتمعي' }, 10);
      await sleep(2500);
      const t = await bodyText(doc);
      if (!/الرمثا/.test(t)) throw new Error('community tab has no «الرمثا»');
      return { excerpt: t.slice(t.indexOf('الرمثا') - 80, t.indexOf('الرمثا') + 160) };
    }, { full: true });
  } catch (e) { rec.error = rec.error || String(e.message || e); }
  finally { await L?.close(); }
  rec.ok = !rec.error && rec.steps.every((s) => s.ok);
  return rec;
}

const runs = [];
for (const v of vps) { console.log(`\n=== flow (normal): ${v} ===`); runs.push(await scenarioNormal(v)); }
if (emergencyVp && VIEWPORTS[emergencyVp]) { console.log(`\n=== flow (emergency): ${emergencyVp} ===`); runs.push(await scenarioEmergency(emergencyVp)); }
let cleanup = null;
if (!args.keep) {
  const py = fs.existsSync('D:\\python.exe') ? 'D:\\python.exe' : 'python';
  const r = spawnSync(py, [path.join(here, 'cleanup_test_patients.py')], { encoding: 'utf8' });
  cleanup = { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim().slice(0, 500) };
  console.log(`\ncleanup: ${cleanup.stdout || cleanup.stderr}`);
  try {
    const list = await getJson(`${base}/api/checkins?limit=50`);
    cleanup.remaining_test_checkins_in_api = list.filter((x) => (x.patient_name_ar || '').startsWith('اختبار آلي')).length;
  } catch { /* ignore */ }
}
const out = { kind: 'full-flow e2e, headless desktop Chrome emulating phone viewports (NOT real iOS Safari / Android); fake camera = SIMULATED 72 bpm face, fake mic = SIMULATED TTS wav',
  when: new Date().toISOString(), base, video, wavNormal, wavEmerg, runs: runs.map(({ checkin, ...r }) => r), cleanup };
const jp = path.join(outDir, `flow_${stamp}.json`);
fs.writeFileSync(jp, JSON.stringify(out, null, 2), 'utf8');
console.log(`\nsaved ${jp}`);
for (const r of runs) console.log(`${r.scenario}/${r.viewport}: ${r.ok ? 'PASS' : `FAIL (${r.error})`}`);
process.exit(runs.every((r) => r.ok) ? 0 : 1);

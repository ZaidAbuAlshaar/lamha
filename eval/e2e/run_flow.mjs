#!/usr/bin/env node
// run_flow.mjs - full patient flow in headless Chrome with a FAKE CAMERA (synthetic 72 bpm face) and FAKE MIC (wav).
//
//   node run_flow.mjs [--url http://127.0.0.1:8787] [--video E:\nazra-e2e\face_72bpm_15rpm.y4m]
//                     [--wav E:\nazra-e2e\flow_symptom_ar.wav] [--viewports iphone14,pixel7] [--keep]
//
// Steps: /#/ -> «ابدأ الفحص» -> name «اختبار آلي …» -> «متابعة» -> consent tick -> «افتح الكاميرا» -> scan ends ->
//        «التالي: احكيلنا شو بتحس» -> mic «ابدأ التسجيل», 6 s, «وقّف التسجيل» -> transcript -> «أرسل للطبيب» -> result.
// Then GET /api/checkins?limit=10 must contain a check-in for that patient. Screenshots: results/flow/<viewport>_<nn>_<step>.png.
// Afterwards (unless --keep) cleanup_test_patients.py deletes ONLY patients named «اختبار آلي…» and their check-ins.
// Fake mic default = flow_symptom_ar.wav: nazra/eval/audio/samples/normal_sana.webm (edge-tts ar-JO-SanaNeural, SIMULATED:
//   «عندي كحة خفيفة من يومين وشوية سخونة») converted to 48 kHz mono PCM + 1.5 s silence; Chrome loops it.
// HONEST LIMIT: this is desktop Chrome emulating phone viewport + UA, not real iOS Safari / Android hardware.

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
const wav = path.resolve(String(args.wav || 'E:\\nazra-e2e\\flow_symptom_ar.wav'));
const chromePath = String(args.chrome || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const scanTimeoutS = Number(args['scan-timeout'] || 200);
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
for (const f of [video, wav, chromePath]) if (!fs.existsSync(f)) { console.error(`missing: ${f}`); process.exit(2); }

// find a visible clickable element by exact-ish visible text or aria-label; returns an ElementHandle or null
async function findEl(page, { text, aria, selector }) {
  const h = await page.evaluateHandle(({ text, aria, selector }) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    let c = [];
    if (selector) c = [...document.querySelectorAll(selector)];
    else if (aria) c = [...document.querySelectorAll(`[aria-label="${aria}"]`)];
    else c = [...document.querySelectorAll('button, a, label, [role=button]')].filter((el) => (el.innerText || '').replace(/\s+/g, ' ').trim().includes(text));
    c = c.filter(vis);
    // prefer the tightest match (shortest text)
    c.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    return c[0] || null;
  }, { text, aria, selector });
  const el = h.asElement();
  if (!el) { await h.dispose(); return null; }
  return el;
}
async function waitEl(page, q, timeoutS, { enabled = false } = {}) {
  const t0 = Date.now();
  for (;;) {
    const el = await findEl(page, q);
    if (el) {
      if (!enabled) return el;
      const dis = await el.evaluate((e) => !!e.disabled);
      if (!dis) return el;
    }
    if ((Date.now() - t0) / 1000 > timeoutS) return null;
    await sleep(500);
  }
}

async function runViewport(vpName) {
  const vp = VIEWPORTS[vpName];
  const name = `اختبار آلي ${vpName} ${stamp}`;
  const steps = [];
  const rec = { viewport: vpName, size: `${vp.width}x${vp.height}`, ua: vp.ua, patient_name: name, steps, ok: false, error: null, console_errors: [] };
  const userDataDir = fs.mkdtempSync(path.join(profileRoot, 'flow-'));
  let browser; let page; let n = 0;
  const shot = async (label) => {
    n++;
    const p = path.join(outDir, `${vpName}_${String(n).padStart(2, '0')}_${label}.png`);
    try { await page.screenshot({ path: p, fullPage: false }); } catch { return null; }
    return p;
  };
  const step = async (label, fn) => {
    const t0 = Date.now();
    try {
      const extra = await fn();
      const s = { step: label, ok: true, ms: Date.now() - t0, screenshot: await shot(label), ...(extra || {}) };
      steps.push(s); console.log(`  [${vpName}] ok   ${label} (${s.ms} ms)`);
      return true;
    } catch (e) {
      const s = { step: label, ok: false, ms: Date.now() - t0, error: String(e.message || e), screenshot: await shot(`${label}_FAIL`) };
      steps.push(s); console.log(`  [${vpName}] FAIL ${label}: ${s.error}`);
      rec.error = `${label}: ${s.error}`;
      return false;
    }
  };
  const click = async (q, timeoutS = 20, opts = {}) => {
    const el = await waitEl(page, q, timeoutS, opts);
    if (!el) throw new Error(`not found${opts.enabled ? '/enabled' : ''}: ${q.text ?? q.aria ?? q.selector}`);
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await el.click();
  };
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath, headless: true, userDataDir, protocolTimeout: 90000,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`,
        `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    });
    rec.chrome = await browser.version();
    page = await browser.newPage();
    await page.setUserAgent(vp.ua);
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    page.on('console', (m) => { if (m.type() === 'error' && !/^INFO:/.test(m.text())) rec.console_errors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => rec.console_errors.push(`[pageerror] ${String(e.message).slice(0, 300)}`));

    if (!await step('home', async () => { await page.goto(`${base}/#/`, { waitUntil: 'networkidle2', timeout: 30000 }); })) return rec;
    if (!await step('start', () => click({ text: 'ابدأ الفحص' }))) return rec;
    if (!await step('name', async () => {
      const el = await waitEl(page, { selector: 'input#nm, input.input' }, 20);
      if (!el) throw new Error('name input not found');
      await el.click(); await el.type(name);
    })) return rec;
    if (!await step('continue', () => click({ text: 'متابعة' }, 20, { enabled: true }))) return rec;
    if (!await step('consent', async () => {
      const el = await waitEl(page, { selector: 'input[type=checkbox]' }, 20);
      if (!el) throw new Error('consent checkbox not found');
      const checked = await el.evaluate((e) => e.checked);
      if (!checked) await el.click();
    })) return rec;
    if (!await step('open_camera', () => click({ text: 'افتح الكاميرا' }, 20, { enabled: true }))) return rec;
    await sleep(8000); await shot('scanning');
    if (!await step('scan_done', async () => {
      const el = await waitEl(page, { text: 'التالي: احكيلنا شو بتحس' }, scanTimeoutS, { enabled: true });
      if (!el) throw new Error(`scan did not finish within ${scanTimeoutS} s`);
      const txt = await page.evaluate(() => document.body.innerText.slice(0, 600));
      return { page_text_excerpt: txt.replace(/\s+/g, ' ').slice(0, 400) };
    })) return rec;
    if (!await step('next_voice', () => click({ text: 'التالي: احكيلنا شو بتحس' }, 10, { enabled: true }))) return rec;
    if (!await step('mic_start', () => click({ aria: 'ابدأ التسجيل' }, 20))) return rec;
    await sleep(6000); await shot('recording');
    if (!await step('mic_stop', () => click({ aria: 'وقّف التسجيل' }, 10))) return rec;
    if (!await step('transcript', async () => {
      const el = await waitEl(page, { text: 'أرسل للطبيب' }, 120, { enabled: true });
      if (!el) {
        const err = await page.evaluate(() => document.querySelector('.err')?.innerText ?? null);
        throw new Error(`no transcript / send button not enabled within 120 s${err ? ` (page error: ${err})` : ''}`);
      }
      const t = await page.evaluate(() => document.querySelector('textarea')?.value ?? null);
      return { transcript: t };
    })) return rec;
    if (!await step('send', async () => {
      await click({ text: 'أرسل للطبيب' }, 10, { enabled: true });
      const t0 = Date.now();
      for (;;) { // result screen = the send button is gone and no spinner
        await sleep(1000);
        const still = await findEl(page, { text: 'أرسل للطبيب' });
        const spin = await page.evaluate(() => !!document.querySelector('.spinner'));
        if (!still && !spin) break;
        if ((Date.now() - t0) / 1000 > 150) throw new Error('result screen not reached within 150 s');
      }
      await sleep(1500);
      return { result_text_excerpt: (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 500) };
    })) return rec;
    await step('api_checkin', async () => {
      const r = await fetch(`${base}/api/checkins?limit=10`);
      if (!r.ok) throw new Error(`GET /api/checkins -> ${r.status}`);
      const list = await r.json();
      const c = list.find((x) => x.patient_name_ar === name);
      if (!c) throw new Error(`no check-in for «${name}» in the latest 10`);
      return { checkin_id: c.id, checkin_hr_bpm: c.vitals?.hr_bpm ?? null, checkin_quality: c.vitals?.quality ?? null, triage: c.triage?.level ?? null, transcript_source: c.transcript_source, transcript: c.transcript };
    });
    rec.ok = steps.every((s) => s.ok);
    return rec;
  } catch (e) {
    rec.error = String(e.message || e);
    return rec;
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); break; } catch { await sleep(400); } }
  }
}

const runs = [];
for (const v of vps) { console.log(`\n=== flow: ${v} ===`); runs.push(await runViewport(v)); }
let cleanup = null;
if (!args.keep) {
  const py = fs.existsSync('D:\\python.exe') ? 'D:\\python.exe' : 'python';
  const r = spawnSync(py, [path.join(here, 'cleanup_test_patients.py')], { encoding: 'utf8' });
  cleanup = { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim().slice(0, 500) };
  console.log(`\ncleanup: ${cleanup.stdout || cleanup.stderr}`);
  try {
    const list = await (await fetch(`${base}/api/checkins?limit=50`)).json();
    cleanup.remaining_test_checkins_in_api = list.filter((x) => (x.patient_name_ar || '').startsWith('اختبار آلي')).length;
  } catch { /* ignore */ }
}
const out = { kind: 'full-flow e2e, headless desktop Chrome emulating phone viewports (NOT real iOS Safari / Android); fake camera = SIMULATED 72 bpm face, fake mic = wav file',
  when: new Date().toISOString(), base, video, wav, runs, cleanup };
const jp = path.join(outDir, `flow_${stamp}.json`);
fs.writeFileSync(jp, JSON.stringify(out, null, 2), 'utf8');
console.log(`\nsaved ${jp}`);
for (const r of runs) console.log(`${r.viewport}: ${r.ok ? 'PASS' : `FAIL (${r.error})`}`);
process.exit(runs.every((r) => r.ok) ? 0 : 1);

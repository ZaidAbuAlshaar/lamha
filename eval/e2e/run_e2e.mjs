#!/usr/bin/env node
// run_e2e.mjs - feed a synthetic face video to the app as a FAKE WEBCAM and read back its vitals.
//
//   node run_e2e.mjs --video E:\nazra-e2e\face_72bpm_15rpm.y4m \
//        --url "http://localhost:5173/#/scan-test?seconds=30" --timeout 120
//
// SYNTHETIC BENCH TEST: validates the signal-processing pipeline against a known pulse /
// breathing rate injected into a still portrait. It is NOT clinical accuracy on real people.
//
// App contract: the page auto-starts camera + engine and exposes
//   window.__nazraE2E = { status: 'loading'|'running'|'done'|'error', progress: 0..1,
//                         vitals: { hr_bpm, hr_confidence, rr_bpm, rr_confidence, hrv_rmssd_ms,
//                                   hrv_sdnn_ms, stress_index, quality, fps, scan_seconds }, error }
//
// Options:
//   --video <file.y4m|.mjpeg>   fake camera source (sidecar <same name>.json = ground truth)
//   --url <url>                 page to open (default http://localhost:5199/?seconds=30  = the stub)
//   --timeout <s>               overall wait for status=done (default 120)
//   --mode auto|headless|headed auto = headless first, headed (off-screen) if no frames arrive (default auto)
//   --load-timeout <s>          in auto mode: still 'loading' after this long => retry headed (default 25)
//   --retries <n>               re-run (fresh Chrome) when the app itself reports status=error, max n times (default 2)
//   --hr-tol <bpm> --rr-tol <rpm>   pass/fail tolerances vs nominal truth (default 3 / 3)
//   --chrome <path>             default C:\Program Files\Google\Chrome\Application\chrome.exe
//   --out-dir <dir>             default ./results
// Exit code: 0 done + within tolerance, 1 done but out of tolerance / app error, 2 timeout or launch failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const nxt = argv[i + 1];
    if (nxt === undefined || nxt.startsWith('--')) a[k] = true;
    else { a[k] = nxt; i++; }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
if (!args.video) { console.error('usage: node run_e2e.mjs --video <file.y4m> [--url <url>] [--timeout 120] [--mode auto|headless|headed]'); process.exit(2); }

const videoPath = path.resolve(String(args.video));
const url = String(args.url || 'http://localhost:5199/?seconds=30');
const timeoutS = Number(args.timeout || 120);
const loadTimeoutS = Number(args['load-timeout'] || 25);
const mode = String(args.mode || 'auto');
const hrTol = Number(args['hr-tol'] || 3);
const rrTol = Number(args['rr-tol'] || 3);
const chromePath = String(args.chrome || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const outDir = path.resolve(String(args['out-dir'] || path.join(here, 'results')));
fs.mkdirSync(outDir, { recursive: true });

if (!fs.existsSync(videoPath)) { console.error(`video not found: ${videoPath}`); process.exit(2); }
if (!fs.existsSync(chromePath)) { console.error(`chrome not found: ${chromePath}`); process.exit(2); }
const sidecarPath = videoPath.replace(/\.[^.\\/]+$/, '.json');
const truth = fs.existsSync(sidecarPath) ? JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) : null;
if (!truth) console.warn(`[warn] no ground-truth sidecar at ${sidecarPath}; errors will not be computed`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const name = path.basename(videoPath).replace(/\.[^.]+$/, '');
const resultBase = path.join(outDir, `${name}_${stamp}`);
const profileRoot = fs.existsSync('E:\\nazra-e2e') ? 'E:\\nazra-e2e\\profiles' : path.join(os.tmpdir(), 'nazra-e2e-profiles');
fs.mkdirSync(profileRoot, { recursive: true });

async function attempt(headed) {
  const userDataDir = fs.mkdtempSync(path.join(profileRoot, 'chrome-'));
  const chromeArgs = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${videoPath}`,
    '--autoplay-policy=no-user-gesture-required',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1280,900',
  ];
  if (headed) chromeArgs.push('--window-position=-2000,0');
  const label = headed ? 'headed (off-screen)' : 'headless (new)';
  console.log(`\n=== launching Chrome ${label} ===`);
  const consoleErrors = [];
  let browser;
  const info = { mode: label, userDataDir, trace: [], consoleErrors, consoleInfo: [], state: null, chromeVersion: null, screenshot: null, outcome: 'unknown' };
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: headed ? false : true, // true = "new" headless in current puppeteer
      userDataDir,
      args: chromeArgs,
      defaultViewport: { width: 1280, height: 900 },
      protocolTimeout: 60000,
    });
    info.chromeVersion = await browser.version();
    console.log(`Chrome: ${info.chromeVersion}`);
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') {
        // some libs (TFLite/XNNPACK) log harmless "INFO: ..." notices through console.error
        if (/^INFO:/.test(m.text())) { info.consoleInfo.push(m.text()); return; }
        const t = `[console.error] ${m.text()}`; consoleErrors.push(t); console.log(t);
      }
    });
    page.on('pageerror', (e) => { const t = `[pageerror] ${e.message}`; consoleErrors.push(t); console.log(t); });
    page.on('requestfailed', (r) => {
      const t = `[requestfailed] ${r.url()} ${r.failure()?.errorText}`; consoleErrors.push(t); console.log(t);
    });
    console.log(`open ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      info.outcome = 'goto-failed';
      info.gotoError = String(e.message || e);
      console.log(`[goto failed] ${info.gotoError}`);
      return info;
    }

    const t0 = Date.now();
    let lastPrint = '';
    let state = null;
    for (;;) {
      const elapsed = (Date.now() - t0) / 1000;
      try { state = await page.evaluate(() => (window.__nazraE2E ? JSON.parse(JSON.stringify(window.__nazraE2E)) : null)); }
      catch (e) { state = { status: 'unreachable', error: String(e.message || e) }; }
      const line = state ? `status=${state.status} progress=${(state.progress ?? 0).toFixed(2)}` : 'window.__nazraE2E not present yet';
      if (line !== lastPrint || Math.round(elapsed * 2) % 20 === 0) {
        console.log(`  t=${elapsed.toFixed(1).padStart(5)}s  ${line}`);
        lastPrint = line;
      }
      info.trace.push({ t: +elapsed.toFixed(2), status: state?.status ?? null, progress: state?.progress ?? null });
      if (state?.status === 'done') { info.outcome = 'done'; break; }
      if (state?.status === 'error') { info.outcome = 'app-error'; break; }
      if (elapsed > timeoutS) { info.outcome = 'timeout'; break; }
      if (!headed && mode === 'auto' && elapsed > loadTimeoutS && (!state || state.status === 'loading')) { info.outcome = 'no-frames'; break; }
      await sleep(500);
    }
    info.state = state;
    info.elapsedS = +((Date.now() - t0) / 1000).toFixed(1);
    try {
      info.screenshot = `${resultBase}${headed ? '_headed' : ''}.png`;
      await page.screenshot({ path: info.screenshot });
    } catch (e) { console.log(`[screenshot failed] ${e.message}`); info.screenshot = null; }
    return info;
  } catch (e) {
    info.outcome = 'launch-failed';
    info.launchError = String(e.stack || e);
    console.error(`[launch/run error] ${info.launchError}`);
    return info;
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); break; } catch { await sleep(500); }
    }
  }
}

// attempt loop: headless first; switch to headed (off-screen) only for camera/device problems or no frames;
// retry the same mode on other app errors (up to --retries) and record every attempt in the result.
const retries = Number(args.retries ?? 2);
const attempts = [];
let headed = mode === 'headed';
let retriesUsed = 0;
let info;
for (;;) {
  info = await attempt(headed);
  const err = info.state?.error ?? info.launchError ?? null;
  attempts.push({ mode: info.mode, outcome: info.outcome, error: err });
  if (info.outcome === 'done' || info.outcome === 'timeout' || info.outcome === 'goto-failed') break;
  const deviceProblem = info.outcome === 'no-frames' || info.outcome === 'launch-failed' || /NotFound|NotReadable|NotAllowed|Overconstrained|Permission|Requested device/i.test(err ?? '');
  if (!headed && mode === 'auto' && deviceProblem) { console.log(`
headless attempt ended with '${info.outcome}' (${err ?? 'no frames'}); retrying headed off-screen`); headed = true; continue; }
  if (info.outcome === 'app-error' && retriesUsed < retries) { retriesUsed++; console.log(`
app reported an error (${err}); retry ${retriesUsed}/${retries} in the same mode`); continue; }
  break;
}
info.headlessAttempt = attempts.length > 1 ? attempts.slice(0, -1) : null;

// ---- compare with ground truth ----
const v = info.state?.vitals ?? null;
const cmp = {};
let pass = false;
const isControl = !!(truth && truth.injected && !truth.injected.pulse);
if (info.outcome === 'done' && v && truth && isControl) {
  // CONTROL video: no pulse / breathing injected. No pass criterion vs 72/15 - we just record what the app claims.
  cmp.control = { note: 'no pulse and no breathing injected; a trustworthy engine should report low confidence / poor quality', measured_hr_bpm: v.hr_bpm ?? null, hr_confidence: v.hr_confidence ?? null, hr_snr_db: v.hr_snr_db ?? null, rr_bpm: v.rr_bpm ?? null, rr_confidence: v.rr_confidence ?? null, quality: v.quality ?? null };
  pass = true; // informational
} else if (info.outcome === 'done' && v && truth) {
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const hr = num(v.hr_bpm), rr = num(v.rr_bpm);
  const hrWin = truth.hr_trace_bpm_per_second
    ? (() => { const n = Math.min(truth.hr_trace_bpm_per_second.length, Math.round(v.scan_seconds || timeoutS)); const s = truth.hr_trace_bpm_per_second.slice(0, n); return s.reduce((a, b) => a + b, 0) / s.length; })()
    : null;
  cmp.hr = { truth_nominal_bpm: truth.bpm, truth_realised_mean_bpm: truth.bpm_realised_mean, truth_first_scan_window_mean_bpm_approx: hrWin == null ? null : +hrWin.toFixed(2),
             measured_bpm: hr, abs_error_vs_nominal: hr == null ? null : +Math.abs(hr - truth.bpm).toFixed(2), abs_error_vs_realised_mean: hr == null ? null : +Math.abs(hr - truth.bpm_realised_mean).toFixed(2), tolerance_bpm: hrTol,
             confidence: v.hr_confidence ?? null };
  cmp.rr = { truth_nominal_rpm: truth.rpm, measured_rpm: rr, abs_error: rr == null ? null : +Math.abs(rr - truth.rpm).toFixed(2), tolerance_rpm: rrTol, confidence: v.rr_confidence ?? null };
  cmp.hr.pass = hr != null && Math.abs(hr - truth.bpm) <= hrTol;
  cmp.rr.pass = rr != null && Math.abs(rr - truth.rpm) <= rrTol;
  pass = cmp.hr.pass && cmp.rr.pass;
  // HRV: informational only (the synthetic pulse has slow drift, no beat-to-beat noise; not a pass criterion)
  if (truth.beat_times_s?.length > 3) {
    const win = Number(v.scan_seconds) || timeoutS;
    const bt = truth.beat_times_s.filter((x) => x <= win);
    const ibi = bt.slice(1).map((x, i) => x - bt[i]);
    const d = ibi.slice(1).map((x, i) => x - ibi[i]);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const m = mean(ibi);
    cmp.hrv_info = {
      truth_rmssd_ms: +(Math.sqrt(mean(d.map((x) => x * x))) * 1000).toFixed(2),
      truth_sdnn_ms: +(Math.sqrt(ibi.reduce((a, x) => a + (x - m) ** 2, 0) / (ibi.length - 1)) * 1000).toFixed(2),
      measured_rmssd_ms: v.hrv_rmssd_ms ?? null, measured_sdnn_ms: v.hrv_sdnn_ms ?? null, stress_index: v.stress_index ?? null,
      note: 'informational, NOT validated: truth reflects only the injected slow drift',
    };
  }
}

const result = {
  kind: 'SYNTHETIC bench test - validates the signal-processing pipeline against a known injected pulse/breathing rate; NOT clinical accuracy on real people',
  when: new Date().toISOString(),
  url, video: videoPath, mode: info.mode, chrome: info.chromeVersion,
  outcome: info.outcome, elapsed_s: info.elapsedS ?? null, earlier_failed_attempts: info.headlessAttempt ?? null, attempts_total: attempts.length,
  truth: truth ? { bpm: truth.bpm, bpm_realised_mean: truth.bpm_realised_mean, rpm: truth.rpm, seconds: truth.seconds, fps: truth.fps, seed: truth.seed, amplitudes: truth.pulse?.amplitude_pp_levels_rgb } : null,
  measured: v, app_error: info.state?.error ?? null, comparison: cmp, pass: isControl ? null : pass, control: isControl,
  console_errors: info.consoleErrors, console_info_ignored: info.consoleInfo, screenshot: info.screenshot, progress_trace: info.trace,
};
const jsonPath = `${resultBase}.json`;
fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf8');

console.log('\n=== RESULT (synthetic-video bench test) ===');
console.log(`outcome : ${info.outcome}  (${info.mode}, ${info.chromeVersion ?? 'n/a'})`);
if (info.state?.error) console.log(`app error: ${info.state.error}`);
if (v) console.log('vitals  :', JSON.stringify({ ...v, bvp_preview: Array.isArray(v.bvp_preview) ? `[${v.bvp_preview.length} samples]` : v.bvp_preview }));
if (cmp.control) {
  console.log(`CONTROL (no pulse/breathing injected) -> app reports HR ${cmp.control.measured_hr_bpm} bpm (confidence ${cmp.control.hr_confidence}, snr ${cmp.control.hr_snr_db} dB), RR ${cmp.control.rr_bpm} (confidence ${cmp.control.rr_confidence}), quality ${cmp.control.quality}`);
}
if (cmp.hr) {
  console.log(`HR  truth ${cmp.hr.truth_nominal_bpm} bpm (realised mean ${cmp.hr.truth_realised_mean_bpm})  measured ${cmp.hr.measured_bpm}  |err| ${cmp.hr.abs_error_vs_nominal}  tol ${hrTol}  ${cmp.hr.pass ? 'PASS' : 'FAIL'}`);
  console.log(`RR  truth ${cmp.rr.truth_nominal_rpm} rpm  measured ${cmp.rr.measured_rpm}  |err| ${cmp.rr.abs_error}  tol ${rrTol}  ${cmp.rr.pass ? 'PASS' : 'FAIL'}`);
}
if (cmp.hrv_info) console.log(`HRV (info only, not validated)  truth RMSSD ${cmp.hrv_info.truth_rmssd_ms} ms / SDNN ${cmp.hrv_info.truth_sdnn_ms} ms   measured RMSSD ${cmp.hrv_info.measured_rmssd_ms} / SDNN ${cmp.hrv_info.measured_sdnn_ms}  stress ${cmp.hrv_info.stress_index}`);
console.log(`console errors captured: ${info.consoleErrors.length}`);
console.log(`saved   : ${jsonPath}`);
if (info.screenshot) console.log(`shot    : ${info.screenshot}`);
console.log(`OVERALL : ${isControl ? 'CONTROL (informational)' : pass ? 'PASS' : 'FAIL'}`);
process.exit(info.outcome === 'done' ? (pass ? 0 : 1) : (info.outcome === 'app-error' ? 1 : 2));

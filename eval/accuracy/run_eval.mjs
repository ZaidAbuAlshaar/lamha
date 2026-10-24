#!/usr/bin/env node
// run_eval.mjs - accuracy evaluation of the Nazra browser rPPG engine through Chrome's FAKE CAMERA.
//
//   node run_eval.mjs [--configs baseline,hardened] [--only <substring>] [--url http://127.0.0.1:8787]
//                     [--seconds 30] [--timeout 180] [--no-synthetic] [--no-recordings] [--parallel 1]
//                     [--before results/<earlier>.json]   (adds that run's summary table to report.md)
//
// Inputs
//   * SIMULATED clips: E:\nazra-e2e\*.y4m and E:\nazra-e2e\hard\*.y4m, truth = sidecar <name>.json ("bpm" = injected
//     nominal HR; "control": true = no pulse injected -> scored separately as a rejection test, never in MAE).
//   * Real dev recordings: D:\nazra-recordings\<id>.webm|mp4 + <id>.json {ref_hr_bpm, ref_source, facing, ...}.
//     Converted once to y4m 640x480 30 fps yuv420p into E:\nazra-eval-cache\ (re-converted when the source mtime/size changes).
//     facing "environment" => fingertip clip => mode=finger.
// Configs
//   baseline = /#/scan-test?...&flags=all-off   (original pre-hardening behaviour)
//   hardened = /#/scan-test?...                 (hardened defaults)
// Scoring (per config, separately for Simulated and Real)
//   failure = no result / app error / timeout OR hr_bpm null OR quality 'poor'
//   on non-failed clips: MAE, RMSE, Bland-Altman bias (mean of app - truth) and 95 % limits (bias +- 1.96 SD, SD with n-1)
// Outputs: results/<timestamp>.json (everything raw) and report.md (regenerated from this run).
// Honesty: this script only measures. Simulated clips validate the signal pipeline, not clinical accuracy.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'e2e', 'package.json'));
const puppeteer = require('puppeteer-core');

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
const configs = String(args.configs || 'baseline,hardened').split(',').map((s) => s.trim()).filter(Boolean);
const baseUrl = String(args.url || 'http://127.0.0.1:8787').replace(/\/+$/, '').replace(/\/#.*$/, '');
const seconds = Number(args.seconds || 30);
const timeoutS = Number(args.timeout || 180);
const loadTimeoutS = Number(args['load-timeout'] || 30);
const only = args.only ? String(args.only) : null;
const parallel = Math.max(1, Number(args.parallel || 1));
const synthDir = String(args['synthetic-dir'] || 'E:\\nazra-e2e');
const recDir = String(args.recordings || 'D:\\nazra-recordings');
const cacheDir = String(args.cache || 'E:\\nazra-eval-cache');
const chromePath = String(args.chrome || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const ffmpeg = String(args.ffmpeg || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
const resultsDir = path.join(here, 'results');
const shotsDir = path.join(resultsDir, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });
const profileRoot = fs.existsSync('E:\\') ? 'E:\\nazra-e2e\\profiles' : path.join(os.tmpdir(), 'nazra-eval-profiles');
fs.mkdirSync(profileRoot, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// ---------------- collect clips ----------------
function y4mList(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.y4m') && !f.startsWith('_')).map((f) => path.join(dir, f));
}
const clips = [];
if (!args['no-synthetic']) {
  for (const [group, dir] of [['standard', synthDir], ['hard', path.join(synthDir, 'hard')]]) {
    for (const v of y4mList(dir)) {
      const side = v.replace(/\.y4m$/i, '.json');
      if (!fs.existsSync(side)) { console.warn(`[skip] no sidecar for ${v}`); continue; }
      const t = JSON.parse(fs.readFileSync(side, 'utf8'));
      const control = !!(t.control || (t.injected && !t.injected.pulse));
      clips.push({ id: path.basename(v, '.y4m'), kind: 'simulated', group: control ? 'control' : group, video: v, mode: 'face',
        truth_bpm: control ? null : t.bpm, truth_realised_mean_bpm: control ? null : t.bpm_realised_mean,
        conditions: Object.keys(t.hard_conditions || {}).join('+') || (control ? 'no pulse' : 'clean'), clip_seconds: t.seconds });
    }
  }
}
function convertRecording(src, id) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${id}.y4m`);
  const stampFile = path.join(cacheDir, `${id}.cache.json`);
  const st = fs.statSync(src);
  const key = { src, mtimeMs: st.mtimeMs, size: st.size };
  try {
    const old = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
    if (old.src === key.src && old.mtimeMs === key.mtimeMs && old.size === key.size && fs.existsSync(out)) return out;
  } catch { /* convert */ }
  console.log(`[ffmpeg] ${src} -> ${out}`);
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', src, '-an',
    '-vf', 'scale=640:480:force_original_aspect_ratio=increase,crop=640:480,fps=30,format=yuv420p',
    '-f', 'yuv4mpegpipe', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${src}: ${r.stderr || r.error}`);
  fs.writeFileSync(stampFile, JSON.stringify(key));
  return out;
}
if (!args['no-recordings'] && fs.existsSync(recDir)) {
  for (const f of fs.readdirSync(recDir)) {
    if (!/\.json$/i.test(f)) continue;
    const id = f.replace(/\.json$/i, '');
    const meta = JSON.parse(fs.readFileSync(path.join(recDir, f), 'utf8'));
    const src = ['webm', 'mp4', 'mov'].map((e) => path.join(recDir, `${id}.${e}`)).find((p) => fs.existsSync(p));
    if (!src) { console.warn(`[skip] recording ${id}: no video file`); continue; }
    if (only && !id.includes(only)) continue;
    let video;
    try { video = convertRecording(src, id); } catch (e) { console.warn(`[skip] ${e.message}`); continue; }
    const finger = meta.facing === 'environment';
    clips.push({ id, kind: 'real', group: finger ? 'real-finger' : 'real-face', video, source: src, mode: finger ? 'finger' : 'face',
      truth_bpm: num(meta.ref_hr_bpm), ref_source: meta.ref_source ?? null, device: meta.device ?? null, conditions: finger ? 'fingertip' : 'face', clip_seconds: meta.seconds ?? null });
  }
}
const selected = clips.filter((c) => !only || c.id.includes(only));
if (!selected.length) { console.error('no clips selected'); process.exit(2); }
if (!fs.existsSync(chromePath)) { console.error(`chrome not found: ${chromePath}`); process.exit(2); }

// flags string per config. hardened turns the pre-scan gate OFF by default: the synthetic portrait's face is ~27 % of the
// frame width, so the gate (correctly) blocks with «قرّب وجهك» and waits for a manual tap that automation cannot give.
const HARDENED_FLAGS = String(args['hardened-flags'] || 'default,preScanGate:0');
const CONFIG_FLAGS = { baseline: 'all-off', hardened: HARDENED_FLAGS };
const flagsFor = (cfg) => CONFIG_FLAGS[cfg] ?? cfg; // any other value is passed through as a flags string
function urlFor(cfg, clip) {
  const q = new URLSearchParams({ seconds: String(seconds) });
  q.set('flags', flagsFor(cfg));
  if (clip.mode === 'finger') q.set('mode', 'finger');
  return `${baseUrl}/#/scan-test?${q.toString()}`;
}

// ---------------- one scan ----------------
async function scanOnce(video, url, headed, shot) {
  const userDataDir = fs.mkdtempSync(path.join(profileRoot, 'eval-'));
  const chromeArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`,
    '--autoplay-policy=no-user-gesture-required', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1280,900'];
  if (headed) chromeArgs.push('--window-position=-2000,0');
  const info = { mode: headed ? 'headed-offscreen' : 'headless', outcome: 'unknown', state: null, consoleErrors: [], elapsed_s: null, chrome: null };
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: chromePath, headless: !headed, userDataDir, args: chromeArgs, defaultViewport: { width: 1280, height: 900 }, protocolTimeout: 90000 });
    info.chrome = await browser.version();
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/^INFO:/.test(m.text())) info.consoleErrors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => info.consoleErrors.push(`[pageerror] ${String(e.message).slice(0, 300)}`));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const t0 = Date.now();
    let state = null;
    for (;;) {
      const el = (Date.now() - t0) / 1000;
      try { state = await page.evaluate(() => (window.__nazraE2E ? JSON.parse(JSON.stringify(window.__nazraE2E)) : null)); }
      catch (e) { state = { status: 'unreachable', error: String(e.message || e) }; }
      if (state?.status === 'done') { info.outcome = 'done'; break; }
      if (state?.status === 'error') { info.outcome = 'app-error'; break; }
      if (el > timeoutS) { info.outcome = 'timeout'; break; }
      if (!headed && el > loadTimeoutS && (!state || state.status === 'loading')) { info.outcome = 'no-frames'; break; }
      await sleep(500);
    }
    info.state = state;
    info.elapsed_s = +((Date.now() - t0) / 1000).toFixed(1);
    try { await page.screenshot({ path: shot }); info.screenshot = shot; } catch { /* ignore */ }
  } catch (e) {
    info.outcome = 'launch-failed';
    info.error = String(e.message || e);
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); break; } catch { await sleep(400); } }
  }
  return info;
}

async function scan(clip, cfg) {
  const url = urlFor(cfg, clip);
  const shot = path.join(shotsDir, `${clip.id}__${cfg}_${stamp}.png`);
  const attempts = [];
  let headed = false;
  let info;
  for (let k = 0; k < 4; k++) {
    info = await scanOnce(clip.video, url, headed, shot);
    attempts.push({ mode: info.mode, outcome: info.outcome, error: info.state?.error ?? info.error ?? null });
    if (info.outcome === 'done' || info.outcome === 'timeout') break;
    const err = info.state?.error ?? info.error ?? '';
    if (!headed && (info.outcome === 'no-frames' || info.outcome === 'launch-failed' || /NotFound|NotReadable|NotAllowed|Overconstrained|Permission/i.test(err))) { headed = true; continue; }
    if (info.outcome === 'app-error' && attempts.filter((a) => a.outcome === 'app-error').length <= 1) continue; // one retry
    break;
  }
  const v = info.state?.vitals ?? null;
  const hr = num(v?.hr_bpm);
  const failed = info.outcome !== 'done' || hr == null || v?.quality === 'poor';
  const failure_reason = info.outcome !== 'done' ? info.outcome : hr == null ? 'hr null' : v?.quality === 'poor' ? 'quality poor' : null;
  return {
    clip: clip.id, kind: clip.kind, group: clip.group, conditions: clip.conditions, config: cfg, url, mode: clip.mode,
    truth_bpm: clip.truth_bpm, truth_realised_mean_bpm: clip.truth_realised_mean_bpm ?? null, ref_source: clip.ref_source ?? null,
    outcome: info.outcome, attempts, failed, failure_reason,
    hr_bpm: hr, err_bpm: hr != null && clip.truth_bpm != null ? +(hr - clip.truth_bpm).toFixed(2) : null,
    hr_confidence: num(v?.hr_confidence), hr_snr_db: num(v?.hr_snr_db), rr_bpm: num(v?.rr_bpm), quality: v?.quality ?? null,
    quality_score: num(v?.quality_score), quality_reasons: v?.quality_reasons ?? null, scan_seconds: num(v?.scan_seconds), fps: num(v?.fps),
    face_fraction: num(v?.face_fraction),
    diag_fps_mean: num(v?.diagnostics?.fps_mean), diag_frame_jitter_ms: num(v?.diagnostics?.frame_jitter_ms), diag_proc_ms_median: num(v?.diagnostics?.proc_ms_median),
    diag_extended: v?.diagnostics?.extended ?? null, diag_segment_s: v?.diagnostics?.segment_s ?? null, diag_engine: v?.diagnostics?.engine ?? null,
    diag_flags: v?.diagnostics?.flags ?? null, quality_components: v?.quality_components ?? null, elapsed_s: info.elapsed_s, chrome: info.chrome, app_error: info.state?.error ?? info.error ?? null,
    console_errors: info.consoleErrors.slice(0, 10), screenshot: info.screenshot ?? null,
    vitals: v ? { ...v, bvp_preview: Array.isArray(v.bvp_preview) ? `[${v.bvp_preview.length}]` : v.bvp_preview } : null,
  };
}

// ---------------- stats ----------------
function stats(rows) {
  const scored = rows.filter((r) => r.truth_bpm != null);
  const ok = scored.filter((r) => !r.failed && r.err_bpm != null);
  const e = ok.map((r) => r.hr_bpm - r.truth_bpm);
  const n = scored.length;
  const fails = scored.filter((r) => r.failed).length;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const out = { n, failures: fails, failure_rate: n ? +(fails / n).toFixed(3) : null, n_scored: ok.length, mae: null, rmse: null, bias: null, sd: null, loa_low: null, loa_high: null };
  if (e.length) {
    out.mae = +mean(e.map(Math.abs)).toFixed(2);
    out.rmse = +Math.sqrt(mean(e.map((x) => x * x))).toFixed(2);
    out.bias = +mean(e).toFixed(2);
    if (e.length >= 2) {
      const sd = Math.sqrt(e.reduce((a, x) => a + (x - mean(e)) ** 2, 0) / (e.length - 1));
      out.sd = +sd.toFixed(2);
      out.loa_low = +(mean(e) - 1.96 * sd).toFixed(2);
      out.loa_high = +(mean(e) + 1.96 * sd).toFixed(2);
    }
  }
  return out;
}

// ---------------- run ----------------
const jobs = [];
for (const c of selected) for (const cfg of configs) jobs.push([c, cfg]);
console.log(`${selected.length} clips x ${configs.length} configs = ${jobs.length} scans (parallel ${parallel}); base ${baseUrl}`);
const results = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const [c, cfg] = jobs[next++];
    const t0 = Date.now();
    const r = await scan(c, cfg);
    results.push(r);
    console.log(`[${results.length}/${jobs.length}] ${cfg.padEnd(8)} ${c.id.padEnd(30)} truth ${String(c.truth_bpm ?? '-').padStart(4)}  app ${String(r.hr_bpm ?? 'null').padStart(6)}  q=${r.quality ?? '-'}  ${r.failed ? 'FAIL(' + r.failure_reason + ')' : 'ok'}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
const tStart = Date.now();
await Promise.all(Array.from({ length: parallel }, worker));
const order = new Map(jobs.map(([c, cfg], i) => [`${c.id}|${cfg}`, i]));
results.sort((a, b) => order.get(`${a.clip}|${a.config}`) - order.get(`${b.clip}|${b.config}`));

const summary = {};
for (const cfg of configs) {
  const rows = results.filter((r) => r.config === cfg);
  summary[cfg] = {
    simulated_all: stats(rows.filter((r) => r.kind === 'simulated')),
    simulated_standard: stats(rows.filter((r) => r.group === 'standard')),
    simulated_hard: stats(rows.filter((r) => r.group === 'hard')),
    real_all: stats(rows.filter((r) => r.kind === 'real')),
    real_face: stats(rows.filter((r) => r.group === 'real-face')),
    real_finger: stats(rows.filter((r) => r.group === 'real-finger')),
    controls: rows.filter((r) => r.group === 'control').map((r) => ({ clip: r.clip, rejected: r.failed || (r.hr_confidence ?? 1) === 0, hr_bpm: r.hr_bpm, hr_confidence: r.hr_confidence, quality: r.quality })),
  };
}
const out = {
  kind: 'Nazra rPPG accuracy eval. "simulated" = synthetic video with an injected pulse (validates the signal pipeline, NOT clinical accuracy); "real" = dev recordings vs a reference device.',
  when: new Date().toISOString(), base_url: baseUrl, configs, config_flags: Object.fromEntries(configs.map((c) => [c, flagsFor(c)])), seconds_requested: seconds, timeout_s: timeoutS, parallel,
  hardening_ready_marker_present: fs.existsSync(path.join(here, '..', '..', 'web', '.hardening-ready')),
  wall_time_s: +((Date.now() - tStart) / 1000).toFixed(0), summary, results,
};
const jsonPath = path.join(resultsDir, `${stamp}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8');

// ---------------- report.md ----------------
const f = (x, d = 1) => (x == null ? '–' : typeof x === 'number' ? x.toFixed(d) : String(x));
const L = [];
L.push('# Nazra rPPG accuracy report');
L.push('');
L.push(`Generated by \`run_eval.mjs\` on ${out.when} against \`${baseUrl}\` (requested scan ${seconds} s, headless Chrome ${results.find((r) => r.chrome)?.chrome ?? 'n/a'}, fake camera).`);
L.push(`Configs → URL \`flags=\`: ${configs.map((c) => `**${c}** = \`${flagsFor(c)}\``).join(', ')}.${configs.includes('hardened') && /preScanGate:0/.test(flagsFor('hardened')) ? ' **The pre-scan gate is OFF in the hardened config here**: the face in the synthetic portrait is ~27 % of the frame width, so the gate correctly blocks with «قرّب وجهك» and waits for a manual «ابدأ القياس على كل حال» tap, which automation cannot give. Real users get the gate.' : ''}`);
L.push(`Raw results: \`results/${stamp}.json\`. Hardening marker \`web/.hardening-ready\` present at run time: **${out.hardening_ready_marker_present ? 'yes' : 'no'}**${out.hardening_ready_marker_present ? '' : ' (so the live build was the pre-hardening build and ignores `flags`; every config here measures the baseline)'}.`);
L.push('');
L.push('**Simulated** = synthetic face video (still portrait + injected pulse, `eval/e2e/make_video.py`). It tests the signal pipeline under the simulated condition only; it says nothing about clinical accuracy on people. **Real** = dev recordings scored against an oximeter/smartwatch reading (the reference itself has its own error).');
L.push('');
L.push('Failure = no result, HR null, or quality "poor". MAE / RMSE / Bland–Altman are computed on non-failed clips only (so a config that rejects more clips can look more accurate: read failure rate and error together). Truth for simulated clips = injected nominal bpm (the injected HR also drifts slowly by up to ±2 bpm).');
L.push('');
const groups = [['simulated_all', 'Simulated, all'], ['simulated_standard', 'Simulated, standard'], ['simulated_hard', 'Simulated, hard'], ['real_all', 'Real, all'], ['real_face', 'Real, face'], ['real_finger', 'Real, fingertip']];
L.push(configs.length >= 2 ? `## Summary: before (${configs[0]}) / after (${configs.slice(1).join(', ')}), same build, same clips` : '## Summary');
L.push('');
L.push('| set | config | n | failures | failure rate | MAE bpm | RMSE bpm | bias bpm | 95% LoA bpm |');
L.push('|---|---|---|---|---|---|---|---|---|');
for (const [g, label] of groups) {
  for (const cfg of configs) {
    const s = summary[cfg][g];
    if (!s.n) continue;
    L.push(`| ${label} | ${cfg} | ${s.n} | ${s.failures} | ${f(s.failure_rate * 100, 0)}% | ${f(s.mae, 2)} | ${f(s.rmse, 2)} | ${f(s.bias, 2)} | ${s.loa_low == null ? '–' : `${f(s.loa_low, 2)} … ${f(s.loa_high, 2)}`} |`);
  }
}
if (args.before && fs.existsSync(String(args.before))) {
  const prev = JSON.parse(fs.readFileSync(String(args.before), 'utf8'));
  L.push('');
  L.push(`### Reference run: \`results/${path.basename(String(args.before))}\` (${prev.when}, hardening marker present then: ${prev.hardening_ready_marker_present ? 'yes' : 'no'})`);
  L.push('');
  L.push('| set | config | n | failures | failure rate | MAE bpm | RMSE bpm | bias bpm | 95% LoA bpm |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const [g, label] of groups) {
    for (const cfg of prev.configs) {
      const s = prev.summary?.[cfg]?.[g];
      if (!s || !s.n) continue;
      L.push(`| ${label} | ${cfg}${prev.hardening_ready_marker_present ? '' : ' (pre-hardening build)'} | ${s.n} | ${s.failures} | ${f(s.failure_rate * 100, 0)}% | ${f(s.mae, 2)} | ${f(s.rmse, 2)} | ${f(s.bias, 2)} | ${s.loa_low == null ? '–' : `${f(s.loa_low, 2)} … ${f(s.loa_high, 2)}`} |`);
    }
  }
}
const ctrl = configs.flatMap((cfg) => summary[cfg].controls.map((c) => ({ ...c, cfg })));
if (ctrl.length) {
  L.push('');
  L.push('Controls (no pulse injected; a trustworthy engine should reject them): ' + ctrl.map((c) => `${c.cfg}: ${c.clip} → HR ${f(c.hr_bpm)} conf ${f(c.hr_confidence, 2)} quality ${c.quality ?? '–'} → **${c.rejected ? 'rejected' : 'NOT rejected'}**`).join('; ') + '.');
}
L.push('');
L.push('## Per clip');
L.push('');
const sgn = (e) => (e == null ? '–' : (e > 0 ? '+' : '') + e.toFixed(1));
if (configs.length >= 2) {
  const [c0, c1] = configs;
  L.push(`Paired view (${c0} → ${c1}):`);
  L.push('');
  L.push(`| clip | conditions | truth | ${c0} bpm | err | quality | ${c1} bpm | err | quality | q-score |`);
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of selected) {
    const a = results.find((r) => r.clip === c.id && r.config === c0);
    const b = results.find((r) => r.clip === c.id && r.config === c1);
    if (!a || !b) continue;
    L.push(`| ${c.id} | ${c.conditions} | ${f(c.truth_bpm, 0)} | ${f(a.hr_bpm)} | ${sgn(a.err_bpm)} | ${a.failed ? `**${a.quality ?? a.failure_reason}**` : a.quality} | ${f(b.hr_bpm)} | ${sgn(b.err_bpm)} | ${b.failed ? `**${b.quality ?? b.failure_reason}**` : b.quality} | ${f(b.quality_score, 2)} |`);
  }
  L.push('');
  L.push('All fields:');
  L.push('');
}
L.push('| clip | kind | conditions | config | truth bpm | app bpm | error | conf | SNR dB | quality | q-score | reasons | scan s | extended | diag fps_mean | jitter ms | proc ms (median) | app fps field | result |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  L.push(`| ${r.clip} | ${r.kind === 'simulated' ? 'Simulated' : 'Real'} | ${r.conditions} | ${r.config} | ${f(r.truth_bpm, 0)} | ${f(r.hr_bpm)} | ${sgn(r.err_bpm)} | ${f(r.hr_confidence, 2)} | ${f(r.hr_snr_db)} | ${r.quality ?? '–'} | ${f(r.quality_score, 2)} | ${Array.isArray(r.quality_reasons) && r.quality_reasons.length ? r.quality_reasons.join(', ') : '–'} | ${f(r.scan_seconds, 1)} | ${r.diag_extended == null ? '–' : r.diag_extended ? 'yes' : 'no'} | ${f(r.diag_fps_mean)} | ${f(r.diag_frame_jitter_ms)} | ${f(r.diag_proc_ms_median)} | ${f(r.fps, 0)} | ${r.failed ? `FAIL (${r.failure_reason})` : 'ok'} |`);
}
L.push('');
L.push('## Re-run');
L.push('');
L.push('```');
L.push('cd nazra/eval/accuracy');
L.push('python make_hard_set.py                      # hard Simulated set -> E:\\nazra-e2e\\hard (once)');
L.push('python ../e2e/check_video.py E:\\nazra-e2e\\hard\\*.y4m   # oracle self-check of the clips');
L.push(`node run_eval.mjs --configs ${configs.join(',')}${only ? ` --only ${only}` : ''}`);
L.push('```');
L.push('');
fs.writeFileSync(path.join(here, 'report.md'), L.join('\n'), 'utf8');
console.log(`\nsaved ${jsonPath}\nreport ${path.join(here, 'report.md')}`);
for (const cfg of configs) {
  const s = summary[cfg].simulated_all;
  console.log(`${cfg}: simulated n=${s.n} fail=${s.failures} MAE=${s.mae} RMSE=${s.rmse} bias=${s.bias} LoA=${s.loa_low}..${s.loa_high}`);
}

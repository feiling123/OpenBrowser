#!/usr/bin/env node
'use strict';

/**
 * Wayfern native-fingerprint bridge selftest.
 *
 * Part A (always runs): unit-checks buildWayfernFingerprintParams — the mapping
 *   from an OpenBrowser fingerprint to Wayfern.setFingerprint FLAT params, and
 *   the OS-neutral subset used for the cross-OS fallback.
 *
 * Part B (opt-in, needs a real kernel binary): launches Wayfern, sets a same-OS
 *   fingerprint via the Wayfern.* CDP domain, and asserts the values stick.
 *     node automation/wayfern-fingerprint-selftest.js /path/to/wayfern[/chrome]
 *   or  WAYFERN_BINARY=/path/... node automation/wayfern-fingerprint-selftest.js
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  buildWayfernFingerprintParams,
  applyWayfernFingerprint,
  fingerprintOsType,
  canvasNoiseSeedFromFp,
  hostOsType,
} = require('./wayfern-fingerprint');
const { buildFingerprint } = require('./fingerprint');

function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
}

function unitTests() {
  // Windows fingerprint with an explicit UA + NVIDIA WebGL.
  const fp = buildFingerprint({
    id: 'wf-unit-1',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    language: 'ja-JP',
    privacy: { fingerprint: { cores: 12, memory: 16 } },
    exitTimezone: 'Asia/Tokyo',
  });
  // Force a deterministic WebGL meta so the assertion is stable.
  fp.webgl = { ...fp.webgl, mode: 'noise', metaMode: 'noise', vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' };

  const { params, osNeutralKeys, osType } = buildWayfernFingerprintParams(fp, {});

  assert.strictEqual(osType, 'windows', 'osType from Windows UA');
  assert.strictEqual(params.userAgent, fp.userAgent, 'userAgent mapped');
  assert.strictEqual(params.platform, fp.platform, 'platform mapped');
  assert.strictEqual(params.webglVendor, 'Google Inc. (NVIDIA)', 'webglVendor mapped');
  assert.ok(/RTX 3060/.test(params.webglRenderer), 'webglRenderer mapped');
  assert.strictEqual(params.hardwareConcurrency, 12, 'cores mapped');
  assert.strictEqual(params.deviceMemory, 16, 'memory mapped');
  assert.ok(Array.isArray(params.languages) && params.languages[0] === 'ja-JP', 'languages mapped');
  assert.strictEqual(params.language, 'ja-JP', 'primary language mapped');
  assert.strictEqual(params.timezone, 'Asia/Tokyo', 'timezone mapped');
  assert.ok(!('fingerprint' in params), 'params are FLAT (not nested)');

  // OS-neutral subset must drop OS-tied identity but keep hardware/locale.
  assert.ok(!osNeutralKeys.has('userAgent'), 'subset drops userAgent');
  assert.ok(!osNeutralKeys.has('platform'), 'subset drops platform');
  assert.ok(!osNeutralKeys.has('webglVendor'), 'subset drops webglVendor');
  assert.ok(!osNeutralKeys.has('webglRenderer'), 'subset drops webglRenderer');
  assert.ok(osNeutralKeys.has('hardwareConcurrency'), 'subset keeps cores');
  assert.ok(osNeutralKeys.has('timezone'), 'subset keeps timezone');
  assert.ok(osNeutralKeys.has('languages'), 'subset keeps languages');

  // Blocked / real WebGL meta must not emit vendor/renderer.
  const fpReal = buildFingerprint({ id: 'wf-unit-2', privacy: { webglMeta: 'real' } });
  const { params: p2 } = buildWayfernFingerprintParams(fpReal, {});
  assert.ok(!('webglVendor' in p2), 'real webgl meta: no vendor override');

  // Canvas noise seed is deterministic and 32 hex chars.
  const seedA = canvasNoiseSeedFromFp(fp);
  const seedB = canvasNoiseSeedFromFp(fp);
  assert.strictEqual(seedA, seedB, 'canvas seed deterministic');
  assert.ok(/^[0-9A-F]{32}$/.test(seedA), 'canvas seed is 32 hex');

  // Token plumbing (env + profile).
  const { params: pTok } = buildWayfernFingerprintParams(fp, { advanced: { wayfernToken: 'tok-123' } });
  assert.strictEqual(pTok.wayfernToken, 'tok-123', 'wayfernToken from profile.advanced');

  console.log('wayfern-fingerprint-selftest: unit OK (fingerprintOsType, flat params, subset, seed, token)');
}

async function waitForDevToolsPort(root, child) {
  const portFile = path.join(root, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (fs.existsSync(portFile)) {
      const lines = String(await fsp.readFile(portFile, 'utf8')).split(/\r?\n/);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0) return { port, wsPath: lines[1] || '' };
    }
    if (child.exitCode !== null) break;
    await sleep(400);
  }
  return null;
}

function rpc(url, method, params = {}, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let done = false;
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === 1) { done = true; ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    };
    ws.onerror = () => { if (!done) reject(new Error('ws error')); };
    setTimeout(() => { if (!done) { try { ws.close(); } catch (_) {} reject(new Error('timeout ' + method)); } }, timeout);
  });
}

async function liveTest(binary) {
  assert.ok(typeof WebSocket === 'function', 'live test needs a WebSocket-capable Node runtime');
  // Accept terms once (Wayfern refuses to run otherwise).
  await new Promise((resolve) => {
    const c = spawn(binary, ['--accept-terms-and-conditions', '--no-sandbox'], { stdio: 'ignore' });
    c.on('exit', () => resolve());
    c.on('error', () => resolve());
    setTimeout(() => { try { c.kill(); } catch (_) {} resolve(); }, 20000);
  });

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openbrowser-wayfern-fp-'));
  let child;
  try {
    child = spawn(binary, [
      '--headless=new', '--no-sandbox', '--no-zygote', '--disable-gpu', '--disable-dev-shm-usage',
      `--user-data-dir=${root}`, '--remote-debugging-port=0', 'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.resume();
    child.stderr?.resume();
    const info = await waitForDevToolsPort(root, child);
    assert.ok(info && info.port, `Wayfern did not become CDP-ready, exitCode=${child.exitCode}`);
    const browserWs = `ws://127.0.0.1:${info.port}${info.wsPath.startsWith('/') ? info.wsPath : '/' + info.wsPath}`;

    const { targetInfos } = await rpc(browserWs, 'Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    assert.ok(page, 'no page target');
    const pageWs = `ws://127.0.0.1:${info.port}/devtools/page/${page.targetId}`;

    // Read host default, then apply a SAME-OS override (no cross-OS token needed).
    const before = (await rpc(pageWs, 'Wayfern.getFingerprint')).fingerprint;
    const hostOs = hostOsType();
    const uaByOs = {
      windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      macos: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    };
    const fp = buildFingerprint({ id: 'wf-live', userAgent: uaByOs[hostOs] || before.userAgent, language: 'ja-JP', privacy: { fingerprint: { cores: 12, memory: 16 } }, exitTimezone: 'Asia/Tokyo' });
    fp.webgl = { ...fp.webgl, mode: 'noise', metaMode: 'noise', vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER/PCIe/SSE2, OpenGL 4.6)' };
    fp.hardwareConcurrency = 12; fp.deviceMemory = 16;

    // Exercise the exact engine entry point (applyWayfernFingerprint) via a
    // cdp.call-shaped adapter: (wsUrl, method, params, timeout) -> result.
    const cdpCall = (wsUrl, method, params) => rpc(wsUrl, method, params);
    const applyResult = await applyWayfernFingerprint(cdpCall, pageWs, fp, {});
    assert.strictEqual(applyResult.ok, true, 'applyWayfernFingerprint ok');
    assert.strictEqual(applyResult.applied, 'full', 'same-OS applies full identity');
    const after = (await rpc(pageWs, 'Wayfern.getFingerprint')).fingerprint;

    assert.strictEqual(after.hardwareConcurrency, 12, 'live cores applied');
    assert.strictEqual(after.deviceMemory, 16, 'live memory applied');
    assert.strictEqual(after.timezone, 'Asia/Tokyo', 'live timezone applied');
    assert.strictEqual(after.webglVendor, 'Google Inc. (NVIDIA)', 'live webglVendor applied');
    assert.ok(/1660 SUPER/.test(after.webglRenderer), 'live webglRenderer applied');
    assert.notStrictEqual(after.webglRenderer, before.webglRenderer, 'renderer changed from host default');

    // New target inherits the fingerprint (per-BrowserContext).
    const { targetId } = await rpc(browserWs, 'Target.createTarget', { url: 'about:blank' });
    const newWs = `ws://127.0.0.1:${info.port}/devtools/page/${targetId}`;
    const inherited = (await rpc(newWs, 'Wayfern.getFingerprint')).fingerprint;
    assert.strictEqual(inherited.hardwareConcurrency, 12, 'new target inherits cores');
    assert.strictEqual(inherited.webglVendor, 'Google Inc. (NVIDIA)', 'new target inherits webglVendor');

    console.log('wayfern-fingerprint-selftest: live OK (setFingerprint sticks + inherited by new targets)');
  } finally {
    if (child && child.exitCode === null) child.kill();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  unitTests();
  const arg = process.argv[2] || process.env.WAYFERN_BINARY || '';
  if (arg) {
    const binary = path.resolve(arg);
    assert.ok(fs.existsSync(binary), 'Wayfern binary not found: ' + binary);
    await liveTest(binary);
  } else {
    console.log('wayfern-fingerprint-selftest: live test skipped (pass a Wayfern binary path to run it)');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

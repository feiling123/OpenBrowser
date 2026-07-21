#!/usr/bin/env node
'use strict';

/**
 * fingerprint-chromium native-flag driver selftest.
 *
 * Part A (always): unit-checks the OpenBrowser fingerprint -> --fingerprint-*
 *   flag mapping and the identity-flag skip list.
 *
 * Part B (opt-in, needs a real binary): launches fingerprint-chromium with the
 *   generated flags and asserts the result is a CONSISTENT, natively-spoofed
 *   Windows identity — native getters (no JS wrappers), webdriver false, UA and
 *   platform agree, timezone honoured.
 *     node automation/fingerprint-chromium-selftest.js /path/to/fingerprint-chromium/chrome
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  isFingerprintChromium,
  chromeArgsForFingerprintChromium,
  platformFlagFromFp,
  fingerprintSeed,
  isIdentityFlagToSkip,
} = require('./fingerprint-chromium');
const { buildFingerprint } = require('./fingerprint');

function flagValue(args, name) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function unitTests() {
  const fp = buildFingerprint({
    id: 'fpc-unit-1',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    language: 'ja-JP',
    privacy: { fingerprint: { cores: 8, memory: 16 } },
    exitTimezone: 'America/New_York',
  });
  fp.hardwareConcurrency = 8;

  const args = chromeArgsForFingerprintChromium(fp, { exitTimezone: 'America/New_York' });

  assert.strictEqual(platformFlagFromFp(fp), 'windows', 'windows UA -> windows platform flag');
  assert.ok(flagValue(args, 'fingerprint'), '--fingerprint seed present');
  assert.ok(/^\d+$/.test(flagValue(args, 'fingerprint')), 'seed is a decimal uint');
  assert.strictEqual(flagValue(args, 'fingerprint-platform'), 'windows', 'platform mapped');
  assert.strictEqual(flagValue(args, 'fingerprint-hardware-concurrency'), '8', 'cores mapped');
  assert.strictEqual(flagValue(args, 'lang'), 'ja-JP', 'lang mapped');
  assert.strictEqual(flagValue(args, 'timezone'), 'America/New_York', 'timezone mapped');
  assert.ok(args.some((a) => a.startsWith('--fingerprint-platform-version=')), 'platform-version present');
  // We deliberately do NOT force a brand version (would desync UA vs headers).
  assert.ok(!args.some((a) => a.startsWith('--fingerprint-brand-version=')), 'no forced brand-version');

  // Seed is deterministic per profile.
  assert.strictEqual(fingerprintSeed(fp, {}), fingerprintSeed(fp, {}), 'seed deterministic');

  // Identity flags OpenBrowser must not pass to this kernel.
  for (const f of ['--user-agent=x', '--lang=en', '--window-size=1,2', '--disable-webgl', '--force-webrtc-ip-handling-policy=x']) {
    assert.ok(isIdentityFlagToSkip(f), 'skip ' + f);
  }
  for (const f of ['--disable-blink-features=AutomationControlled', '--mute-audio', '--do-not-track']) {
    assert.ok(!isIdentityFlagToSkip(f), 'keep ' + f);
  }

  // macOS UA -> macos; linux UA -> linux.
  const macFp = buildFingerprint({ id: 'm', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36' });
  assert.strictEqual(platformFlagFromFp(macFp), 'macos', 'mac UA -> macos');

  assert.strictEqual(isFingerprintChromium({ fingerprintChromium: true }), true, 'meta flag detected');
  assert.strictEqual(isFingerprintChromium({ path: '/x/chrome-for-testing/chrome' }), false, 'CfT not detected');

  console.log('fingerprint-chromium-selftest: unit OK (flag mapping, skip list, seed, platform)');
}

async function waitForPort(root, child) {
  const file = path.join(root, 'DevToolsActivePort');
  for (let i = 0; i < 80; i += 1) {
    try {
      const port = Number(String(await fsp.readFile(file, 'utf8')).split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch (_) {}
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return 0;
}

function rpc(url, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); let done = false;
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) { done = true; ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
    ws.onerror = () => { if (!done) reject(new Error('ws error')); };
    setTimeout(() => { if (!done) { try { ws.close(); } catch (_) {} reject(new Error('timeout')); } }, 6000);
  });
}

async function liveTest(binary) {
  const hostOsWin = process.platform === 'win32';
  // Cross-OS target: whatever the host is NOT (proves free cross-OS spoofing).
  const targetUa = hostOsWin
    ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
  const wantPlat = hostOsWin ? 'Linux' : 'Win32';

  const fp = buildFingerprint({ id: 'fpc-live', userAgent: targetUa, language: 'en-US', privacy: { fingerprint: { cores: 8, memory: 16 } }, exitTimezone: 'America/New_York' });
  fp.hardwareConcurrency = 8;
  const nativeArgs = chromeArgsForFingerprintChromium(fp, { exitTimezone: 'America/New_York' });

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openbrowser-fpc-live-'));
  let child;
  try {
    const args = ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${root}`, '--remote-debugging-port=0', '--no-first-run', ...nativeArgs, 'about:blank'];
    if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
    child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    const port = await waitForPort(root, child);
    assert.ok(port, 'fingerprint-chromium did not become CDP-ready');

    // find a page ws
    const http = require('http');
    const getJson = (u) => new Promise((res, rej) => { http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); });
    let ws = '';
    for (let i = 0; i < 20 && !ws; i += 1) {
      const list = await getJson(`http://127.0.0.1:${port}/json`).catch(() => null);
      const page = Array.isArray(list) ? list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : null;
      ws = page ? page.webSocketDebuggerUrl : '';
      if (!ws) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(ws, 'no page target');

    const expr = `JSON.stringify({plat:navigator.platform,wd:String(navigator.webdriver),cores:navigator.hardwareConcurrency,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,ua:navigator.userAgent,platGetter:(''+Object.getOwnPropertyDescriptor(Navigator.prototype,'platform').get)})`;
    const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const v = JSON.parse(r.result.value);

    assert.strictEqual(v.plat, wantPlat, `cross-OS platform spoofed to ${wantPlat} (got ${v.plat})`);
    assert.strictEqual(v.wd, 'false', 'webdriver is false');
    assert.strictEqual(v.cores, 8, 'hardwareConcurrency spoofed');
    assert.strictEqual(v.tz, 'America/New_York', 'timezone spoofed');
    assert.ok(v.ua.includes(wantPlat === 'Win32' ? 'Windows' : 'Linux'), 'UA matches target OS');
    assert.ok(/\[native code\]/.test(v.platGetter), 'platform getter is NATIVE (no JS wrapper) — passes navigator spoof detection');

    console.log('fingerprint-chromium-selftest: live OK (native cross-OS spoof, native getters, webdriver=false, tz consistent)');
  } finally {
    if (child && child.exitCode === null) child.kill();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  unitTests();
  const arg = process.argv[2] || process.env.FINGERPRINT_CHROMIUM_BINARY || '';
  if (arg) {
    const binary = path.resolve(arg);
    assert.ok(fs.existsSync(binary), 'binary not found: ' + binary);
    await liveTest(binary);
  } else {
    console.log('fingerprint-chromium-selftest: live test skipped (pass a fingerprint-chromium binary path to run it)');
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

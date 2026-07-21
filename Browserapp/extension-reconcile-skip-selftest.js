#!/usr/bin/env node
'use strict';

/**
 * Reconcile must SOFT-SKIP (keep the browser alive) when a kernel lacks the
 * Extensions.* CDP domain — extensions still load via --load-extension.
 *
 * Regression: Chrome for Testing phrases the missing method as
 *   'Extensions.getExtensions' wasn't found
 * which the old regex (only "was not found" / "not found") did not match, so
 * profiles:start threw and the environment crashed on launch.
 */

const assert = require('assert');
const { reconcileOnConnection, isMissingCdpMethod } = require('./extension-pipe');

async function main() {
  // 1) The matcher covers every Chromium phrasing, including CfT's.
  const missing = [
    "'Extensions.getExtensions' wasn't found",           // Chrome for Testing
    "'Extensions.getExtensions' was not found",          // some builds
    'Extensions.getExtensions not found',
    "'Extensions' domain is not available",
    'unknown method',
    'unsupported method',
  ];
  for (const m of missing) assert.ok(isMissingCdpMethod(m), 'should be treated as missing: ' + m);
  for (const m of ['network error', 'timeout', 'permission denied', 'something found nothing']) {
    assert.ok(!isMissingCdpMethod(m), 'should NOT be treated as missing: ' + m);
  }

  // 2) reconcileOnConnection soft-skips on the CfT phrasing instead of throwing.
  const cftConn = {
    command: async (method) => {
      if (method === 'Extensions.getExtensions') {
        throw new Error("'Extensions.getExtensions' wasn't found");
      }
      throw new Error('unexpected method ' + method);
    },
  };
  const desired = [{ id: 'ext1', path: '/tmp/ext1' }];
  const result = await reconcileOnConnection(cftConn, desired, []);
  assert.strictEqual(result.skipped, true, 'reconcile must skip, not throw, on missing Extensions domain');
  assert.deepStrictEqual(result.extensions, [], 'no CDP-installed extensions when domain absent');
  assert.strictEqual(result.installed.length, 1, 'desired extensions still reported (load via --load-extension)');

  // 3) A genuinely unexpected error still propagates (not swallowed).
  const brokenConn = { command: async () => { throw new Error('websocket closed'); } };
  await assert.rejects(() => reconcileOnConnection(brokenConn, desired, []), /websocket closed/, 'non-missing errors must still throw');

  console.log('extension-reconcile-skip-selftest: ok (CfT "wasn\'t found" soft-skips; real errors still throw)');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

'use strict';

/**
 * Start-path exit-cache checks.
 *
 * A proxied start blocked on a proxy geo lookup (a ~12s multi-service race with
 * retries) purely to resolve language/timezone/geo, which is why launching a
 * proxied profile took 10s+ while a direct profile was instant. The cache-first
 * path reuses a recent exit for the same proxy and refreshes in the background,
 * so the blocking lookup only runs on a cold cache or a changed proxy.
 *
 *   node automation/exit-cache-start-selftest.js
 */

const assert = require('assert');
const { BrowserEngine } = require('../engine');

function pass(name) { console.log('  PASS  ' + name); }

/**
 * A BrowserEngine with the blocking proxy lookup replaced by a counter, so a
 * test can tell whether start would have waited on the network.
 */
function makeEngine() {
  const engine = Object.create(BrowserEngine.prototype);
  engine.networkInfo = new Map();
  engine.profiles = new Map();
  engine.running = new Set();
  engine._blockingCalls = 0;
  engine._bgCalls = 0;
  engine.checkProxy = async function () {
    this._blockingCalls += 1;
    return {
      ip: '203.0.113.9',
      countryCode: 'US',
      timezone: 'America/New_York',
      latitude: 40.7,
      longitude: -74,
      checkedAt: new Date().toISOString(),
    };
  };
  engine.emit = function () {};
  return engine;
}

function proxiedProfile(extra = {}) {
  return {
    id: 'env-1',
    networkMode: 'proxy',
    proxy: 'socks5://user:pass@198.51.100.7:1080',
    privacy: { languageMode: 'ip', timezoneMode: 'ip' },
    ...extra,
  };
}

function isoAgo(ms) { return new Date(Date.now() - ms).toISOString(); }

async function main() {
  console.log('Exit cache start selftest\n');
  const TTL = BrowserEngine.EXIT_CACHE_TTL_MS;

  // --- fresh cache for the same proxy: no blocking lookup -------------------
  {
    const engine = makeEngine();
    const profile = proxiedProfile({
      exitCountryCode: 'US',
      exitTimezone: 'America/New_York',
      exitIp: '203.0.113.9',
      exitCheckedAt: isoAgo(60 * 1000),
    });
    profile.exitProxyKey = engine.proxyIdentityKey(profile);
    const net = await engine.ensureExitNetworkForLocale(profile);
    assert.strictEqual(engine._blockingCalls, 0, 'fresh cache still hit the blocking lookup');
    assert.strictEqual(net.countryCode, 'US');
    assert.strictEqual(net.cached, true, 'result was not served from cache');
    pass('fresh same-proxy cache launches without the blocking lookup');
  }

  // --- and it refreshes in the background -----------------------------------
  {
    const engine = makeEngine();
    const profile = proxiedProfile({
      exitCountryCode: 'US',
      exitTimezone: 'America/New_York',
      exitCheckedAt: isoAgo(60 * 1000),
    });
    profile.exitProxyKey = engine.proxyIdentityKey(profile);
    engine.profiles.set(profile.id, profile);
    await engine.ensureExitNetworkForLocale(profile);
    // Background refresh is fire-and-forget; let its microtasks settle.
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(engine._blockingCalls, 1, 'background refresh did not run exactly once');
    pass('cached start still refreshes the exit in the background');
  }

  // --- stale cache: must re-detect ------------------------------------------
  {
    const engine = makeEngine();
    const profile = proxiedProfile({
      exitCountryCode: 'US',
      exitTimezone: 'America/New_York',
      exitCheckedAt: isoAgo(TTL + 60 * 1000),
    });
    profile.exitProxyKey = engine.proxyIdentityKey(profile);
    await engine.ensureExitNetworkForLocale(profile);
    assert.strictEqual(engine._blockingCalls, 1, 'stale cache did not trigger a blocking re-detect');
    pass('a stale cache falls back to the blocking lookup');
  }

  // --- changed proxy: cache must not be trusted -----------------------------
  {
    const engine = makeEngine();
    const profile = proxiedProfile({
      exitCountryCode: 'US',
      exitTimezone: 'America/New_York',
      exitCheckedAt: isoAgo(60 * 1000),
      exitProxyKey: 'deadbeef'.repeat(4), // key of some other proxy
    });
    await engine.ensureExitNetworkForLocale(profile);
    assert.strictEqual(engine._blockingCalls, 1, 'a changed proxy reused a stale exit');
    pass('a changed proxy ignores the cache and re-detects');
  }

  // --- cold cache: must detect ----------------------------------------------
  {
    const engine = makeEngine();
    const profile = proxiedProfile(); // no exit* fields at all
    await engine.ensureExitNetworkForLocale(profile);
    assert.strictEqual(engine._blockingCalls, 1, 'cold start skipped detection');
    // First detection must stamp the proxy key so the next start can cache.
    assert.strictEqual(profile.exitProxyKey, engine.proxyIdentityKey(profile),
      'first detection did not stamp the proxy identity');
    assert.ok(profile.exitCheckedAt, 'first detection did not stamp a timestamp');
    pass('a cold cache detects and stamps proxy key + timestamp for next time');
  }

  // --- profiles that do not need exit info are untouched ---------------------
  {
    const engine = makeEngine();
    const profile = {
      id: 'env-fixed',
      networkMode: 'proxy',
      proxy: 'socks5://198.51.100.7:1080',
      privacy: { languageMode: 'profile', timezoneMode: 'fixed', geoMode: 'off' },
    };
    const net = await engine.ensureExitNetworkForLocale(profile);
    assert.strictEqual(net, null, 'a fixed-locale profile still probed the exit');
    assert.strictEqual(engine._blockingCalls, 0);
    pass('a profile with fixed locale never probes the exit');
  }

  // --- proxy identity: different credentials, different key -----------------
  {
    const engine = makeEngine();
    const a = engine.proxyIdentityKey({ proxy: 'socks5://u1:p1@198.51.100.7:1080' });
    const b = engine.proxyIdentityKey({ proxy: 'socks5://u2:p2@198.51.100.7:1080' });
    const c = engine.proxyIdentityKey({ proxy: 'socks5://u1:p1@198.51.100.7:1080' });
    assert.notStrictEqual(a, b, 'different proxies share an identity key');
    assert.strictEqual(a, c, 'same proxy produced different keys');
    assert.strictEqual(engine.proxyIdentityKey({ proxy: 'Direct' }), 'direct');
    pass('proxy identity key is stable per proxy and separates distinct ones');
  }

  console.log('\nAll exit cache start selftests passed.');
}

main().catch((error) => {
  console.error('\nFAIL', error);
  process.exit(1);
});

'use strict';

/**
 * Launch-argument checks for DNS leak containment on proxied profiles.
 *
 * The observed leak was Secure DNS (DoH): Chromium opens its own HTTPS
 * connection to the DoH provider, which ignores --proxy-server, so Cloudflare
 * 1.1.1.1 answered from a Hong Kong anycast PoP while traffic exited through a
 * US proxy. Disabling DoH removes that side channel.
 *
 * Destination names are resolved through the proxy (SOCKS5 carries the hostname
 * as ATYP 0x03; an HTTP/HTTPS proxy receives CONNECT host:port), so no host
 * resolver deny rule is needed — and adding one (--host-resolver-rules=MAP *
 * ~NOTFOUND) broke SOCKS5 browsing entirely, so this test guards against it
 * coming back.
 *
 *   node automation/dns-leak-containment-selftest.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function pass(name) { console.log('  PASS  ' + name); }

function main() {
  console.log('DNS leak containment selftest\n');

  const engine = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');

  // Narrow to the proxy branch so matches below are about launch flags, not the
  // explanatory comment (which necessarily names the removed rule).
  const marker = 'DNS leak containment';
  const at = engine.indexOf(marker);
  assert.ok(at > 0, 'DNS containment block not found in engine.js');
  const region = engine.slice(at, at + 1600);

  // --- DoH must be disabled (the actual leak) -------------------------------
  assert.ok(
    /disabledFeatures\.push\(\s*'DnsOverHttps'\s*\)/.test(engine),
    'engine.js no longer disables DoH — the Cloudflare DNS leak would return'
  );
  pass('Secure DNS (DoH) is disabled for proxied profiles');

  // --- speculative prefetch closed ------------------------------------------
  assert.ok(engine.includes("args.push('--dns-prefetch-disable')"),
    'DNS prefetch is no longer disabled');
  pass('DNS prefetch is disabled so no name resolves ahead of connecting');

  // --- the MAP deny rule must NOT be present (it broke SOCKS5) ---------------
  // Only the launch-flag construction is forbidden; the comment may mention it.
  assert.ok(!/args\.push\(`?--host-resolver-rules=/.test(engine),
    'engine.js pushes --host-resolver-rules again; MAP * ~NOTFOUND breaks SOCKS5 browsing');
  assert.ok(!region.includes("'MAP * ~NOTFOUND'"),
    'the MAP deny rule was reintroduced into the proxy branch');
  pass('no host-resolver deny rule is applied (would break SOCKS5)');

  // --- AsyncDns must not be force-disabled ----------------------------------
  // Disabling the async resolver alongside a SOCKS5 proxy contributed to the
  // breakage and does not itself prevent a leak.
  assert.ok(!region.includes('AsyncDns'),
    'AsyncDns is force-disabled again; it is unnecessary and was part of the regression');
  pass('the async resolver is left enabled');

  console.log('\nAll DNS leak containment selftests passed.');
}

try {
  main();
} catch (error) {
  console.error('\nFAIL', error.message || error);
  process.exit(1);
}

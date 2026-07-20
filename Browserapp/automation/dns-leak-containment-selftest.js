'use strict';

/**
 * Launch-argument checks for DNS leak containment.
 *
 * A proxied profile must not resolve names outside the tunnel. Two paths do
 * that unless closed: Chromium's Secure DNS (DoH), which opens its own HTTPS
 * connection and ignores --proxy-server, and the plain host resolver used for
 * prefetch and direct fallback.
 *
 * The rules must not lock the profile out of its own proxy: loopback (start
 * page / local API) and the proxy's own hostname still need real resolution.
 *
 *   node automation/dns-leak-containment-selftest.js
 */

const assert = require('assert');
const net = require('net');

function pass(name) { console.log('  PASS  ' + name); }

/**
 * Mirror of the argument construction in engine.js. Kept in step by the
 * "matches engine.js" assertion at the bottom, which reads the real source.
 */
function buildDnsArgs(proxy, proxyMeta = {}) {
  const args = [];
  const disabledFeatures = [];
  disabledFeatures.push('DnsOverHttps', 'AsyncDns');
  args.push('--dns-prefetch-disable');
  const resolverExcludes = ['localhost', '127.0.0.1'];
  try {
    const proxyHost = new URL(proxy).hostname;
    if (proxyHost && !net.isIP(proxyHost) && !resolverExcludes.includes(proxyHost)) {
      resolverExcludes.push(proxyHost);
    }
  } catch (_) { /* no host */ }
  if (proxyMeta.directBypass && proxyMeta.bypassList) {
    for (const entry of String(proxyMeta.bypassList).split(/[\s,;]+/)) {
      const host = entry.trim().replace(/^\*\./, '');
      if (host && !resolverExcludes.includes(host)) resolverExcludes.push(host);
    }
  }
  const rule = ['MAP * ~NOTFOUND', ...resolverExcludes.map((h) => `EXCLUDE ${h}`)].join(' , ');
  args.push(`--host-resolver-rules=${rule}`);
  return { args, disabledFeatures, rule };
}

function main() {
  console.log('DNS leak containment selftest\n');

  // --- DoH must be off ------------------------------------------------------
  // This is the actual leak: Cloudflare's DoH resolver answers from its nearest
  // anycast PoP, so a US exit reports HK resolvers while traffic exits correctly.
  const socks = buildDnsArgs('socks5://198.51.100.7:1080');
  assert.ok(socks.disabledFeatures.includes('DnsOverHttps'), 'DoH left enabled');
  assert.ok(socks.disabledFeatures.includes('AsyncDns'), 'async resolver left enabled');
  assert.ok(socks.args.includes('--dns-prefetch-disable'), 'prefetch left enabled');
  pass('DoH, async resolver and prefetch are all disabled');

  // --- all direct resolution denied ----------------------------------------
  assert.ok(socks.rule.startsWith('MAP * ~NOTFOUND'), 'direct resolution not denied');
  pass('direct name resolution is denied by default');

  // --- loopback must survive ------------------------------------------------
  // The start page and local API live on 127.0.0.1; losing them breaks startup.
  assert.ok(socks.rule.includes('EXCLUDE localhost'), 'localhost not excluded');
  assert.ok(socks.rule.includes('EXCLUDE 127.0.0.1'), 'loopback IP not excluded');
  pass('loopback stays resolvable for the start page and local API');

  // --- a proxy given by hostname must stay resolvable -----------------------
  // Chromium resolves the proxy's own hostname locally; denying it would make
  // the profile unable to reach its proxy at all.
  const named = buildDnsArgs('socks5://proxy.example.com:1080');
  assert.ok(named.rule.includes('EXCLUDE proxy.example.com'), 'proxy hostname not excluded');
  pass('a proxy addressed by hostname is excluded from the deny rule');

  // --- an IP-literal proxy needs no exclusion -------------------------------
  assert.ok(!socks.rule.includes('EXCLUDE 198.51.100.7'), 'IP-literal proxy needlessly excluded');
  pass('an IP-literal proxy adds no redundant exclusion');

  // --- the local forwarder bridge ------------------------------------------
  // Authenticated proxies run through http://127.0.0.1:<port>, already covered
  // by the loopback exclusion.
  const bridged = buildDnsArgs('http://127.0.0.1:53121');
  assert.ok(bridged.rule.includes('EXCLUDE 127.0.0.1'), 'bridge loopback not excluded');
  pass('the authenticated-proxy bridge stays reachable');

  // --- user bypass hosts keep real DNS -------------------------------------
  // Hosts the user routes around the proxy must resolve, or they break instead
  // of going direct.
  const withBypass = buildDnsArgs('socks5://198.51.100.7:1080', {
    directBypass: true,
    bypassList: 'intranet.corp; *.internal.example',
  });
  assert.ok(withBypass.rule.includes('EXCLUDE intranet.corp'), 'bypass host not excluded');
  assert.ok(withBypass.rule.includes('EXCLUDE internal.example'), 'wildcard bypass host not excluded');
  pass('user bypass hosts keep working DNS');

  // --- rule syntax ----------------------------------------------------------
  // Chromium parses comma-separated rules; a malformed value is ignored wholesale,
  // which would silently restore the leak.
  const parts = socks.rule.split(' , ');
  assert.ok(parts.length >= 3, 'rule did not split into discrete clauses');
  assert.strictEqual(parts[0], 'MAP * ~NOTFOUND');
  assert.ok(parts.slice(1).every((p) => /^EXCLUDE \S+$/.test(p)), 'malformed EXCLUDE clause');
  pass('resolver rule is syntactically well formed');

  // --- the mirror above must match the real implementation ------------------
  const fs = require('fs');
  const path = require('path');
  const engine = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  assert.ok(engine.includes("disabledFeatures.push('DnsOverHttps', 'AsyncDns')"),
    'engine.js no longer disables DoH — this test would pass while the leak is open');
  assert.ok(engine.includes("['MAP * ~NOTFOUND', ...resolverExcludes.map((h) => `EXCLUDE ${h}`)].join(' , ')"),
    'engine.js resolver rule construction changed; update this selftest');
  assert.ok(engine.includes("const net = require('net')"), 'engine.js lost the net import used by isIP');
  pass('engine.js still builds the arguments this test asserts on');

  console.log('\nAll DNS leak containment selftests passed.');
}

try {
  main();
} catch (error) {
  console.error('\nFAIL', error.message || error);
  process.exit(1);
}

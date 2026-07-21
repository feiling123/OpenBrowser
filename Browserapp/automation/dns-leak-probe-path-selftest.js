#!/usr/bin/env node
'use strict';

/**
 * DNS-leak probe routing selftest.
 *
 * The reported false positive: on a proxied profile, browserleaks (run inside
 * the tunneled browser) shows NO leak, yet the 127.0.0.1 start page flags a DNS
 * leak. Root cause — the start-page server ran the probe subdomain lookups on
 * the HOST resolver (dns.lookup), so bash.ws observed the host ISP resolver
 * (host country) instead of the exit resolver, and mismatched it against the
 * exit country.
 *
 * Fix — a proxied profile resolves the probe subdomains THROUGH the tunnel, so
 * the EXIT resolver is what queries them (as the browser does). This test proves
 * the routing with a mock upstream proxy: the exit sees the probe hostnames.
 *
 *   node automation/dns-leak-probe-path-selftest.js
 */

const assert = require('assert');
const net = require('net');
const { resolveDnsLeakProbes } = require('./start-page-server');

/** Minimal upstream HTTP CONNECT proxy that records the hostnames it is asked to reach. */
function startMockConnectProxy() {
  const seen = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      socket.off('data', onData);
      const head = buf.subarray(0, idx).toString('latin1');
      const m = head.match(/^CONNECT\s+([^\s:]+):(\d+)/i);
      if (m) {
        seen.push(m[1]);
        // Pretend the exit resolved + connected, then close (probe only needs the lookup).
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      } else {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      }
      socket.end();
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

async function main() {
  console.log('DNS-leak probe routing selftest\n');

  const mock = await startMockConnectProxy();
  try {
    const testId = 'unittestid123';
    const count = 6;

    // Proxied path: every unique probe host must reach the EXIT (mock) proxy.
    const viaProxy = await resolveDnsLeakProbes(testId, count, `http://127.0.0.1:${mock.port}`);
    assert.strictEqual(viaProxy.via, 'proxy', 'proxied profile uses the tunnel path');
    assert.strictEqual(viaProxy.hosts.length, count, 'all probe hosts generated');
    for (let i = 0; i < count; i += 1) {
      const host = `${i}.${testId}.bash.ws`;
      assert.ok(mock.seen.includes(host), `exit resolver saw probe host ${host}`);
    }
    // Host resolver must NOT have been the one to observe them: the mock did.
    assert.strictEqual(mock.seen.length, count, 'exit saw exactly the probe hosts');
    console.log('  PASS  proxied profile resolves probes through the exit tunnel');

    mock.server.close();

    // Unparseable proxy: fall back to host resolver rather than skip probing.
    // (A dead UPSTREAM behind a live bridge intentionally stays on the tunnel
    // path — falling back to the host resolver there would reintroduce the leak
    // false-positive, and a truly dead proxy means the browser can't resolve
    // either, which surfaces as "no resolvers observed", not a leak.)
    const viaFallback = await resolveDnsLeakProbes(testId, count, 'not-a-valid-proxy');
    assert.strictEqual(viaFallback.via, 'host', 'unparseable proxy falls back to host resolver');
    console.log('  PASS  unparseable proxy falls back to host resolver');

    // Direct profile: host resolver path (host == browser resolver, comparison valid).
    const direct = await resolveDnsLeakProbes(testId, count, '');
    assert.strictEqual(direct.via, 'host', 'direct profile uses host resolver');
    console.log('  PASS  direct profile uses host resolver');

    console.log('\nDNS-leak probe routing selftest: OK');
  } finally {
    try { mock.server.close(); } catch (_) {}
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

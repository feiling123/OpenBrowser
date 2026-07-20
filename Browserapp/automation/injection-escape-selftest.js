'use strict';

/**
 * Guard against regex escapes being eaten by template literals.
 *
 * Injected browser scripts are built as template literals. Inside an untagged
 * template, a backslash before a non-escape character is silently dropped:
 *
 *     `/\s+/`   ->  /s+/      matches the letter s
 *     `/\d/`    ->  /d/       matches the letter d
 *     `/\/\//`  ->  ///       regex closes early -> SyntaxError
 *
 * A SyntaxError anywhere in an injected script means the *entire* script never
 * runs, so a single mangled escape can silently disable a whole feature with no
 * error surfaced anywhere. Tagged templates (String.raw`...`) are immune and are
 * skipped here.
 *
 *   node automation/injection-escape-selftest.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const {
  buildFingerprint,
  buildInjectionScript,
  buildWorkerInjectionScript,
} = require('./fingerprint');

function pass(name) { console.log('  PASS  ' + name); }

/**
 * Escapes that break a regex when a template literal processes them.
 * \n \t \r \f \v \0 \x \u are deliberately excluded: they are ordinary string
 * escapes that appear intentionally in template literals all over the codebase.
 * \b is included — backspace is virtually never intended, word-boundary is.
 */
const REGEX_ESCAPES = new Set('sdwSDWbB./*+?()[]{}|^$-'.split(''));

/**
 * Walk source, tracking comments, strings and template literals (including
 * ${} nesting), and report single backslashes inside untagged templates.
 */
function findMangledEscapes(src) {
  const hits = [];
  const stack = [];
  let i = 0;
  let line = 1;
  const top = () => (stack.length ? stack[stack.length - 1] : null);
  const inTemplate = () => top() && top().kind === 'tpl';

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '\n') { line += 1; i += 1; continue; }

    if (!inTemplate()) {
      if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line += 1; i += 1; }
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i += 1;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') i += 1;
          if (src[i] === '\n') line += 1;
          i += 1;
        }
        i += 1;
        continue;
      }
    }

    if (ch === '`') {
      if (inTemplate()) {
        stack.pop();
      } else {
        // A tagged template (String.raw`...`) keeps backslashes verbatim.
        const before = src.slice(Math.max(0, i - 40), i);
        stack.push({ kind: 'tpl', raw: /(?:^|[^\w.])String\.raw\s*$/.test(before) });
      }
      i += 1;
      continue;
    }
    if (inTemplate() && ch === '$' && next === '{') { stack.push({ kind: 'expr' }); i += 2; continue; }
    if (top() && top().kind === 'expr' && ch === '}') { stack.pop(); i += 1; continue; }

    if (inTemplate() && ch === '\\') {
      if (next === '\\' || next === '`' || next === '$') { i += 2; continue; }
      if (!top().raw && REGEX_ESCAPES.has(next)) {
        const start = src.lastIndexOf('\n', i) + 1;
        let end = src.indexOf('\n', i);
        if (end < 0) end = src.length;
        hits.push({ line, seq: '\\' + next, text: src.slice(start, end).trim().slice(0, 120) });
      }
      i += 2;
      continue;
    }
    i += 1;
  }
  return hits;
}

function trackedJsFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '*.js'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => path.join(root, f));
  } catch (_) {
    return [];
  }
}

function main() {
  console.log('Injection escape selftest\n');

  // --- the detector itself must work ---------------------------------------
  const bad = findMangledEscapes('const a = `x.replace(/\\s+/g, " ")`;');
  assert.strictEqual(bad.length, 1, 'detector missed a mangled escape');
  assert.strictEqual(bad[0].seq, '\\s');
  const raw = findMangledEscapes('const a = String.raw`x.replace(/\\s+/g, " ")`;');
  assert.strictEqual(raw.length, 0, 'detector flagged a String.raw template');
  const plain = findMangledEscapes('const a = "x".replace(/\\s+/g, " ");');
  assert.strictEqual(plain.length, 0, 'detector flagged a regex outside a template');
  const newline = findMangledEscapes('const a = `line\\nline`;');
  assert.strictEqual(newline.length, 0, 'detector flagged an intentional \\n');
  const escaped = findMangledEscapes('const a = `re = /\\\\s+/`;');
  assert.strictEqual(escaped.length, 0, 'detector flagged a correctly doubled escape');
  pass('detector distinguishes mangled escapes from legitimate ones');

  // --- the whole tree must be clean ----------------------------------------
  const root = path.join(__dirname, '..', '..');
  const files = trackedJsFiles(root);
  assert.ok(files.length > 20, 'could not enumerate tracked .js files');

  const offenders = [];
  for (const file of files) {
    let src = '';
    try { src = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    if (src.indexOf('`') < 0) continue;
    const hits = findMangledEscapes(src);
    if (hits.length) offenders.push({ file: path.relative(root, file), hits });
  }

  if (offenders.length) {
    console.error('\n  Mangled regex escapes inside template literals:\n');
    for (const entry of offenders) {
      for (const hit of entry.hits) {
        console.error('    ' + entry.file + ':' + hit.line + '  [' + hit.seq + ']  ' + hit.text);
      }
    }
    console.error('\n  Fix: double the backslash (\\\\s) or make the template String.raw.\n');
    throw new assert.AssertionError({ message: offenders.length + ' file(s) contain mangled regex escapes' });
  }
  pass('no tracked file mangles a regex escape inside a template literal');

  // --- generated injection scripts must parse ------------------------------
  const profiles = [
    { id: 'esc-win', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36' },
    { id: 'esc-mac', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36' },
    { id: 'esc-rtc', privacy: { fingerprint: { webrtc: 'proxy', webrtcAddress: '203.0.113.7' } } },
    { id: 'esc-blocked', privacy: { fingerprint: { canvas: 'blocked', webgl: 'blocked', fonts: 'blocked' } } },
  ];
  for (const profile of profiles) {
    const fp = buildFingerprint(profile);
    new vm.Script(buildInjectionScript(fp));
    new vm.Script(buildWorkerInjectionScript(fp));
  }
  pass('injection scripts parse for every fingerprint variant');

  // --- specific regexes that were broken in v1.0.1 -------------------------
  const fp = buildFingerprint({ id: 'esc-regex', privacy: { fingerprint: { webrtc: 'proxy', webrtcAddress: '203.0.113.7' } } });
  const script = buildInjectionScript(fp);
  assert.ok(script.includes('/^https?:\\/\\//'), 'normalizeHost protocol regex is mangled');
  assert.ok(script.includes('/:\\d+$/'), 'normalizeHost port regex is mangled');
  assert.ok(script.includes('\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b'), 'WebRTC host-candidate IP regex is mangled');
  pass('previously broken regexes survive script generation intact');

  // --- live-sync injected expressions --------------------------------------
  const liveSync = fs.readFileSync(path.join(__dirname, '..', 'live-sync-v4.js'), 'utf8');
  assert.ok(liveSync.includes('path.split(/\\\\s*>>>\\\\s*/)'),
    'live-sync shadow-DOM selector split must double its escapes');
  assert.ok(liveSync.includes("String(item.innerText||item.textContent||'').trim().replace(/\\\\s+/g,' ')"),
    'live-sync candidate text normalisation must double its escapes');
  // The String.raw injection block must NOT be doubled — it is already verbatim.
  const { injection } = require('../live-sync-v4');
  assert.ok(injection.includes("replace(/\\s+/g,' ')"),
    'String.raw injection lost its verbatim escape');
  assert.ok(!injection.includes("replace(/\\\\s+/g,' ')"),
    'String.raw injection was wrongly double-escaped');
  pass('live-sync escapes are correct in both raw and untagged templates');

  console.log('\nAll injection escape selftests passed.');
}

try {
  main();
} catch (error) {
  console.error('\nFAIL', error.message || error);
  process.exit(1);
}

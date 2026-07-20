'use strict';

/**
 * Functional tests for the font fingerprint surface.
 * Runs the real injection script inside a mock DOM — no desktop host required.
 *
 *   node automation/font-fingerprint-selftest.js
 */

const assert = require('assert');
const vm = require('vm');

const {
  buildFingerprint,
  buildInjectionScript,
  buildWorkerInjectionScript,
} = require('./fingerprint');
const {
  createFontProfileFromSeed,
  fontMetricMarkFromSeed,
  normalizeFontName,
  isGenericFamily,
  FONT_POOLS,
} = require('./fonts');

function pass(name) { console.log('  PASS  ' + name); }

/**
 * Minimal DOM good enough for the font block: the setters it patches plus the
 * canvas/FontFaceSet surfaces a detector would reach for.
 */
function makeSandbox() {
  const styleStore = new WeakMap();

  class CSSStyleDeclaration {
    constructor() { styleStore.set(this, {}); }
    setProperty(name, value) { styleStore.get(this)[String(name).toLowerCase()] = value; }
    getPropertyValue(name) { return styleStore.get(this)[String(name).toLowerCase()] || ''; }
  }
  Object.defineProperty(CSSStyleDeclaration.prototype, 'fontFamily', {
    configurable: true, enumerable: true,
    get() { return styleStore.get(this)['font-family'] || ''; },
    set(value) { styleStore.get(this)['font-family'] = value; },
  });
  Object.defineProperty(CSSStyleDeclaration.prototype, 'font', {
    configurable: true, enumerable: true,
    get() { return styleStore.get(this).font || ''; },
    set(value) { styleStore.get(this).font = value; },
  });
  Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
    configurable: true, enumerable: true,
    get() { return styleStore.get(this)._cssText || ''; },
    set(value) { styleStore.get(this)._cssText = value; },
  });

  class Element {
    constructor() { this.style = new CSSStyleDeclaration(); this.attributes = {}; }
    setAttribute(name, value) { this.attributes[String(name)] = value; }
    getAttribute(name) { return this.attributes[String(name)]; }
  }

  class TextMetrics {}

  class CanvasRenderingContext2D {
    constructor() { this._font = '10px sans-serif'; }
    // Width model: a real engine measures the resolved face. Here every family
    // gets a distinct stable width so "did it fall back?" is observable.
    measureText(text) {
      const family = String(this._font).split(',')[0].split(' ').slice(1).join(' ') || 'sans-serif';
      let h = 0;
      for (let i = 0; i < family.length; i += 1) h = (h * 31 + family.charCodeAt(i)) >>> 0;
      const m = new TextMetrics();
      m.width = String(text).length * (8 + (h % 5));
      m.actualBoundingBoxAscent = 7 + (h % 3);
      m.actualBoundingBoxDescent = 2;
      return m;
    }
  }
  Object.defineProperty(CanvasRenderingContext2D.prototype, 'font', {
    configurable: true, enumerable: true,
    get() { return this._font; },
    set(value) { this._font = value; },
  });

  class FontFaceSet {
    // Stand-in for the engine's real lookup: only these are "installed".
    constructor(installed) { this._installed = new Set(installed.map((f) => f.toLowerCase())); }
    check(font) {
      const family = String(font).split(',')[0].split(' ').slice(1).join(' ')
        .replace(/^["']|["']$/g, '').toLowerCase();
      return this._installed.has(family);
    }
  }

  class FontFace {
    constructor(family) { this.family = family; }
  }

  const sandbox = {
    Element, CSSStyleDeclaration, CanvasRenderingContext2D, TextMetrics,
    FontFaceSet, FontFace,
    Range: undefined,
    DOMRect: undefined,
    document: { styleSheets: [], fonts: null, documentElement: new Element() },
    location: { hostname: 'example.com' },
    navigator: { userAgent: '', languages: ['en-US'], plugins: [], mimeTypes: [] },
    screen: {},
    Promise,
    Date,
    Math,
    JSON,
    Map,
    Set,
    WeakMap,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    console,
    parseInt,
    parseFloat,
    Symbol,
    Reflect,
    Proxy,
    Function,
    setTimeout,
    TypeError,
    RangeError,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return sandbox;
}

function runInjection(fp, installedForEngine) {
  const sandbox = makeSandbox();
  sandbox.document.fonts = new sandbox.FontFaceSet(installedForEngine || fp.fonts.installed);
  vm.createContext(sandbox);
  // The UA prelude touches surfaces the mock omits; failures there are unrelated
  // to fonts and already covered by the isolation selftest.
  try {
    new vm.Script(buildInjectionScript(fp)).runInContext(sandbox);
  } catch (error) {
    throw new Error('injection script threw: ' + error.message);
  }
  return sandbox;
}

function main() {
  console.log('Font fingerprint selftest\n');

  // --- pool hygiene -------------------------------------------------------
  for (const [os, pool] of Object.entries(FONT_POOLS)) {
    const all = [...pool.base, ...pool.optional].map(normalizeFontName);
    assert.strictEqual(new Set(all).size, all.length, os + ' pool has duplicates');
    assert.ok(!all.some((f) => isGenericFamily(f)), os + ' pool leaks a generic family');
    assert.ok(pool.base.length >= 25, os + ' base pool too small');
    assert.ok(pool.optional.length >= 25, os + ' optional pool too small');
  }
  pass('font pools are duplicate-free and contain no generic families');

  // --- determinism --------------------------------------------------------
  const a1 = createFontProfileFromSeed('profile-a', 'windows');
  const a2 = createFontProfileFromSeed('profile-a', 'windows');
  const b1 = createFontProfileFromSeed('profile-b', 'windows');
  assert.deepStrictEqual(a1.installed, a2.installed);
  assert.strictEqual(a1.metricMark, a2.metricMark);
  pass('same seed reproduces an identical font set');

  assert.notDeepStrictEqual(a1.installed, b1.installed);
  pass('different seeds produce different font sets');

  // Neighbouring seeds must not collapse to near-identical sets.
  const overlap = a1.installed.filter((f) => b1.installed.includes(f)).length;
  const union = new Set([...a1.installed, ...b1.installed]).size;
  assert.ok(overlap / union < 0.95, 'seeded sets are too similar (ratio ' + (overlap / union).toFixed(3) + ')');
  pass('seeded sets diverge beyond the shared base fonts');

  // --- OS consistency -----------------------------------------------------
  const winFp = buildFingerprint({ id: 'win-1', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36' });
  const macFp = buildFingerprint({ id: 'mac-1', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36' });
  assert.strictEqual(winFp.fonts.os, 'windows');
  assert.strictEqual(macFp.fonts.os, 'macos');
  assert.ok(winFp.fonts.installed.includes('Segoe UI'), 'windows profile missing Segoe UI');
  assert.ok(macFp.fonts.installed.includes('Helvetica Neue'), 'macos profile missing Helvetica Neue');
  assert.ok(!winFp.fonts.installed.includes('Helvetica Neue'), 'windows profile leaks a macOS font');
  assert.ok(!macFp.fonts.installed.includes('Segoe UI'), 'macos profile leaks a Windows font');
  pass('font set follows the UA-derived OS');

  // --- generated script is syntactically valid ----------------------------
  // Regex escapes inside the injection template literal are easy to mangle;
  // a SyntaxError anywhere silently disables the whole fingerprint layer.
  for (const fp of [winFp, macFp]) {
    new vm.Script(buildInjectionScript(fp));
    new vm.Script(buildWorkerInjectionScript(fp));
  }
  pass('injection scripts parse as valid JavaScript');

  // --- masking behaviour --------------------------------------------------
  const fp = buildFingerprint({ id: 'mask-1', privacy: { fingerprint: { fonts: 'mask' } } });
  assert.strictEqual(fp.fonts.mode, 'mask');
  // Pick a real font this seed happens to exclude rather than hardcoding one —
  // which font lands outside the set is seed-dependent by design.
  const installedKeys = new Set(fp.fonts.installed.map(normalizeFontName));
  const masked = FONT_POOLS[fp.fonts.os].optional.find((f) => !installedKeys.has(normalizeFontName(f)));
  const kept = fp.fonts.installed[0];
  assert.ok(masked, 'seed excluded nothing from the optional pool');

  // Engine "has" everything; only our mask should hide the absent ones.
  const sandbox = runInjection(fp, [...fp.fonts.installed, masked]);

  const el = new sandbox.Element();
  el.style.fontFamily = '"' + masked + '", monospace';
  assert.strictEqual(el.style.fontFamily, 'monospace', 'masked family survived the fontFamily setter');
  pass('masked family is stripped from style.fontFamily');

  el.style.fontFamily = '"' + kept + '", monospace';
  assert.ok(el.style.fontFamily.indexOf(kept) >= 0, 'allowed family was wrongly stripped');
  pass('allowed family passes through style.fontFamily');

  const el2 = new sandbox.Element();
  el2.style.setProperty('font-family', '"' + masked + '", serif');
  assert.strictEqual(el2.style.getPropertyValue('font-family'), 'serif');
  pass('masked family is stripped from setProperty');

  const el3 = new sandbox.Element();
  el3.setAttribute('style', 'font-family: "' + masked + '", sans-serif; color: red');
  assert.ok(el3.getAttribute('style').indexOf(masked) < 0, 'masked family survived setAttribute');
  assert.ok(el3.getAttribute('style').indexOf('color: red') >= 0, 'setAttribute dropped unrelated declarations');
  pass('masked family is stripped from setAttribute("style")');

  const elCss = new sandbox.Element();
  elCss.style.cssText = 'font-family: "' + masked + '", sans-serif; color: red';
  assert.ok(elCss.style.cssText.indexOf(masked) < 0, 'masked family survived cssText');
  assert.ok(elCss.style.cssText.indexOf('color: red') >= 0, 'cssText dropped unrelated declarations');
  pass('masked family is stripped from style.cssText');

  // A family with no surviving fallback must resolve to nothing, not stay intact.
  const el4 = new sandbox.Element();
  el4.style.fontFamily = '"' + masked + '"';
  assert.ok(el4.style.fontFamily.indexOf(masked) < 0, 'sole masked family survived');
  assert.ok(el4.style.fontFamily.length > 0, 'font-family became empty instead of falling back');
  pass('sole masked family becomes an unresolvable sentinel');

  // --- canvas enumeration path --------------------------------------------
  const ctx = new sandbox.CanvasRenderingContext2D();
  ctx.font = '12px "' + masked + '", monospace';
  const maskedWidth = ctx.measureText('mmmmmmmmmmlli').width;
  ctx.font = '12px monospace';
  const baselineWidth = ctx.measureText('mmmmmmmmmmlli').width;
  assert.strictEqual(maskedWidth, baselineWidth, 'canvas measureText still distinguishes a masked font');
  pass('canvas measureText cannot distinguish a masked font from the baseline');

  ctx.font = '12px "' + kept + '", monospace';
  const keptWidth = ctx.measureText('mmmmmmmmmmlli').width;
  assert.notStrictEqual(keptWidth, baselineWidth, 'allowed font was wrongly folded into the baseline');
  pass('canvas measureText still resolves an allowed font');

  // --- metric noise --------------------------------------------------------
  const m1 = ctx.measureText('abc');
  const m2 = ctx.measureText('abc');
  assert.strictEqual(m1.width, m2.width, 'metric noise is not stable within a profile');
  assert.ok(m1 instanceof sandbox.TextMetrics, 'measureText no longer returns a TextMetrics');
  pass('text metrics are stable within a profile and keep their type');

  const otherFp = buildFingerprint({ id: 'mask-2', privacy: { fingerprint: { fonts: 'mask' } } });
  assert.notStrictEqual(fp.fonts.metricMark, otherFp.fonts.metricMark);
  pass('metric mark differs between profiles');

  // --- FontFaceSet.check ---------------------------------------------------
  assert.strictEqual(sandbox.document.fonts.check('12px "' + masked + '"'), false);
  assert.strictEqual(sandbox.document.fonts.check('12px "' + kept + '"'), true);
  pass('document.fonts.check reports the masked set');

  // --- Local Font Access ---------------------------------------------------
  return sandbox.queryLocalFonts().then((list) => {
    assert.ok(Array.isArray(list) && list.length > 0, 'queryLocalFonts returned nothing');
    // The array is built inside the VM realm, so copy into a host array before
    // comparing — deepStrictEqual compares prototypes and would fail otherwise.
    const names = [];
    for (let i = 0; i < list.length; i += 1) names.push(String(list[i].family));
    assert.ok(!names.includes(masked), 'queryLocalFonts leaked a masked font');
    assert.deepStrictEqual(names.slice().sort(), fp.fonts.installed.slice().sort());
    assert.ok(list.every((f) => f.postscriptName && f.fullName && f.style), 'FontData shape incomplete');
    pass('queryLocalFonts returns exactly the masked set');

    // --- web fonts must never be masked ------------------------------------
    const webSandbox = runInjection(fp, fp.fonts.installed);
    new webSandbox.FontFace('BrandCustomFont');
    const webEl = new webSandbox.Element();
    webEl.style.fontFamily = '"BrandCustomFont", sans-serif';
    assert.ok(webEl.style.fontFamily.indexOf('BrandCustomFont') >= 0,
      'a @font-face family was masked, which would break ordinary sites');
    pass('families registered via FontFace() are never masked');

    // --- blocked mode --------------------------------------------------------
    const blockedFp = buildFingerprint({ id: 'blocked-1', privacy: { fingerprint: { fonts: 'blocked' } } });
    const blockedBox = runInjection(blockedFp, blockedFp.fonts.installed);
    const bEl = new blockedBox.Element();
    bEl.style.fontFamily = '"Arial", sans-serif';
    assert.strictEqual(bEl.style.fontFamily, 'sans-serif', 'blocked mode kept a non-generic family');
    return blockedBox.queryLocalFonts().then((empty) => {
      assert.strictEqual(empty.length, 0, 'blocked mode still enumerated fonts');
      pass('blocked mode exposes generic families only');

      // --- real mode is a genuine no-op --------------------------------------
      const realFp = buildFingerprint({ id: 'real-1', privacy: { fingerprint: { fonts: 'real' } } });
      const realBox = runInjection(realFp, realFp.fonts.installed);
      const rEl = new realBox.Element();
      rEl.style.fontFamily = '"Totally Absent Face", monospace';
      assert.ok(rEl.style.fontFamily.indexOf('Totally Absent Face') >= 0,
        'real mode still filtered a family');
      pass('real mode leaves font resolution untouched');

      console.log('\nAll font fingerprint selftests passed.');
    });
  });
}

Promise.resolve().then(main).catch((error) => {
  console.error('\nFAIL', error);
  process.exit(1);
});

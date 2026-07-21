'use strict';

/**
 * fingerprint-chromium (adryfish/fingerprint-chromium) native-flag driver.
 *
 * Why this exists
 * ---------------
 * fingerprint-chromium is the free, open-source upstream of Wayfern: a patched
 * Chromium that spoofs the fingerprint at the C++ level via command-line flags,
 * and — crucially — leaves NATIVE getters in place (navigator.platform reads
 * `function get platform() { [native code] }`, webdriver is a real false, the UA
 * and Client Hints agree on the real build version). It also does cross-OS for
 * free (no wayfernToken).
 *
 * OpenBrowser's default CDP + document-start JS injection is the WRONG tool for
 * it: redefining navigator.* / WebGL getParameter in JS leaves detthe wrapper
 * `toString()` visible (e.g. getBattery => "function (...args){try{return
 * Reflect.ap…"), and forcing a UA version different from the real binary makes
 * the UA disagree with Client Hints. browserscan/adspower flag all of that as
 * "Navigator 欺骗 / Webdriver / 版本不同".
 *
 * So for this kernel we DROP the JS/CDP fingerprint injection entirely and drive
 * everything through the native flags below. Unknown --fingerprint-* flags are
 * ignored by ordinary Chromium, so passing them is only meaningful once we have
 * confirmed (via detectFingerprintChromium) that the binary understands them.
 *
 * Flags (from the fingerprint-chromium binary):
 *   --fingerprint=<uint64>              master seed (enables spoofing)
 *   --fingerprint-platform=windows|macos|linux|android|ios
 *   --fingerprint-platform-version=<v>
 *   --fingerprint-brand / --fingerprint-brand-version   (NOT used — see below)
 *   --fingerprint-hardware-concurrency=<n>
 *   --fingerprint-screen-width / --fingerprint-screen-height
 *   --fingerprint-device-scale-factor=<f>
 *   --lang=<tag>  --timezone=<IANA>  --disable-non-proxied-udp
 *
 * We deliberately do NOT set --fingerprint-brand-version: it does not rewrite the
 * UA string major (still the real build), so forcing it would re-introduce a
 * UA/headers version mismatch. The consistent choice is the binary's own version
 * everywhere.
 */

const crypto = require('crypto');
const { parseOsFromUa } = require('./user-agent');

/** Whether the resolved kernel is a confirmed fingerprint-chromium build. */
function isFingerprintChromium(browser = {}) {
  if (!browser) return false;
  if (browser.fingerprintChromium === true) return true;
  // Heuristic fallback (path/name) for callers that did not carry the meta flag.
  const p = String(browser.path || browser.binary || '').toLowerCase();
  return /fingerprint[-_]?chromium/.test(p);
}

/** fingerprint-chromium --fingerprint-platform value from the profile UA. */
function platformFlagFromFp(fp = {}) {
  const os = parseOsFromUa(fp.userAgent || '');
  if (os === 'macos') return 'macos';
  if (os === 'linux') return 'linux';
  if (os === 'android') return 'android';
  if (os === 'ios') return 'ios';
  return 'windows';
}

/** Stable uint64 (decimal string) seed for --fingerprint, derived per profile. */
function fingerprintSeed(fp = {}, profile = {}) {
  const basis = String(fp.seed || profile.id || fp.profileId || 'openbrowser');
  const hex = crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
  // uint64 range; BigInt keeps full precision as a decimal string.
  const n = BigInt('0x' + hex);
  return (n === 0n ? 1n : n).toString();
}

/**
 * Build the native launch flags for a fingerprint-chromium kernel from an
 * OpenBrowser fingerprint. This REPLACES OpenBrowser's identity flags + JS
 * injection for this kernel.
 */
function chromeArgsForFingerprintChromium(fp = {}, profile = {}) {
  const args = [];
  const meta = fp.userAgentMetadata || fp.uaProfile?.metadata || {};

  args.push(`--fingerprint=${fingerprintSeed(fp, profile)}`);
  args.push(`--fingerprint-platform=${platformFlagFromFp(fp)}`);
  if (meta.platformVersion) args.push(`--fingerprint-platform-version=${meta.platformVersion}`);

  if (Number(fp.hardwareConcurrency) > 0) {
    args.push(`--fingerprint-hardware-concurrency=${Math.round(Number(fp.hardwareConcurrency))}`);
  }
  if (fp.screen) {
    if (Number(fp.screen.width) > 0) args.push(`--fingerprint-screen-width=${Math.round(Number(fp.screen.width))}`);
    if (Number(fp.screen.height) > 0) args.push(`--fingerprint-screen-height=${Math.round(Number(fp.screen.height))}`);
    if (Number(fp.screen.devicePixelRatio) > 0) args.push(`--fingerprint-device-scale-factor=${Number(fp.screen.devicePixelRatio)}`);
  }

  const lang = (Array.isArray(fp.languages) && fp.languages[0]) || profile.language || '';
  const primaryLang = String(lang).split(',')[0].trim();
  if (primaryLang) args.push(`--lang=${primaryLang}`);

  const timezone = String(profile.exitTimezone || fp.dynamicConfig?.timezone || '').trim();
  if (timezone) args.push(`--timezone=${timezone}`);

  if (fp.webrtc === 'disabled' || fp.webrtc === 'proxy') args.push('--disable-non-proxied-udp');

  return args;
}

/** Launch flags OpenBrowser must NOT pass to this kernel (native layer owns them). */
function isIdentityFlagToSkip(flag) {
  return /^--(user-agent|lang|window-size|disable-webgl|disable-webgl2|disable-3d-apis|force-webrtc-ip-handling-policy|webrtc-ip-handling-policy)(=|$)/.test(flag);
}

module.exports = {
  isFingerprintChromium,
  chromeArgsForFingerprintChromium,
  platformFlagFromFp,
  fingerprintSeed,
  isIdentityFlagToSkip,
};

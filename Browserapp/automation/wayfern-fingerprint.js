'use strict';

/**
 * Wayfern (Donut) native fingerprint bridge.
 *
 * Why this exists
 * ---------------
 * Wayfern is an anti-detect Chromium. Its native layer OWNS User-Agent, WebGL
 * vendor/renderer, canvas/audio/font noise, screen, timezone, languages, etc.,
 * and it deliberately GATES standard automation behind a paid plan:
 *
 *   Runtime.evaluate                         -> "Browser automation requires a
 *   Page.addScriptToEvaluateOnNewDocument    -> paid Donut Browser plan."
 *
 * That is exactly why OpenBrowser's normal fingerprint stack (document-start JS
 * inject + Runtime.evaluate probes) silently fails on Wayfern and the browser
 * reports its REAL User-Agent / WebGL / hardware. Emulation.setUserAgentOverride
 * is accepted by the endpoint but the native layer overrides it, so it is a
 * no-op too.
 *
 * The ONLY channel Wayfern honours is its own CDP domain:
 *   - Wayfern.getFingerprint            (read current per-context fingerprint)
 *   - Wayfern.setFingerprint            (set custom values; FLAT params)
 *   - Wayfern.refreshFingerprint / resetFingerprint
 *
 * setFingerprint takes a FLAT params object (NOT nested under `fingerprint`),
 * applies per BrowserContext, and is inherited by every document/frame/worker
 * created afterwards — so it must be set before the start-page navigation.
 * Unknown keys are ignored, so sending a superset is safe.
 *
 * Cross-OS caveat
 * ---------------
 * Spoofing an OS different from the host requires a paid `wayfernToken`:
 *   "Cross-OS fingerprinting requires a paid plan. Provide a wayfernToken parameter."
 * Same-OS spoofing (WebGL GPU, cores, memory, timezone, languages, screen,
 * canvas noise, and same-OS UA) works with no token. When a cross-OS request has
 * no valid token we fall back to the OS-neutral subset so host hardware still
 * does not leak, and surface a clear warning.
 */

const crypto = require('crypto');
const { parseOsFromUa } = require('./user-agent');

const SOURCE_WAYFERN = 'donut-wayfern';

/** Same detection as browser-kernel.isWayfernKernel, duplicated to avoid a cycle. */
function isWayfernKernel(candidate = {}, versionOutput = '') {
  const source = String(candidate.source || '').toLowerCase();
  const binaryPath = String(candidate.path || candidate.binary || candidate || '')
    .toLowerCase().replace(/\\/g, '/');
  const version = String(versionOutput || candidate.versionOutput || '').toLowerCase();
  return source === SOURCE_WAYFERN
    || /(?:^|\/)wayfern(?:\/|$)/.test(binaryPath)
    || /\bwayfern\b/.test(version);
}

function hostOsType(platform = process.platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  return 'windows';
}

/** OS family of a fingerprint, from its UA (Wayfern keys OS off the UA/platform). */
function fingerprintOsType(fp = {}) {
  const os = parseOsFromUa(fp.userAgent || '');
  if (os === 'ios') return 'ios';
  if (os === 'android') return 'android';
  if (os === 'macos') return 'macos';
  if (os === 'linux') return 'linux';
  if (os === 'windows') return 'windows';
  return hostOsType();
}

/** Deterministic 32-hex canvas noise seed from the profile seed + canvas mark. */
function canvasNoiseSeedFromFp(fp = {}) {
  const basis = `${fp.seed || fp.profileId || 'openbrowser'}:${fp.canvas?.mark ?? 0}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32).toUpperCase();
}

/** Pick the real (non-grease) Chrome brand + major from UA metadata. */
function brandFromFp(fp = {}) {
  const meta = fp.userAgentMetadata || fp.uaProfile?.metadata || {};
  const brands = Array.isArray(meta.brands) ? meta.brands : [];
  const real = brands.find((b) => /chrome|chromium/i.test(String(b.brand || '')) && !/not/i.test(String(b.brand || '')));
  const brand = String(real?.brand || 'Google Chrome');
  const version = String(real?.version || fp.uaProfile?.chromeMajor || '').split('.')[0] || '';
  return { brand, version };
}

/**
 * Map an OpenBrowser fingerprint to Wayfern setFingerprint FLAT params.
 * OS-specific keys are tagged so the cross-OS fallback can drop them.
 * @returns {{ params: object, osNeutralKeys: Set<string>, osType: string }}
 */
function buildWayfernFingerprintParams(fp = {}, profile = {}, options = {}) {
  const params = {};
  const osSpecific = new Set();
  const put = (key, value, { osTied = false } = {}) => {
    if (value === undefined || value === null || value === '') return;
    params[key] = value;
    if (osTied) osSpecific.add(key);
  };

  // --- Identity (OS-tied) ---
  put('userAgent', fp.userAgent, { osTied: true });
  put('platform', fp.platform, { osTied: true });
  const meta = fp.userAgentMetadata || fp.uaProfile?.metadata || {};
  put('platformVersion', meta.platformVersion, { osTied: true });
  const { brand, version } = brandFromFp(fp);
  put('brand', brand, { osTied: true });
  put('brandVersion', version, { osTied: true });
  put('vendor', fp.vendor || fp.uaProfile?.vendor, { osTied: true });

  // --- WebGL meta (OS-tied: a D3D11 renderer must not sit under a Linux UA) ---
  if (fp.webgl && fp.webgl.mode !== 'blocked' && fp.webgl.metaMode !== 'real') {
    put('webglVendor', fp.webgl.vendor, { osTied: true });
    put('webglRenderer', fp.webgl.renderer, { osTied: true });
  }

  // --- Hardware / locale (OS-neutral) ---
  if (Number(fp.hardwareConcurrency) > 0) put('hardwareConcurrency', Math.round(Number(fp.hardwareConcurrency)));
  if (Number(fp.deviceMemory) > 0) put('deviceMemory', Math.round(Number(fp.deviceMemory)));
  const langs = Array.isArray(fp.languages) ? fp.languages.filter(Boolean) : [];
  if (langs.length) {
    put('languages', langs);
    put('language', langs[0]);
  }
  if (fp.maxTouchPoints != null) params.maxTouchPoints = Math.max(0, Number(fp.maxTouchPoints) || 0);
  if (fp.doNotTrack === '1') put('doNotTrack', '1');

  // --- Timezone / geo (OS-neutral; follow exit IP) ---
  const timezone = options.timezone
    || fp.dynamicConfig?.timezone
    || profile.exitTimezone
    || '';
  put('timezone', timezone);
  const geo = fp.dynamicConfig?.geoposition
    || (Number.isFinite(Number(profile.exitLatitude)) && Number.isFinite(Number(profile.exitLongitude))
      ? { latitude: Number(profile.exitLatitude), longitude: Number(profile.exitLongitude), accuracy: 100 }
      : null);
  if (geo && Number.isFinite(Number(geo.latitude)) && Number.isFinite(Number(geo.longitude))) {
    params.latitude = Number(geo.latitude);
    params.longitude = Number(geo.longitude);
    params.accuracy = Number(geo.accuracy) || 100;
  }

  // --- Screen (OS-neutral) ---
  if (fp.screen) {
    if (Number(fp.screen.width) > 0) params.screenWidth = Math.round(Number(fp.screen.width));
    if (Number(fp.screen.height) > 0) params.screenHeight = Math.round(Number(fp.screen.height));
    if (Number(fp.screen.availWidth) > 0) params.screenAvailWidth = Math.round(Number(fp.screen.availWidth));
    if (Number(fp.screen.availHeight) > 0) params.screenAvailHeight = Math.round(Number(fp.screen.availHeight));
    if (Number(fp.screen.colorDepth) > 0) params.screenColorDepth = Math.round(Number(fp.screen.colorDepth));
    if (Number(fp.screen.devicePixelRatio) > 0) params.devicePixelRatio = Number(fp.screen.devicePixelRatio);
  }

  // --- Canvas noise seed (OS-neutral; deterministic per profile) ---
  if (fp.canvas?.mode === 'noise') put('canvasNoiseSeed', canvasNoiseSeedFromFp(fp));

  // --- Cross-OS authorization token, if configured ---
  const token = options.token
    || profile.advanced?.wayfernToken
    || profile.wayfernToken
    || process.env.WAYFERN_TOKEN
    || '';
  if (token) params.wayfernToken = String(token);

  const osNeutralKeys = new Set(Object.keys(params).filter((k) => !osSpecific.has(k)));
  return { params, osNeutralKeys, osType: fingerprintOsType(fp), token: String(token || '') };
}

function isCrossOsError(message = '') {
  return /cross-os fingerprinting requires a paid plan|cross-os fingerprinting authorization failed/i.test(String(message));
}

function isPaidPlanError(message = '') {
  return /requires a paid (donut browser|wayfern) plan/i.test(String(message));
}

/**
 * Apply an OpenBrowser fingerprint to a Wayfern kernel through its native CDP
 * domain. Best-effort: never throws — returns a telemetry object instead.
 *
 * @param {(wsUrl:string, method:string, params?:object, timeout?:number)=>Promise<any>} cdpCall
 * @param {string} pageWsUrl  a page target's webSocketDebuggerUrl (Wayfern domain is page-scoped)
 * @param {object} fp         OpenBrowser fingerprint (buildFingerprint output)
 * @param {object} profile
 * @param {object} [options]  { token, timezone }
 */
async function applyWayfernFingerprint(cdpCall, pageWsUrl, fp, profile = {}, options = {}) {
  if (typeof cdpCall !== 'function') return { ok: false, error: 'cdp call function required' };
  if (!pageWsUrl) return { ok: false, error: 'wayfern: no page target' };
  const built = buildWayfernFingerprintParams(fp, profile, options);
  const host = hostOsType();

  const send = async (params) => cdpCall(pageWsUrl, 'Wayfern.setFingerprint', params, options.timeout || 10000);

  try {
    const result = await send(built.params);
    return {
      ok: true,
      applied: 'full',
      osType: built.osType,
      hostOsType: host,
      crossOs: built.osType !== host,
      usedToken: Boolean(built.token),
      fingerprint: result?.fingerprint || null,
      keys: Object.keys(built.params),
    };
  } catch (error) {
    const message = String(error?.message || error || '');
    // Cross-OS without a valid token: re-apply the OS-neutral subset so host
    // hardware (GPU/cores/memory) still does not leak, and flag for the caller.
    if (isCrossOsError(message)) {
      const subset = {};
      for (const key of built.osNeutralKeys) subset[key] = built.params[key];
      try {
        const result = await send(subset);
        return {
          ok: true,
          applied: 'os-neutral-subset',
          osType: built.osType,
          hostOsType: host,
          crossOs: true,
          usedToken: Boolean(built.token),
          crossOsBlocked: true,
          error: message,
          fingerprint: result?.fingerprint || null,
          keys: Object.keys(subset),
        };
      } catch (subError) {
        return { ok: false, applied: 'none', crossOs: true, crossOsBlocked: true, error: String(subError?.message || subError) };
      }
    }
    return { ok: false, applied: 'none', error: message, paidPlan: isPaidPlanError(message) };
  }
}

module.exports = {
  SOURCE_WAYFERN,
  isWayfernKernel,
  hostOsType,
  fingerprintOsType,
  canvasNoiseSeedFromFp,
  brandFromFp,
  buildWayfernFingerprintParams,
  applyWayfernFingerprint,
  isCrossOsError,
  isPaidPlanError,
};

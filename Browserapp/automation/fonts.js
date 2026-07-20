'use strict';

/**
 * Font fingerprint surface.
 *
 * Detection vectors this module defends against:
 *  1) Measurement enumeration — render text as `font-family: "Target", monospace`
 *     and compare offsetWidth/offsetHeight (or canvas measureText width) against
 *     the bare `monospace` baseline. A difference means "Target" is installed.
 *  2) `document.fonts.check('12px "Target"')` — FontFaceSet direct query.
 *  3) `window.queryLocalFonts()` — Local Font Access API (Chrome 103+), returns
 *     postscriptName/fullName/family/style for every installed face.
 *  4) Text metric drift — even with an identical font set, subpixel metrics
 *     (width, actualBoundingBoxAscent/Descent) vary per machine.
 *
 * Strategy (mirrors how commercial fingerprint browsers behave):
 *  - Each profile gets a deterministic font set = OS base fonts (always present,
 *    removing them looks broken and is itself a signal) + a seeded subset of the
 *    OS optional pool. Two profiles on the same OS therefore differ, while a
 *    single profile stays stable across restarts.
 *  - Masking happens at font *resolution* time, not at measurement time: masked
 *    families are stripped from any font-family value before the engine sees it,
 *    so the browser genuinely falls back and the resulting metrics are real.
 *    That is undetectable by measurement comparison, unlike patching offsetWidth.
 *  - A per-profile metric mark adds sub-pixel noise to canvas text metrics so the
 *    metrics fingerprint itself is not shared between profiles.
 *
 * Consumed by fingerprint.js (buildFingerprint / buildInjectionScript).
 */

const crypto = require('crypto');

function hashSeed(input) {
  return crypto.createHash('sha256').update(String(input)).digest();
}

function u32(buf, offset = 0) {
  return buf.readUInt32BE(offset % (buf.length - 4));
}

/** CSS generic families always resolve locally and must never be masked. */
const GENERIC_FAMILIES = [
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
  'math', 'emoji', 'fangsong',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default',
  '-apple-system', 'blinkmacsystemfont',
];

/**
 * Per-OS font pools.
 *  base     — shipped with a clean OS install; always reported present.
 *  optional — bundled with Office / creative suites / language packs / user
 *             installs. Seeded inclusion here is what makes profiles differ.
 */
const FONT_POOLS = {
  windows: {
    base: [
      'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Cambria Math',
      'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
      'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia',
      'HoloLens MDL2 Assets', 'Impact', 'Ink Free', 'Javanese Text', 'Leelawadee UI',
      'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Marlett',
      'Microsoft Himalaya', 'Microsoft JhengHei', 'Microsoft New Tai Lue',
      'Microsoft PhagsPa', 'Microsoft Sans Serif', 'Microsoft Tai Le',
      'Microsoft YaHei', 'Microsoft Yi Baiti', 'MingLiU-ExtB', 'Mongolian Baiti',
      'MS Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI', 'Palatino Linotype',
      'Segoe Fluent Icons', 'Segoe MDL2 Assets', 'Segoe Print', 'Segoe Script',
      'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol',
      'SimSun', 'Sitka', 'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman',
      'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
    ],
    optional: [
      'Agency FB', 'Algerian', 'Book Antiqua', 'Bookman Old Style',
      'Bookshelf Symbol 7', 'Bradley Hand ITC', 'Britannic Bold', 'Berlin Sans FB',
      'Broadway', 'Brush Script MT', 'Californian FB', 'Centaur', 'Century',
      'Century Gothic', 'Century Schoolbook', 'Chiller', 'Colonna MT',
      'Cooper Black', 'Copperplate Gothic Bold', 'Copperplate Gothic Light',
      'Curlz MT', 'Elephant', 'Engravers MT', 'Eras Bold ITC', 'Felix Titling',
      'Footlight MT Light', 'Forte', 'Freestyle Script', 'French Script MT',
      'Garamond', 'Gigi', 'Gill Sans MT', 'Gloucester MT Extra Condensed',
      'Goudy Old Style', 'Haettenschweiler', 'Harlow Solid Italic', 'Harrington',
      'High Tower Text', 'Imprint MT Shadow', 'Informal Roman', 'Jokerman',
      'Juice ITC', 'Kristen ITC', 'Kunstler Script', 'Wide Latin', 'Lucida Bright',
      'Lucida Calligraphy', 'Lucida Fax', 'Lucida Handwriting', 'Lucida Sans',
      'Lucida Sans Typewriter', 'Magneto', 'Maiandra GD',
      'Matura MT Script Capitals', 'Mistral', 'Modern No. 20', 'Monotype Corsiva',
      'Niagara Engraved', 'Niagara Solid', 'OCR A Extended', 'Old English Text MT',
      'Onyx', 'Palace Script MT', 'Papyrus', 'Parchment', 'Perpetua',
      'Perpetua Titling MT', 'Playbill', 'Poor Richard', 'Pristina', 'Rage Italic',
      'Ravie', 'Rockwell', 'Rockwell Condensed', 'Script MT Bold',
      'Showcard Gothic', 'Snap ITC', 'Stencil', 'Tempus Sans ITC', 'Tw Cen MT',
      'Viner Hand ITC', 'Vivaldi', 'Vladimir Script', 'Wingdings 2', 'Wingdings 3',
      'Arial Narrow', 'Arial Rounded MT Bold', 'Bodoni MT', 'Calisto MT',
      'Castellar', 'Edwardian Script ITC', 'Franklin Gothic Book', 'Bell MT',
      'Berlin Sans FB Demi', 'Bernard MT Condensed', 'Blackadder ITC', 'Candara Light',
      'Constantia Light', 'Corbel Light', 'Dubai', 'Gill Sans Nova', 'Rockwell Nova',
      'Sitka Text', 'Verdana Pro', 'Yu Mincho', 'MS PGothic', 'MS UI Gothic',
      // 'FangSong' is intentionally absent: CSS defines `fangsong` as a generic
      // family, so it can never be masked and would be dead weight in the pool.
      'NSimSun', 'SimHei', 'KaiTi', 'DengXian', 'Meiryo', 'Meiryo UI',
    ],
  },
  macos: {
    base: [
      'American Typewriter', 'Andale Mono', 'Arial', 'Arial Black', 'Arial Narrow',
      'Arial Rounded MT Bold', 'Arial Unicode MS', 'Avenir', 'Avenir Next',
      'Avenir Next Condensed', 'Baskerville', 'Big Caslon', 'Bodoni 72',
      'Bodoni 72 Oldstyle', 'Bodoni 72 Smallcaps', 'Bradley Hand', 'Brush Script MT',
      'Chalkboard', 'Chalkboard SE', 'Chalkduster', 'Charter', 'Cochin',
      'Comic Sans MS', 'Copperplate', 'Courier', 'Courier New', 'Didot',
      'DIN Alternate', 'DIN Condensed', 'Futura', 'Geneva', 'Georgia', 'Gill Sans',
      'Helvetica', 'Helvetica Neue', 'Herculanum', 'Hoefler Text', 'Impact',
      'Lucida Grande', 'Luminari', 'Marker Felt', 'Menlo', 'Microsoft Sans Serif',
      'Monaco', 'Noteworthy', 'Optima', 'Palatino', 'Papyrus', 'Phosphate',
      'Rockwell', 'Savoye LET', 'SignPainter', 'Skia', 'Snell Roundhand', 'Tahoma',
      'Times', 'Times New Roman', 'Trattatello', 'Trebuchet MS', 'Verdana',
      'Zapfino', 'Apple Chancery', 'Apple Color Emoji', 'Apple SD Gothic Neo',
      'Apple Symbols', 'AppleGothic', 'AppleMyungjo', 'Hiragino Sans',
      'Hiragino Kaku Gothic Pro', 'Hiragino Mincho ProN', 'PingFang SC', 'PingFang TC',
      'PingFang HK', 'Heiti SC', 'Heiti TC', 'Songti SC', 'Songti TC', 'STHeiti',
      'STSong', 'Thonburi', 'Kailasa', 'Kefa', 'Krungthep', 'Mshtakan', 'Nadeem',
      'New Peninim MT', 'Raanana', 'Sana', 'Sathu', 'Silom', 'Symbol', 'Webdings',
      'Wingdings', 'Wingdings 2', 'Wingdings 3', 'Zapf Dingbats',
    ],
    optional: [
      'Academy Engraved LET', 'Al Bayan', 'Al Nile', 'Al Tarikh', 'Athelas',
      'Ayuthaya', 'Baghdad', 'Bangla MN', 'Bangla Sangam MN', 'Beirut',
      'BiauKai', 'Bodoni Ornaments', 'Bookman Old Style', 'Bookshelf Symbol 7',
      'Century Gothic', 'Century Schoolbook', 'Corsiva Hebrew', 'Damascus',
      'DecoType Naskh', 'Devanagari MT', 'Devanagari Sangam MN', 'Diwan Kufi',
      'Diwan Thuluth', 'Euphemia UCAS', 'Farah', 'Farisi', 'Garamond',
      'GB18030 Bitmap', 'Gujarati MT', 'Gujarati Sangam MN', 'Gurmukhi MN',
      'Gurmukhi Sangam MN', 'Hannotate SC', 'HanziPen SC', 'Hei', 'Hiragino Sans GB',
      'Iowan Old Style', 'ITF Devanagari', 'Kaiti SC', 'Kannada MN',
      'Kannada Sangam MN', 'Khmer MN', 'Khmer Sangam MN', 'Kohinoor Bangla',
      'Kohinoor Devanagari', 'Kohinoor Telugu', 'Kokonor', 'Lao MN',
      'Lao Sangam MN', 'Lucida Bright', 'Lucida Console', 'Lucida Fax',
      'Lucida Handwriting', 'Lucida Sans', 'Lucida Sans Typewriter', 'Malayalam MN',
      'Malayalam Sangam MN', 'Mishafi', 'Monotype Corsiva', 'Mukta Mahee',
      'Muna', 'Myanmar MN', 'Myanmar Sangam MN', 'Nanum Gothic', 'Nanum Myeongjo',
      'Oriya MN', 'Oriya Sangam MN', 'Osaka', 'Perpetua', 'PT Mono', 'PT Sans',
      'PT Serif', 'Plantagenet Cherokee', 'Rockwell Extra Bold', 'Seravek',
      'Shree Devanagari 714', 'Sinhala MN', 'Sinhala Sangam MN', 'STFangsong',
      'STIXGeneral', 'STKaiti', 'Sukhumvit Set', 'Superclarendon', 'Tamil MN',
      'Tamil Sangam MN', 'Telugu MN', 'Telugu Sangam MN', 'Tsukushi A Round Gothic',
      'Waseem', 'Yu Gothic', 'Yu Mincho', 'Yuanti SC', 'YuppySC',
      'SF Compact', 'SF Mono', 'SF Pro', 'SF Pro Display', 'SF Pro Text',
      'New York', 'Menlo Bold', 'Andale Mono Bold',
    ],
  },
  linux: {
    base: [
      'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'DejaVu Sans Condensed',
      'DejaVu Serif Condensed', 'Liberation Mono', 'Liberation Sans',
      'Liberation Sans Narrow', 'Liberation Serif', 'Noto Sans', 'Noto Serif',
      'Noto Mono', 'Noto Color Emoji', 'Noto Sans Symbols', 'FreeMono', 'FreeSans',
      'FreeSerif', 'Nimbus Mono PS', 'Nimbus Roman', 'Nimbus Sans',
      'Nimbus Sans Narrow', 'C059', 'P052', 'URW Bookman', 'URW Gothic',
      'Standard Symbols PS', 'Z003', 'D050000L',
    ],
    optional: [
      'Ubuntu', 'Ubuntu Condensed', 'Ubuntu Mono', 'Ubuntu Light', 'Cantarell',
      'Droid Sans', 'Droid Sans Mono', 'Droid Serif', 'Roboto', 'Roboto Condensed',
      'Roboto Mono', 'Open Sans', 'Lato', 'Source Code Pro', 'Source Sans Pro',
      'Source Serif Pro', 'Fira Sans', 'Fira Mono', 'Fira Code', 'Inconsolata',
      'Hack', 'JetBrains Mono', 'Cascadia Code', 'Cousine', 'Arimo', 'Tinos',
      'Carlito', 'Caladea', 'Gelasio', 'Selawik', 'Oxygen', 'Oxygen Mono',
      'Abyssinica SIL', 'Khmer OS', 'Lohit Bengali', 'Lohit Devanagari',
      'Lohit Gujarati', 'Lohit Tamil', 'Kalimati', 'Mukti Narrow', 'Rachana',
      'Samyak Devanagari', 'Samyak Gujarati', 'Samyak Tamil', 'Saab',
      'WenQuanYi Micro Hei', 'WenQuanYi Micro Hei Mono', 'WenQuanYi Zen Hei',
      'AR PL UMing CN', 'AR PL UKai CN', 'Takao Gothic', 'Takao Mincho',
      'IPAGothic', 'IPAMincho', 'VL Gothic', 'Nanum Gothic', 'Nanum Myeongjo',
      'Noto Sans CJK SC', 'Noto Sans CJK JP', 'Noto Sans CJK KR', 'Noto Sans Mono',
      'Noto Serif CJK SC', 'Symbola', 'Unifont', 'Terminus', 'Bitstream Vera Sans',
      'Bitstream Vera Serif', 'Bitstream Vera Sans Mono', 'Century Schoolbook L',
      'Dingbats', 'Garuda', 'Kinnari', 'Loma', 'Norasi', 'Purisa', 'Sawasdee',
      'Tlwg Typist', 'Umpush', 'Waree',
    ],
  },
};

/** Fold a font family token to a comparable key (case/quote/space insensitive). */
function normalizeFontName(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** True when the token is a CSS generic family and must resolve untouched. */
function isGenericFamily(value) {
  return GENERIC_FAMILIES.includes(normalizeFontName(value));
}

function poolForOs(os) {
  const key = String(os || '').toLowerCase();
  if (key === 'macos' || key === 'mac' || key === 'darwin') return FONT_POOLS.macos;
  if (key === 'linux') return FONT_POOLS.linux;
  return FONT_POOLS.windows;
}

/**
 * Sub-pixel text metric mark, mirroring audioMarkFromSeed / clientRectMarkFromSeed.
 * Range ±1000, never 0 (0 would mean "no noise" and leak the unmodified metric).
 */
function fontMetricMarkFromSeed(seedBufOrStr) {
  if (Buffer.isBuffer(seedBufOrStr)) {
    const v = (u32(seedBufOrStr, 48) % 2000) - 1000;
    return v === 0 ? 1 : v;
  }
  const s = String(seedBufOrStr || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const v = (Math.abs(h) % 2000) - 1000;
  return v === 0 ? 1 : v;
}

/**
 * Deterministic per-profile font set.
 *
 * @param {Buffer|string} seedInput  profile seed (Buffer from hashSeed preferred)
 * @param {string} os                windows | macos | linux
 * @param {object} options
 *   @param {number} options.ratio   share of the optional pool to include (0..1)
 *   @param {string[]} options.extra additional families to force-install
 *   @param {string[]} options.exclude families to force-remove (base included)
 * @returns {{ os, base: string[], optional: string[], installed: string[], metricMark: number }}
 */
function createFontProfileFromSeed(seedInput, os = 'windows', options = {}) {
  const seed = Buffer.isBuffer(seedInput) ? seedInput : hashSeed(String(seedInput || 'fonts'));
  const pool = poolForOs(os);
  const ratio = Number.isFinite(Number(options.ratio))
    ? Math.min(1, Math.max(0, Number(options.ratio)))
    : 0.35 + ((u32(seed, 52) % 30) / 100); // 0.35 .. 0.64, seeded

  // Independent per-font inclusion draw keeps neighbouring seeds from producing
  // near-identical sets, which a prefix-slice would.
  const optional = pool.optional.filter((name, index) => {
    const draw = u32(seed, (index * 4) % (seed.length - 4));
    return ((draw >>> (index % 8)) % 1000) / 1000 < ratio;
  });

  const exclude = new Set((options.exclude || []).map(normalizeFontName));
  const extra = (options.extra || []).filter((name) => name && !isGenericFamily(name));

  const base = pool.base.filter((name) => !exclude.has(normalizeFontName(name)));
  const merged = [];
  const seen = new Set();
  for (const name of [...base, ...optional, ...extra]) {
    const key = normalizeFontName(name);
    if (!key || seen.has(key) || exclude.has(key)) continue;
    seen.add(key);
    merged.push(name);
  }

  return {
    os: pool === FONT_POOLS.macos ? 'macos' : (pool === FONT_POOLS.linux ? 'linux' : 'windows'),
    base,
    optional,
    installed: merged.sort((a, b) => a.localeCompare(b)),
    metricMark: fontMetricMarkFromSeed(seed),
  };
}

module.exports = {
  FONT_POOLS,
  GENERIC_FAMILIES,
  normalizeFontName,
  isGenericFamily,
  poolForOs,
  createFontProfileFromSeed,
  fontMetricMarkFromSeed,
};

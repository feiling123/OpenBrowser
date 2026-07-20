'use strict';

/**
 * Safety checks for the extracted-kernel validator.
 *
 * Reproduces the real macOS .app layout that CI packaging trips over:
 * a framework whose Helpers/Libraries/Resources are links into
 * Versions/Current, which is itself a link to the versioned directory.
 *
 *   node automation/kernel-extract-safety-selftest.js
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { assertSafeExtractedTree } = require('./browser-kernel');

function pass(name) { console.log('  PASS  ' + name); }

/** Build the framework layout the Wayfern DMG actually ships. */
async function makeAppBundle(root, { version = '149.0.7827.114', danglingCurrent = false } = {}) {
  const fw = path.join(root, 'Contents', 'Frameworks', 'Wayfern Framework.framework');
  const versioned = path.join(fw, 'Versions', version);
  for (const dir of ['Helpers', 'Libraries', 'Resources']) {
    await fsp.mkdir(path.join(versioned, dir), { recursive: true });
    await fsp.writeFile(path.join(versioned, dir, 'placeholder'), 'x');
  }
  await fsp.writeFile(path.join(versioned, 'Wayfern Framework'), 'binary');
  await fsp.mkdir(path.join(root, 'Contents', 'MacOS'), { recursive: true });
  await fsp.writeFile(path.join(root, 'Contents', 'MacOS', 'Wayfern'), 'binary');

  // Versions/Current -> <version>  (or a version that was never shipped)
  await fsp.symlink(danglingCurrent ? '999.0.0.0' : version, path.join(fw, 'Versions', 'Current'));
  for (const name of ['Helpers', 'Libraries', 'Resources', 'Wayfern Framework']) {
    await fsp.symlink(path.join('Versions', 'Current', name), path.join(fw, name));
  }
  return fw;
}

async function main() {
  console.log('Kernel extract safety selftest\n');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-kernel-safety-'));

  try {
    // --- the real bundle layout must be accepted --------------------------
    const good = path.join(tmp, 'good', 'Wayfern.app');
    await fsp.mkdir(good, { recursive: true });
    await makeAppBundle(good);
    await assertSafeExtractedTree(good);
    pass('accepts the real macOS framework link layout');

    // --- dangling but internal links must be accepted ---------------------
    // A copy step can leave these; they point inside the bundle, so they are
    // not an escape and must not fail the build.
    const dangling = path.join(tmp, 'dangling', 'Wayfern.app');
    await fsp.mkdir(dangling, { recursive: true });
    await makeAppBundle(dangling, { danglingCurrent: true });
    await assertSafeExtractedTree(dangling);
    pass('accepts a dangling link that still points inside the tree');

    // --- absolute escape must be rejected ---------------------------------
    const escapeAbs = path.join(tmp, 'escape-abs', 'Wayfern.app');
    await fsp.mkdir(escapeAbs, { recursive: true });
    await makeAppBundle(escapeAbs);
    await fsp.symlink('/etc', path.join(escapeAbs, 'Applications'));
    await assert.rejects(
      () => assertSafeExtractedTree(escapeAbs),
      (error) => {
        assert.match(error.message, /unsafe link/);
        assert.match(error.message, /Applications/, 'error must name the offending path');
        assert.match(error.message, /\/etc/, 'error must name the link target');
        return true;
      }
    );
    pass('rejects an absolute link escaping the tree, naming path and target');

    // --- relative escape must be rejected ---------------------------------
    const escapeRel = path.join(tmp, 'escape-rel', 'Wayfern.app');
    await fsp.mkdir(escapeRel, { recursive: true });
    await makeAppBundle(escapeRel);
    await fsp.symlink(path.join('..', '..', '..', 'outside'), path.join(escapeRel, 'Escape'));
    await fsp.mkdir(path.join(tmp, 'outside'), { recursive: true });
    await assert.rejects(
      () => assertSafeExtractedTree(escapeRel),
      (error) => /unsafe link/.test(error.message) && /Escape/.test(error.message)
    );
    pass('rejects a relative link escaping the tree');

    // --- a dangling link that escapes must still be rejected --------------
    // The lexical fallback must not become a hole: an unresolvable target
    // outside the root is still an escape.
    const escapeDangling = path.join(tmp, 'escape-dangling', 'Wayfern.app');
    await fsp.mkdir(escapeDangling, { recursive: true });
    await makeAppBundle(escapeDangling);
    await fsp.symlink('/nonexistent-path-outside', path.join(escapeDangling, 'Ghost'));
    await assert.rejects(
      () => assertSafeExtractedTree(escapeDangling),
      (error) => /unsafe link/.test(error.message) && /Ghost/.test(error.message)
    );
    pass('rejects a dangling link whose target lies outside the tree');

    // --- special files still rejected, and named -------------------------
    if (process.platform !== 'win32') {
      const special = path.join(tmp, 'special', 'Wayfern.app');
      await fsp.mkdir(special, { recursive: true });
      await makeAppBundle(special);
      try {
        fs.mkfifoSync?.(path.join(special, 'pipe'));
      } catch (_) { /* node has no mkfifo; skip below */ }
      if (fs.existsSync(path.join(special, 'pipe'))) {
        await assert.rejects(
          () => assertSafeExtractedTree(special),
          (error) => /special file/.test(error.message) && /pipe/.test(error.message)
        );
        pass('rejects a special file, naming it');
      }
    }

    console.log('\nAll kernel extract safety selftests passed.');
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\nFAIL', error);
  process.exit(1);
});

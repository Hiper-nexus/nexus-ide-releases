import { lstatSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateBuildNodeVersion(version) {
  const match = String(version).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 22 && minor >= 12;
}

// @electron/packager does not traverse a symlinked node_modules: the app.asar
// ships without node_modules or unpacked natives, yet still signs and
// notarizes cleanly — the breakage only appears at launch. Worse, the forge
// hooks then mutate the tree the symlink points at (bin shims wiped, natives
// rebuilt for the wrong arch, foreign-arch payloads pruned from the source).
export function isNodeModulesSymlink(root = process.cwd()) {
  try {
    return lstatSync(path.join(root, 'node_modules')).isSymbolicLink();
  } catch {
    return false;
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entryPoint === import.meta.url) {
  if (!validateBuildNodeVersion(process.versions.node)) {
    console.error(
      [
        `NexusIDE release builds require Node >=22.12.0 <23. Current Node: ${process.version}.`,
        'Use the pinned Node/npm toolchain from package.json before package/make.',
      ].join('\n'),
    );
    process.exit(1);
  }
  if (isNodeModulesSymlink()) {
    console.error(
      [
        'NexusIDE release builds require a real node_modules directory; this one is a symlink.',
        'Packaging through a symlink produces an app.asar without natives (the app signs,',
        'notarizes and then crashes at launch) and mutates the shared tree the link targets.',
        'Materialize a local copy first, e.g.:',
        '  rm node_modules && cp -Rc /path/to/main-checkout/node_modules node_modules',
      ].join('\n'),
    );
    process.exit(1);
  }
}

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compatRoot = path.join(root, 'third_party', 'braces-compat');
const packageJson = require(path.join(root, 'package.json'));
const packageLock = require(path.join(root, 'package-lock.json'));
const provenance = require(
  path.join(root, 'third_party', 'provenance', 'braces-3.0.3-depth-guard.json'),
);

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

describe('braces 3.0.3 with nesting-depth guards', () => {
  it('keeps every copied and patched file pinned to its recorded hash', () => {
    for (const file of provenance.files) {
      const pinned = file.type === 'copied' ? file.originalSha256 : file.nexusSha256;
      expect(sha256(path.join(root, file.nexusPath)), file.nexusPath).toBe(pinned);
    }
  });

  it('turns deeply nested patterns into a controlled error instead of a stack overflow (GHSA-vfj7-8cjw-p6xm)', () => {
    const entrypoint = path.join(compatRoot, 'index.js');
    const script = `
      const braces = require(${JSON.stringify(entrypoint)});
      const fit = (unit) => Math.floor(9989 / unit);
      const inputs = [
        '{'.repeat(fit(2)) + '}'.repeat(fit(2)),
        '{a,'.repeat(fit(4)) + 'b' + '}'.repeat(fit(4)),
        '\${'.repeat(fit(3)) + '}'.repeat(fit(3)),
      ];
      const outcomes = [];
      for (const input of inputs) {
        for (const run of [braces, braces.expand, braces.compile]) {
          try { run(input); outcomes.push('ok'); }
          catch (error) { outcomes.push(/maximum nesting depth/.test(error.message) ? 'guarded' : error.message); }
        }
      }
      process.stdout.write(JSON.stringify([...new Set(outcomes)]));
    `;
    const result = spawnSync(process.execPath, ['--stack-size=300', '-e', script], {
      cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 1_024 * 1_024,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['guarded']);
  });

  it('expands and compiles ordinary patterns exactly like upstream', () => {
    const braces = require(compatRoot);
    expect(braces.expand('a{1..3}b{c,d}')).toEqual(['a1bc', 'a1bd', 'a2bc', 'a2bd', 'a3bc', 'a3bd']);
    expect(braces.expand('{a,b{1..2}}')).toEqual(['a', 'b1', 'b2']);
    expect(braces('a{1..3}b{c,d}')).toEqual(['a([1-3])b(c|d)']);
    expect(braces.compile('{a,b{1..2}}')).toBe('(a|b(1|2))');
    expect(() => braces.compile('{'.repeat(50) + '}'.repeat(50), { maxDepth: 100 })).not.toThrow();
  });

  it('is the braces that the Forge glob stack resolves', () => {
    const micromatchRoot = path.dirname(require.resolve('micromatch/package.json'));
    expect(
      fs.realpathSync(require.resolve('braces', { paths: [micromatchRoot] })),
    ).toBe(fs.realpathSync(path.join(compatRoot, 'index.js')));
    const micromatch = require('micromatch');
    expect(micromatch.isMatch('src/a.ts', '{src,test}/*.{ts,tsx}')).toBe(true);
    expect(micromatch.isMatch('lib/a.ts', '{src,test}/*.{ts,tsx}')).toBe(false);
  });

  it('keeps the local package, override and lock coherent', () => {
    const entries = Object.entries(packageLock.packages).filter(
      ([packagePath]) => packagePath === 'node_modules/braces' || packagePath.endsWith('/node_modules/braces'),
    );
    expect(packageJson.devDependencies.braces).toBe('file:third_party/braces-compat');
    expect(packageJson.overrides.braces).toBe('$braces');
    expect(packageLock.packages['third_party/braces-compat'].version).toBe('3.0.4-nexus.1');
    expect(entries).toEqual([
      ['node_modules/braces', { resolved: 'third_party/braces-compat', link: true }],
    ]);
  });
});

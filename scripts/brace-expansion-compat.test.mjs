import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compatRoot = path.join(root, 'third_party', 'brace-expansion-compat');
const packageJson = require(path.join(root, 'package.json'));
const packageLock = require(path.join(root, 'package-lock.json'));
const provenance = require(
  path.join(
    root,
    'third_party',
    'provenance',
    'brace-expansion-5.0.12-compat.json',
  ),
);

/**
 * Runs `expand` from the compat entrypoint in a child process with the
 * default stack, so a regression that overflows the stack or hangs fails
 * this test instead of the vitest worker.
 */
function expandInChild(patternSource) {
  const entrypoint = path.join(compatRoot, 'index.cjs');
  const script = `
    const expand = require(${JSON.stringify(entrypoint)});
    const pattern = ${patternSource};
    const started = process.hrtime.bigint();
    let outcome;
    try {
      const output = expand(pattern);
      outcome = { ok: true, count: output.length };
    } catch (error) {
      outcome = { ok: false, error: error.constructor.name };
    }
    outcome.ms = Number(process.hrtime.bigint() - started) / 1e6;
    process.stdout.write(JSON.stringify(outcome));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1_024 * 1_024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function minimatchFunction(api) {
  if (typeof api === 'function') return api;
  if (typeof api?.minimatch === 'function') return api.minimatch;
  throw new TypeError('installed minimatch has no callable API');
}

describe('brace-expansion 5.0.12 compatibility boundary', () => {
  it('keeps every copied upstream artifact byte-for-byte pinned', () => {
    for (const file of provenance.files) {
      expect(sha256(path.join(root, file.nexusPath)), file.nexusPath).toBe(
        file.originalSha256,
      );
    }
  });

  it('keeps every provenance payload visible to a clean Git checkout', () => {
    for (const file of provenance.files) {
      const result = spawnSync(
        'git',
        ['check-ignore', '--no-index', '--quiet', '--', file.nexusPath],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
      expect(result.error, file.nexusPath).toBeUndefined();
      expect(result.status, file.nexusPath).toBe(1);
    }
  });

  it('delegates callable CJS and named ESM exports to the same upstream algorithm', async () => {
    const upstream = require(
      path.join(compatRoot, 'upstream', 'dist', 'commonjs', 'index.js'),
    );
    const commonJs = require('brace-expansion');
    const esm = await import('brace-expansion');

    expect(typeof commonJs).toBe('function');
    expect(commonJs).toBe(upstream.expand);
    expect(commonJs.expand).toBe(upstream.expand);
    expect(commonJs.EXPANSION_MAX).toBe(100_000);
    expect(commonJs.EXPANSION_MAX_LENGTH).toBe(4_000_000);
    expect(commonJs.EXPANSION_MAX_DEPTH).toBe(1_000);
    expect(commonJs.EXPANSION_MAX_REWRITES).toBe(1_000);
    for (const limit of [
      'EXPANSION_MAX',
      'EXPANSION_MAX_LENGTH',
      'EXPANSION_MAX_DEPTH',
      'EXPANSION_MAX_REWRITES',
    ]) {
      expect(commonJs[limit], limit).toBe(upstream[limit]);
      expect(esm[limit], limit).toBe(upstream[limit]);
    }

    expect(esm.default).toBe(esm.expand);
    expect(esm.EXPANSION_MAX).toBe(100_000);
    expect(esm.EXPANSION_MAX_LENGTH).toBe(4_000_000);
    expect(esm.EXPANSION_MAX_DEPTH).toBe(1_000);
    expect(esm.EXPANSION_MAX_REWRITES).toBe(1_000);
    expect(fs.readFileSync(path.join(compatRoot, 'index.mjs'), 'utf8')).toContain(
      'export const expand = upstream.expand;',
    );

    const cases = [
      ['file-{a,b,c}.js', ['file-a.js', 'file-b.js', 'file-c.js']],
      ['release-{03..09..3}', ['release-03', 'release-06', 'release-09']],
      ['{src,test}/{a,b}.ts', [
        'src/a.ts',
        'src/b.ts',
        'test/a.ts',
        'test/b.ts',
      ]],
      ['x\\{a,b\\}', ['x{a,b}']],
    ];
    for (const [pattern, expected] of cases) {
      expect(commonJs(pattern), pattern).toEqual(expected);
      expect(esm.expand(pattern), pattern).toEqual(expected);
    }
  });

  it('bounds the CVE expansion in a memory-limited child process', () => {
    const entrypoint = path.join(compatRoot, 'index.cjs');
    const script = `
      const expand = require(${JSON.stringify(entrypoint)});
      const output = expand('{a,b}'.repeat(1500));
      const totalLength = output.reduce((sum, value) => sum + value.length, 0);
      process.stdout.write(JSON.stringify({ count: output.length, totalLength }));
    `;
    const result = spawnSync(
      process.execPath,
      ['--max-old-space-size=256', '-e', script],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1_024 * 1_024,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      count: 2_666,
      totalLength: 3_999_000,
    });
  });

  // GHSA-qhr7-859c-m2p7: ~3,100 nested groups (about 6KB) overflowed the
  // native stack before 5.0.11. 5,000 levels now stop at EXPANSION_MAX_DEPTH.
  it('keeps deeply nested groups off the native stack (GHSA-qhr7-859c-m2p7)', () => {
    const outcome = expandInChild(
      `'{'.repeat(5000) + 'a,b' + '}'.repeat(5000)`,
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(outcome.count).toBeGreaterThan(0);
  });

  // GHSA-6j4f-fj2g-mc7p: parseCommaParts recursed once per chained group
  // before 5.0.10, so a long chain inside one set overflowed the stack.
  it('parses long chains of brace groups iteratively (GHSA-6j4f-fj2g-mc7p)', () => {
    const outcome = expandInChild(`'{' + '{x}'.repeat(60000) + ',y}'`);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      ok: true,
      count: 2,
    });
  });

  // GHSA-q2hr-2g5m-vwhr: each `{a},b}` rewrite restarted the scan over a
  // growing string; 5.0.9 needed ~3s for n = 40,000 (quadratic in n). 5.0.12
  // stops after EXPANSION_MAX_REWRITES and finishes in milliseconds.
  it('bounds the quadratic {a},b} rewrite (GHSA-q2hr-2g5m-vwhr)', () => {
    const outcome = expandInChild(`'{a}' + '}'.repeat(60000) + ',z}'`);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(outcome.ms).toBeLessThan(2_000);
  });

  it('supports every minimatch API shape installed by the Forge tree', () => {
    const installed = Object.entries(packageLock.packages)
      .filter(([packagePath]) => packagePath.endsWith('node_modules/minimatch'))
      .map(([packagePath, metadata]) => ({ packagePath, metadata }));

    expect(installed.length).toBeGreaterThan(0);
    const majors = new Set();
    const apiShapes = new Set();
    const compatEntrypoint = fs.realpathSync(
      path.join(compatRoot, 'index.cjs'),
    );

    for (const { packagePath, metadata } of installed) {
      const packageRoot = path.join(root, packagePath);
      const api = require(packageRoot);
      const match = minimatchFunction(api);
      const major = Number.parseInt(metadata.version.split('.')[0], 10);
      majors.add(major);
      apiShapes.add(typeof api === 'function' ? 'callable' : 'named');

      expect(match('alpha.ts', '{alpha,beta}.ts'), packagePath).toBe(true);
      expect(match('gamma.ts', '{alpha,beta}.ts'), packagePath).toBe(false);
      expect(
        fs.realpathSync(
          require.resolve('brace-expansion', { paths: [packageRoot] }),
        ),
        packagePath,
      ).toBe(compatEntrypoint);
    }

    expect([...majors].sort((a, b) => a - b)).toEqual([3, 5, 9]);
    expect([...apiShapes].sort()).toEqual(['callable', 'named']);
  });

  it('keeps the root/server lock and local override coherent', () => {
    const serverPackageJson = require(path.join(root, 'server', 'package.json'));
    const braceEntries = Object.entries(packageLock.packages).filter(
      ([packagePath]) =>
        packagePath === 'node_modules/brace-expansion' ||
        packagePath.endsWith('/node_modules/brace-expansion'),
    );

    expect(packageJson.devDependencies['brace-expansion']).toBe(
      'file:third_party/brace-expansion-compat',
    );
    expect(packageJson.overrides['brace-expansion']).toBe('$brace-expansion');
    expect(packageLock.packages[''].devDependencies['brace-expansion']).toBe(
      packageJson.devDependencies['brace-expansion'],
    );
    expect(packageLock.packages[''].version).toBe(packageJson.version);
    expect(packageLock.packages.server.version).toBe(serverPackageJson.version);
    expect(packageLock.packages['third_party/brace-expansion-compat'].version).toBe(
      '5.0.12',
    );
    expect(require(path.join(compatRoot, 'package.json')).version).toBe('5.0.12');
    expect(provenance.upstreamVersion).toBe('5.0.12');
    expect(braceEntries).toEqual([
      [
        'node_modules/brace-expansion',
        {
          resolved: 'third_party/brace-expansion-compat',
          link: true,
        },
      ],
    ]);
  });
});

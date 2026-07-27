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
    'brace-expansion-5.0.8-compat.json',
  ),
);

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function minimatchFunction(api) {
  if (typeof api === 'function') return api;
  if (typeof api?.minimatch === 'function') return api.minimatch;
  throw new TypeError('installed minimatch has no callable API');
}

describe('brace-expansion 5.0.8 compatibility boundary', () => {
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

    expect(esm.default).toBe(esm.expand);
    expect(esm.EXPANSION_MAX).toBe(100_000);
    expect(esm.EXPANSION_MAX_LENGTH).toBe(4_000_000);
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
      '5.0.8',
    );
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

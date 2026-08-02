import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import serverConfig from '../vitest.config';
import rootConfig from '../../vitest.config';

/**
 * Resource policy for the PGlite suites — tested as the RUN sees it, not as a
 * single file claims it.
 *
 * The previous version of this file asserted only that `server/vitest.config.ts`
 * said `maxWorkers: 2`, which is a statement about a file, not about any run.
 * Vitest resolves `maxWorkers`/`poolOptions` from the config of the run and the
 * worker pool is global (there is no per-project worker budget), so the root
 * run — `npm test`, what CI executes — collects `server/**` and governs it with
 * the ROOT config. Asserting only the server file was false protection.
 *
 * Two things are asserted here instead:
 *  1. BOTH entry points that can collect a PGlite suite declare a finite bound,
 *     and the root run really is one of them (it does not exclude `server/**`).
 *  2. The bound is the second line of defence, not the mechanism: every fixture
 *     that boots a PGlite must release it when the test ends. Without this,
 *     a file with N tests keeps N WASM PostgreSQL runtimes resident until the
 *     file finishes, times the number of parallel workers.
 */

const SERVER_SRC = path.dirname(fileURLToPath(import.meta.url));

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

describe('server Vitest resource policy', () => {
  it('bounds PGlite concurrency on every run that can collect these suites', () => {
    // Standalone run (`vitest run --root server`).
    expect(serverConfig.test).toMatchObject({
      environment: 'node',
      hookTimeout: 15_000,
      maxWorkers: 2,
      testTimeout: 15_000,
    });
    // Repository run (`npm test` at the root == CI). The server config does not
    // reach it, so the root bound is the operative one and must exist and stay
    // finite.
    expect(typeof rootConfig.test?.maxWorkers).toBe('number');
    expect(rootConfig.test?.maxWorkers as number).toBeGreaterThan(0);
    expect(rootConfig.test?.maxWorkers as number).toBeLessThanOrEqual(4);
    expect(rootConfig.test?.hookTimeout).toBe(15_000);
    expect(rootConfig.test?.testTimeout).toBe(15_000);
  });

  it('root run really does collect the server suites (so its bound is the operative one)', () => {
    const excluded = (rootConfig.test?.exclude ?? []) as readonly string[];
    expect(
      excluded.some((pattern) => pattern.replaceAll('\\', '/').includes('server/')),
    ).toBe(false);
  });

  it('every PGlite fixture releases its WASM PostgreSQL when the test ends', () => {
    const scanner = fileURLToPath(import.meta.url);
    const offenders = listSourceFiles(SERVER_SRC)
      // The scanner quotes the very patterns it looks for.
      .filter((file) => file !== scanner)
      .filter((file) => fs.readFileSync(file, 'utf8').includes('new PGlite('))
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        const boots = source.match(/new PGlite\(/g)?.length ?? 0;
        const releases = source.match(/\.close\(\)/g)?.length ?? 0;
        return releases < boots;
      })
      .map((file) => path.relative(SERVER_SRC, file));
    expect(offenders).toEqual([]);
  });
});

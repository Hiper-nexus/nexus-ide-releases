import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.claude/**',
      // Runtime worktrees contain full project copies, including their tests.
      // Collecting them runs stale suites multiple times and may load native
      // modules built for another Node/Electron ABI.
      '.dev-user-data/**',
      '.dev-user-data.bak-*/**',
      '.dev-user-data-qa/**',
      // Vendored skill suites (archify) run under their own `node --test`
      // runner (see assets/skills/archify/package.json), not under vitest.
      'assets/**',
    ],
    setupFiles: ['./src/test/vitest.setup.ts'],
    // The root run also collects server PGlite suites, and `server/vitest.config.ts`
    // does NOT apply to it: Vitest resolves `maxWorkers`/`poolOptions` from the
    // config of the run, and the worker pool is global — there is no per-project
    // worker budget to inherit. This number is therefore the ONLY concurrency
    // bound the server suites get under `npm test` (what CI runs), so keep it
    // finite: WASM Postgres, OCR and Electron imports must not starve one
    // another. Asserted by server/src/vitest-resource-policy.test.ts.
    hookTimeout: 15_000,
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});

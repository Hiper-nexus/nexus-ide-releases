import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.claude/**',
      // Vendored skill suites (archify) run under their own `node --test`
      // runner (see assets/skills/archify/package.json), not under vitest.
      'assets/**',
    ],
    setupFiles: ['./src/test/vitest.setup.ts'],
    // The root run also collects server PGlite suites. Keep concurrency finite
    // so WASM Postgres, OCR and Electron imports do not starve one another.
    hookTimeout: 15_000,
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});

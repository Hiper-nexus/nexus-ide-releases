import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // PGlite starts a WASM PostgreSQL runtime per fixture. Unbounded workers
    // starve each other on two-core CI runners and create false 5s timeouts.
    hookTimeout: 15_000,
    maxWorkers: 2,
    testTimeout: 15_000,
  },
});

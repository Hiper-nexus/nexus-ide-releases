import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // PGlite starts a WASM PostgreSQL runtime per fixture. Unbounded workers
    // starve each other on two-core CI runners and create false 5s timeouts.
    //
    // Scope of this bound, stated honestly: Vitest resolves `maxWorkers` (and
    // `poolOptions`) from the config of the RUN — the worker pool is global,
    // there is no per-project worker budget. So this number only governs a
    // standalone server run (`vitest run --root server`, or `npm test` inside
    // server/). The repository run (`npm test` at the root, which is what CI
    // executes) collects `server/**` too and governs it with the ROOT config's
    // `maxWorkers`. Both are asserted by src/vitest-resource-policy.test.ts.
    //
    // The bound is therefore a second line of defence, not the mechanism that
    // keeps PGlite pressure finite: that mechanism is every fixture closing
    // its client when the test ends (see the same policy test).
    hookTimeout: 15_000,
    maxWorkers: 2,
    testTimeout: 15_000,
  },
});

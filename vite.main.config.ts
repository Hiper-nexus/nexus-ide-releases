import { createRequire } from 'node:module';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);

// Main process bundle. Native modules are marked external so they are required
// straight from node_modules (dev) / app.asar.unpacked (prod) instead of being
// pulled into the Rollup graph, which would break the .node binaries.
export default defineConfig({
  build: {
    rollupOptions: {
      // uiohook-napi / onnxruntime-node are OPTIONAL native modules for voice
      // (PTT keyup + Silero VAD). They may not be installed; marking them external
      // keeps them out of the Rollup graph so the build never tries to resolve
      // them — a runtime require() in a try/catch handles their absence.
      external: [
        '@lydell/node-pty',
        'better-sqlite3',
        'uiohook-napi',
        'onnxruntime-node',
      ],
    },
  },
  resolve: {
    // tslib must bypass its exports map: the node+import condition resolves to
    // modules/index.js, which destructures the CJS default export — rolldown's
    // interop leaves .default undefined (tslib.js sets __esModule), crashing the
    // packaged app at startup. All deps use named imports, so the pure-ESM build
    // is a drop-in.
    alias: {
      tslib: require.resolve('tslib/tslib.es6.mjs'),
    },
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});

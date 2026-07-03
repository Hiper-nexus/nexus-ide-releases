import { defineConfig } from 'vite';

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
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});

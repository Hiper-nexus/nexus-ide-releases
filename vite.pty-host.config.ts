import { defineConfig } from 'vite';

// PTY host utilityProcess bundle (docs/ARCHITECTURE.md §B.2). Built as a second
// main-target entry so it lands beside main.js at `.vite/build/pty-host-entry.js`.
// @lydell/node-pty is external — required straight from node_modules (dev) /
// app.asar.unpacked (prod), exactly like the main bundle, so its .node binary
// is never pulled into the Rollup graph.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['@lydell/node-pty'],
    },
  },
  resolve: {
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});

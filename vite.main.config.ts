import { defineConfig } from 'vite';

// Main process bundle. Native modules are marked external so they are required
// straight from node_modules (dev) / app.asar.unpacked (prod) instead of being
// pulled into the Rollup graph, which would break the .node binaries.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['@lydell/node-pty', 'better-sqlite3'],
    },
  },
  resolve: {
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});

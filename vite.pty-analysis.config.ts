import { defineConfig } from 'vite';
/** Dedicated Worker sibling. Only pure reducers; no Electron or native addon. */
export default defineConfig({
  build: { rollupOptions: { input: 'src/main/pty/pty-analysis-worker-entry.ts', external: [/^node:/, 'electron'], output: { format: 'cjs', entryFileNames: 'pty-analysis-worker-entry.js' } } },
});

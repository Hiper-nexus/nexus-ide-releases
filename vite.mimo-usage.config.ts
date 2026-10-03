import { defineConfig } from 'vite';
/** SQLite stays external and runs only in this dedicated Main sibling worker. */
export default defineConfig({
  build: { rollupOptions: { input: 'src/main/usage/mimo-usage-worker-entry.ts',
    external: [/^node:/, 'better-sqlite3'],
    output: { format: 'cjs', entryFileNames: 'mimo-usage-worker-entry.js' } } },
});

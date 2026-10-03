import { defineConfig } from 'vite';
export default defineConfig({ build: { rollupOptions: { input: 'scripts/f764/regex-adversarial-worker.ts', external: [/^node:/, 'typescript'], output: { format: 'cjs', entryFileNames: 'regex-adversarial-worker.cjs' } } } });

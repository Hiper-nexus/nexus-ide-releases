import path from 'node:path';
import { build } from 'vite';
import { configureMimoUsageWorkerPath } from '../mimo-worker-reader';

/** Test-only real bundle; its ancestor node_modules resolves the Node22 addon. */
export async function prepareMimoWorker(): Promise<string> {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: '.vite/mimo-worker-test',
    rollupOptions: { input: 'src/main/usage/mimo-usage-worker-entry.ts', external: [/^node:/, 'better-sqlite3'],
      output: { format: 'cjs', entryFileNames: 'mimo-usage-worker-entry.js' } } } });
  const file = path.resolve('.vite/mimo-worker-test/mimo-usage-worker-entry.js');
  configureMimoUsageWorkerPath(file); return file;
}

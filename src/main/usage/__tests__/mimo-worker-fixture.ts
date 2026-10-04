import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { build } from 'vite';
import { configureMimoUsageProcessFactory, configureMimoUsageWorkerPath,
  type MimoProcessFactory } from '../mimo-worker-reader';

/** Test-only adapter. Production uses Electron utilityProcess, with the same CJS entry. */
export const forkMimoFixtureProcess: MimoProcessFactory = (entry, privateRoot) => {
  const child = fork(path.resolve('.vite/mimo-worker-test/node-port.cjs'), [entry, privateRoot], {
    execPath: process.execPath, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return {
    postMessage: message => { child.send(message); },
    on: (event: string, listener: (...args: any[]) => void) => child.on(event === 'exit' ? 'close' : event, listener),
    terminate: () => child.kill('SIGKILL'),
  };
};
/** Real bundle; its ancestor node_modules resolves the existing Node22 addon. */
export async function prepareMimoWorker(): Promise<string> {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: '.vite/mimo-worker-test',
    rollupOptions: { input: 'src/main/usage/mimo-usage-worker-entry.ts', external: [/^node:/, 'better-sqlite3'],
      output: { format: 'cjs', entryFileNames: 'mimo-usage-worker-entry.js' } } } });
  fs.writeFileSync('.vite/mimo-worker-test/node-port.cjs', `process.parentPort = {
    on: (event, listener) => process.on(event, data => listener({ data })),
    postMessage: message => process.send(message)
  }; const entry = process.argv[2]; process.argv.splice(1, 1); require(entry);`);
  const file = path.resolve('.vite/mimo-worker-test/mimo-usage-worker-entry.js');
  configureMimoUsageWorkerPath(file); configureMimoUsageProcessFactory(forkMimoFixtureProcess); return file;
}

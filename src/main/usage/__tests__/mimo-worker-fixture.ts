import fs from 'node:fs';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { build } from 'vite';
import { configureMimoUsageProcessFactory, configureMimoUsageWorkerPath,
  type MimoProcessFactory, type MimoReaderProcess } from '../mimo-worker-reader';

const forkPort = (args: string[]): ChildProcess => fork(path.resolve('.vite/mimo-worker-test/node-port.cjs'), args, {
  execPath: process.execPath, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
const ownPort = (child: ChildProcess): MimoReaderProcess => ({
  postMessage: message => { child.send(message); },
  on: (event: string, listener: (...args: any[]) => void) => child.on(event === 'exit' ? 'close' : event, listener),
  terminate: () => child.kill('SIGKILL'),
});
/** Test-only adapter. Production uses Electron utilityProcess, with the same CJS entry. */
export const forkMimoFixtureProcess: MimoProcessFactory = (entry, privateRoot) => ownPort(forkPort([entry, privateRoot]));
/**
 * Boots the host Node runtime before a reader owns it, so a short read deadline
 * measures the production entry, addon, snapshot and SQL, not host process
 * start-up (60-110 ms on a loaded host). One adoption; a respawn throws.
 */
export async function bootMimoFixtureProcess(): Promise<MimoProcessFactory> {
  const child = forkPort([]);
  await new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('exit', () => reject(new Error('MiMo fixture runtime exited during boot')));
  });
  let adopted = false;
  return (entry, privateRoot) => {
    if (adopted) throw new Error('MiMo fixture runtime already adopted');
    adopted = true; child.send({ entry, privateRoot }); return ownPort(child);
  };
}
/** Real bundle; its ancestor node_modules resolves the existing Node22 addon. */
export async function prepareMimoWorker(): Promise<string> {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: '.vite/mimo-worker-test',
    rollupOptions: { input: 'src/main/usage/mimo-usage-worker-entry.ts', external: [/^node:/, 'better-sqlite3'],
      output: { format: 'cjs', entryFileNames: 'mimo-usage-worker-entry.js' } } } });
  fs.writeFileSync('.vite/mimo-worker-test/node-port.cjs', `process.parentPort = {
    on: (event, listener) => process.on(event, data => listener({ data })),
    postMessage: message => process.send(message)
  }; const start = (entry, privateRoot) => { process.argv.splice(1, Infinity, entry, privateRoot); require(entry); };
  if (process.argv[2]) start(process.argv[2], process.argv[3]);
  else { process.once('message', ({ entry, privateRoot }) => start(entry, privateRoot)); process.send('ready'); }`);
  const file = path.resolve('.vite/mimo-worker-test/mimo-usage-worker-entry.js');
  configureMimoUsageWorkerPath(file); configureMimoUsageProcessFactory(forkMimoFixtureProcess); return file;
}

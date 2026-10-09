import fs from 'node:fs';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { build } from 'vite';
import { afterAll } from 'vitest';
import { removeTreeSync } from '../../util/remove-tree';
import { configureMimoUsageProcessFactory, configureMimoUsageWorkerPath,
  type MimoProcessFactory, type MimoReaderProcess } from '../mimo-worker-reader';

const prepared = new Map<string, { directory: string; launcher: string }>();
const children = new Map<ChildProcess, Promise<void>>();
// Consumers stop their readers in afterEach; also close an unadopted boot on failure.
afterAll(async () => {
  await Promise.all([...children].map(([child, closed]) => { child.kill('SIGKILL'); return closed; }));
  for (const fixture of prepared.values()) removeTreeSync(fixture.directory, { force: true });
  prepared.clear();
});
const forkPort = (launcher: string, args: string[]): ChildProcess => {
  const child = fork(launcher, args, {
    execPath: process.execPath, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.set(child, new Promise<void>(resolve => child.once('close', () => { children.delete(child); resolve(); })));
  return child;
};
function fixtureLauncher(entry: string): string {
  const fixture = prepared.get(entry);
  if (!fixture) throw new Error('MiMo fixture entry was not prepared');
  return fixture.launcher;
}
const ownPort = (child: ChildProcess): MimoReaderProcess => ({
  postMessage: message => { child.send(message); },
  on: (event: string, listener: (...args: any[]) => void) => child.on(event === 'exit' ? 'close' : event, listener),
  terminate: () => child.kill('SIGKILL'),
});
/** Test-only adapter. Production uses Electron utilityProcess, with the same CJS entry. */
export function forkMimoFixtureProcess(entry: string, privateRoot: string, preparedEntry: string): MimoReaderProcess {
  return ownPort(forkPort(fixtureLauncher(preparedEntry), [entry, privateRoot]));
}
/**
 * Boots the host Node runtime before a reader owns it, so a short read deadline
 * measures the production entry, addon, snapshot and SQL, not host process
 * start-up (60-110 ms on a loaded host). One adoption; a respawn throws.
 */
export async function bootMimoFixtureProcess(preparedEntry: string): Promise<MimoProcessFactory> {
  const launcher = fixtureLauncher(preparedEntry);
  const child = forkPort(launcher, []);
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
  const outputRoot = path.resolve('.vite'); fs.mkdirSync(outputRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(outputRoot, 'mimo-worker-test-'));
  const file = path.join(directory, 'mimo-usage-worker-entry.js');
  const launcher = path.join(directory, 'node-port.cjs');
  prepared.set(file, { directory, launcher });
  const processFactory: MimoProcessFactory = (entry, privateRoot) => ownPort(forkPort(launcher, [entry, privateRoot]));
  await build({ configFile: false, logLevel: 'silent', build: { outDir: directory,
    rollupOptions: { input: 'src/main/usage/mimo-usage-worker-entry.ts', external: [/^node:/, 'better-sqlite3'],
      output: { format: 'cjs', entryFileNames: 'mimo-usage-worker-entry.js' } } } });
  fs.writeFileSync(launcher, `process.parentPort = {
    on: (event, listener) => process.on(event, data => listener({ data })),
    postMessage: message => process.send(message)
  }; const start = (entry, privateRoot) => { process.argv.splice(1, Infinity, entry, privateRoot); require(entry); };
  if (process.argv[2]) start(process.argv[2], process.argv[3]);
  else { process.once('message', ({ entry, privateRoot }) => start(entry, privateRoot)); process.send('ready'); }`);
  configureMimoUsageWorkerPath(file); configureMimoUsageProcessFactory(processFactory); return file;
}

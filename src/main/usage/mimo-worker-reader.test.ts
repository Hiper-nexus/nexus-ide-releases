import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { forkMimoFixtureProcess, prepareMimoWorker } from './__tests__/mimo-worker-fixture';
import { MimoWorkerReader } from './mimo-worker-reader';
let root: string;
const readers: MimoWorkerReader[] = [];
let nativeEntry: string;
beforeAll(async () => { nativeEntry = await prepareMimoWorker(); });
afterEach(async () => {
  await Promise.all(readers.splice(0).map(reader => reader.stop()));
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
const input = { kind: 'validate' as const, rootId: 'root', runtime: {
  checkoutId: 'checkout', cwd: '/fixture', stateRoot: '/fixture/mimo-code/checkout',
  databasePath: '/fixture/mimo-code/checkout/database/mimocode.db' } };

it('stop physically terminates an in-flight worker, drains queued requests, and prevents new admission', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-worker-stop-'));
  const entry = path.join(root, 'blocked.cjs'); const marker = path.join(root, 'started');
  fs.writeFileSync(entry, `const parentPort = process.parentPort;
    parentPort.on('message', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });`);
  const reader = new MimoWorkerReader({ workerPath: entry }); readers.push(reader);
  const running = reader.read(input); const queued = reader.read(input);
  await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
  const stopping = reader.stop();
  expect(reader.stop()).toBe(stopping);
  await stopping;
  expect(await running).toBeNull(); expect(await queued).toBeNull();
  expect(await reader.read(input)).toBeNull();
});

it('timeout waits for worker exit before making the same reader available again', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-worker-timeout-'));
  const entry = path.join(root, 'blocked.cjs');
  fs.writeFileSync(entry, `const parentPort = process.parentPort;
    parentPort.on('message', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));`);
  const reader = new MimoWorkerReader({ workerPath: entry, timeoutMs: 100 }); readers.push(reader);
  expect(await reader.read(input)).toBeNull();
  expect(await reader.read(input)).toBeNull();
  await reader.stop();
});

it.each(['timeout', 'stop'] as const)('physically stops a pathological SQLite view via %s without waiting for sqlite3_step', async mode => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-native-deadline-')));
  const stateRoot = path.join(root, 'mimo-code', 'checkout');
  fs.mkdirSync(path.join(stateRoot, 'database'), { recursive: true });
  const databasePath = path.join(stateRoot, 'database', 'mimocode.db');
  const db = new Database(databasePath);
  db.exec('CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT)');
  db.prepare('INSERT INTO session VALUES (?, ?, NULL)').run('ses_root', root);
  // A finite owned fixture makes RED safe even with the old uninterruptible worker.
  db.exec(`CREATE VIEW message AS WITH RECURSIVE c(x) AS
    (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x<5000000)
    SELECT printf('msg-%08d', x) AS id, 'ses_root' AS session_id,
      x AS time_updated, '{}' AS data FROM c`);
  db.close();
  const before = fs.readFileSync(databasePath);
  let exited = false;
  const reader = new MimoWorkerReader({ workerPath: nativeEntry, timeoutMs: 100,
    processFactory: (entry, privateRoot) => { const child = forkMimoFixtureProcess(entry, privateRoot);
      child.on('exit', () => { exited = true; }); return child; } }); readers.push(reader);
  const runtime = { checkoutId: 'checkout', cwd: root, stateRoot, databasePath };
  expect((await reader.read({ kind: 'validate', rootId: 'ses_root', runtime }))?.valid).toBe(true);
  const started = performance.now();
  const running = reader.read({ kind: 'scan', rootId: 'ses_root', runtime });
  const stopTimer = mode === 'stop' ? setTimeout(() => { void reader.stop(); }, 50) : undefined;
  try { expect(await running).toBeNull(); } finally { clearTimeout(stopTimer); }
  expect(performance.now() - started).toBeLessThan(400);
  expect(exited).toBe(true);
  await reader.stop();
  expect(fs.readFileSync(databasePath).equals(before)).toBe(true);
}, 10_000);

it('retains physical proof when signalling fails and retries the same owned child', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-kill-retry-'));
  const entry = path.join(root, 'blocked.cjs'); const marker = path.join(root, 'started');
  fs.writeFileSync(entry, `process.parentPort.on('message', () => {
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });`);
  let attempts = 0; let exited = false;
  const reader = new MimoWorkerReader({ workerPath: entry, processFactory: (file, privateRoot) => {
    const child = forkMimoFixtureProcess(file, privateRoot); child.on('exit', () => { exited = true; });
    return { ...child, terminate: () => ++attempts === 1 ? false : child.terminate() };
  } }); readers.push(reader);
  let settled = false; const running = reader.read(input).then(value => { settled = true; return value; });
  await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
  const stopping = reader.stop();
  expect(attempts).toBe(1); expect(settled).toBe(false); expect(exited).toBe(false);
  expect(reader.stop()).toBe(stopping);
  await stopping;
  expect(await running).toBeNull(); expect(exited).toBe(true); expect(attempts).toBeGreaterThan(1);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MimoWorkerReader } from './mimo-worker-reader';
let root: string;
const readers: MimoWorkerReader[] = [];
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
  fs.writeFileSync(entry, `const { parentPort } = require('node:worker_threads');
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
  fs.writeFileSync(entry, `const { parentPort } = require('node:worker_threads');
    parentPort.on('message', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));`);
  const reader = new MimoWorkerReader({ workerPath: entry, timeoutMs: 100 }); readers.push(reader);
  expect(await reader.read(input)).toBeNull();
  expect(await reader.read(input)).toBeNull();
  await reader.stop();
});

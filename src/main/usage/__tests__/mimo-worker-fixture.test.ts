import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

const overlap = vi.hoisted(() => ({ pause: null as null | { reached(): void; released: Promise<void> } }));
vi.mock('vite', async importOriginal => {
  const actual = await importOriginal<typeof import('vite')>();
  return { ...actual, build: (config: import('vite').InlineConfig) => {
    const pause = overlap.pause;
    // Keep the build real; generateBundle is awaited after Vite empties outDir, before writing.
    return actual.build(pause ? { ...config, plugins: [config.plugins, {
      name: 'mimo-fixture-build-overlap',
      generateBundle: { order: 'post', handler: async () => { pause.reached(); await pause.released; } },
    }] } : config);
  } };
});
import { prepareMimoWorker } from './mimo-worker-fixture';
import { MimoWorkerReader } from '../mimo-worker-reader';
import { removeTreeSync } from '../../util/remove-tree';

let root = '';
const readers: MimoWorkerReader[] = [];
afterEach(async () => {
  await Promise.all(readers.splice(0).map(reader => reader.stop()));
  overlap.pause = null;
  if (root) removeTreeSync(root, { force: true });
});

it('keeps a prepared native worker usable while another real build empties its output', async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-fixture-overlap-')));
  const stateRoot = path.join(root, 'mimo-code', 'checkout');
  fs.mkdirSync(path.join(stateRoot, 'database'), { recursive: true });
  const databasePath = path.join(stateRoot, 'database', 'mimocode.db');
  const db = new Database(databasePath);
  try {
    db.exec('CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_updated INTEGER, data TEXT)');
    db.prepare('INSERT INTO session VALUES (?, ?, NULL)').run('ses_root', root);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg-one', 'ses_root', 1, JSON.stringify({
      role: 'assistant', modelID: 'mimo-v2.6-flash', providerID: 'xiaomi', path: { cwd: root },
      time: { created: 100 }, cost: 0.02,
      tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 5, write: 0 } },
    }));
  } finally { db.close(); }
  const entry = await prepareMimoWorker();
  const launcher = path.join(path.dirname(entry), 'node-port.cjs');
  expect(fs.existsSync(entry)).toBe(true); expect(fs.existsSync(launcher)).toBe(true);
  // The reader must retain this preparation's factory before the second build starts.
  const reader = new MimoWorkerReader({ workerPath: entry }); readers.push(reader);
  let reached!: () => void; let release!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  overlap.pause = { reached, released };
  const secondBuild = prepareMimoWorker();
  try {
    await Promise.race([paused, secondBuild.then(() => { throw new Error('Second build did not pause before writing'); })]);
    const filesAtPause = { entry: fs.existsSync(entry), launcher: fs.existsSync(launcher) };
    const reply = await reader.read({ kind: 'scan', rootId: 'ses_root',
      runtime: { checkoutId: 'checkout', cwd: root, stateRoot, databasePath } });
    expect({ filesAtPause, reply }).toMatchObject({ filesAtPause: { entry: true, launcher: true },
      reply: { valid: true, fetched: 1, events: [{
      sessionId: 'ses_root', messageId: 'msg-one', model: 'xiaomi/mimo-v2.6-flash', inputTokens: 10,
      outputTokens: 5, cacheReadTokens: 5, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
      timestamp: 100, nativeUpdatedAt: 1, reportedCostUsd: 0.02,
    }] } });
  } finally { release(); await secondBuild; }
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { stopMimoValidationReader } from './mimo-worker-reader';
import { prepareMimoWorker } from './__tests__/mimo-worker-fixture';
import { MimoUsageScanner, validateMimoRootSession, type MimoSessionBinding } from './mimo-scanner';

const roots: string[] = [];
const databases: Database.Database[] = [];
const scanners: MimoUsageScanner[] = [];
beforeAll(prepareMimoWorker);
function fixture(checkoutId = 'checkout-a') {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-scanner-')));
  roots.push(home);
  const cwd = path.join(home, 'project'); fs.mkdirSync(cwd);
  const stateRoot = path.join(home, 'provider-state', 'mimo-code', checkoutId);
  fs.mkdirSync(path.join(stateRoot, 'database'), { recursive: true });
  const databasePath = path.join(stateRoot, 'database', 'mimocode.db');
  const db = new Database(databasePath); databases.push(db);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_updated INTEGER, data TEXT)');
  db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses_root', cwd, null);
  db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses_child', cwd, 'ses_root');
  db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses_other', cwd, null);
  const binding: MimoSessionBinding = {
    ptySessionId: 'pty-a', paneId: 'pane-a', accountId: 'account-a', cwd, stateRoot, databasePath,
    providerSessionId: 'ses_root',
    scope: { version: 1, installationId: 'install-a', projectId: 'project-a', checkoutId,
      rootRealPath: cwd, identitySource: 'manifest' },
  };
  function message(id: string, sessionId: string, output: number, updated = 1, messageCwd = cwd) {
    db.prepare('INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?)').run(id, sessionId, updated, JSON.stringify({
      role: 'assistant', modelID: 'mimo-v2.6-flash', providerID: 'xiaomi', path: { cwd: messageCwd },
      time: { created: 100 }, cost: output / 100, tokens: { input: 10, output, reasoning: 3, cache: { read: 5, write: 0 } },
    }));
  }
  return { db, binding, message };
}
afterEach(async () => {
  await Promise.all(scanners.splice(0).map(scanner => scanner.stop()));
  await stopMimoValidationReader();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('MiMo checkout database reader', () => {
  it('never runs native SQLite prepare on the Main scanner turn', async () => {
    const { binding, message } = fixture(); message('msg-main-proof', 'ses_root', 3);
    const onEvent = vi.fn(); const scanner = new MimoUsageScanner(onEvent);
    scanner.bind(binding);
    const prepare = vi.spyOn(Database.prototype, 'prepare');
    try {
      await scanner.scan();
      expect(prepare).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledTimes(1);
    } finally { prepare.mockRestore(); await scanner.stop(); }
  });
  it('keeps Main timers alive while scanning a real unindexed 100000-row native database', async () => {
    const { db, binding } = fixture();
    const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
    const data = JSON.stringify({ role: 'assistant', modelID: 'mimo-v2.6-flash', providerID: 'xiaomi',
      path: { cwd: binding.cwd }, time: { created: 100 }, cost: 0.01,
      tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 5, write: 0 } }, privateText: 'never crosses worker boundary' });
    db.transaction(() => { for (let i = 0; i < 100_000; i++) insert.run(`msg-${String(i).padStart(6, '0')}`, 'ses_child', i + 1, data); })();
    const before = fs.readFileSync(binding.databasePath);
    const onEvent = vi.fn(); const scanner = new MimoUsageScanner(onEvent); scanners.push(scanner);
    scanner.bind(binding);
    let beats = 0; const probe = setInterval(() => beats++, 1);
    try {
      await scanner.scan();
      expect(beats).toBeGreaterThan(0);
      expect(onEvent).toHaveBeenCalledTimes(128);
      expect(JSON.stringify(onEvent.mock.calls.map(([, event]) => event))).not.toContain('privateText');
      expect(fs.readFileSync(binding.databasePath).equals(before)).toBe(true);
    } finally { clearInterval(probe); await scanner.stop(); }
  }, 30_000);
  it('accepts only an exact root session in the authorized cwd', async () => {
    const { db, binding } = fixture();
    expect(await validateMimoRootSession(binding, 'ses_root')).toBe(true);
    expect(await validateMimoRootSession(binding, 'ses_child')).toBe(false);
    expect(await validateMimoRootSession(binding, 'missing')).toBe(false);
    db.prepare('UPDATE session SET directory=? WHERE id=?').run(os.tmpdir(), 'ses_root');
    expect(await validateMimoRootSession(binding, 'ses_root')).toBe(false);
  });

  it('reaches valid usage after a full page of unrepresentable native message IDs', async () => {
    const { db, binding, message } = fixture();
    for (let i = 1; i <= 128; i++) message(`${'x'.repeat(257)}-${i}`, 'ses_root', 99, i);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(Buffer.from('blob-id'), 'ses_root', 129, '{}');
    message('msg-reachable', 'ses_root', 7, 130);
    const onEvent = vi.fn(); const scanner = new MimoUsageScanner(onEvent); scanners.push(scanner);
    scanner.bind(binding); await scanner.scan(); await scanner.scan();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][1]).toMatchObject({ messageId: 'msg-reachable', outputTokens: 10 });
  });

  it('reads root and child usage without attributing a neighboring pane, and notices streaming rewrites', async () => {
    const { binding, message } = fixture();
    message('msg-root', 'ses_root', 2); message('msg-child', 'ses_child', 4); message('msg-other', 'ses_other', 99);
    const onEvent = vi.fn();
    const scanner = new MimoUsageScanner(onEvent);
    scanners.push(scanner); scanner.bind(binding); await scanner.scan();
    expect(onEvent.mock.calls.map(([, event]) => event.messageId)).toEqual(['msg-child', 'msg-root']);
    await scanner.scan(); expect(onEvent).toHaveBeenCalledTimes(2);
    message('msg-root', 'ses_root', 8, 2); await scanner.scan();
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent.mock.calls[2][1]).toMatchObject({ messageId: 'msg-root', outputTokens: 11, reportedCostUsd: 0.08 });
    await scanner.stop();
  });

  it('arms the 1s poll only while there is work and disarms it when idle', async () => {
    const { binding } = fixture();
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const armed: ReturnType<typeof setInterval>[] = [];
    const cleared: ReturnType<typeof setInterval>[] = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      const timer = realSetInterval(fn, ms); armed.push(timer); return timer;
    }) as typeof setInterval);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((timer?: ReturnType<typeof setInterval>) => {
      if (timer) cleared.push(timer); realClearInterval(timer);
    }) as typeof clearInterval);
    try {
      const onEvent = vi.fn();
      const scanner = new MimoUsageScanner(onEvent); scanners.push(scanner);
      scanner.start();
      expect(armed).toHaveLength(0);
      scanner.bind(binding);
      expect(armed).toHaveLength(1);
      await scanner.scan();
      expect(armed).toHaveLength(1);
      expect(cleared).toHaveLength(0);
      scanner.remove(binding.ptySessionId);
      await scanner.scan();
      expect(armed).toHaveLength(1);
      expect(cleared).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('refuses database symlink swaps and does not follow another checkout', async () => {
    const { db, binding } = fixture(); const other = fixture('checkout-b');
    db.close(); databases.splice(databases.indexOf(db), 1);
    fs.unlinkSync(binding.databasePath); fs.symlinkSync(other.binding.databasePath, binding.databasePath);
    expect(await validateMimoRootSession(binding, 'ses_root')).toBe(false);
  });

  it('flushes the previous exact conversation before /new switches the pane binding', async () => {
    const { binding, message } = fixture(); const onEvent = vi.fn();
    const scanner = new MimoUsageScanner(onEvent); scanner.bind(binding);
    scanners.push(scanner);
    message('msg-last', 'ses_root', 17);
    message('msg-after-retirement', 'ses_root', 99, Date.now() + 60_000);
    scanner.bind({ ...binding, providerSessionId: 'ses_other' });
    await scanner.scan();
    expect(onEvent).toHaveBeenCalledWith(binding, expect.objectContaining({ messageId: 'msg-last', outputTokens: 20 }));
    expect(onEvent.mock.calls.map(([, event]) => event.messageId)).not.toContain('msg-after-retirement');
    await scanner.stop();
  });

  it('includes a descendant in the CLI-owned checkout worktree but rejects a foreign checkout', async () => {
    const { binding, message } = fixture();
    const isolated = path.join(binding.stateRoot, 'worktree', 'project'); fs.mkdirSync(isolated, { recursive: true });
    message('msg-isolated', 'ses_child', 5, 1, isolated);
    message('msg-foreign', 'ses_child', 99, 1, os.tmpdir());
    const onEvent = vi.fn(); const scanner = new MimoUsageScanner(onEvent);
    scanners.push(scanner); scanner.bind(binding); await scanner.scan();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][1].messageId).toBe('msg-isolated');
    await scanner.stop();
  });
});

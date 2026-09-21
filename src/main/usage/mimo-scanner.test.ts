import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MimoUsageScanner, validateMimoRootSession, type MimoSessionBinding } from './mimo-scanner';

const roots: string[] = [];
const databases: Database.Database[] = [];
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
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('MiMo checkout database reader', () => {
  it('accepts only an exact root session in the authorized cwd', () => {
    const { db, binding } = fixture();
    expect(validateMimoRootSession(binding, 'ses_root')).toBe(true);
    expect(validateMimoRootSession(binding, 'ses_child')).toBe(false);
    expect(validateMimoRootSession(binding, 'missing')).toBe(false);
    db.prepare('UPDATE session SET directory=? WHERE id=?').run(os.tmpdir(), 'ses_root');
    expect(validateMimoRootSession(binding, 'ses_root')).toBe(false);
  });

  it('reads root and child usage without attributing a neighboring pane, and notices streaming rewrites', () => {
    const { binding, message } = fixture();
    message('msg-root', 'ses_root', 2); message('msg-child', 'ses_child', 4); message('msg-other', 'ses_other', 99);
    const onEvent = vi.fn();
    const scanner = new MimoUsageScanner(onEvent);
    scanner.bind(binding); scanner.scan();
    expect(onEvent.mock.calls.map(([, event]) => event.messageId)).toEqual(['msg-child', 'msg-root']);
    scanner.scan(); expect(onEvent).toHaveBeenCalledTimes(2);
    message('msg-root', 'ses_root', 8, 2); scanner.scan();
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent.mock.calls[2][1]).toMatchObject({ messageId: 'msg-root', outputTokens: 11, reportedCostUsd: 0.08 });
    scanner.stop();
  });

  it('refuses database symlink swaps and does not follow another checkout', () => {
    const { db, binding } = fixture(); const other = fixture('checkout-b');
    db.close(); databases.splice(databases.indexOf(db), 1);
    fs.unlinkSync(binding.databasePath); fs.symlinkSync(other.binding.databasePath, binding.databasePath);
    expect(validateMimoRootSession(binding, 'ses_root')).toBe(false);
  });

  it('flushes the previous exact conversation before /new switches the pane binding', () => {
    const { binding, message } = fixture(); const onEvent = vi.fn();
    const scanner = new MimoUsageScanner(onEvent); scanner.bind(binding);
    message('msg-last', 'ses_root', 17);
    scanner.bind({ ...binding, providerSessionId: 'ses_other' });
    expect(onEvent).toHaveBeenCalledWith(binding, expect.objectContaining({ messageId: 'msg-last', outputTokens: 20 }));
    scanner.stop();
  });

  it('includes a descendant in the CLI-owned checkout worktree but rejects a foreign checkout', () => {
    const { binding, message } = fixture();
    const isolated = path.join(binding.stateRoot, 'worktree', 'project'); fs.mkdirSync(isolated, { recursive: true });
    message('msg-isolated', 'ses_child', 5, 1, isolated);
    message('msg-foreign', 'ses_child', 99, 1, os.tmpdir());
    const onEvent = vi.fn(); const scanner = new MimoUsageScanner(onEvent);
    scanner.bind(binding); scanner.scan();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][1].messageId).toBe('msg-isolated');
    scanner.stop();
  });
});

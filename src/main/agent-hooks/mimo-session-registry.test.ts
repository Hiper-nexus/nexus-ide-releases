import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { prepareMimoWorker } from '../usage/__tests__/mimo-worker-fixture';
import { stopMimoValidationReader } from '../usage/mimo-worker-reader';
const pty = vi.hoisted(() => ({ agents: new Map<string, any>(), exits: new Set<(id: string) => void>() }));
vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (id: string) => pty.agents.get(id),
  tapSessionExit: (cb: (id: string) => void) => { pty.exits.add(cb); return () => pty.exits.delete(cb); },
}));
vi.mock('../persistence/provider-session-store', () => ({ providerSessionAccountIsCompatible: vi.fn(() => true) }));
import { publishMimoSessionBinding, registerMimoRuntime, unregisterMimoRuntime, validateMimoSessionBinding } from './mimo-session-registry';
const roots: string[] = [];
const token = 'b'.repeat(64);
beforeAll(prepareMimoWorker);
afterEach(async () => {
  await stopMimoValidationReader();
  for (const id of pty.agents.keys()) unregisterMimoRuntime(id);
  pty.agents.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('binds each root to one live pane/account, rejects subagents and a changed authority', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-binding-'))); roots.push(root);
  const stateRoot = path.join(root, 'mimo-code', 'checkout-a');
  fs.mkdirSync(path.join(stateRoot, 'database'), { recursive: true });
  const databasePath = path.join(stateRoot, 'database', 'mimocode.db');
  const db = new Database(databasePath);
  db.exec('CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT)');
  for (const [id, parent] of [['root_a', null], ['root_b', null], ['child_a', 'root_a']]) {
    db.prepare('INSERT INTO session VALUES (?, ?, ?)').run(id, root, parent);
  }
  db.close();
  const scope = { version: 1 as const, installationId: 'install', projectId: 'project', checkoutId: 'checkout-a', rootRealPath: root, identitySource: 'manifest' as const };
  for (const id of ['a', 'b']) {
    const agent = { paneId: `pane-${id}`, accountId: `acct-${id}`, scope, cwd: root, adapterId: 'mimo-code' };
    pty.agents.set(id, agent);
    registerMimoRuntime({ ...agent, ptySessionId: id, databasePath, stateRoot }, token);
  }
  expect(await validateMimoSessionBinding('a', 'root_a', 'c'.repeat(64))).toBeNull();
  expect(await validateMimoSessionBinding('a', 'child_a', token)).toBeNull();
  const a = (await validateMimoSessionBinding('a', 'root_a', token))!;
  expect(a.accountId).toBe('acct-a'); publishMimoSessionBinding(a);
  expect(await validateMimoSessionBinding('b', 'root_a', token)).toBeNull();
  expect((await validateMimoSessionBinding('b', 'root_b', token))?.accountId).toBe('acct-b');
  pty.agents.set('a', { ...pty.agents.get('a'), accountId: 'changed' });
  expect(await validateMimoSessionBinding('a', 'root_a', token)).toBeNull();
  pty.agents.set('a', { ...pty.agents.get('a'), accountId: 'acct-a' });
  const pendingAccount = validateMimoSessionBinding('a', 'root_a', token);
  pty.agents.set('a', { ...pty.agents.get('a'), accountId: 'changed-during-worker' });
  expect(await pendingAccount).toBeNull();
  pty.agents.set('a', { ...pty.agents.get('a'), accountId: 'acct-a' });
  const pendingExit = validateMimoSessionBinding('a', 'root_a', token);
  unregisterMimoRuntime('a');
  expect(await pendingExit).toBeNull();
  for (const cb of pty.exits) cb('b');
  expect(await validateMimoSessionBinding('b', 'root_b', token)).toBeNull();
});

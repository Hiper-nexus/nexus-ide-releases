import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { prepareMimoWorker } from '../usage/__tests__/mimo-worker-fixture';
import { stopMimoValidationReader } from '../usage/mimo-worker-reader';
import { MimoUsageScanner } from '../usage/mimo-scanner';
import { noteMimoMissionAuthority } from './mimo-mission-authority';
const pty = vi.hoisted(() => ({ agents: new Map<string, any>(), exits: new Set<(id: string, agent?: any) => void>() }));
vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (id: string) => pty.agents.get(id),
  tapSessionExit: (cb: (id: string) => void) => { pty.exits.add(cb); return () => pty.exits.delete(cb); },
}));
vi.mock('../persistence/provider-session-store', () => ({ providerSessionAccountIsCompatible: vi.fn(() => true) }));
import { isMimoSessionBindingCurrent, publishMimoSessionBinding, registerMimoRuntime, unregisterMimoRuntime,
  validateMimoSessionBinding, resolveMimoUsageBinding, releaseMimoUsageBinding, tapMimoSessionBindings } from './mimo-session-registry';
import { isMimoUsageBindingProved } from './mimo-session-registry';
const roots: string[] = [];
const scanners: MimoUsageScanner[] = [];
const token = 'b'.repeat(64);
beforeAll(prepareMimoWorker);
afterEach(async () => {
  await Promise.all(scanners.splice(0).map(scanner => scanner.stop()));
  await stopMimoValidationReader();
  for (const id of pty.agents.keys()) unregisterMimoRuntime(id);
  pty.agents.clear();
  vi.restoreAllMocks();
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
  pty.agents.set('a', { ...pty.agents.get('a'), missionId: 'mission-adopted' });
  noteMimoMissionAuthority('a', 'mission-adopted');
  expect(isMimoSessionBindingCurrent(a)).toBe(false);
  expect((await validateMimoSessionBinding('a', 'root_a', token))?.missionId).toBe('mission-adopted');
  pty.agents.set('a', { ...pty.agents.get('a'), missionId: undefined });
  noteMimoMissionAuthority('a');
  expect((await validateMimoSessionBinding('a', 'root_a', token))?.missionId).toBeUndefined();
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

it('keeps native message missions across adoption, demotion, rewrites and a final bounded tail', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-mission-timeline-'))); roots.push(root);
  const stateRoot = path.join(root, 'mimo-code', 'checkout-a');
  fs.mkdirSync(path.join(stateRoot, 'database'), { recursive: true });
  const databasePath = path.join(stateRoot, 'database', 'mimocode.db');
  const db = new Database(databasePath);
  db.exec('CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_updated INTEGER, data TEXT)');
  db.prepare('INSERT INTO session VALUES (?, ?, NULL)').run('root_a', root);
  const message = (id: string, created: number, updated: number, output = 2) => {
    db.prepare('INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?)').run(id, 'root_a', updated, JSON.stringify({
      role: 'assistant', providerID: 'xiaomi', modelID: 'mimo-v2.6-flash', path: { cwd: root },
      time: { created }, cost: output / 100, tokens: { input: 1, output, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
  };
  const scope = { version: 1 as const, installationId: 'install', projectId: 'project', checkoutId: 'checkout-a', rootRealPath: root, identitySource: 'manifest' as const };
  const agent = { paneId: 'pane-a', accountId: 'acct-a', scope, cwd: root, adapterId: 'mimo-code' };
  let now = 1_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  pty.agents.set('a', agent);
  registerMimoRuntime({ ...agent, ptySessionId: 'a', stateRoot, databasePath }, token);
  const original = (await validateMimoSessionBinding('a', 'root_a', token))!; publishMimoSessionBinding(original);
  const onEvent = vi.fn(); const scanner = new MimoUsageScanner(onEvent, resolveMimoUsageBinding, releaseMimoUsageBinding);
  scanners.push(scanner);
  const stopTap = tapMimoSessionBindings((id, binding) => { if (binding) scanner.bind(binding); else scanner.remove(id); });
  const transition = (at: number, missionId?: string) => {
    now = at; pty.agents.set('a', { ...agent, missionId }); noteMimoMissionAuthority('a', missionId);
  };
  try {
    message('history', 900, 900); message('before', 1_100, 1_100);
    transition(2_000, 'mission-a'); message('adopted', 2_100, 2_100);
    const adopted = (await validateMimoSessionBinding('a', 'root_a', token))!;
    publishMimoSessionBinding(adopted); await scanner.scan();
    expect(onEvent.mock.calls.map(([binding, event]) => [event.messageId, binding.missionId, binding.historicalUnowned]))
      .toEqual([['history', undefined, true], ['before', undefined, false], ['adopted', 'mission-a', false]]);
    const issued = onEvent.mock.calls[2][0];
    expect(isMimoUsageBindingProved(issued)).toBe(true);
    expect(isMimoUsageBindingProved({ ...issued })).toBe(false);
    transition(4_000); message('demoted', 4_100, 4_100); message('adopted', 2_100, 4_500, 9);
    await scanner.scan();
    expect(onEvent.mock.calls.slice(3).map(([binding, event]) => [event.messageId, binding.missionId]))
      .toEqual([['demoted', undefined], ['adopted', 'mission-a']]);
    transition(6_000, 'mission-b'); message('readopted', 6_100, 6_100); await scanner.scan();
    expect(onEvent.mock.calls.at(-1)?.[0].missionId).toBe('mission-b');
    message('revoked-during-wait', 6_200, 6_200);
    const pendingScope = scanner.scan();
    pty.agents.set('a', { ...agent, missionId: 'mission-b', scope: { ...scope, checkoutId: 'foreign' } });
    await pendingScope;
    expect(onEvent.mock.calls.map(([, event]) => event.messageId)).not.toContain('revoked-during-wait');
    pty.agents.set('a', { ...agent, missionId: 'mission-b' });
    message('final', 6_500, 6_500); now = 7_000;
    const exitedAgent = pty.agents.get('a'); pty.agents.delete('a');
    for (const exit of pty.exits) exit('a', exitedAgent);
    scanner.remove('a');
    message('after-exit', 6_600, 8_000);
    await scanner.scan();
    expect(onEvent.mock.calls.map(([, event]) => event.messageId)).toContain('final');
    expect(onEvent.mock.calls.map(([, event]) => event.messageId)).not.toContain('after-exit');
    expect(resolveMimoUsageBinding(original, 6_500, 6_500)).toBeNull();
    expect(onEvent.mock.calls.every(([, event]) => !('nativeUpdatedAt' in event))).toBe(true);
  } finally { stopTap(); db.close(); }
});

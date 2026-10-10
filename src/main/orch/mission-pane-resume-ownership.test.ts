import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { fork, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { WebContents } from 'electron';
import type { OrchPaneSpawnRequest } from '../../shared/orch-types';

// Only installation DB/license services are redirected. Stores, seals, capture, pending
// request issuance/claim and the final physical authority fence remain real.
const binding = vi.hoisted(() => {
  const fs = process.getBuiltinModule('fs') as typeof import('node:fs');
  const os = process.getBuiltinModule('os') as typeof import('node:os');
  const path = process.getBuiltinModule('path') as typeof import('node:path');
  const nativeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-native-profile-'));
  // Main imports compute artifact/config roots. Isolation precedes those imports,
  // just as the existing real-PTY mission harness isolates HOME before boot.
  const changedKeys = new Set(['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'GIT_CONFIG_NOSYSTEM',
    'USERPROFILE', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CODEX_HOME',
    'KIMI_CODE_HOME', 'MIMO_CODE_HOME', 'OPENCODE_CONFIG_DIR',
    'NODE_OPTIONS', 'BASH_ENV', 'ZDOTDIR', 'NEXUS_PANE_ID', 'NEXUS_PANE_KEY', 'NEXUS_MCP_URL', 'NEXUS_MCP_TOKEN',
    'NEXUS_GATE_TOKEN', 'NEXUS_GATE_URL']);
  for (const key of Object.keys(process.env)) if (key.startsWith('NEXUS_HEAVY_') || key.startsWith('NEXUS_SHIM_')) changedKeys.add(key);
  const previousEnv = [...changedKeys].map(key => [key, process.env[key]] as const);
  for (const key of changedKeys) delete process.env[key];
  process.env.HOME = nativeUserData;
  process.env.XDG_CONFIG_HOME = path.join(nativeUserData, '.config');
  process.env.XDG_CACHE_HOME = path.join(nativeUserData, '.cache');
  process.env.XDG_DATA_HOME = path.join(nativeUserData, '.data');
  process.env.XDG_STATE_HOME = path.join(nativeUserData, '.state');
  process.env.USERPROFILE = nativeUserData;
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CODEX_HOME', 'KIMI_CODE_HOME',
    'MIMO_CODE_HOME', 'OPENCODE_CONFIG_DIR']) process.env[key] = path.join(nativeUserData, key.toLowerCase());
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  return { db: null as import('better-sqlite3').Database | null, nativeUserData, previousEnv };
});
vi.mock('electron', async () => {
  const noop = () => undefined;
  const emitter = { on: noop, once: noop, off: noop, removeListener: noop, removeAllListeners: noop };
  return {
    app: { ...emitter, getPath: () => binding.nativeUserData, getAppPath: () => process.cwd(),
      getVersion: () => 'test', getName: () => 'NexusIDE', isPackaged: false, isReady: () => true,
      whenReady: async () => undefined, getLocale: () => 'pt-BR', commandLine: { appendSwitch: noop, hasSwitch: () => false } },
    ipcMain: { ...emitter, handle: noop, removeHandler: noop },
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null },
    webContents: { getAllWebContents: () => [], fromId: () => null },
    safeStorage: { isEncryptionAvailable: () => false },
    dialog: { showMessageBox: async () => ({ response: 0 }), showMessageBoxSync: () => 0 },
    shell: { openExternal: async () => undefined },
    nativeTheme: { ...emitter, shouldUseDarkColors: false }, powerMonitor: { ...emitter },
    systemPreferences: { getUserDefault: () => undefined },
  };
});
afterAll(() => {
  for (const [key, value] of binding.previousEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(binding.nativeUserData, { recursive: true, force: true });
});
vi.mock('../persistence/db', () => ({ getDb: () => binding.db }));
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry } from './project-domain-store-registry';
import { compileIntentContract } from '../../shared/mission-intent';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import { bindResolvedRendererWorkspaceScope, clearRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { getProviderPaneSession, saveProviderPaneSession } from '../persistence/provider-session-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { captureMissionPaneResume } from './mission-pane-resume';
import { assertWorkerContinuationCurrent, assertWorkerContinuationTarget, assertWorkerContinuationAccount,
  rollbackWorkerContinuationBeforeBirth, commitWorkerContinuation, bindWorkerContinuationSession,
  workerContinuationPhysicalProof, authorizeWorkerContinuationBirth, workerContinuationBirthState } from './mission-pane-resume-ownership';
import * as ptyManager from '../pty/pty-manager';
import { authorizeMainOwnedAgentSpawn, assertMainOwnedAgentSpawnGrantActive, resolveMainOwnedAgentSpawn } from './main-owned-agent-spawn';
import {
  PENDING_SPAWN_RESULT, registerOrchRenderer, unregisterOrchRenderer, syncPanes,
  requestPaneSpawn, resolvePaneSpawn, resolveCurrentMissionSpawnAuthoritySeal,
  attachOrchMeta, reportPendingSpawnStartFailure, abandonPendingOrchSpawn,
  bindPendingSpawnSession as bindPendingSpawnSessionForNative, initPaneRegistry,
} from './pane-registry';

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

let fixture: ReturnType<typeof setup>;
let rendererId = 11_510;
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-continuation-red-')));
  const scope = testProjectScope({ rootRealPath: root });
  const manager = new ProjectRuntimeManager({ baseDir: path.join(root, 'runtime'), appVersion: 'test' });
  const registry = configureProjectDomainStoreRegistry(manager);
  binding.db = manager.open(scope).db;
  binding.db.exec(`CREATE TABLE provider_pane_sessions (
    installation_id TEXT NOT NULL, project_id TEXT NOT NULL, checkout_id TEXT NOT NULL,
    pane_id TEXT NOT NULL, adapter_id TEXT NOT NULL, session_key TEXT NOT NULL,
    session_id TEXT NOT NULL, transcript_path TEXT, updated_at INTEGER NOT NULL, account_id TEXT,
    PRIMARY KEY (installation_id, project_id, checkout_id, pane_id, adapter_id))`);
  const stores = registry.forScope(scope);
  const contract = { ...compileIntentContract({ goal: 'Finish exact worker assignment', intentVersion: 1 }),
    freeAgentChoice: true, approvedAt: 10, dispatchedAt: 11 };
  const created = stores.missions.create({ title: 'Continuation', intentVersion: 1,
    intentState: 'executing', intentContract: contract });
  stores.missions.setStatus(created.id, 'running');
  const authoritySeal = resolveCurrentMissionSpawnAuthoritySeal(scope, created.id);
  const spec = stores.missionPanes.record({ missionId: created.id, paneId: 'pane-original',
    adapterId: 'claude', model: 'recorded-model', accountId: 'account-a', effort: 'high',
    cwd: root, executionScope: scope, role: 'worker', workerIncarnationId: 'incarnation-original',
    authoritySeal, visualTask: { id: 'assignment-original', since: 1 },
    allowedTools: ['nexus_handoff_submit'], allowedSkills: ['review'] });
  expect(saveProviderPaneSession(scope, spec.paneId!, spec.adapterId,
    { key: 'session_id', id: 'native-conversation-original' }, spec.accountId)).toBe(true);
  const owner = { id: rendererId++, isDestroyed: () => false, isCrashed: () => false,
    send: vi.fn() } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
  bindResolvedRendererWorkspaceScope(owner, scope);
  registerOrchRenderer(owner);
  syncPanes([], owner);
  const requests: OrchPaneSpawnRequest[] = [];
  const restore = { kind: 'cli-agent' as const, cols: 80, rows: 24, adapterId: 'claude',
    paneId: spec.paneId, missionId: created.id, accountId: spec.accountId,
    model: spec.model, effort: spec.effort, cwd: root, resume: true };
  function beginExplicit(extra: Record<string, unknown> = {}) {
    const captured = captureMissionPaneResume(scope, created.id, spec.paneId, {});
    captured.assertCurrent();
    const result = requestPaneSpawn({ ...captured.spec, scope,
      workerContinuation: captured.continuation,
      resumeFromPaneId: spec.paneId, resume: true, [PENDING_SPAWN_RESULT]: true, ...extra });
    const request = owner.send.mock.calls.filter(call => call[0] === ORCH_CHANNELS.paneSpawnRequest).at(-1)?.[1] as OrchPaneSpawnRequest;
    expect(request).toBeDefined();
    requests.push(request);
    expect(getProviderPaneSession(scope, request.paneId, 'claude', 'account-a'))
      .toEqual({ key: 'session_id', id: 'native-conversation-original' });
    const grant = authorizeMainOwnedAgentSpawn(owner, { kind: 'cli-agent', cols: 120, rows: 36,
      adapterId: request.adapterId, accountId: request.accountId, model: request.model,
      effort: request.effort, cwd: request.cwd, paneId: request.paneId,
      missionId: request.missionId, orchRequestId: request.requestId }, manager);
    return { request, result, grant, captured };
  }
  return { root, scope, manager, registry, stores, owner, spec, requests, restore, beginExplicit };
}

beforeEach(() => { fixture = setup(); });
afterEach(async () => {
  for (const request of fixture.requests) {
    resolvePaneSpawn({ requestId: request.requestId, ok: false, error: 'owned test cleanup before child' }, fixture.owner);
  }
  unregisterOrchRenderer(fixture.owner);
  clearRendererWorkspaceScope(fixture.owner);
  await disposeProjectDomainStoreRegistry();
  binding.db = null;
  fixture.manager.closeAll();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

it.each(['before ACK', 'after pending ACK'])('denies original restore when explicit native continuation is accepted %s', async ack => {
  // Break caught: copying a closed worker context grants the new request while
  // leaving the exact original worker eligible for another physical process.
  const unopposed = authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager);
  expect(unopposed.persistedPane?.id).toBe(fixture.spec.id);
  assertMainOwnedAgentSpawnGrantActive({ owner: fixture.owner, requestId: undefined,
    pending: null, recovery: null, persistedPane: unopposed.persistedPane,
    runtimeManager: fixture.manager });
  const explicit = fixture.beginExplicit();
  assertMainOwnedAgentSpawnGrantActive({ owner: fixture.owner,
    requestId: explicit.request.requestId, pending: explicit.grant.pending,
    recovery: null, runtimeManager: fixture.manager });
  if (ack === 'after pending ACK') {
    expect(resolvePaneSpawn({ requestId: explicit.request.requestId, ok: true,
      pending: true, paneId: explicit.request.paneId, sessionId: null }, fixture.owner)).toBe(true);
    expect(await explicit.result).toMatchObject({ ok: true, pending: true, sessionId: null });
    assertMainOwnedAgentSpawnGrantActive({ owner: fixture.owner,
      requestId: explicit.request.requestId, pending: explicit.grant.pending,
      recovery: null, runtimeManager: fixture.manager });
  }
  expect(fixture.stores.missionPanes.findByPaneId('pane-original')).toMatchObject(fixture.spec);
  expect(getProviderPaneSession(fixture.scope, 'pane-original', 'claude', 'account-a'))
    .toEqual({ key: 'session_id', id: 'native-conversation-original' });
  const accepted = barrier();
  const originalAttempt = accepted.wait.then(() => authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager));
  accepted.release();
  await expect(originalAttempt).rejects.toThrow(/continuation|moving|resume.*owned/i);
});

it('rechecks original physical grant captured before explicit continuation acceptance', async () => {
  // Break caught: checking only initial restore admission would miss a grant
  // paused during account preparation before its final physical fence.
  const original = authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager);
  expect(original.persistedPane?.id).toBe(fixture.spec.id);
  assertMainOwnedAgentSpawnGrantActive({ owner: fixture.owner, requestId: undefined,
    pending: null, recovery: null, persistedPane: original.persistedPane,
    runtimeManager: fixture.manager });
  const physicalBirth = barrier();
  const originalAttempt = physicalBirth.wait.then(() => assertMainOwnedAgentSpawnGrantActive({
    owner: fixture.owner, requestId: undefined, pending: null, recovery: null,
    persistedPane: original.persistedPane, runtimeManager: fixture.manager }));
  const explicit = fixture.beginExplicit();
  assertMainOwnedAgentSpawnGrantActive({ owner: fixture.owner,
    requestId: explicit.request.requestId, pending: explicit.grant.pending,
    recovery: null, runtimeManager: fixture.manager });
  physicalBirth.release();
  await expect(originalAttempt).rejects.toThrow(/continuation|moving|resume.*owned/i);
});

async function reopenStore() {
  await disposeProjectDomainStoreRegistry();
  fixture.manager.closeAll();
  fixture.manager = new ProjectRuntimeManager({ baseDir: path.join(fixture.root, 'runtime'), appVersion: 'test' });
  fixture.registry = configureProjectDomainStoreRegistry(fixture.manager);
  binding.db = fixture.manager.open(fixture.scope).db;
  fixture.stores = fixture.registry.forScope(fixture.scope);
}

it('another explicit claimant loses without changing the first durable owner', () => {
  const first = captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {});
  expect(() => captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {}))
    .toThrow(/continuation_owned/);
  first.assertCurrent();
  expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation?.attemptId)
    .toBe(first.continuation!.attemptId);
});

it.each(['reserved', 'bound', 'child-possible', 'pending-ACK'])('retains exclusive durable owner after store reopen at %s', async phase => {
  const captured = phase === 'reserved'
    ? captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {})
    : fixture.beginExplicit().captured;
  const source = fixture.stores.missionPanes.findByPaneId('pane-original')!;
  const claim = source.workerContinuation!;
  if (phase === 'child-possible' || phase === 'pending-ACK') {
    authorizeWorkerContinuationBirth(fixture.scope, captured.continuation!, claim.target!);
  }
  if (phase === 'pending-ACK') {
    const request = fixture.requests.at(-1)!;
    expect(resolvePaneSpawn({ requestId: request.requestId, ok: true, pending: true,
      paneId: request.paneId, sessionId: null }, fixture.owner)).toBe(true);
  }
  await reopenStore();
  if (phase === 'reserved' || phase === 'bound') {
    expect(authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager).persistedPane?.id).toBe(fixture.spec.id);
    expect(() => captured.assertCurrent()).toThrow(/authority_changed/);
    const replacement = captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {});
    expect(replacement.continuation!.attemptId).not.toBe(claim.attemptId);
    replacement.assertCurrent();
    return;
  }
  captured.assertCurrent();
  expect(() => authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager)).toThrow(/continuation_owned/);
  expect(() => captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {})).toThrow(/continuation_owned/);
  expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation?.attemptId).toBe(claim.attemptId);
});

it('pre-birth rollback is CAS-fenced and stale compensation cannot release a replacement', () => {
  const first = captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {});
  expect(rollbackWorkerContinuationBeforeBirth(fixture.scope, first.continuation!)).toBe(true);
  const replacement = captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {});
  expect(() => rollbackWorkerContinuationBeforeBirth(fixture.scope, first.continuation!)).toThrow(/authority_changed/);
  replacement.assertCurrent();
});

it('possible child cannot unlock by ordinary rollback or loss of RAM registry state', async () => {
  const explicit = fixture.beginExplicit();
  const claim = assertWorkerContinuationCurrent(fixture.scope, explicit.captured.continuation!).claim;
  authorizeWorkerContinuationBirth(fixture.scope, explicit.captured.continuation!, claim.target!);
  expect(rollbackWorkerContinuationBeforeBirth(fixture.scope, explicit.captured.continuation!)).toBe(false);
  resolvePaneSpawn({ requestId: explicit.request.requestId, ok: false, error: 'uncertain child' }, fixture.owner);
  await reopenStore();
  expect(rollbackWorkerContinuationBeforeBirth(fixture.scope, explicit.captured.continuation!)).toBe(false);
  expect(() => authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager)).toThrow(/continuation_owned/);
});

it.each(['account', 'native', 'seal'])('fences exact source %s drift while target is bound', changed => {
  const explicit = fixture.beginExplicit();
  if (changed === 'native') saveProviderPaneSession(fixture.scope, 'pane-original', 'claude',
    { key: 'session_id', id: 'different-conversation' }, 'account-a');
  else if (changed === 'account') binding.db!.prepare('UPDATE mission_panes SET account_id = ? WHERE id = ?')
    .run('account-b', fixture.spec.id);
  else {
    const row = binding.db!.prepare('SELECT scope_json FROM mission_panes WHERE id = ?').get(fixture.spec.id) as { scope_json: string };
    const envelope = JSON.parse(row.scope_json);
    envelope.authoritySeal.contextRevision = 'different-approved-workflow';
    binding.db!.prepare('UPDATE mission_panes SET scope_json = ? WHERE id = ?').run(JSON.stringify(envelope), fixture.spec.id);
  }
  expect(() => explicit.captured.assertCurrent()).toThrow(/authority_changed/);
  expect(() => assertWorkerContinuationTarget(fixture.scope, explicit.captured.continuation!, {
    paneId: explicit.request.paneId, requestId: explicit.request.requestId,
    workerIncarnationId: explicit.grant.pending!.workerIncarnationId! })).toThrow(/authority_changed/);
});

it('keeps different exact workers independent within the same mission', () => {
  const other = fixture.stores.missionPanes.record({ missionId: fixture.spec.missionId,
    paneId: 'pane-other', adapterId: 'claude', accountId: 'account-a', role: 'worker',
    workerIncarnationId: 'incarnation-other', title: 'Other assignment', authoritySeal: fixture.spec.authoritySeal });
  saveProviderPaneSession(fixture.scope, 'pane-other', 'claude',
    { key: 'session_id', id: 'native-conversation-other' }, 'account-a');
  const first = captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {});
  const second = captureMissionPaneResume(fixture.scope, other.missionId, other.paneId, {});
  first.assertCurrent(); second.assertCurrent();
  expect(second.continuation!.attemptId).not.toBe(first.continuation!.attemptId);
});

it('closed manual readOnly worker inherits its Main human lifetime and grants in the target pending authority', () => {
  const manual = fixture.stores.missionPanes.record({ missionId: fixture.spec.missionId,
    paneId: 'pane-manual', adapterId: 'claude', accountId: 'account-a', role: 'worker',
    workerIncarnationId: 'incarnation-manual', title: 'Manual review', readOnly: true,
    operatorOpened: true, allowedTools: ['nexus_handoff_submit'], allowedSkills: ['review'], authoritySeal: fixture.spec.authoritySeal });
  saveProviderPaneSession(fixture.scope, 'pane-manual', 'claude',
    { key: 'session_id', id: 'manual-native-conversation' }, 'account-a');
  const captured = captureMissionPaneResume(fixture.scope, manual.missionId, manual.paneId, {});
  void requestPaneSpawn({ ...captured.spec, workerContinuation: captured.continuation,
    resumeFromPaneId: manual.paneId, resume: true, [PENDING_SPAWN_RESULT]: true });
  const request = fixture.owner.send.mock.calls.filter(call => call[0] === ORCH_CHANNELS.paneSpawnRequest).at(-1)![1] as OrchPaneSpawnRequest;
  fixture.requests.push(request);
  const grant = authorizeMainOwnedAgentSpawn(fixture.owner, { kind: 'cli-agent', cols: 120, rows: 36,
    adapterId: request.adapterId, accountId: request.accountId, cwd: request.cwd,
    paneId: request.paneId, missionId: request.missionId, orchRequestId: request.requestId }, fixture.manager);
  expect(grant.pending).toMatchObject({ operatorOpened: true, readOnly: true,
    allowedTools: ['nexus_handoff_submit'], allowedSkills: ['review'], workerContinuation: captured.continuation });
  expect(grant.pending!.sealedRequest?.accountId).toBe('account-a');
  expect(fixture.stores.missionPanes.findByPaneId('pane-manual')!.operatorOpened).toBe(true);
});

function seedOriginalDispatch(state = 'running') {
  binding.db!.prepare(`INSERT INTO tasks (id, mission_id, title, detail, status, priority, created_at, updated_at)
    VALUES ('original-task', ?, 'Original assignment', '', ?, 0, 1, 1)`).run(fixture.spec.missionId, state === 'completed' ? 'done' : 'running');
  binding.db!.prepare(`INSERT INTO task_dispatch_queue (id, task_id, mission_id, intent_version, state,
    lease_token_hash, lease_owner, lease_expires_at, worker_id, pane_id, session_id,
    worker_incarnation_id, created_at, updated_at)
    VALUES ('original-dispatch', 'original-task', ?, 1, ?, ?, 'main', ?, 'Original worker', 'pane-original',
    'closed-original-session', 'incarnation-original', 1, 1)`).run(fixture.spec.missionId, state, 'c'.repeat(64), Date.now() + 60_000);
}

function commitStoreOnlyTarget(explicit: ReturnType<typeof fixture.beginExplicit>) {
  // Store protocol control only: this does not assert that an OS child exists.
  const target = assertWorkerContinuationCurrent(fixture.scope, explicit.captured.continuation!).claim.target!;
  const sessionId = 'store-protocol-replacement';
  bindWorkerContinuationSession(fixture.scope, explicit.captured.continuation!, target, sessionId);
  authorizeWorkerContinuationBirth(fixture.scope, explicit.captured.continuation!, target);
  return commitWorkerContinuation(fixture.scope, explicit.captured.continuation!, {
    missionId: fixture.spec.missionId, adapterId: fixture.spec.adapterId, paneId: target.paneId,
    model: fixture.spec.model, accountId: fixture.spec.accountId, effort: fixture.spec.effort,
    cwd: fixture.spec.cwd, executionScope: fixture.spec.executionScope, title: fixture.spec.title,
    role: 'worker', workerIncarnationId: target.workerIncarnationId, visualTask: fixture.spec.visualTask,
    readOnly: fixture.spec.readOnly, operatorOpened: fixture.spec.operatorOpened,
    allowedTools: fixture.spec.allowedTools, allowedSkills: fixture.spec.allowedSkills, authoritySeal: fixture.spec.authoritySeal,
  }, sessionId);
}

it('commits the SAME active task and new physical tuple atomically, with old task history intact', async () => {
  seedOriginalDispatch();
  const previous = fixture.stores.taskDispatches.get('original-task')!;
  const explicit = fixture.beginExplicit();
  const target = commitStoreOnlyTarget(explicit);
  const rebound = fixture.stores.taskDispatches.get('original-task')!;
  expect(rebound).toMatchObject({ id: previous.id, taskId: 'original-task', missionId: previous.missionId,
    intentVersion: previous.intentVersion, state: 'running', paneId: target.paneId,
    sessionId: 'store-protocol-replacement', workerIncarnationId: target.workerIncarnationId,
    revision: previous.revision + 1 });
  expect(() => fixture.stores.taskDispatches.heartbeat({ sessionId: 'closed-original-session',
    missionId: previous.missionId, workerIncarnationId: 'incarnation-original', leaseMs: 60_000 })).toThrow(/nenhum dispatch/);
  expect(fixture.stores.taskDispatches.heartbeat({ sessionId: 'store-protocol-replacement',
    missionId: previous.missionId, workerIncarnationId: target.workerIncarnationId!, leaseMs: 60_000 }).taskId).toBe('original-task');
  expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation?.state).toBe('committed');
  await reopenStore();
  expect(() => authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager)).toThrow(/continuation_owned/);
  expect(authorizeMainOwnedAgentSpawn(fixture.owner, { ...fixture.restore, paneId: target.paneId }, fixture.manager).persistedPane?.id).toBe(target.id);
});

it('a dispatch revision bumped BEFORE birth authorization refuses the birth while no child can exist, then releases', () => {
  seedOriginalDispatch();
  const explicit = fixture.beginExplicit();
  const ref = explicit.captured.continuation!;
  const target = assertWorkerContinuationCurrent(fixture.scope, ref).claim.target!;
  bindWorkerContinuationSession(fixture.scope, ref, target, 'store-protocol-replacement');
  binding.db!.prepare('UPDATE task_dispatch_queue SET revision = revision + 1 WHERE task_id = ?').run('original-task');
  // F-1151 review P2: the commit predicate is evaluated at the host-post fence, not only after the child exists.
  expect(() => authorizeWorkerContinuationBirth(fixture.scope, ref, target)).toThrow(/CAS/);
  expect(assertWorkerContinuationCurrent(fixture.scope, ref).claim.childPossible).toBe(false);
  expect(fixture.stores.missionPanes.findByPaneId(explicit.request.paneId)).toBeNull();
  expect(rollbackWorkerContinuationBeforeBirth(fixture.scope, ref)).toBe(true);
  expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation)
    .toMatchObject({ state: 'released', outcome: 'prepared-cancelled' });
});

it('a non-recoverable superseded dispatch is refused at reservation, before any provider preparation', () => {
  seedOriginalDispatch();
  binding.db!.prepare("UPDATE task_dispatch_queue SET state = 'superseded', last_error = 'operator stopped' WHERE task_id = ?").run('original-task');
  expect(() => fixture.beginExplicit()).toThrow(/não autoriza rebind/);
  expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation).toBeUndefined();
});

it('a dispatch revision bumped AFTER birth authorization rejects commit without publishing target or releasing source', () => {
  seedOriginalDispatch();
  const explicit = fixture.beginExplicit();
  const ref = explicit.captured.continuation!;
  const target = assertWorkerContinuationCurrent(fixture.scope, ref).claim.target!;
  bindWorkerContinuationSession(fixture.scope, ref, target, 'store-protocol-replacement');
  authorizeWorkerContinuationBirth(fixture.scope, ref, target);
  binding.db!.prepare('UPDATE task_dispatch_queue SET revision = revision + 1 WHERE task_id = ?').run('original-task');
  expect(() => commitWorkerContinuation(fixture.scope, ref, {
    missionId: fixture.spec.missionId, adapterId: fixture.spec.adapterId, paneId: target.paneId,
    model: fixture.spec.model, accountId: fixture.spec.accountId, effort: fixture.spec.effort,
    cwd: fixture.spec.cwd, executionScope: fixture.spec.executionScope, title: fixture.spec.title,
    role: 'worker', workerIncarnationId: target.workerIncarnationId, visualTask: fixture.spec.visualTask,
    readOnly: fixture.spec.readOnly, operatorOpened: fixture.spec.operatorOpened,
    allowedTools: fixture.spec.allowedTools, allowedSkills: fixture.spec.allowedSkills, authoritySeal: fixture.spec.authoritySeal,
  }, 'store-protocol-replacement')).toThrow(/CAS/);
  expect(fixture.stores.missionPanes.findByPaneId(explicit.request.paneId)).toBeNull();
  expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation?.state).toBe('bound');
  expect(rollbackWorkerContinuationBeforeBirth(fixture.scope, ref)).toBe(false);
});

it('completed-task adjustment leaves the completed dispatch and receipts intact', () => {
  seedOriginalDispatch('completed');
  binding.db!.prepare('UPDATE task_dispatch_queue SET completed_at = 2 WHERE task_id = ?').run('original-task');
  const previous = binding.db!.prepare('SELECT * FROM task_dispatch_queue WHERE task_id = ?').get('original-task');
  const explicit = fixture.beginExplicit();
  expect(assertWorkerContinuationCurrent(fixture.scope, explicit.captured.continuation!).claim.dispatch).toBeNull();
  commitStoreOnlyTarget(explicit);
  expect(binding.db!.prepare('SELECT * FROM task_dispatch_queue WHERE task_id = ?').get('original-task')).toEqual(previous);
});

it('a durable record failure rolls back the dispatch transaction and retains exclusive source ownership', () => {
  seedOriginalDispatch();
  const explicit = fixture.beginExplicit();
  const previous = fixture.stores.taskDispatches.get('original-task');
  binding.db!.exec(`CREATE TRIGGER fail_continuation_record BEFORE INSERT ON mission_panes
    BEGIN SELECT RAISE(ABORT, 'controlled durable write refusal'); END`);
  expect(() => commitStoreOnlyTarget(explicit)).toThrow(/durable write refusal/);
  expect(fixture.stores.taskDispatches.get('original-task')).toEqual(previous);
  expect(fixture.stores.missionPanes.findByPaneId(explicit.request.paneId)).toBeNull();
  expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation?.state).toBe('bound');
});

it.each([
  { ok: false, rootExited: false, descendantsExited: false },
  { ok: true, rootExited: true, descendantsExited: false },
])('incomplete raw host proof cannot release child-possible source (%j)', proof => {
  const explicit = fixture.beginExplicit();
  const target = assertWorkerContinuationCurrent(fixture.scope, explicit.captured.continuation!).claim.target!;
  authorizeWorkerContinuationBirth(fixture.scope, explicit.captured.continuation!, target);
  workerContinuationPhysicalProof(fixture.scope, explicit.captured.continuation!, target)('proof-policy-session', proof);
  expect(rollbackWorkerContinuationBeforeBirth(fixture.scope, explicit.captured.continuation!)).toBe(false);
  expect(() => authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager)).toThrow(/continuation_owned/);
});

it('a late or foreign raw proof is ignored without throwing and without changing the claim', () => {
  const full = { ok: true, rootExited: true, descendantsExited: true };
  const explicit = fixture.beginExplicit();
  const ref = explicit.captured.continuation!;
  const target = assertWorkerContinuationCurrent(fixture.scope, ref).claim.target!;
  bindWorkerContinuationSession(fixture.scope, ref, target, 'sess-a');
  authorizeWorkerContinuationBirth(fixture.scope, ref, target);
  const proof = workerContinuationPhysicalProof(fixture.scope, ref, target);
  // A proof for ANOTHER process of the same pane/target never releases this claim.
  expect(() => proof('sess-foreign', full)).not.toThrow();
  expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation).toMatchObject({ state: 'bound', childPossible: true });
  // The exact process proves a full exit: released by the physical tree, as designed.
  expect(() => proof('sess-a', full)).not.toThrow();
  expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation).toMatchObject({ state: 'released', outcome: 'physical-tree-exited' });
  // A replacement attempt now owns the source: the old proof arriving late must not throw nor touch it.
  const replacement = captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {});
  expect(() => proof('sess-a', full)).not.toThrow();
  expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation)
    .toMatchObject({ attemptId: replacement.continuation!.attemptId, state: 'reserved' });
});

it('ordinary tool pending ACK retains the real durable prepared owner until deferred birth', async () => {
  const toolUtil = await import('./tool-util');
  const { paneSpawnTool } = await import('./tools-panes');
  const workflow = await import('../context/context-workflow-registry');
  workflow.configureContextWorkflowRegistry(fixture.manager, { appVersion: 'test' });
  const worktrees = await import('../runtime/worktree-runtime-registry');
  worktrees.configureWorktreeRuntimeRegistry(fixture.manager);
  const originalSpawn = vi.spyOn(toolUtil, 'spawnPaneAndMaybePrompt').mockImplementationOnce(async (options, hooks) => {
    const result = await requestPaneSpawn({ ...options, abortSignal: hooks?.invocation?.signal });
    throw new Error(result.error ?? 'pane spawn pending');
  });
  const ctx: import('./gate').AgentGateContext = { token: 'owned-handler-control', label: 'Operator', role: 'user',
    sessionId: 'owned-handler-session', missionId: fixture.spec.missionId, scope: fixture.scope,
    allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false };
  try {
    const flow = paneSpawnTool.handler({ resume: fixture.spec.paneId, readOnly: true }, ctx, { signal: new AbortController().signal });
    let flowError: unknown;
    void flow.catch(error => { flowError = error; });
    const deadline = Date.now() + 5_000;
    let request: OrchPaneSpawnRequest | undefined;
    while (!request && Date.now() < deadline) {
      request = fixture.owner.send.mock.calls.filter(call => call[0] === ORCH_CHANNELS.paneSpawnRequest).at(-1)?.[1];
      if (flowError) throw flowError;
      if (!request) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(request).toBeDefined();
    fixture.requests.push(request!);
    expect(resolvePaneSpawn({ requestId: request!.requestId, ok: true, pending: true,
      paneId: request!.paneId, sessionId: null }, fixture.owner)).toBe(true);
    expect(await flow).toMatchObject({ ok: true, pending: true, sessionId: null });
    const claim = fixture.stores.missionPanes.findByPaneId(fixture.spec.paneId!)!.workerContinuation!;
    expect(claim).toMatchObject({ state: 'bound', childPossible: false, target: { requestId: request!.requestId } });
    expect(() => assertWorkerContinuationTarget(fixture.scope,
      { sourcePaneId: fixture.spec.paneId!, attemptId: claim.attemptId }, claim.target!)).not.toThrow();
    expect(() => authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager)).toThrow(/continuation/);
  } finally { originalSpawn.mockRestore(); workflow.disposeContextWorkflowRegistry(); worktrees.disposeWorktreeRuntimeRegistry(); }
});


describe('F-1151 review P1/P2: the real tool handler, composed with the real registry', () => {
  async function withHandler(spawnImpl: (toolUtil: typeof import('./tool-util')) => Parameters<typeof vi.spyOn>[0] extends never ? never : (options: never, hooks: never) => Promise<never>,
    body: (run: () => Promise<unknown>) => Promise<void>) {
    const toolUtil = await import('./tool-util');
    const { paneSpawnTool } = await import('./tools-panes');
    const workflow = await import('../context/context-workflow-registry');
    workflow.configureContextWorkflowRegistry(fixture.manager, { appVersion: 'test' });
    const worktrees = await import('../runtime/worktree-runtime-registry');
    worktrees.configureWorktreeRuntimeRegistry(fixture.manager);
    const originalSpawn = vi.spyOn(toolUtil, 'spawnPaneAndMaybePrompt').mockImplementationOnce(spawnImpl(toolUtil) as never);
    const ctx: import('./gate').AgentGateContext = { token: 'owned-handler-control-2', label: 'Operator', role: 'user',
      sessionId: 'owned-handler-session', missionId: fixture.spec.missionId, scope: fixture.scope,
      allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false };
    try {
      await body(() => paneSpawnTool.handler({ resume: fixture.spec.paneId, readOnly: true }, ctx, { signal: new AbortController().signal }));
    } finally { originalSpawn.mockRestore(); workflow.disposeContextWorkflowRegistry(); worktrees.disposeWorktreeRuntimeRegistry(); }
  }

  it('a failure BEFORE any ACK releases the reservation by CAS and leaves the source restorable', async () => {
    await withHandler(() => (async () => { throw new Error('cli_missing: provider binary unavailable'); }) as never, async run => {
      await expect(run()).rejects.toThrow(/cli_missing/);
    });
    expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation)
      .toMatchObject({ state: 'released', outcome: 'prepared-cancelled', childPossible: false });
    expect(authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager).persistedPane?.id).toBe(fixture.spec.id);
  });

  it('an accepted pending ACK keeps the owner at tool return, and the grant settlement (not the tool) releases it later', async () => {
    let request: OrchPaneSpawnRequest | undefined;
    await withHandler(() => (async (options: never, hooks: { invocation?: { signal?: AbortSignal } }) => {
      const result = await requestPaneSpawn({ ...(options as object), abortSignal: hooks?.invocation?.signal } as never);
      throw new Error((result as { error?: string }).error ?? 'pane spawn pending');
    }) as never, async run => {
      const flow = run();
      let flowError: unknown;
      void flow.catch(error => { flowError = error; });
      const deadline = Date.now() + 5_000;
      while (!request && Date.now() < deadline) {
        request = fixture.owner.send.mock.calls.filter(call => call[0] === ORCH_CHANNELS.paneSpawnRequest).at(-1)?.[1];
        if (flowError) throw flowError;
        if (!request) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(request).toBeDefined();
      fixture.requests.push(request!);
      expect(resolvePaneSpawn({ requestId: request!.requestId, ok: true, pending: true, paneId: request!.paneId, sessionId: null }, fixture.owner)).toBe(true);
      await expect(flow).resolves.toMatchObject({ ok: true, pending: true });
    });
    // Tool returned: the finally block did NOT release (the old defect), the grant still owns it.
    expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation).toMatchObject({ state: 'bound', childPossible: false });
    expect(() => authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager)).toThrow(/continuation_owned/);
    // The CLI never starts and the start watchdog gives up: the registry settlement releases it by CAS.
    expect(abandonPendingOrchSpawn(request!.requestId, 'pane did not start')).toBe(true);
    expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation)
      .toMatchObject({ state: 'released', outcome: 'prepared-cancelled' });
    expect(authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager).persistedPane?.id).toBe(fixture.spec.id);
  });
});

describe('F-1151 review P1: an accepted pending ACK hands its reservation to the grant settlement', () => {
  async function acceptPending(extra: Record<string, unknown> = {}) {
    const explicit = fixture.beginExplicit(extra);
    expect(resolvePaneSpawn({ requestId: explicit.request.requestId, ok: true, pending: true,
      paneId: explicit.request.paneId, sessionId: null }, fixture.owner)).toBe(true);
    await expect(explicit.result).resolves.toMatchObject({ ok: true, pending: true, sessionId: null });
    return explicit;
  }
  function expectReleasedAndRestorable(ref: { sourcePaneId: string; attemptId: string }) {
    expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation)
      .toMatchObject({ attemptId: ref.attemptId, state: 'released', outcome: 'prepared-cancelled', childPossible: false });
    expect(authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager).persistedPane?.id).toBe(fixture.spec.id);
    const replacement = captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {});
    expect(replacement.continuation!.attemptId).not.toBe(ref.attemptId);
    return replacement;
  }

  it('keeps the owner while the pending grant is alive, then cancels by CAS when start failure is reported', async () => {
    const explicit = await acceptPending();
    const ref = explicit.captured.continuation!;
    expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation).toMatchObject({ attemptId: ref.attemptId, state: 'bound' });
    expect(() => authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager)).toThrow(/continuation_owned/);
    expect(reportPendingSpawnStartFailure(explicit.request.requestId, fixture.owner, 'CLI did not start')).toBe(true);
    expectReleasedAndRestorable(ref);
  });

  it('cancels by CAS when the start watchdog abandons a sessionless attempt', async () => {
    const explicit = await acceptPending();
    expect(abandonPendingOrchSpawn(explicit.request.requestId, 'pane did not start')).toBe(true);
    expectReleasedAndRestorable(explicit.captured.continuation!);
  });

  it('cancels by CAS when the caller authority is revoked (abort) after the pending ACK', async () => {
    const abort = new AbortController();
    const explicit = await acceptPending({ abortSignal: abort.signal });
    abort.abort('mission authority revoked');
    await vi.waitFor(() => expectReleasedAndRestorable(explicit.captured.continuation!));
  });

  it('cancels by CAS when the renderer reports a failed spawn result', async () => {
    const explicit = fixture.beginExplicit();
    expect(resolvePaneSpawn({ requestId: explicit.request.requestId, ok: false, error: 'renderer refused' }, fixture.owner)).toBe(true);
    await vi.waitFor(() => expectReleasedAndRestorable(explicit.captured.continuation!));
  });

  it('never releases once a child is possible, whichever path settles the grant', async () => {
    const explicit = await acceptPending();
    const ref = explicit.captured.continuation!;
    authorizeWorkerContinuationBirth(fixture.scope, ref, assertWorkerContinuationCurrent(fixture.scope, ref).claim.target!);
    expect(abandonPendingOrchSpawn(explicit.request.requestId, 'pane did not start')).toBe(true);
    await Promise.resolve();
    expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation)
      .toMatchObject({ attemptId: ref.attemptId, state: 'bound', childPossible: true });
    expect(() => authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager)).toThrow(/continuation_owned/);
  });

  it('a late settlement of an old attempt cannot clear a newer reservation (the attemptId CAS is what refuses)', async () => {
    const stale = await acceptPending();
    const staleRef = stale.captured.continuation!;
    // The old claim is released by ANOTHER path while its grant is still alive in the registry...
    expect(rollbackWorkerContinuationBeforeBirth(fixture.scope, staleRef)).toBe(true);
    // ...and a newer attempt reserves the same source.
    const replacement = captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {});
    expect(replacement.continuation!.attemptId).not.toBe(staleRef.attemptId);
    // Only now does the OLD grant settle (its pending is still in the registry map).
    expect(abandonPendingOrchSpawn(stale.request.requestId, 'late watchdog')).toBe(true);
    replacement.assertCurrent();
    expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation)
      .toMatchObject({ attemptId: replacement.continuation!.attemptId, state: 'reserved', childPossible: false });
  });
});

describe('F-1151 review P1: the durable target is committed only after the exact attempt reached the host post', () => {
  it('follows the durable claim: waiting until childPossible, authorized after, gone once released or replaced', () => {
    const explicit = fixture.beginExplicit();
    const ref = explicit.captured.continuation!;
    const target = assertWorkerContinuationCurrent(fixture.scope, ref).claim.target!;
    bindWorkerContinuationSession(fixture.scope, ref, target, 'sess-readiness');
    // Session visible and bound, native readiness still pending.
    expect(workerContinuationBirthState(fixture.scope, ref)).toBe('waiting');
    // The store keeps refusing a target that may never be born.
    expect(() => commitWorkerContinuation(fixture.scope, ref, {
      missionId: fixture.spec.missionId, adapterId: fixture.spec.adapterId, paneId: target.paneId, model: fixture.spec.model,
      accountId: fixture.spec.accountId, effort: fixture.spec.effort, cwd: fixture.spec.cwd, executionScope: fixture.spec.executionScope,
      title: fixture.spec.title, role: 'worker', workerIncarnationId: target.workerIncarnationId, visualTask: fixture.spec.visualTask,
      readOnly: fixture.spec.readOnly, operatorOpened: fixture.spec.operatorOpened, allowedTools: fixture.spec.allowedTools,
      allowedSkills: fixture.spec.allowedSkills, authoritySeal: fixture.spec.authoritySeal }, 'sess-readiness')).toThrow(/authority_changed/);
    authorizeWorkerContinuationBirth(fixture.scope, ref, target);
    expect(workerContinuationBirthState(fixture.scope, ref)).toBe('authorized');
    const other = { sourcePaneId: ref.sourcePaneId, attemptId: 'some-other-attempt' };
    expect(workerContinuationBirthState(fixture.scope, other)).toBe('gone');
  });

  it('is gone as soon as the reservation is released before any birth', () => {
    const captured = captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {});
    expect(workerContinuationBirthState(fixture.scope, captured.continuation!)).toBe('waiting');
    expect(rollbackWorkerContinuationBeforeBirth(fixture.scope, captured.continuation!)).toBe(true);
    expect(workerContinuationBirthState(fixture.scope, captured.continuation!)).toBe('gone');
  });
});

describe('F-1151 review P1 (composed, real stores and registry): the pending record loop waits for the host post', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function recordInput(target: { paneId: string; workerIncarnationId: string }) {
    return { missionId: fixture.spec.missionId, adapterId: fixture.spec.adapterId, paneId: target.paneId,
      model: fixture.spec.model, accountId: fixture.spec.accountId, effort: fixture.spec.effort, cwd: fixture.spec.cwd,
      executionScope: fixture.spec.executionScope, title: fixture.spec.title, role: 'worker' as const,
      workerIncarnationId: target.workerIncarnationId, visualTask: fixture.spec.visualTask, readOnly: fixture.spec.readOnly,
      operatorOpened: fixture.spec.operatorOpened, allowedTools: fixture.spec.allowedTools, allowedSkills: fixture.spec.allowedSkills,
      authoritySeal: fixture.spec.authoritySeal };
  }
  async function startLoop(sessionId: string) {
    seedOriginalDispatch();
    const { recordMissionPaneAfterPendingSpawn } = await import('./tool-util');
    const explicit = fixture.beginExplicit();
    const ref = explicit.captured.continuation!;
    const target = assertWorkerContinuationCurrent(fixture.scope, ref).claim.target!;
    expect(resolvePaneSpawn({ requestId: explicit.request.requestId, ok: true, pending: true, paneId: explicit.request.paneId, sessionId: null }, fixture.owner)).toBe(true);
    await explicit.result;
    expect(bindPendingSpawnSessionForNative(explicit.request.requestId, fixture.owner, sessionId)).toBe(true);
    bindWorkerContinuationSession(fixture.scope, ref, target, sessionId);
    vi.spyOn(ptyManager, 'getAgentSessionInfo').mockImplementation(((id: string) => id === sessionId
      ? { sessionId, paneId: explicit.request.paneId, adapterId: fixture.spec.adapterId, missionId: fixture.spec.missionId } : null) as never);
    vi.useFakeTimers();
    let record = vi.fn((id: string) => { commitWorkerContinuation(fixture.scope, ref, recordInput(target), id); });
    const outcome = recordMissionPaneAfterPendingSpawn({ requestId: explicit.request.requestId, paneId: explicit.request.paneId }, record,
      () => workerContinuationBirthState(fixture.scope, ref));
    return { explicit, ref, target, outcome, record };
  }

  it('does not commit or rebind while the session is visible but unborn, then commits exactly once after the host post', async () => {
    const { ref, target, outcome, record } = await startLoop('sess-readiness');
    await vi.advanceTimersByTimeAsync(3_000);
    // Native readiness still owns the host post: nothing durable yet, the dispatch still points at the closed worker.
    expect(record).not.toHaveBeenCalled();
    expect(fixture.stores.missionPanes.findByPaneId(target.paneId)).toBeNull();
    expect(fixture.stores.taskDispatches.get('original-task')).toMatchObject({ sessionId: 'closed-original-session', state: 'running' });
    authorizeWorkerContinuationBirth(fixture.scope, ref, target);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('recorded');
    expect(record).toHaveBeenCalledTimes(1);
    expect(fixture.stores.missionPanes.findByPaneId(target.paneId)).toMatchObject({ paneId: target.paneId, workerIncarnationId: target.workerIncarnationId });
    expect(fixture.stores.taskDispatches.get('original-task')).toMatchObject({ sessionId: 'sess-readiness', paneId: target.paneId,
      workerIncarnationId: target.workerIncarnationId, taskId: 'original-task', state: 'running' });
    expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation?.state).toBe('committed');
  });

  it('a readiness that fails before the host post releases the source and the loop reports no session without any durable write', async () => {
    const { ref, target, outcome, record } = await startLoop('sess-readiness-fail');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rollbackWorkerContinuationBeforeBirth(fixture.scope, ref)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('no-session');
    expect(record).not.toHaveBeenCalled();
    expect(fixture.stores.missionPanes.findByPaneId(target.paneId)).toBeNull();
    expect(fixture.stores.taskDispatches.get('original-task')).toMatchObject({ sessionId: 'closed-original-session' });
    expect(authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager).persistedPane?.id).toBe(fixture.spec.id);
  });
});

describe('F-1151 review P1 (composed): a readiness that dies before the host post is released by the REAL physical proof', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('a full unposted-tree proof releases the claim, the loop reports no session and nothing durable is written', async () => {
    seedOriginalDispatch();
    const { recordMissionPaneAfterPendingSpawn } = await import('./tool-util');
    const explicit = fixture.beginExplicit();
    const ref = explicit.captured.continuation!;
    const target = assertWorkerContinuationCurrent(fixture.scope, ref).claim.target!;
    expect(resolvePaneSpawn({ requestId: explicit.request.requestId, ok: true, pending: true, paneId: explicit.request.paneId, sessionId: null }, fixture.owner)).toBe(true);
    await explicit.result;
    expect(bindPendingSpawnSessionForNative(explicit.request.requestId, fixture.owner, 'sess-dies')).toBe(true);
    bindWorkerContinuationSession(fixture.scope, ref, target, 'sess-dies');
    vi.spyOn(ptyManager, 'getAgentSessionInfo').mockImplementation(((id: string) => id === 'sess-dies'
      ? { sessionId: 'sess-dies', paneId: explicit.request.paneId } : null) as never);
    vi.useFakeTimers();
    const record = vi.fn();
    const outcome = recordMissionPaneAfterPendingSpawn({ requestId: explicit.request.requestId, paneId: explicit.request.paneId }, record,
      () => workerContinuationBirthState(fixture.scope, ref));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(workerContinuationBirthState(fixture.scope, ref)).toBe('waiting');
    // What pty-host-core's cancelBeforeBirth ends in: terminate() of a never-posted session proves an empty tree.
    workerContinuationPhysicalProof(fixture.scope, ref, target)('sess-dies', { ok: true, rootExited: true, descendantsExited: true });
    expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation)
      .toMatchObject({ state: 'released', outcome: 'physical-tree-exited', childPossible: false });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('no-session');
    expect(record).not.toHaveBeenCalled();
    expect(fixture.stores.missionPanes.findByPaneId(target.paneId)).toBeNull();
    expect(authorizeMainOwnedAgentSpawn(fixture.owner, fixture.restore, fixture.manager).persistedPane?.id).toBe(fixture.spec.id);
  });

  it('a late proof after a cancelled-before-birth release is ignored without touching the claim', () => {
    const explicit = fixture.beginExplicit();
    const ref = explicit.captured.continuation!;
    const target = assertWorkerContinuationCurrent(fixture.scope, ref).claim.target!;
    expect(rollbackWorkerContinuationBeforeBirth(fixture.scope, ref)).toBe(true);
    const before = JSON.stringify(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation);
    expect(() => workerContinuationPhysicalProof(fixture.scope, ref, target)('sess-late', { ok: true, rootExited: true, descendantsExited: true })).not.toThrow();
    expect(JSON.stringify(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation)).toBe(before);
  });
});

describe('F-1151 review P1: the deferred birth fence survives the renderer consuming the single-use grant', () => {
  function consumeGrantForSession(explicit: ReturnType<typeof fixture.beginExplicit>, sessionId: string) {
    const ref = explicit.captured.continuation!;
    const target = assertWorkerContinuationCurrent(fixture.scope, ref).claim.target!;
    expect(bindPendingSpawnSessionForNative(explicit.request.requestId, fixture.owner, sessionId)).toBe(true);
    bindWorkerContinuationSession(fixture.scope, ref, target, sessionId);
    // The renderer sees the allocated SID long before the native readiness finishes.
    expect(resolvePaneSpawn({ requestId: explicit.request.requestId, ok: true, paneId: explicit.request.paneId, sessionId }, fixture.owner)).toBe(true);
    return { ref, target };
  }
  const fence = (explicit: ReturnType<typeof fixture.beginExplicit>, deferredSessionId?: string) => () =>
    assertMainOwnedAgentSpawnGrantActive({ owner: fixture.owner, requestId: explicit.request.requestId,
      pending: explicit.grant.pending, recovery: null, runtimeManager: fixture.manager, deferredSessionId });

  it('admits the exact allocated session, and only it, after the grant was consumed', async () => {
    const explicit = fixture.beginExplicit();
    consumeGrantForSession(explicit, 'sess-deferred');
    await expect(explicit.result).resolves.toMatchObject({ ok: true, sessionId: 'sess-deferred' });
    // The ordinary single-use fence (no deferred session) keeps its original meaning.
    expect(fence(explicit)).toThrow(/grant expired before process start/);
    expect(fence(explicit, 'sess-deferred')).not.toThrow();
    expect(fence(explicit, 'sess-other')).toThrow(/grant expired before process start/);
  });

  it('still refuses once the durable claim was released or the target tuple is no longer current', () => {
    const explicit = fixture.beginExplicit();
    const { ref } = consumeGrantForSession(explicit, 'sess-deferred');
    expect(fence(explicit, 'sess-deferred')).not.toThrow();
    expect(rollbackWorkerContinuationBeforeBirth(fixture.scope, ref)).toBe(true);
    expect(fence(explicit, 'sess-deferred')).toThrow(/authority_changed/);
  });

  it('does not admit an expired (settled-failure) grant even for the session it had claimed', async () => {
    const explicit = fixture.beginExplicit();
    expect(bindPendingSpawnSessionForNative(explicit.request.requestId, fixture.owner, 'sess-deferred')).toBe(true);
    expect(resolvePaneSpawn({ requestId: explicit.request.requestId, ok: false, error: 'renderer refused' }, fixture.owner)).toBe(true);
    await vi.waitFor(() => expect(fence(explicit, 'sess-deferred')).toThrow(/grant expired before process start/));
  });
});

describe('F-1151 review P2: pre-birth account and liveness fences', () => {
  it('the selected physical account must equal the original pin before any child exists', () => {
    const captured = captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {});
    expect(() => assertWorkerContinuationAccount(fixture.scope, captured.continuation!, 'account-a')).not.toThrow();
    expect(() => assertWorkerContinuationAccount(fixture.scope, captured.continuation!, 'account-b')).toThrow(/conta selecionada/);
    expect(() => assertWorkerContinuationAccount(fixture.scope, captured.continuation!, undefined)).toThrow(/conta selecionada/);
  });

  it('a worker whose physical child the renderer mirror has not seen still refuses a second continuation', () => {
    const inventory = vi.spyOn(ptyManager, 'listAgentSessionsForPane').mockReturnValue([{ sessionId: 'physical-not-mirrored', paneId: 'pane-original' } as never]);
    try {
      expect(() => captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {})).toThrow(/resume_source_live/);
      expect(fixture.stores.missionPanes.findByPaneId('pane-original')?.workerContinuation).toBeUndefined();
    } finally { inventory.mockRestore(); }
    captureMissionPaneResume(fixture.scope, fixture.spec.missionId, 'pane-original', {});
  });
});

describe.runIf(process.env.NEXUS_WORKER_CONTINUATION_NATIVE === '1')('owned native continuation controls', () => {
  let host: ReturnType<typeof fork>;
  let pty: typeof import('../pty/pty-manager');
  let primaryBridge: import('../pty/pty-host-core').PtyHostBridge;
  let rawProofs: Array<{ ok: boolean; rootExited: boolean; descendantsExited: boolean }>;
  const owned = new Set<string>();
  let hostLog = '';
  const rootWithSupervisor = process.env.NEXUS_WORKER_CONTINUATION_NATIVE_ROOT ?? process.cwd();
  async function ownedHost(rejectPreflight = false) {
    const { createPtyHostBridge } = await import('../pty/pty-host-core');
    const child = fork(path.join(process.cwd(), 'scripts/mission-e2e/pty-host-child.cjs'), [], {
      cwd: rootWithSupervisor,
      env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
        HOME: binding.nativeUserData, LANG: 'en_US.UTF-8', TMPDIR: os.tmpdir() },
      serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--import', pathToFileURL(path.join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href],
    });
    child.stdout?.on('data', chunk => { hostLog += chunk.toString(); });
    child.stderr?.on('data', chunk => { hostLog += chunk.toString(); });
    const bridge = createPtyHostBridge({ ensure: () => undefined, post: message => child.send(
      // Deliberately request an incompatible trust profile. The REAL host
      // rejects it before nodePty.spawn and issues its exact no-child tombstone.
      rejectPreflight && message.type === 'spawn' ? { ...message, darwinTrustProfile: 'packaged-smoke' } : message) });
    child.on('message', message => bridge.dispatchEvent(message as import('../pty/pty-host-core').HostEventMsg));
    child.on('exit', () => bridge.handleHostDown());
    return { child, bridge };
  }
  beforeAll(async () => {
    const started = await ownedHost(); host = started.child; primaryBridge = started.bridge;
    pty = await import('../pty/pty-manager');
    pty.setPtyHost(primaryBridge.host);
    initPaneRegistry();
    const { prepareAgentSpawnDecoration } = await import('./mcp-server');
    pty.setAgentSpawnHook(prepareAgentSpawnDecoration);
  });
  afterAll(async () => {
    if (owned.size) throw new Error('native control retained an owned session; see exact test cleanup failure');
    host.disconnect();
    await new Promise<void>(resolve => { if (host.exitCode !== null) resolve(); else host.once('exit', () => resolve()); });
    pty.setAgentSpawnHook(null);
  });
  beforeEach(async () => {
    rawProofs = [];
    if (os.homedir() !== binding.nativeUserData || process.env.XDG_CONFIG_HOME !== path.join(binding.nativeUserData, '.config') ||
        process.env.XDG_CACHE_HOME !== path.join(binding.nativeUserData, '.cache')) throw new Error('native Main/config roots escaped owned isolation');
    delete process.env.OPENAI_API_KEY;
    const { initUsageTelemetry } = await import('../usage/usage-service');
    await initUsageTelemetry(fixture.manager);
  });
  afterEach(async () => {
    try { for (const sessionId of [...owned]) await cleanup(sessionId); }
    finally { await (await import('../usage/usage-service')).shutdownUsageTelemetry(); }
  });

  async function waitForBirth(sessionId: string) {
    const { readSessionOutput } = await import('./pane-registry');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (readSessionOutput(sessionId, 2_048).includes('CONTINUATION_NATIVE_READY')) return;
      if (pty.getSessionState(sessionId) === null) throw new Error(`owned fixture exited before ready: ${hostLog.slice(-2_048)}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`owned fixture birth timed out: ${hostLog.slice(-2_048)}`);
  }

  async function source(operatorOpened = false) {
    execFileSync('git', ['-C', fixture.root, 'init', '-q']);
    fs.writeFileSync(path.join(fixture.root, 'native-fixture.cjs'),
      "process.stdout.write('CONTINUATION_NATIVE_READY\\n'); process.stdin.resume(); setInterval(() => {}, 1000);\n");
    execFileSync('git', ['-C', fixture.root, 'add', 'native-fixture.cjs']);
    execFileSync('git', ['-C', fixture.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Owned fixture baseline']);
    const { cliPtyAdapterSchema } = await import('../../shared/adapter-types');
    const adapter = cliPtyAdapterSchema.parse({ kind: 'cli-pty', id: 'continuation-fixture', label: 'Owned continuation fixture',
      version: '1', bin: process.execPath, detect: `${process.execPath} --version`,
      install: { method: 'manual', command: 'local fixture' }, auth: { method: 'none' },
      spawn: { interactive: [process.execPath, path.join(fixture.root, 'native-fixture.cjs')],
        headless: [process.execPath, path.join(fixture.root, 'native-fixture.cjs')], ptyRequired: true, resumeIdArgs: ['--resume'] },
      env: { static: { HOME: binding.nativeUserData }, passthrough: [] },
      models: { flag: '--model', list: ['fixture-model'], default: 'fixture-model' },
      promptInjection: { method: 'stdin' }, stateParsing: { idle: { type: 'timeout', ms: 100 } },
      quirks: { mcpAutoload: true, nexusMcp: 'autoload' }, control: {} });
    const spec = fixture.stores.missionPanes.record({ missionId: fixture.spec.missionId, paneId: 'native-original',
      adapterId: adapter.id, model: 'fixture-model', role: 'worker', workerIncarnationId: 'native-original-incarnation',
      agentName: 'Original worker',
      cwd: fixture.root, executionScope: fixture.scope, operatorOpened: operatorOpened || undefined,
      allowedTools: ['nexus_handoff_submit', 'nexus_worker_heartbeat'], allowedSkills: [], authoritySeal: fixture.spec.authoritySeal });
    saveProviderPaneSession(fixture.scope, spec.paneId!, adapter.id, { key: 'session_id', id: 'owned-native-conversation' });
    return { adapter, spec };
  }

  function spawnNative(adapter: import('../../shared/adapter-types').CliPtyAdapter,
    envelope: ReturnType<typeof authorizeMainOwnedAgentSpawn>, continuation?: NonNullable<ReturnType<typeof captureMissionPaneResume>['continuation']>) {
    const resolved = resolveMainOwnedAgentSpawn(fixture.owner, envelope, fixture.manager);
    const target = continuation ? assertWorkerContinuationCurrent(fixture.scope, continuation).claim.target! : undefined;
    const consumeProof = continuation && target ? workerContinuationPhysicalProof(fixture.scope, continuation, target) : undefined;
    const spawned = pty.spawnAgentSession(fixture.owner, resolved.request, adapter, { binPath: process.execPath,
      ...(continuation && target ? {
        assertDeferredSpawnCurrent: () => assertMainOwnedAgentSpawnGrantActive({ owner: fixture.owner,
          requestId: resolved.request.orchRequestId, pending: resolved.pending, recovery: null, runtimeManager: fixture.manager }),
        onSpawnSessionAllocated: (sessionId: string) => bindWorkerContinuationSession(fixture.scope, continuation, target, sessionId),
        onNativeBirthAuthorized: () => authorizeWorkerContinuationBirth(fixture.scope, continuation, target),
        onPhysicalTerminationProof: (sessionId: string, proof: import('../pty/pty-descendant-termination').PtyProcessTreeTerminationProof) => {
          rawProofs.push({ ok: proof.ok, rootExited: proof.rootExited, descendantsExited: proof.descendantsExited });
          consumeProof!(sessionId, proof);
        },
      } : {}),
    }, resolved.authority);
    owned.add(spawned.sessionId);
    if (resolved.pending) {
      bindPendingSpawnSessionForNative(resolved.request.orchRequestId!, fixture.owner, spawned.sessionId);
    }
    syncPanes([...owned].flatMap(sessionId => {
      const agent = pty.getAgentSessionInfo(sessionId);
      return agent?.paneId ? [{ paneId: agent.paneId, sessionId,
        kind: 'cli-agent' as const, title: 'Owned fixture', adapterId: agent.adapterId }] : [];
    }), fixture.owner);
    attachOrchMeta(fixture.owner, resolved.request.paneId!, { scope: fixture.scope, missionId: fixture.spec.missionId,
      role: resolved.authority.context!.role,
      workerIncarnationId: resolved.authority.context!.workerIncarnationId,
      operatorOpened: resolved.authority.context!.operatorOpened });
    return spawned.sessionId;
  }

  async function cleanup(sessionId: string) {
    const stopped = await pty.orchTerminateSession(sessionId, { origin: 'F-1151:owned-native-control' });
    if (!stopped || pty.getSessionState(sessionId) !== null) throw new Error('owned native control cleanup did not finish');
    owned.delete(sessionId);
  }

  async function continuation(native: Awaited<ReturnType<typeof source>>, pendingAck = false, expectBirth = true) {
    const captured = captureMissionPaneResume(fixture.scope, native.spec.missionId, native.spec.paneId, {});
    void requestPaneSpawn({ ...captured.spec, workerContinuation: captured.continuation,
      resumeFromPaneId: native.spec.paneId, resume: true, [PENDING_SPAWN_RESULT]: true });
    const request = fixture.owner.send.mock.calls.filter(call => call[0] === ORCH_CHANNELS.paneSpawnRequest).at(-1)![1] as OrchPaneSpawnRequest;
    fixture.requests.push(request);
    const envelope = authorizeMainOwnedAgentSpawn(fixture.owner, { kind: 'cli-agent', cols: 120, rows: 36,
      adapterId: request.adapterId, model: request.model, cwd: request.cwd, paneId: request.paneId,
      missionId: request.missionId, orchRequestId: request.requestId }, fixture.manager);
    if (pendingAck) expect(resolvePaneSpawn({ requestId: request.requestId, paneId: request.paneId,
      ok: true, pending: true, sessionId: null }, fixture.owner)).toBe(true);
    const sessionId = spawnNative(native.adapter, envelope, captured.continuation);
    if (expectBirth) await waitForBirth(sessionId);
    return { captured, request, sessionId };
  }

  function commitNative(native: Awaited<ReturnType<typeof source>>, flow: Awaited<ReturnType<typeof continuation>>) {
    const physical = pty.getAgentSessionInfo(flow.sessionId);
    if (!physical || physical.paneId !== flow.request.paneId || physical.role !== 'worker' ||
        !physical.workerIncarnationId) throw new Error('actual Main worker identity missing at native continuation commit');
    const recorded = commitWorkerContinuation(fixture.scope, flow.captured.continuation!, {
      missionId: native.spec.missionId, adapterId: native.spec.adapterId, paneId: flow.request.paneId,
      model: native.spec.model, accountId: native.spec.accountId, effort: native.spec.effort,
      cwd: physical.cwd, executionScope: native.spec.executionScope, title: native.spec.title,
      role: 'worker', workerIncarnationId: physical.workerIncarnationId, visualTask: native.spec.visualTask,
      readOnly: physical.readOnly, operatorOpened: physical.operatorOpened,
      allowedTools: physical.allowedTools, allowedSkills: physical.allowedSkills, authoritySeal: native.spec.authoritySeal,
    }, flow.sessionId);
    expect(resolvePaneSpawn({ requestId: flow.request.requestId, ok: true,
      paneId: flow.request.paneId, sessionId: flow.sessionId }, fixture.owner)).toBe(true);
    return recorded;
  }

  it('a genuinely live manual original refuses explicit continuation without killing it', async () => {
    const native = await source(true);
    const request = { ...fixture.restore, adapterId: native.adapter.id, paneId: native.spec.paneId,
      model: native.spec.model, accountId: undefined, effort: undefined };
    const sessionId = spawnNative(native.adapter, authorizeMainOwnedAgentSpawn(fixture.owner, request, fixture.manager));
    try {
      await waitForBirth(sessionId);
      expect(() => captureMissionPaneResume(fixture.scope, native.spec.missionId, native.spec.paneId, {})).toThrow(/resume_source_live/);
      expect(pty.getAgentSessionInfo(sessionId)?.operatorOpened).toBe(true);
      expect(pty.getSessionState(sessionId)).not.toBeNull();
    } finally { await cleanup(sessionId); }
  });

  it('genuine full target cohort proof is persisted before cleanup returns and permits source retry after reopening', async () => {
    const native = await source();
    const { captured, sessionId } = await continuation(native);
    try {
      await waitForBirth(sessionId);
      expect(rollbackWorkerContinuationBeforeBirth(fixture.scope, captured.continuation!)).toBe(false);
    } finally { await cleanup(sessionId); }
    expect(rawProofs).toContainEqual({ ok: true, rootExited: true, descendantsExited: true });
    expect(fixture.stores.missionPanes.findByPaneId(native.spec.paneId!)?.workerContinuation)
      .toMatchObject({ state: 'released', outcome: 'physical-tree-exited', target: { sessionId } });
    await reopenStore();
    expect(captureMissionPaneResume(fixture.scope, native.spec.missionId, native.spec.paneId, {}).continuation).toBeDefined();
  });

  it('closed manual continuation keeps human lifetime through commit, machine teardown and return to user', async () => {
    const native = await source(true);
    const flow = await continuation(native, true);
    try {
      const recorded = commitNative(native, flow);
      expect(recorded.operatorOpened).toBe(true);
      expect(pty.getAgentSessionInfo(flow.sessionId)?.operatorOpened).toBe(true);
      fixture.stores.missions.setStatus(native.spec.missionId, 'failed');
      const { terminateMissionRuntime } = await import('./mission-runtime-termination');
      const result = await terminateMissionRuntime({ scope: fixture.scope, suite: fixture.stores,
        missionId: native.spec.missionId, reason: 'authority-revoked', collapsePanes: true });
      expect(result.ok).toBe(true);
      expect(pty.getSessionState(flow.sessionId)).not.toBeNull();
      expect(pty.getAgentSessionInfo(flow.sessionId)?.role).toBe('user');
      expect(pty.getAgentSessionInfo(flow.sessionId)?.missionId).toBeUndefined();
      expect(fixture.stores.missionPanes.findByPaneId(native.spec.paneId!)?.workerContinuation?.state).toBe('committed');
    } finally { await cleanup(flow.sessionId); }
    expect(rawProofs).toContainEqual({ ok: true, rootExited: true, descendantsExited: true });
  });

  it.runIf(process.platform === 'darwin')('genuine host preflight no-child proof survives reopen; missing session/TTL are not the proof', async () => {
    const failedHost = await ownedHost(true);
    pty.setPtyHost(failedHost.bridge.host);
    let flow: Awaited<ReturnType<typeof continuation>> | undefined;
    try {
      const native = await source();
      flow = await continuation(native, true, false);
      const deadline = Date.now() + 10_000;
      while (pty.getSessionState(flow.sessionId) !== null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      expect(pty.getSessionState(flow.sessionId)).toBeNull();
      expect(rawProofs).toContainEqual({ ok: true, rootExited: true, descendantsExited: true });
      expect(fixture.stores.missionPanes.findByPaneId(native.spec.paneId!)?.workerContinuation)
        .toMatchObject({ state: 'released', outcome: 'physical-tree-exited', target: { sessionId: flow.sessionId } });
      owned.delete(flow.sessionId);
      await reopenStore();
      expect(captureMissionPaneResume(fixture.scope, native.spec.missionId, native.spec.paneId, {}).continuation).toBeDefined();
    } finally {
      if (flow && owned.has(flow.sessionId)) await cleanup(flow.sessionId);
      failedHost.child.disconnect();
      await new Promise<void>(resolve => { if (failedHost.child.exitCode !== null) resolve(); else failedHost.child.once('exit', () => resolve()); });
      pty.setPtyHost(primaryBridge.host);
    }
  });

  it('replacement ordinary HTTP handoff and physical Maestro ACK settle only the original sealed task exactly once', async () => {
    const { listSquads, initSquadStore } = await import('./squad-store');
    initSquadStore(null);
    const { snapshotSquadAuthority } = await import('./squad-authority-snapshot');
    const squad = listSquads().find(row => row.agents.some(agent => agent.category === 'executor'));
    if (!squad) throw new Error('real bundled executor roster is required for sealed-task control');
    const agent = squad.agents.find(row => row.category === 'executor')!;
    const mission = fixture.stores.missions.create({ title: 'Original assignment', squadId: squad.id,
      intentVersion: 1, intentState: 'executing', intentContract: {
        ...compileIntentContract({ goal: 'Original assignment', intentVersion: 1 }), freeAgentChoice: true,
        approvedAt: 10, dispatchedAt: 11, squadRevisionHash: snapshotSquadAuthority(squad).hash } });
    fixture.stores.missions.setStatus(mission.id, 'running');
    fixture.spec = { ...fixture.spec, missionId: mission.id, authoritySeal: resolveCurrentMissionSpawnAuthoritySeal(fixture.scope, mission.id) };
    const tasks = fixture.stores.tasks.createPlanAtomically({ missionId: mission.id, intentVersion: 1,
      squad: { id: squad.id, agents: squad.agents }, rows: [
        { plannerId: 'original-unit', title: 'Original assignment', detail: 'Return the original bounded fixture result.', agentRef: agent.id, agentCategory: 'executor' },
        { plannerId: 'unrelated-unit', title: 'Unrelated work remains pending', detail: 'Must not be settled by this continuation.', agentRef: agent.id, agentCategory: 'executor' },
      ] });
    const original = tasks.find(row => row.title === 'Original assignment')!;
    const unrelated = tasks.find(row => row.title === 'Unrelated work remains pending')!;
    fixture.stores.tasks.advanceSealedTaskStatus(original.id, 'running');
    const planBefore = binding.db!.prepare('SELECT * FROM mission_task_plans WHERE mission_id = ?').get(mission.id);
    const native = await source();
    const mcp = await import('./mcp-server');
    const { configureAuditLogRuntime, disposeAuditLogRuntime } = await import('../jarvis/audit-log');
    configureAuditLogRuntime(fixture.manager);
    await mcp.startMcpServer();
    const { getContextBySession } = await import('./gate');
    let replacement: Awaited<ReturnType<typeof continuation>> | undefined;
    let leaderSession: string | undefined;
    const post = async (sessionId: string, name: string, args: Record<string, unknown>, id = 1) => {
      const ctx = getContextBySession(sessionId);
      if (!ctx) throw new Error('actual Main-minted context unavailable for ordinary native MCP call');
      const response = await fetch(mcp.getMcpRuntimeInfo().url!, { method: 'POST',
        headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
      const payload = await response.json() as { result?: { isError?: boolean; content?: Array<{text?: string}> }; error?: {message?: string} };
      if (!response.ok || payload.error || payload.result?.isError) throw new Error(`ordinary ${name} refused: ${payload.error?.message ?? payload.result?.content?.[0]?.text ?? response.status}`);
      return JSON.parse(payload.result!.content![0]!.text!);
    };
    try {
      const originalEnvelope = authorizeMainOwnedAgentSpawn(fixture.owner, { kind: 'cli-agent', cols: 120, rows: 36,
        adapterId: native.adapter.id, model: native.spec.model, paneId: native.spec.paneId,
        missionId: mission.id, cwd: fixture.root, resume: true }, fixture.manager);
      const originalSession = spawnNative(native.adapter, originalEnvelope);
      await waitForBirth(originalSession);
      await cleanup(originalSession);
      binding.db!.prepare(`INSERT INTO task_dispatch_queue (id, task_id, mission_id, intent_version, state,
        lease_token_hash, lease_owner, lease_expires_at, worker_id, pane_id, session_id,
        worker_incarnation_id, created_at, updated_at)
        VALUES ('native-original-dispatch', ?, ?, 1, 'running', ?, 'main', ?, 'Original worker', ?, ?, ?, 1, 1)`)
        .run(original.id, mission.id, 'c'.repeat(64), Date.now() + 60_000, native.spec.paneId,
          originalSession, native.spec.workerIncarnationId);
      const leader = fixture.stores.missionPanes.record({ missionId: mission.id, paneId: 'native-maestro', adapterId: native.adapter.id,
        model: native.spec.model, agentName: 'Maestro', role: 'orchestrator', cwd: fixture.root,
        executionScope: fixture.scope, allowedTools: ['nexus_handoff_list', 'nexus_handoff_ack', 'nexus_pane_whoami'],
        allowedSkills: [], authoritySeal: native.spec.authoritySeal });
      saveProviderPaneSession(fixture.scope, leader.paneId!, native.adapter.id, { key: 'session_id', id: 'owned-maestro-conversation' });
      leaderSession = spawnNative(native.adapter, authorizeMainOwnedAgentSpawn(fixture.owner, { kind: 'cli-agent', cols: 120, rows: 36,
        adapterId: native.adapter.id, model: native.spec.model, paneId: leader.paneId,
        missionId: mission.id, cwd: fixture.root, resume: true }, fixture.manager));
      await waitForBirth(leaderSession);
      fixture.stores.missions.setOrchestratorSession(mission.id, leaderSession);
      replacement = await continuation(native, true);
      const target = commitNative(native, replacement);
      const ctx = getContextBySession(replacement.sessionId);
      if (!ctx || ctx.workerIncarnationId !== target.workerIncarnationId) throw new Error('replacement Main context lost its real incarnation');
      const heartbeat = await post(replacement.sessionId, 'nexus_worker_heartbeat', {}, 10);
      expect(heartbeat.taskId).toBe(original.id);
      const who = await post(replacement.sessionId, 'nexus_pane_whoami', {}, 11);
      expect(who).toMatchObject({ sessionId: replacement.sessionId, missionId: mission.id, role: 'worker' });
      const report = { status: 'success', summary: 'Original assignment: bounded fixture result delivered.',
        fullText: 'Original assignment was continued in the exact native context. This is the owned fixture result.', filesModified: [] };
      const submitted = await post(replacement.sessionId, 'nexus_handoff_submit', report, 12);
      const handoffId = submitted.handoffId ?? submitted.id;
      if (typeof handoffId !== 'string') throw new Error('ordinary handoff response did not identify its accepted handoff');
      await post(leaderSession, 'nexus_handoff_list', { full: true }, 20);
      await post(leaderSession, 'nexus_handoff_ack', { handoffId }, 21);
      const settled = fixture.stores.tasks.list(mission.id);
      expect(settled.find(row => row.id === original.id)).toMatchObject({ id: original.id, title: original.title, status: 'done' });
      expect(settled.find(row => row.id === unrelated.id)).toMatchObject({ id: unrelated.id, status: 'pending' });
      expect(binding.db!.prepare('SELECT * FROM mission_task_plans WHERE mission_id = ?').get(mission.id)).toEqual(planBefore);
      expect(fixture.stores.taskDispatches.get(original.id)).toMatchObject({ taskId: original.id,
        paneId: target.paneId, sessionId: replacement.sessionId, workerIncarnationId: target.workerIncarnationId, handoffId });
      await post(replacement.sessionId, 'nexus_handoff_submit', report, 12);
      await post(leaderSession, 'nexus_handoff_ack', { handoffId }, 21);
      expect(fixture.stores.tasks.list(mission.id).find(row => row.id === unrelated.id)?.status).toBe('pending');
      expect(binding.db!.prepare('SELECT COUNT(*) AS n FROM handoff_ack_receipts WHERE handoff_id = ?').get(handoffId)).toEqual({ n: 1 });
    } finally {
      if (replacement && owned.has(replacement.sessionId)) await cleanup(replacement.sessionId);
      if (leaderSession && owned.has(leaderSession)) await cleanup(leaderSession);
      await mcp.stopMcpServer();
      disposeAuditLogRuntime();
    }
  }, 30_000);

  it('normal graceful shutdown joins pending ACK to full target proof before stores close and reopens retryable source', async () => {
    const native = await source();
    const flow = await continuation(native, true);
    try {
      const result = await pty.terminateAllSessions({ origin: 'F-1151:owned-graceful-restart' });
      expect(result.ok).toBe(true);
      expect(rawProofs).toContainEqual({ ok: true, rootExited: true, descendantsExited: true });
      expect(fixture.stores.missionPanes.findByPaneId(native.spec.paneId!)?.workerContinuation)
        .toMatchObject({ state: 'released', outcome: 'physical-tree-exited', target: { sessionId: flow.sessionId } });
      owned.delete(flow.sessionId);
      await reopenStore();
      expect(captureMissionPaneResume(fixture.scope, native.spec.missionId, native.spec.paneId, {}).continuation).toBeDefined();
    } finally {
      if (owned.has(flow.sessionId)) await cleanup(flow.sessionId);
      pty.__resetPtyShutdownLifecycleForTests();
    }
  });
});

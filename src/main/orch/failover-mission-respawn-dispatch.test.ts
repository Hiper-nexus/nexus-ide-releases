/**
 * F-1480: a troca de conta do worker headless leva a tarefa despachada junto —
 * stores REAIS (missão, composição e fila de despacho em SQLite): depois da
 * troca, o heartbeat de lease do pane novo renova a tarefa e o da sessão
 * exausta é recusado; a composição ganha o pane novo no mesmo modelo/esforço.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchPaneSpawnResult } from '../../shared/orch-types';

const h = vi.hoisted(() => ({
  panes: new Map<string, unknown>(),
  spawn: vi.fn<(options: Record<string, unknown>) => Promise<OrchPaneSpawnResult>>(),
  terminate: vi.fn(async () => true),
}));

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
vi.mock('./jev-mission-advisor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev-mission-advisor')>()),
  scheduleRecoveryAdvice: vi.fn(),
}));
vi.mock('./main-owned-pane-runtime', () => ({
  getMainOwnedPane: (paneId: string) => h.panes.get(paneId),
  deleteMainOwnedPane: (paneId: string) => h.panes.delete(paneId),
}));
vi.mock('./pane-registry', () => ({ spawnMainOwnedMissionPaneAsync: h.spawn }));
vi.mock('./pane-session-output', () => ({ markPaneDeliberatelyClosed: vi.fn() }));
// F-1512: o canal do pacote de cada CLI vem do manifesto builtin real (Kimi cola).
vi.mock('../adapters/adapter-registry', async (importOriginal) => {
  const { BUILTIN_ADAPTERS } = await import('../../adapters/builtin');
  const { adapterSchema } = await import('../../shared/adapter-types');
  return {
    ...(await importOriginal<typeof import('../adapters/adapter-registry')>()),
    getAdapter: (id: string) => {
      const raw = BUILTIN_ADAPTERS.find((entry) => (entry as { id?: unknown }).id === id);
      return raw ? adapterSchema.parse(raw) : null;
    },
  };
});
vi.mock('../pty/pty-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pty/pty-manager')>()),
  orchTerminateSession: h.terminate,
  getSessionCwd: () => null,
  getAgentSessionInfo: (sessionId: string) =>
    sessionId === 'old-session' ? { requestedModel: 'claude-sonnet-x', effort: 'high' } : null,
}));

import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
} from './project-domain-store-registry';
import { compileIntentContract } from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';
import { respawnMainOwnedPaneWithAccount } from './failover-mission-respawn';

let root: string;
let manager: ProjectRuntimeManager;
let scope: ReturnType<typeof testProjectScope>;
let missionId: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f1480-dispatch-')));
  scope = testProjectScope({ rootRealPath: root });
  manager = new ProjectRuntimeManager({ baseDir: path.join(root, 'runtime'), appVersion: 'test' });
  configureProjectDomainStoreRegistry(manager);
  const stores = getProjectDomainStores(scope);
  const contract = { ...compileIntentContract({ goal: 'Trocar de conta sem perder a tarefa', intentVersion: 1 }),
    freeAgentChoice: true, approvedAt: 10, dispatchedAt: 11 };
  const mission = stores.missions.create({ title: 'F-1480', intentVersion: 1, intentState: 'executing',
    intentContract: contract });
  stores.missions.setStatus(mission.id, 'running');
  missionId = mission.id;
  stores.missionPanes.record({ missionId, paneId: 'old-pane', adapterId: 'claude', model: 'claude-sonnet-x',
    accountId: 'account-a', effort: 'high', cwd: root, executionScope: scope, role: 'worker',
    title: 'Implementar motor', agentName: 'Implementar motor', workerIncarnationId: 'workerinc-old',
    allowedTools: ['nexus_handoff_submit', 'nexus_worker_heartbeat'], allowedSkills: [] });
  const db = manager.open(scope).db;
  db.prepare(`INSERT INTO tasks (id, mission_id, title, detail, status, priority, created_at, updated_at)
    VALUES ('task-1', ?, 'Implementar motor', '', 'running', 0, 1, 1)`).run(missionId);
  db.prepare(`INSERT INTO task_dispatch_queue (id, task_id, mission_id, intent_version, state,
    lease_token_hash, lease_owner, lease_expires_at, worker_id, pane_id, session_id,
    worker_incarnation_id, created_at, updated_at)
    VALUES ('dispatch-1', 'task-1', ?, 1, 'running', ?, 'main', ?, 'Implementar motor', 'old-pane',
    'old-session', 'workerinc-old', 1, 1)`).run(missionId, 'c'.repeat(64), Date.now() + 60_000);
  const meta = { missionId, role: 'worker' as const, agentName: 'Implementar motor', workerIncarnationId: 'workerinc-old',
    allowedTools: ['nexus_handoff_submit', 'nexus_worker_heartbeat'], allowedSkills: [], readOnly: false,
    scope, executionScope: scope };
  h.panes.clear();
  h.panes.set('old-pane', { entry: { paneId: 'old-pane', sessionId: 'old-session', adapterId: 'claude',
    model: 'claude-sonnet-x', accountId: 'account-a' }, meta });
  h.spawn.mockReset();
  h.spawn.mockImplementation(async (options) => {
    h.panes.set('new-pane', { entry: { paneId: 'new-pane', sessionId: 'new-session', adapterId: 'claude',
      model: options.model, accountId: options.accountId }, meta: { ...meta,
      workerIncarnationId: options.workerIncarnationId } });
    return { requestId: 'spawn', ok: true, paneId: 'new-pane', sessionId: 'new-session' };
  });
  h.terminate.mockClear();
});

afterEach(async () => {
  await disposeProjectDomainStoreRegistry();
  manager.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('F-1480: tarefa despachada atravessa a troca de conta (stores reais)', () => {
  it('heartbeat do pane novo renova a tarefa; o da sessão exausta é recusado', async () => {
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'claude', toAccountId: 'account-b',
      fromAccountLabel: 'fixture-a', reason: 'usage limit', limitKind: 'rate-limit',
      touchedFiles: [], diffStat: undefined,
    })).resolves.toBe(true);
    const options = h.spawn.mock.calls[0]![0] as { workerIncarnationId: string; model?: string; effort?: string };
    expect(options).toMatchObject({ model: 'claude-sonnet-x', effort: 'high', accountId: 'account-b' });
    const stores = getProjectDomainStores(scope);
    const renewed = stores.taskDispatches.heartbeat({ sessionId: 'new-session', missionId,
      workerIncarnationId: options.workerIncarnationId, leaseMs: 60_000 });
    expect(renewed).toMatchObject({ taskId: 'task-1', paneId: 'new-pane', sessionId: 'new-session',
      workerIncarnationId: options.workerIncarnationId, state: 'running' });
    expect(() => stores.taskDispatches.heartbeat({ sessionId: 'old-session', missionId,
      workerIncarnationId: 'workerinc-old', leaseMs: 60_000 })).toThrow(/nenhum dispatch running/);
    // A composição ganha o pane novo no mesmo modelo/esforço; a linha antiga fica no histórico.
    expect(stores.missionPanes.findByPaneId('new-pane')).toMatchObject({ model: 'claude-sonnet-x',
      effort: 'high', accountId: 'account-b', workerIncarnationId: options.workerIncarnationId, role: 'worker' });
    expect(stores.missionPanes.findByPaneId('old-pane')).toMatchObject({ accountId: 'account-a' });
  });

  it('F-1512: o substituto já tem o dispatch quando recebe o pacote (heartbeat e handoff acham a tarefa)', async () => {
    const stores = getProjectDomainStores(scope);
    const duringBrief: Array<Record<string, unknown>> = [];
    const deliverBrief = vi.fn(async (sessionId: string) => {
      const incarnation = (h.spawn.mock.calls[0]![0] as { workerIncarnationId: string }).workerIncarnationId;
      // O que o handoff do substituto consulta (tools-handoff): o dispatch da sessão dele.
      const own = stores.taskDispatches.list(missionId).filter((row) => row.sessionId === sessionId);
      expect(own).toEqual([expect.objectContaining({ taskId: 'task-1', workerIncarnationId: incarnation, state: 'running' })]);
      duringBrief.push(stores.taskDispatches.heartbeat({ sessionId, missionId, workerIncarnationId: incarnation,
        leaseMs: 60_000 }) as unknown as Record<string, unknown>);
      return true;
    });
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'kimi', toAccountId: 'account-b',
      fromAccountLabel: 'fixture-a', reason: 'usage limit', touchedFiles: [], diffStat: undefined,
    }, { deliverBrief })).resolves.toBe(true);
    expect(deliverBrief).toHaveBeenCalledTimes(1);
    expect(duringBrief).toEqual([expect.objectContaining({ taskId: 'task-1', sessionId: 'new-session' })]);
    // O pacote vai antes de a origem sair: o dispatch passou antes dos dois.
    expect(deliverBrief.mock.invocationCallOrder[0]).toBeLessThan(h.terminate.mock.invocationCallOrder[0]!);
    expect(() => stores.taskDispatches.heartbeat({ sessionId: 'old-session', missionId,
      workerIncarnationId: 'workerinc-old', leaseMs: 60_000 })).toThrow(/nenhum dispatch running/);
  });

  it('F-1512: pacote recusado desfaz a troca e o dispatch volta à origem', async () => {
    const stores = getProjectDomainStores(scope);
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'kimi', toAccountId: 'account-b',
      fromAccountLabel: 'fixture-a', reason: 'usage limit', touchedFiles: [], diffStat: undefined,
    }, { deliverBrief: vi.fn(async () => false) })).resolves.toBe(false);
    const incarnation = (h.spawn.mock.calls[0]![0] as { workerIncarnationId: string }).workerIncarnationId;
    expect(stores.taskDispatches.heartbeat({ sessionId: 'old-session', missionId,
      workerIncarnationId: 'workerinc-old', leaseMs: 60_000 })).toMatchObject({ taskId: 'task-1', paneId: 'old-pane' });
    expect(() => stores.taskDispatches.heartbeat({ sessionId: 'new-session', missionId,
      workerIncarnationId: incarnation, leaseMs: 60_000 })).toThrow(/nenhum dispatch running/);
    expect(h.terminate).not.toHaveBeenCalledWith('old-session', expect.anything());
  });

  it('sem pane novo a tarefa continua com a sessão de antes (nada é movido)', async () => {
    h.spawn.mockReset();
    h.spawn.mockResolvedValue({ requestId: 'spawn', ok: false, error: 'auth refresh timeout' });
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'claude', toAccountId: 'account-b',
      fromAccountLabel: 'fixture-a', reason: 'usage limit', touchedFiles: [], diffStat: undefined,
    })).resolves.toBe(false);
    expect(h.terminate).not.toHaveBeenCalled();
    expect(getProjectDomainStores(scope).taskDispatches.heartbeat({ sessionId: 'old-session', missionId,
      workerIncarnationId: 'workerinc-old', leaseMs: 60_000 })).toMatchObject({ taskId: 'task-1' });
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as pty from '../pty/pty-manager';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionPaneStore } from './mission-pane-store';
import { createScopedMissionStore } from './mission-store';
import { requestMissionPaneRecovery } from './pane-registry';
import { switchRendererOrchestratorAccount, type OrchestratorAccountSwitchDeps } from './failover-orchestrator-respawn';

// License/auth is outside this regression; keep the SQLite write and recovery real.
vi.mock('../license-access', async () => {
  const { licensedAccessMock } = await import('../__tests__/licensed-access');
  return licensedAccessMock;
});

const fixtures: Array<{ manager: ProjectRuntimeManager; root: string }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { manager, root } of fixtures.splice(0)) {
    manager.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f1054-'));
  const manager = new ProjectRuntimeManager({ baseDir: root, appVersion: '0.76.212-test' });
  fixtures.push({ manager, root });
  const scope = testProjectScope();
  const mission = createScopedMissionStore(manager, scope).create({ title: 'Account refusal' });
  const panes = createScopedMissionPaneStore(manager, scope);
  const original = panes.record({
    missionId: mission.id, paneId: 'pane-f1054', adapterId: 'claude',
    accountId: 'account-a', model: 'claude-opus-5-5', cwd: scope.rootRealPath,
    title: 'Operator', role: 'orchestrator', agentName: 'Orquestrador',
  });
  const physical: pty.OwnedAgentSessionInfo = {
    sessionId: 'pty-original-a', paneId: 'pane-f1054', adapterId: 'claude',
    accountId: 'account-a', model: 'claude-opus-5-5', cwd: scope.rootRealPath,
    scope, source: 'persisted-pane', missionId: mission.id, role: 'orchestrator',
    readOnly: false, allowedTools: null, allowedSkills: null,
  };
  const inventory = vi.spyOn(pty, 'listAgentSessionsForPane').mockReturnValue([physical]);
  const writable = vi.spyOn(pty, 'isPtySessionConnectedAndWritable').mockReturnValue(true);
  const input = {
    scope, missionId: mission.id, paneId: 'pane-f1054', sessionId: 'pty-original-a',
    toAccountId: 'account-b', buildRecap: () => 'Continue the mission.',
  };
  const deps = {
    findSpec: (_scope, paneId) => panes.findByPaneId(paneId),
    rebindAccount: (_scope, missionId, paneId, expected, accountId) =>
      panes.rebindPaneAccount(missionId, paneId, expected, accountId),
    requestRecovery: requestMissionPaneRecovery,
  } satisfies OrchestratorAccountSwitchDeps;
  const persisted = () => createScopedMissionPaneStore(manager, scope).findByPaneId('pane-f1054');
  return { original, physical, inventory, writable, input, deps, panes, persisted };
}

describe('F-1131: account switch refused before replacement', () => {
  it('keeps the durable contract on A when Main has no renderer and the original PTY remains writable', async () => {
    const f = fixture();
    // Real recovery refuses before issuing a grant or terminating the original.
    await expect(switchRendererOrchestratorAccount(f.input, f.deps)).resolves.toMatchObject({
      handled: true, ok: false, error: 'mission pane renderer is unavailable',
    });
    expect(f.persisted()).toEqual(f.original);
    expect(f.physical).toMatchObject({ sessionId: 'pty-original-a', accountId: 'account-a' });
  });

  it('compensates a pre-exit scope refusal after the real durable A to B write', async () => {
    const f = fixture();
    f.deps.requestRecovery = async () => {
      expect(f.persisted()?.accountId).toBe('account-b');
      return { requestId: '', paneId: 'pane-f1054', ok: false, error: 'mission pane renderer scope changed' };
    };
    await switchRendererOrchestratorAccount(f.input, f.deps);
    expect(f.persisted()).toEqual(f.original);
  });

  it('never compensates a timed-out grant that may still bind a late replacement', async () => {
    const f = fixture();
    f.deps.requestRecovery = async () => ({
      requestId: 'panerecovery-late', paneId: 'pane-f1054', ok: false, error: 'pane recovery timed out',
    });
    await switchRendererOrchestratorAccount(f.input, f.deps);
    expect(f.persisted()?.accountId).toBe('account-b');
  });

  it('does not borrow an empty-request refusal for another pane', async () => {
    const f = fixture();
    f.deps.requestRecovery = async () => ({ requestId: '', paneId: 'another-pane', ok: false, error: 'renderer unavailable' });
    await switchRendererOrchestratorAccount(f.input, f.deps);
    expect(f.persisted()?.accountId).toBe('account-b');
  });

  it('never compensates a replacement B already in the physical inventory', async () => {
    const f = fixture();
    f.inventory.mockReturnValue([f.physical, { ...f.physical, sessionId: 'pty-replacement-b', accountId: 'account-b' }]);
    await switchRendererOrchestratorAccount(f.input, f.deps);
    expect(f.persisted()?.accountId).toBe('account-b');
  });

  it('never compensates an original PTY without connected and writable proof', async () => {
    const f = fixture();
    f.writable.mockReturnValue(false);
    await switchRendererOrchestratorAccount(f.input, f.deps);
    expect(f.persisted()?.accountId).toBe('account-b');
  });

  it.each(['session', 'mission', 'adapter', 'account', 'scope'] as const)(
    'does not compensate when the physical %s no longer matches the old A runtime', async field => {
      const f = fixture();
      if (field === 'session') f.physical.sessionId = 'pty-another';
      if (field === 'mission') f.physical.missionId = 'mission-another';
      if (field === 'adapter') f.physical.adapterId = 'codex';
      if (field === 'account') f.physical.accountId = 'account-c';
      if (field === 'scope') f.physical.scope = { ...f.input.scope, rootRealPath: '/workspace/other' };
      await switchRendererOrchestratorAccount(f.input, f.deps);
      expect(f.persisted()?.accountId).toBe('account-b');
    },
  );

  it('uses coordination identity for the old A runtime executing in a tab worktree', async () => {
    const f = fixture();
    f.physical.coordinationScope = f.input.scope;
    f.physical.scope = { ...f.input.scope, rootRealPath: '/workspace/tab-worktree' };
    await switchRendererOrchestratorAccount(f.input, f.deps);
    expect(f.persisted()).toEqual(f.original);
  });

  it('preserves a concurrent account C chosen before the refused recovery returns', async () => {
    const f = fixture();
    f.deps.requestRecovery = async () => {
      f.panes.rebindPaneAccount(f.input.missionId, 'pane-f1054', 'account-b', 'account-c');
      return { requestId: '', paneId: 'pane-f1054', ok: false, error: 'mission pane renderer scope changed' };
    };
    await switchRendererOrchestratorAccount(f.input, f.deps);
    expect(f.persisted()?.accountId).toBe('account-c');
  });

  it('does not infer no effect from a recovery exception', async () => {
    const f = fixture();
    f.deps.requestRecovery = async () => { throw new Error('transport failed after dispatch'); };
    await switchRendererOrchestratorAccount(f.input, f.deps);
    expect(f.persisted()?.accountId).toBe('account-b');
  });
});

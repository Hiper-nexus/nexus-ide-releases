import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchPaneSpawnResult } from '../../shared/orch-types';
const deps = vi.hoisted(() => ({
  getPane: vi.fn(),
  spawnSync: vi.fn(() => ({ requestId: 'sync', ok: true, paneId: 'sync-pane', sessionId: 'sync-session' })),
  spawnAsync: vi.fn<(...args: unknown[]) => Promise<OrchPaneSpawnResult>>(),
  terminate: vi.fn(async () => true),
}));
vi.mock('./main-owned-pane-runtime', () => ({ getMainOwnedPane: deps.getPane }));
vi.mock('./pane-registry', () => ({
  spawnMainOwnedMissionPane: deps.spawnSync,
  spawnMainOwnedMissionPaneAsync: deps.spawnAsync,
}));
vi.mock('../pty/pty-manager', () => ({ orchTerminateSession: deps.terminate }));

import { planMainOwnedFailoverRespawn, respawnMainOwnedPaneWithAccount } from './failover-mission-respawn';

const meta = {
  missionId: 'mission-1',
  role: 'worker' as const,
  agentName: 'Implementar motor',
  contextRevision: 'rev-1',
  allowedTools: null,
  allowedSkills: [],
  readOnly: false,
};

describe('planMainOwnedFailoverRespawn (failover de conta em pane de missão)', () => {
  it('planeia respawn com a nova conta pinada e nota de continuidade', () => {
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'claude',
      meta,
      toAccountId: 'acct-2',
      fromAccountLabel: 'Pessoal',
      reason: 'rate-limit',
    });
    expect(plan.action).toBe('respawn');
    if (plan.action !== 'respawn') return;
    expect(plan.options.accountId).toBe('acct-2');
    expect(plan.options.missionId).toBe('mission-1');
    expect(plan.options.role).toBe('worker');
    expect(plan.options.agentName).toBe('Implementar motor');
    expect(plan.options.initialPrompt).toContain('Pessoal');
    expect(plan.options.initialPrompt).toContain('rate-limit');
    expect(plan.options.initialPrompt).toContain('continuar a tarefa');
    // encarnação NOVA: workerIncarnationId não é herdado do processo morto
    expect(plan.options.workerIncarnationId).toBeUndefined();
  });

  it('pula pane sem missão (não é worker de missão main-owned)', () => {
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'claude',
      meta: { ...meta, missionId: undefined, role: undefined },
      toAccountId: 'acct-2',
      fromAccountLabel: 'Pessoal',
      reason: 'quota',
    });
    expect(plan).toMatchObject({ action: 'skip' });
  });

  it('pula meta ausente (pane main-owned não registrado)', () => {
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'claude',
      meta: null,
      toAccountId: 'acct-2',
      fromAccountLabel: 'Pessoal',
      reason: 'auth',
    });
    expect(plan).toMatchObject({ action: 'skip' });
  });
});

describe('respawnMainOwnedPaneWithAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.spawnAsync.mockReset();
    deps.getPane.mockReturnValue({ meta });
  });

  it('waits for the asynchronous account gate before reporting a successful failover', async () => {
    let release!: (result: OrchPaneSpawnResult) => void;
    deps.spawnAsync.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    let finished = false;
    const result = respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', adapterId: 'codex', toAccountId: 'account-reserve',
      fromAccountLabel: 'synthetic', reason: 'quota',
    }).then((value) => { finished = true; return value; });
    expect(deps.spawnAsync).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-reserve', adapterId: 'codex' }));
    expect(deps.spawnSync).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    release({ requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    await expect(result).resolves.toBe(true);
  });

  it('reports an auth gate refusal as failed failover', async () => {
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'async', ok: false, error: 'auth refresh timeout' });
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', adapterId: 'codex', toAccountId: 'account-reserve',
      fromAccountLabel: 'synthetic', reason: 'quota',
    })).resolves.toBe(false);
    expect(deps.spawnSync).not.toHaveBeenCalled();
  });
});

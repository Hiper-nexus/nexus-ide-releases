import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchPaneSpawnResult } from '../../shared/orch-types';
const deps = vi.hoisted(() => ({
  getPane: vi.fn(),
  spawnSync: vi.fn(() => ({ requestId: 'sync', ok: true, paneId: 'sync-pane', sessionId: 'sync-session' })),
  spawnAsync: vi.fn<(...args: unknown[]) => Promise<OrchPaneSpawnResult>>(),
  terminate: vi.fn(async () => true),
  collectFiles: vi.fn(() => ['src/a.ts', 'src/b.ts']),
}));
vi.mock('./main-owned-pane-runtime', () => ({ getMainOwnedPane: deps.getPane }));
vi.mock('./pane-registry', () => ({
  spawnMainOwnedMissionPane: deps.spawnSync,
  spawnMainOwnedMissionPaneAsync: deps.spawnAsync,
}));
vi.mock('../pty/pty-manager', () => ({ orchTerminateSession: deps.terminate }));
vi.mock('./worker-files-modified', () => ({
  collectFilesModified: deps.collectFiles,
}));

import {
  planMainOwnedFailoverRespawn,
  respawnMainOwnedPaneWithAccount,
} from './failover-mission-respawn';
import {
  FAILOVER_HANDOFF_FOOTER,
  FAILOVER_HANDOFF_HEADER,
} from '../../shared/failover-handoff';
import { maskAccountLabel } from '../../shared/account-choice';
import { detectLimit } from './limit-detector';

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
  it('planeia respawn com a nova conta pinada e pacote de continuidade (F-775)', () => {
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'claude',
      meta,
      toAccountId: 'acct-2',
      toAccountLabel: 'ana.ops@example.org',
      fromAccountLabel: 'gustavo.lupygo@example.com',
      reason: 'rate limit exceeded',
      limitKind: 'rate-limit',
      limitWindow: '5 Horas',
      limitResetsAt: Date.UTC(2026, 9, 3, 18, 0, 0),
      taskBrief: 'Fechar o builder do pack',
      nextStep: 'Rodar os testes do pack',
      touchedFiles: ['src/shared/failover-handoff.ts'],
      diffStat: 'src/shared/failover-handoff.ts | 10 ++++++',
      scrollbackExcerpt: 'boot\n…\nAPI Error: 401 Unauthorized\ndied here',
    });
    expect(plan.action).toBe('respawn');
    if (plan.action !== 'respawn') return;
    // Conta pinada = recibo account-choice com source 'pinned'
    // (resolveSpawnAccountChoice grava 'pinned' quando accountId é explícito).
    expect(plan.options.accountId).toBe('acct-2');
    expect(plan.options.missionId).toBe('mission-1');
    expect(plan.options.role).toBe('worker');
    expect(plan.options.agentName).toBe('Implementar motor');
    const prompt = plan.options.initialPrompt ?? '';
    expect(prompt.startsWith(FAILOVER_HANDOFF_HEADER)).toBe(true);
    expect(prompt.endsWith(FAILOVER_HANDOFF_FOOTER)).toBe(true);
    expect(prompt).toContain(maskAccountLabel('gustavo.lupygo@example.com'));
    expect(prompt).toContain(maskAccountLabel('ana.ops@example.org'));
    expect(prompt).not.toContain('gustavo.lupygo@example.com');
    expect(prompt).toContain('kind rate-limit');
    expect(prompt).toContain('window 5 Horas');
    expect(prompt).toContain('src/shared/failover-handoff.ts');
    expect(prompt).toContain('Fechar o builder do pack');
    expect(prompt).toContain('Rodar os testes do pack');
    expect(prompt).toContain('died here');
    // Anti-loop F-511: o pack não re-arma o detector.
    expect(detectLimit(prompt)).toBeNull();
    expect(detectLimit(prompt.replace(FAILOVER_HANDOFF_HEADER, ''))).toBeNull();
    // encarnação NOVA: workerIncarnationId não é herdado do processo morto
    expect(plan.options.workerIncarnationId).toBeUndefined();
  });

  it('F-520: rotação de modelo mantém o prompt curto (sem pack cross-account)', () => {
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'claude',
      meta,
      toAccountId: 'acct-1',
      fromAccountLabel: 'Pessoal',
      reason: 'model requires a newer version',
      toModel: 'claude-sonnet-4-6',
    });
    expect(plan.action).toBe('respawn');
    if (plan.action !== 'respawn') return;
    expect(plan.options.initialPrompt).toContain('claude-sonnet-4-6');
    expect(plan.options.initialPrompt).not.toContain(FAILOVER_HANDOFF_HEADER);
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
    deps.collectFiles.mockReturnValue(['src/a.ts']);
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
    expect(finished).toBe(true);
  });

  it('reports an auth gate refusal as failed failover', async () => {
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'async', ok: false, error: 'auth refresh timeout' });
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', adapterId: 'codex', toAccountId: 'account-reserve',
      fromAccountLabel: 'synthetic', reason: 'quota',
    })).resolves.toBe(false);
    expect(deps.spawnSync).not.toHaveBeenCalled();
  });

  it('integração F-775: limite com 2 contas → pane novo recebe o pack e conta pinada (recibo pinned)', async () => {
    deps.spawnAsync.mockResolvedValueOnce({
      requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session',
    });
    const ok = await respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane',
      sessionId: 'old-session',
      adapterId: 'claude',
      toAccountId: 'account-b',
      toAccountLabel: 'reserve@example.org',
      fromAccountLabel: 'primary@example.com',
      reason: "You've hit your session limit",
      limitKind: 'rate-limit',
      limitWindow: 'Sessão',
      limitResetsAt: Date.UTC(2026, 9, 3, 20, 0, 0),
      taskBrief: 'Continuar F-775',
      nextStep: 'Validar o pack com detectLimit',
      scrollbackExcerpt: 'working…\nusage limit reached\ndeath',
      cwd: '/workspace/mission-checkout',
      // 2 contas: a exausta (primary) foi para cooldown; a reserva é pinada.
    });
    expect(ok).toBe(true);
    // Só depois do spawn real o caller emite switched:true (F-249).
    expect(deps.spawnAsync).toHaveBeenCalledTimes(1);
    const options = deps.spawnAsync.mock.calls[0][0] as {
      accountId: string;
      initialPrompt: string;
    };
    expect(options.accountId).toBe('account-b');
    expect(options.initialPrompt).toContain(FAILOVER_HANDOFF_HEADER);
    expect(options.initialPrompt).toContain('Validar o pack com detectLimit');
    expect(options.initialPrompt).toContain('src/a.ts');
    expect(detectLimit(options.initialPrompt)).toBeNull();
    // Termina a sessão exausta ANTES do spawn novo.
    expect(deps.terminate).toHaveBeenCalledWith(
      'old-session',
      expect.objectContaining({ origin: 'failover-respawn' }),
    );
  });
});

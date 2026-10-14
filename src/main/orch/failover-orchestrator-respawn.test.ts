import { describe, expect, it, vi } from 'vitest';
import type { MissionPaneSpec } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  switchRendererOrchestratorAccount,
  type OrchestratorAccountSwitchDeps,
} from './failover-orchestrator-respawn';

const scope = testProjectScope();

const operatorLeader: MissionPaneSpec = {
  id: 'mpane-operador',
  missionId: 'mission-23eee6e5',
  paneId: 'pane-12502a80',
  adapterId: 'claude',
  model: 'claude-opus-5-5',
  accountId: 'acct-co-claude',
  cwd: '/workspace/nexus',
  title: 'Claude',
  agentName: 'Orquestrador',
  role: 'orchestrator',
  createdAt: 1,
};

function deps(
  overrides: Partial<OrchestratorAccountSwitchDeps> = {},
): OrchestratorAccountSwitchDeps & {
  rebindAccount: ReturnType<typeof vi.fn>;
  requestRecovery: ReturnType<typeof vi.fn>;
} {
  return {
    findSpec: vi.fn(() => operatorLeader),
    rebindAccount: vi.fn(
      (_scope, _missionId, _paneId, _expected, accountId: string) => ({
        ...operatorLeader,
        accountId,
      }),
    ),
    requestRecovery: vi.fn(async () => ({
      requestId: 'panerecovery-1',
      ok: true,
      paneId: 'pane-12502a80',
      sessionId: 'pty-religado',
    })),
    ...overrides,
  } as never;
}

const input = {
  scope,
  missionId: 'mission-23eee6e5',
  paneId: 'pane-12502a80',
  sessionId: 'pty-muyltibz-3',
  toAccountId: 'acct-re-claude',
  buildRecap: () => '[NEXUS FAILOVER HANDOFF] recap',
};

describe('switchRendererOrchestratorAccount (F-995)', () => {
  it('troca a conta SELADA (CAS na conta esgotada) e religa o mesmo pane pela recuperação do orquestrador', async () => {
    const d = deps();
    await expect(switchRendererOrchestratorAccount(input, d)).resolves.toEqual({
      handled: true,
      ok: true,
      sessionId: 'pty-religado',
    });
    expect(d.rebindAccount).toHaveBeenCalledWith(
      scope,
      'mission-23eee6e5',
      'pane-12502a80',
      'acct-co-claude',
      'acct-re-claude',
    );
    expect(d.requestRecovery).toHaveBeenCalledWith({
      missionId: 'mission-23eee6e5',
      paneId: 'pane-12502a80',
      role: 'orchestrator',
      expectedSessionId: 'pty-muyltibz-3',
      pane: expect.objectContaining({ accountId: 'acct-re-claude', role: 'orchestrator' }),
      scope,
      recap: '[NEXUS FAILOVER HANDOFF] recap',
    });
  });

  it('pane que não é o orquestrador selado desta missão segue o caminho de sempre', async () => {
    for (const spec of [
      null,
      { ...operatorLeader, role: 'worker' as const },
      { ...operatorLeader, missionId: 'outra-missao' },
    ]) {
      const d = deps({ findSpec: vi.fn(() => spec) });
      await expect(switchRendererOrchestratorAccount(input, d)).resolves.toEqual({ handled: false });
      expect(d.rebindAccount).not.toHaveBeenCalled();
      expect(d.requestRecovery).not.toHaveBeenCalled();
    }
  });

  it('conta selada mudou no meio (CAS perdido): não religa nada', async () => {
    const d = deps({ rebindAccount: vi.fn(() => null) });
    await expect(switchRendererOrchestratorAccount(input, d)).resolves.toMatchObject({
      handled: true,
      ok: false,
    });
    expect(d.requestRecovery).not.toHaveBeenCalled();
  });

  it('recuperação recusada ou sem sessão nova não é sucesso', async () => {
    const refused = deps({
      requestRecovery: vi.fn(async () => ({
        requestId: '',
        ok: false,
        paneId: 'pane-12502a80',
        error: 'mission pane renderer is unavailable',
      })),
    });
    await expect(switchRendererOrchestratorAccount(input, refused)).resolves.toEqual({
      handled: true,
      ok: false,
      error: 'mission pane renderer is unavailable',
    });
    const sameSession = deps({
      requestRecovery: vi.fn(async () => ({
        requestId: 'r',
        ok: true,
        paneId: 'pane-12502a80',
        sessionId: 'pty-muyltibz-3',
      })),
    });
    await expect(switchRendererOrchestratorAccount(input, sameSession)).resolves.toMatchObject({
      handled: true,
      ok: false,
    });
  });
});

describe('F-1473: orquestrador Claude troca de conta e continua a MESMA conversa', () => {
  const resumeInput = { ...input, buildResumeNote: () => 'NOTA: mesma conversa' };

  it('com o histórico religado à conta nova, pede a retomada com a nota (o pacote vai de fallback)', async () => {
    const rebindSession = vi.fn(() => true);
    const d = deps({ rebindSession });
    await expect(switchRendererOrchestratorAccount(resumeInput, d)).resolves.toEqual({
      handled: true, ok: true, sessionId: 'pty-religado',
    });
    expect(rebindSession).toHaveBeenCalledWith(scope, 'pane-12502a80', 'claude', 'acct-co-claude', 'acct-re-claude');
    expect(d.requestRecovery).toHaveBeenCalledTimes(1);
    expect(d.requestRecovery).toHaveBeenCalledWith(expect.objectContaining({
      expectedSessionId: 'pty-muyltibz-3',
      pane: expect.objectContaining({ accountId: 'acct-re-claude' }),
      recap: '[NEXUS FAILOVER HANDOFF] recap',
      resumeNote: 'NOTA: mesma conversa',
    }));
  });

  it('retomada que não sobe depois do grant: refaz a troca com sessão nova + pacote, sem a nota', async () => {
    const requestRecovery = vi.fn()
      .mockResolvedValueOnce({ requestId: 'panerecovery-1', ok: false, paneId: 'pane-12502a80',
        sessionId: 'pty-resume-caiu', error: 'fresh pane session did not become healthy' })
      .mockResolvedValueOnce({ requestId: 'panerecovery-2', ok: true, paneId: 'pane-12502a80', sessionId: 'pty-pacote' });
    const d = deps({ rebindSession: vi.fn(() => true), requestRecovery });
    await expect(switchRendererOrchestratorAccount(resumeInput, d)).resolves.toEqual({
      handled: true, ok: true, sessionId: 'pty-pacote',
    });
    expect(requestRecovery).toHaveBeenCalledTimes(2);
    const fallback = requestRecovery.mock.calls[1]![0];
    expect(fallback).not.toHaveProperty('resumeNote');
    expect(fallback).toMatchObject({ expectedSessionId: 'pty-resume-caiu', recap: '[NEXUS FAILOVER HANDOFF] recap' });
  });

  it('conversa que não pôde ser religada: só o pacote, como antes', async () => {
    const d = deps({ rebindSession: vi.fn(() => false) });
    await expect(switchRendererOrchestratorAccount(resumeInput, d)).resolves.toMatchObject({ ok: true });
    expect(d.requestRecovery).toHaveBeenCalledTimes(1);
    expect(d.requestRecovery.mock.calls[0]![0]).not.toHaveProperty('resumeNote');
  });

  it('recusa antes do grant não é falha da retomada: nada é refeito', async () => {
    const requestRecovery = vi.fn(async () => ({
      requestId: '', ok: false, paneId: 'pane-12502a80', error: 'mission pane renderer is unavailable',
    }));
    const d = deps({ rebindSession: vi.fn(() => true), requestRecovery });
    await expect(switchRendererOrchestratorAccount(resumeInput, d)).resolves.toMatchObject({ ok: false });
    expect(requestRecovery).toHaveBeenCalledTimes(1);
  });
});

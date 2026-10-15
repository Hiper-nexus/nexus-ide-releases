import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreEffectRefusalError, type AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  assertCallerMaySpawnPane,
  coerceSpawnReadOnly,
  paneSpawnTool,
} from './tools-panes';
import {
  beginPaneSpawnRequest,
  paneSpawnRequestState,
  resetPaneSpawnRequestsForTests,
} from './pane-spawn-request-registry';
import * as domainStores from './project-domain-store-registry';

function context(
  overrides: Partial<AgentGateContext> = {},
): AgentGateContext {
  return {
    token: 'token',
    label: 'worker',
    role: 'worker',
    sessionId: 'session-worker',
    missionId: 'mission-1',
    scope: testProjectScope(),
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

describe('assertCallerMaySpawnPane', () => {
  it('recusa worker com erro visível — sem pane-neto', () => {
    expect(() => assertCallerMaySpawnPane('worker')).toThrow(
      /workers cannot create panes/i,
    );
  });

  it('deixa orquestrador e usuário spawnar (handoff do maestro intacto)', () => {
    expect(() => assertCallerMaySpawnPane('orchestrator')).not.toThrow();
    expect(() => assertCallerMaySpawnPane('user')).not.toThrow();
  });
});

describe('nexus_pane_spawn recusa worker antes de qualquer spawn', () => {
  it('worker → spawn pane falha visível (ad-hoc e agentName)', async () => {
    const worker = context();
    await expect(
      paneSpawnTool.handler({ adapterId: 'codex' }, worker),
    ).rejects.toThrow(/workers cannot create panes/i);
    await expect(
      paneSpawnTool.handler(
        { agentName: 'Executor', adapterId: 'codex' },
        worker,
      ),
    ).rejects.toThrow(/workers cannot create panes/i);
  });

  it('orquestrador não é cortado por este gate', async () => {
    try {
      await paneSpawnTool.handler(
        { adapterId: 'codex' },
        context({ role: 'orchestrator', label: 'orch' }),
      );
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toMatch(
        /workers cannot create panes/i,
      );
    }
  });
});

describe('nexus_pane_spawn — contrato de entrega (expect) falha visível antes do spawn', () => {
  it('expect malformado é recusado para o orquestrador antes de qualquer spawn', async () => {
    await expect(
      paneSpawnTool.handler(
        { adapterId: 'codex', expect: { schema: { type: 'lista' } } },
        context({ role: 'orchestrator', label: 'orch' }),
      ),
    ).rejects.toThrow(/expect\.schema inválido: .*tipo desconhecido/);
    await expect(
      paneSpawnTool.handler(
        { adapterId: 'codex', expect: { schema: true, retries: 7 } },
        context({ role: 'orchestrator', label: 'orch' }),
      ),
    ).rejects.toThrow(/expect\.retries inválido/);
  });
});

describe('nexus_pane_spawn — agentName sem squad (F-1334)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('recusa antes de qualquer efeito: o dispatcher não reporta efeito possível', async () => {
    vi.spyOn(domainStores, 'getProjectDomainStores').mockReturnValue({
      missions: { get: () => ({ id: 'mission-1', status: 'running' }) },
    } as never);

    const outcome = await paneSpawnTool
      .handler({ agentName: 'Executor' }, context({ role: 'orchestrator', label: 'orch' }))
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PreEffectRefusalError);
    // F-1314/F-1388: missão sem squad consulta o catálogo; nome desconhecido
    // recusa pre-effect com a mensagem específica, não a genérica de squad.
    expect((outcome as Error).message).toMatch(/unknown squad agent: Executor/);
  });
});

describe('F-1531: o mesmo requestId não abre um segundo pane', () => {
  beforeEach(() => {
    resetPaneSpawnRequestsForTests();
  });

  it('reenvio com o requestId em curso devolve o estado, sem tocar no spawn', async () => {
    // O primeiro pedido reservou o id e está no preparo pesado (rota/worktree).
    beginPaneSpawnRequest({ requestId: 'm:mission-1|w1-visual' });

    // Sem a deduplicação esta chamada iria ao spawn e MORRERIA (não há
    // runtime de pane no teste): voltar com o recibo prova que o Main
    // interceptou antes de qualquer efeito.
    const outcome = await paneSpawnTool.handler(
      { adapterId: 'codex', requestId: 'w1-visual' },
      context({ role: 'user', label: 'pane do operador' }),
    );

    expect(outcome).toMatchObject({
      ok: true,
      pending: true,
      deduplicated: true,
      inFlight: true,
      paneId: null,
      requestId: 'w1-visual',
    });
    expect(String((outcome as { note: string }).note)).toContain('nenhum pane novo foi aberto');
  });

  it('o mesmo requestId em outra missão é outro pedido e não devolve recibo alheio', async () => {
    beginPaneSpawnRequest({ requestId: 'm:mission-A|scout-1' });
    // Missão B manda o MESMO texto: não pode juntar-se ao pedido de A. O spawn
    // real morre neste teste (sem runtime), e isso é a prova de que não houve join.
    const outcome = await paneSpawnTool.handler(
      { adapterId: 'codex', requestId: 'scout-1' },
      context({ role: 'user', label: 'pane do operador', missionId: 'mission-B' }),
    ).then(
      (value) => value as { deduplicated?: boolean },
      () => ({ rejected: true }) as { deduplicated?: boolean },
    );
    expect(outcome.deduplicated).not.toBe(true);
  });

  it('erro antes do spawn (expect inválido) libera a chave em vez de prendê-la', async () => {
    await expect(
      paneSpawnTool.handler(
        { adapterId: 'codex', requestId: 'w2-erro', expect: 'isto-nao-e-um-contrato' },
        context({ role: 'user', label: 'pane do operador' }),
      ),
    ).rejects.toThrow();
    expect(paneSpawnRequestState('m:mission-1|w2-erro')).toBeNull();
  });

  it('requestId inválido é recusado antes de qualquer spawn', async () => {
    await expect(
      paneSpawnTool.handler(
        { adapterId: 'codex', requestId: 'orchspawn-falso' },
        context({ role: 'user', label: 'pane do operador' }),
      ),
    ).rejects.toThrow(/requestId inválido/);
    // Nada foi reservado: um id recusado não ocupa a chave.
    expect(paneSpawnRequestState('orchspawn-falso')).toBeNull();
  });
});

describe('coerceSpawnReadOnly', () => {
  it('preserva readOnly=false quando o chamador não é read-only', () => {
    expect(coerceSpawnReadOnly({ readOnly: false }, false)).toEqual({
      readOnly: false,
    });
    expect(coerceSpawnReadOnly({ readOnly: false }, undefined)).toEqual({
      readOnly: false,
    });
  });

  it('força readOnly=true quando o chamador é read-only', () => {
    expect(coerceSpawnReadOnly({}, true)).toEqual({ readOnly: true });
    expect(coerceSpawnReadOnly({ readOnly: false }, true)).toEqual({
      readOnly: true,
    });
    expect(coerceSpawnReadOnly({ readOnly: true }, true)).toEqual({
      readOnly: true,
    });
  });
});

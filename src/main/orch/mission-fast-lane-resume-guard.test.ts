/**
 * Regressão B1 (2026-08-18): o caminho Retomar/retry-kickoff da Via Rápida
 * (`resumeFastLaneMission`) NUNCA pode re-armar uma missão `blocked_user` com
 * pergunta pendente — a única saída autorizada é answer-question. Antes da
 * correção, `resumeTechnical` limpava o bloqueio sem resposta e respawnava o
 * orquestrador (bug de campo).
 *
 * F-738 (02/10): "pergunta pendente" é a REGISTRADA no ledger (clarify). O
 * bloqueio que o Maestro declara por set_status não registra pergunta, e o
 * processo dele é encerrado — exigir answer-question ali deixava a missão sem
 * saída.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Handoff, Mission } from '../../shared/orch-types';
import { buildClarify } from '../../shared/clarify';
import { testProjectScope } from './__tests__/scope-fixture';

const harness = vi.hoisted(() => ({
  mission: null as Mission | null,
  handoffs: [] as Handoff[],
  resumeTechnical: vi.fn(),
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: () => null,
  listAgentSessions: () => [],
  registeredOrchestratorSessionsForMission: () => [],
  orchTerminateSession: async () => true,
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => [],
  wasOrchestratorOperatorDismissed: () => false,
  clearOperatorDismissedPanes: () => {},
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => harness.mission,
      list: () => (harness.mission ? [harness.mission] : []),
      update: () => harness.mission,
    },
    handoffs: {
      list: () => harness.handoffs,
    },
  }),
}));

vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({
    resumeTechnical: harness.resumeTechnical,
  }),
}));

import { resumeFastLaneMission } from './mission-fast-lane';

const scope = testProjectScope();

function blockedUserMission(description: string): Mission {
  return {
    id: 'mission-1',
    title: 'Prova',
    description,
    status: 'blocked',
    intentState: 'blocked_user',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    squadId: 'squad-1',
    orchestratorSessionId: 'orch-1',
    milestones: [],
    learnings: '',
  } as Mission;
}

function registeredQuestion(): Handoff {
  return {
    id: 'handoff-question',
    missionId: 'mission-1',
    sessionId: 'orch-1',
    fromAgent: 'Maestro',
    status: 'partial',
    summary: 'Qual escopo devo seguir?',
    artifacts: [
      {
        kind: 'nexus-clarify-question',
        schemaVersion: 1,
        clarify: buildClarify({
          question: 'Qual escopo devo seguir?',
          options: ['Só leitura', 'Corrigir'],
        }),
      },
    ],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: true,
    deliveryState: 'submitted',
    createdAt: 2,
  } as unknown as Handoff;
}

describe('resumeFastLaneMission — guarda de blocked_user', () => {
  it('recusa retomar missão com pergunta registrada pendente (sem selo runtime-closed)', async () => {
    harness.mission = blockedUserMission('Pergunta pendente ao operador');
    harness.handoffs = [registeredQuestion()];
    harness.resumeTechnical.mockClear();

    await expect(
      resumeFastLaneMission(scope, 'mission-1'),
    ).rejects.toThrow(/pergunta do operador exige resposta/);
    expect(harness.resumeTechnical).not.toHaveBeenCalled();
  });

  it('F-738: bloqueio declarado pelo Maestro sem pergunta registrada retoma e tira os dois selos', async () => {
    harness.mission = blockedUserMission(
      [
        'objetivo do operador',
        '<!-- nexus:runtime-closed -->\n[NEXUS_RUNTIME_CLOSED] Execução encerrada pelo operador; histórico e receipts preservados.',
        '<!-- nexus:agent-status-block -->\n[NEXUS_AGENT_STATUS_BLOCK] O orquestrador declarou status=blocked: pedido original irrecuperável.',
      ].join('\n\n'),
    );
    harness.handoffs = [];
    harness.resumeTechnical.mockClear();

    // O bootstrap seguinte depende de runtime que este teste não monta; o que
    // importa é que a guarda não recusou e a reabertura limpou a descrição.
    const outcome = await resumeFastLaneMission(scope, 'mission-1').then(
      () => null,
      (error: unknown) => error,
    );

    expect(String(outcome ?? '')).not.toMatch(/pergunta do operador exige resposta/);
    expect(harness.resumeTechnical).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        missionId: 'mission-1',
        expectedIntentState: 'blocked_user',
        description: 'objetivo do operador',
      }),
    );
  });
});


it('F-429: automatic remount cannot remove the operator stop seal', async () => {
  harness.mission = blockedUserMission('<!-- nexus:runtime-closed -->\n[NEXUS_RUNTIME_CLOSED] Execução encerrada pelo operador.');
  harness.handoffs = []; harness.resumeTechnical.mockClear();
  await expect(resumeFastLaneMission(scope, 'mission-1', { remountKind: 'automatic' })).rejects.toThrow(/encerrada pelo operador/);
  expect(harness.resumeTechnical).not.toHaveBeenCalled();
  expect(harness.mission.description).toContain('runtime-closed');
});

describe('resumeFastLaneMission — CAS do resumeTechnical (A5)', () => {
  function blockedTechnicalMission(): Mission {
    return {
      ...blockedUserMission('objetivo do operador'),
      intentState: 'blocked_technical',
      updatedAt: 1,
    } as Mission;
  }

  it('linha que muda entre a leitura e o CAS é relida e o CAS é retentado uma vez', async () => {
    harness.mission = blockedTechnicalMission();
    harness.handoffs = [];
    harness.resumeTechnical.mockReset();
    harness.resumeTechnical
      .mockImplementationOnce(() => {
        // Watcher/outro comando mudou a linha entre o get e o CAS.
        harness.mission = { ...harness.mission!, updatedAt: 2 };
        throw new Error('store: CAS conflict (updatedAt mudou)');
      })
      .mockImplementationOnce(() => {
        harness.mission = { ...harness.mission!, status: 'running', intentState: 'executing' } as Mission;
      });

    // O bootstrap seguinte depende de runtime que este teste não monta; o que
    // importa é que o CAS foi retentado com a linha fresca e o erro, se
    // houver, não é o de conflito.
    const outcome = await resumeFastLaneMission(scope, 'mission-1').then(
      () => null,
      (error: unknown) => error,
    );

    expect(harness.resumeTechnical).toHaveBeenCalledTimes(2);
    expect(harness.resumeTechnical).toHaveBeenNthCalledWith(
      2,
      scope,
      expect.objectContaining({ missionId: 'mission-1', expectedUpdatedAt: 2 }),
    );
    expect(String(outcome ?? '')).not.toMatch(/corrida de estado/);
  });

  it('CAS perdido nas duas tentativas propaga o conflito (esperado vs atual), nunca request-processed mudo', async () => {
    harness.mission = blockedTechnicalMission();
    harness.handoffs = [];
    harness.resumeTechnical.mockReset().mockImplementation(() => {
      harness.mission = { ...harness.mission!, updatedAt: harness.mission!.updatedAt + 1 };
      throw new Error('store: status mudou');
    });

    await expect(resumeFastLaneMission(scope, 'mission-1')).rejects.toThrow(
      /corrida de estado.*esperado blocked\/blocked_technical@1, atual blocked\/blocked_technical@2/,
    );
    expect(harness.resumeTechnical).toHaveBeenCalledTimes(2);
  });

  it('linha já reaberta por outro caminho (running) não retenta o CAS', async () => {
    harness.mission = blockedTechnicalMission();
    harness.handoffs = [];
    harness.resumeTechnical.mockReset().mockImplementationOnce(() => {
      // Outra retomada venceu a corrida e já reabriu a missão.
      harness.mission = { ...harness.mission!, status: 'running', intentState: 'executing', updatedAt: 2 } as Mission;
      throw new Error('store: CAS conflict');
    });

    const outcome = await resumeFastLaneMission(scope, 'mission-1').then(
      () => null,
      (error: unknown) => error,
    );

    expect(harness.resumeTechnical).toHaveBeenCalledTimes(1);
    expect(String(outcome ?? '')).not.toMatch(/corrida de estado/);
  });
});

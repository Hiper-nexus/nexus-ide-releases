import { describe, expect, it, vi } from 'vitest';
import type { Mission, Squad } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import type { ProjectExecutionScope } from '../../shared/types';
import { getAutomaticCompletionProof, withAutomaticCompletionProof } from './automatic-completion-proof';
import type { MissionLeader } from './mission-leadership';

/**
 * Onda 1 (religação da liderança): evaluateIndependentReviewGate compara o
 * par PROVADO por resolveMissionLeader, não mission.orchestratorSessionId
 * cru. O default abaixo replica "há uma sessão corrente" para as fixtures
 * existentes; testes de religação específicos sobrescrevem via
 * `leadershipMocks.resolveMissionLeader`.
 */
const leadershipMocks = vi.hoisted(() => ({
  resolveMissionLeader: vi.fn<() => MissionLeader | null>(() => ({
    sessionId: 'orch-1', paneId: 'pane-orch', source: 'durable', proven: true,
  })),
}));

vi.mock('./mission-leadership-runtime', () => ({
  getMissionLeadership: () => ({ resolveMissionLeader: leadershipMocks.resolveMissionLeader }),
}));

import {
  assertIndependentReviewForDone,
  evaluateIndependentReviewGate,
  isCivilianViaRapidaReviewExempt,
  reviewerHandoffHasEvidence,
} from './mission-independent-review-gate';
import { MissionLeadershipError } from './mission-leadership';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    title: 'SaaS',
    description: 'Entrega real',
    status: 'running',
    intentState: 'executing',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    milestones: [],
    squadId: 'squad-1',
    orchestratorSessionId: 'orch-1',
    intentContract: { lane: 'standard' } as Mission['intentContract'],
    ...overrides,
  } as Mission;
}

function squad(): Squad {
  return {
    id: 'squad-1',
    name: 'Full',
    createdAt: '1',
    builtin: true,
    orchestratorInstructions: '',
    agents: [
      {
        id: 'orch',
        agentName: 'Maestro',
        category: 'orchestrator',
        cli: 'claude',
      },
      {
        id: 'exec',
        agentName: 'Implementar motor',
        category: 'executor',
        cli: 'codex',
      },
      {
        id: 'rev',
        agentName: 'Reviewer',
        category: 'reviewer',
        cli: 'codex',
      },
    ],
  } as Squad;
}

const accepted = [
  {
    state: 'accepted',
    acceptedAt: 10,
    orchestratorSessionId: 'orch-1',
  },
];

const scope: ProjectExecutionScope = {
  version: 1, installationId: 'test-install', projectId: 'test-project',
  checkoutId: 'test-checkout', rootRealPath: '/projects/test', identitySource: 'manifest',
};

describe('Main-owned completion proof', () => {
  it('requires the automatic check for Express standard without requiring a manual reviewer', () => {
    const current = mission({ intentContract: { lane: 'standard', freeAgentChoice: true } as Mission['intentContract'] });
    const input = { scope, mission: current, squad: squad(), handoffs: [], deliveryAttemptsOf: () => [] };
    expect(evaluateIndependentReviewGate(input).ok).toBe(false);
    withAutomaticCompletionProof(scope, current, { status: 'verified' }, () => {
      expect(evaluateIndependentReviewGate({
        ...input, automaticProof: getAutomaticCompletionProof(scope, current),
      })).toEqual({ ok: true, reviewerHandoffId: 'main-automatic-verification' });
      return true;
    });
  });

  it('keeps a Main-validated text-only answer exempt', () => {
    expect(evaluateIndependentReviewGate({
      mission: mission(), squad: squad(), handoffs: [], deliveryAttemptsOf: () => [], textOnly: true,
    })).toEqual({ ok: true, reviewerHandoffId: 'exempt' });
  });

  it('does not add a new automatic-proof requirement to free ops or missions without a squad', () => {
    for (const current of [
      mission({ intentContract: { lane: 'ops', freeAgentChoice: true } as Mission['intentContract'] }),
      mission({ squadId: undefined }),
    ]) {
      expect(evaluateIndependentReviewGate({
        mission: current, squad: squad(), handoffs: [], deliveryAttemptsOf: () => [],
      })).toEqual({ ok: true, reviewerHandoffId: 'exempt' });
    }
  });

  it('rejects substantial prose and invented evidence IDs without a resolved proof', () => {
    for (const evidenceIds of [[], ['review:invented']]) {
      const result = evaluateIndependentReviewGate({
        mission: mission(), squad: squad(), deliveryAttemptsOf: () => [],
        handoffs: [{ id: 'reviewer', fromAgent: 'Reviewer', status: 'success',
          summary: 'x'.repeat(120), deliveryState: 'consumed', evidenceIds }],
      });
      expect(result).toMatchObject({ ok: false, code: 'review_without_evidence' });
    }
  });

  it('allows the current automatic check after rejected history without a manual reviewer round', () => {
    const current = mission();
    withAutomaticCompletionProof(scope, current, { status: 'verified', candidateFingerprint: 'b'.repeat(64) }, () => {
      const result = evaluateIndependentReviewGate({
        scope, mission: current, squad: squad(), deliveryAttemptsOf: () => [],
        automaticProof: getAutomaticCompletionProof(scope, current),
        handoffs: Array.from({ length: 20 }, (_, index) => ({
          id: `old-review-${index}`, fromAgent: 'Reviewer', status: 'failed',
          summary: '[REPROVADA] Falha no login antes da correção.', deliveryState: 'consumed',
        })),
      });
      expect(result).toEqual({ ok: true, reviewerHandoffId: 'main-automatic-verification' });
      return result.ok;
    });
  });

  it('does not accept a JSON-shaped automatic proof or one bound to another intent', () => {
    const current = mission();
    const input = { scope, mission: current, squad: squad(), handoffs: [], deliveryAttemptsOf: () => [] };
    expect(evaluateIndependentReviewGate({ ...input, automaticProof: { status: 'verified' } }).ok).toBe(false);
    withAutomaticCompletionProof(scope, current, { status: 'verified' }, () => {
      expect(evaluateIndependentReviewGate({
        ...input, mission: mission({ intentVersion: 2 }),
        automaticProof: getAutomaticCompletionProof(scope, current),
      }).ok).toBe(false);
      return true;
    });
  });

  it('accepts an explicit unavailable check without misrepresenting it as a verified review', () => {
    const current = mission();
    withAutomaticCompletionProof(scope, current, { status: 'unavailable', note: 'Verificação indisponível; resultado entregue com limitação.' }, () => {
      expect(evaluateIndependentReviewGate({
        scope, mission: current, squad: squad(), handoffs: [], deliveryAttemptsOf: () => [],
        automaticProof: getAutomaticCompletionProof(scope, current),
      })).toEqual({ ok: true, reviewerHandoffId: 'main-check-unavailable' });
      return true;
    });
  });
});

describe('evaluateIndependentReviewGate', () => {
  it('done só com executor → FALHA (review_missing)', () => {
    const result = evaluateIndependentReviewGate({
      mission: mission(),
      squad: squad(),
      handoffs: [
        {
          id: 'h-exec',
          status: 'success',
          fromAgent: 'Implementar motor',
          summary: 'Arquivo criado com sucesso e testado localmente.',
          deliveryState: 'consumed',
          evidenceIds: ['e1'],
        },
      ],
      deliveryAttemptsOf: () => accepted,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('review_missing');
      expect(result.reason).not.toMatch(/nexus_|handoffId|JSON/i);
    }
  });

  it('executor e revisor com IDs não resolvidos não comprovam revisão', () => {
    const result = evaluateIndependentReviewGate({
      mission: mission(),
      squad: squad(),
      handoffs: [
        {
          id: 'h-exec',
          status: 'success',
          fromAgent: 'Implementar motor',
          summary: 'Implementado.',
          deliveryState: 'consumed',
        },
        {
          id: 'h-rev',
          status: 'success',
          fromAgent: 'Reviewer',
          summary:
            'Revisei o diff e os testes. Sem regressão, sem legado perigoso, pronto para produção.',
          deliveryState: 'consumed',
          evidenceIds: ['review-ev-1'],
        },
      ],
      deliveryAttemptsOf: () => accepted,
    });
    expect(result).toMatchObject({ ok: false, code: 'review_without_evidence' });
  });

  it('revisor com verdict incorrect → nunca verde', () => {
    const summary = [
      '```json',
      JSON.stringify({
        verdict: 'incorrect',
        explanation: 'Regressão no login.',
        confidence: 0.9,
        findings: [],
      }),
      '```',
    ].join('\n');
    const result = evaluateIndependentReviewGate({
      mission: mission(),
      squad: squad(),
      handoffs: [
        {
          id: 'h-rev',
          status: 'success',
          fromAgent: 'Reviewer',
          summary,
          deliveryState: 'consumed',
          evidenceIds: ['x'],
        },
      ],
      deliveryAttemptsOf: () => accepted,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('review_without_evidence');
  });

  it('revisor success sem prova → review_without_evidence', () => {
    const result = evaluateIndependentReviewGate({
      mission: mission(),
      squad: squad(),
      handoffs: [
        {
          id: 'h-rev',
          status: 'success',
          fromAgent: 'Reviewer',
          summary: 'ok',
          deliveryState: 'consumed',
        },
      ],
      deliveryAttemptsOf: () => accepted,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('review_without_evidence');
  });

  it('Via Rápida dispensa revisor manual, mas não a verificação automática', () => {
    const result = evaluateIndependentReviewGate({
      mission: mission({
        intentState: 'executing',
        intentContract: {
          lane: 'standard',
          freeAgentChoice: true,
        } as Mission['intentContract'],
      }),
      squad: squad(),
      handoffs: [
        {
          id: 'h-exec',
          status: 'success',
          fromAgent: 'Implementar motor',
          summary: '20 stories no disco com handoff SUCCESS.',
          deliveryState: 'consumed',
          evidenceIds: ['e1'],
        },
      ],
      deliveryAttemptsOf: () => accepted,
    });
    expect(result).toMatchObject({ ok: false, code: 'review_missing' });
    expect(
      isCivilianViaRapidaReviewExempt({
        intentState: 'executing',
        intentContract: {
          lane: 'standard',
          freeAgentChoice: true,
        } as Mission['intentContract'],
      }),
    ).toBe(true);
    expect(
      isCivilianViaRapidaReviewExempt({
        intentState: 'legacy',
        intentContract: {
          lane: 'standard',
          freeAgentChoice: true,
        } as Mission['intentContract'],
      }),
    ).toBe(false);
    expect(
      isCivilianViaRapidaReviewExempt({
        intentState: 'executing',
        intentContract: {
          lane: 'standard',
          orchestrationMode: 'guided',
        } as Mission['intentContract'],
      }),
    ).toBe(false);
  });

  it('guided/legacy com squad continua review_missing sem revisor', () => {
    const result = evaluateIndependentReviewGate({
      mission: mission({
        intentState: 'legacy',
        intentContract: {
          lane: 'standard',
          freeAgentChoice: true,
          orchestrationMode: 'guided',
        } as Mission['intentContract'],
      }),
      squad: squad(),
      handoffs: [],
      deliveryAttemptsOf: () => [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('review_missing');
  });

  it('Pet Studio e consult ficam isentos', () => {
    expect(
      evaluateIndependentReviewGate({
        mission: mission({ squadId: PET_STUDIO_SQUAD_ID }),
        squad: null,
        handoffs: [],
        deliveryAttemptsOf: () => [],
      }).ok,
    ).toBe(true);
    expect(
      evaluateIndependentReviewGate({
        mission: mission({
          intentContract: { lane: 'consult' } as Mission['intentContract'],
        }),
        squad: squad(),
        handoffs: [],
        deliveryAttemptsOf: () => [],
      }).ok,
    ).toBe(true);
  });

  it('assertIndependentReviewForDone lança com código estável', () => {
    expect(() =>
      assertIndependentReviewForDone({
        mission: mission(),
        squad: squad(),
        handoffs: [],
        deliveryAttemptsOf: () => [],
      }),
    ).toThrow(/review_missing:/);
  });
});

describe('reviewerHandoffHasEvidence', () => {
  it('não transforma IDs soltos ou resumo longo em evidência', () => {
    expect(
      reviewerHandoffHasEvidence({
        id: 'a',
        status: 'success',
        evidenceIds: ['e'],
      }),
    ).toBe(false);
    expect(
      reviewerHandoffHasEvidence({
        id: 'b',
        status: 'success',
        summary: 'x'.repeat(40),
      }),
    ).toBe(false);
    expect(
      reviewerHandoffHasEvidence({
        id: 'c',
        status: 'success',
        summary:
          'Chequei auth, pagamentos e o fluxo principal. Tudo passou sem regressão detectável.',
      }),
    ).toBe(false);
  });
});

import { reviewSummaryLooksNegative } from './mission-independent-review-gate';

describe('leitura do veredito do revisor (gate 0.62, 19/08)', () => {
  it('"Nenhuma story reprovada" NUNCA é reprovação — fixture do voo real', () => {
    // Resumo VERBATIM (truncado) da revisão 3/3 validada que o gate leu como
    // review_rejected e travou a missão em loop eterno.
    const flightSummary =
      'Validação por story (evidência em disco + comportamento observado ' +
      'via servidor local + Chrome):\n\n' +
      '1. [VALIDADA] Criar arquivo estilos-sobre.css com estilo básico — ' +
      'servido com HTTP 200; screenshot confirma.\n' +
      '2. [VALIDADA] Adicionar na index.html um link de navegação — cliquei ' +
      'no link e a aba navegou; confirmado por screenshot.\n' +
      '3. [VALIDADA] Criar página sobre.html — renderizado no Chrome.\n\n' +
      'Nenhuma story reprovada. Servidor de teste encerrado após a verificação.';
    expect(reviewSummaryLooksNegative(flightSummary)).toBe(false);
  });

  it('marcador estruturado [REPROVADA] decide reprovação mesmo com elogios', () => {
    expect(
      reviewSummaryLooksNegative(
        'Revisão story-a-story: 1. [VALIDADA] login ok com testes verdes. ' +
          '2. [REPROVADA] API de sessão — arquivo ausente no disco.',
      ),
    ).toBe(true);
  });

  it('menção negada ("0 reprovadas", "sem reprovação") não é negativa', () => {
    expect(
      reviewSummaryLooksNegative(
        'Board verificado por completo: 10/10 validadas, 0 reprovadas. ' +
          'Evidência de execução anexada para cada story do plano selado.',
      ),
    ).toBe(false);
    expect(
      reviewSummaryLooksNegative(
        'Auditoria integral sem reprovação: todas as entregas têm arquivo ' +
          'real e comportamento demonstrado por teste automatizado local.',
      ),
    ).toBe(false);
  });

  it('reprovação textual clara continua sendo reprovação', () => {
    expect(
      reviewSummaryLooksNegative(
        'Revisão concluída: a story de checkout foi reprovada — o fluxo ' +
          'quebra no submit e não há arquivo de teste cobrindo o caso.',
      ),
    ).toBe(true);
    expect(
      reviewSummaryLooksNegative(
        'Review finished: the delivery is rejected because the sealed board ' +
          'claims files that do not exist on disk anywhere in the project.',
      ),
    ).toBe(true);
  });
});

describe('recibos de transporte não substituem verificação do candidato', () => {
  it('handoff submitted com attempt aceito continua exigindo prova de qualidade', () => {
    const result = evaluateIndependentReviewGate({
      scope,
      mission: {
        ...mission(),
        id: 'mission-1',
        squadId: 'squad-1',
        intentContract: { lane: 'standard' } as never,
        intentState: 'executing',
      },
      squad: {
        id: 'squad-1',
        agents: [
          { id: 'rev', agentName: 'Verificar experiência', category: 'reviewer', cli: 'claude' },
        ],
      } as never,
      handoffs: [
        {
          id: 'h-rev',
          missionId: 'mission-1',
          fromAgent: 'Verificar experiência',
          status: 'success',
          deliveryState: 'submitted',
          summary:
            'Validação por story: 1. [VALIDADA] css aplicado com evidência ' +
            'de computed style. 2. [VALIDADA] navegação clicada no browser. ' +
            'Nenhuma story reprovada nesta rodada de verificação integral.',
          evidenceIds: [],
        } as never,
      ],
      deliveryAttemptsOf: () => [
        {
          state: 'accepted',
          acceptedAt: 123,
          orchestratorSessionId: 'orch-ANTIGO-que-morreu',
        },
      ],
    });
    expect(result).toMatchObject({ ok: false, code: 'review_without_evidence' });
  });
});

describe('religação onda 1 — sessão corrente vem de resolveMissionLeader', () => {
  const reviewerSquad = {
    id: 'squad-1',
    agents: [{ id: 'rev', agentName: 'Verificar experiência', category: 'reviewer', cli: 'claude' }],
  } as never;
  const submittedAccepted = [{ state: 'accepted' as const, acceptedAt: 123 }];
  const baseMission = {
    ...mission(), id: 'mission-1', squadId: 'squad-1',
    intentContract: { lane: 'standard' } as never, intentState: 'executing' as const,
  };
  const submittedHandoff = [{
    id: 'h-rev', missionId: 'mission-1', fromAgent: 'Verificar experiência', status: 'success',
    deliveryState: 'submitted', summary: '[VALIDADA] tudo certo. Nenhuma story reprovada.',
    evidenceIds: [],
  } as never];

  it('A e C concordam (líder provado) — attempt aceito conta, mesmo sem prova de qualidade', () => {
    leadershipMocks.resolveMissionLeader.mockReturnValueOnce({
      sessionId: 'orch-vivo', paneId: 'pane-1', source: 'durable', proven: true,
    });
    const result = evaluateIndependentReviewGate({
      scope, mission: baseMission, squad: reviewerSquad, handoffs: submittedHandoff,
      deliveryAttemptsOf: () => submittedAccepted,
    });
    expect(result).toMatchObject({ ok: false, code: 'review_without_evidence' });
  });

  it('A morto (source live, proven:false) — sem sessão corrente, cai em review_missing', () => {
    leadershipMocks.resolveMissionLeader.mockReturnValueOnce({
      sessionId: 'orch-morto', paneId: 'pane-1', source: 'live', proven: false,
    });
    const result = evaluateIndependentReviewGate({
      scope, mission: baseMission, squad: reviewerSquad, handoffs: submittedHandoff,
      deliveryAttemptsOf: () => submittedAccepted,
    });
    expect(result).toMatchObject({ ok: false, code: 'review_missing' });
  });

  it('split-brain nunca é engolido — devolve leadership_conflict com o código, sem escolher por ordem de array', () => {
    leadershipMocks.resolveMissionLeader.mockImplementationOnce(() => {
      throw new MissionLeadershipError('split_brain', {
        missionId: 'mission-1', sessionIds: ['orch-a', 'orch-b'],
      });
    });
    const result = evaluateIndependentReviewGate({
      scope, mission: baseMission, squad: reviewerSquad, handoffs: submittedHandoff,
      deliveryAttemptsOf: () => submittedAccepted,
    });
    expect(result).toMatchObject({ ok: false, code: 'leadership_conflict' });
    expect((result as { reason: string }).reason).toContain('split_brain');
  });
});

describe('list-ack registra leitura, não qualidade', () => {
  it('revisão reconhecida via nexus_handoff_list não prova o candidato', () => {
    const result = evaluateIndependentReviewGate({
      mission: {
        ...mission(),
        id: 'mission-1',
        squadId: 'squad-1',
        intentContract: { lane: 'standard' } as never,
        intentState: 'executing',
      },
      squad: {
        id: 'squad-1',
        agents: [
          { id: 'rev', agentName: 'Verificar experiência', category: 'reviewer', cli: 'claude' },
        ],
      } as never,
      handoffs: [
        {
          id: 'h-rev-list',
          missionId: 'mission-1',
          fromAgent: 'Verificar experiência',
          status: 'success',
          deliveryState: 'acknowledged',
          summary:
            'Verificação integral por story com evidência de execução: ' +
            '1. [VALIDADA] página renderizada. 2. [VALIDADA] css aplicado.',
          evidenceIds: [],
        } as never,
      ],
      // O Maestro leu via list — NUNCA houve delivery digitado.
      deliveryAttemptsOf: () => [],
    });
    expect(result).toMatchObject({ ok: false, code: 'review_without_evidence' });
  });

  it('queued continua NÃO valendo — sem recibo nenhum não há revisão', () => {
    const result = evaluateIndependentReviewGate({
      mission: {
        ...mission(),
        id: 'mission-1',
        squadId: 'squad-1',
        intentContract: { lane: 'standard' } as never,
        intentState: 'executing',
      },
      squad: {
        id: 'squad-1',
        agents: [
          { id: 'rev', agentName: 'Verificar experiência', category: 'reviewer', cli: 'claude' },
        ],
      } as never,
      handoffs: [
        {
          id: 'h-rev-q',
          missionId: 'mission-1',
          fromAgent: 'Verificar experiência',
          status: 'success',
          deliveryState: 'queued',
          summary:
            'Verificação integral por story com evidência de execução: ' +
            '1. [VALIDADA] página renderizada e navegação clicada no browser.',
          evidenceIds: [],
        } as never,
      ],
      deliveryAttemptsOf: () => [],
    });
    expect(result.ok).toBe(false);
  });
});

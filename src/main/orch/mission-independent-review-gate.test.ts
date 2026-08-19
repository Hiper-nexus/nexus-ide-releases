import { describe, expect, it } from 'vitest';
import type { Mission, Squad } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import {
  assertIndependentReviewForDone,
  evaluateIndependentReviewGate,
  isCivilianViaRapidaReviewExempt,
  reviewerHandoffHasEvidence,
} from './mission-independent-review-gate';

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

  it('executor + revisor com evidência aceitos → PASSA', () => {
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
    expect(result).toEqual({ ok: true, reviewerHandoffId: 'h-rev' });
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
    if (!result.ok) expect(result.code).toBe('review_rejected');
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

  it('Via Rápida civil (freeAgentChoice) não exige revisor manual', () => {
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
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reviewerHandoffId).toBe('exempt');
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
  it('aceita evidenceIds ou resumo longo sem reprovação', () => {
    expect(
      reviewerHandoffHasEvidence({
        id: 'a',
        status: 'success',
        evidenceIds: ['e'],
      }),
    ).toBe(true);
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
    ).toBe(true);
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

describe('revisão SUBMITTED com attempt aceito vale — inclusive pós-respawn (0.63)', () => {
  it('handoff submitted + attempt aceito por sessão ANTERIOR do Maestro passa o gate', () => {
    const result = evaluateIndependentReviewGate({
      mission: {
        id: 'mission-1',
        squadId: 'squad-1',
        intentContract: { lane: 'standard' } as never,
        orchestratorSessionId: 'orch-NOVO-pós-respawn',
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
    expect(result.ok).toBe(true);
  });
});

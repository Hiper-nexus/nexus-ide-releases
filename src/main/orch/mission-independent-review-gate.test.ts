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

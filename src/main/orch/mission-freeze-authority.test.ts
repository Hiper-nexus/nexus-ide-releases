import { describe, expect, it } from 'vitest';
import { compileIntentContract } from '../../shared/mission-intent';
import type { Mission } from '../../shared/orch-types';
import type { MissionContractDraft } from '../context/context-workflow-service';
import { bindFreezeDraftToApprovedIntent } from './mission-freeze-authority';

function mission(risk: 'normal' | 'sensitive' | 'destructive' = 'sensitive'): Mission {
  const base = compileIntentContract({
    goal: 'Alterar autenticação sem reduzir o contrato',
    acceptanceCriteria: ['Sessão antiga é revogada', 'Testes de segurança passam'],
    intentVersion: 3,
  });
  return {
    id: 'mission-a',
    title: 'Auth',
    description: base.goal,
    status: 'running',
    milestones: [],
    learnings: '',
    intentState: 'dispatched',
    intentVersion: 3,
    intentContract: {
      ...base,
      risk,
      approvedAt: 1,
      dispatchedAt: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function draft(overrides: Partial<MissionContractDraft> = {}): MissionContractDraft {
  return {
    missionId: 'mission-a',
    goal: 'Alterar autenticação sem reduzir o contrato',
    acceptanceCriteria: [
      {
        id: 'agent-chosen',
        statement: 'Sessão antiga é revogada',
        requiredSensorIds: [],
        invariantRefs: [],
        requiredArtifactIds: [],
      },
      {
        id: 'reverse-id',
        statement: 'Testes de segurança passam',
        requiredSensorIds: ['unit'],
        invariantRefs: [],
        requiredArtifactIds: [],
      },
    ],
    impactedDomains: ['auth'],
    impactedSymbols: ['rotateSession'],
    riskHints: [],
    ...overrides,
  };
}

describe('approved intent authority for PREVC freeze', () => {
  it('rejects goal and ordered acceptance drift before freezing', () => {
    expect(() => bindFreezeDraftToApprovedIntent(
      mission(),
      draft({ goal: 'Só atualizar um comentário' }),
    )).toThrow(/freeze_goal_mismatch/i);
    expect(() => bindFreezeDraftToApprovedIntent(
      mission(),
      draft({ acceptanceCriteria: [...draft().acceptanceCriteria].reverse() }),
    )).toThrow(/freeze_acceptance_mismatch/i);
  });

  it('main-owns criterion ids and applies the approved risk floor', () => {
    const bound = bindFreezeDraftToApprovedIntent(mission('destructive'), draft());
    expect(bound.acceptanceCriteria.map((criterion) => criterion.id)).toEqual([
      'criterion-0001',
      'criterion-0002',
    ]);
    expect(bound.riskHints).toEqual(['credential', 'security']);
    expect(bound.impactedDomains).toEqual(['auth']);
  });

  it('rejects paused or superseded mission authority', () => {
    expect(() => bindFreezeDraftToApprovedIntent(
      { ...mission(), status: 'blocked' },
      draft(),
    )).toThrow(/freeze_authority_required/i);
  });
});

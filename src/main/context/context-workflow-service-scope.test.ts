import { describe, expect, it } from 'vitest';
import type { MissionContractDraft } from './context-workflow-service';
import { unionMissionDraftWithBlastRadius } from './context-workflow-service';

const draft: MissionContractDraft = {
  missionId: 'mission-a',
  goal: 'Alterar autenticação e revogação de sessão',
  acceptanceCriteria: [
    {
      id: 'criterion-0001',
      statement: 'Sessões antigas são revogadas',
      requiredSensorIds: [],
      invariantRefs: [],
      requiredArtifactIds: [],
    },
  ],
  impactedSymbols: ['caller-picked-narrow-symbol'],
  impactedDomains: ['caller-picked-narrow-domain'],
};

describe('main-owned PREVC blast-radius union', () => {
  it('never lets an explicit narrow scope remove Nexus-derived scope', () => {
    const enriched = unionMissionDraftWithBlastRadius(draft, {
      symbols: ['revokeSession', 'rotateCredential'],
      domains: ['auth', 'security'],
    });

    expect(enriched.impactedSymbols).toEqual([
      'caller-picked-narrow-symbol',
      'revokeSession',
      'rotateCredential',
    ]);
    expect(enriched.impactedDomains).toEqual([
      'auth',
      'caller-picked-narrow-domain',
      'security',
    ]);
  });
});

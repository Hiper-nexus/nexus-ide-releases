import { describe, expect, it } from 'vitest';
import {
  buildContinuityPack,
  buildSameAccountContinuePrompt,
} from './failover-continuity';

describe('failover continuity pack', () => {
  it('states new session and does not claim native resume across accounts', () => {
    const pack = buildContinuityPack({
      fromAccountLabel: 'Work',
      toAccountLabel: 'Personal',
      reason: '5-hour usage limit',
      role: 'orchestrator',
      missionId: 'm-1',
      openWorkHint: 'task: ship failover',
      scrollbackExcerpt: 'Building…\nLIMIT',
    });
    expect(pack).toMatch(/NEW provider session/i);
    expect(pack).toMatch(/NOT transferable/i);
    expect(pack).toContain('Work');
    expect(pack).toContain('Personal');
    expect(pack).toContain('m-1');
    expect(pack).toContain('ship failover');
    expect(pack).not.toMatch(/--resume/i);
  });

  it('same-account continue is short and role-aware', () => {
    expect(buildSameAccountContinuePrompt('orchestrator')).toMatch(
      /orchestrator/,
    );
    expect(buildSameAccountContinuePrompt()).toMatch(/agent/);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Handoff } from '../../shared/orch-types';
import { publishFinalValidationHandoff } from './final-validation-handoff';

function trustedHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'handoff-a',
    missionId: 'mission-a',
    fromAgent: 'nexus-prevc-autopilot',
    status: 'success',
    claimTrust: 'untrusted',
    summary: 'Validated',
    artifacts: [],
    evidenceIds: ['ev-sensor', 'review:review-a'],
    evidenceTrust: 'nexus-trusted',
    evidenceBinding: {
      missionId: 'mission-a',
      contextRevision: 'a'.repeat(64),
      contractHash: 'b'.repeat(64),
      baseSha: 'c'.repeat(40),
      headSha: 'd'.repeat(40),
      diffHash: 'e'.repeat(64),
      workflowRevision: 7,
    },
    delivered: false,
    deliveryState: 'queued',
    createdAt: 1,
    ...overrides,
  };
}

describe('publishFinalValidationHandoff', () => {
  it('publishes sorted unique validation evidence once', () => {
    const submitted = trustedHandoff();
    const submit = vi.fn(() => submitted);
    const handoff = publishFinalValidationHandoff(
      {
        missionId: 'mission-a',
        workflowRevision: 7,
        evidenceIds: ['review:review-a', 'ev-sensor', 'ev-sensor'],
      },
      { list: () => [], submit },
    );

    expect(handoff).toBe(submitted);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      missionId: 'mission-a',
      evidenceIds: ['ev-sensor', 'review:review-a'],
    }));
  });

  it('reuses a trusted handoff from the same workflow revision', () => {
    const existing = trustedHandoff();
    const submit = vi.fn();

    expect(publishFinalValidationHandoff(
      {
        missionId: 'mission-a',
        workflowRevision: 7,
        evidenceIds: ['ev-sensor', 'review:review-a'],
      },
      { list: () => [existing], submit },
    )).toBe(existing);
    expect(submit).not.toHaveBeenCalled();
  });

  it('reuses current trusted evidence when the final gate is retried', () => {
    const existing = trustedHandoff();

    expect(publishFinalValidationHandoff(
      { missionId: 'mission-a', workflowRevision: 7, evidenceIds: [] },
      { list: () => [existing], submit: vi.fn() },
    )).toBe(existing);
  });

  it('fails closed when validation produced no evidence', () => {
    expect(() => publishFinalValidationHandoff(
      { missionId: 'mission-a', workflowRevision: 7, evidenceIds: [] },
      { list: () => [], submit: vi.fn() },
    )).toThrow(/no trusted evidence/);
  });
});

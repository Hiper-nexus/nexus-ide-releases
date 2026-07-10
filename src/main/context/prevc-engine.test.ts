import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  createWorkflowState,
  type WorkflowEvidence,
} from './prevc-engine';

const binding = {
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  missionId: 'mission-a',
  contractHash: 'c'.repeat(64),
  contextHash: 'x'.repeat(64),
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  diffHash: 'd'.repeat(64),
};

function evidence(overrides: Partial<WorkflowEvidence> = {}): WorkflowEvidence {
  return {
    binding,
    blockingConflictIds: [],
    openFindingSeverities: [],
    trustedSensorIds: ['unit'],
    requiredSensorIds: ['unit'],
    trustedArtifactIds: ['artifact-a'],
    requiredArtifactIds: ['artifact-a'],
    authorId: 'author-a',
    reviewerId: 'reviewer-b',
    authorProvider: 'codex',
    reviewerProvider: 'claude',
    worktreeId: 'worktree-a',
    integratedHeadSha: binding.headSha,
    integratedDiffHash: binding.diffHash,
    ...overrides,
  };
}

describe('PREVC workflow gate', () => {
  it('binds the produced diff exactly when execution finishes', () => {
    const initial = createWorkflowState('low', binding);
    const producedBinding = {
      ...binding,
      headSha: 'd'.repeat(40),
      diffHash: 'e'.repeat(64),
    };

    const validating = advanceWorkflow(
      initial,
      evidence({ binding: producedBinding, worktreeId: 'worktree-1' }),
      'validation-primary',
    );

    expect(validating.binding).toEqual(producedBinding);
    expect(() =>
      advanceWorkflow(
        validating,
        evidence({
          binding,
          integratedHeadSha: binding.headSha,
          integratedDiffHash: binding.diffHash,
        }),
        'complete',
      ),
    ).toThrow(/binding mismatch/i);
  });

  it('never lets execution rebind contract, context or base commit', () => {
    const initial = createWorkflowState('low', binding);
    for (const changed of [
      { contractHash: 'f'.repeat(64) },
      { contextHash: 'f'.repeat(64) },
      { baseSha: 'f'.repeat(40) },
    ]) {
      expect(() =>
        advanceWorkflow(
          initial,
          evidence({
            binding: { ...binding, ...changed },
            worktreeId: 'worktree-1',
          }),
          'validation-primary',
        ),
      ).toThrow(/binding mismatch/i);
    }
  });
  it('never allows an arbitrary done transition', () => {
    const state = createWorkflowState('high', binding);
    expect(state.stage).toBe('planning');
    expect(() => advanceWorkflow(state, evidence(), 'confirmation')).toThrow(
      /next required stage/i,
    );
  });

  it('advances high risk only through P-R-E-V-C', () => {
    let state = createWorkflowState('high', binding);
    state = advanceWorkflow(state, evidence(), 'review-primary');
    state = advanceWorkflow(state, evidence(), 'execution');
    state = advanceWorkflow(state, evidence(), 'validation-primary');
    state = advanceWorkflow(state, evidence(), 'confirmation');
    state = advanceWorkflow(state, evidence(), 'complete');

    expect(state.stage).toBe('complete');
  });

  it('blocks self-review, same-provider high-risk review and open blockers', () => {
    const state = advanceWorkflow(
      createWorkflowState('high', binding),
      evidence(),
      'review-primary',
    );

    expect(() =>
      advanceWorkflow(
        state,
        evidence({ reviewerId: 'author-a' }),
        'execution',
      ),
    ).toThrow(/author.*review/i);
    expect(() =>
      advanceWorkflow(
        state,
        evidence({ reviewerProvider: 'codex' }),
        'execution',
      ),
    ).toThrow(/provider/i);
    expect(() =>
      advanceWorkflow(
        state,
        evidence({ openFindingSeverities: ['high'] }),
        'execution',
      ),
    ).toThrow(/blocking finding/i);
  });

  it('invalidates evidence whose immutable binding differs from the workflow', () => {
    const state = createWorkflowState('low', binding);
    expect(() =>
      advanceWorkflow(
        state,
        evidence({ binding: { ...binding, contractHash: 'e'.repeat(64) } }),
        'validation-primary',
      ),
    ).toThrow(/evidence binding/i);
  });

  it('requires Nexus-produced sensors and the exact integrated diff before completion', () => {
    let state = createWorkflowState('low', binding);
    state = advanceWorkflow(state, evidence(), 'validation-primary');

    expect(() =>
      advanceWorkflow(
        state,
        evidence({ trustedSensorIds: [] }),
        'complete',
      ),
    ).toThrow(/required sensor/i);
    expect(() =>
      advanceWorkflow(
        state,
        evidence({ trustedArtifactIds: [] }),
        'complete',
      ),
    ).toThrow(/required Nexus artifact/i);
    expect(() =>
      advanceWorkflow(
        state,
        evidence({ integratedDiffHash: 'e'.repeat(64) }),
        'complete',
      ),
    ).toThrow(/integrated diff/i);
  });
});

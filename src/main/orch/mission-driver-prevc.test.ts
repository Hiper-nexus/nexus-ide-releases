import { describe, expect, it, vi } from 'vitest';
import { createWorkflowState, type WorkflowEvidence } from '../context/prevc-engine';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  advanceWorkflowStagePure,
  createProductionPrevcPort,
  nextWorkflowStage,
} from './mission-driver-prevc';

const BINDING = {
  projectId: 'project-test',
  checkoutId: 'checkout-test',
  missionId: 'mission-a',
  contractHash: 'c'.repeat(64),
  contextHash: 'd'.repeat(64),
  baseSha: 'a'.repeat(40),
  headSha: 'a'.repeat(40),
  diffHash: 'e'.repeat(64),
};

function planningEvidence(): WorkflowEvidence {
  return {
    binding: BINDING,
    blockingConflictIds: [],
    openFindingSeverities: [],
    trustedSensorIds: [],
    requiredSensorIds: [],
    trustedArtifactIds: [],
    requiredArtifactIds: [],
    authorId: 'author-1',
    authorProvider: 'claude',
  };
}

describe('mission-driver PREVC bridge', () => {
  it('nextWorkflowStage follows the route', () => {
    // medium: planning → execution → validation-primary
    const state = createWorkflowState('medium', BINDING);
    expect(state.stage).toBe('planning');
    expect(nextWorkflowStage(state)).toBe('execution');
  });

  it('advanceWorkflowStagePure drives the real advanceWorkflow gate', () => {
    const state = createWorkflowState('medium', BINDING);
    const next = nextWorkflowStage(state);
    expect(next).toBe('execution');
    const advanced = advanceWorkflowStagePure(
      state,
      planningEvidence(),
      next!,
    );
    expect(advanced.stage).toBe('execution');
    expect(advanced.revision).toBe(state.revision + 1);
    expect(advanced.completedStages).toContain('planning');
  });

  it('createProductionPrevcPort calls service.advance with next stage', () => {
    const scope = testProjectScope();
    const state = createWorkflowState('medium', BINDING);
    const advance = vi.fn(() => ({
      ...state,
      stage: nextWorkflowStage(state)!,
      revision: state.revision + 1,
    }));
    const port = createProductionPrevcPort(() => ({
      getMissionWorkflow: () => ({ workflow: state }),
      advance,
    }));
    port.advanceWorkflowStage('mission-a', scope);
    expect(advance).toHaveBeenCalledWith('mission-a', 'execution');
  });

  it('createProductionPrevcPort no-ops when workflow absent or complete', () => {
    const scope = testProjectScope();
    const advance = vi.fn();
    const absent = createProductionPrevcPort(() => ({
      getMissionWorkflow: () => ({ workflow: null }),
      advance,
    }));
    absent.advanceWorkflowStage('mission-a', scope);
    expect(advance).not.toHaveBeenCalled();
    expect(absent.isWorkflowCompleteOrAbsent('mission-a', scope)).toBe(true);

    const completeState = {
      ...createWorkflowState('medium', BINDING),
      stage: 'complete' as const,
    };
    const done = createProductionPrevcPort(() => ({
      getMissionWorkflow: () => ({ workflow: completeState }),
      advance,
    }));
    done.advanceWorkflowStage('mission-a', scope);
    expect(advance).not.toHaveBeenCalled();
    expect(done.isWorkflowCompleteOrAbsent('mission-a', scope)).toBe(true);
  });
});

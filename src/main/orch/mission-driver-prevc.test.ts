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

  it('createProductionPrevcPort calls the atomic mission-step service', () => {
    const scope = testProjectScope();
    const state = createWorkflowState('medium', BINDING);
    const advanceMissionStep = vi.fn();
    const port = createProductionPrevcPort(() => ({
      getMissionWorkflow: () => ({ workflow: state }),
      advanceMissionStep,
      isMissionDriverComplete: () => false,
    }));
    port.advanceMissionStep('mission-a', scope, 'step-a', ['evidence-a']);
    expect(advanceMissionStep).toHaveBeenCalledWith(
      'mission-a',
      'step-a',
      ['evidence-a'],
    );
  });

  it('createProductionPrevcPort fails closed when workflow is absent', () => {
    const scope = testProjectScope();
    const advanceMissionStep = vi.fn();
    const absent = createProductionPrevcPort(() => ({
      getMissionWorkflow: () => ({ workflow: null }),
      advanceMissionStep,
      isMissionDriverComplete: () => false,
    }));
    expect(() =>
      absent.advanceMissionStep('mission-a', scope, 'step-a', ['evidence-a']),
    ).toThrow(/workflow missing/);
    expect(advanceMissionStep).not.toHaveBeenCalled();
    expect(absent.isMissionComplete('mission-a', scope, ['step-a'])).toBe(false);
  });

  it('recognizes complete but refuses to advance it again', () => {
    const scope = testProjectScope();
    const advanceMissionStep = vi.fn();
    const completeState = {
      ...createWorkflowState('medium', BINDING),
      stage: 'complete' as const,
    };
    const done = createProductionPrevcPort(() => ({
      getMissionWorkflow: () => ({ workflow: completeState }),
      advanceMissionStep,
      isMissionDriverComplete: () => true,
    }));
    expect(() =>
      done.advanceMissionStep('mission-a', scope, 'step-a', ['evidence-a']),
    ).toThrow(/already complete/);
    expect(advanceMissionStep).not.toHaveBeenCalled();
    expect(done.isMissionComplete('mission-a', scope, ['step-a'])).toBe(true);
  });

  it('propagates registry failures instead of treating them as absence', () => {
    const scope = testProjectScope();
    const port = createProductionPrevcPort(() => {
      throw new Error('registry unavailable');
    });
    expect(() =>
      port.advanceMissionStep('mission-a', scope, 'step-a', ['evidence-a']),
    ).toThrow(/registry unavailable/);
    expect(() =>
      port.isMissionComplete('mission-a', scope, ['step-a']),
    ).toThrow(/registry unavailable/);
  });
});

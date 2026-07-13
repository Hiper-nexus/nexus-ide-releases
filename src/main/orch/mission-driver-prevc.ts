import type { WorkflowStage } from '../context/contract-compiler';
import {
  advanceWorkflow,
  type WorkflowEvidence,
  type WorkflowState,
} from '../context/prevc-engine';
import type { ProjectExecutionScope } from '../../shared/types';

/**
 * PREVC bridge for mission-driver advance/complete (Fase C).
 *
 * Production calls ContextWorkflowService.advance when a frozen workflow exists.
 * Pure helpers here wrap advanceWorkflow so unit tests can drive the real
 * PREVC gate without spinning up the full service.
 */

export interface PrevcAdvancePort {
  /**
   * Atomically advance PREVC and complete a mission milestone with trusted
   * evidence. Rejects without a frozen workflow or immutable receipt.
   */
  advanceMissionStep(
    missionId: string,
    scope: ProjectExecutionScope,
    stepId: string,
    evidenceIds: readonly string[],
  ): void | Promise<void>;
  /** True only when PREVC is complete and every step has a valid receipt. */
  isMissionComplete(
    missionId: string,
    scope: ProjectExecutionScope,
    stepIds: readonly string[],
  ): boolean;
}

/**
 * Pure wrapper: advance one PREVC stage via the real advanceWorkflow gate.
 * Callers supply current state, evidence, and requested next stage.
 */
export function advanceWorkflowStagePure(
  state: WorkflowState,
  evidence: WorkflowEvidence,
  requestedNext: WorkflowStage,
): WorkflowState {
  return advanceWorkflow(state, evidence, requestedNext);
}

/** Next stage on the route after current, or null if complete/off-route. */
export function nextWorkflowStage(
  state: WorkflowState,
): WorkflowStage | null {
  if (state.stage === 'complete') return null;
  const index = state.route.indexOf(state.stage);
  if (index < 0) return null;
  return state.route[index + 1] ?? 'complete';
}

/**
 * Production PREVC port: uses ContextWorkflowService when registry is ready.
 * Lazy-requires the registry so mission-driver-io stays importable in tests
 * that do not boot context workflow.
 */
export function createProductionPrevcPort(
  getService: (scope: ProjectExecutionScope) => {
    getMissionWorkflow(missionId: string): {
      workflow: WorkflowState | null;
    };
    advanceMissionStep(
      missionId: string,
      stepId: string,
      evidenceIds: readonly string[],
    ): unknown;
    isMissionDriverComplete(
      missionId: string,
      stepIds: readonly string[],
    ): boolean;
  },
): PrevcAdvancePort {
  return {
    advanceMissionStep(missionId, scope, stepId, evidenceIds) {
      const service = getService(scope);
      const { workflow } = service.getMissionWorkflow(missionId);
      if (!workflow) {
        throw new Error(`PREVC workflow missing for mission ${missionId}`);
      }
      if (workflow.stage === 'complete') {
        throw new Error(`PREVC workflow already complete for mission ${missionId}`);
      }
      const next = nextWorkflowStage(workflow);
      if (!next) {
        throw new Error(`PREVC workflow has no valid next stage for mission ${missionId}`);
      }
      service.advanceMissionStep(missionId, stepId, evidenceIds);
    },
    isMissionComplete(missionId, scope, stepIds) {
      const service = getService(scope);
      const { workflow } = service.getMissionWorkflow(missionId);
      return (
        workflow?.stage === 'complete' &&
        service.isMissionDriverComplete(missionId, stepIds)
      );
    },
  };
}

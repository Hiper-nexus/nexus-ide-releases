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
   * Advance the mission's PREVC workflow one stage when present.
   * No-op when no workflow is frozen for the mission.
   * Must use advanceWorkflow (or ContextWorkflowService.advance which does).
   */
  advanceWorkflowStage(
    missionId: string,
    scope: ProjectExecutionScope,
  ): void | Promise<void>;
  /**
   * True when PREVC workflow is absent OR already at stage `complete`.
   * Complete of the mission requires this (or a successful advance to complete).
   */
  isWorkflowCompleteOrAbsent(
    missionId: string,
    scope: ProjectExecutionScope,
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
    advance(missionId: string, next: WorkflowStage): WorkflowState;
  },
): PrevcAdvancePort {
  return {
    advanceWorkflowStage(missionId, scope) {
      let service: ReturnType<typeof getService>;
      try {
        service = getService(scope);
      } catch {
        // Registry not initialized — mission-only step path; no PREVC work.
        return;
      }
      const { workflow } = service.getMissionWorkflow(missionId);
      if (!workflow || workflow.stage === 'complete') return;
      const next = nextWorkflowStage(workflow);
      if (!next) return;
      // Real PREVC path — service.advance builds WorkflowEvidence and calls
      // store.advance → advanceWorkflow under the hood. Callers may soft-fail.
      service.advance(missionId, next);
    },
    isWorkflowCompleteOrAbsent(missionId, scope) {
      try {
        const { workflow } = getService(scope).getMissionWorkflow(missionId);
        if (!workflow) return true;
        return workflow.stage === 'complete';
      } catch {
        // Registry not initialized → treat as absent (mission-only steps).
        return true;
      }
    },
  };
}

import type { ProjectExecutionScope } from '../../shared/types';
import type { DriveAction } from './mission-drive';

/** Minimal snapshot needed to apply a decided action (avoids runtime cycle). */
export interface ApplySnapshot {
  readonly missionId: string;
  readonly scope: ProjectExecutionScope;
  readonly action: DriveAction;
}

/**
 * Active apply path for mission-driver actions (Fase C).
 *
 * Pure orchestration over injectable ports — no hidden IO. Tests inject fakes;
 * production wires real stores + handoff/PREVC gates.
 *
 * Invariants:
 *  - signal-stall never kills a worker (handoff-style signal only)
 *  - advance requires trusted-evidence gate (never agent self-declare)
 *  - fail-closed: rejected advance leaves step non-done
 */

export interface ApplyActionPorts {
  submitStalledHandoff(
    missionId: string,
    scope: ProjectExecutionScope,
    action: Extract<DriveAction, { kind: 'signal-stall' }>,
  ): void | Promise<void>;
  respawnFreshContext(
    missionId: string,
    scope: ProjectExecutionScope,
    reason: string,
  ): void | Promise<void>;
  reRoute(
    missionId: string,
    scope: ProjectExecutionScope,
    reason: string,
  ): void | Promise<void>;
  /**
   * Advance current step through trusted-evidence gate (+ optional PREVC
   * advanceWorkflow wrapper). Must reject when evidence is untrusted.
   */
  advanceStep(
    missionId: string,
    scope: ProjectExecutionScope,
    stepId: string,
  ): void | Promise<void>;
  /**
   * Human-side stop WITH a durable, operator-readable verdict in the mission
   * description. Never a silent `{status:'blocked'}` — the rail must be able
   * to name the cause.
   */
  blockHuman(
    missionId: string,
    scope: ProjectExecutionScope,
    reason: string,
  ): void | Promise<void>;
  appendLearning(
    missionId: string,
    scope: ProjectExecutionScope,
    entry: string,
  ): void | Promise<void>;
}

export type ApplyActionResult =
  | { readonly applied: true; readonly kind: DriveAction['kind'] }
  | { readonly applied: false; readonly kind: 'wait' }
  | {
      readonly applied: false;
      readonly kind: DriveAction['kind'];
      readonly error: string;
    };

/**
 * Apply a decided DriveAction via ports. `wait` is a no-op.
 * Errors from ports are rethrown so the runtime can log and isolate.
 */
export async function applyDriveAction(
  snapshot: ApplySnapshot,
  ports: ApplyActionPorts,
): Promise<ApplyActionResult> {
  const { action, missionId, scope } = snapshot;
  switch (action.kind) {
    case 'wait':
      return { applied: false, kind: 'wait' };
    case 'signal-stall':
      await ports.submitStalledHandoff(missionId, scope, action);
      return { applied: true, kind: 'signal-stall' };
    case 'respawn-fresh-context':
      // Ports own learning append (avoid double-write).
      await ports.respawnFreshContext(missionId, scope, action.reason);
      return { applied: true, kind: 'respawn-fresh-context' };
    case 're-route':
      await ports.reRoute(missionId, scope, action.reason);
      return { applied: true, kind: 're-route' };
    case 'advance':
      await ports.advanceStep(missionId, scope, action.stepId);
      return { applied: true, kind: 'advance' };
    case 'block-human':
      await ports.blockHuman(missionId, scope, action.reason);
      await ports.appendLearning(
        missionId,
        scope,
        `block-human: ${action.reason}`,
      );
      return { applied: true, kind: 'block-human' };
  }
}

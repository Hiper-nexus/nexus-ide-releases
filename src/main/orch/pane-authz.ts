import type { ProjectExecutionScope } from '../../shared/types';

/**
 * Object-level authorization for the pane MCP tools (SEC#5). The skill-gate
 * (gate.ts) only checks whether a tool NAME is allowed; it does nothing about
 * WHICH pane a call targets. Without this, any agent holding a token can
 * nexus_pane_read another agent's terminal (harvest secrets) or nexus_pane_write
 * into it (inject commands) — lateral escape between agents/missions.
 *
 * Pure logic, no electron/node imports, unit-tested directly (pane-registry.ts
 * resolves the live PaneAuthzInfo and calls in here). The rule set:
 *  - you may always act on your OWN pane;
 *  - the human's own agents (role 'user') are unrestricted — they act for the user;
 *  - a worker may never touch a shell pane (the user's terminal);
 *  - every other cross-pane access must stay inside the caller's OWN mission;
 *  - a worker may read/wait on but never write/close the orchestrator pane.
 */

export type PaneAction = 'read' | 'write' | 'close' | 'wait';

export type CallerRole = 'orchestrator' | 'worker' | 'user';

export interface CallerCtx {
  role: CallerRole;
  scope: ProjectExecutionScope;
  /** The mission the caller belongs to (undefined before mission_create). */
  missionId?: string;
  /** Frozen PREVC revision restored by main; never renderer-authored. */
  contextRevision?: string;
  /** The caller's own PTY session — acting on it is always allowed. */
  sessionId?: string;
}

export interface PaneAuthzInfo {
  paneId: string;
  sessionId: string | null;
  kind: 'shell' | 'cli-agent' | 'browser';
  missionId?: string;
  /** Frozen PREVC revision restored by main; never renderer-authored. */
  contextRevision?: string;
  role?: 'orchestrator' | 'worker';
  scope?: ProjectExecutionScope;
  /** Narrower worktree authority used by mission workers, when present. */
  executionScope?: ProjectExecutionScope;
}

export interface AuthzDecision {
  allow: boolean;
  reason?: string;
}

const WRITE_ACTIONS = new Set<PaneAction>(['write', 'close']);

export function authorizePaneAccess(
  caller: CallerCtx,
  pane: PaneAuthzInfo,
  action: PaneAction,
): AuthzDecision {
  if (
    !pane.scope ||
    caller.scope.projectId !== pane.scope.projectId ||
    caller.scope.checkoutId !== pane.scope.checkoutId
  ) {
    return { allow: false, reason: 'pane belongs to another project checkout' };
  }
  // Acting on your own pane is always fine (read your own tail, etc.).
  if (caller.sessionId && pane.sessionId && caller.sessionId === pane.sessionId) {
    return { allow: true };
  }
  // The user's directly-opened agents act on the user's behalf.
  if (caller.role === 'user') return { allow: true };

  // A worker must never reach the user's shell/browser — read (secret capture)
  // or write/navigate.
  if (caller.role === 'worker' && (pane.kind === 'shell' || pane.kind === 'browser')) {
    return {
      allow: false,
      reason: 'workers cannot access shell/browser panes (user surface)',
    };
  }

  // Any other cross-pane access is confined to the caller's own mission.
  if (!caller.missionId || pane.missionId !== caller.missionId) {
    return { allow: false, reason: 'pane belongs to another mission' };
  }

  // Inside the mission, a worker may observe the orchestrator pane but not
  // drive it (no injecting input into / closing the coordinator).
  if (
    caller.role === 'worker' &&
    pane.role === 'orchestrator' &&
    WRITE_ACTIONS.has(action)
  ) {
    return {
      allow: false,
      reason: 'workers cannot write to or close the orchestrator pane',
    };
  }

  return { allow: true };
}

/** Whether a caller may even SEE a pane in nexus_pane_list (info disclosure). */
export function canListPane(caller: CallerCtx, pane: PaneAuthzInfo): boolean {
  return authorizePaneAccess(caller, pane, 'read').allow;
}

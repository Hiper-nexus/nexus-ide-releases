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
 *  - the human's own agents (role 'user') are unrestricted — they act for the user,
 *    and keep that reach while leading a mission they were adopted into;
 *  - browser access stays in the caller's originating window and workspace;
 *  - a worker may never touch a shell pane (the user's terminal);
 *  - other terminal access must stay inside the caller's OWN mission;
 *  - a worker may read/wait on but never write/close the orchestrator pane.
 */

export type PaneAction = 'read' | 'write' | 'close' | 'wait';

export type CallerRole = 'orchestrator' | 'worker' | 'user';

export interface CallerCtx {
  role: CallerRole;
  scope: ProjectExecutionScope;
  /** Main-issued worktree authority; coordination scope alone is insufficient. */
  executionScope?: ProjectExecutionScope;
  /** The mission the caller belongs to (undefined before mission_create). */
  missionId?: string;
  /** Frozen PREVC revision restored by main; never renderer-authored. */
  contextRevision?: string;
  /** The caller's own PTY session — acting on it is always allowed. */
  sessionId?: string;
  /** Exact Main-issued generation for a mission worker, when present. */
  workerIncarnationId?: string;
  /** Main-derived renderer owner of the caller's physical session. */
  ownerWebContentsId?: number;
  /** Main-owned: this orchestrator is the operator's pane adopted by a mission. */
  promotedFromUserSession?: true;
}

export interface PaneAuthzInfo {
  /** Main-authored operator parent; absent for mission workers. */
  operatorParentSessionId?: string;
  paneId: string;
  sessionId: string | null;
  kind: 'shell' | 'cli-agent' | 'browser';
  /** Actual renderer owner, supplied only by the Main pane registry. */
  ownerWebContentsId?: number;
  missionId?: string;
  /** Frozen PREVC revision restored by main; never renderer-authored. */
  contextRevision?: string;
  role?: 'orchestrator' | 'worker';
  /** Exact physical worker generation; absent for orchestrators. */
  workerIncarnationId?: string;
  /**
   * F-231: worker de missão aberto pelo operador — mortalidade, TTL,
   * teardown e `nexus_pane_close` do Maestro não o fecham.
   */
  operatorOpened?: boolean;
  scope?: ProjectExecutionScope;
  /** Narrower worktree authority used by mission workers, when present. */
  executionScope?: ProjectExecutionScope;
}

export interface AuthzDecision {
  allow: boolean;
  reason?: string;
}

const WRITE_ACTIONS = new Set<PaneAction>(['write', 'close']);

export function sameExactPaneScope(
  left: ProjectExecutionScope,
  right: ProjectExecutionScope,
): boolean {
  return left.version === right.version &&
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath &&
    left.identitySource === right.identitySource;
}

export interface AutomatedReviewBrowserGrant {
  readonly paneId: string;
  readonly missionId: string;
  readonly scope: Readonly<ProjectExecutionScope>;
}

/**
 * Narrow object-level exception for a main-verified automated design review.
 * The caller must already have proved the active review session and exact
 * design profile before constructing `grant`; this pure layer only enforces
 * pane identity, mission/scope binding and the read-only action boundary.
 */
export function authorizeAutomatedReviewBrowserAccess(
  caller: CallerCtx,
  pane: PaneAuthzInfo,
  action: PaneAction,
  grant: AutomatedReviewBrowserGrant,
): AuthzDecision {
  if (caller.role !== 'worker') {
    return { allow: false, reason: 'automated review browser grant requires a worker' };
  }
  if (action !== 'read' && action !== 'wait') {
    return {
      allow: false,
      reason: 'automated reviewers may only inspect their bound browser pane',
    };
  }
  if (
    pane.kind !== 'browser' ||
    pane.paneId !== grant.paneId ||
    pane.missionId !== grant.missionId ||
    caller.missionId !== grant.missionId
  ) {
    return {
      allow: false,
      reason: 'browser pane is not bound to this automated review mission',
    };
  }
  if (
    !pane.scope ||
    caller.scope.version !== grant.scope.version ||
    caller.scope.installationId !== grant.scope.installationId ||
    caller.scope.projectId !== grant.scope.projectId ||
    caller.scope.checkoutId !== grant.scope.checkoutId ||
    caller.scope.rootRealPath !== grant.scope.rootRealPath ||
    caller.scope.identitySource !== grant.scope.identitySource ||
    pane.scope.version !== grant.scope.version ||
    pane.scope.installationId !== grant.scope.installationId ||
    pane.scope.projectId !== grant.scope.projectId ||
    pane.scope.checkoutId !== grant.scope.checkoutId ||
    pane.scope.rootRealPath !== grant.scope.rootRealPath ||
    pane.scope.identitySource !== grant.scope.identitySource
  ) {
    return {
      allow: false,
      reason: 'automated review browser pane belongs to another project checkout',
    };
  }
  return { allow: true };
}

export function authorizePaneAccess(
  caller: CallerCtx,
  pane: PaneAuthzInfo,
  action: PaneAction,
): AuthzDecision {
  if (
    !pane.scope ||
    caller.scope.installationId !== pane.scope.installationId ||
    caller.scope.projectId !== pane.scope.projectId ||
    caller.scope.checkoutId !== pane.scope.checkoutId
  ) {
    return { allow: false, reason: 'pane belongs to another project checkout' };
  }
  if (pane.kind === 'browser') {
    if (!sameExactPaneScope(caller.scope, pane.scope)) {
      return { allow: false, reason: 'browser pane belongs to another project checkout' };
    }
    if (!Number.isInteger(caller.ownerWebContentsId) ||
        !Number.isInteger(pane.ownerWebContentsId) ||
        caller.ownerWebContentsId! <= 0 ||
        caller.ownerWebContentsId !== pane.ownerWebContentsId) {
      return { allow: false, reason: 'browser pane belongs to another originating window' };
    }
    // Browser control follows the existing tool allowlist and effect policy,
    // including tabs opened directly by the operator in this same window.
    return { allow: true };
  }
  // Acting on your own pane is always fine (read your own tail, etc.).
  if (caller.sessionId && pane.sessionId && caller.sessionId === pane.sessionId) {
    return { allow: true };
  }
  // The user's directly-opened agents act on the user's behalf — also after a
  // mission adopted one as its orchestrator: leading a mission never takes
  // away what the operator's pane already reached (0.76.110).
  if (caller.role === 'user') return { allow: true };
  if (caller.role === 'orchestrator' && caller.promotedFromUserSession === true) {
    return { allow: true };
  }

  // F-231: pane aberto pelo operador dentro da missão é lido/escrito pelo
  // Maestro, mas só a mão do operador o fecha. O caller `user` (a própria
  // mão) já passou acima; qualquer participante de missão é recusado aqui.
  if (pane.operatorOpened === true && action === 'close') {
    return {
      allow: false,
      reason: 'pane aberto pelo operador: só ele fecha',
    };
  }

  // Browser control has its own origin boundary above. User shells retain the
  // existing worker restriction for read (secret capture) and write.
  if (caller.role === 'worker' && pane.kind === 'shell') {
    return {
      allow: false,
      reason: 'workers cannot access shell panes (user surface)',
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

  if (caller.role === 'worker' && WRITE_ACTIONS.has(action) &&
      (caller.executionScope ?? caller.scope).rootRealPath !==
        (pane.executionScope ?? pane.scope).rootRealPath) {
    return { allow: false, reason: 'workers cannot write to or close panes in another execution worktree' };
  }

  return { allow: true };
}

/** Whether a caller may even SEE a pane in nexus_pane_list (info disclosure). */
export function canListPane(caller: CallerCtx, pane: PaneAuthzInfo): boolean {
  return authorizePaneAccess(caller, pane, 'read').allow;
}

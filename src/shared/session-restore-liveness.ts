/**
 * Session restore liveness — one product rule for layout, rail and pet.
 *
 * Overclock job (behavior only, no copied code): reopen is a clean cockpit.
 * Only a mission that is actually running looks alive. Dead work is Parou,
 * not "Trabalhando" / "Pronta".
 *
 * Classes:
 * - live — maestro/worker process is running AND the mission still has a
 *   live plan/objective
 * - religado-without-plan — restore/resume path with no live plan
 * - dead-idle — empty leftover PTY, idle "Pronta para iniciar", plan-only
 *   leftover, or any persisted "running" without a live process
 */

export const SESSION_DEAD_REASON_CODE = 'session-dead' as const;
export const SESSION_DEAD_REASON_LABEL = 'Parou';

/** Leftover leftover card after restart — history stays, no PTY remount. */
export const SESSION_SLEEPING_REASON_CODE = 'session-sleeping' as const;
export const SESSION_SLEEPING_REASON_LABEL = 'Dormindo';

/** Preload/main injects this when a PTY hole is accepted. */
export const SKIPPED_TERMINAL_OUTPUT_MARKER =
  'skipped terminal output that could not be recovered';

/** Process start of this Nexus instance. Missions older than this are leftovers. */
export const NEXUS_PROCESS_STARTED_AT = Date.now();

export type SessionRestoreClass =
  | 'live'
  | 'dead-idle'
  | 'religado-without-plan';

export type RestoredPaneKind = 'shell' | 'cli-agent' | 'browser' | 'unknown';

export type RestoredProcessState =
  | 'busy'
  | 'spawning'
  | 'idle'
  | 'exited'
  | 'absent';

export interface SessionRestoreEvidence {
  readonly paneKind: RestoredPaneKind;
  /** Physical process: busy/spawning only. Idle is not "working". */
  readonly processState: RestoredProcessState;
  /** Mission still has an objective/plan that is actually in play. */
  readonly hasLivePlan: boolean;
  /** Restore/resume path (religado) rather than a first spawn. */
  readonly isRestoreResume: boolean;
  /** Leftover shell from the previous session (not a fresh placeholder). */
  readonly isEmptyLeftoverShell: boolean;
  /** Plan-only leftover with no execution runtime. */
  readonly isPlanOnlyLeftover: boolean;
  /** Row exists from before this process started. */
  readonly updatedBeforeAppBoot: boolean;
}

export function processIsRunning(
  processState: RestoredProcessState,
): boolean {
  return processState === 'busy' || processState === 'spawning';
}

/** Plano/objetivo ainda em jogo — sem isto o processo é zumbi, não missão. */
export function missionHasLivePlan(mission?: {
  readonly title?: string;
  readonly description?: string;
  readonly status?: string;
  readonly intentState?: string | null;
  readonly intentContract?: {
    readonly goal?: string;
    readonly lane?: string;
  } | null;
}): boolean {
  if (!mission) return false;
  const goal =
    mission.intentContract?.goal?.trim() ||
    mission.description?.trim() ||
    mission.title?.trim();
  if (!goal) return false;
  if (mission.intentState === 'awaiting_goal' || mission.intentState === 'draft') {
    return false;
  }
  if (mission.intentContract?.lane === 'plan' && mission.status !== 'running') {
    return false;
  }
  return (
    mission.status === 'running' ||
    mission.intentState === 'executing' ||
    mission.intentState === 'dispatched' ||
    mission.intentState === 'validating'
  );
}

export function wasUpdatedBeforeThisProcess(
  updatedAt: number,
  processStartedAt: number = NEXUS_PROCESS_STARTED_AT,
): boolean {
  return Number.isFinite(updatedAt) && updatedAt < processStartedAt;
}

export function classifySessionRestore(
  evidence: SessionRestoreEvidence,
): SessionRestoreClass {
  if (processIsRunning(evidence.processState) && evidence.hasLivePlan) {
    return 'live';
  }
  if (evidence.isRestoreResume && !evidence.hasLivePlan) {
    return 'religado-without-plan';
  }
  return 'dead-idle';
}

export function restoreLooksWorking(
  restoreClass: SessionRestoreClass,
): boolean {
  return restoreClass === 'live';
}

export const EMPTY_POST_RESET_MARKER = 'adopted pane vazio pós-reset';

/**
 * Recovered assistant dump with no PTY/prompt markers — a text graveyard,
 * not a live CLI. Fail-closed: markdown headings or Implementation Summary
 * without a shell prompt mean the PTY was never remounted.
 */
export function scrollbackLooksLikeRecoveredMarkdown(
  scrollback: string | undefined,
): boolean {
  const text = (scrollback ?? '').trim();
  if (!text) return false;
  const hasPtyMarker = /(?:\$ |% |❯ |nexus@|\x1b\[)/.test(text);
  if (hasPtyMarker) return false;
  return (
    /^#{1,6}\s+\S/m.test(text) || /Implementation Summary/i.test(text)
  );
}

export function leftoverScrollbackLooksUnreadable(
  scrollback: string | undefined,
): boolean {
  const text = scrollback ?? '';
  return (
    text.includes(SKIPPED_TERMINAL_OUTPUT_MARKER) ||
    text.includes(EMPTY_POST_RESET_MARKER) ||
    scrollbackLooksLikeRecoveredMarkdown(text)
  );
}

/**
 * Fail-closed: leftover leftover markdown / skipped-output with no live
 * process is a graveyard, not a working CLI cell.
 */
export function shouldHideDeadRecoveredPane(input: {
  readonly processRunning: boolean;
  readonly hasLeftoverScrollback: boolean;
  readonly scrollbackUnreadable?: boolean;
}): boolean {
  if (input.processRunning) return false;
  return (
    input.hasLeftoverScrollback || input.scrollbackUnreadable === true
  );
}

export function shouldRestoreAsWorkingGridCell(
  evidence: SessionRestoreEvidence,
): boolean {
  if (evidence.isEmptyLeftoverShell) return false;
  if (evidence.paneKind === 'browser') return true;
  return classifySessionRestore(evidence) === 'live';
}

export function shouldShowRailWorking(
  restoreClass: SessionRestoreClass,
): boolean {
  return restoreClass === 'live';
}

export function shouldShowPetReadyChrome(hasLiveMission: boolean): boolean {
  return hasLiveMission;
}

/**
 * Leftover running/pending without a live PTY and without files is dead
 * work: Parou, not Trabalhando. A fresh kickoff (receipt, leaf not born
 * yet) and a fresh pending the operator just armed stay visible.
 */
export function leftoverRunningOrPendingIsDead(input: {
  readonly status: string;
  readonly hasLivePty: boolean;
  readonly hasFiles: boolean;
  readonly isFreshKickoff?: boolean;
  readonly isFreshPending?: boolean;
}): boolean {
  if (input.hasLivePty || input.hasFiles) return false;
  if (input.status === 'running') return input.isFreshKickoff !== true;
  if (input.status === 'pending') return input.isFreshPending !== true;
  return false;
}

export function sessionDeadReason(): {
  readonly code: typeof SESSION_DEAD_REASON_CODE;
  readonly label: typeof SESSION_DEAD_REASON_LABEL;
} {
  return {
    code: SESSION_DEAD_REASON_CODE,
    label: SESSION_DEAD_REASON_LABEL,
  };
}

export function sessionSleepingReason(): {
  readonly code: typeof SESSION_SLEEPING_REASON_CODE;
  readonly label: typeof SESSION_SLEEPING_REASON_LABEL;
} {
  return {
    code: SESSION_SLEEPING_REASON_CODE,
    label: SESSION_SLEEPING_REASON_LABEL,
  };
}

export function isSessionDeadReasonCode(code: string | undefined): boolean {
  return (
    code === SESSION_DEAD_REASON_CODE ||
    code === SESSION_SLEEPING_REASON_CODE ||
    code === 'restore-failed' ||
    code === 'never-started-draft'
  );
}

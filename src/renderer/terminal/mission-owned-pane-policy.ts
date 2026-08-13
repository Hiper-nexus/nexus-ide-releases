/**
 * Posse de missão ≠ mudez. Decisões puras do restore/teclado para o
 * renderer não entrar no beco sync → block → retire → pane oco.
 */

export type StaleAuthorityAction = 'sync-once' | 'unlock-keyboard';

export function decideStaleAuthorityRecovery(input: {
  readonly restorePersistedAuthority: boolean;
  readonly autoResumeAlreadySpent: boolean;
}): StaleAuthorityAction {
  if (input.restorePersistedAuthority || input.autoResumeAlreadySpent) {
    return 'unlock-keyboard';
  }
  return 'sync-once';
}

export type ExitedPaneKeyAction =
  | 'resume-keyboard'
  | 'reclaim-shell'
  | 'ignore';

export type UnlockRetiredPaneDisposition = 'keep-paused' | 'reclaim-shell';

/**
 * Missão viva (pending/running/blocked) NÃO vira shell. Falha ao consultar
 * o status também preserva o pane — fail-closed, nunca destrói o histórico
 * do agente porque o IPC piscou.
 */
export function decideUnlockRetiredMissionPane(input: {
  readonly missionStatus?: 'pending' | 'running' | 'blocked' | 'done' | 'failed';
  readonly lookupFailed?: boolean;
}): UnlockRetiredPaneDisposition {
  if (input.lookupFailed) return 'keep-paused';
  if (
    input.missionStatus === 'pending' ||
    input.missionStatus === 'running' ||
    input.missionStatus === 'blocked'
  ) {
    return 'keep-paused';
  }
  return 'reclaim-shell';
}

export function decideExitedPaneKey(input: {
  readonly hasSession: boolean;
  readonly spawnStarted: boolean;
  readonly paneState: string | undefined;
  readonly missionOwns: boolean;
  readonly spawnHeld?: boolean;
}): ExitedPaneKeyAction {
  if (input.hasSession || input.spawnStarted) return 'ignore';
  if (input.spawnHeld && input.missionOwns) return 'resume-keyboard';
  if (input.paneState === 'hibernated' && input.missionOwns) {
    return 'resume-keyboard';
  }
  if (input.paneState !== 'exited') return 'ignore';
  return input.missionOwns ? 'resume-keyboard' : 'reclaim-shell';
}

function isTypableOperatorLeaf(pane: {
  readonly kind?: string;
  readonly isStructuralPlaceholder?: boolean;
}): boolean {
  if (pane.isStructuralPlaceholder === true) return false;
  return pane.kind === 'shell' || pane.kind === 'cli-agent';
}

/** True when pruning this pane would leave the operator with no typable leaf. */
export function pruneWouldLeaveOperatorMute(
  livePanes: readonly { readonly id: string; readonly kind?: string; readonly isStructuralPlaceholder?: boolean }[],
  paneId: string,
): boolean {
  return !livePanes.some(
    (pane) => pane.id !== paneId && isTypableOperatorLeaf(pane),
  );
}

export const MISSION_OWNED_EXIT_NOTICE =
  '[nexus] a missão ainda é dona deste pane — clique a missão no rail e use Retomar.';

export const STALE_AUTHORITY_SYNC_NOTICE =
  '[nexus] contexto antigo detectado — sincronizando a missão uma vez pela autoridade principal…';

export const STALE_AUTHORITY_UNLOCK_NOTICE =
  '[nexus] este pane não tem mais sessão. Digite para um shell aqui — a missão continua no rail.';

export const BLOCKED_RESUME_NOTICE =
  '[nexus] missão bloqueada — retomando pela autoridade principal…';

export const MISSION_HOLD_NOTICE =
  '[Nexus] Agente em pausa — a sessão anterior NÃO foi reiniciada automaticamente.\r\n' +
  '  Clique a missão no rail e use Retomar.\r\n';

export const STANDALONE_HOLD_NOTICE =
  '[Nexus] Agente em pausa — a sessão anterior NÃO foi reiniciada automaticamente.\r\n' +
  '  Confirme o diálogo ou retome a missão no rail quando quiser.\r\n';

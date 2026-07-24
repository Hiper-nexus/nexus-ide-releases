import type { PaneModel } from '../../shared/types';
import { sharedAgentAuthFamily } from '../../shared/agent-auth-family';
import { listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { getPaneSessionId } from '../terminal/terminal-host';

/**
 * Auth surfaces that cannot host two live orchestrators at once.
 * Claude CLI rewrites the same keychain item — dual orch = mutual logout.
 * Other adapters return null (parallel missions allowed when safe).
 */
export function sharedAuthFamily(adapterId: string | undefined): string | null {
  return sharedAgentAuthFamily(adapterId);
}

export function isExclusiveOrchestratorAdapter(adapterId: string | undefined): boolean {
  return sharedAuthFamily(adapterId) !== null;
}

/**
 * Live cli-agent panes that are orchestrators. Live means a real PTY session:
 * the shared-login collision this feeds (dual Claude orch = mutual keychain
 * logout) only exists for a RUNNING CLI. A layout pane whose spawn failed or
 * never started holds no credential — counting it blocked every new mission
 * behind a zombie ("orquestrador incompatível sem autoridade") with no exit
 * besides closing the pane by hand. The main process still owns the
 * authoritative race fence (assertExclusiveOrchestratorProcessAvailable).
 */
export function listLiveOrchestratorPanes(): PaneModel[] {
  return listPanes(useLayoutStore.getState().root).filter(
    (p) =>
      p.kind === 'cli-agent' &&
      p.role === 'orchestrator' &&
      Boolean(getPaneSessionId(p.id)),
  );
}

/**
 * Live orchestrator panes that would collide with spawning/reopening an
 * orchestrator for `incomingAdapterId` (shared login / keychain).
 */
export function conflictingOrchestratorPanes(
  incomingAdapterId: string | undefined,
): PaneModel[] {
  const family = sharedAuthFamily(incomingAdapterId);
  if (!family) return [];
  return listLiveOrchestratorPanes().filter(
    (p) => sharedAuthFamily(p.adapterId) === family,
  );
}

/** True when starting this adapter as orch would require killing another live orch. */
export function hardReopenWouldKillAgents(incomingAdapterId: string | undefined): boolean {
  return conflictingOrchestratorPanes(incomingAdapterId).length > 0;
}

/**
 * Kill PTY sessions for the given pane ids only (does not change layout).
 * Layout reconcile still kills hosts when panes leave the tree — keep those
 * panes in the tree when you want multi-mission without kill.
 */
export function killPaneSessions(paneIds: readonly string[]): void {
  for (const id of paneIds) {
    const sid = getPaneSessionId(id);
    if (sid) window.nexus.pty.kill(sid);
  }
}

/** Kill only live orchestrators that conflict with the incoming adapter. */
export function killConflictingOrchestrators(incomingAdapterId: string | undefined): string[] {
  const conflict = conflictingOrchestratorPanes(incomingAdapterId);
  killPaneSessions(conflict.map((p) => p.id));
  return conflict.map((p) => p.id);
}

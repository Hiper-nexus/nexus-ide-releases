import type { PaneModel } from '../../shared/types';
import { sharedAgentAuthFamily } from '../../shared/agent-auth-family';
import { listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { getPaneSessionId } from '../terminal/terminal-host';

/**
 * Auth surfaces that share a process-level login (Claude keychain).
 * Concurrent missions are allowed; this family is advisory, never a kill
 * fence. Main still refuses a second Maestro for the SAME mission.
 */
export function sharedAuthFamily(adapterId: string | undefined): string | null {
  return sharedAgentAuthFamily(adapterId);
}

export function isExclusiveOrchestratorAdapter(adapterId: string | undefined): boolean {
  return sharedAuthFamily(adapterId) !== null;
}

/**
 * Live cli-agent panes that are orchestrators. Live means a real PTY session:
 * a layout pane whose spawn failed or never started holds no credential.
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

/** Never kill another mission's Maestro to make room for this one. */
export function hardReopenWouldKillAgents(
  _incomingAdapterId: string | undefined,
): boolean {
  return false;
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

/** Never kill another mission's Maestro to make room for this one. */
export function killConflictingOrchestrators(
  _incomingAdapterId: string | undefined,
): string[] {
  return [];
}

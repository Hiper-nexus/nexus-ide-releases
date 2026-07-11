import type { PaneModel } from '../../shared/types';
import { listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { getPaneSessionId } from '../terminal/terminal-host';

/**
 * Auth surfaces that cannot host two live orchestrators at once.
 * Claude CLI rewrites the same keychain item — dual orch = mutual logout.
 * Other adapters return null (parallel missions allowed when safe).
 */
export function sharedAuthFamily(adapterId: string | undefined): string | null {
  if (!adapterId) return null;
  const id = adapterId.toLowerCase();
  if (id.includes('claude')) return 'claude-shared-login';
  return null;
}

export function isExclusiveOrchestratorAdapter(adapterId: string | undefined): boolean {
  return sharedAuthFamily(adapterId) !== null;
}

/** Live cli-agent panes that are orchestrators. */
export function listLiveOrchestratorPanes(): PaneModel[] {
  return listPanes(useLayoutStore.getState().root).filter(
    (p) => p.kind === 'cli-agent' && p.role === 'orchestrator',
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

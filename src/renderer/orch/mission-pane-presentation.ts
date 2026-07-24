import type { MissionOrchestratorPane } from '../../shared/orch-types';
import type { PaneModel } from '../../shared/types';
import { createPane, listPanes } from '../lib/split-tree';
import { useHomeStore } from '../state/home-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import {
  markPersistedAuthorityOnSpawn,
  waitForSession,
} from '../terminal/terminal-host';

export interface PresentMainOwnedMissionPaneResult {
  readonly ok: boolean;
  readonly pane: PaneModel;
  readonly error?: string;
}

interface PresentMainOwnedMissionPaneDeps {
  readonly waitForSession: (
    paneId: string,
    timeoutMs?: number,
  ) => Promise<string | null>;
}

export interface PresentMainOwnedMissionPaneOptions {
  readonly removePaneIds?: ReadonlySet<string>;
}

const DEFAULT_PRESENTATION_TIMEOUT_MS = 20_000;

function paneFromSealedAuthority(
  missionId: string,
  sealed: MissionOrchestratorPane,
): PaneModel {
  return {
    ...createPane(
      'cli-agent',
      sealed.cwd,
      sealed.adapterId,
      sealed.model,
    ),
    id: sealed.paneId,
    accountId: sealed.accountId,
    effort: sealed.effort,
    title: sealed.title,
    missionId,
    role: 'orchestrator',
    agentName: sealed.agentName,
  };
}

/**
 * Present the exact main-owned orchestrator process in the renderer.
 *
 * Bootstrap success is physical authority, not just a status bit: remove every
 * obsolete pane copy of the same mission, mount the newly sealed stable pane,
 * adopt its already-running PTY, and verify that the renderer attached to the
 * exact session returned by main before reporting success.
 */
export async function presentMainOwnedMissionPane(
  missionId: string,
  sealed: MissionOrchestratorPane,
  options: PresentMainOwnedMissionPaneOptions = {},
  deps: PresentMainOwnedMissionPaneDeps = { waitForSession },
): Promise<PresentMainOwnedMissionPaneResult> {
  const pane = paneFromSealedAuthority(missionId, sealed);
  const layout = useLayoutStore.getState();
  const orch = useOrchStore.getState();
  const existing = listPanes(layout.root);
  const removePaneIds = options.removePaneIds ?? new Set<string>();
  const kept = existing.filter((candidate) => {
    const boundMissionId =
      candidate.missionId ?? orch.paneMissions[candidate.id];
    return (
      boundMissionId !== missionId &&
      candidate.id !== pane.id &&
      !removePaneIds.has(candidate.id)
    );
  });

  // Mark before setPanes: mounting may synchronously attach the host and
  // consume the persisted-authority flag.
  markPersistedAuthorityOnSpawn(pane.id);
  orch.bindPaneMission(pane.id, missionId);
  useHomeStore.getState().hide();

  const next =
    kept.length === 0 || kept.every((candidate) => candidate.kind === 'shell')
      ? [pane]
      : [...kept, pane];
  layout.setPanes(next);
  layout.focus(pane.id);

  const adoptedSessionId = await deps.waitForSession(
    pane.id,
    DEFAULT_PRESENTATION_TIMEOUT_MS,
  );
  if (!adoptedSessionId) {
    return {
      ok: false,
      pane,
      error:
        'O processo principal iniciou a missão, mas o pane não adotou a sessão ativa.',
    };
  }
  if (adoptedSessionId !== sealed.sessionId) {
    return {
      ok: false,
      pane,
      error:
        'O pane adotou uma sessão diferente da autoridade criada pelo processo principal.',
    };
  }
  return { ok: true, pane };
}

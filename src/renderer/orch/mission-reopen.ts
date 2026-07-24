import type { Mission, MissionPaneSpec } from '../../shared/orch-types';
import type { PaneModel } from '../../shared/types';
import { createPane, listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { getActiveWorkspacePath } from '../state/active-workspace';
import {
  getPaneSessionId,
  markResumeOnSpawn,
  waitForSession,
} from '../terminal/terminal-host';
import {
  conflictingOrchestratorPanes,
  hardReopenWouldKillAgents,
} from './mission-launcher';

/**
 * One-click mission reopen: rebuild / merge the grid from the mission's
 * recorded pane composition — orchestrator first, then workers — with every
 * CLI re-spawned using resume flags so previous conversations continue.
 *
 * Soft focus: if the mission already has live panes, only focus them.
 * Soft multi: if another mission is live and there is no shared-login
 * conflict (e.g. dual Claude orch), merge panes — no kill of the other
 * mission (Orca-style parallel work).
 * Hard: forceHard or exclusive-auth conflict → kill conflicting (or all)
 * then restore this mission's composition.
 */

const MAX_REOPEN_PANES = 12;
const MAX_MERGED_PANES = 16;

export interface MissionReopenResult {
  ok: boolean;
  panes?: number;
  error?: string;
  /** True when we only focused existing panes (no hard reopen). */
  soft?: boolean;
  /** True when other live panes were kept (multi-mission). */
  multi?: boolean;
  /**
   * Intent-first shell (armed, no orchestrator pane yet). Caller should open
   * Nova Missão on the goal composer instead of spawning panes.
   */
  intentShell?: boolean;
  /** Correlates the voice/UI request to the exact physical readiness proof. */
  ackId?: string;
  /** Every restored pane had a concrete PTY session before success returned. */
  sessionIds?: string[];
  /** Wall clock of the successful orchestrator rebind/readiness acknowledgement. */
  ackedAt?: number;
}

function reopenAckId(missionId: string): string {
  const nonce = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `mission-reopen:${missionId}:${nonce}`;
}

function acknowledgedReopen(
  missionId: string,
  sessionIds: string[],
  rest: Omit<MissionReopenResult, 'ok' | 'ackId' | 'sessionIds' | 'ackedAt'>,
): MissionReopenResult {
  return {
    ok: true,
    ...rest,
    ackId: reopenAckId(missionId),
    sessionIds: [...sessionIds],
    ackedAt: Date.now(),
  };
}

/**
 * Armed / planned mission with no dispatched workers yet — intentional for
 * intent-first (agentic) flow. Has no pane composition to restore.
 */
export function isIntentFirstMissionShell(mission: Mission): boolean {
  const state = mission.intentState;
  if (
    state === 'awaiting_goal' ||
    state === 'draft' ||
    state === 'intent_compiling' ||
    state === 'ready_to_start' ||
    state === 'awaiting_approval'
  ) {
    return true;
  }
  // Pending shell without a recorded dispatch timestamp.
  if (
    mission.status === 'pending' &&
    !mission.intentContract?.dispatchedAt &&
    state !== 'dispatched' &&
    state !== 'executing' &&
    state !== 'validating' &&
    state !== 'done'
  ) {
    return true;
  }
  return false;
}

/** Live pane ids currently bound to this mission and present in the layout. */
export function livePaneIdsForMission(missionId: string): string[] {
  const { paneMissions } = useOrchStore.getState();
  const liveIds = Object.entries(paneMissions)
    .filter(([, mid]) => mid === missionId)
    .map(([paneId]) => paneId);
  if (liveIds.length === 0) return [];
  const present = new Set(listPanes(useLayoutStore.getState().root).map((p) => p.id));
  return liveIds.filter((id) => present.has(id));
}

/**
 * True when hard reopen would replace an existing layout (shells, browsers,
 * and/or CLI agents). Soft focus short-circuits when this mission is already live.
 */
export function hardReopenWouldDisplaceLayout(missionId: string): boolean {
  if (livePaneIdsForMission(missionId).length > 0) return false;
  return listPanes(useLayoutStore.getState().root).length > 0;
}

/** @deprecated use hardReopenWouldDisplaceLayout */
export function hardReopenWouldDisplaceAgents(missionId: string): boolean {
  return hardReopenWouldDisplaceLayout(missionId);
}

export { hardReopenWouldKillAgents };

function specsToPanes(
  specs: MissionPaneSpec[],
  missionId: string,
  fallbackCwd?: string,
): PaneModel[] {
  const ordered = specs.slice(0, MAX_REOPEN_PANES);
  return ordered.map((spec) => {
    const base = createPane(
      'cli-agent',
      spec.cwd ?? fallbackCwd,
      spec.adapterId,
      spec.model,
    );
    // Reusa o paneId ORIGINAL da missão: a captura de session-id do resume é
    // chaveada por (cwd, paneId) — com id novo o resume direcionado nunca
    // acertava e o --continue genérico retomava a conversa da OUTRA missão.
    const paneId = spec.paneId ?? base.id;
    markResumeOnSpawn(paneId);
    return {
      ...base,
      id: paneId,
      title: spec.title,
      accountId: spec.accountId,
      effort: spec.effort,
      missionId,
      role: spec.role,
      agentName: spec.agentName,
    };
  });
}

function primaryOrchestratorAdapter(specs: MissionPaneSpec[]): string | undefined {
  const orch = specs.find((s) => s.role === 'orchestrator');
  return orch?.adapterId ?? specs[0]?.adapterId;
}

/**
 * Soft focus when the mission is already open; otherwise reopen with
 * multi-mission merge when safe (no exclusive-auth dual orch).
 */
export async function reopenMission(
  mission: Mission,
  options?: { forceHard?: boolean },
): Promise<MissionReopenResult> {
  if (!options?.forceHard) {
    const live = livePaneIdsForMission(mission.id);
    if (live.length > 0) {
      const sessionIds = live.map((paneId) => getPaneSessionId(paneId));
      if (sessionIds.every((sessionId): sessionId is string => Boolean(sessionId))) {
        useLayoutStore.getState().focus(live[0]!);
        return acknowledgedReopen(mission.id, sessionIds, {
          panes: live.length,
          soft: true,
        });
      }
    }
  }

  let specs: MissionPaneSpec[] = [];
  try {
    specs = await window.nexus.orch.listMissionPanes(mission.id);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'falha ao ler os panes da missão',
    };
  }
  if (specs.length === 0) {
    // Intent-first / modo agêntico: the shell is armed with 0 panes on purpose.
    // Reopen means resume the goal wizard, not invent a pane history.
    if (isIntentFirstMissionShell(mission)) {
      return { ok: true, panes: 0, intentShell: true };
    }
    // Bootstrap-blocked mission: the orchestrator never materialized (zero
    // panes, teardown cleared the session). "Retomar" must retry the
    // main-owned bootstrap — there is no composition to restore and the
    // wizard's submit_goal is an invalid transition from blocked_technical.
    if (mission.status === 'blocked' && mission.intentState === 'blocked_technical') {
      const resumed = await window.nexus.orch.resumeMissionBootstrap({
        missionId: mission.id,
      });
      if (resumed.ok) {
        return acknowledgedReopen(mission.id, [resumed.pane.sessionId], {
          panes: 1,
          soft: false,
        });
      }
      return { ok: false, error: resumed.error };
    }
    return {
      ok: false,
      error:
        'Esta missão não tem panes registrados (criada antes do histórico de composição).',
    };
  }

  // Blocked mission with a persisted composition: re-arm BEFORE any pane
  // respawn. The persisted-pane spawn resolves the current authority seal
  // from the live mission, and that seal is null while status != running —
  // spawning first turned every resume into "stale or legacy persisted
  // mission pane authority".
  if (mission.status === 'blocked') {
    const rearmed = await window.nexus.orch.rearmMission({
      missionId: mission.id,
    });
    if (!rearmed.ok) return { ok: false, error: rearmed.error };
  }

  const fallbackCwd = getActiveWorkspacePath() ?? undefined;
  const panes = specsToPanes(specs, mission.id, fallbackCwd);
  const incomingAdapter = primaryOrchestratorAdapter(specs);
  const existing = listPanes(useLayoutStore.getState().root);
  const forceHard = options?.forceHard === true;
  const conflicts = conflictingOrchestratorPanes(incomingAdapter);
  // Exclude conflicts that are panes we're about to re-bind with same id.
  const newIds = new Set(panes.map((p) => p.id));
  const foreignConflicts = conflicts.filter((p) => !newIds.has(p.id));

  if (forceHard) {
    return {
      ok: false,
      error:
        'Reabertura forçada exige encerramento físico confirmado pelo processo principal. Feche a missão conflitante e tente novamente.',
    };
  } else if (foreignConflicts.length > 0) {
    return {
      ok: false,
      error:
        'Há um orquestrador com credencial exclusiva em execução. O Nexus não substitui esse processo sem prova física de saída.',
    };
  } else {
    // Safe multi-mission: keep every live pane, append this mission's panes.
    // (reconcileHosts only kills hosts for panes removed from the tree.)
    const kept = existing.filter((p) => !newIds.has(p.id));
    if (kept.length === 0) {
      useLayoutStore.getState().setPanes(panes);
    } else {
      const merged = [...kept, ...panes].slice(0, MAX_MERGED_PANES);
      useLayoutStore.getState().setPanes(merged);
    }
  }

  for (const pane of panes) {
    useOrchStore.getState().bindPaneMission(pane.id, mission.id);
  }

  // Focus the reopened mission's orchestrator (first pane).
  useLayoutStore.getState().focus(panes[0]!.id);

  // Physical acknowledgement: an updated layout is not proof that the CLI
  // sessions exist. Wait for every exact pane, then rebind the persisted
  // orchestrator before any caller (especially voice) may claim success.
  const maybeSessions = await Promise.all(
    panes.map((pane) => waitForSession(pane.id, 10_000)),
  );
  const missingIndex = maybeSessions.findIndex((sessionId) => !sessionId);
  if (missingIndex >= 0) {
    return {
      ok: false,
      error: `O pane ${panes[missingIndex]!.id} não confirmou uma sessão ativa.`,
    };
  }
  const sessionIds = maybeSessions as string[];
  const orchestratorIndex = Math.max(
    0,
    specs.findIndex((spec) => spec.role === 'orchestrator'),
  );
  const orchestratorSessionId = sessionIds[orchestratorIndex];
  if (!orchestratorSessionId) {
    return { ok: false, error: 'O orquestrador restaurado não confirmou sessão.' };
  }
  const rebound = await window.nexus.orch.rebindMissionOrchestrator(
    mission.id,
    orchestratorSessionId,
  );
  if (!rebound.ok) {
    return {
      ok: false,
      error: 'Os panes abriram, mas a autoridade da missão não foi restaurada.',
    };
  }

  const multi = !forceHard && existing.length > 0;
  return acknowledgedReopen(mission.id, sessionIds, {
    panes: panes.length,
    soft: false,
    multi,
  });
}

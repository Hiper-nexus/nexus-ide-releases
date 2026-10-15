import type { Mission, MissionPaneSpec } from '../../shared/orch-types';
import type { PaneModel } from '../../shared/types';
import { createPane, listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { getActiveWorkspacePath } from '../state/active-workspace';
import {
  getPaneSessionId,
  prepareMissionPaneResume,
  waitForSession,
} from '../terminal/terminal-host';
import { presentMainOwnedMissionPane } from './mission-pane-presentation';

/**
 * One-click mission reopen: rebuild / merge the grid from the mission's
 * recorded pane composition — orchestrator first, then workers — with every
 * CLI re-spawned using resume flags so previous conversations continue.
 *
 * Soft focus: if the mission already has live panes, only focus them.
 * Soft multi: if another mission is live, merge panes — no kill of the other
 * mission (parallel work). A second Claude Maestro is its own runtime.
 * Hard: forceHard is rejected; Main must prove physical exit first.
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
  /**
   * A7: panes que NÃO confirmaram sessão, sem derrubar a retomada — o
   * orquestrador já foi religado. Cada entrada nomeia o pane, o motivo e a
   * ação sugerida.
   */
  partialPanes?: Array<{ paneId: string; reason: string; action: string }>;
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

export { hardReopenWouldKillAgents } from './mission-auth-conflict';

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

/**
 * Soft focus when the mission is already open; otherwise reopen with
 * multi-mission merge. Another live Maestro is kept, never stolen.
 */
export async function reopenMission(
  mission: Mission,
  options?: { forceHard?: boolean },
): Promise<MissionReopenResult> {
  // Legacy hard reopen is no longer supported: reject before bootstrap,
  // persistence, pane construction or any spawn-capable renderer operation.
  if (options?.forceHard) {
    return {
      ok: false,
      error:
        'Reabertura forçada exige encerramento físico confirmado pelo processo principal. Feche a missão conflitante e tente novamente.',
    };
  }

  // A árvore de layout é uma só no renderer. Se o operador trocar de projeto
  // enquanto o Main responde, a árvore viva passa a ser a do OUTRO workspace e
  // a missão não pode entrar nela.
  const workspaceAtStart = getActiveWorkspacePath();
  const workspaceChanged = (): MissionReopenResult | null =>
    getActiveWorkspacePath() === workspaceAtStart
      ? null
      : {
          ok: false,
          error:
            'O projeto mudou enquanto a missão reabria. Volte ao projeto dela e tente de novo.',
        };

  // Every blocked mission resumes through the main-owned authority. Main
  // either adopts the exact still-live PTY or clears a proven-dead identity and
  // creates one fresh sealed pane. Renderer-side persisted-pane spawning here
  // creates ghost panes and circular "Retomar missão" failures.
  if (mission.status === 'blocked') {
    const resumed = await window.nexus.orch.resumeMissionBootstrap({
      missionId: mission.id,
    });
    // O processo já é do Main: na volta ao projeto dele, a apresentação o monta.
    const moved = workspaceChanged();
    if (moved) return moved;
    if (resumed.ok) {
      const presentation = await presentMainOwnedMissionPane(
        resumed.missionId,
        resumed.pane,
        {},
      );
      if (!presentation.ok) {
        return { ok: false, error: presentation.error };
      }
      return acknowledgedReopen(mission.id, [resumed.pane.sessionId], {
        panes: 1,
        soft: false,
      });
    }
    if (resumed.reason === 'review_required') {
      // Main physically retired the dead graph and published a fresh
      // awaiting_approval revision. Re-enter the native review wizard; never
      // restore an old pane or describe this as a resumed execution.
      return { ok: true, panes: 0, intentShell: true };
    }
    return { ok: false, error: resumed.error };
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
  const moved = workspaceChanged();
  if (moved) return moved;
  if (specs.length === 0) {
    // Intent-first / modo agêntico: the shell is armed with 0 panes on purpose.
    // Reopen means resume the goal wizard, not invent a pane history.
    if (isIntentFirstMissionShell(mission)) {
      return { ok: true, panes: 0, intentShell: true };
    }
    return {
      ok: false,
      error:
        'Esta missão não tem panes registrados (criada antes do histórico de composição).',
    };
  }

  const fallbackCwd = getActiveWorkspacePath() ?? undefined;
  const panes = specsToPanes(specs, mission.id, fallbackCwd);
  const existing = listPanes(useLayoutStore.getState().root);
  const newIds = new Set(panes.map((p) => p.id));
  const kept = existing.filter((pane) => !newIds.has(pane.id));
  // Um placeholder estrutural nunca reclamado pelo operador não é conteúdo:
  // os caminhos de apresentação main-owned já o substituem. Mantê-lo deixava
  // um shell vazio no primeiro tile (e, se maximizado, cobrindo a missão).
  const keptDurable =
    kept.length === 1 &&
    kept[0]!.kind === 'shell' &&
    kept[0]!.isStructuralPlaceholder === true
      ? []
      : kept;
  if (keptDurable.length + panes.length > MAX_MERGED_PANES) {
    return {
      ok: false,
      error:
        `A missão precisa de ${panes.length} pane(s), mas o grid só tem ` +
        `${Math.max(0, MAX_MERGED_PANES - keptDurable.length)} vaga(s). ` +
        'Feche panes que não pertencem à missão e tente novamente.',
    };
  }

  const existingIds = new Set(existing.map((pane) => pane.id));
  // Snapshot once. Reading the mutable host map separately for soft-focus and
  // preparation creates a TOCTOU hole where a changing session can make us
  // neither acknowledge it nor prepare its replacement.
  const existingSessionByPane = new Map(
    panes.map((pane) => [
      pane.id,
      existingIds.has(pane.id) ? getPaneSessionId(pane.id) : null,
    ]),
  );
  const existingSessionIds = panes.map(
    (pane) => existingSessionByPane.get(pane.id) ?? null,
  );
  if (
    existingSessionIds.every(
      (sessionId): sessionId is string => Boolean(sessionId),
    )
  ) {
    useLayoutStore.getState().focus(panes[0]!.id);
    return acknowledgedReopen(mission.id, existingSessionIds, {
      panes: panes.length,
      soft: true,
    });
  }

  // Safe multi-mission: keep every live pane, append this mission's panes.
  // (reconcileHosts only kills hosts for panes removed from the tree.)
  // setPanes BEFORE prepareMissionPaneResume: the resume kick re-reads the
  // layout pane, and the sealed accountId from specsToPanes must already be
  // there or the persisted-authority fence rejects as
  // `accountId[undefined != acct-…]`.
  if (keptDurable.length === 0) {
    useLayoutStore.getState().setPanes(panes);
  } else {
    useLayoutStore.getState().setPanes([...keptDurable, ...panes]);
  }

  // All rejection gates passed and blocked authority was rearmed. Only now may
  // renderer host preparation trigger a PTY adoption/resume. Live sessions are
  // deliberately skipped: they must never be reset, replaced, or left with a
  // latent resume flag.
  for (const pane of panes) {
    if (!existingSessionByPane.get(pane.id)) prepareMissionPaneResume(pane.id);
  }

  for (const pane of panes) {
    useOrchStore.getState().bindPaneMission(pane.id, mission.id);
  }

  // Focus the reopened mission's orchestrator (first pane).
  useLayoutStore.getState().focus(panes[0]!.id);

  // Physical acknowledgement: an updated layout is not proof that the CLI
  // sessions exist. A7: o orquestrador é aguardado PRIMEIRO e religado assim
  // que a sessão DELE confirma — um worker que não sobe vira resultado
  // parcial nomeado, sem derrubar o ack da missão nem impedir o rebind.
  const sessionWaits = panes.map((pane) => waitForSession(pane.id, 10_000));
  // Quem lidera é o MAIN. Duas leituras dele, nesta ordem: a sessão durável
  // (A) que alguma pane restaurada carrega, e a composição que ele registrou
  // em `listMissionPanes` (C). O `Math.max(0, findIndex(...))` antigo promovia
  // o PRIMEIRO pane a orquestrador sempre que nenhuma spec tinha o papel — o
  // rebind durável gravava no motor a mentira de que um worker era o líder.
  const roleOrchestratorIndex = panes.findIndex((pane) => pane.role === 'orchestrator');
  const durableSessionId = mission.orchestratorSessionId ?? null;
  let sessions: (string | null)[] | null = null;
  let orchestratorIndex = -1;
  let orchestratorSessionId: string | null = null;
  if (roleOrchestratorIndex >= 0) {
    const own = await sessionWaits[roleOrchestratorIndex]!;
    if (own && (!durableSessionId || own === durableSessionId)) {
      orchestratorIndex = roleOrchestratorIndex;
      orchestratorSessionId = own;
    }
  }
  if (orchestratorIndex < 0 && durableSessionId) {
    // O líder durável pode ser outro pane da composição: a identidade dele só
    // é conhecida quando a sessão daquele pane resolve.
    sessions = await Promise.all(sessionWaits);
    const durableLeaderIndex = sessions.indexOf(durableSessionId);
    if (durableLeaderIndex >= 0) {
      orchestratorIndex = durableLeaderIndex;
      orchestratorSessionId = durableSessionId;
    } else if (
      roleOrchestratorIndex >= 0 &&
      sessions[roleOrchestratorIndex]
    ) {
      orchestratorIndex = roleOrchestratorIndex;
      orchestratorSessionId = sessions[roleOrchestratorIndex]!;
    }
  }
  if (orchestratorIndex < 0) {
    if (roleOrchestratorIndex < 0) {
      return {
        ok: false,
        error:
          'A composição desta missão não registra um pane de orquestrador: nada foi promovido.',
      };
    }
    return { ok: false, error: 'O orquestrador restaurado não confirmou sessão.' };
  }
  const rebound = await window.nexus.orch.rebindMissionOrchestrator(
    mission.id,
    orchestratorSessionId!,
  );
  if (!rebound.ok) {
    return {
      ok: false,
      error: 'Os panes abriram, mas a autoridade da missão não foi restaurada.',
    };
  }

  // Com a liderança religada, os demais panes são aguardados até o fim; quem
  // falhou entra como parcial nomeado (pane, motivo, ação).
  const resolvedSessions: (string | null)[] =
    sessions ?? (await Promise.all(sessionWaits));
  const failedPanes = panes
    .map((pane, index) => ({ pane, sessionId: resolvedSessions[index] }))
    .filter((entry) => !entry.sessionId)
    .map((entry) => ({
      paneId: entry.pane.id,
      reason: 'não confirmou uma sessão ativa no prazo',
      action: 'use Retomar novamente para recriar este pane',
    }));
  const sessionIds = resolvedSessions.filter(
    (sessionId): sessionId is string => Boolean(sessionId),
  );

  const multi = existing.length > 0;
  return acknowledgedReopen(mission.id, sessionIds, {
    panes: panes.length,
    soft: false,
    multi,
    ...(failedPanes.length > 0 ? { partialPanes: failedPanes } : {}),
  });
}

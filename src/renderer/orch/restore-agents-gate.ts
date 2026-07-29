import type { PaneModel } from '../../shared/types';
import type { OrchSettings } from '../../shared/settings-types';
import { DEFAULT_ORCH_SETTINGS } from '../../shared/settings-types';
import {
  setRestoredPanesHandler,
  useLayoutStore,
} from '../state/layout-store';
import { askConfirm } from '../state/confirm-store';
import {
  discardPaneSpawnState,
  holdSpawnUntilApproved,
  releaseHeldSpawns,
} from '../terminal/terminal-host';
import { isAutomatedReviewerPaneIdentity } from '../../shared/automated-reviewer-pane';
import { useOrchStore } from '../state/orch-store';
import { listPanes } from '../lib/split-tree';
import { getActiveWorkspacePath } from '../state/active-workspace';

/**
 * Cross-platform gate for restored agents.
 *
 * Same Electron renderer path on macOS, Linux and Windows — no platform
 * branches. Mission panes resume automatically through their persisted
 * main-owned authority; only standalone agents follow the operator preference.
 */

export type AgentRestorePolicy = OrchSettings['agentRestorePolicy'];

/** Pure: policy → action (unit-tested, OS-independent). */
export function resolveAgentRestoreAction(
  policy: AgentRestorePolicy | string | undefined,
): 'ask' | 'pause' | 'resume' {
  if (policy === 'pause' || policy === 'resume' || policy === 'ask') {
    return policy;
  }
  return 'ask';
}

/** Coalesce concurrent restore prompts (layout handler + App double-call). */
let promptInFlight: Promise<void> | null = null;
/** Agent pane ids waiting for the in-flight ask decision. */
const pendingAskIds = new Set<string>();
/** Last ask outcome — waiters apply the same decision to their batch. */
let lastAskDecision: 'resume' | 'pause' | null = null;

function agentLabel(pane: PaneModel): string {
  const name = pane.title?.trim() || pane.agentName?.trim() || pane.adapterId;
  return name || 'agente';
}

function looksLikeMissionAgent(pane: PaneModel): boolean {
  return Boolean(
    pane.missionId ||
    pane.role === 'orchestrator' ||
    pane.role === 'worker',
  );
}

const missionAuthorityChecks = new Map<string, Promise<boolean>>();
const orphanPrunesInFlight = new Set<string>();
const MISSION_AUTHORITY_INITIAL_RETRY_DELAY_MS = 100;
const MISSION_AUTHORITY_MAX_RETRY_DELAY_MS = 400;
let restoreWorkspacePath: string | null | undefined;
let restoreWorkspaceEpoch = 0;
let restoreWorkspaceAbortController = new AbortController();

interface RestoreWorkspaceGeneration {
  readonly path: string | null;
  readonly epoch: number;
  readonly signal: AbortSignal;
}

function invalidateRestoreWorkspaceGeneration(path: string | null): void {
  restoreWorkspaceAbortController.abort();
  restoreWorkspaceAbortController = new AbortController();
  restoreWorkspacePath = path;
  restoreWorkspaceEpoch += 1;
  missionAuthorityChecks.clear();
  orphanPrunesInFlight.clear();
}

function captureRestoreWorkspaceGeneration(): RestoreWorkspaceGeneration {
  const path = getActiveWorkspacePath();
  if (path !== restoreWorkspacePath) {
    invalidateRestoreWorkspaceGeneration(path);
  }
  return Object.freeze({
    path,
    epoch: restoreWorkspaceEpoch,
    signal: restoreWorkspaceAbortController.signal,
  });
}

function isCurrentRestoreWorkspaceGeneration(
  generation: RestoreWorkspaceGeneration,
): boolean {
  return (
    !generation.signal.aborted &&
    restoreWorkspacePath === generation.path &&
    restoreWorkspaceEpoch === generation.epoch &&
    getActiveWorkspacePath() === generation.path
  );
}

function missionAuthorityKey(
  pane: PaneModel,
  generation: RestoreWorkspaceGeneration,
): string {
  return [
    generation.epoch,
    generation.path ?? '',
    pane.missionId ?? '',
    pane.id,
  ].join('\u0000');
}

function waitForMissionAuthorityRetry(
  delayMs: number,
  generation: RestoreWorkspaceGeneration,
): Promise<boolean> {
  if (!isCurrentRestoreWorkspaceGeneration(generation)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const finish = (shouldRetry: boolean) => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      generation.signal.removeEventListener('abort', cancel);
      resolve(shouldRetry);
    };
    const cancel = () => finish(false);
    timeoutId = setTimeout(
      () => finish(isCurrentRestoreWorkspaceGeneration(generation)),
      delayMs,
    );
    generation.signal.addEventListener('abort', cancel, { once: true });
  });
}

async function requestMissionPaneAuthority(
  pane: PaneModel,
  generation: RestoreWorkspaceGeneration,
): Promise<boolean> {
  let retryDelayMs = MISSION_AUTHORITY_INITIAL_RETRY_DELAY_MS;
  while (isCurrentRestoreWorkspaceGeneration(generation)) {
    try {
      const isAuthorized = await window.nexus.orch.canRestoreMissionPane({
        missionId: pane.missionId!,
        paneId: pane.id,
      });
      if (!isCurrentRestoreWorkspaceGeneration(generation)) {
        throw new Error('restore generation changed');
      }
      return isAuthorized;
    } catch (error) {
      if (!isCurrentRestoreWorkspaceGeneration(generation)) throw error;
      const shouldRetry = await waitForMissionAuthorityRetry(
        retryDelayMs,
        generation,
      );
      if (!shouldRetry) throw error;
      retryDelayMs = Math.min(
        retryDelayMs * 2,
        MISSION_AUTHORITY_MAX_RETRY_DELAY_MS,
      );
    }
  }
  throw new Error('restore generation changed');
}

function confirmMissionPaneAuthority(
  pane: PaneModel,
  generation: RestoreWorkspaceGeneration,
): Promise<boolean> {
  if (!pane.missionId) return Promise.resolve(false);
  const key = missionAuthorityKey(pane, generation);
  const existing = missionAuthorityChecks.get(key);
  if (existing) return existing;
  const check = requestMissionPaneAuthority(pane, generation).finally(() => {
    if (missionAuthorityChecks.get(key) === check) {
      missionAuthorityChecks.delete(key);
    }
  });
  missionAuthorityChecks.set(key, check);
  return check;
}

function pruneOrphanMissionPane(
  pane: PaneModel,
  generation: RestoreWorkspaceGeneration,
): void {
  if (!isCurrentRestoreWorkspaceGeneration(generation)) return;
  const key = missionAuthorityKey(pane, generation);
  if (orphanPrunesInFlight.has(key)) return;
  orphanPrunesInFlight.add(key);
  try {
    // Close while the spawn is still held. If layout cleanup ever throws, the
    // pane remains fail-closed instead of becoming runnable by accident.
    useLayoutStore.getState().close(pane.id, 'restore-orphan-mission-pane');
    discardPaneSpawnState(pane.id);
    const livePaneIds = new Set(
      listPanes(useLayoutStore.getState().root).map((item) => item.id),
    );
    useOrchStore.getState().pruneMissionBindings(livePaneIds);
  } finally {
    queueMicrotask(() => orphanPrunesInFlight.delete(key));
  }
}

async function loadPolicy(): Promise<AgentRestorePolicy> {
  try {
    const orch = await window.nexus.settings.orchGet();
    return resolveAgentRestoreAction(
      orch.agentRestorePolicy ?? DEFAULT_ORCH_SETTINGS.agentRestorePolicy,
    );
  } catch {
    return DEFAULT_ORCH_SETTINGS.agentRestorePolicy;
  }
}

function applyDecision(
  ids: readonly string[],
  decision: 'resume' | 'pause',
): void {
  if (ids.length === 0) return;
  if (decision === 'resume') {
    releaseHeldSpawns(ids, { resume: true });
    return;
  }
  releaseHeldSpawns(ids, { resume: false });
  // Stay held so a later attach cannot silent-spawn without an explicit reopen.
  for (const id of ids) holdSpawnUntilApproved(id);
}

/**
 * Hold restored CLI agents and apply the product policy. Safe default is
 * ask → dialog with focus on cancel ("Deixar em pausa").
 */
export async function gateRestoredAgents(
  panes: readonly PaneModel[],
): Promise<void> {
  const restoreGeneration = captureRestoreWorkspaceGeneration();
  const agents = panes.filter(
    (pane) =>
      pane.kind === 'cli-agent' &&
      pane.transient !== true &&
      !isAutomatedReviewerPaneIdentity(pane),
  );
  if (agents.length === 0) return;

  // Always hold first so a fast attach cannot race before policy resolves.
  for (const pane of agents) holdSpawnUntilApproved(pane.id);

  // Layout metadata is not authority. Main validates the exact
  // (missionId,paneId,approved revision) before a provider resume is requested.
  const missionAgents = agents.filter(looksLikeMissionAgent);
  const confirmedMissionIds: string[] = [];
  await Promise.all(
    missionAgents.map(async (pane) => {
      try {
        const isAuthorized = await confirmMissionPaneAuthority(
          pane,
          restoreGeneration,
        );
        if (!isCurrentRestoreWorkspaceGeneration(restoreGeneration)) return;
        if (isAuthorized) {
          confirmedMissionIds.push(pane.id);
          return;
        }
        pruneOrphanMissionPane(pane, restoreGeneration);
      } catch (error) {
        if (!isCurrentRestoreWorkspaceGeneration(restoreGeneration)) return;
        // Main may be restarting. Fail closed and retain the hold; absence of a
        // reply is not proof that the durable pane is an orphan.
        console.warn(
          `[restore] mission pane authority unavailable pane=${pane.id}:`,
          error,
        );
      }
    }),
  );
  if (isCurrentRestoreWorkspaceGeneration(restoreGeneration)) {
    releaseHeldSpawns(confirmedMissionIds, { resume: true });
  } else {
    return;
  }

  const restorable = agents.filter((pane) => !looksLikeMissionAgent(pane));
  if (restorable.length === 0) return;
  const ids = restorable.map((pane) => pane.id);

  const action = resolveAgentRestoreAction(await loadPolicy());
  if (!isCurrentRestoreWorkspaceGeneration(restoreGeneration)) return;

  if (action === 'resume') {
    applyDecision(ids, 'resume');
    return;
  }

  if (action === 'pause') {
    applyDecision(ids, 'pause');
    return;
  }

  // action === 'ask' — merge concurrent batches into one dialog.
  for (const id of ids) pendingAskIds.add(id);

  if (promptInFlight) {
    await promptInFlight;
    // Primary prompt already applied lastAskDecision to the full pending set.
    return;
  }

  promptInFlight = (async () => {
    const snapshotIds = [...pendingAskIds];
    const labels = restorable.slice(0, 5).map(agentLabel).join(', ');
    const more =
      restorable.length > 5 ? ` e mais ${restorable.length - 5}` : '';
    const count = Math.max(snapshotIds.length, restorable.length);
    const ok = await askConfirm({
      title: 'Retomar agentes da sessão anterior?',
      body:
        `Este workspace tinha ${count} agente(s) avulso(s) ` +
        `(${labels}${more}).\n\n` +
        'Se retomar agora, eles podem continuar a trabalhar sozinhos — ' +
        'comandos, edições e tools — sem pedir de novo a cada passo.\n\n' +
        'Isso vale em qualquer SO (macOS, Linux, Windows). Missões do ' +
        'autopiloto retomam pela autoridade persistida; esta escolha afeta ' +
        'somente agentes avulsos.\n\n' +
        'Cancelar deixa os agentes avulsos em pausa.',
      confirmLabel: 'Retomar agentes',
      cancelLabel: 'Deixar em pausa',
      danger: true,
    });

    lastAskDecision = ok ? 'resume' : 'pause';
    const batch = [...pendingAskIds];
    pendingAskIds.clear();
    applyDecision(batch, lastAskDecision);
  })();

  try {
    await promptInFlight;
  } finally {
    promptInFlight = null;
  }
}

/** Wire layout restore → hold + policy. Call once at app boot (all platforms). */
export function installRestoredAgentsGate(): void {
  setRestoredPanesHandler((panes) => {
    void gateRestoredAgents(panes);
  });
}

/** Drop pending ask state (workspace close / tests). */
export function resetRestoredAgentsGate(): void {
  promptInFlight = null;
  pendingAskIds.clear();
  lastAskDecision = null;
  invalidateRestoreWorkspaceGeneration(getActiveWorkspacePath());
}

/** @deprecated use resetRestoredAgentsGate */
export const resetRestoredAgentsGateForTests = resetRestoredAgentsGate;

import { useEffect } from 'react';
import { noticeJevRouteFallback } from './jev-route-notice';
import type {
  MissionPaneRecoveryRequest,
  MissionPaneRecoveryResult,
  MissionPanePresentationRequest,
  PaneParkRequest,
  PaneRegistryEntry,
} from '../../shared/orch-types';
import type { PaneModel } from '../../shared/types';
import {
  useLayoutStore,
  whenWorkspaceLayoutSettled,
} from '../state/layout-store';
import { getActiveWorkspacePath } from '../state/active-workspace';
import { useOrchStore } from '../state/orch-store';
import { useSessionStateStore } from '../state/session-state-store';
import { useWorkspaceStore } from '../state/workspace-store';
import {
  createPane,
  isStructuralPlaceholderPane,
  listPanes,
  MAX_LIVE_PANES_HARD,
} from '../lib/split-tree';
import {
  cancelPaneRecovery,
  getPaneSessionId,
  holdSpawnUntilApproved,
  isPaneSessionHealthy,
  markPaneClosingDeliberately,
  markPaneParked,
  markPersistedAuthorityOnSpawn,
  onPaneSessionChange,
  respawnMissionPaneFresh,
  submitPromptToPaneConfirmed,
  waitForHealthyPaneSession,
  waitForSession,
} from '../terminal/terminal-host';
import { waitForBrowserPaneCreated } from '../browser/browser-host';
import { initAgentNotificationBridge } from './agent-notification-bridge';
import { reflectLeadershipFromMissions } from './leadership-reflect';
import type { Handoff } from '../../shared/orch-types';
import {
  newlyDispatchedPlanMissionIds,
  usePlanLaneMetricsStore,
} from '../state/plan-lane-metrics-store';

/**
 * Renderer half of the orchestration bridge:
 *  - answers main-process pane spawn/close requests (the renderer owns the
 *    layout tree, so panes must be created here);
 *  - mirrors the pane set (paneId ↔ sessionId ↔ metadata) into the main
 *    process registry that backs nexus_pane_list / nexus_pane_read;
 *  - keeps the orchestration store hydrated via change events.
 */

function snapshotPanes(): PaneRegistryEntry[] {
  const { root } = useLayoutStore.getState();
  const paneStates = useSessionStateStore.getState().paneStates;
  return listPanes(root).map((pane) => ({
    paneId: pane.id,
    sessionId: getPaneSessionId(pane.id),
    // O número que o operador lê no header viaja junto para o Main poder
    // aceitar "pane 7" como alvo nas ferramentas MCP.
    paneNumber: pane.paneNumber,
    title: pane.title,
    kind: pane.kind,
    adapterId: pane.adapterId,
    model: pane.model,
    accountId: pane.accountId,
    state: paneStates.get(pane.id),
  }));
}

/**
 * Coalesced pane sync: multiple rapid state changes (layout + session + state)
 * collapse into a single IPC call per animation frame. Prevents IPC storms
 * when spawning/closing multiple panes simultaneously.
 */
let syncPanesScheduled = false;
function scheduleSyncPanes(): void {
  if (syncPanesScheduled) return;
  syncPanesScheduled = true;
  requestAnimationFrame(() => {
    syncPanesScheduled = false;
    // The rAF can outlive the bridge (window torn down between schedule and
    // frame, e.g. test teardown or window close); skip instead of throwing.
    window.nexus?.orch?.syncPanes(snapshotPanes());
  });
}

/** Immediate sync for critical paths (cleanup, final mirror). */
function syncPanesNow(): void {
  syncPanesScheduled = false; // Cancel any pending rAF
  window.nexus.orch.syncPanes(snapshotPanes());
}

function cleanupFailedOrchPane(
  request: { readonly requestId: string; readonly paneId: string },
  paneId: string | null,
): void {
  const pane = listPanes(useLayoutStore.getState().root).find((candidate) => {
    if (candidate.kind !== 'cli-agent') return false;
    if (paneId) {
      return (
        candidate.id === paneId &&
        (candidate.orchRequestId === request.requestId ||
          candidate.orchRequestId === undefined)
      );
    }
    return candidate.orchRequestId === request.requestId;
  });
  if (pane) {
    useLayoutStore.getState().close(pane.id, 'orch-spawn-failed');
  }
  // Explicit final mirror: layout subscriptions also publish changes, but the
  // Main result must never overtake the cleanup snapshot.
  syncPanesNow();
}

/**
 * Um orquestrador por missão. O main só emite grant de spawn de orquestrador
 * DEPOIS de provar o exit físico da sessão anterior (cerca exclusiva de auth
 * + respawn do fast-lane), então qualquer OUTRO pane de orquestrador da mesma
 * missão que ainda esteja no layout é cadáver — restaurado do boot com grant
 * de sessão morta ou sobra de revival. Sem esta aposentadoria o boot deixa
 * DOIS panes de orquestrador na tela e o morto trava com mensagens de erro
 * que o operador lê como pane vivo (teclado não responde).
 */
function retireStaleMissionOrchestratorPanes(req: {
  readonly missionId?: string;
  readonly role?: string;
  readonly keepPaneId: string | null;
}): void {
  if (req.role !== 'orchestrator' || !req.missionId) return;
  const paneMissions = useOrchStore.getState().paneMissions;
  const stale = listPanes(useLayoutStore.getState().root).filter((pane) => {
    if (pane.kind !== 'cli-agent') return false;
    if (pane.id === req.keepPaneId) return false;
    // Quem tem sessão viva fica — e isso JÁ é o líder confirmado pelo Main: o
    // par (missão, sessão durável) só casa com um pane que carrega a sessão de
    // A, exatamente o que este cinto protege. Não há eleição aqui para corrigir.
    if (getPaneSessionId(pane.id)) return false;
    if ((pane.role ?? 'worker') !== 'orchestrator') return false;
    const missionId = pane.missionId ?? paneMissions[pane.id];
    return missionId === req.missionId;
  });
  for (const pane of stale) {
    useLayoutStore.getState().close(pane.id, 'orchestrator-replaced');
  }
  if (stale.length > 0) {
    // O mirror no main precisa perder o cadáver na mesma hora em que o pane
    // novo nasce — senão nexus_pane_list mostra dois orquestradores.
    syncPanesNow();
  }
}

/**
 * Missão terminal (done/failed): os panes dela são APOSENTADOS, nunca apagados.
 *
 * Antes esta varredura FECHAVA (`close` + `syncPanesNow`, que PERSISTE) todo
 * worker sem sessão viva. Duas coisas estavam erradas:
 *
 * 1. `getPaneSessionId` responde "sem sessão" enquanto os hosts do renderer
 *    estão drenados numa troca de workspace — então um pane VIVO era
 *    classificado como cadáver e apagado do layout durável.
 * 2. Apagar é irreversível e ninguém pediu. Esta porta, junto com o gate de
 *    restore, fez 7 panes de uma missão `done` sumirem em campo — com a main
 *    ainda dona dos 7.
 *
 * Agora só SEGURAMOS o spawn: o pane fica no layout, com o histórico, e não
 * reexecuta sozinho. Fechar é ação explícita do operador ("Limpar projeto →
 * Fechar todos os panes"). `blocked` preserva (Retomar precisa do contexto);
 * sessão viva é lifecycle do main, o renderer não toca em pane vivo.
 *
 * F-108 continua valendo: o ORQUESTRADOR não entra nesta varredura. O motor
 * marcar done (CLI já saiu) apagava o Maestro e o operador perdia o canal para
 * revisar e pedir ajuste. Quem fecha o coordenador é só o humano.
 */
function retireTerminalMissionPanes(
  missions: readonly { id: string; status: string }[],
): void {
  if (missions.length === 0) return; // hidratação/travessia não varre nada
  const terminalIds = new Set(
    missions
      .filter((m) => m.status === 'done' || m.status === 'failed')
      .map((m) => m.id),
  );
  if (terminalIds.size === 0) return;
  const paneMissions = useOrchStore.getState().paneMissions;
  const retired = listPanes(useLayoutStore.getState().root).filter((pane) => {
    if (pane.kind !== 'cli-agent') return false;
    if ((pane.role ?? 'worker') === 'orchestrator') return false;
    const missionId = pane.missionId ?? paneMissions[pane.id];
    if (!missionId || !terminalIds.has(missionId)) return false;
    return !getPaneSessionId(pane.id);
  });
  for (const pane of retired) holdSpawnUntilApproved(pane.id);
}

const recoveryInFlight = new Set<string>();
const recoveryResults = new Map<string, MissionPaneRecoveryResult>();
const RECOVERY_HEALTH_TIMEOUT_MS = 75_000;
const presentationInFlight = new Map<string, Promise<void>>();

interface PresentationScope {
  readonly workspacePath: string | null;
  readonly workspaceEpoch: number;
}

function cacheRecoveryResult(result: MissionPaneRecoveryResult): void {
  recoveryResults.set(result.requestId, result);
  if (recoveryResults.size <= 64) return;
  const oldest = recoveryResults.keys().next().value as string | undefined;
  if (oldest) recoveryResults.delete(oldest);
}

function paneFromRecovery(req: MissionPaneRecoveryRequest): PaneModel {
  if (req.pane.role !== req.role) {
    throw new Error('mission pane role does not match recovery request');
  }
  const base = createPane(
    'cli-agent',
    req.pane.cwd,
    req.pane.adapterId,
    req.pane.model,
  );
  return {
    ...base,
    id: req.paneId,
    title: req.pane.title,
    accountId: req.pane.accountId,
    effort: req.pane.effort,
    missionId: req.missionId,
    agentName: req.pane.agentName,
    role: req.role,
    orchRequestId: req.requestId,
  };
}

function capturePresentationScope(): PresentationScope {
  return {
    workspacePath: getActiveWorkspacePath(),
    workspaceEpoch: useOrchStore.getState().workspaceEpoch,
  };
}

function isPresentationScopeCurrent(scope: PresentationScope): boolean {
  return (
    getActiveWorkspacePath() === scope.workspacePath &&
    useOrchStore.getState().workspaceEpoch === scope.workspaceEpoch
  );
}

function presentationKey(
  req: MissionPanePresentationRequest,
  scope: PresentationScope,
): string {
  return JSON.stringify([
    scope.workspacePath,
    scope.workspaceEpoch,
    req.paneId,
    req.sessionId,
  ]);
}

function isExactHealthyPresentation(
  req: MissionPanePresentationRequest,
): boolean {
  const pane = listPanes(useLayoutStore.getState().root).find(
    (candidate) => candidate.id === req.paneId,
  );
  if (req.transport === 'acp') {
    return (
      pane?.kind === 'cli-agent' &&
      pane.missionId === req.missionId &&
      pane.role === req.role &&
      pane.agentTransport === 'acp'
    );
  }
  return (
    pane?.kind === 'cli-agent' &&
    pane.missionId === req.missionId &&
    pane.role === req.role &&
    getPaneSessionId(req.paneId) === req.sessionId &&
    isPaneSessionHealthy(req.paneId, req.sessionId)
  );
}

function paneFromPresentation(
  req: MissionPanePresentationRequest,
): PaneModel {
  const base = createPane(
    'cli-agent',
    req.pane.cwd,
    req.pane.adapterId,
    req.pane.model,
  );
  return {
    ...base,
    id: req.paneId,
    title: req.pane.title,
    accountId: req.pane.accountId,
    effort: req.pane.effort,
    missionId: req.missionId,
    agentName: req.pane.agentName,
    role: req.role,
    agentTransport: req.transport ?? 'cli-pty',
  };
}

function isStructuralWorkspacePlaceholder(pane: PaneModel): boolean {
  return isStructuralPlaceholderPane(pane);
}

/**
 * A fresh workspace owns one explicitly marked structural shell until the
 * first real surface is mounted. The marker is cleared when the operator opens
 * that terminal, so shape alone can never authorize an automated close of a
 * live manual shell.
 */
function panesAfterMainOwnedPresentation(
  existing: PaneModel[],
  pane: PaneModel,
): PaneModel[] {
  const current = existing.find((candidate) => candidate.id === pane.id);
  const presented = current
    ? { ...current, ...pane }
    : pane;
  if (!current) {
    return (
      existing.length === 1 &&
      isStructuralWorkspacePlaceholder(existing[0]!)
    )
      ? [presented]
      : [...existing, presented];
  }

  const others = existing.filter((candidate) => candidate.id !== pane.id);
  const next = (
    others.length === 1 &&
    isStructuralWorkspacePlaceholder(others[0]!)
  )
    ? [presented]
    : existing.map((candidate) =>
        candidate.id === pane.id ? presented : candidate,
      );
  return next.every((candidate, index) => candidate === existing[index])
    ? existing
    : next;
}

/**
 * I4 — the presentation channel owns focus for the pane it just mounted.
 *
 * `setPanes` focuses the FIRST pane of the new set, which on a merge is the
 * pane that was already there. Presenting a mission then left the operator
 * focused on the previous surface, with the mission mounted somewhere else on
 * the grid. The renderer-side sibling (presentMainOwnedMissionPane) has always
 * focused its pane; the Main-owned channel never did.
 *
 * Only a NEW mount takes focus: Main replays presentations for panes that are
 * already live, and those must not steal focus from the operator.
 */
function focusFreshlyPresentedPane(
  paneId: string,
  existedBefore: boolean,
  role?: string,
): void {
  if (existedBefore) return;
  if (role === 'worker') return;
  useLayoutStore.getState().focus(paneId);
}

/**
 * `setPanes` enforces MAX_LIVE_PANES_HARD by TRUNCATING the tail, and
 * `panesAfterMainOwnedPresentation` appends the presented pane last — so on a
 * saturated grid the pane this request just presented is exactly the one
 * discarded. Reporting success for it left Main waiting out the full
 * 75s session timeout for a pane that was never mounted.
 */
function assertPresentedPaneMounted(paneId: string): void {
  const mounted = listPanes(useLayoutStore.getState().root).some(
    (pane) => pane.id === paneId,
  );
  if (mounted) return;
  throw new Error(
    `main-owned pane was not mounted (layout at the ${MAX_LIVE_PANES_HARD}-pane cap): ${paneId}`,
  );
}

function normalizeExactHealthyPresentation(
  req: MissionPanePresentationRequest,
): void {
  const layout = useLayoutStore.getState();
  const existing = listPanes(layout.root);
  const current = existing.find((candidate) => candidate.id === req.paneId);
  if (!current) return;
  const next = panesAfterMainOwnedPresentation(
    existing,
    paneFromPresentation(req),
  );
  if (next === existing) return;
  layout.setPanes(next);
}

async function presentLiveMainOwnedPane(
  req: MissionPanePresentationRequest,
  scope: PresentationScope,
): Promise<void> {
  // The bridge mounts before the workspace layout hydrates. Presenting first
  // let the later hydrate replace the mission panes with the persisted
  // structural placeholder (empty tile covering a live mission). Order is the
  // contract: hydrate settles, then presentations land on the final tree.
  await whenWorkspaceLayoutSettled();
  if (!isPresentationScopeCurrent(scope)) return;
  const existing = listPanes(useLayoutStore.getState().root);
  const current = existing.find((pane) => pane.id === req.paneId);
  if (current && current.kind !== 'cli-agent') {
    throw new Error('main-owned pane id collides with a non-agent pane');
  }
  if (
    current &&
    ((current.missionId && current.missionId !== req.missionId) ||
      (current.role && current.role !== req.role))
  ) {
    throw new Error('main-owned pane presentation identity diverged');
  }

  if (req.transport === 'acp') {
    useOrchStore.getState().bindPaneMission(req.paneId, req.missionId);
    const pane = current ? { ...current, agentTransport: 'acp' as const } : paneFromPresentation(req);
    const next = panesAfterMainOwnedPresentation(existing, pane);
    if (next !== existing) useLayoutStore.getState().setPanes(next);
    focusFreshlyPresentedPane(req.paneId, current !== undefined, req.role);
    assertPresentedPaneMounted(req.paneId);
    return;
  }

  // This flag asks the PTY boundary to adopt persisted Main authority. It
  // never grants a fresh renderer-authored spawn.
  markPersistedAuthorityOnSpawn(req.paneId);
  useOrchStore.getState().bindPaneMission(req.paneId, req.missionId);
  const pane = current ?? paneFromPresentation(req);
  const next = panesAfterMainOwnedPresentation(existing, pane);
  if (next !== existing) {
    useLayoutStore.getState().setPanes(next);
  }
  focusFreshlyPresentedPane(req.paneId, current !== undefined, req.role);
  assertPresentedPaneMounted(req.paneId);

  const sessionId = await waitForSession(
    req.paneId,
    RECOVERY_HEALTH_TIMEOUT_MS,
  );
  // Layout and terminal hosts are renderer-global. A late response from A
  // must never inspect, close or otherwise mutate a homonymous pane in B.
  if (!isPresentationScopeCurrent(scope)) return;
  if (sessionId !== req.sessionId) {
    throw new Error(
      sessionId
        ? 'main-owned pane adopted a different session'
        : 'main-owned pane presentation did not attach in time',
    );
  }
}

function requestLiveMainOwnedPanePresentation(
  req: MissionPanePresentationRequest,
): void {
  const scope = capturePresentationScope();
  if (!isPresentationScopeCurrent(scope)) return;
  if (isExactHealthyPresentation(req)) {
    normalizeExactHealthyPresentation(req);
    return;
  }
  const key = presentationKey(req, scope);
  if (presentationInFlight.has(key)) return;
  const flight = presentLiveMainOwnedPane(req, scope)
    .catch((error) => {
      if (!isPresentationScopeCurrent(scope)) return;
      console.warn(
        `[orch-bridge] main-owned presentation failed pane=${req.paneId}:`,
        error,
      );
    })
    .finally(() => {
      if (presentationInFlight.get(key) === flight) {
        presentationInFlight.delete(key);
      }
    });
  presentationInFlight.set(key, flight);
}

async function recoverMissionPane(
  req: MissionPaneRecoveryRequest,
  scope: PresentationScope,
): Promise<MissionPaneRecoveryResult> {
  let replacementSessionId: string | undefined;
  let recoveryOwned = false;
  try {
    // Same ordering contract as presentLiveMainOwnedPane: never race the
    // workspace layout hydrate with recovery-mounted panes.
    await whenWorkspaceLayoutSettled();
    // O layout que assentou pode ser o de OUTRO workspace: o operador trocou
    // de projeto enquanto a recovery esperava. A árvore agora é a de B e o
    // pane da missão de A não entra nela (o Main já retomou a missão headless).
    if (!isPresentationScopeCurrent(scope)) {
      throw new Error('renderer workspace changed during pane recovery');
    }
    let pane = listPanes(useLayoutStore.getState().root).find(
      (candidate) => candidate.id === req.paneId,
    );
    if (pane && pane.kind !== 'cli-agent') {
      throw new Error('stable mission pane is not a CLI agent');
    }
    if (pane) {
      replacementSessionId = await respawnMissionPaneFresh(
        pane,
        req.expectedSessionId,
        RECOVERY_HEALTH_TIMEOUT_MS,
        req.requestId,
      );
      // The helper owns cleanup until its CAS check, spawn and health check
      // succeed. Only then may this request cancel the exact replacement.
      recoveryOwned = true;
    } else {
      pane = paneFromRecovery(req);
      recoveryOwned = true;
      markPersistedAuthorityOnSpawn(pane.id);
      useOrchStore.getState().bindPaneMission(pane.id, req.missionId);
      const existing = listPanes(useLayoutStore.getState().root);
      // Same placeholder rule as presentations: a lone structural shell is
      // never operator content — the recovered mission pane replaces it
      // instead of leaving a permanent empty tile beside the mission.
      useLayoutStore
        .getState()
        .setPanes(panesAfterMainOwnedPresentation(existing, pane));
      replacementSessionId =
        (await waitForHealthyPaneSession(
          pane.id,
          req.expectedSessionId,
          RECOVERY_HEALTH_TIMEOUT_MS,
        )) ?? undefined;
      if (!replacementSessionId) {
        throw new Error('missing mission pane did not become healthy');
      }
    }

    // Vínculo de WORKER é classificação: pode ser gravado já. O de orquestrador
    // é ESPELHO da liderança — o Main ainda não sabe desta sessão nova, então
    // escrever aqui pintava a estrela de um líder que o motor não reconhece
    // (o orquestrador órfão do F-561) e o layout virava autoridade.
    if (req.role !== 'orchestrator') {
      useOrchStore.getState().bindPaneMission(req.paneId, req.missionId);
    }
    syncPanesNow(); // Critical: main needs latest state before prompt injection
    if (
      !(await submitPromptToPaneConfirmed(
        req.paneId,
        req.recap,
        replacementSessionId,
      )) ||
      !isPaneSessionHealthy(req.paneId, replacementSessionId)
    ) {
      throw new Error('mission recap was not submitted to a healthy session');
    }
    if (req.role === 'orchestrator') {
      const rebound = await window.nexus.orch.rebindMissionOrchestrator(
        req.missionId,
        replacementSessionId,
      );
      if (!rebound.ok) {
        throw new Error('fresh pane session was not rebound to mission');
      }
      // Só depois do rebind durável o renderer pode afirmar quem lidera.
      useOrchStore.getState().bindPaneMission(req.paneId, req.missionId);
      reflectLeadershipFromMissions(useOrchStore.getState().missions);
    }
    scheduleSyncPanes(); // Final state update, can be coalesced
    return {
      requestId: req.requestId,
      ok: true,
      paneId: req.paneId,
      sessionId: replacementSessionId,
    };
  } catch (error) {
    if (recoveryOwned) {
      cancelPaneRecovery(req.paneId, replacementSessionId);
      syncPanesNow(); // Critical cleanup path
    }
    return {
      requestId: req.requestId,
      ok: false,
      paneId: req.paneId,
      ...(replacementSessionId
        ? { sessionId: replacementSessionId }
        : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function useOrchBridge(): void {
  const hydrate = useOrchStore((s) => s.hydrate);
  const workspaceHydrated = useWorkspaceStore((s) => s.hydrated);
  const workspacePath = useWorkspaceStore((s) => s.current?.path ?? null);

  useEffect(() => {
    useOrchStore.getState().resetProjectState();
    if (workspaceHydrated && workspacePath) void hydrate(workspacePath);
  }, [hydrate, workspaceHydrated, workspacePath]);

  useEffect(() => {
    // First handoffs/missions payloads are snapshots — do not treat as live events.

    const un = [
      window.nexus.orch.onPaneSpawnRequest((req) => {
        console.info(
          `[orch] pane spawn received id=${req.requestId} mission=${req.missionId ?? "none"} role=${req.role ?? "none"}`,
        );
        void (async () => {
          let paneId: string | null = null;
          try {
            const existing = listPanes(useLayoutStore.getState().root).find(
              (pane) => pane.orchRequestId === req.requestId,
            );
            if (existing && existing.id !== req.paneId) {
              throw new Error(
                `Spawn retry pane id mismatch: ${existing.id} != ${req.paneId}`,
              );
            }
            if (!existing) {
              retireStaleMissionOrchestratorPanes({
                ...req,
                keepPaneId: req.paneId,
              });
            }
            paneId = existing?.id ??
              useLayoutStore.getState().spawnOrchPane({
                paneId: req.paneId,
                adapterId: req.adapterId,
                model: req.model,
                accountId: req.accountId,
                effort: req.effort,
                cwd: req.cwd,
                title: req.title,
                orchRequestId: req.requestId,
                missionId: req.missionId,
                transient: req.transient,
                agentName: req.agentName,
                role: req.role ?? 'worker',
                ...(req.parentPaneId ? { parentPaneId: req.parentPaneId } : {}),
                ...(req.route ? { spawnRoute: req.route } : {}),
              });
            console.info(
              `[orch] pane spawn materialized id=${req.requestId} pane=${paneId}`,
            );
            noticeJevRouteFallback(req.route);
            useOrchStore.getState().bindPaneMission(paneId, req.missionId);
            // The pane identity is already main-owned and durable enough to
            // address. Do not make the MCP caller pay for a cold CLI boot just
            // to learn that identity; the late session bind remains authorized
            // by the still-pending main grant.
            if (req.allowPending) {
              syncPanesNow();
              window.nexus.orch.sendPaneSpawnResult({
                requestId: req.requestId,
                ok: true,
                paneId,
                sessionId: null,
                pending: true,
              });
            }
            const sessionId = await waitForSession(paneId, 75_000);
            console.info(
              `[orch] pane spawn session result id=${req.requestId} pane=${paneId} session=${sessionId ?? "none"}`,
            );
            if (!sessionId) {
              if (!req.allowPending) {
                cleanupFailedOrchPane(req, paneId);
                window.nexus.orch.sendPaneSpawnResult({
                  requestId: req.requestId,
                  ok: false,
                  paneId,
                  error: 'session did not start (adapter missing or spawn failed)',
                });
                return;
              }
              // A sessão pode materializar depois do timeout local. O ACK
              // pendente acima já resolveu o contrato sem declarar falha e
              // mantém o pane vivo para nexus_pane_wait_idle.
              console.info(
                `[orch] pane spawn still pending id=${req.requestId} pane=${paneId}`,
              );
              return;
            }
            syncPanesNow(); // Critical: main needs state before result
            window.nexus.orch.sendPaneSpawnResult({
              requestId: req.requestId,
              ok: true,
              paneId,
              sessionId,
            });
          } catch (err) {
            cleanupFailedOrchPane(req, paneId);
            window.nexus.orch.sendPaneSpawnResult({
              requestId: req.requestId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      }),

      window.nexus.orch.onPaneRecoveryRequest((req) => {
        const cached = recoveryResults.get(req.requestId);
        if (cached) {
          window.nexus.orch.sendPaneRecoveryResult(cached);
          return;
        }
        if (recoveryInFlight.has(req.requestId)) return;
        recoveryInFlight.add(req.requestId);
        void recoverMissionPane(req, capturePresentationScope()).then((result) => {
          recoveryInFlight.delete(req.requestId);
          cacheRecoveryResult(result);
          window.nexus.orch.sendPaneRecoveryResult(result);
        });
      }),

      window.nexus.orch.onBrowserOpenRequest((req) => {
        void (async () => {
          let paneId: string | null = null;
          try {
            paneId = useLayoutStore
              .getState()
              .addBrowserPane(req.url, req.paneId, req.requestId);
            if (paneId !== req.paneId) {
              throw new Error('browser pane identity mismatch');
            }
            await waitForBrowserPaneCreated(paneId);
            syncPanesNow(); // Critical: main needs state before result
            window.nexus.orch.sendBrowserOpenResult({
              requestId: req.requestId,
              ok: true,
              paneId,
            });
          } catch (err) {
            if (paneId) {
              useLayoutStore.getState().close(paneId, 'browser-open-failed');
              syncPanesNow(); // Critical cleanup
            }
            window.nexus.orch.sendBrowserOpenResult({
              requestId: req.requestId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      }),

      window.nexus.orch.onPaneCloseRequest((request) => {
        const paneId = typeof request === 'string' ? request : request.paneId;
        if (typeof request !== 'string' && 'closingSessionId' in request) {
          // Aviso prévio: o exit que vem a seguir não pode oferecer shell.
          markPaneClosingDeliberately(paneId, request.closingSessionId);
          return;
        }
        if (typeof request !== 'string' && 'expectedSessionId' in request) {
          // O main encerra a sessão ANTES de pedir o fechamento (prova de
          // saída), e o exit zera o host: sem sessão é o mesmo pane, já morto.
          // Recusar aí deixava todo helper com autoCloseOnHandoff aberto.
          // Só uma sessão NOVA e viva (pane reaproveitado) segura o pane.
          const current = getPaneSessionId(paneId);
          if (current !== null && current !== request.expectedSessionId) return;
        } else if (typeof request !== 'string') {
          const pane = listPanes(useLayoutStore.getState().root).find(
            (candidate) => candidate.id === request.paneId,
          );
          const ownsBrowserAttempt =
            pane?.kind === 'browser' &&
            pane.browserOpenRequestId === request.requestId;
          const ownsOrchAttempt =
            pane?.kind === 'cli-agent' &&
            pane.orchRequestId === request.requestId;
          if (!ownsBrowserAttempt && !ownsOrchAttempt) {
            return;
          }
        }
        useLayoutStore.getState().close(paneId, 'orch-close-request');
        syncPanesNow(); // Critical: close request needs immediate sync
      }),

      window.nexus.orch.onPaneParkRequest((request: PaneParkRequest) => {
        markPaneParked(request);
      }),

      window.nexus.mission.onChanged((items) => {
        useOrchStore.getState().setMissionSummaries(items);
      }),

      window.nexus.orch.onMissionsChanged((missions) => {
        const prev = useOrchStore.getState().missions;
        const prevLanes = new Map(
          prev.map((m) => [m.id, m.intentContract?.lane] as const),
        );
        useOrchStore.getState().setMissions(missions);
        retireTerminalMissionPanes(missions);
        // Plan-lane adoption metric (local only; seen-id dedupe + empty-prev skip).
        const metrics = usePlanLaneMetricsStore.getState();
        for (const id of newlyDispatchedPlanMissionIds(
          prevLanes,
          missions.map((m) => ({
            id: m.id,
            status: m.status,
            lane: m.intentContract?.lane,
          })),
        )) {
          metrics.notePlanDispatched(id);
        }
        // Vincula o pane do ORQUESTRADOR à missão dele (via sessionId): sem
        // isto a missão nova nunca constava como aberta — o rail oferecia
        // "retomar" na missão viva e o clique matava/respawnava ela mesma.
        // Índice pane→missão: diz a quem o pane PERTENCE, nunca quem lidera.
        const panes = listPanes(useLayoutStore.getState().root);
        for (const mission of missions) {
          if (!mission.orchestratorSessionId) continue;
          const pane = panes.find(
            (p) => getPaneSessionId(p.id) === mission.orchestratorSessionId,
          );
          if (pane) {
            useOrchStore.getState().bindPaneMission(pane.id, mission.id);
          }
        }
        // E o espelho: o Main é a autoridade, o layout é consequência. O
        // orquestrador que NÃO bate com a sessão durável dele é rebaixado, e o
        // que bate ganha a estrela. Reaplicar o mesmo broadcast não escreve.
        reflectLeadershipFromMissions(missions);
      }),
      window.nexus.orch.onHandoffsChanged((handoffs: Handoff[]) =>
        useOrchStore.getState().setHandoffs(handoffs),
      ),
      window.nexus.orch.onTodosChanged((lists) =>
        useOrchStore.getState().setTodoLists(lists),
      ),
      window.nexus.orch.onSquadsChanged((squads) =>
        useOrchStore.getState().setSquads(squads),
      ),
    ];
    const onPanePresentationRequest =
      window.nexus.orch.onPanePresentationRequest;
    if (onPanePresentationRequest) {
      un.push(
        onPanePresentationRequest((req) =>
          requestLiveMainOwnedPanePresentation(req),
        ),
      );
    }

    // Pane mirror, fully event-driven (no heartbeat): push on every layout
    // change AND when a pane's sessionId materializes after its async spawn —
    // the exact event the old 1s setInterval was polling for.
    // Coalesced via rAF to batch rapid successive changes into one IPC call.
    const unsubLayout = useLayoutStore.subscribe(() => {
      // Bindings pane→missão de panes que saíram do layout morrem junto —
      // senão a missão deslocada fica "aberta" para sempre (não-clicável).
      const live = new Set(
        listPanes(useLayoutStore.getState().root).map((p) => p.id),
      );
      useOrchStore.getState().pruneMissionBindings(live);
      scheduleSyncPanes();
    });
    const unsubSession = onPaneSessionChange(() => {
      // A estrela depende do par (missão, sessão durável). No boot o broadcast
      // de missões chega ANTES do PTY anexar, então sem esta segunda passada o
      // espelho nunca convergia: o líder confirmado ficava sem estrela até o
      // próximo broadcast — que pode nunca vir.
      reflectLeadershipFromMissions(useOrchStore.getState().missions);
      scheduleSyncPanes();
    });
    const unsubState = useSessionStateStore.subscribe(() => {
      scheduleSyncPanes();
    });
    // Inbox de notificações de agentes: transições busy→idle sustentado /
    // exited viram itens no sininho da workspace bar (fora do state-store).
    const stopNotifBridge = initAgentNotificationBridge();
    usePlanLaneMetricsStore.getState().hydrate();
    syncPanesNow();

    return () => {
      un.forEach((fn) => fn());
      unsubLayout();
      unsubSession();
      unsubState();
      stopNotifBridge();
    };
  }, []);
}

import { reportLicenseDenial } from '../state/access-guard';
import type { MissionPaneRestoreAuthority } from '../../shared/orch-types';
import { useAccessStore } from '../state/access-store';
import type { PaneModel } from '../../shared/types';
import type { OrchSettings } from '../../shared/settings-types';
import { DEFAULT_ORCH_SETTINGS } from '../../shared/settings-types';
import {
  setRestoredPanesHandler,
  useLayoutStore,
} from '../state/layout-store';
import { askChoice } from '../state/choice-store';
import {
  discardPaneSpawnState,
  holdSpawnUntilApproved,
  isSpawnHeld,
  releaseHeldSpawns,
  setHeldPaneNotice,
} from '../terminal/terminal-host';
import {
  MISSION_AUTHORITY_PENDING_NOTICE,
  missionPaneRestoreHoldNotice,
} from '../terminal/mission-owned-pane-policy';
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

/**
 * O que o operador decide para os agentes avulsos da sessão anterior.
 * `close` descarta: o pane sai do layout sem nunca ter subido um processo
 * (o spawn estava retido). Missão e shell nunca passam por aqui.
 */
type RestoreDecision = 'resume' | 'pause' | 'close';
const CLOSE_REASON = 'restore-gate-discard';

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
const accessPending = new Map<string, { pane: PaneModel; path: string | null }>();
let unsubscribeAccess: (() => void) | undefined;

/**
 * Lote do diálogo "ask" POR GERAÇÃO de workspace (F-1269). Globais únicos
 * faziam o gate de B esperar a promessa de A — e o finalizador de A limpava
 * os ids de B antes de sair por geração obsoleta: B ficava retido sem
 * diálogo próprio. Cada geração tem o seu lote e a sua promessa; o
 * finalizador só limpa o que é dele.
 */
interface AskBatch {
  /** Agent pane ids waiting for this generation's ask decision. */
  readonly ids: Set<string>;
  inFlight: Promise<void> | null;
}
const askBatches = new Map<number, AskBatch>();

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

/**
 * Mission identity for restore authority. Layout `missionId` is metadata;
 * the orch store may hold the binding when the layout row lost it. Without
 * the fallback a restored worker with only `role` never reached Main's
 * sealed runtime and kicked the fence with `accountId: undefined`.
 */
function resolveMissionIdForRestore(pane: PaneModel): string | undefined {
  return (
    pane.missionId ??
    useOrchStore.getState().paneMissions[pane.id]
  );
}

const missionAuthorityChecks = new Map<
  string,
  Promise<MissionPaneRestoreAuthority>
>();
const orphanPrunesInFlight = new Set<string>();
const MISSION_AUTHORITY_INITIAL_RETRY_DELAY_MS = 100;
const MISSION_AUTHORITY_MAX_RETRY_DELAY_MS = 400;
const MISSION_AUTHORITY_NOTICE_DELAY_MS = 20_000;
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
  askBatches.clear();
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
): Promise<MissionPaneRestoreAuthority> {
  const missionId = resolveMissionIdForRestore(pane);
  if (!missionId) return { authorized: false, reason: 'spec-missing' };
  let retryDelayMs = MISSION_AUTHORITY_INITIAL_RETRY_DELAY_MS;
  while (isCurrentRestoreWorkspaceGeneration(generation)) {
    try {
      // Tolera mock/IPC legado que ainda devolve boolean.
      const result = (await window.nexus.orch.canRestoreMissionPane({
        missionId,
        paneId: pane.id,
      })) as MissionPaneRestoreAuthority | boolean;
      if (!isCurrentRestoreWorkspaceGeneration(generation)) {
        throw new Error('restore generation changed');
      }
      // Sealed runtime from Main: the layout may carry `accountId:
      // undefined` while Main sealed a physical account. The persisted-
      // authority fence requires that exact account; kick with the stale
      // mirror rejects as `accountId[undefined != acct-…]`.
      if (
        typeof result === 'object' &&
        result !== null &&
        result.authorized === true &&
        result.sealed
      ) {
        applySealedRestoreRuntime(pane.id, result.sealed);
      }
      if (result === true) return { authorized: true };
      if (typeof result === 'object' && result !== null) {
        // Devolve o objeto inteiro: `reason` e `movedToPaneId` são o que o
        // pane aposentado precisa para dizer onde a conversa continuou.
        return result;
      }
      return { authorized: false };
    } catch (error) {
      if (!isCurrentRestoreWorkspaceGeneration(generation) || reportLicenseDenial(error)) throw error;
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
): Promise<MissionPaneRestoreAuthority> {
  if (!resolveMissionIdForRestore(pane)) {
    return Promise.resolve({ authorized: false, reason: 'spec-missing' });
  }
  const key = missionAuthorityKey(pane, generation);
  const existing = missionAuthorityChecks.get(key);
  if (existing) return existing;
  // Rechecking the same pending request must not overwrite its delayed notice.
  setHeldPaneNotice(pane.id, MISSION_AUTHORITY_PENDING_NOTICE);
  const noticeTimer = setTimeout(() => {
    if (!isCurrentRestoreWorkspaceGeneration(generation) || !isSpawnHeld(pane.id)) return;
    setHeldPaneNotice(
      pane.id,
      'O Nexus ainda não confirmou a retomada. Use “Retomar missão” no topo deste painel',
    );
  }, MISSION_AUTHORITY_NOTICE_DELAY_MS);
  const clearNoticeTimer = () => clearTimeout(noticeTimer);
  generation.signal.addEventListener('abort', clearNoticeTimer, { once: true });
  const check = requestMissionPaneAuthority(pane, generation).finally(() => {
    clearNoticeTimer();
    generation.signal.removeEventListener('abort', clearNoticeTimer);
    if (missionAuthorityChecks.get(key) === check) {
      missionAuthorityChecks.delete(key);
    }
  });
  missionAuthorityChecks.set(key, check);
  return check;
}

/**
 * Mirror Main's sealed runtime onto the layout pane before the restore
 * gate releases the hold. `setAccountId`/`setPaneModel` persist; `effort`
 * has no dedicated setter, so the full pane is rewritten when needed.
 */
function applySealedRestoreRuntime(
  paneId: string,
  sealed: {
    readonly adapterId?: string;
    readonly model?: string;
    readonly accountId?: string;
    readonly effort?: string;
    readonly cwd?: string;
  },
): void {
  const layout = useLayoutStore.getState();
  const pane = listPanes(layout.root).find((item) => item.id === paneId);
  if (!pane || pane.kind !== 'cli-agent') return;
  // Same rule as alignPaneToSealedRecovery (orch-bridge.ts): sealed wins for
  // runtime identity; only fields Main actually sealed are written, in ONE
  // atomic store update (sequential setters on a stale root undo each other).
  const patch: Parameters<typeof layout.patchPaneRuntime>[1] = {};
  if (sealed.accountId !== undefined && pane.accountId !== sealed.accountId) {
    patch.accountId = sealed.accountId;
  }
  if (sealed.model !== undefined && pane.model !== sealed.model) {
    patch.model = sealed.model;
  }
  if (sealed.cwd && pane.cwd !== sealed.cwd) patch.cwd = sealed.cwd;
  if (sealed.effort !== undefined && pane.effort !== sealed.effort) {
    patch.effort = sealed.effort;
  }
  if (sealed.adapterId !== undefined && pane.adapterId !== sealed.adapterId) {
    patch.adapterId = sealed.adapterId;
  }
  layout.patchPaneRuntime(paneId, patch);
}

/**
 * A4: o aviso do pane aposentado. Quando o Main aponta o pane que ficou com
 * a conversa (`movedToPaneId`), o texto o nomeia pelo número que o operador
 * vê no cabeçalho — "a conversa continua no pane 7", não "em outro pane".
 */
function restoreDenialNotice(authority: MissionPaneRestoreAuthority): string {
  const target = authority.movedToPaneId
    ? listPanes(useLayoutStore.getState().root).find(
        (item) => item.id === authority.movedToPaneId,
      )
    : undefined;
  const label = target
    ? target.paneNumber !== undefined
      ? `no pane ${target.paneNumber}`
      : `em «${agentLabel(target)}»`
    : undefined;
  return missionPaneRestoreHoldNotice(authority.reason, label);
}

/**
 * Negar autoridade NUNCA apaga o pane — ele é APOSENTADO.
 *
 * O estado seguro já está armado quando chegamos aqui: `gateRestoredAgents`
 * segurou o spawn (`holdSpawnUntilApproved`) antes de perguntar à main, então o
 * pane já está inerte e visível. O código anterior soltava o hold
 * (`discardPaneSpawnState`) e em seguida chamava `close(...)`, que SEMPRE
 * persiste — destruindo o terminal do operador de forma irreversível. Foi assim
 * que 7 panes de uma missão `done` sumiram em campo (e 2 de outra `blocked`):
 * `mission_panes` ainda os tinha, o layout durável não.
 *
 * Aposentado: continua no layout, com o conteúdo e o scrollback preservados, e
 * o hold garante que não executa sozinho. Fechar é ação explícita do operador
 * ("Limpar projeto → Fechar todos os panes").
 *
 * Não usamos `unlockRetiredMissionPane` aqui de propósito: para worker de
 * missão `done` ele decide `reclaim-shell`, que SPAWNA um shell novo e converte
 * o pane — o oposto de inerte e com histórico.
 */
function retireUnauthorizedMissionPane(
  pane: PaneModel,
  generation: RestoreWorkspaceGeneration,
  authority: MissionPaneRestoreAuthority,
): void {
  if (!isCurrentRestoreWorkspaceGeneration(generation)) return;
  const key = missionAuthorityKey(pane, generation);
  if (orphanPrunesInFlight.has(key)) return;
  orphanPrunesInFlight.add(key);
  try {
    // Idempotente, e reafirmado a cada gate: nunca soltar, nunca apagar.
    holdSpawnUntilApproved(pane.id);
    // A4: UMA linha específica no pane aposentado — "a conversa continua no
    // pane novo", "responda a pergunta", "a missão encerrou" — nunca o
    // "use Retomar" de uma retomada que o Main já recusou.
    setHeldPaneNotice(pane.id, restoreDenialNotice(authority));
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
  decision: RestoreDecision,
): void {
  if (ids.length === 0 || !useAccessStore.getState().canUseApp) return;
  if (decision === 'resume') {
    releaseHeldSpawns(ids, { resume: true });
    return;
  }
  if (decision === 'close') {
    closeRestoredAgents(ids);
    return;
  }
  releaseHeldSpawns(ids, { resume: false });
  // Stay held so a later attach cannot silent-spawn without an explicit reopen.
  for (const id of ids) holdSpawnUntilApproved(id);
}

/**
 * Descarta agentes avulsos restaurados. O diálogo é assíncrono: reconfere o
 * layout e o hold agora, pane a pane, e só fecha o que continua inerte e
 * avulso — nunca age sobre estado velho. Pane que saiu do layout, que perdeu o
 * hold (a Main adotou o PTY vivo ou o spawn começou) ou que virou agente de
 * missão enquanto o diálogo estava aberto é deixado em paz: fechá-lo mataria o
 * processo (o descarte do host encerra a sessão). A conversa do provider
 * continua no histórico dele e não é apagada.
 */
function closeRestoredAgents(ids: readonly string[]): void {
  const layout = useLayoutStore.getState();
  const current = new Map(listPanes(layout.root).map((pane) => [pane.id, pane]));
  for (const id of ids) {
    const pane = current.get(id);
    if (!pane || looksLikeMissionAgent(pane) || !isSpawnHeld(id)) continue;
    discardPaneSpawnState(id);
    layout.close(id, CLOSE_REASON);
  }
}

/**
 * Hold restored CLI agents and apply the product policy. The default is
 * resume — restored agents continue without a dialog; `ask` (dialog with
 * focus on cancel, "Deixar em pausa") and `pause` remain hardened opt-ins.
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

  const deferForAccess = (pending: readonly PaneModel[] = agents): boolean => {
    if (useAccessStore.getState().canUseApp) return false;
    for (const pane of pending) accessPending.set(pane.id, { pane, path: restoreGeneration.path });
    return true;
  };
  if (deferForAccess()) return;

  // Layout metadata is not authority. Main validates the exact
  // (missionId,paneId,approved revision) before a provider resume is requested.
  const missionAgents = agents.filter(looksLikeMissionAgent);
  const missionRestores = missionAgents.map(async (pane) => {
    try {
      const authority = await confirmMissionPaneAuthority(
        pane,
        restoreGeneration,
      );
      if (!isCurrentRestoreWorkspaceGeneration(restoreGeneration)) return;
      if (deferForAccess([pane])) return;
      if (authority.authorized) {
        releaseHeldSpawns([pane.id], { resume: true });
        return;
      }
      retireUnauthorizedMissionPane(pane, restoreGeneration, authority);
    } catch (error) {
      if (!isCurrentRestoreWorkspaceGeneration(restoreGeneration)) return;
      if (deferForAccess([pane])) return;
      // Main may be restarting. Fail closed and retain the hold; absence of a
      // reply is not proof that the durable pane is an orphan.
      console.warn(
        `[restore] mission pane authority unavailable pane=${pane.id}:`,
        error,
      );
    }
  });
  // Each pane can resume as soon as its own authority is ready. A retrying
  // mission must not block another mission or the standalone restore policy.
  await Promise.all([
    ...missionRestores,
    restoreStandaloneAgents(agents, restoreGeneration, deferForAccess),
  ]);
}

async function restoreStandaloneAgents(
  agents: readonly PaneModel[],
  restoreGeneration: RestoreWorkspaceGeneration,
  deferForAccess: (panes: readonly PaneModel[]) => boolean,
): Promise<void> {
  const restorable = agents.filter((pane) => !looksLikeMissionAgent(pane));
  if (restorable.length === 0) return;
  const ids = restorable.map((pane) => pane.id);

  const action = resolveAgentRestoreAction(await loadPolicy());
  if (!isCurrentRestoreWorkspaceGeneration(restoreGeneration)) return;

  if (deferForAccess(restorable)) return;
  if (action === 'resume') {
    applyDecision(ids, 'resume');
    return;
  }

  if (action === 'pause') {
    applyDecision(ids, 'pause');
    return;
  }

  // action === 'ask' — merge concurrent batches into one dialog PER
  // generation. O lote é da geração: um diálogo pendente de A nunca segura
  // nem decide pelos agentes de B.
  const askKey = restoreGeneration.epoch;
  let askBatch = askBatches.get(askKey);
  if (!askBatch) {
    askBatch = { ids: new Set(), inFlight: null };
    askBatches.set(askKey, askBatch);
  }
  for (const id of ids) askBatch.ids.add(id);

  if (askBatch.inFlight) {
    await askBatch.inFlight;
    // Primary prompt already applied the decision to the full pending set.
    return;
  }

  const flight = (async () => {
    const snapshotIds = [...askBatch.ids];
    const labels = restorable.slice(0, 5).map(agentLabel).join(', ');
    const more =
      restorable.length > 5 ? ` e mais ${restorable.length - 5}` : '';
    const count = Math.max(snapshotIds.length, restorable.length);
    const choice = await askChoice({
      title: 'Retomar agentes da sessão anterior?',
      body:
        `Este workspace tinha ${count} agente(s) avulso(s) ` +
        `(${labels}${more}).\n\n` +
        'Se retomar agora, eles podem continuar a trabalhar sozinhos — ' +
        'comandos, edições e tools — sem pedir de novo a cada passo.\n\n' +
        'Isso vale em qualquer SO (macOS, Linux, Windows). Missões do ' +
        'autopiloto retomam pela autoridade persistida; esta escolha afeta ' +
        'somente agentes avulsos.\n\n' +
        'Cancelar (ou Esc) deixa os agentes em pausa, sem fechar nada.',
      // A 1ª opção recebe o foco: a que não faz nada irreversível vem primeiro.
      options: [
        {
          value: 'pause',
          label: 'Deixar em pausa',
          detail: 'Os agentes ficam na tela parados; retome pelo rail quando quiser.',
          primary: true,
        },
        {
          value: 'resume',
          label: 'Retomar agentes',
          detail: 'Continuam a conversa anterior e podem agir sozinhos.',
        },
        {
          value: 'close',
          label: 'Fechar agentes',
          detail: 'Remove esses terminais do projeto. Nada é executado.',
        },
      ],
      cancelLabel: 'Cancelar',
    });

    const decision: RestoreDecision =
      choice === 'resume' || choice === 'close' ? choice : 'pause';
    const batch = [...askBatch.ids];
    askBatch.ids.clear();
    if (!isCurrentRestoreWorkspaceGeneration(restoreGeneration)) return;
    const batchPanes = listPanes(useLayoutStore.getState().root).filter(pane => batch.includes(pane.id));
    if (!deferForAccess(batchPanes)) applyDecision(batch, decision);
  })();
  askBatch.inFlight = flight;

  try {
    await flight;
  } finally {
    if (askBatch.inFlight === flight) {
      askBatch.inFlight = null;
      // Ids que chegaram DEPOIS do fechamento do lote ficam para a próxima
      // pergunta desta geração; lote vazio morre junto com a promessa.
      if (askBatch.ids.size === 0 && askBatches.get(askKey) === askBatch) {
        askBatches.delete(askKey);
      }
    }
  }
}

/**
 * A4: o broadcast de missões é o sinal de que a autoridade pode ter mudado.
 * Panes retidos são reavaliados — a missão que destravou (pergunta
 * respondida, contrato re-aprovado, selo reconciliado) solta o pane sozinho;
 * ainda recusado, a linha do pane passa a dizer o motivo novo. Não há loop:
 * `releaseHeldSpawns` tira o pane do conjunto e o próximo broadcast não o
 * reavalia; a dedupe de `setHeldPaneNotice` evita repetir a mesma linha.
 */
export function reevaluateHeldMissionPanes(): void {
  const generation = captureRestoreWorkspaceGeneration();
  for (const pane of listPanes(useLayoutStore.getState().root)) {
    if (
      pane.kind !== 'cli-agent' ||
      !looksLikeMissionAgent(pane) ||
      !isSpawnHeld(pane.id) ||
      !resolveMissionIdForRestore(pane)
    ) {
      continue;
    }
    void confirmMissionPaneAuthority(pane, generation)
      .then((authority) => {
        if (!isCurrentRestoreWorkspaceGeneration(generation)) return;
        if (authority.authorized) {
          releaseHeldSpawns([pane.id], { resume: true });
          return;
        }
        setHeldPaneNotice(pane.id, restoreDenialNotice(authority));
      })
      .catch(() => {
        // Main indisponível neste broadcast: o pane segue retido e a última
        // linha continua valendo — a próxima mudança de estado reavalia.
      });
  }
}

/** Wire layout restore → hold + policy. Call once at app boot (all platforms). */
export function installRestoredAgentsGate(): void {
  unsubscribeAccess?.();
  unsubscribeAccess = useAccessStore.subscribe((state, previous) => {
    if (!state.canUseApp || previous.canUseApp) return;
    const ids = new Set(listPanes(useLayoutStore.getState().root).map(pane => pane.id));
    const panes = [...accessPending.values()].filter(item => item.path === getActiveWorkspacePath() && ids.has(item.pane.id)).map(item => item.pane);
    accessPending.clear();
    if (panes.length) void gateRestoredAgents(panes);
  });
  setRestoredPanesHandler((panes) => {
    void gateRestoredAgents(panes);
  });
}

/** Drop pending ask state (workspace close / tests). */
export function resetRestoredAgentsGate(): void {
  accessPending.clear();
  invalidateRestoreWorkspaceGeneration(getActiveWorkspacePath());
}

/** @deprecated use resetRestoredAgentsGate */
export const resetRestoredAgentsGateForTests = resetRestoredAgentsGate;

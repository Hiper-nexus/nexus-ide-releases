import { analysisClient, flushPtyAnalysis, isPtyAnalysisEnabled, subscribePtyAnalysis } from '../pty/pty-analysis-runtime';
import type { FailoverTextProposal } from './failover-text-core';
import type { WebContents } from 'electron';
import {
  ACCOUNT_CHANNELS,
  type Account,
  type FailoverEvent,
} from '../../shared/account-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  getAgentSessionInfo,
  getSessionState,
  listAgentSessionsForPane,
  tapSessionExit,
} from '../pty/pty-manager';
import { getAdapter, getAdapterResolvedBin } from '../adapters/adapter-registry';
import {
  isModelBlockedForAutoRouting,
  loadModelCatalog,
  modelCatalogInfo,
} from '../adapters/model-catalog';
import { migrateModelId } from '../../shared/model-defaults';
import {
  buildContinuityPack,
  buildCrossAccountResumeNote,
  sanitizeHandoffExcerptForDetector,
} from '../../shared/failover-handoff';
import { nativeResumeAcrossAccounts } from '../../shared/cross-account-resume';
import { rebindProviderPaneSessionAccount } from '../persistence/provider-session-store';
import { maskAccountLabel } from '../../shared/account-choice';
import { missionOwnsItsPanes } from '../../shared/mission-recovery-policy';
import {
  collectGitTaskState,
  observeResumeBoot,
  respawnMainOwnedPaneWithAccount,
  type ResumeBootVerdict,
} from './failover-mission-respawn';
import { switchRendererOrchestratorAccount } from './failover-orchestrator-respawn';
import { getProjectDomainStores } from './project-domain-store-registry';
import {
  forgetAccountFailoverNote,
  noteAccountFailoverForPane,
} from '../persistence/account-choice-receipts';
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
} from '../persistence/renderer-workspace-scope';
import {
  findPaneBySessionOwnedBy,
  getOwnedPaneAuthzInfoBySession,
  getPaneRuntimeAuthorityBySession,
  readSessionOutput,
  requestPaneClose,
  type OwnedPaneAuthzInfo,
} from './pane-registry';
import {
  forgetConfirmedPaneLimit,
  noteConfirmedPaneLimit,
  releasePaneStartWatch,
  shortStartError,
} from './pane-start-watchdog';
import {
  forgetPaneTaskReroute,
  getPaneTaskReroute,
  hasNextCliResolver,
  paneTaskRerouteBlocker,
  registerPaneTaskReroute,
  resolveNextCli,
  type PaneTaskRerouteBlocker,
  type PaneTaskRerouteHandle,
  type PaneTaskRerouteRequest,
} from './pane-task-reroute';
import { DEFAULT_ROUTING_TABLE, TIER_ORDER } from './task-router';
import { tierScopeFromModelId, type LimitHit } from './limit-detector';
import { retryTargetMsForLimit } from './failover-retry-policy';
import {
  hasFreshProviderApiWindowForLimit,
  longCooldownNeedsFreshProviderApi,
  providerApiConfirmsAuth,
  providerApiRefutesLimit,
  providerApiExhaustsAccount,
} from './limit-refutation';
import type { ProviderQuotaEntry } from '../../shared/quota-types';
import {
  adoptNativeAccountForFailover,
  clearCooldown,
  ensureFreshClaudeSubscription,
  getAccount,
  getActiveAccount,
  hasAvailableAccount,
  isAccountBlockedForScope,
  pickAvailableForFailover,
  prepareAccountForSpawn,
  setCooldown,
  verifyManagedClaudeAccountForSpawn,
} from '../persistence/account-store';
import { retryClaudeSpawnOnCredentialChange } from '../persistence/claude-spawn-retry';
import { broadcastToProject, sameProjectScope } from './project-scoped-broadcast';
import {
  noteQuotaLimitHit,
  requireQuotaService,
} from '../quota/quota-service';
import { quotaAvailabilityScore } from '../quota/quota-policy';
import {
  headroomInputsByAccount,
  type HeadroomInput,
} from '../quota/account-headroom';
import { tapObserverFrames } from './observer-bus';
import type { ObserverFrame } from '../../shared/observer-frame';
import {
  MODEL_ACCESS_QUARANTINE_MS,
  modelAccessQuarantine,
  quarantineRejectedModel,
  resolveModelQuarantineInstallationId,
  setModelQuarantineScopeResolver,
  type ModelQuarantineScope,
} from './model-access-quarantine';
import { trace } from '../observability/main-trace';
import { noteCliLimit } from './cli-limit-registry';
import { carryInFlightRequests, inFlightRequestOf } from './in-flight-request';

/**
 * Automatic account failover. Watches each pane's output for a limit signature
 * (rate-limit / quota / auth). When one fires: puts the pane's account on
 * cooldown, picks the next available account for that adapter, pins it on the
 * pane (no global activate thrash), and asks the renderer to re-spawn.
 *
 * Cross-account: fresh session + continuity pack (provider session ids are
 * account-owned) — except when the CLI's history is shared across accounts
 * (F-1473, Claude): the same conversation is resumed natively on the new
 * account, with the pack as fallback. Same-account recovery uses native resume.
 * Multi-pane storms coalesce on the same from-account → same to-account.
 */

const REARM_MS = 30_000;
/** Reuse the same A→B decision for concurrent panes hitting the same limit. */
const COALESCE_MS = 5_000;
// Derived from can1357/oh-my-pi@03c48d073 auth-storage cooldown machine (MIT)
// + docs/non-compaction-retry-policy.md: espera-pela-irmã em vez da janela
// multi-hora — retry em min(fim do próprio cooldown, retryAtMs da irmã) + 1s.
/** Folga após o instante de liberação para a credencial existir de fato. */
const RETRY_BUFFER_MS = 1_000;
/** Piso entre re-agendamentos (mesmo espírito do rearm de 30s do watch). */
const RETRY_MIN_RESCHEDULE_MS = REARM_MS;
/** Teto de re-agendamentos por watch — evita timer eterno em pool morto. */
const MAX_SCHEDULED_RETRIES = 8;
/**
 * Contas que um mesmo failover tenta preparar antes de desistir (F-676). Com
 * frotas de 10–100 contas, parar na 2ª com prepare falho deixava o pane sem
 * troca enquanto dezenas de irmãs estavam livres.
 */
const MAX_PREPARE_ATTEMPTS = 12;
/**
 * Conta cujo prepare falhou sai da frente por alguns minutos: o pick é
 * determinístico e, sem isto, o próximo hit escolhia a mesma conta quebrada.
 */
const PREPARE_FAILURE_COOLDOWN_MS = 5 * 60_000;

interface CoalesceEntry {
  toAccountId: string;
  toLabel: string;
  expiresAt: number;
}

/** adapterId\0fromAccountId → recent replacement. */
const coalesceByFrom = new Map<string, CoalesceEntry>();

interface ScheduledRetry {
  timer: ReturnType<typeof setTimeout>;
  authority: FailoverAuthority;
}

/** watchKey → retry agendado esperando a irmã (ou o próprio cooldown) liberar. */
const pendingRetries = new Map<string, ScheduledRetry>();

interface SessionWatch {
  readonly authority: FailoverAuthority;
  readonly startedAt: number;
  buffer: string;
  firedAt: number;
  /** Última varredura de detectLimit na janela (0 = nunca). */
  lastDetectAt: number;
  /** Texto chegado desde a última varredura. */
  pendingChars: number;
  /** Varredura final agendada para o texto que ficou sem checagem. */
  detectTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Episódio de erro do PROVIDER (5xx/capacidade) em curso: instante do 1º
   * hit (0 = nenhum). Um episódio avisa uma vez e agenda uma verificação —
   * nunca troca de conta.
   */
  transientAt: number;
  /** Texto NOVO (linhas inéditas) desde o último erro NOVO do provider. */
  progressChars: number;
  /**
   * Linhas já vistas: semeado com o que estava na tela ANTES do erro, então
   * repaint do transcript antigo (resize, foco) e do próprio erro não contam
   * como resposta nem como erro novo.
   */
  seenLines: Set<string>;
  /**
   * Assinaturas de erro já vistas (o trecho a partir de onde o padrão de erro
   * casa). Um erro redesenhado grudado a outra linha continua sendo o MESMO
   * erro; um retry novo ("attempt 2/10") é outra assinatura.
   */
  errorSignatures: Set<string>;
  /** F-764: varredura estourou o orçamento — nenhuma nova antes disto. */
  slowDetectUntil: number;
  analysisUnavailable?: boolean;
  /**
   * F-1427: esta sessão de missão já recebeu o retry único depois de parar no
   * erro do provedor. Sobrevive ao fim do episódio: a próxima parada no erro
   * vai direto para o supervisor reabrir a tarefa noutra CLI.
   */
  providerStopRetried?: boolean;
}

/**
 * Erro do provider: a CLI tenta de novo sozinha. Depois do backoff o Main
 * confere se ela voltou; se parou no erro, um pane de MISSÃO recebe um
 * "continue" na mesma sessão (nunca respawn: o processo está vivo no prompt).
 */
const TRANSIENT_MIN_CHECK_MS = 20_000;
const TRANSIENT_RECHECK_MS = 30_000;
/** ~3 min de CLI ainda ocupada (retries internos) antes de deixar com ela. */
const MAX_TRANSIENT_CHECKS = 6;
/** Texto inédito que prova resposta de verdade depois do erro. */
const TRANSIENT_PROGRESS_CHARS = 400;

/**
 * Pedido de continuação. Neutro de propósito: não ecoa o texto do erro
 * ("503", "overloaded", "unavailable"…), que o detector leria de volta no
 * próprio pane e abriria outro episódio.
 */
export const TRANSIENT_CONTINUE_PROMPT =
  'The last request was interrupted by a temporary provider issue. ' +
  'Retry it now and continue exactly where you stopped.';

/**
 * Disjuntor de morte instantânea: sessão que morre de auth com segundos de
 * vida nasceu com credencial morta — trocar/respawnar de novo só queima outro
 * pane e empilha outro handoff gigante. A 1ª morte ainda troca (caso legítimo:
 * abrir pane em conta morta e cair na irmã saudável); a 2ª seguida trava o
 * failover com motivo acionável até re-login. Sem isto, credencial morta nas
 * duas contas = loop infinito entre panes novos (cada respawn zera o attempt).
 */
const INSTANT_DEATH_MS = 90_000;
/** Mortes seguidas da MESMA conta que travam o failover (credencial morta). */
const INSTANT_DEATH_TRIP = 2;
/**
 * Contas DISTINTAS mortas na janela que travam o provider inteiro (F-676).
 * Com 10–100 contas, duas expiradas não podem parar a rotação das outras;
 * cinco seguidas já indicam defeito do provider/CLI, não da credencial.
 */
const INSTANT_DEATH_PROVIDER_TRIP = 5;
const INSTANT_DEATH_WINDOW_MS = 10 * 60_000;
/** adapterId → mortes instantâneas recentes (instante + conta que morreu). */
const instantAuthDeaths = new Map<string, Array<{ at: number; accountKey: string }>>();

function noteInstantAuthDeath(
  adapterId: string,
  accountId: string | null | undefined,
  now: number,
): { sameAccount: number; distinctAccounts: number } {
  const accountKey = accountId ?? '';
  const recent = (instantAuthDeaths.get(adapterId) ?? []).filter(
    (death) => now - death.at < INSTANT_DEATH_WINDOW_MS,
  );
  recent.push({ at: now, accountKey });
  instantAuthDeaths.set(adapterId, recent);
  return {
    sameAccount: recent.filter((death) => death.accountKey === accountKey).length,
    distinctAccounts: new Set(recent.map((death) => death.accountKey)).size,
  };
}

/**
 * Re-login com blob fresco cura a causa do 401 — as mortes instantâneas
 * ANTERIORES não podem contar contra a credencial nova, senão 1 morte
 * legítima logo após o login já trava o failover de novo.
 */
export function resetInstantAuthDeaths(adapterId: string): void {
  instantAuthDeaths.delete(adapterId);
}

interface FailoverAuthority {
  /** Null = pane físico main-owned/headless (mission worker sem renderer). */
  readonly owner: OwnedPaneAuthzInfo['owner'] | null;
  readonly paneId: string;
  readonly sessionId: string;
  readonly missionId?: string;
  readonly workerIncarnationId?: string;
  readonly scope: ProjectExecutionScope;
}

const watches = new Map<string, SessionWatch>();
const listeners = new Set<WebContents>();
const destroyHandlers = new Map<WebContents, () => void>();
const ownerKeys = new WeakMap<WebContents, number>();
let nextOwnerKey = 1;
let untapData: (() => void) | null = null;
let untapExit: (() => void) | null = null;
let untapObserver: (() => void) | null = null;
let unsubscribeScopeChanges: (() => void) | null = null;

function ownerKey(owner: WebContents | null): number {
  if (!owner) return 0;
  const existing = ownerKeys.get(owner);
  if (existing) return existing;
  const key = nextOwnerKey++;
  ownerKeys.set(owner, key);
  return key;
}

function watchKey(authority: FailoverAuthority): string {
  return JSON.stringify([
    ownerKey(authority.owner),
    authority.scope.installationId,
    authority.scope.projectId,
    authority.scope.checkoutId,
    authority.scope.rootRealPath,
    authority.missionId ?? null,
    authority.paneId,
    authority.sessionId,
  ]);
}

function resolveAuthority(sessionId: string): FailoverAuthority | null {
  const pane = getOwnedPaneAuthzInfoBySession(sessionId);
  if (!pane) return resolveMainOwnedAuthority(sessionId);
  const rendererScope = getRendererWorkspaceScope(pane.owner);
  if (
    pane.sessionId !== sessionId ||
    pane.kind !== 'cli-agent' ||
    !pane.scope ||
    !listeners.has(pane.owner) ||
    !rendererScope ||
    !sameProjectScope(rendererScope, pane.scope)
  ) {
    return null;
  }
  return Object.freeze({
    owner: pane.owner,
    paneId: pane.paneId,
    sessionId,
    missionId: pane.missionId,
    workerIncarnationId: pane.workerIncarnationId,
    scope: Object.freeze({ ...pane.scope }),
  });
}

/**
 * Mission workers (ex.: AGY) rodam headless/main-owned: não há renderer dono
 * nem WebContents para bind de escopo. A autoridade vem do inventário físico
 * main-owned — a decisão de waiver/retry nunca depende do renderer.
 */
function resolveMainOwnedAuthority(sessionId: string): FailoverAuthority | null {
  const runtime = getPaneRuntimeAuthorityBySession(sessionId);
  if (
    !runtime ||
    runtime.owner !== null ||
    runtime.sessionId !== sessionId ||
    runtime.kind !== 'cli-agent' ||
    !runtime.scope
  ) {
    return null;
  }
  return Object.freeze({
    owner: null,
    paneId: runtime.paneId,
    sessionId,
    missionId: runtime.missionId,
    workerIncarnationId: runtime.workerIncarnationId,
    scope: Object.freeze({ ...runtime.scope }),
  });
}

function isCurrentAuthority(authority: FailoverAuthority): boolean {
  const current = resolveAuthority(authority.sessionId);
  return Boolean(
    current &&
      current.owner === authority.owner &&
      current.paneId === authority.paneId &&
      current.missionId === authority.missionId &&
      current.workerIncarnationId === authority.workerIncarnationId &&
      sameProjectScope(current.scope, authority.scope),
  );
}

function cancelScheduledRetry(key: string): void {
  const pending = pendingRetries.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRetries.delete(key);
}

function cleanupOwner(
  owner: WebContents,
  scope?: ProjectExecutionScope,
): void {
  for (const [key, watch] of [...watches]) {
    if (
      watch.authority.owner === owner &&
      (!scope || sameProjectScope(watch.authority.scope, scope))
    ) {
      watches.delete(key);
    }
  }
  for (const [key, pending] of [...pendingRetries]) {
    if (
      pending.authority.owner === owner &&
      (!scope || sameProjectScope(pending.authority.scope, scope))
    ) {
      cancelScheduledRetry(key);
    }
  }
}

function ensureScopeChangeListener(): void {
  if (unsubscribeScopeChanges) return;
  unsubscribeScopeChanges = onRendererWorkspaceScopeChange(
    (changedOwner, previous) => {
      if (!previous) return;
      for (const owner of listeners) {
        if (owner.id === changedOwner.id) cleanupOwner(owner, previous);
      }
    },
  );
}

export function registerFailoverListener(wc: WebContents): void {
  listeners.add(wc);
  ensureScopeChangeListener();
  if (destroyHandlers.has(wc)) return;
  const onDestroyed = () => unregisterFailoverListener(wc);
  destroyHandlers.set(wc, onDestroyed);
  wc.once('destroyed', onDestroyed);
}
export function unregisterFailoverListener(wc: WebContents): void {
  listeners.delete(wc);
  const onDestroyed = destroyHandlers.get(wc);
  if (onDestroyed) wc.removeListener('destroyed', onDestroyed);
  destroyHandlers.delete(wc);
  cleanupOwner(wc);
  if (listeners.size === 0) {
    unsubscribeScopeChanges?.();
    unsubscribeScopeChanges = null;
  }
}

function emitFailover(
  authority: FailoverAuthority,
  event: FailoverEvent,
): void {
  if (!isCurrentAuthority(authority)) return;
  broadcastToProject(
    // Main-owned não tem renderer dono: notifica qualquer listener no escopo.
    authority.owner ? [authority.owner] : listeners,
    authority.scope,
    ACCOUNT_CHANNELS.failover,
    event,
  );
}

/**
 * F-995: recibo de uma troca que o Main aplicou no pane do renderer. A sessão
 * velha já não existe (a autoridade mudou de propósito): o destino é o mesmo
 * dono, no mesmo escopo, enquanto ele ainda escuta.
 */
function emitToPaneOwner(
  authority: FailoverAuthority,
  event: FailoverEvent,
): void {
  const owner = authority.owner;
  if (!owner || !listeners.has(owner) || owner.isDestroyed()) return;
  broadcastToProject([owner], authority.scope, ACCOUNT_CHANNELS.failover, event);
}

/** Próximo passo do orquestrador religado na conta nova (F-995). */
const ORCHESTRATOR_SWITCH_NEXT_STEP =
  'Check nexus_handoff_list and the panes still running (nexus_pane_list), then ' +
  'continue coordinating the mission from the first pending step. Do not redo delivered work.';

/** Detalhes do pane físico, seja ele renderer-owned ou main-owned/headless. */
interface FailoverPaneDetails {
  readonly paneId: string;
  readonly adapterId: string;
  readonly model?: string;
  readonly accountId?: string;
}

function resolvePaneDetails(
  authority: FailoverAuthority,
): FailoverPaneDetails | null {
  if (authority.owner) {
    const pane = findPaneBySessionOwnedBy(
      authority.owner,
      authority.sessionId,
    );
    if (
      !pane ||
      pane.paneId !== authority.paneId ||
      pane.sessionId !== authority.sessionId ||
      pane.kind !== 'cli-agent' ||
      !pane.adapterId
    ) {
      return null;
    }
    return {
      paneId: pane.paneId,
      adapterId: pane.adapterId,
      model: pane.model,
      accountId: pane.accountId,
    };
  }
  // Main-owned: o inventário físico do pty-manager é a autoridade do processo;
  // a identidade exata (pane/missão/encarnação) precisa convergir com o pane
  // registry ou o hit é ignorado.
  const info = getAgentSessionInfo(authority.sessionId);
  if (
    !info ||
    info.paneId !== authority.paneId ||
    !info.adapterId ||
    (authority.missionId !== undefined &&
      info.missionId !== authority.missionId) ||
    (authority.workerIncarnationId !== undefined &&
      info.workerIncarnationId !== authority.workerIncarnationId)
  ) {
    return null;
  }
  return {
    paneId: authority.paneId,
    adapterId: info.adapterId,
    model: info.model,
    accountId: info.accountId,
  };
}

/** Latest fleet-snapshot entry for one account (undefined at boot race). */
/**
 * Backoff da conta quando o texto do PTY pede horas de quarentena mas não há
 * leitura provider-api fresca para autorizá-las: curto o bastante para uma
 * cascata fantasma se desfazer sozinha, longo o bastante para o pane não
 * voltar à conta esgotada no próximo minuto.
 */
const CAPPED_COOLDOWN_WITHOUT_PROVIDER_API_MS = 15 * 60 * 1000;

/**
 * F-775: o MESMO limite longo, sem leitura do provedor, batendo de novo na
 * mesma conta DEPOIS da pausa curta é a confirmação que a sonda não trouxe —
 * a sessão retomada recebeu o limite outra vez. Repaint dentro da pausa não
 * conta. Sem isto, conta única (ou todas assim) girava em ciclos de 15 min e
 * a troca de CLI nunca chegava.
 */
const UNCONFIRMED_STRIKE_WINDOW_MS = 3 * 60 * 60 * 1000;
const unconfirmedStrikes = new Map<string, number>();

function strikeKey(adapterId: string, accountId: string | undefined, kind: string): string {
  return `${adapterId}\0${accountId ?? ''}\0${kind}`;
}

/** true = segunda batida depois da pausa (consome a anterior); senão anota a 1ª. */
function repeatedUnconfirmedLimit(
  adapterId: string,
  accountId: string | undefined,
  kind: string,
  now: number,
): boolean {
  const key = strikeKey(adapterId, accountId, kind);
  const first = unconfirmedStrikes.get(key);
  if (first !== undefined && now - first < UNCONFIRMED_STRIKE_WINDOW_MS) {
    if (now - first < CAPPED_COOLDOWN_WITHOUT_PROVIDER_API_MS) return false;
    unconfirmedStrikes.delete(key);
    return true;
  }
  unconfirmedStrikes.set(key, now);
  return false;
}

function quotaEntryFor(
  adapterId: string,
  accountId: string,
): ProviderQuotaEntry | undefined {
  try {
    const snap = requireQuotaService().lastSnapshot();
    return snap?.entries.find(
      (e) => e.adapterId === adapterId && e.accountId === accountId,
    );
  } catch {
    /* quota service optional at boot race */
    return undefined;
  }
}

/**
 * Linha de cota do pane: a da conta gerenciada, ou — login nativo sem conta
 * (ex.: Muse) — a linha NATIVA do adapter (`accountId` ausente no snapshot).
 * Sem isto a sonda F-249 era cega para panes nativos: `fresh` nascia sempre
 * `undefined`, nada refutava nem confirmava, e o texto do PTY decidia sozinho
 * (Bug 9: toast «Sessão expirada em "muse"» com a credencial viva).
 */
function quotaEntryForPane(
  adapterId: string,
  current: { id: string } | null | undefined,
): ProviderQuotaEntry | undefined {
  if (current) return quotaEntryFor(adapterId, current.id);
  try {
    const snap = requireQuotaService().lastSnapshot();
    return snap?.entries.find(
      (e) => e.adapterId === adapterId && !e.accountId,
    );
  } catch {
    return undefined;
  }
}

/**
 * F-775: pior janela MEDIDA da conta exausta (label + resetsAt) para o pack
 * de continuidade. Sem snapshot ou sem janela conhecida, devolve undefined —
 * o pack nunca inventa reset.
 */
function measuredLimitWindow(
  adapterId: string,
  accountId: string | undefined,
): { label: string; resetsAt: number | null } | undefined {
  if (!accountId) return undefined;
  const entry = quotaEntryFor(adapterId, accountId);
  if (!entry?.windows?.length) return undefined;
  let worst = entry.windows[0];
  for (const w of entry.windows) {
    const a = w.usedRatio ?? -1;
    const b = worst.usedRatio ?? -1;
    if (a > b) worst = w;
  }
  return {
    label: worst.label,
    resetsAt: worst.resetsAt != null ? worst.resetsAt : null,
  };
}

/** Prefer freer cota among eligible accounts when fleet snapshot exists. */
function quotaScoresFor(adapterId: string): Map<string, number> | undefined {
  try {
    const snap = requireQuotaService().lastSnapshot();
    if (!snap) return undefined;
    const quotaScores = new Map<string, number>();
    for (const e of snap.entries) {
      if (e.adapterId === adapterId && e.accountId) {
        quotaScores.set(e.accountId, quotaAvailabilityScore(e));
      }
    }
    return quotaScores;
  } catch {
    /* quota service optional at boot race */
    return undefined;
  }
}

/** F-995: janelas medidas por conta — a troca compara só janelas comparáveis. */
function quotaHeadroomFor(
  adapterId: string,
): ReadonlyMap<string, HeadroomInput> | undefined {
  try {
    const snap = requireQuotaService().lastSnapshot();
    return snap ? headroomInputsByAccount(snap.entries, adapterId) : undefined;
  } catch {
    /* quota service optional at boot race */
    return undefined;
  }
}

interface SwitchRequest {
  /** watchKey — chave do retry agendado deste pane. */
  key: string;
  authority: FailoverAuthority;
  paneId: string;
  adapterId: string;
  /** Modelo do pane (escopo tier da seleção quando anthropic). */
  paneModel: string | undefined;
  hit: LimitHit;
  now: number;
  /** Conta exausta/pinada (origem do failover), quando conhecida. */
  current: Account | null;
  /** Conta a excluir da seleção (a que acabou de estourar) ou null (retry). */
  excludeId: string | null;
  /** Instante em que a PRÓPRIA conta libera (para a espera-pela-irmã). */
  ownUnblockAtMs: number | undefined;
  /** 0 = hit original; >0 = retry agendado (falha silenciosa, re-agenda). */
  attempt: number;
  /** Sufixo pt-BR no reason do evento (ex.: retry automático). */
  reasonSuffix: string;
  /** F-249: limite longo só com o texto do PTY — não autoriza trocar de CLI. */
  unconfirmed?: boolean;
}

/**
 * Núcleo da decisão de failover: coalesce → seleção escopo-ciente (com
 * sondagem last-resort) → prepare (com um alternate) → evento. Quando nada
 * está livre, agenda a espera-pela-irmã em vez de desistir.
 */
/**
 * F-511: renova a secundária Claude ANTES do pin. `ensureFreshClaudeSubscription`
 * é best-effort e tem timeout próprio; a corrida de 15s aqui permanece como
 * defesa adicional para o failover nunca depender da latência do provider.
 */
async function healClaudeSecondaryBeforePin(
  accountId: string,
  now: number,
): Promise<void> {
  try {
    await Promise.race([
      ensureFreshClaudeSubscription(accountId, now),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
  } catch {
    // best-effort: o prepare abaixo decide com o que houver no vault.
  }
}

async function prepareFailoverAccount(
  adapterId: string,
  accountId: string,
  now: number,
  options?: Parameters<typeof prepareAccountForSpawn>[3],
): Promise<ReturnType<typeof prepareAccountForSpawn>> {
  // F-1401: verify+prepare dentro da tentativa — um pane irmão pode renovar a
  // credencial entre as duas etapas; a retentativa revalida o perfil e fixa o
  // blob novo em vez de falhar o failover.
  return retryClaudeSpawnOnCredentialChange(async () => {
    let verifiedClaudeBlob: string | undefined;
    if (adapterId === 'claude' && getAccount(accountId)?.mode === 'subscription') {
      // The synchronous prepare can persist a rotated credential to the managed
      // store. Prove ownership first, including on alternate/native adoption.
      const identity = await verifyManagedClaudeAccountForSpawn(accountId, (blob) => {
        verifiedClaudeBlob = blob;
      });
      if (identity !== 'match') {
        return { ok: false as const, error: identity === 'mismatch'
          ? 'credencial Claude pertence a outra conta — entre novamente'
          : identity === 'auth-expired'
            ? 'sessão Claude expirada — entre novamente'
            : 'não foi possível verificar a identidade da conta Claude' };
      }
      if (!verifiedClaudeBlob) {
        return { ok: false as const, error: 'credencial Claude verificada mudou — tente novamente' };
      }
    }
    return prepareAccountForSpawn(adapterId, accountId, now,
      verifiedClaudeBlob ? { ...options, expectedClaudeBlob: verifiedClaudeBlob } : options);
  });
}

/* ------------------------------------------------------------------------ *
 * F-775: troca de CLI quando TODAS as contas da CLI atual estão esgotadas.
 * Automática, nos dois tipos de pane: o pane do operador ("+ Pane", sem
 * missão) troca de CLI no lugar, com aviso; a tarefa de missão é reaberta
 * pela rota do spawn. A próxima CLI é a do roteador (especialidade,
 * capacidade, diversidade, cota e login); a esgotada não volta antes de
 * liberar, e cada tarefa troca no máximo MAX_CLI_SWITCHES_PER_TASK vezes.
 * ------------------------------------------------------------------------ */

/**
 * Espera mínima (própria conta ou irmã) que justifica levar a tarefa para
 * outra CLI. Limite curto espera a irmã — a conversa atual vale mais.
 */
const CLI_SWITCH_MIN_WAIT_MS = 10 * 60_000;
/** Trocas de CLI por tarefa (linhagem de panes) — mais que isso é cascata. */
const MAX_CLI_SWITCHES_PER_TASK = 3;
const CLI_SWITCH_HISTORY_MS = 12 * 60 * 60_000;
/** Trecho final do PTY que vai no pacote (o próprio builder poda e mascara). */
const CLI_SWITCH_EXCERPT_LINES = 120;
const CLI_SWITCH_NEXT_STEP =
  'Inspect the touched files and the diff above (they are the real state of the work), ' +
  'then continue the task from its first pending step.';

/** Linhagem (pane do pedido original) → CLIs que esgotaram nesta tarefa. */
const cliSwitchHistory = new Map<
  string,
  Array<{ readonly adapterId: string; readonly at: number; readonly until: number }>
>();

function cliSwitchesOf(lineageId: string, now: number) {
  const recent = (cliSwitchHistory.get(lineageId) ?? []).filter(
    (entry) => now - entry.at < CLI_SWITCH_HISTORY_MS,
  );
  cliSwitchHistory.set(lineageId, recent);
  return recent;
}

function noteCliExhausted(lineageId: string, adapterId: string, now: number, until: number): void {
  cliSwitchesOf(lineageId, now).push({ adapterId, at: now, until });
}

function adapterLabelOf(adapterId: string): string {
  return getAdapter(adapterId)?.label ?? adapterId;
}

type CliSwitchPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'blocked'; readonly note: string }
  | {
      readonly kind: 'go';
      readonly lineageId: string;
      /** A esgotada e as que esgotaram nesta tarefa e seguem sem liberar. */
      readonly exclude: readonly string[];
      readonly handle: PaneTaskRerouteHandle | null;
    };

/**
 * A tarefa deste pane segue em outra CLI? Limite de cota, de uso ou
 * credencial sem conta livre (erro do provedor e modelo têm caminho próprio),
 * com espera longa. Pedido explícito do operador não segura a troca — o
 * esgotamento vence —, mas o pane aberto pelo operador DENTRO de uma missão
 * (F-231) não é fechado pela máquina.
 */
function planCliSwitch(req: SwitchRequest, retryTargetMs: number | undefined): CliSwitchPlan {
  const { hit, now, paneId, adapterId } = req;
  if (hit.kind !== 'quota' && hit.kind !== 'rate-limit' && hit.kind !== 'auth') {
    return { kind: 'none' };
  }
  // F-249: o texto sozinho não troca de conta — nem de CLI.
  if (req.unconfirmed) return { kind: 'none' };
  if (retryTargetMs !== undefined && retryTargetMs - now < CLI_SWITCH_MIN_WAIT_MS) {
    return { kind: 'none' };
  }
  const handle = getPaneTaskReroute(paneId);
  // Caminhos: no lugar (pane fora de missão), pane novo pela rota do spawn
  // (pedido guardado) ou religar o worker main-owned pela rota do Maestro.
  // Sem caminho, a espera-pela-irmã sai na hora, sem esperar rota nenhuma.
  const inPlace = Boolean(req.authority.owner) && !req.authority.missionId;
  const mainOwnedRoute = !req.authority.owner && Boolean(req.authority.missionId);
  if (!handle && !inPlace && !mainOwnedRoute) return { kind: 'none' };
  if ((inPlace || !handle) && !hasNextCliResolver()) return { kind: 'none' };
  const lineageId = handle?.lineageId ?? paneId;
  const history = cliSwitchesOf(lineageId, now);
  if (history.length >= MAX_CLI_SWITCHES_PER_TASK) {
    return {
      kind: 'blocked',
      note: `a tarefa já trocou de CLI ${MAX_CLI_SWITCHES_PER_TASK} vezes; o Nexus não troca de novo sozinho`,
    };
  }
  if (req.authority.missionId) {
    const blocker = paneTaskRerouteBlocker(handle);
    if (blocker === 'operator' || blocker === 'chain-limit') {
      return { kind: 'blocked', note: REROUTE_BLOCKER_TEXT[blocker] };
    }
  }
  const exclude = [
    ...new Set([
      adapterId,
      ...history
        .filter((entry) => entry.until > now || !hasAvailableAccount(entry.adapterId, now))
        .map((entry) => entry.adapterId),
    ]),
  ];
  return { kind: 'go', lineageId, exclude, handle };
}

/** Texto de rota para o pane do operador: só o rótulo do pane, nunca o terminal. */
function operatorPaneRouteTask(sessionId: string, adapterLabel: string): string {
  const title = getOwnedPaneAuthzInfoBySession(sessionId)?.title?.trim();
  return `Continuar o trabalho do terminal ${title ? `"${title}"` : adapterLabel} em outra CLI`;
}

/** Maestro da missão do pane: a autoridade de rota de um worker sem pedido guardado. */
async function missionOrchestratorSessionId(authority: FailoverAuthority): Promise<string | null> {
  if (!authority.missionId) return null;
  try {
    const { getProjectDomainStores } = await import('./project-domain-store-registry');
    return (
      getProjectDomainStores(authority.scope).missions.get(authority.missionId)
        ?.orchestratorSessionId ?? null
    );
  } catch {
    return null;
  }
}

function cliSwitchPack(
  req: SwitchRequest,
  facts: NonNullable<FailoverEvent['continuity']>,
  options: { readonly withExcerpt?: boolean } = {},
): string {
  const { authority, adapterId, hit, current } = req;
  return buildContinuityPack({
    fromAccountLabel: current?.label ?? adapterId,
    toAccountLabel: '',
    reason: hit.reason,
    role: 'worker',
    missionId: authority.missionId,
    limitKind: hit.kind,
    limitWindow: facts.limitWindow ?? null,
    limitResetsAt: facts.limitResetsAt ?? null,
    limitCooldownMs: facts.limitCooldownMs ?? null,
    touchedFiles: facts.touchedFiles,
    diffStat: facts.diffStat,
    inFlightRequest: facts.inFlightRequest,
    ...(options.withExcerpt === false
      ? {}
      : { scrollbackExcerpt: readSessionOutput(authority.sessionId, CLI_SWITCH_EXCERPT_LINES) }),
    nextStep: CLI_SWITCH_NEXT_STEP,
    fromAdapterLabel: adapterLabelOf(adapterId),
  });
}

type CliSwitchResult = { readonly handled: true } | { readonly handled: false; readonly note: string };

/**
 * Executa a troca de CLI. `handled:false` = o pane parado continua lá e a
 * espera-pela-irmã segue (com a nota); `handled:true` = o recibo já saiu.
 */
async function continueOnAnotherCli(
  req: SwitchRequest,
  plan: Extract<CliSwitchPlan, { kind: 'go' }>,
  retryTargetMs: number | undefined,
  nextUnblockAtMs: number | undefined,
  /** F-1471: a conta irmã com folga não recebeu a tarefa (rótulos mascarados). */
  cause?: string,
): Promise<CliSwitchResult> {
  const { authority, paneId, adapterId, hit, current, now } = req;
  const fromCli = adapterLabelOf(adapterId);
  const fromLabel = current?.label ?? adapterId;
  const until = retryTargetMs ?? now + hit.cooldownMs;
  const handle = plan.handle;
  const base = {
    paneId,
    fromAccountLabel: fromLabel,
    toAccountLabel: '',
    kind: hit.kind,
    fromAccountId: current?.id,
    fromAdapterId: adapterId,
    fromAdapterLabel: fromCli,
    missionId: authority.missionId,
    ...(nextUnblockAtMs !== undefined ? { nextUnblockAtMs } : {}),
  };
  const traceOutcome = (outcome: string, extra: Record<string, unknown> = {}): void =>
    trace({
      kind: 'account-failover',
      outcome,
      paneId,
      adapterId,
      fromAccountId: current?.id ?? null,
      limitKind: hit.kind,
      reason: hit.reason,
      missionId: authority.missionId ?? null,
      ...extra,
    });

  // (b) Pane do operador / helper fora de missão: troca NO LUGAR, com aviso.
  if (authority.owner && !authority.missionId) {
    const route = await resolveNextCli({
      callerSessionId: handle?.callerSessionId ?? authority.sessionId,
      task: handle?.routeTask ?? operatorPaneRouteTask(authority.sessionId, fromCli),
      excludeAdapterIds: plan.exclude,
    });
    if (!route || plan.exclude.includes(route.adapterId)) {
      return { handled: false, note: 'nenhuma outra CLI elegível agora' };
    }
    if (!isCurrentAuthority(authority)) return { handled: true };
    noteCliExhausted(plan.lineageId, adapterId, now, until);
    const facts = await continuityFacts(authority, adapterId, current?.id, hit, nextUnblockAtMs);
    const toCli = adapterLabelOf(route.adapterId);
    const headline = `${fromCli} esgotou em todas as contas; continuando em ${toCli}`;
    const switchFields = {
      ...base,
      toAdapterId: route.adapterId,
      toAdapterLabel: toCli,
      ...(route.model ? { toModel: route.model } : {}),
    };
    emitFailover(authority, {
      ...switchFields,
      reason: `${headline} (${hit.reason})`,
      switched: false,
      cliSwitchPhase: 'requested',
      continuityPack: cliSwitchPack(req, facts),
    });
    traceOutcome('cli-switch-requested', { toAdapterId: route.adapterId, toModel: route.model ?? null });
    const proven = await waitForPaneRespawn(
      paneId,
      authority.sessionId,
      (session) => session.adapterId === route.adapterId,
    );
    if (proven) {
      releasePaneStartWatch(paneId);
      // O pane segue com a MESMA tarefa, agora na CLI nova.
      if (handle) registerPaneTaskReroute({ ...handle, adapterId: route.adapterId });
    }
    emitFailoverReceipt(authority, {
      ...switchFields,
      reason: proven
        ? `${headline} (${hit.reason})`
        : `${headline} — o pane não religou em ${toCli} em ` +
          `${Math.round(MODEL_ROTATION_PROOF_MS / 1000)} s; nada foi trocado`,
      switched: proven,
      cliSwitchPhase: 'applied',
    });
    traceOutcome(proven ? 'cli-switched' : 'cli-switch-failed', { toAdapterId: route.adapterId });
    return { handled: true };
  }

  // (a) Tarefa de missão com o pedido guardado: pane novo pela rota do spawn.
  if (handle) {
    const facts = await continuityFacts(authority, adapterId, current?.id, hit, nextUnblockAtMs);
    noteCliExhausted(plan.lineageId, adapterId, now, until);
    const outcome = await reopenTaskElsewhere(
      authority,
      { paneId, adapterId, model: req.paneModel, accountId: current?.id },
      handle,
      {
        excludeAdapterIds: plan.exclude,
        appendPrompt: cliSwitchPack(req, facts),
        worktreeFromPaneId: paneId,
      },
    );
    if (!outcome.ok && !outcome.closed) {
      return { handled: false, note: `troca de CLI indisponível: ${outcome.error}` };
    }
    const toCli = outcome.ok ? adapterLabelOf(outcome.adapterId) : '';
    const exhausted = cause ? `${fromCli}: ${cause}` : `${fromCli} esgotou em todas as contas`;
    const reason = outcome.ok
      ? `${exhausted}; a tarefa seguiu em ${toCli} ` +
        `(pane ${outcome.paneId}) com o pacote de continuidade (${hit.reason})`
      : `${exhausted} e a tarefa não foi reaberta em outra CLI: ` +
        `${outcome.error} (${hit.reason})`;
    emitFailoverReceipt(authority, {
      ...base,
      reason,
      switched: outcome.ok,
      ...(outcome.ok
        ? { toAdapterId: outcome.adapterId, toAdapterLabel: toCli, toPaneId: outcome.paneId }
        : {}),
    });
    traceOutcome(outcome.ok ? 'cli-switched' : 'cli-switch-failed', {
      ...(outcome.ok ? { toAdapterId: outcome.adapterId, toPaneId: outcome.paneId } : {}),
    });
    await notifyCliSwitch(authority, req, outcome.ok
      ? { toAdapterId: outcome.adapterId, toPaneId: outcome.paneId }
      : { error: outcome.error }, cause);
    return { handled: true };
  }

  // (a') Worker main-owned sem pedido guardado: a rota do Maestro escolhe a
  // CLI e o Main religa a mesma missão nela, com o pacote.
  if (!authority.owner && authority.missionId) {
    const maestro = await missionOrchestratorSessionId(authority);
    const agent = getAgentSessionInfo(authority.sessionId)?.agentName;
    const route = maestro
      ? await resolveNextCli({
          callerSessionId: maestro,
          task: `Continuar a tarefa do worker ${agent ? `"${agent}"` : paneId} em outra CLI`,
          excludeAdapterIds: plan.exclude,
        })
      : null;
    if (!route || plan.exclude.includes(route.adapterId)) {
      return { handled: false, note: 'nenhuma outra CLI elegível agora' };
    }
    const facts = await continuityFacts(authority, adapterId, current?.id, hit, nextUnblockAtMs);
    noteCliExhausted(plan.lineageId, adapterId, now, until);
    let respawned = false;
    try {
      respawned = await respawnMainOwnedPaneWithAccount({
        paneId,
        sessionId: authority.sessionId,
        adapterId: route.adapterId,
        ...(route.model ? { toModel: route.model } : {}),
        fromAccountLabel: fromLabel,
        reason: hit.reason,
        // ORC-05/F-249: o trecho do terminal vai no recorte do respawn
        // (redigido e neutralizado inteiro), não cru dentro do pack.
        continuityPack: cliSwitchPack(req, facts, { withExcerpt: false }),
        scrollbackExcerpt: readSessionOutput(authority.sessionId, CLI_SWITCH_EXCERPT_LINES),
      });
    } catch (error) {
      console.warn(
        '[failover] troca de CLI main-owned falhou:',
        error instanceof Error ? error.message : error,
      );
    }
    const toCli = adapterLabelOf(route.adapterId);
    emitFailoverReceipt(authority, {
      ...base,
      reason: respawned
        ? `${fromCli} esgotou em todas as contas; a tarefa seguiu em ${toCli} (${hit.reason})`
        : `${fromCli} esgotou em todas as contas e o worker não pôde ser religado em ${toCli} (${hit.reason})`,
      switched: respawned,
      ...(respawned ? { toAdapterId: route.adapterId, toAdapterLabel: toCli } : {}),
    });
    traceOutcome(respawned ? 'cli-switched' : 'cli-switch-failed', { toAdapterId: route.adapterId });
    await notifyCliSwitch(authority, req, respawned
      ? { toAdapterId: route.adapterId }
      : { error: `o worker não pôde ser religado em ${toCli}` });
    return { handled: true };
  }
  return { handled: false, note: 'o Nexus não tem como reabrir esta tarefa sozinho' };
}

/** Aviso ao Maestro da troca de CLI (rótulos de conta mascarados). */
async function notifyCliSwitch(
  authority: FailoverAuthority,
  req: SwitchRequest,
  outcome: { readonly toAdapterId: string; readonly toPaneId?: string } | { readonly error: string },
  /** F-1471: por que a conta irmã com folga não recebeu a tarefa (mascarado). */
  cause?: string,
): Promise<void> {
  const agent = getAgentSessionInfo(authority.sessionId)?.agentName ?? req.paneId;
  const fromCli = adapterLabelOf(req.adapterId);
  await notifyMissionOrchestrator(
    authority,
    `[troca-de-cli:${req.paneId}] O worker "${agent}" (${req.adapterId}, conta ` +
      `"${maskAccountLabel(req.current?.label ?? req.adapterId)}") ` +
      (cause ? `esgotou a conta; ${cause}. ` : `ficou sem conta com folga em ${fromCli}. `) +
      ('error' in outcome
        ? `A tarefa não foi reaberta em outra CLI (${outcome.error}). Decida: reabra com outra ` +
          'CLI ou espere a conta liberar.'
        : `A tarefa seguiu em ${outcome.toAdapterId}` +
          (outcome.toPaneId ? ` (pane ${outcome.toPaneId})` : '') +
          ' com o pacote de continuidade (arquivos tocados, diff e próximo passo); espere o handoff dela.'),
  );
}

/**
 * F-775: fatos medidos para o pacote de continuidade que o RENDERER monta na
 * troca de conta — janela/reset da conta esgotada e o estado da tarefa no cwd
 * do pane. O Main coleta (git assíncrono, F-764); o renderer só escreve.
 */
async function continuityFacts(
  authority: FailoverAuthority,
  adapterId: string,
  fromAccountId: string | undefined,
  hit: LimitHit,
  nextUnblockAtMs: number | undefined,
): Promise<NonNullable<FailoverEvent['continuity']>> {
  const window = measuredLimitWindow(adapterId, fromAccountId);
  // F-822: só a worktree do PRÓPRIO pane; checkout compartilhado não entra.
  const runtime = getPaneRuntimeAuthorityBySession(authority.sessionId);
  const git = await collectGitTaskState(runtime?.executionScope?.rootRealPath, {
    sharedRootPath: (runtime?.scope ?? authority.scope).rootRealPath,
  });
  // F-1482: o pedido em voo do pane segue no pack (memória do Main).
  const inFlightRequest = inFlightRequestOf(authority.paneId);
  return {
    limitWindow: window?.label ?? null,
    limitResetsAt: window?.resetsAt ?? nextUnblockAtMs ?? null,
    limitCooldownMs: hit.cooldownMs,
    touchedFiles: git.touchedFiles.slice(0, 50),
    ...(git.diffStat ? { diffStat: git.diffStat.slice(0, 4_000) } : {}),
    ...(inFlightRequest ? { inFlightRequest } : {}),
  };
}

/** F-1471: trocas de conta por tarefa (linhagem) numa janela — mais que isso é laço. */
const MAX_ACCOUNT_SWITCHES_PER_TASK = 3;
const ACCOUNT_SWITCH_WINDOW_MS = 60 * 60_000;
const accountSwitchHistory = new Map<string, number[]>();
/** F-1471: panes com troca de conta em curso — uma por pane; o supervisor espera. */
const siblingReopens = new Set<string>();
/**
 * F-1473: panes substitutos esperando a prova da retomada — o failover é dono
 * da recuperação deles; a ficha de início do substituto não reabre a tarefa.
 */
const resumeProofPanes = new Set<string>();

function recentAccountSwitches(lineageId: string, now: number): number[] {
  const recent = (accountSwitchHistory.get(lineageId) ?? []).filter(
    (at) => now - at < ACCOUNT_SWITCH_WINDOW_MS,
  );
  accountSwitchHistory.set(lineageId, recent);
  return recent;
}

/**
 * F-1471/F-1473: o failover ainda cuida deste pane — espera-pela-irmã
 * agendada ou troca de conta em curso. A rede do supervisor (60 s) espera,
 * em vez de levar a mesma tarefa para outra CLI em paralelo.
 */
export function hasPendingFailoverRecovery(paneId: string, sessionId: string): boolean {
  if (siblingReopens.has(paneId) || resumeProofPanes.has(paneId)) return true;
  for (const pending of pendingRetries.values()) {
    if (pending.authority.sessionId === sessionId) return true;
  }
  return false;
}

/**
 * F-1471: a missão ainda é dona do pane (store do Main); null = sem leitura.
 * Síncrono de propósito: o módulo já está carregado (failover-orchestrator-
 * respawn o importa) e a troca não ganha espera nova.
 */
function missionOwnsPane(authority: FailoverAuthority): boolean | null {
  if (!authority.missionId) return false;
  try {
    const mission = getProjectDomainStores(authority.scope).missions.get(authority.missionId);
    return mission ? missionOwnsItsPanes(mission) : false;
  } catch {
    return null;
  }
}

type SiblingReopen = { readonly handled: true } | { readonly handled: false; readonly why: string };

/**
 * F-1471: pane de missão viva num pane do RENDERER esgotou a conta e há irmã
 * do MESMO provedor com folga. O renderer não religa pane de missão viva: o
 * "switched" de antes não trocava nada e, 60 s depois, o supervisor levava a
 * tarefa para OUTRA CLI. Aqui o Main reabre a MESMA tarefa na MESMA CLI pela
 * rota do spawn, fixada na irmã, com o modelo de antes, na mesma worktree e
 * com o pacote de continuidade (sessão nova). F-1473: quando o histórico da
 * CLI atravessa as contas (Claude), o pane novo retoma a MESMA conversa e
 * recebe só a nota curta; se a retomada não sobe (recusa no spawn ou queda no
 * boot), a mesma troca é refeita com o pacote. Leitor: o pane novo nasce
 * antes de o velho fechar. Writer: o checkout é de um writer só (a delegação
 * no mesmo checkout é serializada e o segundo writer cairia numa worktree
 * NOVA, sem o trabalho não commitado) — o velho sai e o novo entra logo
 * depois. Recusa: a tarefa
 * segue pelo caminho de sempre (outra CLI ou espera), com o motivo.
 * `handled:false` = o Nexus não tem como trocar este pane; `why` diz por quê.
 */
async function reopenTaskOnSiblingAccount(
  req: SwitchRequest,
  next: Account,
  facts: NonNullable<FailoverEvent['continuity']>,
  flags: {
    readonly crossAccount: boolean;
    readonly coalesced: boolean;
    readonly probe: boolean;
    /** F-1473: o histórico desta CLI atravessa as duas contas. */
    readonly nativeResume?: boolean;
  },
): Promise<SiblingReopen> {
  const { authority, paneId, adapterId, hit, current, now } = req;
  const handle = getPaneTaskReroute(paneId);
  if (!handle) {
    return {
      handled: false,
      why:
        'o Nexus não tem o pedido de spawn deste pane (aberto fora do nexus_pane_spawn, ' +
        'restaurado ou com o pedido vencido) e não pode reabri-lo sozinho',
    };
  }
  // F-231: pane aberto pelo operador dentro da missão não é fechado pela máquina.
  if (paneTaskRerouteBlocker(handle) === 'operator') {
    return {
      handled: false,
      why: 'o pane foi aberto pelo operador dentro da missão (F-231): o Nexus não o fecha nem o religa sozinho',
    };
  }
  if (handle.adapterId !== adapterId) {
    return { handled: false, why: 'o pedido guardado deste pane é de outra CLI' };
  }
  // Uma troca por pane: outra notícia do mesmo limite não abre um segundo pane.
  if (siblingReopens.has(paneId)) return { handled: true };
  const fromLabel = current?.label ?? adapterId;
  const toMasked = maskAccountLabel(next.label);
  // Teto próprio (não é reabertura por falha, F-1414): troca em série é laço.
  const switches = recentAccountSwitches(handle.lineageId, now);
  if (switches.length >= MAX_ACCOUNT_SWITCHES_PER_TASK) {
    await continueWithoutSibling(req, {
      fallback: {
        cause:
          `a tarefa já trocou de conta ${MAX_ACCOUNT_SWITCHES_PER_TASK} vezes na última hora; ` +
          `o Nexus não a troca para a conta "${toMasked}" de novo sozinho`,
        paneGone: false,
      },
    });
    return { handled: true };
  }
  switches.push(now);
  siblingReopens.add(paneId);
  // A rede do supervisor não reabre a mesma tarefa noutra CLI enquanto esta
  // troca corre (antes do primeiro await: rota + spawn podem passar de 60 s).
  forgetConfirmedPaneLimit(paneId);
  try {
    const agent = getAgentSessionInfo(authority.sessionId)?.agentName ?? paneId;
    // O modelo que o processo rodou de fato (o pane pode não ter id explícito).
    const previousModel = getAgentSessionInfo(authority.sessionId)?.model ?? req.paneModel;
    const pane = { paneId, adapterId, model: req.paneModel, accountId: current?.id };
    const spawnFirst = handle.exclusiveCheckout === false;
    const freshRequest: PaneTaskRerouteRequest = {
      excludeAdapterIds: [],
      sameAdapter: { adapterId, accountId: next.id, ...(previousModel ? { model: previousModel } : {}) },
      appendPrompt: buildContinuityPack({
        fromAccountLabel: fromLabel,
        toAccountLabel: next.label,
        reason: hit.reason,
        role: 'worker',
        missionId: authority.missionId,
        limitKind: hit.kind,
        limitWindow: facts.limitWindow ?? null,
        limitResetsAt: facts.limitResetsAt ?? null,
        limitCooldownMs: facts.limitCooldownMs ?? null,
        touchedFiles: facts.touchedFiles,
        diffStat: facts.diffStat,
        inFlightRequest: facts.inFlightRequest,
        scrollbackExcerpt: readSessionOutput(authority.sessionId, CLI_SWITCH_EXCERPT_LINES),
        nextStep: previousModel
          ? `${CLI_SWITCH_NEXT_STEP} The previous session ran model ${previousModel}; this one keeps it when the CLI offers it.`
          : CLI_SWITCH_NEXT_STEP,
      }),
      worktreeFromPaneId: paneId,
    };
    // F-1473: a conversa vai junto para a irmã; o pane novo a retoma e só
    // vale depois de sobreviver ao boot. Senão: a mesma troca, com o pacote.
    const resumeNote =
      flags.nativeResume &&
      rebindProviderPaneSessionAccount(authority.scope, paneId, adapterId, current?.id, next.id)
        ? buildCrossAccountResumeNote({
            toAccountLabel: next.label,
            role: 'worker',
            inFlightRequest: facts.inFlightRequest,
          })
        : undefined;
    let resumedOutcome: TaskReopenOutcome | undefined;
    if (resumeNote) {
      // O observador nasce antes do spawn: saída no boot nunca escapa dele.
      const boot = observeResumeBoot();
      const proofs: string[] = [];
      try {
        resumedOutcome = await reopenTaskElsewhere(
          authority,
          pane,
          handle,
          { ...freshRequest, nativeResume: { fromPaneId: paneId, note: resumeNote } },
          {
            spawnFirst,
            confirm: (reopenedPaneId) => {
              proofs.push(reopenedPaneId);
              resumeProofPanes.add(reopenedPaneId);
              return boot.confirm({ paneId: reopenedPaneId });
            },
          },
        );
      } finally {
        boot.dispose();
        for (const proof of proofs) resumeProofPanes.delete(proof);
      }
    }
    const resumed = resumedOutcome?.ok === true && !resumedOutcome.unproved;
    const outcome = resumedOutcome?.ok
      ? resumedOutcome
      : await reopenTaskElsewhere(authority, pane, handle, freshRequest, { spawnFirst });
    const traceOutcome = (outcomeName: string, extra: Record<string, unknown> = {}): void =>
      trace({
        kind: 'account-failover',
        outcome: outcomeName,
        paneId,
        adapterId,
        fromAccountId: current?.id ?? null,
        toAccountId: next.id,
        limitKind: hit.kind,
        reason: `${hit.reason}${req.reasonSuffix}`,
        crossAccount: flags.crossAccount,
        coalesced: flags.coalesced,
        missionId: authority.missionId ?? null,
        respawn: 'main-task-reopen',
        ...extra,
      });
    if (!outcome.ok) {
      traceOutcome('switch-respawn-failed', { paneGone: outcome.closed });
      await continueWithoutSibling(req, {
        fallback: {
          cause: `a conta "${toMasked}" com folga não recebeu a tarefa (${outcome.error})`,
          paneGone: outcome.closed,
        },
      });
      return { handled: true };
    }
    const modelNote =
      previousModel && outcome.model && outcome.model !== previousModel
        ? ` — o modelo "${previousModel}" não estava na rota; a tarefa seguiu em "${outcome.model}"`
        : '';
    const staleNote = outcome.staleOpen
      ? ` — o pane antigo (${paneId}, conta esgotada) não fechou; feche-o`
      : '';
    traceOutcome('switched', { toPaneId: outcome.paneId, toModel: outcome.model ?? null, nativeResume: resumed });
    emitFailoverReceipt(authority, {
      paneId,
      fromAccountLabel: fromLabel,
      toAccountLabel: next.label,
      reason: `${hit.reason}${req.reasonSuffix}${modelNote}${staleNote}`,
      kind: hit.kind,
      switched: true,
      toAccountId: next.id,
      fromAccountId: current?.id,
      crossAccount: flags.crossAccount,
      coalesced: flags.coalesced,
      missionId: authority.missionId,
      fromAdapterId: adapterId,
      toAdapterId: outcome.adapterId,
      toPaneId: outcome.paneId,
      ...(outcome.model ? { toModel: outcome.model } : {}),
      ...(flags.probe ? { probe: true } : {}),
      ...(resumed ? { nativeResume: true } : {}),
    });
    await notifyMissionOrchestrator(
      authority,
      `[troca-de-conta:${paneId}] O worker "${agent}" (${adapterId}) esgotou a conta ` +
        `"${maskAccountLabel(fromLabel)}" e seguiu na conta "${toMasked}" da mesma CLI ` +
        `(pane ${outcome.paneId}${outcome.model ? `, modelo ${outcome.model}` : ''}), ` +
        (resumed
          ? 'retomando a MESMA conversa'
          : 'com o pacote de continuidade (arquivos tocados, diff e próximo passo)') +
        `${modelNote}${staleNote}; ` +
        'espere o handoff dela.',
    );
    return { handled: true };
  } finally {
    siblingReopens.delete(paneId);
  }
}

/**
 * F-1471: pane de missão viva que o Nexus não pode trocar sozinho — o recibo
 * diz que NÃO trocou e por quê, e o Maestro é avisado (nunca "trocado" falso).
 */
async function refuseMissionPaneSwitch(req: SwitchRequest, next: Account, why: string): Promise<void> {
  const { authority, paneId, adapterId, hit, current } = req;
  const toMasked = maskAccountLabel(next.label);
  emitNoSwitch(
    authority,
    { paneId, adapterId, model: req.paneModel, accountId: current?.id },
    current,
    hit,
    `${hit.reason} — a conta "${toMasked}" tem folga, mas ${why}`,
  );
  const agent = getAgentSessionInfo(authority.sessionId)?.agentName ?? paneId;
  await notifyMissionOrchestrator(
    authority,
    `[troca-de-conta:${paneId}] O pane "${agent}" (${adapterId}) esgotou a conta ` +
      `"${maskAccountLabel(current?.label ?? adapterId)}" e não foi trocado para a conta ` +
      `"${toMasked}", que tem folga: ${why}. Decida: reabra a tarefa com nexus_pane_spawn ` +
      '(a conta com folga é escolhida sozinha) ou espere a conta liberar.',
  );
}

/**
 * Sem conta irmã aplicável. Espera-pela-irmã (política do omp): retry
 * automático em min(fim do cooldown da própria conta, menor blockedUntil das
 * irmãs)+1s em vez de desistir ou esperar a janela multi-hora do provedor.
 * Auth: nunca retenta a MESMA credencial morta (1s ticker / 15min cooldown
 * fingiam "Sessão recuperada" e injetavam continue no /login).
 * F-1471: `fallback` = a irmã com folga existia, mas não recebeu a tarefa —
 * o motivo entra no recibo e o Maestro é avisado; com `paneGone` (o writer
 * já tinha saído), não há pane para esperar a conta: só recibo e aviso.
 */
async function continueWithoutSibling(
  req: SwitchRequest,
  outcome: {
    readonly nextUnblockAtMs?: number;
    readonly prepareError?: string;
    readonly fallback?: {
      /** Motivo com rótulos mascarados (vai ao recibo e ao Maestro). */
      readonly cause: string;
      readonly paneGone: boolean;
    };
  },
): Promise<void> {
  const { key, authority, paneId, adapterId, hit, current, attempt } = req;
  const { nextUnblockAtMs, prepareError, fallback } = outcome;
  const fromAccountId = current?.id;
  const fromLabel = current?.label ?? adapterId;
  const retryTarget = retryTargetMsForLimit({
    kind: hit.kind,
    ownUnblockAtMs: req.ownUnblockAtMs,
    nextUnblockAtMs,
  });
  // F-775: todas as contas desta CLI esgotadas por bastante tempo — a
  // tarefa segue em OUTRA CLI elegível. Sem saída (ou falhando antes de o
  // pane sair), continua a espera-pela-irmã de sempre, com o motivo.
  const cliPlan = planCliSwitch(req, retryTarget);
  let cliSwitchNote = cliPlan.kind === 'blocked' ? cliPlan.note : undefined;
  if (cliPlan.kind === 'go') {
    const switched = await continueOnAnotherCli(req, cliPlan, retryTarget, nextUnblockAtMs, fallback?.cause);
    if (switched.handled) return;
    cliSwitchNote = switched.note;
  }
  let scheduledRetryAtMs: number | undefined;
  if (!fallback?.paneGone && retryTarget !== undefined && attempt < MAX_SCHEDULED_RETRIES) {
    scheduledRetryAtMs = scheduleFailoverRetry(key, authority, hit, retryTarget + RETRY_BUFFER_MS, attempt + 1);
  }
  console.info(
    '[failover]',
    JSON.stringify({
      paneId,
      adapterId,
      fromAccountId: fromAccountId ?? null,
      toAccountId: null,
      reason: hit.reason,
      switched: false,
      prepareError: prepareError ?? null,
      nextUnblockAtMs: nextUnblockAtMs ?? null,
      scheduledRetryAtMs: scheduledRetryAtMs ?? null,
      attempt,
      ...(fallback ? { siblingRefused: true, paneGone: fallback.paneGone } : {}),
    }),
  );
  // Publish the new schedule (or its exhaustion), so the UI never keeps
  // promising the original retry time after that attempt has already run.
  const event: FailoverEvent = {
    paneId,
    fromAccountLabel: fromLabel,
    toAccountLabel: '',
    reason:
      (prepareError ? `${hit.reason} (troca indisponível: ${prepareError})` : hit.reason) +
      (fallback ? ` — ${fallback.cause}` : '') +
      (cliSwitchNote ? ` — ${cliSwitchNote}` : ''),
    kind: hit.kind,
    switched: false,
    fromAccountId,
    missionId: authority.missionId,
    ...(nextUnblockAtMs !== undefined ? { nextUnblockAtMs } : {}),
    ...(scheduledRetryAtMs !== undefined ? { scheduledRetryAtMs } : {}),
  };
  if (!fallback) {
    emitFailover(authority, event);
    return;
  }
  // A sessão velha já saiu (writer): o recibo vai ao dono de quando a troca começou.
  if (fallback.paneGone) emitFailoverReceipt(authority, event);
  else emitFailover(authority, event);
  const agent = getAgentSessionInfo(authority.sessionId)?.agentName ?? paneId;
  await notifyMissionOrchestrator(
    authority,
    `[troca-de-conta:${paneId}] O worker "${agent}" (${adapterId}) esgotou a conta ` +
      `"${maskAccountLabel(fromLabel)}"; ${fallback.cause}` +
      (cliSwitchNote ? ` — ${cliSwitchNote}` : '') +
      (fallback.paneGone
        ? `. O pane parado já tinha saído (o checkout é de um writer só) e a tarefa ficou sem pane; ` +
          `o checkout e a branch seguem intactos. Reabra-a com nexus_pane_spawn({ resume: "${paneId}" }).`
        : '. O pane segue na conta esgotada, à espera de ela liberar. Decida: reabra a tarefa ou espere.'),
  );
}

async function performSwitch(req: SwitchRequest): Promise<void> {
  const { authority, paneId, adapterId, hit, now, current, attempt } = req;
  const fromLabel = current?.label ?? adapterId;
  const fromAccountId = current?.id;
  // Escopo da seleção: tier do modelo do pane; senão o tier citado no erro.
  const selectionScope = tierScopeFromModelId(req.paneModel) ?? hit.scope;

  const coalesceKey = `${adapterId}\0${fromAccountId ?? '_'}`;
  let coalesced = false;
  let probe = false;
  let next: Account | null = null;
  let nextUnblockAtMs: number | undefined;
  const recent = coalesceByFrom.get(coalesceKey);
  if (recent && recent.expiresAt > now) {
    const reused = getAccount(recent.toAccountId);
    if (
      reused &&
      reused.adapterId === adapterId &&
      !isAccountBlockedForScope(reused.id, now, selectionScope)
    ) {
      next = reused;
      coalesced = true;
    } else {
      // Stale/bad coalesce entry — drop so we re-pick.
      coalesceByFrom.delete(coalesceKey);
    }
  }

  const quotaScores = quotaScoresFor(adapterId);
  const quotaByAccountId = quotaHeadroomFor(adapterId);

  if (!next) {
    const selection = pickAvailableForFailover(
      adapterId,
      req.excludeId,
      now,
      quotaScores,
      {
        allowProbe: true,
        ...(selectionScope ? { scope: selectionScope } : {}),
        ...(quotaByAccountId ? { quotaByAccountId } : {}),
      },
    );
    next = selection.account;
    probe = selection.probe;
    nextUnblockAtMs = selection.nextUnblockAtMs;
  }

  // F-511: performSwitch é async (heal-before-pin): sem este registro
  // antecipado, panes da mesma rajada não veriam a decisão do primeiro
  // switch (o registro pós-prepare só acontece depois do await) e cada um
  // repetia o pick. Provisório de propósito: o prepare abaixo valida o alvo
  // e o caminho existente apaga a entrada na falha — o reuse revalida conta
  // e escopo de qualquer forma. Sondagens nunca entram (como no registro
  // pós-prepare): é UMA request de teste, não destino da rajada.
  if (next && !probe && !coalesced) {
    coalesceByFrom.set(coalesceKey, {
      toAccountId: next.id,
      toLabel: next.label,
      expiresAt: now + COALESCE_MS,
    });
  }

  // Pin-only prepare. O coalesce já foi registrado de forma provisória no
  // pick (visibilidade para a rajada concorrente); aqui, na falha do
  // prepare, a entrada é descartada e a frota é percorrida até uma conta
  // preparar (teto MAX_PREPARE_ATTEMPTS, F-676).
  let prepareError: string | undefined;
  if (next) {
    // F-511: secundária Claude com access token vencido mas refresh vivo
    // morria no 401 do pane porque o sweeper (15min) ainda não tinha
    // renovado. Renova aqui, no momento do pin; sem refresh no blob ou com
    // refresh morto, o prepare abaixo recusa com motivo acionável em vez
    // de queimar a sessão.
    if (next.adapterId === 'claude') {
      await healClaudeSecondaryBeforePin(next.id, now);
    }
    let prepared = await prepareFailoverAccount(adapterId, next.id, now, {
      allowCoolingProbe: probe,
    });
    const failedIds = new Set<string>();
    while (next && !prepared.ok) {
      prepareError = prepared.error;
      console.warn('[failover] next account not spawnable:', prepared.error);
      coalesceByFrom.delete(coalesceKey);
      coalesced = false;
      failedIds.add(next.id);
      // Sondagem consumida não ganha cooldown extra: o bloco dela já existe.
      if (!probe) {
        setCooldown(
          next.id,
          now + PREPARE_FAILURE_COOLDOWN_MS,
          `troca indisponível: ${prepared.error}`,
          selectionScope,
        );
      }
      if (failedIds.size >= MAX_PREPARE_ATTEMPTS) {
        next = null;
        break;
      }
      // Alternativas sem probe: a sondagem (se houve) já foi consumida.
      const alternate = pickAvailableForFailover(
        adapterId,
        req.excludeId,
        now,
        quotaScores,
        {
          excludeIds: failedIds,
          ...(selectionScope ? { scope: selectionScope } : {}),
          ...(quotaByAccountId ? { quotaByAccountId } : {}),
        },
      );
      next = alternate.account;
      probe = false;
      if (nextUnblockAtMs === undefined) {
        nextUnblockAtMs = alternate.nextUnblockAtMs;
      }
      if (!next) break;
      if (next.adapterId === 'claude') {
        await healClaudeSecondaryBeforePin(next.id, now);
      }
      prepared = await prepareFailoverAccount(adapterId, next.id, now);
    }
    if (next && prepared.ok) prepareError = undefined;
  }

  if (!next) {
    const adopted = adoptNativeAccountForFailover(adapterId, req.excludeId);
    if (adopted) {
      const prepared = await prepareFailoverAccount(adapterId, adopted.id, now);
      if (prepared.ok) {
        next = adopted;
        probe = false;
        prepareError = undefined;
      } else {
        prepareError = prepared.error;
      }
    }
  }

  if (!next) {
    await continueWithoutSibling(req, { nextUnblockAtMs, prepareError });
    return;
  }

  // Only after successful prepare: share this A→B decision with concurrent
  // panes. Sondagens nunca entram no coalesce: é UMA request de teste, não um
  // destino saudável para a rajada inteira.
  if (!coalesced && !probe) {
    coalesceByFrom.set(coalesceKey, {
      toAccountId: next.id,
      toLabel: next.label,
      expiresAt: now + COALESCE_MS,
    });
  }

  const crossAccount = Boolean(
    fromAccountId ? fromAccountId !== next.id : true,
  );
  // F-1473: o histórico desta CLI atravessa as contas — a conversa segue.
  const nativeResume =
    crossAccount && nativeResumeAcrossAccounts(adapterId, { from: current, to: next });

  console.info(
    '[failover]',
    JSON.stringify({
      paneId,
      adapterId,
      fromAccountId: fromAccountId ?? null,
      toAccountId: next.id,
      reason: hit.reason,
      switched: true,
      crossAccount,
      coalesced,
      probe,
      attempt,
      missionId: authority.missionId ?? null,
    }),
  );

  // F-249: o evento "trocou" só pode sair depois da troca de verdade. Pane
  // main-owned (worker headless de missão): o renderer não é dono e nunca
  // consumiria o evento — o Main respawna ANTES de emitir, e emite o desfecho
  // real (skip/recusa do respawn virava toast de sucesso mentiroso).
  if (!authority.owner) {
    let respawned = false;
    try {
      // F-775: o pack de continuidade leva a janela/reset medidos da conta
      // exausta (quando o snapshot tem) para o agente novo saber o horário.
      const limitWindowInfo = measuredLimitWindow(adapterId, fromAccountId);
      respawned = await respawnMainOwnedPaneWithAccount({
        paneId,
        sessionId: authority.sessionId,
        adapterId,
        toAccountId: next.id,
        toAccountLabel: next.label,
        fromAccountLabel: fromLabel,
        reason: hit.reason,
        limitKind: hit.kind,
        limitWindow: limitWindowInfo?.label ?? null,
        limitResetsAt: limitWindowInfo?.resetsAt ?? nextUnblockAtMs ?? null,
        limitCooldownMs: hit.cooldownMs,
        // O trecho final do PTY (memória do Main) — o builder poda e mascara.
        scrollbackExcerpt: readSessionOutput(authority.sessionId, CLI_SWITCH_EXCERPT_LINES),
        fromAccountId,
        nativeResume,
      });
    } catch (error) {
      console.warn(
        '[failover] main-owned respawn falhou:',
        error instanceof Error ? error.message : error,
      );
    }
    trace({
      kind: 'account-failover',
      outcome: respawned ? 'switched' : 'switch-respawn-failed',
      paneId,
      adapterId,
      fromAccountId: fromAccountId ?? null,
      toAccountId: next.id,
      limitKind: hit.kind,
      reason: `${hit.reason}${req.reasonSuffix}`,
      crossAccount,
      coalesced,
      missionId: authority.missionId ?? null,
    });
    if (!respawned) {
      emitNoSwitch(
        authority,
        { paneId, adapterId, model: req.paneModel, accountId: fromAccountId ?? undefined },
        current,
        hit,
        `${hit.reason} — a troca para "${next.label}" não se aplicou ` +
          '(o pane não pôde ser religado); a conta original segue em cooldown',
      );
      return;
    }
    emitFailover(authority, {
      paneId,
      fromAccountLabel: fromLabel,
      toAccountLabel: next.label,
      reason: `${hit.reason}${req.reasonSuffix}`,
      kind: hit.kind,
      switched: true,
      toAccountId: next.id,
      fromAccountId,
      crossAccount,
      coalesced,
      missionId: authority.missionId,
      ...(probe ? { probe } : {}),
    });
    return;
  }

  // F-995: orquestrador de missão num pane do renderer (inclusive o pane do
  // operador adotado pela missão da aba). O renderer não religa pane de
  // missão viva nem mata sessão de missão, e a cerca do spawn persistido
  // exige a conta selada — o "switched" de antes não trocava nada e o pane
  // ficava parado na conta esgotada. O Main troca a conta selada e religa o
  // MESMO pane pelo caminho de recuperação do orquestrador; o recibo sai só
  // depois do religamento.
  // F-775: o pacote (troca de conta) leva janela e estado da tarefa.
  const continuity = crossAccount
    ? await continuityFacts(authority, adapterId, fromAccountId, hit, nextUnblockAtMs)
    : undefined;
  if (authority.missionId && continuity) {
    const facts = continuity;
    // Recibo da sessão nova: foi a troca automática, não um pin qualquer.
    noteAccountFailoverForPane(
      paneId,
      `troca automática por limite confirmado: "${maskAccountLabel(fromLabel)}" ` +
        `esgotou (${hit.kind}); a conta fixada esgotada não prende o pane`,
    );
    const switchedOrchestrator = await switchRendererOrchestratorAccount({
      scope: authority.scope,
      missionId: authority.missionId,
      paneId,
      sessionId: authority.sessionId,
      toAccountId: next.id,
      buildRecap: () => buildContinuityPack({
        fromAccountLabel: maskAccountLabel(fromLabel),
        toAccountLabel: maskAccountLabel(next.label),
        reason: hit.reason,
        role: 'orchestrator',
        missionId: authority.missionId,
        limitKind: hit.kind,
        limitWindow: facts.limitWindow,
        limitResetsAt: facts.limitResetsAt,
        limitCooldownMs: facts.limitCooldownMs,
        ...(facts.touchedFiles ? { touchedFiles: facts.touchedFiles } : {}),
        ...(facts.diffStat ? { diffStat: facts.diffStat } : {}),
        inFlightRequest: facts.inFlightRequest,
        scrollbackExcerpt: readSessionOutput(
          authority.sessionId,
          CLI_SWITCH_EXCERPT_LINES,
        ),
        nextStep: ORCHESTRATOR_SWITCH_NEXT_STEP,
      }),
      ...(nativeResume
        ? {
            buildResumeNote: () => buildCrossAccountResumeNote({
              toAccountLabel: next.label,
              role: 'orchestrator',
              inFlightRequest: facts.inFlightRequest,
            }),
          }
        : {}),
    });
    if (!switchedOrchestrator.handled) forgetAccountFailoverNote(paneId);
    if (switchedOrchestrator.handled) {
      trace({
        kind: 'account-failover',
        outcome: switchedOrchestrator.ok ? 'switched' : 'switch-respawn-failed',
        paneId,
        adapterId,
        fromAccountId: fromAccountId ?? null,
        toAccountId: next.id,
        limitKind: hit.kind,
        reason: `${hit.reason}${req.reasonSuffix}`,
        crossAccount,
        coalesced,
        missionId: authority.missionId,
        respawn: 'main-orchestrator-recovery',
      });
      if (!switchedOrchestrator.ok) {
        forgetAccountFailoverNote(paneId);
        emitToPaneOwner(authority, {
          paneId,
          fromAccountLabel: fromLabel,
          toAccountLabel: '',
          reason:
            `${hit.reason} — a troca para "${next.label}" não se aplicou ` +
            `(${switchedOrchestrator.error}); a conta original segue em cooldown`,
          kind: hit.kind,
          switched: false,
          fromAccountId,
          missionId: authority.missionId,
        });
        return;
      }
      emitToPaneOwner(authority, {
        paneId,
        fromAccountLabel: fromLabel,
        toAccountLabel: next.label,
        reason: `${hit.reason}${req.reasonSuffix}`,
        kind: hit.kind,
        switched: true,
        toAccountId: next.id,
        fromAccountId,
        crossAccount,
        coalesced,
        missionId: authority.missionId,
        respawnedByMain: true,
        ...(probe ? { probe } : {}),
      });
      return;
    }
  }

  // F-1471: pane de missão viva no renderer — a conta dele é do Main. Ou o
  // Main troca de verdade, ou o recibo diz que não trocou (nunca "trocado"
  // sem troca). Sem leitura do store, segue o caminho antigo.
  // F-1473: com histórico compartilhado, a reabertura retoma a conversa.
  if (
    authority.missionId &&
    continuity &&
    !req.unconfirmed &&
    missionOwnsPane(authority) === true
  ) {
    const reopened = await reopenTaskOnSiblingAccount(req, next, continuity, {
      crossAccount,
      coalesced,
      probe,
      nativeResume,
    });
    if (!reopened.handled) await refuseMissionPaneSwitch(req, next, reopened.why);
    return;
  }

  // F-1473: o renderer só retoma a conversa que já é da conta nova.
  const resumable =
    nativeResume &&
    rebindProviderPaneSessionAccount(authority.scope, paneId, adapterId, fromAccountId, next.id);
  emitFailover(authority, {
    paneId,
    fromAccountLabel: fromLabel,
    toAccountLabel: next.label,
    reason: `${hit.reason}${req.reasonSuffix}`,
    kind: hit.kind,
    switched: true,
    toAccountId: next.id,
    fromAccountId,
    crossAccount,
    coalesced,
    missionId: authority.missionId,
    ...(probe ? { probe } : {}),
    ...(continuity ? { continuity } : {}),
    ...(resumable ? { nativeResume: true } : {}),
  });
  trace({
    kind: 'account-failover',
    outcome: 'switched',
    paneId,
    adapterId,
    fromAccountId: fromAccountId ?? null,
    toAccountId: next.id,
    limitKind: hit.kind,
    reason: `${hit.reason}${req.reasonSuffix}`,
    crossAccount,
    coalesced,
    missionId: authority.missionId ?? null,
  });
}

/** Agenda (ou re-agenda) a espera-pela-irmã de um watch. */
function scheduleFailoverRetry(
  key: string,
  authority: FailoverAuthority,
  hit: LimitHit,
  retryAtMs: number,
  attempt: number,
): number {
  cancelScheduledRetry(key);
  // Primeiro agendamento respeita o instante exato (+buffer); re-agendamentos
  // têm piso de 30s — integração com o rearm: nunca mais cedo que o menor
  // entre o rearm e a liberação real.
  const minDelay = attempt <= 1 ? RETRY_BUFFER_MS : RETRY_MIN_RESCHEDULE_MS;
  const scheduledAt = Date.now();
  const delay = Math.max(retryAtMs - scheduledAt, minDelay);
  const timer = setTimeout(() => {
    pendingRetries.delete(key);
    try {
      fireScheduledRetry(key, authority, hit, attempt);
    } catch (err) {
      console.warn('[failover] scheduled retry error:', err);
    }
  }, delay);
  timer.unref?.();
  pendingRetries.set(key, { timer, authority });
  return scheduledAt + delay;
}

/**
 * Dispara a espera-pela-irmã: re-executa a decisão de failover sem excluir
 * ninguém — se o cooldown da própria conta expirou ela volta a ser elegível
 * (retomada same-account); senão uma irmã liberada (ou sondagem) assume.
 */
function fireScheduledRetry(
  key: string,
  authority: FailoverAuthority,
  hit: LimitHit,
  attempt: number,
): void {
  if (!isCurrentAuthority(authority)) return;
  const pane = resolvePaneDetails(authority);
  if (!pane) {
    return;
  }
  const now = Date.now();
  const adapterId = pane.adapterId;
  const current = paneAccount(pane);
  void performSwitch({
    key,
    authority,
    paneId: pane.paneId,
    adapterId,
    paneModel: pane.model,
    hit,
    now,
    current,
    excludeId: null,
    ownUnblockAtMs:
      current?.cooldownUntil && current.cooldownUntil > now
        ? current.cooldownUntil
        : undefined,
    attempt,
    reasonSuffix: ' — retry automático (conta liberada)',
  });
}

/**
 * F-249: retry de um limite que a API do provider NÃO conseguiu confirmar.
 * Re-sonda uma vez: leitura saudável refuta → limpa o cooldown capado e o
 * pane segue intacto; confirmada ou ainda sem dados → troca de verdade
 * (adiar pra sempre deixaria pane preso num limite real — a janela capada é
 * o único adiamento permitido). Dividir o mapa `pendingRetries` é proposital:
 * cancel/cleanup por escopo/sessão cobrem o retry sem código duplo.
 */
function scheduleUnconfirmedLimitRetry(
  key: string,
  authority: FailoverAuthority,
  hit: LimitHit,
  retryAtMs: number,
): number {
  cancelScheduledRetry(key);
  const scheduledAt = Date.now();
  const delay = Math.max(retryAtMs - scheduledAt, RETRY_BUFFER_MS);
  const timer = setTimeout(() => {
    pendingRetries.delete(key);
    try {
      void fireUnconfirmedLimitRetry(key, authority, hit);
    } catch (err) {
      console.warn('[failover] unconfirmed-limit retry error:', err);
    }
  }, delay);
  timer.unref?.();
  pendingRetries.set(key, { timer, authority });
  return scheduledAt + delay;
}

async function fireUnconfirmedLimitRetry(
  key: string,
  authority: FailoverAuthority,
  hit: LimitHit,
): Promise<void> {
  if (!isCurrentAuthority(authority)) return;
  const pane = resolvePaneDetails(authority);
  if (!pane) return;
  const adapterId = pane.adapterId;
  const current = paneAccount(pane);
  const now = Date.now();
  let fresh: ProviderQuotaEntry | undefined;
  try {
    await requireQuotaService().refreshForLimitHit(now);
    fresh = quotaEntryForPane(adapterId, current);
  } catch {
    fresh = undefined;
  }
  const probedAt = Date.now();
  if (providerApiRefutesLimit(fresh, hit, probedAt)) {
    if (current) {
      clearCooldown(current.id, 'limite não confirmado pela API do provider — sonda saudável no retry');
    }
    logSuppressedFailover(pane, current, hit, 'unconfirmed-limit-refuted-at-retry', 'transient-watch');
    trace({
      kind: 'account-failover',
      outcome: 'unconfirmed-refuted',
      paneId: pane.paneId,
      adapterId,
      fromAccountId: current?.id ?? null,
      limitKind: hit.kind,
      reason: hit.reason,
      missionId: authority.missionId ?? null,
    });
    // Pane de missão pode ter ficado parado no erro fantasma: um "continue"
    // na mesma sessão retoma sem custo. Pane do operador nunca é digitado.
    if (authority.missionId) nudgeTransientContinue(authority, pane, current, hit);
    return;
  }
  // Confirmado pela sonda ou ainda sem dados: era (ou pode ser) limite real —
  // a troca acontece AGORA, no fim da pausa capada. Quando a sonda CONFIRMOU,
  // a conta sai da disputa de vez (evita respawnar na conta ainda limitada);
  // sem dados ela pode voltar a ser escolhida (falso positivo provável).
  const confirmed = hasFreshProviderApiWindowForLimit(fresh, hit, probedAt) ||
    providerApiExhaustsAccount(fresh, hit, probedAt) ||
    providerApiConfirmsAuth(fresh, hit, probedAt);
  void performSwitch({
    key,
    authority,
    paneId: pane.paneId,
    adapterId,
    paneModel: pane.model,
    hit,
    now,
    current,
    excludeId: confirmed ? (current?.id ?? null) : null,
    ownUnblockAtMs:
      current?.cooldownUntil && current.cooldownUntil > now
        ? current.cooldownUntil
        : undefined,
    attempt: 0,
    reasonSuffix: ' — troca após pausa de limite não confirmado',
  });
}

type FailoverSignalSource = 'observer' | 'scrollback';

function watchFor(authority: FailoverAuthority): [string, SessionWatch] {
  const key = watchKey(authority);
  let watch = watches.get(key);
  if (!watch) {
    watch = {
      authority,
      buffer: '',
      firedAt: 0,
      lastDetectAt: 0,
      pendingChars: 0,
      detectTimer: null,
      startedAt: Date.now(),
      transientAt: 0,
      progressChars: 0,
      seenLines: new Set(),
      errorSignatures: new Set(),
      slowDetectUntil: 0,
    };
    watches.set(key, watch);
  }
  return [key, watch];
}

/**
 * F-520: escolha pura do modelo de rotação quando o provider rejeita o id do
 * pane. Ordem: migração de id aposentado (só conta se MUDOU o id), o default
 * curado do catálogo do adapter e (F-765) os modelos da rota automática da
 * CLI — quando o recusado É o default (gpt-6.1-sol no Codex, 03/10), a
 * alternativa vem dali. Cada candidato precisa ser outro id, constar da lista
 * da CLI instalada (quando há lista) e ser elegível: fora da quarentena da
 * conta/instalação e do bloqueio do catálogo. Sem candidato → undefined e o
 * pane recebe orientação acionável (ou a tarefa é reaberta em outra CLI).
 *
 * Pane SEM modelo conhecido já roda no default do adapter (o pty-manager
 * resolve models.default) — rotacionar "para o default" respawna o mesmo
 * modelo rejeitado com toast de sucesso mentiroso, então também retorna
 * undefined: a orientação certa é atualizar a CLI, não trocar de modelo.
 */
export function pickModelRotation(
  paneModel: string | undefined,
  adapterDefault: string | undefined,
  options: {
    /** Ordem de preferência depois da migração e do default. */
    readonly candidates?: readonly string[];
    /** Modelos que a CLI instalada lista (vazio = sem como validar). */
    readonly available?: readonly string[];
    /** false = fora (quarentena, catálogo). */
    readonly eligible?: (model: string) => boolean;
  } = {},
): string | undefined {
  if (!paneModel) return undefined;
  const rejected = paneModel.trim().toLowerCase();
  const migrated = migrateModelId(paneModel);
  const ordered = [
    ...(migrated && migrated !== paneModel ? [migrated] : []),
    ...(adapterDefault ? [adapterDefault] : []),
    ...(options.candidates ?? []),
  ];
  return ordered.find(
    (candidate) =>
      Boolean(candidate.trim()) &&
      candidate.trim().toLowerCase() !== rejected &&
      (!options.available?.length || options.available.includes(candidate)) &&
      (!options.eligible || options.eligible(candidate)),
  );
}

/**
 * F-765: modelos da rota automática da CLI, do tier mais forte ao mais leve.
 * O GPT-6 Astra não está na tabela (F-700: só pelo nome), então a rotação
 * nunca o escolhe sozinha.
 */
export function routeModelsForAdapter(adapterId: string): string[] {
  const models: string[] = [];
  for (const tier of [...TIER_ORDER].reverse()) {
    for (const row of DEFAULT_ROUTING_TABLE[tier]) {
      if (row.adapterId === adapterId && row.model && !models.includes(row.model)) {
        models.push(row.model);
      }
    }
  }
  return models;
}

type PaneDetails = NonNullable<ReturnType<typeof resolvePaneDetails>>;
type PaneAccount = ReturnType<typeof getActiveAccount>;

/** Conta que o pane usa agora: a fixada no pane, senão a ativa do adapter. */
function paneAccount(pane: PaneDetails): PaneAccount {
  const pinned = pane.accountId ? getAccount(pane.accountId) : null;
  return pinned?.adapterId === pane.adapterId
    ? pinned
    : getActiveAccount(pane.adapterId);
}

/** Linha de auditoria de toda decisão de NÃO trocar — um formato só. */
function logSuppressedFailover(
  pane: PaneDetails,
  current: PaneAccount | null | undefined,
  hit: LimitHit,
  suppressed: string,
  source: FailoverSignalSource | 'transient-watch',
  extra: Record<string, unknown> = {},
): void {
  // F-249: a decisão de NÃO trocar também precisa sobreviver ao empacotamento
  // — console.info morre no stdout, o trace fica em logs/main.trace.ndjson.
  trace({
    kind: 'account-failover',
    outcome: 'suppressed',
    suppressed,
    paneId: pane.paneId,
    adapterId: pane.adapterId,
    fromAccountId: current?.id ?? null,
    limitKind: hit.kind,
    reason: hit.reason,
    source,
    ...extra,
  });
  console.info(
    '[failover]',
    JSON.stringify({
      paneId: pane.paneId,
      adapterId: pane.adapterId,
      fromAccountId: current?.id ?? null,
      reason: hit.reason,
      ...extra,
      switched: false,
      suppressed,
      source,
    }),
  );
}

/** Evento "sem troca" para o renderer — mesmos campos em todos os ramos. */
function emitNoSwitch(
  authority: FailoverAuthority,
  pane: PaneDetails,
  current: PaneAccount | null | undefined,
  hit: LimitHit,
  reason: string = hit.reason,
  transientPhase?: FailoverEvent['transientPhase'],
  extra: Partial<Pick<FailoverEvent, 'nextUnblockAtMs' | 'scheduledRetryAtMs'>> = {},
): void {
  trace({
    kind: 'account-failover',
    outcome: 'no-switch',
    paneId: pane.paneId,
    adapterId: pane.adapterId,
    fromAccountId: current?.id ?? null,
    limitKind: hit.kind,
    reason,
    transientPhase: transientPhase ?? null,
    missionId: authority.missionId ?? null,
    ...extra,
  });
  emitFailover(authority, {
    paneId: pane.paneId,
    fromAccountLabel: current?.label ?? pane.adapterId,
    toAccountLabel: '',
    reason,
    kind: hit.kind,
    switched: false,
    fromAccountId: current?.id,
    missionId: authority.missionId,
    ...(transientPhase ? { transientPhase } : {}),
    ...extra,
  });
}

function transientKey(key: string): string {
  return `${key}\0transient`;
}

function endTransientEpisode(watch: SessionWatch): void {
  analysisClient.control(watch.authority.sessionId, 'failover', { endTransient: true });
  watch.transientAt = 0;
  watch.progressChars = 0;
  watch.seenLines = new Set();
  watch.errorSignatures = new Set();
}

/**
 * Erro do PROVIDER (5xx, sobrecarga, capacidade do modelo). A conta está
 * sadia e a irmã recebe o mesmo erro: trocar de conta virava ping-pong A→B→A
 * a cada 503, com respawn e handoff a cada volta ("status:503", 23/09). Não
 * troca, não põe cooldown, não pinta a cota e não arma o rearm (um limite de
 * VERDADE logo depois precisa ser visto). Avisa uma vez por episódio e agenda
 * a verificação: a CLI costuma se recuperar sozinha nos próprios retries.
 *
 * `detectedText` é o trecho em que o erro foi visto: semeia as linhas já na
 * tela, e só um erro com linha INÉDITA zera o progresso — repaint do mesmo
 * erro não apaga a resposta que já chegou.
 */
function handleTransientHit(
  authority: FailoverAuthority,
  pane: PaneDetails,
  key: string,
  watch: SessionWatch,
  hit: LimitHit,
  now: number,
  source: FailoverSignalSource,
): void {
  if (watch.transientAt !== 0) return;
  const current = paneAccount(pane);
  // Um limite de verdade já está esperando a conta liberar: o pane é dele.
  if (pendingRetries.has(key)) {
    logSuppressedFailover(pane, current, hit, 'transient-deferred-to-limit-retry', source);
    analysisClient.control(authority.sessionId, 'failover', { rejectTransient: true });
    return;
  }
  watch.transientAt = now;
  watch.progressChars = 0;

  logSuppressedFailover(pane, current, hit, 'transient-provider-error', source);
  emitNoSwitch(authority, pane, current, hit, hit.reason, 'detected');
  scheduleTransientCheck(
    key,
    authority,
    hit,
    now + Math.max(hit.cooldownMs, TRANSIENT_MIN_CHECK_MS),
    1,
  );
}

function scheduleTransientCheck(
  key: string,
  authority: FailoverAuthority,
  hit: LimitHit,
  atMs: number,
  attempt: number,
): void {
  const tKey = transientKey(key);
  cancelScheduledRetry(tKey);
  const timer = setTimeout(
    () => {
      pendingRetries.delete(tKey);
      try {
        checkTransientRecovery(key, authority, hit, attempt);
      } catch (err) {
        console.warn('[failover] transient check error:', err);
      }
    },
    Math.max(atMs - Date.now(), RETRY_BUFFER_MS),
  );
  timer.unref?.();
  pendingRetries.set(tKey, { timer, authority });
}

/**
 * Depois do backoff: a CLI voltou a responder (texto novo inédito) → nada a
 * fazer; ainda ocupada (retries internos) → confere de novo; parada no erro →
 * pane de MISSÃO recebe um "continue" na mesma sessão. Nunca respawn: o
 * processo está vivo no prompt, respawn perdia o contexto e dizia que a conta
 * bateu limite. Pane do operador (sem missão) só recebe o aviso — o Nexus não
 * digita no terminal que o humano está dirigindo.
 */
function checkTransientRecovery(key: string, authority: FailoverAuthority, hit: LimitHit, attempt: number): void {
  const watch = watches.get(key);
  if (!isPtyAnalysisEnabled()) { checkTransientRecoveryNow(key, authority, hit, attempt); return; }
  void flushPtyAnalysis(authority.sessionId).then((ok) => {
    if (!ok || watches.get(key) !== watch || !isCurrentAuthority(authority)) return;
    checkTransientRecoveryNow(key, authority, hit, attempt);
  });
}

function checkTransientRecoveryNow(
  key: string,
  authority: FailoverAuthority,
  hit: LimitHit,
  attempt: number,
): void {
  const watch = watches.get(key);
  if (!watch || watch.transientAt === 0 || watch.analysisUnavailable) return;
  const pane = isCurrentAuthority(authority) ? resolvePaneDetails(authority) : null;
  const state = getSessionState(authority.sessionId);
  if (!pane || state === null || state === 'exited' || state === 'hibernated') {
    endTransientEpisode(watch);
    return;
  }
  const current = paneAccount(pane);
  if (watch.progressChars >= TRANSIENT_PROGRESS_CHARS) {
    logSuppressedFailover(pane, current, hit, 'transient-recovered', 'transient-watch', {
      progressChars: watch.progressChars,
    });
    endTransientEpisode(watch);
    return;
  }
  if (state !== 'idle') {
    if (attempt < MAX_TRANSIENT_CHECKS) {
      scheduleTransientCheck(
        key,
        authority,
        hit,
        Date.now() + TRANSIENT_RECHECK_MS,
        attempt + 1,
      );
      return;
    }
    logSuppressedFailover(pane, current, hit, 'transient-cli-still-busy', 'transient-watch', {
      attempt,
    });
    emitNoSwitch(
      authority,
      pane,
      current,
      hit,
      `${hit.reason} — a CLI segue tentando sozinha há ~${Math.round(
        (MAX_TRANSIENT_CHECKS * TRANSIENT_RECHECK_MS) / 60_000,
      )} min sem resposta`,
      'stalled',
    );
    endTransientEpisode(watch);
    return;
  }
  // Limite de verdade esperando a conta (ou a conta em cooldown): pedir para
  // continuar agora só bateria no limite de novo e reiniciaria a espera.
  if (pendingRetries.has(key) || (current?.cooldownUntil ?? 0) > Date.now()) {
    logSuppressedFailover(pane, current, hit, 'transient-deferred-to-limit-retry', 'transient-watch');
    endTransientEpisode(watch);
    return;
  }
  endTransientEpisode(watch);
  if (authority.missionId) {
    // F-1427: o MiniMax parou no "provider is temporarily unavailable" e o pane
    // ficou ocioso até o Maestro fechar — o "continue" era a única saída. Agora
    // a parada vai também à rede do supervisor (F-1414): sem saída nova, sem
    // handoff e sem voltar a trabalhar, a tarefa é reaberta noutra CLI. Um
    // retry só por sessão; a 2ª parada no erro já não espera o prazo.
    const now = Date.now();
    const retried = watch.providerStopRetried === true;
    watch.providerStopRetried = true;
    noteConfirmedPaneLimit({
      paneId: pane.paneId,
      sessionId: authority.sessionId,
      adapterId: pane.adapterId,
      reason: hit.reason,
      at: now,
      kind: 'provider-error',
      ...(pane.model ? { model: pane.model } : {}),
      ...(retried ? { readyAt: now } : {}),
    });
    if (retried) {
      logSuppressedFailover(pane, current, hit, 'transient-cli-stopped-after-retry', 'transient-watch');
      emitNoSwitch(
        authority,
        pane,
        current,
        hit,
        `${hit.reason} — a CLI parou de novo depois do retry; a tarefa vai para outra CLI`,
        'stopped',
      );
      return;
    }
  }
  if (!authority.missionId) {
    logSuppressedFailover(pane, current, hit, 'transient-cli-stopped-operator-pane', 'transient-watch');
    emitNoSwitch(
      authority,
      pane,
      current,
      hit,
      `${hit.reason} — a CLI parou com este erro do provider; mande "continue" no pane para tentar de novo`,
      'stopped',
    );
    return;
  }
  nudgeTransientContinue(authority, pane, current, hit);
}

/**
 * Missão parada num erro do provider: o mesmo processo, a mesma conta e a
 * mesma conversa recebem o pedido de continuar. Um falso positivo (a CLI já
 * tinha respondido curto) custa um "continue" inofensivo, não um restart.
 */
function nudgeTransientContinue(
  authority: FailoverAuthority,
  pane: PaneDetails,
  current: PaneAccount | null | undefined,
  hit: LimitHit,
): void {
  void (async () => {
    // Import tardio: tool-util puxa o grafo de ferramentas MCP, que não pode
    // entrar no ciclo de carga do failover.
    const { injectPrompt } = await import('./tool-util');
    if (!isCurrentAuthority(authority)) return;
    await injectPrompt(authority.sessionId, TRANSIENT_CONTINUE_PROMPT, undefined, 'failover');
    console.info(
      '[failover]',
      JSON.stringify({
        paneId: pane.paneId,
        adapterId: pane.adapterId,
        fromAccountId: current?.id ?? null,
        reason: hit.reason,
        switched: false,
        nudged: true,
        source: 'transient-watch',
      }),
    );
    emitNoSwitch(
      authority,
      pane,
      current,
      hit,
      `${hit.reason} — a CLI parou; o Nexus pediu para ela continuar na mesma conta e na mesma conversa`,
      'nudged',
    );
  })().catch((error) => {
    console.warn(
      '[failover] continue após erro do provider falhou:',
      error instanceof Error ? error.message : error,
    );
  });
}

/* ------------------------------------------------------------------------ *
 * F-765: modelo recusado pelo provedor. O pane é religado em outro modelo
 * elegível da MESMA CLI quando dá para religar no lugar; senão a tarefa é
 * reaberta pela rota do spawn. O pedido de troca e o recibo são eventos
 * separados: `switched:true` só sai depois de o religamento existir.
 * ------------------------------------------------------------------------ */

/** Prazo para o renderer religar o pane no modelo novo antes do recibo. */
const MODEL_ROTATION_PROOF_MS = 45_000;
const MODEL_ROTATION_PROOF_POLL_MS = 1_000;
/** Religamentos no lugar por pane nesta janela — mais que isso é cascata. */
const MAX_MODEL_ROTATIONS = 2;
const MODEL_ROTATION_WINDOW_MS = 10 * 60_000;
/** A identidade da instalação vai ao disco (assíncrono) no máximo nesta cadência. */
const INSTALLATION_ID_TTL_MS = 60_000;
/** Autor dos avisos do failover ao Maestro (handoff `progress`). */
const FAILOVER_AGENT = 'nexus-failover';

const modelRotationsByPane = new Map<string, number[]>();
const rotationProofs = new Map<
  string,
  { readonly timer: ReturnType<typeof setTimeout>; readonly resolve: (proven: boolean) => void }
>();
const installationIds = new Map<
  string,
  { readonly binPath: string; readonly id: string | null; readonly at: number }
>();
const installationRefreshes = new Map<string, Promise<string | null>>();

/** Identidade da instalação da CLI (alvo real + carimbo), lida do disco sem bloquear. */
function refreshInstallationId(adapterId: string): Promise<string | null> {
  const binPath = getAdapterResolvedBin(adapterId);
  if (!binPath) return Promise.resolve(null);
  const inFlight = installationRefreshes.get(adapterId);
  if (inFlight) return inFlight;
  const refresh = resolveModelQuarantineInstallationId(binPath)
    .then((id) => {
      installationIds.set(adapterId, { binPath, id, at: Date.now() });
      return id;
    })
    .finally(() => installationRefreshes.delete(adapterId));
  installationRefreshes.set(adapterId, refresh);
  return refresh;
}

/** Valor já resolvido, para o roteador; vencido, renova em segundo plano. */
function cachedInstallationId(adapterId: string): string | null {
  const binPath = getAdapterResolvedBin(adapterId);
  const cached = installationIds.get(adapterId);
  if (binPath && (!cached || cached.binPath !== binPath || Date.now() - cached.at >= INSTALLATION_ID_TTL_MS)) {
    void refreshInstallationId(adapterId).catch(() => undefined);
  }
  return cached && cached.binPath === binPath ? cached.id : null;
}

/**
 * Recusa que é da INSTALAÇÃO (CLI velha), não da conta: some quando a CLI
 * muda. 03/10: o Codex 0.146 recusava o gpt-6.1-sol "with a ChatGPT
 * account" e o 0.160 aceitou — atualizar a CLI curou, a conta estava sadia.
 */
function rejectionIsInstallationBound(reason: string): boolean {
  return /requires a newer version|not supported when using Codex with a ChatGPT account/i.test(
    reason,
  );
}

function noteModelRotation(paneId: string, now: number): boolean {
  const recent = (modelRotationsByPane.get(paneId) ?? []).filter(
    (at) => now - at < MODEL_ROTATION_WINDOW_MS,
  );
  const allowed = recent.length < MAX_MODEL_ROTATIONS;
  if (allowed) recent.push(now);
  modelRotationsByPane.set(paneId, recent);
  return allowed;
}

/**
 * Recibo de uma troca que já trocou a sessão (ou fechou o pane): a autoridade
 * antiga deixou de ser a corrente, então vale o dono e o escopo de quando a
 * troca começou — nunca outro projeto nem outra janela.
 */
function emitFailoverReceipt(authority: FailoverAuthority, event: FailoverEvent): void {
  if (authority.owner && !listeners.has(authority.owner)) return;
  broadcastToProject(
    authority.owner ? [authority.owner] : listeners,
    authority.scope,
    ACCOUNT_CHANNELS.failover,
    event,
  );
}

/**
 * Prova do religamento: uma sessão NOVA do mesmo pane, viva, que satisfaz o
 * pedido (modelo novo, CLI nova). Só memória do pty-manager — nada de disco
 * nem de processo.
 */
function waitForPaneRespawn(
  paneId: string,
  previousSessionId: string,
  matches: (session: ReturnType<typeof listAgentSessionsForPane>[number]) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + MODEL_ROTATION_PROOF_MS;
  rotationProofs.get(paneId)?.resolve(false);
  return new Promise((resolve) => {
    const check = (): void => {
      rotationProofs.delete(paneId);
      const respawned = listAgentSessionsForPane(paneId).some(
        (session) =>
          session.sessionId !== previousSessionId &&
          matches(session) &&
          (getSessionState(session.sessionId) ?? 'exited') !== 'exited',
      );
      if (respawned || Date.now() >= deadline) {
        resolve(respawned);
        return;
      }
      const timer = setTimeout(check, MODEL_ROTATION_PROOF_POLL_MS);
      timer.unref?.();
      rotationProofs.set(paneId, {
        timer,
        resolve: (proven) => {
          clearTimeout(timer);
          rotationProofs.delete(paneId);
          resolve(proven);
        },
      });
    };
    check();
  });
}

/** O religamento no modelo pedido (F-765). */
function waitForModelRespawn(
  paneId: string,
  previousSessionId: string,
  toModel: string,
): Promise<boolean> {
  const wanted = toModel.trim().toLowerCase();
  return waitForPaneRespawn(paneId, previousSessionId, (session) =>
    [session.model, session.requestedModel].some(
      (model) => model?.trim().toLowerCase() === wanted,
    ),
  );
}

/**
 * Avisa o Maestro da missão pelo mesmo canal do supervisor (handoff
 * `progress`). Só ids, CLI, modelo e o motivo mascarado — o texto de erro
 * do provedor nunca volta cru para um PTY (F-511).
 */
async function notifyMissionOrchestrator(
  authority: FailoverAuthority,
  summary: string,
): Promise<void> {
  if (!authority.missionId) return;
  if (getAgentSessionInfo(authority.sessionId)?.role === 'orchestrator') return;
  try {
    // Import tardio: o registro de stores e a entrega puxam o grafo da missão.
    const [{ getProjectDomainStores }, { onHandoffSubmitted }] = await Promise.all([
      import('./project-domain-store-registry'),
      import('./idle-delivery'),
    ]);
    const handoff = getProjectDomainStores(authority.scope).handoffs.submit({
      missionId: authority.missionId,
      status: 'progress',
      summary: sanitizeHandoffExcerptForDetector(summary),
      fromAgent: FAILOVER_AGENT,
    });
    onHandoffSubmitted(handoff, authority.scope);
  } catch (error) {
    console.warn(
      '[failover] aviso ao Maestro não entregue:',
      error instanceof Error ? error.message : error,
    );
  }
}

type TaskReopenOutcome =
  | {
      readonly ok: true;
      readonly paneId: string;
      readonly adapterId: string;
      /** F-1471: modelo com que o pane novo nasceu. */
      readonly model?: string;
      /** F-1471: pane-first — o pane novo existe, mas o parado não fechou. */
      readonly staleOpen?: boolean;
      /** F-1473: o pane novo ficou sem a prova pedida (não fechou para o fallback). */
      readonly unproved?: boolean;
    }
  /** `closed`: o pane parado já saiu — não há mais nada a esperar nele. */
  | { readonly ok: false; readonly error: string; readonly closed: boolean };

/**
 * F-765/F-775: a tarefa sai do pane parado e é reaberta pela rota do
 * `nexus_pane_spawn` — pedido original, autoridade atual de quem pediu. O
 * pane parado fecha ANTES (libera a vaga do worker e o checkout do writer);
 * o resultado só existe depois de o pane novo nascer.
 */
async function reopenTaskElsewhere(
  authority: FailoverAuthority,
  pane: PaneDetails,
  handle: PaneTaskRerouteHandle,
  request: PaneTaskRerouteRequest,
  /** F-1471: pane-first (leitor) — o novo nasce antes; recusado, o parado fica. */
  options: {
    readonly spawnFirst?: boolean;
    /**
     * F-1473: o pane novo só conta depois desta prova (a retomada sobreviveu
     * ao boot). `failed`: o pane novo sai e o pedido fica para outra
     * tentativa; `closed` (o próprio Nexus o encerrou): não é queda, sem
     * fallback.
     */
    readonly confirm?: (paneId: string) => Promise<ResumeBootVerdict>;
  } = {},
): Promise<TaskReopenOutcome> {
  // F-1471: na troca de conta a CLI é a mesma (a conta irmã já foi preparada).
  if (!request.sameAdapter && !handle.hasAlternative(request.excludeAdapterIds)) {
    return { ok: false, error: 'nenhuma CLI pode receber a tarefa agora', closed: false };
  }
  // A ficha de início (F-723) não reabre a mesma tarefa de novo.
  releasePaneStartWatch(pane.paneId);
  if (!options.spawnFirst && !(await closeStoppedPane(pane.paneId, authority.sessionId))) {
    return { ok: false, error: 'o pane parado não fechou; nada foi reaberto', closed: false };
  }
  let next: Awaited<ReturnType<PaneTaskRerouteHandle['reroute']>>;
  try {
    next = await handle.reroute(request);
  } catch (error) {
    // F-1471: o pedido fica guardado — o caminho de recurso ainda o usa.
    return { ok: false, error: shortStartError(error), closed: !options.spawnFirst };
  }
  const verdict = options.confirm ? await options.confirm(next.paneId) : 'proved';
  let unproved = verdict !== 'proved';
  if (verdict === 'failed') {
    // F-1473: uma recuperação por tarefa — a ficha de início do substituto
    // sai antes de qualquer outra, e o fallback só começa com ele fechado.
    releasePaneStartWatch(next.paneId);
    if (await closeReplacementPane(next.paneId)) {
      forgetPaneTaskReroute(next.paneId);
      return { ok: false, error: 'a retomada não subiu no pane novo', closed: !options.spawnFirst };
    }
    unproved = true;
  }
  forgetPaneTaskReroute(pane.paneId);
  // F-1482: o pane novo herda os pedidos em voo (troca em cadeia A → B → C).
  carryInFlightRequests(pane.paneId, next.paneId);
  const staleOpen = options.spawnFirst === true &&
    !(await closeStoppedPane(pane.paneId, authority.sessionId));
  return {
    ok: true,
    paneId: next.paneId,
    adapterId: next.adapterId,
    ...(next.model ? { model: next.model } : {}),
    ...(staleOpen ? { staleOpen: true } : {}),
    ...(unproved ? { unproved: true } : {}),
  };
}

/**
 * F-1473: fecha o substituto sem prova; true só com o fechamento ACEITO e
 * nenhuma sessão viva dele (senão o fallback abriria um segundo pane).
 */
async function closeReplacementPane(paneId: string): Promise<boolean> {
  const accepted = await requestPaneClose(paneId).catch(() => false);
  return accepted && !listAgentSessionsForPane(paneId).some(
    (session) => (getSessionState(session.sessionId) ?? 'exited') !== 'exited',
  );
}

/** Fecha o pane parado; a sessão que já saiu conta como fechada (F-1471). */
async function closeStoppedPane(paneId: string, sessionId: string): Promise<boolean> {
  if (await requestPaneClose(paneId, sessionId).catch(() => false)) return true;
  return !listAgentSessionsForPane(paneId).some(
    (session) =>
      session.sessionId === sessionId && (getSessionState(sessionId) ?? 'exited') !== 'exited',
  );
}

const REROUTE_BLOCKER_TEXT: Readonly<Record<PaneTaskRerouteBlocker, string>> = {
  'no-request': 'o Nexus não tem como reabrir esta tarefa sozinho',
  operator: 'o pane é do operador',
  pinned: 'a CLI foi pedida pelo operador — não troquei de CLI sozinho',
  'chain-limit': 'a tarefa já foi reaberta automaticamente o máximo de vezes',
};

async function handleModelRejection(
  authority: FailoverAuthority,
  pane: PaneDetails,
  hit: LimitHit,
  now: number,
  source: FailoverSignalSource,
  current: PaneAccount,
): Promise<void> {
  const adapterId = pane.adapterId;
  // A frase cita o próprio produto: no pane de outra CLI é citação, não erro.
  if (hit.adapterId && hit.adapterId !== adapterId) {
    logSuppressedFailover(pane, current, hit, 'model-error-of-another-cli', source);
    return;
  }
  // O modelo que o processo rodou de fato (o pane pode não ter id explícito).
  const rejected = getAgentSessionInfo(authority.sessionId)?.model ?? pane.model;
  const installationId = rejectionIsInstallationBound(hit.reason)
    ? await refreshInstallationId(adapterId).catch(() => null)
    : null;
  if (!isCurrentAuthority(authority)) return;
  const scope: ModelQuarantineScope = {
    accountId: current?.id ?? null,
    ...(installationId ? { installationId } : {}),
  };
  // F-683: o roteador para de mandar helpers para o modelo recusado. A recusa
  // de acesso é da conta; a incompatibilidade é da instalação (F-765).
  quarantineRejectedModel(adapterId, rejected, hit.reason, now, MODEL_ACCESS_QUARANTINE_MS, {
    ...scope,
    kind: installationId ? 'installation' : 'access',
  });
  const adapter = getAdapter(adapterId);
  const catalog = loadModelCatalog();
  const next = pickModelRotation(rejected, adapter?.models.default, {
    candidates: routeModelsForAdapter(adapterId),
    available: adapter?.models.list,
    eligible: (model) =>
      !modelAccessQuarantine(adapterId, model, now, scope) &&
      !isModelBlockedForAutoRouting(modelCatalogInfo(catalog, adapterId, model)),
  });
  const label = current?.label ?? adapterId;
  const refused = `modelo "${rejected ?? 'padrão'}" recusado (${hit.reason})`;
  const base = {
    paneId: pane.paneId,
    fromAccountLabel: label,
    kind: 'model' as const,
    fromAccountId: current?.id,
    missionId: authority.missionId,
  };
  const traceOutcome = (outcome: string, extra: Record<string, unknown> = {}): void =>
    trace({
      kind: 'account-failover',
      outcome,
      paneId: pane.paneId,
      adapterId,
      fromAccountId: current?.id ?? null,
      limitKind: hit.kind,
      reason: hit.reason,
      fromModel: rejected ?? null,
      missionId: authority.missionId ?? null,
      ...extra,
    });

  // 1) Pane que o renderer religa no lugar (fora de missão): pedido → prova → recibo.
  let capped = false;
  if (next && authority.owner && !authority.missionId) {
    if (noteModelRotation(pane.paneId, now)) {
      const rotation = {
        ...base,
        toAccountLabel: label,
        toModel: next,
        ...(current ? { toAccountId: current.id } : {}),
        crossAccount: false,
      };
      emitFailover(authority, {
        ...rotation,
        reason: `${refused} → religando em "${next}"`,
        switched: false,
        modelRotationPhase: 'requested',
      });
      traceOutcome('model-rotation-requested', { toModel: next });
      const proven = await waitForModelRespawn(pane.paneId, authority.sessionId, next);
      if (proven) releasePaneStartWatch(pane.paneId);
      emitFailoverReceipt(authority, {
        ...rotation,
        reason: proven
          ? `${refused} → rotacionado para "${next}"`
          : `${refused} — o pane não religou em "${next}" em ` +
            `${Math.round(MODEL_ROTATION_PROOF_MS / 1000)} s; nada foi trocado`,
        switched: proven,
        modelRotationPhase: 'applied',
      });
      traceOutcome(proven ? 'model-rotated' : 'model-rotation-failed', { toModel: next });
      return;
    }
    capped = true;
  }

  // 2) Pane de missão (o renderer não religa pane de missão viva) ou helper
  //    sem religamento no lugar: a tarefa é reaberta pela rota do spawn —
  //    preferindo a mesma CLI quando ela ainda tem outro modelo elegível.
  const handle = getPaneTaskReroute(pane.paneId);
  const blocker = paneTaskRerouteBlocker(handle);
  if (handle && !blocker) {
    const sameCli = Boolean(next) && !capped;
    const reopened = await reopenTaskElsewhere(authority, pane, handle, {
      excludeAdapterIds: sameCli ? [] : [adapterId],
      ...(sameCli ? { preferAdapterIds: [adapterId] } : {}),
    });
    const reason = reopened.ok
      ? `${refused} → tarefa reaberta em ${reopened.adapterId} (pane ${reopened.paneId})`
      : `${refused} — a tarefa não foi reaberta: ${reopened.error}`;
    emitFailoverReceipt(authority, {
      ...base,
      toAccountLabel: '',
      reason,
      switched: reopened.ok,
      fromAdapterId: adapterId,
      ...(reopened.ok ? { toAdapterId: reopened.adapterId, toPaneId: reopened.paneId } : {}),
    });
    traceOutcome(reopened.ok ? 'task-rerouted' : 'task-reroute-failed', {
      ...(reopened.ok ? { toAdapterId: reopened.adapterId, toPaneId: reopened.paneId } : {}),
    });
    await notifyMissionOrchestrator(
      authority,
      `[failover:${pane.paneId}] O pane ${pane.paneId} (${adapterId}) parou: ${reason}.` +
        (reopened.ok ? '' : ' Decida: abra de novo com outro modelo ou outra CLI.'),
    );
    return;
  }

  // 3) Pane main-owned sem pedido guardado: o Main religa no modelo novo.
  if (next && !authority.owner) {
    if (noteModelRotation(pane.paneId, now)) {
      let respawned = false;
      try {
        respawned = await respawnMainOwnedPaneWithAccount({
          paneId: pane.paneId,
          sessionId: authority.sessionId,
          adapterId,
          ...(current ? { toAccountId: current.id } : {}),
          fromAccountLabel: label,
          reason: hit.reason,
          toModel: next,
        });
      } catch (error) {
        console.warn(
          '[failover] main-owned model respawn falhou:',
          error instanceof Error ? error.message : error,
        );
      }
      const reason = respawned
        ? `${refused} → rotacionado para "${next}"`
        : `${refused} — o pane não pôde ser religado em "${next}"`;
      emitFailoverReceipt(authority, {
        ...base,
        toAccountLabel: label,
        toModel: next,
        reason,
        switched: respawned,
        modelRotationPhase: 'applied',
      });
      traceOutcome(respawned ? 'model-rotated' : 'model-rotation-failed', { toModel: next });
      if (!respawned) {
        await notifyMissionOrchestrator(
          authority,
          `[failover:${pane.paneId}] O pane ${pane.paneId} (${adapterId}) parou: ${reason}. ` +
            'Decida: abra de novo com outro modelo ou outra CLI.',
        );
      }
      return;
    }
    capped = true;
  }

  // 4) Sem como recuperar sozinho: aviso honesto (toast) e o Maestro decide.
  // A orientação ("atualize a CLI…") vive SÓ no failover-toast-copy.
  const why = capped
    ? `${MAX_MODEL_ROTATIONS} religamentos seguidos já falharam neste pane`
    : next
      ? `${blocker ? REROUTE_BLOCKER_TEXT[blocker] : 'o pane não pode ser religado aqui'}; ` +
        `"${next}" segue elegível nesta CLI`
      : 'sem modelo alternativo elegível nesta CLI';
  traceOutcome('model-no-recovery', { blocker: blocker ?? null, capped });
  emitNoSwitch(authority, pane, current, hit, `${hit.reason} — ${why}`);
  await notifyMissionOrchestrator(
    authority,
    `[failover:${pane.paneId}] O pane ${pane.paneId} (${adapterId}) parou: ${refused} — ${why}. ` +
      'Decida: abra de novo com outro modelo ou outra CLI.',
  );
}

function handleLimitHit(
  authority: FailoverAuthority,
  pane: PaneDetails,
  key: string,
  hit: LimitHit,
  now: number,
  source: FailoverSignalSource,
): void {
  const adapterId = pane.adapterId;
  const current = paneAccount(pane);
  const quotaEntry = quotaEntryForPane(adapterId, current);

  // Provider-api readings are authoritative evidence over scrollback text AND
  // observer hook frames. If a fresh provider API reading proves the account is healthy,
  // failover is suppressed. Pane nativo (sem conta) refuta pela linha nativa.
  if (providerApiRefutesLimit(quotaEntry, hit, now)) {
    logSuppressedFailover(pane, current, hit, 'provider-api-healthy', source);
    return;
  }

  // Modelo rejeitado (F-520/F-765): a CONTA está sadia — "as contas estão
  // todas operacionais". Cooldown de credencial aqui puniria conta sã e
  // queimaria o pool inteiro: a recuperação troca o MODELO (ou reabre a
  // tarefa pela rota do spawn) e só anuncia a troca depois de ela existir.
  if (hit.kind === 'model') {
    void handleModelRejection(authority, pane, hit, now, source, current).catch((error) => {
      console.warn(
        '[failover] recuperação de modelo recusado falhou:',
        error instanceof Error ? error.message : error,
      );
    });
    return;
  }

  // Guarda: erro do provider é episódio próprio (handleTransientHit) e nunca
  // chega à troca de conta, nem por um caminho novo que esqueça de desviar.
  if (hit.kind === 'transient') {
    logSuppressedFailover(pane, current, hit, 'transient-provider-error', source);
    return;
  }

  // F-1410: CLI sem conta gerenciada (login nativo, como o Muse Code) não tem
  // sonda de provider por conta — `fresh` seria sempre vazio e o limite ficaria
  // eternamente "não confirmado" (15 min, sem marcar nada). A confirmação dela
  // é a POSIÇÃO: o hit veio de uma célula de status/erro que só a TUI desta
  // mesma CLI desenha (`confirmed`, nunca a frase solta — F-249). Então a CLI
  // entra em janela inteira e a troca segue como confirmada.
  // Ponto de extensão: quando houver sonda de cota da CLI (ex.: `muse-usage`),
  // ela refuta com `clearCliLimit` ou ajusta a janela com `noteCliLimit`.
  if (!current && hit.confirmed === true && hit.adapterId === adapterId) {
    commitLimitHit(authority, pane, key, hit, now, source, current, adapterId);
    return;
  }

  // A long multi-hour usage quarantine cannot be authorized by PTY text alone
  // (cascata fantasma: um `cat erro.log` com a frase certa não é limite). Sem
  // leitura provider-api fresca, CONFIRMA com uma sonda ao vivo antes de
  // quarentenar/trocar: leitura sadia refuta; leitura no limite aplica a
  // janela inteira. Outra janela da conta só confirma com 100% MEDIDO.
  // Sonda sem resposta preserva F-249: pausa curta na mesma conta e retry.
  // Provider errors (transient) never reach this function.
  //
  // Auth entra na MESMA sonda (incidente agy 2026-10-13): o cooldown de auth
  // é curto (15 min), mas ele TROCA de conta e, sem irmã, move a tarefa a
  // outra CLI (`planCliSwitch` aceita auth) — texto "authentication_error"
  // no PTY parou uma missão com a conta operacional. A sonda decide: leitura
  // provider-api medida refuta (a credencial foi aceita para produzi-la),
  // `auth-expired` confirma, sem dados vira pausa capada na mesma conta.
  if (
    (longCooldownNeedsFreshProviderApi(hit) || hit.kind === 'auth') &&
    !hasFreshProviderApiWindowForLimit(quotaEntry, hit, now) &&
    !providerApiExhaustsAccount(quotaEntry, hit, now) &&
    !providerApiConfirmsAuth(quotaEntry, hit, now)
  ) {
    void confirmLimitByProbe(authority, pane, key, hit, now, source, current, adapterId);
    return;
  }
  commitLimitHit(authority, pane, key, hit, now, source, current, adapterId);
}

async function confirmLimitByProbe(
  authority: FailoverAuthority,
  pane: PaneDetails,
  key: string,
  hit: LimitHit,
  now: number,
  source: FailoverSignalSource,
  current: ReturnType<typeof paneAccount>,
  adapterId: string,
): Promise<void> {
  let fresh: ProviderQuotaEntry | undefined;
  let probeUnavailable = false;
  try {
    await requireQuotaService().refreshForLimitHit(now);
    fresh = quotaEntryForPane(adapterId, current);
  } catch (error) {
    console.warn(
      '[failover] sonda de cota após limite falhou:',
      error instanceof Error ? error.message : error,
    );
    fresh = undefined;
    probeUnavailable = true;
  }
  const probedAt = Date.now();
  if (providerApiRefutesLimit(fresh, hit, probedAt)) {
    logSuppressedFailover(pane, current, hit, 'provider-api-healthy-after-probe', source);
    return;
  }
  // Serviço de cota fora do ar (boot race): nenhuma autoridade pôde julgar.
  // Auth mantém a recuperação legada (trocar de credencial é o conserto de um
  // 401 real e o disjuntor de morte instantânea freia o loop); uso continua
  // no caminho não confirmado abaixo, como sempre foi.
  if (hit.kind === 'auth' && probeUnavailable) {
    commitLimitHit(authority, pane, key, hit, now, source, current, adapterId);
    return;
  }
  if (hasFreshProviderApiWindowForLimit(fresh, hit, probedAt) ||
      providerApiExhaustsAccount(fresh, hit, probedAt) ||
      providerApiConfirmsAuth(fresh, hit, probedAt)) {
    commitLimitHit(authority, pane, key, hit, now, source, current, adapterId);
    return;
  }
  if (repeatedUnconfirmedLimit(adapterId, current?.id, hit.kind, probedAt)) {
    logSuppressedFailover(pane, current, hit, 'unconfirmed-limit-repeated-after-pause', source);
    commitLimitHit(authority, pane, key, hit, now, source, current, adapterId);
    return;
  }
  // F-249: sonda sem resposta NÃO troca o pane. O único indício é o texto da
  // CLI (ou narração do Maestro citando erro de outro pane — "usage limit
  // reached" casa no detector mesmo sem erro na conta do narrador). A conta
  // fica em cooldown CURTO para o pool não sentar nela, o pane segue vivo na
  // MESMA conta e um retry re-sonda: confirmado/sem-dados → troca lá;
  // refutado → limpa o cooldown e não toca em nada. Antes disto o texto sozinho
  // capava o cooldown E respawnava o pane na irmã — "trocou sem ter atingido".
  logSuppressedFailover(
    pane,
    current,
    hit,
    'long-cooldown-capped-without-provider-api',
    source,
    { cooldownMs: hit.cooldownMs, cappedToMs: CAPPED_COOLDOWN_WITHOUT_PROVIDER_API_MS },
  );
  if (!current) {
    // Sem conta gerenciada (login nativo — ex.: Muse — ou adapter api-key):
    // não há cooldown nem irmã, mas F-249 vale igual — texto de PTY que a
    // sonda NÃO confirmou não pode virar o toast definitivo «Sessão
    // expirada» (Bug 9). «Desconhecido» não é «expirado»: com o Keychain
    // negado (F-1447) a sonda do Muse devolve `quota-key-required` pela
    // sessão inteira, e o caminho legado commitava esse desconhecido como
    // expiração na hora. Aqui nada muda de estado (sem conta para pôr em
    // pausa), então nada se anuncia: agenda a re-sondagem e cala.
    // Confirmado (auth-expired/janela) foi tratado acima; no retry,
    // confirmado-ou-ainda-sem-dados troca e avisa, como na conta gerenciada.
    noteQuotaLimitHit(adapterId, hit, undefined);
    scheduleUnconfirmedLimitRetry(
      key,
      authority,
      hit,
      now + CAPPED_COOLDOWN_WITHOUT_PROVIDER_API_MS + RETRY_BUFFER_MS,
    );
    return;
  }
  setCooldown(
    current.id,
    now + CAPPED_COOLDOWN_WITHOUT_PROVIDER_API_MS,
    `${hit.reason} (limite não confirmado pela API do provider)`,
    hit.scope,
  );
  noteQuotaLimitHit(adapterId, hit, current.id);
  const scheduledRetryAtMs = scheduleUnconfirmedLimitRetry(
    key,
    authority,
    hit,
    now + CAPPED_COOLDOWN_WITHOUT_PROVIDER_API_MS + RETRY_BUFFER_MS,
  );
  emitNoSwitch(
    authority,
    pane,
    current,
    hit,
    `${hit.reason} — a API do provider não confirmou o limite; ` +
      `a conta fica em pausa curta e o pane tenta de novo em ~${Math.round(
        CAPPED_COOLDOWN_WITHOUT_PROVIDER_API_MS / 60_000,
      )} min sem trocar de conta`,
    undefined,
    {
      scheduledRetryAtMs,
      nextUnblockAtMs: now + CAPPED_COOLDOWN_WITHOUT_PROVIDER_API_MS,
    },
  );
}

/** Cooldown na conta esgotada, disjuntor de auth e troca para a próxima. */
function commitLimitHit(
  authority: FailoverAuthority,
  pane: PaneDetails,
  key: string,
  hit: LimitHit,
  now: number,
  source: FailoverSignalSource,
  current: ReturnType<typeof paneAccount>,
  adapterId: string,
  options: { readonly unconfirmed?: boolean } = {},
): void {
  // Feed fleet quota UI (session/5h/weekly bars) from the same limit signal.
  noteQuotaLimitHit(adapterId, hit, current?.id);
  // F-1414: limite CONFIRMADO (sonda/API ou repetido depois da pausa) vai à
  // rede do supervisor: se a troca daqui não tirar a tarefa do pane, ela é
  // reaberta noutra CLI. Texto sem confirmação (F-249) nunca entra, nem a
  // pausa curta de taxa que a própria CLI atravessa (mesmo piso da troca de CLI).
  if (
    !options.unconfirmed &&
    (hit.kind === 'quota' || (hit.kind === 'rate-limit' && hit.cooldownMs >= CLI_SWITCH_MIN_WAIT_MS))
  ) {
    noteConfirmedPaneLimit({
      paneId: pane.paneId,
      sessionId: authority.sessionId,
      adapterId,
      reason: hit.reason,
      at: now,
    });
  }

  // F-1410: sem conta gerenciada não há onde pôr cooldown (`setCooldown`
  // abaixo não roda e `hasAvailableAccount` é true para sempre): a rota
  // reescolheria a CLI esgotada. Limite confirmado pela célula da própria TUI
  // (mesmo adapter do pane) marca a CLI inteira até o reset; texto não
  // confirmado nunca marca.
  if (
    !current &&
    !options.unconfirmed &&
    hit.confirmed === true &&
    hit.adapterId === adapterId
  ) {
    const cliLimit = noteCliLimit(adapterId, hit, now);
    trace({
      kind: 'account-failover',
      outcome: 'cli-limited',
      paneId: pane.paneId,
      adapterId,
      fromAccountId: null,
      limitKind: hit.kind,
      reason: hit.reason,
      missionId: authority.missionId ?? null,
      unblockAtMs: cliLimit.until,
      source,
    });
  }

  // Put the exhausted account on cooldown, then pick the next available one.
  // Com escopo (erro cita um tier anthropic): a conta segue no pool para os
  // demais modelos; sem escopo o cooldown é global (comportamento legado).
  if (current) {
    setCooldown(current.id, now + hit.cooldownMs, hit.reason, hit.scope);
    if (
      hit.kind === 'auth' &&
      current.adapterId === 'claude' &&
      current.mode === 'subscription'
    ) {
      // 401 não significa necessariamente refresh morto: o access token pode
      // ter sido revogado antes do expiresAt. Renova somente a linhagem desta
      // conta no vault; nunca troca nem sobrescreve o Keychain global.
      void ensureFreshClaudeSubscription(current.id, now, undefined, {
        force: true,
      }).catch(() => {
        console.warn(
          '[failover] renovação forçada da conta Claude falhou antes de concluir',
        );
      });
    }
  }

  // Disjuntor de morte instantânea (401-loop multi-conta): sessão que morre
  // de auth com segundos de vida nasceu com credencial morta — trocar para a
  // irmã e respawnar só queima outro pane. A 1ª morte ainda troca (abrir pane
  // em conta morta e cair na irmã saudável é legítimo); a 2ª seguida da MESMA
  // conta dentro da janela trava o failover com motivo acionável — contas
  // diferentes mortas só travam o provider a partir de
  // INSTANT_DEATH_PROVIDER_TRIP (F-676, frotas de 10–100 contas). O prepare da
  // account-store já veta conta com refresh morto; isto cobre a credencial
  // que morreu entre o prepare e o spawn. As entradas decaem pela janela, e
  // o re-login limpa a causa (blob fresco).
  if (hit.kind === 'auth') {
    const sessionAgeMs = now - (watches.get(key)?.startedAt ?? now);
    if (sessionAgeMs < INSTANT_DEATH_MS) {
      const { sameAccount, distinctAccounts } = noteInstantAuthDeath(adapterId, current?.id, now);
      const deaths = Math.max(sameAccount, distinctAccounts);
      if (sameAccount >= INSTANT_DEATH_TRIP || distinctAccounts >= INSTANT_DEATH_PROVIDER_TRIP) {
        logSuppressedFailover(pane, current, hit, 'instant-auth-death-breaker', source, {
          sessionAgeMs,
          deaths,
          sameAccount,
          distinctAccounts,
        });
        // Emite SEMPRE: suprimir aqui deixava o pane morrer sem nenhum
        // feedback no renderer. Repetição idêntica não empilha toast — a
        // store deduplica por kind+título+detalhe e troca no lugar. Sem
        // ponteiro de re-login no motivo: o toast de kind auth
        // (blockedFailoverToastCopy) já instrui "Entre novamente em
        // Configurações → Providers".
        emitNoSwitch(
          authority,
          pane,
          current,
          hit,
          `${hit.reason} (sessão morreu com segundos de vida ` +
            `${deaths}x seguidas — credencial provavelmente expirada)`,
        );
        return;
      }
    }
  }

  void performSwitch({
    key,
    authority,
    paneId: pane.paneId,
    adapterId,
    paneModel: pane.model,
    hit,
    now,
    current,
    excludeId: current?.id ?? null,
    ownUnblockAtMs: current ? now + hit.cooldownMs : undefined,
    attempt: 0,
    reasonSuffix: '',
    ...(options.unconfirmed ? { unconfirmed: true } : {}),
  });
}

function acceptAnalysisProposal(sessionId: string, proposal: FailoverTextProposal): void {
  const authority = resolveAuthority(sessionId);
  if (!authority || !isCurrentAuthority(authority)) return;
  const pane = resolvePaneDetails(authority); if (!pane) return;
  const [key, watch] = watchFor(authority);
  watch.analysisUnavailable = proposal.unavailable === true;
  if (proposal.slowScanMs) trace({ kind: 'failover-detect-slow', sessionId, paneId: pane.paneId, scanMs: proposal.slowScanMs, backoffMs: 5_000 });
  if (proposal.unavailable) return;
  // F-999: sinal de modelo citado logo depois do pack de continuidade, à espera da 2ª ocorrência.
  if (proposal.held) logSuppressedFailover(pane, paneAccount(pane), proposal.held, 'model-signal-after-continuity-pack-unconfirmed', 'scrollback');
  if (proposal.hit) {
    if (proposal.at - watch.firedAt < REARM_MS) return;
    if (proposal.hit.kind === 'transient') {
      handleTransientHit(authority, pane, key, watch, proposal.hit, proposal.at, 'scrollback');
    } else {
      beginLimitHandling(key, watch, proposal.at);
      handleLimitHit(authority, pane, key, proposal.hit, proposal.at, 'scrollback');
    }
  }
  if (watch.transientAt !== 0) watch.progressChars = proposal.progressChars;
}

/**
 * Limite de verdade (cota/taxa/auth/modelo): arma o rearm, cancela a espera
 * anterior e encerra um episódio de erro do provider — a troca assume o pane.
 * Erro do provider NÃO passa por aqui: ele não pode cancelar a nova tentativa
 * já agendada para um limite real, senão o pane fica parado esperando nada.
 */
function beginLimitHandling(key: string, watch: SessionWatch, now: number): void {
  watch.firedAt = now;
  analysisClient.control(watch.authority.sessionId, 'failover', { firedAt: now });
  watch.buffer = '';
  cancelScheduledRetry(key);
  cancelScheduledRetry(transientKey(key));
  endTransientEpisode(watch);
}

function handleObserverFrame(frame: ObserverFrame): void {
  if (frame.kind !== 'provider_error' || !resolveAuthority(frame.sessionId)) return;
  const hit: LimitHit = { kind: frame.payload.kind, reason: frame.payload.reason, cooldownMs: frame.payload.cooldownMs,
    ...(frame.payload.scope ? { scope: frame.payload.scope } : {}) };
  analysisClient.control(frame.sessionId, 'failover', { observer: { hit, at: frame.at } });
}

export function initFailover(): void {
  if (untapData || untapObserver) return;
  // F-765: a quarentena do roteador lê a conta ativa e a instalação já
  // resolvida (cache, sem disco no caminho da rota).
  setModelQuarantineScopeResolver((adapterId) => ({
    accountId: getActiveAccount(adapterId)?.id ?? null,
    installationId: cachedInstallationId(adapterId),
  }));
  untapData = subscribePtyAnalysis('failover', (sessionId, proposal) => {
    acceptAnalysisProposal(sessionId, proposal as FailoverTextProposal);
  });
  untapExit = tapSessionExit((sessionId) => {
    for (const [key, watch] of [...watches]) {
      if (watch.authority.sessionId !== sessionId) continue;
      if (watch.detectTimer) clearTimeout(watch.detectTimer);
      watches.delete(key);
    }
    for (const [key, pending] of [...pendingRetries]) {
      if (pending.authority.sessionId === sessionId) cancelScheduledRetry(key);
    }
  });
  // Canonical provider failures reach this path without passing through the
  // mixed terminal stream. Keep the scrollback tap above for older providers
  // that do not emit hooks yet.
  untapObserver = tapObserverFrames((frame) => {
    try {
      handleObserverFrame(frame);
    } catch (err) {
      console.warn('[failover] observer tap error:', err);
    }
  });
}

export function shutdownFailover(): void {
  untapData?.();
  untapExit?.();
  untapObserver?.();
  untapData = null;
  untapExit = null;
  untapObserver = null;
  watches.clear();
  // Estado do disjuntor de morte instantânea também é ciclo de vida do
  // failover: sem isto, mortes de testes/sessões anteriores vazam para as
  // próximas e o trip dispara cedo demais.
  instantAuthDeaths.clear();
  for (const key of [...pendingRetries.keys()]) cancelScheduledRetry(key);
  // F-765: provas de religamento pendentes terminam sem troca.
  for (const proof of [...rotationProofs.values()]) proof.resolve(false);
  modelRotationsByPane.clear();
  cliSwitchHistory.clear();
  accountSwitchHistory.clear();
  siblingReopens.clear();
  resumeProofPanes.clear();
  unconfirmedStrikes.clear();
  installationIds.clear();
  setModelQuarantineScopeResolver(null);
  coalesceByFrom.clear();
  for (const [wc, onDestroyed] of destroyHandlers) {
    wc.removeListener('destroyed', onDestroyed);
  }
  destroyHandlers.clear();
  listeners.clear();
  unsubscribeScopeChanges?.();
  unsubscribeScopeChanges = null;
}

/**
 * Ask the renderer to restart one exact, still-authorized pane with its native
 * resume mechanism. Used by the stall watchdog only after a long second
 * timeout; no account/keychain mutation occurs.
 */
export function requestSessionRecovery(sessionId: string, reason: string): boolean {
  const authority = resolveAuthority(sessionId);
  // Native resume is a renderer-owned mechanism; main-owned/headless mission
  // workers recover through the scheduler's session-exit path instead.
  if (!authority || !authority.owner) return false;
  const pane = findPaneBySessionOwnedBy(authority.owner, sessionId);
  if (!pane || pane.paneId !== authority.paneId || pane.kind !== 'cli-agent' || !pane.adapterId) {
    return false;
  }
  const account = pane.accountId ? getAccount(pane.accountId) : getActiveAccount(pane.adapterId);
  emitFailover(authority, {
    paneId: pane.paneId,
    fromAccountLabel: account?.label ?? pane.adapterId,
    toAccountLabel: account?.label ?? pane.adapterId,
    reason,
    switched: true,
    crossAccount: false,
    missionId: authority.missionId,
    ...(account?.id
      ? { toAccountId: account.id, fromAccountId: account.id }
      : {}),
  });
  return true;
}

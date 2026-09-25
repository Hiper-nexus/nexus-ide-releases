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
  tapSessionData,
  tapSessionExit,
} from '../pty/pty-manager';
import { getAdapter } from '../adapters/adapter-registry';
import { migrateModelId } from '../../shared/model-defaults';
import { respawnMainOwnedPaneWithAccount } from './failover-mission-respawn';
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
} from '../persistence/renderer-workspace-scope';
import {
  stripAnsi,
  findPaneBySessionOwnedBy,
  getOwnedPaneAuthzInfoBySession,
  getPaneRuntimeAuthorityBySession,
  type OwnedPaneAuthzInfo,
} from './pane-registry';
import { detectLimit, tierScopeFromModelId, type LimitHit } from './limit-detector';
import { retryTargetMsForLimit } from './failover-retry-policy';
import {
  hasFreshProviderApiWindowForLimit,
  longCooldownNeedsFreshProviderApi,
  providerApiRefutesLimit,
} from './limit-refutation';
import type { ProviderQuotaEntry } from '../../shared/quota-types';
import {
  adoptNativeAccountForFailover,
  ensureFreshClaudeSubscription,
  getAccount,
  getActiveAccount,
  isAccountBlockedForScope,
  pickAvailableForFailover,
  prepareAccountForSpawn,
  setCooldown,
  verifyManagedClaudeAccountForSpawn,
} from '../persistence/account-store';
import { broadcastToProject, sameProjectScope } from './project-scoped-broadcast';
import {
  noteQuotaLimitHit,
  requireQuotaService,
} from '../quota/quota-service';
import { quotaAvailabilityScore } from '../quota/quota-policy';
import { tapObserverFrames } from './observer-bus';
import type { ObserverFrame } from '../../shared/observer-frame';

/**
 * Automatic account failover. Watches each pane's output for a limit signature
 * (rate-limit / quota / auth). When one fires: puts the pane's account on
 * cooldown, picks the next available account for that adapter, pins it on the
 * pane (no global activate thrash), and asks the renderer to re-spawn.
 *
 * Cross-account: fresh session + continuity pack (provider session ids are
 * account-owned). Same-account recovery still uses native resume.
 * Multi-pane storms coalesce on the same from-account → same to-account.
 */

const WINDOW_CHARS = 4000;
const REARM_MS = 30_000;
/**
 * detectLimit varre a janela inteira (~120 µs em 4 KB de TUI) e rodava a cada
 * chunk de PTY — 2–6% de um núcleo do main com cinco panes transmitindo. Fora
 * de um episódio de erro ela roda no máximo a cada DETECT_MIN_INTERVAL_MS, ou
 * antes, a cada DETECT_MAX_PENDING_CHARS de texto novo: metade da janela, então
 * toda mensagem de limite passa inteira por pelo menos uma varredura. Uma
 * varredura final cobre o que chegou por último quando a saída para.
 */
const DETECT_MIN_INTERVAL_MS = 250;
const DETECT_MAX_PENDING_CHARS = WINDOW_CHARS / 2;
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
const TRANSIENT_MIN_LINE_CHARS = 20;
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
const INSTANT_DEATH_TRIP = 2;
const INSTANT_DEATH_WINDOW_MS = 10 * 60_000;
/** adapterId → instantes das mortes instantâneas recentes. */
const instantAuthDeaths = new Map<string, number[]>();

function noteInstantAuthDeath(adapterId: string, now: number): number {
  const recent = (instantAuthDeaths.get(adapterId) ?? []).filter(
    (at) => now - at < INSTANT_DEATH_WINDOW_MS,
  );
  recent.push(now);
  instantAuthDeaths.set(adapterId, recent);
  return recent.length;
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
  let verifiedClaudeBlob: string | undefined;
  if (adapterId === 'claude' && getAccount(accountId)?.mode === 'subscription') {
    // The synchronous prepare can persist a rotated credential to the managed
    // store. Prove ownership first, including on alternate/native adoption.
    const identity = await verifyManagedClaudeAccountForSpawn(accountId, (blob) => {
      verifiedClaudeBlob = blob;
    });
    if (identity !== 'match') {
      return { ok: false, error: identity === 'mismatch'
        ? 'credencial Claude pertence a outra conta — entre novamente'
        : identity === 'auth-expired'
          ? 'sessão Claude expirada — entre novamente'
          : 'não foi possível verificar a identidade da conta Claude' };
    }
    if (!verifiedClaudeBlob) {
      return { ok: false, error: 'credencial Claude verificada mudou — tente novamente' };
    }
  }
  return prepareAccountForSpawn(adapterId, accountId, now,
    verifiedClaudeBlob ? { ...options, expectedClaudeBlob: verifiedClaudeBlob } : options);
}

async function performSwitch(req: SwitchRequest): Promise<void> {
  const { key, authority, paneId, adapterId, hit, now, current, attempt } = req;
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

  if (!next) {
    const selection = pickAvailableForFailover(
      adapterId,
      req.excludeId,
      now,
      quotaScores,
      { allowProbe: true, ...(selectionScope ? { scope: selectionScope } : {}) },
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
  // prepare, a entrada é descartada e tenta-se UMA alternativa.
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
    if (!prepared.ok) {
      prepareError = prepared.error;
      console.warn('[failover] next account not spawnable:', prepared.error);
      coalesceByFrom.delete(coalesceKey);
      coalesced = false;
      const failedId = next.id;
      // Alternate sem probe: a sondagem (se houve) já foi consumida.
      const alternate = pickAvailableForFailover(
        adapterId,
        failedId,
        now,
        quotaScores,
        selectionScope ? { scope: selectionScope } : undefined,
      );
      next = alternate.account;
      probe = false;
      if (nextUnblockAtMs === undefined) {
        nextUnblockAtMs = alternate.nextUnblockAtMs;
      }
      if (next) {
        if (next.adapterId === 'claude') {
          await healClaudeSecondaryBeforePin(next.id, now);
        }
        prepared = await prepareFailoverAccount(adapterId, next.id, now);
        if (!prepared.ok) {
          prepareError = prepared.error;
          next = null;
        } else {
          prepareError = undefined;
        }
      } else {
        next = null;
      }
    }
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
    // Espera-pela-irmã (política do omp): retry automático em
    // min(fim do cooldown da própria conta, menor blockedUntil das irmãs)+1s
    // em vez de desistir ou esperar a janela multi-hora do provedor.
    // Auth: nunca retenta a MESMA credencial morta (1s ticker / 15min
    // cooldown fingiam "Sessão recuperada" e injetavam continue no /login).
    const retryTarget = retryTargetMsForLimit({
      kind: hit.kind,
      ownUnblockAtMs: req.ownUnblockAtMs,
      nextUnblockAtMs,
    });
    let scheduledRetryAtMs: number | undefined;
    if (retryTarget !== undefined && attempt < MAX_SCHEDULED_RETRIES) {
      scheduledRetryAtMs = retryTarget + RETRY_BUFFER_MS;
      scheduleFailoverRetry(key, authority, hit, scheduledRetryAtMs, attempt + 1);
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
      }),
    );
    // Retries agendados falham em silêncio (o evento original já informou a
    // UI); só o hit original emite switched:false.
    if (attempt > 0) return;
    emitFailover(authority, {
      paneId,
      fromAccountLabel: fromLabel,
      toAccountLabel: '',
      reason: prepareError
        ? `${hit.reason} (troca indisponível: ${prepareError})`
        : hit.reason,
      kind: hit.kind,
      switched: false,
      fromAccountId,
      missionId: authority.missionId,
      ...(nextUnblockAtMs !== undefined ? { nextUnblockAtMs } : {}),
      ...(scheduledRetryAtMs !== undefined ? { scheduledRetryAtMs } : {}),
    });
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

  // Pane main-owned (worker headless de missão): o renderer não é dono e
  // nunca vai consumir o evento acima — o Main respawna com a nova conta.
  if (!authority.owner) {
    void respawnMainOwnedPaneWithAccount({
      paneId,
      sessionId: authority.sessionId,
      adapterId,
      toAccountId: next.id,
      fromAccountLabel: fromLabel,
      reason: hit.reason,
    }).catch((error) => {
      console.warn(
        '[failover] main-owned respawn falhou (evento segue para o renderer):',
        error instanceof Error ? error.message : error,
      );
    });
  }
}

/** Agenda (ou re-agenda) a espera-pela-irmã de um watch. */
function scheduleFailoverRetry(
  key: string,
  authority: FailoverAuthority,
  hit: LimitHit,
  retryAtMs: number,
  attempt: number,
): void {
  cancelScheduledRetry(key);
  // Primeiro agendamento respeita o instante exato (+buffer); re-agendamentos
  // têm piso de 30s — integração com o rearm: nunca mais cedo que o menor
  // entre o rearm e a liberação real.
  const minDelay = attempt <= 1 ? RETRY_BUFFER_MS : RETRY_MIN_RESCHEDULE_MS;
  const delay = Math.max(retryAtMs - Date.now(), minDelay);
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
    };
    watches.set(key, watch);
  }
  return [key, watch];
}

/**
 * F-520: escolha pura do modelo de rotação quando o provider rejeita o id do
 * pane. Ordem: migração de id aposentado (só conta se MUDOU o id), senão o
 * default curado do catálogo do adapter; se o resultado é o próprio modelo
 * rejeitado, não há rotação (undefined) e o pane recebe orientação acionável.
 *
 * Pane SEM modelo explícito já roda no default do adapter (o pty-manager
 * resolve models.default) — rotacionar "para o default" respawna o mesmo
 * modelo rejeitado com toast de sucesso mentiroso, então também retorna
 * undefined: a orientação certa é atualizar a CLI, não trocar de modelo.
 */
export function pickModelRotation(
  paneModel: string | undefined,
  adapterDefault: string | undefined,
): string | undefined {
  if (!paneModel) return undefined;
  const migrated = migrateModelId(paneModel);
  const fallback = migrated !== paneModel ? migrated : adapterDefault;
  return fallback && fallback !== paneModel ? fallback : undefined;
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
): void {
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
  });
}

function transientKey(key: string): string {
  return `${key}\0transient`;
}

function endTransientEpisode(watch: SessionWatch): void {
  watch.transientAt = 0;
  watch.progressChars = 0;
  watch.seenLines = new Set();
  watch.errorSignatures = new Set();
}

function normalizedLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((raw) => raw.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= TRANSIENT_MIN_LINE_CHARS);
}

function rememberLine(watch: SessionWatch, line: string): void {
  if (watch.seenLines.size >= 2_000) watch.seenLines = new Set();
  watch.seenLines.add(line);
}

/**
 * Linha que é o próprio erro/retry da CLI, não resposta do modelo. Estreito
 * de propósito: uma resposta que cita "HTTP 500" ou "unavailable" na prosa
 * continua contando como resposta.
 */
const TRANSIENT_NOISE_LINE =
  /retrying\s+in\s+\d|attempt\s+\d+\s*\/\s*\d+|api\s*error|overloaded_error|service unavailable|status[\s:(]*5\d\d\b|\bhttp\s*5\d\d\b/i;

/** O trecho da linha a partir do erro/retry, ou null se a linha não é erro. */
function errorSignature(line: string): string | null {
  const match = TRANSIENT_NOISE_LINE.exec(line);
  return match ? line.slice(match.index) : null;
}

/**
 * Conta texto NOVO depois do último erro do provider. Linha já vista (repaint
 * do transcript antigo, da moldura, do próprio erro) e a linha de erro/retry
 * não provam resposta.
 */
function noteTransientProgress(watch: SessionWatch, text: string): void {
  for (const line of normalizedLines(text)) {
    if (watch.seenLines.has(line)) continue;
    rememberLine(watch, line);
    const signature = errorSignature(line);
    if (signature !== null) {
      watch.errorSignatures.add(signature);
      continue;
    }
    watch.progressChars += line.length;
  }
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
  detectedText = '',
): void {
  const lines = normalizedLines(detectedText);
  if (watch.transientAt !== 0) {
    let freshError = false;
    for (const line of lines) {
      const signature = errorSignature(line);
      if (signature !== null && !watch.errorSignatures.has(signature)) {
        freshError = true;
        watch.errorSignatures.add(signature);
      }
      rememberLine(watch, line);
    }
    // A CLI reimprimiu o erro num retry NOVO: a resposta ainda não veio.
    if (freshError) watch.progressChars = 0;
    return;
  }
  const current = paneAccount(pane);
  // Um limite de verdade já está esperando a conta liberar: o pane é dele.
  if (pendingRetries.has(key)) {
    logSuppressedFailover(pane, current, hit, 'transient-deferred-to-limit-retry', source);
    return;
  }
  watch.transientAt = now;
  watch.progressChars = 0;
  watch.seenLines = new Set(lines);
  watch.errorSignatures = new Set(
    lines.map(errorSignature).filter((signature): signature is string => signature !== null),
  );
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
function checkTransientRecovery(
  key: string,
  authority: FailoverAuthority,
  hit: LimitHit,
  attempt: number,
): void {
  const watch = watches.get(key);
  if (!watch || watch.transientAt === 0) return;
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
    await injectPrompt(authority.sessionId, TRANSIENT_CONTINUE_PROMPT);
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
  const quotaEntry = current
    ? quotaEntryFor(adapterId, current.id)
    : undefined;

  // Provider-api readings are authoritative evidence over scrollback text AND
  // observer hook frames. If a fresh provider API reading proves the account is healthy,
  // failover is suppressed.
  if (
    current &&
    providerApiRefutesLimit(quotaEntry, hit, now)
  ) {
    logSuppressedFailover(pane, current, hit, 'provider-api-healthy', source);
    return;
  }

  // A long multi-hour usage quarantine cannot be authorized without a fresh
  // matching provider-api window. Short backoff and auth recovery remain
  // available; provider errors (transient) never reach this function — they
  // are an episode of their own (handleTransientHit).
  if (
    longCooldownNeedsFreshProviderApi(hit) &&
    !hasFreshProviderApiWindowForLimit(quotaEntry, hit, now)
  ) {
    logSuppressedFailover(
      pane,
      current,
      hit,
      'provider-api-required-for-long-cooldown',
      source,
      { cooldownMs: hit.cooldownMs },
    );
    return;
  }

  // Modelo rejeitado (F-520): a CONTA está sadia — "as contas estão todas
  // operacionais". Rotacionar o MODELO do pane (id aposentado → migração;
  // senão default curado do catálogo do adapter) e religar na MESMA conta.
  // Cooldown de credencial aqui puniria conta sã e queimaria o pool inteiro.
  if (hit.kind === 'model') {
    const next = pickModelRotation(
      pane.model,
      getAdapter(adapterId)?.models.default,
    );
    emitFailover(authority, {
      paneId: pane.paneId,
      fromAccountLabel: current?.label ?? adapterId,
      toAccountLabel: current?.label ?? adapterId,
      toModel: next,
      // A orientação ("atualize a CLI…") vive SÓ no failover-toast-copy —
      // motivo aqui causa toast com a frase duplicada (donos únicos por kind).
      reason: next
        ? `modelo "${pane.model}" rejeitado (${hit.reason}) → rotacionado para "${next}"`
        : `${hit.reason} — sem modelo alternativo no catálogo`,
      kind: hit.kind,
      switched: next !== undefined,
      fromAccountId: current?.id,
      toAccountId: next ? current?.id : undefined,
      missionId: authority.missionId,
    });
    // Pane main-owned (worker headless de missão): o renderer não é dono do
    // processo — o Main respawna com a MESMA conta no modelo alternativo.
    if (!authority.owner && next && current) {
      void respawnMainOwnedPaneWithAccount({
        paneId: pane.paneId,
        sessionId: authority.sessionId,
        adapterId,
        toAccountId: current.id,
        fromAccountLabel: current.label,
        reason: hit.reason,
        toModel: next,
      }).catch((error) => {
        console.warn(
          '[failover] main-owned model respawn falhou (evento segue para o renderer):',
          error instanceof Error ? error.message : error,
        );
      });
    }
    return;
  }

  // Guarda: erro do provider é episódio próprio (handleTransientHit) e nunca
  // chega à troca de conta, nem por um caminho novo que esqueça de desviar.
  if (hit.kind === 'transient') {
    logSuppressedFailover(pane, current, hit, 'transient-provider-error', source);
    return;
  }

  // Feed fleet quota UI (session/5h/weekly bars) from the same limit signal.
  noteQuotaLimitHit(adapterId, hit, current?.id);

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
  // em conta morta e cair na irmã saudável é legítimo); a 2ª seguida dentro
  // da janela trava o failover com motivo acionável. O prepare da
  // account-store já veta conta com refresh morto; isto cobre a credencial
  // que morreu entre o prepare e o spawn. As entradas decaem pela janela, e
  // o re-login limpa a causa (blob fresco).
  if (hit.kind === 'auth') {
    const sessionAgeMs = now - (watches.get(key)?.startedAt ?? now);
    if (sessionAgeMs < INSTANT_DEATH_MS) {
      const deaths = noteInstantAuthDeath(adapterId, now);
      if (deaths >= INSTANT_DEATH_TRIP) {
        logSuppressedFailover(pane, current, hit, 'instant-auth-death-breaker', source, {
          sessionAgeMs,
          deaths,
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
  });
}

function armTrailingDetect(
  sessionId: string,
  watch: SessionWatch,
  now: number,
): void {
  if (watch.detectTimer) return;
  const delay = Math.max(0, DETECT_MIN_INTERVAL_MS - (now - watch.lastDetectAt));
  watch.detectTimer = setTimeout(() => {
    watch.detectTimer = null;
    try {
      detectPending(sessionId);
    } catch (err) {
      console.warn('[failover] trailing detection failed:', err);
    }
  }, delay);
  watch.detectTimer.unref?.();
}

/** Varredura final: o texto que chegou dentro do intervalo não fica sem checagem. */
function detectPending(sessionId: string): void {
  const now = Date.now();
  const authority = resolveAuthority(sessionId);
  if (!authority) return;
  const pane = resolvePaneDetails(authority);
  if (!pane) return;
  const [key, watch] = watchFor(authority);
  if (watch.pendingChars === 0 || now - watch.firedAt < REARM_MS) return;
  detectInWindow(authority, pane, key, watch, '', now);
}

function handleChunk(sessionId: string, data: string, now: number): void {
  const authority = resolveAuthority(sessionId);
  if (!authority) return;
  const pane = resolvePaneDetails(authority);
  if (!pane) return;

  const [key, watch] = watchFor(authority);
  const text = stripAnsi(data);
  // Debounce: don't re-fire within REARM_MS of a switch.
  if (now - watch.firedAt < REARM_MS) {
    if (watch.transientAt !== 0) noteTransientProgress(watch, text);
    return;
  }

  watch.buffer = (watch.buffer + text).slice(-WINDOW_CHARS);
  watch.pendingChars += text.length;
  if (
    watch.transientAt === 0 &&
    now - watch.lastDetectAt < DETECT_MIN_INTERVAL_MS &&
    watch.pendingChars < DETECT_MAX_PENDING_CHARS
  ) {
    armTrailingDetect(sessionId, watch, now);
    return;
  }
  detectInWindow(authority, pane, key, watch, text, now);
}

/** Varre a janela acumulada; `text` é o chunk que disparou (vazio no timer). */
function detectInWindow(
  authority: FailoverAuthority,
  pane: FailoverPaneDetails,
  key: string,
  watch: SessionWatch,
  text: string,
  now: number,
): void {
  watch.lastDetectAt = now;
  watch.pendingChars = 0;
  if (watch.detectTimer) {
    clearTimeout(watch.detectTimer);
    watch.detectTimer = null;
  }
  const hit = detectLimit(watch.buffer);
  if (hit?.kind === 'transient') {
    const detectedText = watch.buffer;
    watch.buffer = ''; // consumed
    // Sem rearm: um limite de VERDADE logo depois do 503 ainda é detectado.
    // A detecção vem ANTES do progresso: ela decide se o erro é inédito.
    handleTransientHit(authority, pane, key, watch, hit, now, 'scrollback', detectedText);
    if (watch.transientAt !== 0) noteTransientProgress(watch, text);
    return;
  }
  // Episódio de erro do provider em curso: mede se a CLI voltou a responder.
  if (watch.transientAt !== 0) noteTransientProgress(watch, text);
  if (!hit) return;

  watch.buffer = ''; // consumed
  beginLimitHandling(key, watch, now);
  handleLimitHit(authority, pane, key, hit, now, 'scrollback');
}

/**
 * Limite de verdade (cota/taxa/auth/modelo): arma o rearm, cancela a espera
 * anterior e encerra um episódio de erro do provider — a troca assume o pane.
 * Erro do provider NÃO passa por aqui: ele não pode cancelar a nova tentativa
 * já agendada para um limite real, senão o pane fica parado esperando nada.
 */
function beginLimitHandling(key: string, watch: SessionWatch, now: number): void {
  watch.firedAt = now;
  watch.buffer = '';
  cancelScheduledRetry(key);
  cancelScheduledRetry(transientKey(key));
  endTransientEpisode(watch);
}

function handleObserverFrame(frame: ObserverFrame): void {
  if (frame.kind !== 'provider_error') return;
  const authority = resolveAuthority(frame.sessionId);
  if (!authority) return;
  const pane = resolvePaneDetails(authority);
  if (!pane) return;

  const now = frame.at;
  const [key, watch] = watchFor(authority);
  if (now - watch.firedAt < REARM_MS) return;
  const hit: LimitHit = {
    kind: frame.payload.kind,
    reason: frame.payload.reason,
    cooldownMs: frame.payload.cooldownMs,
    ...(frame.payload.scope ? { scope: frame.payload.scope } : {}),
  };
  if (hit.kind === 'transient') {
    handleTransientHit(authority, pane, key, watch, hit, now, 'observer', hit.reason);
    return;
  }
  beginLimitHandling(key, watch, now);
  handleLimitHit(authority, pane, key, hit, now, 'observer');
}

export function initFailover(): void {
  if (untapData || untapObserver) return;
  untapData = tapSessionData((sessionId, data) => {
    try {
      handleChunk(sessionId, data, Date.now());
    } catch (err) {
      console.warn('[failover] tap error:', err);
    }
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

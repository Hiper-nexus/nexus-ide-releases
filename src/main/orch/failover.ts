import type { WebContents } from 'electron';
import {
  ACCOUNT_CHANNELS,
  type Account,
  type FailoverEvent,
} from '../../shared/account-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { tapSessionData, tapSessionExit, getAgentSessionInfo } from '../pty/pty-manager';
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
import {
  hasFreshProviderApiWindowForLimit,
  longCooldownNeedsFreshProviderApi,
  providerApiRefutesLimit,
} from './limit-refutation';
import type { ProviderQuotaEntry } from '../../shared/quota-types';
import {
  getAccount,
  getActiveAccount,
  isAccountBlockedForScope,
  pickAvailableForFailover,
  prepareAccountForSpawn,
  setCooldown,
} from '../persistence/account-store';
import { broadcastToProject, sameProjectScope } from './project-scoped-broadcast';
import {
  noteQuotaLimitHit,
  requireQuotaService,
} from '../quota/quota-service';
import { quotaAvailabilityScore } from '../quota/quota-policy';
import { requestMissionDriverTick } from './mission-driver-runtime';
import { handleMissionWorkerProviderNoRoute } from './provider-failure-waiver';
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
  buffer: string;
  firedAt: number;
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
  requestMissionDriverTick();
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
function performSwitch(req: SwitchRequest): void {
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

  // Pin-only prepare; never record coalesce until a target is spawnable.
  // On prepare failure, drop poisoned coalesce and try one alternate.
  let prepareError: string | undefined;
  if (next) {
    let prepared = prepareAccountForSpawn(adapterId, next.id, now, {
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
        prepared = prepareAccountForSpawn(adapterId, next.id, now);
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
    // Mission worker sem rota: a política Main-owned decide — advisory Guided
    // raiz sem consumidores recebe waiver auditável (task done + sessão física
    // exata fechada + slot liberado); qualquer outra task segue o retry
    // limitado e a sessão problemática é encerrada pela identidade exata.
    //
    // Sobre o attempt: a política é consultada em TODOS os attempts, não só no
    // hit original. Prender ao attempt 0 fazia uma auth revogada que só se
    // provava sem rota no retry (dispatch ainda não vinculado no instante do
    // hit, evidência que sumiu, política retry-required naquele momento)
    // recuperar apenas pelo caminho lento: session-exit ×3 → blocked → sweep.
    // Estender é seguro porque (a) `fireScheduledRetry` re-prova a identidade
    // exata (isCurrentAuthority + resolvePaneDetails) antes de chegar aqui,
    // então a consulta fala sempre da MESMA encarnação física; (b) os dois
    // desfechos terminais — `rerouted` e `waived` — retornam sem re-agendar,
    // encerrando a cadeia; (c) o desfecho `retry` cai na espera-pela-irmã de
    // sempre, limitada por MAX_SCHEDULED_RETRIES; e (d) o orçamento de 1
    // substituição por task é durável (a diretiva carimbada pelo guard), então
    // re-consultar não vira reroute duplo nem waiver antecipado.
    if (authority.missionId && authority.workerIncarnationId) {
      const outcome = handleMissionWorkerProviderNoRoute({
        scope: authority.scope,
        missionId: authority.missionId,
        paneId,
        sessionId: authority.sessionId,
        workerIncarnationId: authority.workerIncarnationId,
        adapterId,
        hit,
      });
      if (outcome === 'rerouted') {
        // A task já pertence a outro agente do roster e a sessão morta foi
        // fechada — agendar a espera-pela-irmã aqui reagendaria um retry para
        // uma encarnação que não existe mais.
        emitFailover(authority, {
          paneId,
          fromAccountLabel: fromLabel,
          toAccountLabel: '',
          reason:
            `${hit.reason} — tarefa re-roteada para outro agente do roster`,
          kind: hit.kind,
          switched: false,
          fromAccountId,
          missionId: authority.missionId,
        });
        return;
      }
      if (outcome === 'waived') {
        // Emitido mesmo em retry agendado: a regra de "retry falha em
        // silêncio" vale para o não-desfecho (segue esperando); um waiver é
        // fato terminal novo — a task foi dispensada — e o operador precisa
        // vê-lo no attempt em que aconteceu.
        console.info(
          '[failover]',
          JSON.stringify({
            paneId,
            adapterId,
            fromAccountId: fromAccountId ?? null,
            toAccountId: null,
            reason: hit.reason,
            switched: false,
            missionTaskWaived: true,
            attempt,
          }),
        );
        emitFailover(authority, {
          paneId,
          fromAccountLabel: fromLabel,
          toAccountLabel: '',
          reason: `${hit.reason} — advisory dispensada (provider indisponível)`,
          kind: hit.kind,
          switched: false,
          fromAccountId,
          missionId: authority.missionId,
          missionTaskWaived: true,
        });
        return;
      }
    }
    // Espera-pela-irmã (política do omp): retry automático em
    // min(fim do cooldown da própria conta, menor blockedUntil das irmãs)+1s
    // em vez de desistir ou esperar a janela multi-hora do provedor.
    const retryTarget = Math.min(
      req.ownUnblockAtMs ?? Number.POSITIVE_INFINITY,
      nextUnblockAtMs ?? Number.POSITIVE_INFINITY,
    );
    let scheduledRetryAtMs: number | undefined;
    if (Number.isFinite(retryTarget) && attempt < MAX_SCHEDULED_RETRIES) {
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
        ? `${hit.reason} (falha na conta: ${prepareError})`
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
  const pinned = pane.accountId ? getAccount(pane.accountId) : null;
  const current =
    pinned?.adapterId === adapterId ? pinned : getActiveAccount(adapterId);
  performSwitch({
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
    watch = { authority, buffer: '', firedAt: 0 };
    watches.set(key, watch);
  }
  return [key, watch];
}

function handleLimitHit(
  authority: FailoverAuthority,
  pane: NonNullable<ReturnType<typeof resolvePaneDetails>>,
  key: string,
  hit: LimitHit,
  now: number,
  source: FailoverSignalSource,
): void {
  const adapterId = pane.adapterId;
  const pinned = pane.accountId ? getAccount(pane.accountId) : null;
  const current =
    pinned?.adapterId === adapterId ? pinned : getActiveAccount(adapterId);
  const quotaEntry = current
    ? quotaEntryFor(adapterId, current.id)
    : undefined;

  // The typed hook frame is already provider-native evidence. Only the legacy
  // mixed PTY stream needs the second-layer API refutation.
  if (
    source === 'scrollback' &&
    current &&
    providerApiRefutesLimit(quotaEntry, hit, now)
  ) {
    console.info(
      '[failover]',
      JSON.stringify({
        paneId: pane.paneId,
        adapterId,
        fromAccountId: current.id,
        reason: hit.reason,
        switched: false,
        suppressed: 'provider-api-healthy',
        source,
      }),
    );
    return;
  }

  // A PTY is an untrusted mixed stream (provider output + quoted logs + agent
  // prose). It may trigger short recovery, auth rotation, or transient backoff,
  // but it cannot be the sole authority for a long usage quarantine. Typed
  // provider-hook errors have already crossed the canonical boundary and can
  // carry the provider's cooldown directly.
  if (
    source === 'scrollback' &&
    longCooldownNeedsFreshProviderApi(hit) &&
    !hasFreshProviderApiWindowForLimit(quotaEntry, hit, now)
  ) {
    console.info(
      '[failover]',
      JSON.stringify({
        paneId: pane.paneId,
        adapterId,
        fromAccountId: current?.id ?? null,
        reason: hit.reason,
        cooldownMs: hit.cooldownMs,
        switched: false,
        suppressed: 'provider-api-required-for-long-cooldown',
        source,
      }),
    );
    return;
  }

  // Feed fleet quota UI (session/5h/weekly bars) from the same limit signal.
  noteQuotaLimitHit(adapterId, hit, current?.id);

  // Put the exhausted account on cooldown, then pick the next available one.
  // Com escopo (erro cita um tier anthropic): a conta segue no pool para os
  // demais modelos; sem escopo o cooldown é global (comportamento legado).
  if (current) {
    setCooldown(current.id, now + hit.cooldownMs, hit.reason, hit.scope);
  }

  performSwitch({
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

function handleChunk(sessionId: string, data: string, now: number): void {
  const authority = resolveAuthority(sessionId);
  if (!authority) return;
  const pane = resolvePaneDetails(authority);
  if (!pane) return;

  const [key, watch] = watchFor(authority);
  // Debounce: don't re-fire within REARM_MS of a switch.
  if (now - watch.firedAt < REARM_MS) return;

  watch.buffer = (watch.buffer + stripAnsi(data)).slice(-WINDOW_CHARS);
  const hit = detectLimit(watch.buffer);
  if (!hit) return;

  watch.firedAt = now;
  watch.buffer = ''; // consumed
  cancelScheduledRetry(key);
  handleLimitHit(authority, pane, key, hit, now, 'scrollback');
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
  watch.firedAt = now;
  watch.buffer = '';
  cancelScheduledRetry(key);
  handleLimitHit(
    authority,
    pane,
    key,
    {
      kind: frame.payload.kind,
      reason: frame.payload.reason,
      cooldownMs: frame.payload.cooldownMs,
      ...(frame.payload.scope ? { scope: frame.payload.scope } : {}),
    },
    now,
    'observer',
  );
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
      if (watch.authority.sessionId === sessionId) watches.delete(key);
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

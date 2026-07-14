import type { WebContents } from 'electron';
import { ACCOUNT_CHANNELS, type FailoverEvent } from '../../shared/account-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { tapSessionData, tapSessionExit } from '../pty/pty-manager';
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
} from '../persistence/renderer-workspace-scope';
import {
  stripAnsi,
  findPaneBySessionOwnedBy,
  getOwnedPaneAuthzInfoBySession,
  type OwnedPaneAuthzInfo,
} from './pane-registry';
import { detectLimit } from './limit-detector';
import {
  getAccount,
  getActiveAccount,
  pickAvailable,
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

interface CoalesceEntry {
  toAccountId: string;
  toLabel: string;
  expiresAt: number;
}

/** adapterId\0fromAccountId → recent replacement. */
const coalesceByFrom = new Map<string, CoalesceEntry>();

interface SessionWatch {
  readonly authority: FailoverAuthority;
  buffer: string;
  firedAt: number;
}

interface FailoverAuthority {
  readonly owner: OwnedPaneAuthzInfo['owner'];
  readonly paneId: string;
  readonly sessionId: string;
  readonly missionId?: string;
  readonly scope: ProjectExecutionScope;
}

const watches = new Map<string, SessionWatch>();
const listeners = new Set<WebContents>();
const destroyHandlers = new Map<WebContents, () => void>();
const ownerKeys = new WeakMap<WebContents, number>();
let nextOwnerKey = 1;
let untapData: (() => void) | null = null;
let untapExit: (() => void) | null = null;
let unsubscribeScopeChanges: (() => void) | null = null;

function ownerKey(owner: WebContents): number {
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
  const rendererScope = pane ? getRendererWorkspaceScope(pane.owner) : null;
  if (
    !pane ||
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
    scope: Object.freeze({ ...pane.scope }),
  });
}

function isCurrentAuthority(authority: FailoverAuthority): boolean {
  const current = resolveAuthority(authority.sessionId);
  return Boolean(
    current &&
      current.owner === authority.owner &&
      current.paneId === authority.paneId &&
      current.missionId === authority.missionId &&
      sameProjectScope(current.scope, authority.scope),
  );
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
    [authority.owner],
    authority.scope,
    ACCOUNT_CHANNELS.failover,
    event,
  );
  requestMissionDriverTick();
}

function handleChunk(sessionId: string, data: string, now: number): void {
  const authority = resolveAuthority(sessionId);
  if (!authority) return;
  const pane = findPaneBySessionOwnedBy(authority.owner, sessionId);
  if (
    !pane ||
    pane.paneId !== authority.paneId ||
    pane.sessionId !== sessionId ||
    pane.kind !== 'cli-agent' ||
    !pane.adapterId
  ) {
    return;
  }

  const key = watchKey(authority);
  let watch = watches.get(key);
  if (!watch) {
    watch = { authority, buffer: '', firedAt: 0 };
    watches.set(key, watch);
  }
  // Debounce: don't re-fire within REARM_MS of a switch.
  if (now - watch.firedAt < REARM_MS) return;

  watch.buffer = (watch.buffer + stripAnsi(data)).slice(-WINDOW_CHARS);
  const hit = detectLimit(watch.buffer);
  if (!hit) return;

  watch.firedAt = now;
  watch.buffer = ''; // consumed

  const adapterId = pane.adapterId;
  const pinned = pane.accountId ? getAccount(pane.accountId) : null;
  const current =
    pinned?.adapterId === adapterId ? pinned : getActiveAccount(adapterId);
  const fromLabel = current?.label ?? adapterId;
  const fromAccountId = current?.id;

  // Feed fleet quota UI (session/5h/weekly bars) from the same limit signal.
  noteQuotaLimitHit(adapterId, hit, current?.id);

  // Put the exhausted account on cooldown, then pick the next available one.
  if (current) setCooldown(current.id, now + hit.cooldownMs, hit.reason);

  const coalesceKey = `${adapterId}\0${fromAccountId ?? '_'}`;
  let coalesced = false;
  let next = null as ReturnType<typeof pickAvailable>;
  const recent = coalesceByFrom.get(coalesceKey);
  if (recent && recent.expiresAt > now) {
    const reused = getAccount(recent.toAccountId);
    if (
      reused &&
      reused.adapterId === adapterId &&
      (!reused.cooldownUntil || reused.cooldownUntil <= now)
    ) {
      next = reused;
      coalesced = true;
    } else {
      // Stale/bad coalesce entry — drop so we re-pick.
      coalesceByFrom.delete(coalesceKey);
    }
  }

  // Prefer freer cota among eligible accounts when fleet snapshot exists.
  let quotaScores: Map<string, number> | undefined;
  try {
    const snap = requireQuotaService().lastSnapshot();
    if (snap) {
      quotaScores = new Map();
      for (const e of snap.entries) {
        if (e.adapterId === adapterId && e.accountId) {
          quotaScores.set(e.accountId, quotaAvailabilityScore(e));
        }
      }
    }
  } catch {
    /* quota service optional at boot race */
  }

  if (!next) {
    next = pickAvailable(
      adapterId,
      current?.id ?? null,
      now,
      quotaScores,
    );
  }

  // Pin-only prepare; never record coalesce until a target is spawnable.
  // On prepare failure, drop poisoned coalesce and try one alternate.
  let prepareError: string | undefined;
  if (next) {
    let prepared = prepareAccountForSpawn(adapterId, next.id, now);
    if (!prepared.ok) {
      prepareError = prepared.error;
      console.warn('[failover] next account not spawnable:', prepared.error);
      coalesceByFrom.delete(coalesceKey);
      coalesced = false;
      const failedId = next.id;
      next = pickAvailable(adapterId, failedId, now, quotaScores);
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
    console.info(
      '[failover]',
      JSON.stringify({
        paneId: pane.paneId,
        adapterId,
        fromAccountId: fromAccountId ?? null,
        toAccountId: null,
        reason: hit.reason,
        switched: false,
        prepareError: prepareError ?? null,
      }),
    );
    emitFailover(authority, {
      paneId: pane.paneId,
      fromAccountLabel: fromLabel,
      toAccountLabel: '',
      reason: prepareError
        ? `${hit.reason} (falha na conta: ${prepareError})`
        : hit.reason,
      switched: false,
      fromAccountId,
      missionId: authority.missionId,
    });
    return;
  }

  // Only after successful prepare: share this A→B decision with concurrent panes.
  if (!coalesced) {
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
      paneId: pane.paneId,
      adapterId,
      fromAccountId: fromAccountId ?? null,
      toAccountId: next.id,
      reason: hit.reason,
      switched: true,
      crossAccount,
      coalesced,
      missionId: authority.missionId ?? null,
    }),
  );

  emitFailover(authority, {
    paneId: pane.paneId,
    fromAccountLabel: fromLabel,
    toAccountLabel: next.label,
    reason: hit.reason,
    switched: true,
    toAccountId: next.id,
    fromAccountId,
    crossAccount,
    coalesced,
    missionId: authority.missionId,
  });
}

export function initFailover(): void {
  if (untapData) return;
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
  });
}

export function shutdownFailover(): void {
  untapData?.();
  untapExit?.();
  untapData = null;
  untapExit = null;
  watches.clear();
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
  if (!authority) return false;
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

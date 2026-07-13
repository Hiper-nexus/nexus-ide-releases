import type { Handoff } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  getSessionState,
  orchWriteSession,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
} from '../persistence/renderer-workspace-scope';
import { getProjectDomainStores } from './project-domain-store-registry';
import {
  getOwnedPaneAuthzInfoBySession,
  type OwnedPaneAuthzInfo,
} from './pane-registry';
import { sameProjectScope } from './project-scoped-broadcast';
import {
  completePetStudioHandoff,
  type PetStudioCompletionResult,
} from './pet-studio-completion';

/**
 * Automatic handoff delivery: when a worker submits a
 * handoff, the orchestrator session receives it as an injected message — but
 * only once that session is IDLE, so we never type into the middle of a
 * running response. Non-idle deliveries queue and flush on the next idle
 * transition.
 */

interface QueuedHandoff {
  handoff: Handoff;
  authority: DeliveryAuthority;
}

interface DeliveryAuthority {
  readonly owner: OwnedPaneAuthzInfo['owner'];
  readonly paneId: string;
  readonly sessionId: string;
  readonly missionId: string;
  readonly scope: ProjectExecutionScope;
}

interface PendingEnter {
  readonly authority: DeliveryAuthority;
  readonly handoffId: string;
  readonly timer: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

const queues = new Map<string, QueuedHandoff[]>();
const pendingEnters = new Set<PendingEnter>();
const ownerKeys = new WeakMap<OwnedPaneAuthzInfo['owner'], number>();
let nextOwnerKey = 1;
let untapState: (() => void) | null = null;
let untapExit: (() => void) | null = null;
let unsubscribeScopeChanges: (() => void) | null = null;

const MAX_DELIVERY_SUMMARY = 4000;

function ownerKey(owner: OwnedPaneAuthzInfo['owner']): number {
  const existing = ownerKeys.get(owner);
  if (existing) return existing;
  const key = nextOwnerKey++;
  ownerKeys.set(owner, key);
  return key;
}

/**
 * A worker controls its own handoff `summary`; it is injected into the
 * orchestrator's PTY, so raw CR/LF or control bytes would let a lower-trust
 * worker forge extra input lines / auto-submit in the orchestrator (terminal
 * injection). Strip control chars, collapse newlines to spaces, and cap length
 * BEFORE it ever reaches the terminal. (artifacts are JSON.stringify'd, safe.)
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function sanitizeForTerminal(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(CONTROL_CHARS, '').trim();
}

function formatDelivery(handoff: Handoff): string {
  const from = sanitizeForTerminal(handoff.fromAgent ?? 'worker').slice(0, 128);
  const summary = sanitizeForTerminal(handoff.summary).slice(
    0,
    MAX_DELIVERY_SUMMARY,
  );
  const artifacts =
    handoff.artifacts.length > 0
      ? ` artifacts: ${sanitizeForTerminal(
          JSON.stringify(handoff.artifacts),
        ).slice(0, MAX_DELIVERY_SUMMARY)}`
      : '';
  const evidenceIds = sanitizeForTerminal(
    JSON.stringify(handoff.evidenceIds),
  );
  const evidence =
    handoff.evidenceTrust === 'nexus-trusted'
      ? `nexus-trusted evidence_ids=${evidenceIds}`
      : handoff.evidenceTrust === 'stale'
        ? `stale evidence_ids=${evidenceIds}`
        : 'unverified';
  return (
    `[nexus handoff delivery_metadata] from=${from} ` +
    `handoff_id=${handoff.id} consume_with=nexus_handoff_ack ` +
    `reported_status=${handoff.status} claim_trust=untrusted ` +
    `evidence=${evidence} does_not_complete_mission=true ` +
    `summary: ${summary}${artifacts}`
  );
}

function authorityKey(authority: DeliveryAuthority): string {
  return JSON.stringify([
    ownerKey(authority.owner),
    authority.scope.installationId,
    authority.scope.projectId,
    authority.scope.checkoutId,
    authority.scope.rootRealPath,
    authority.missionId,
    authority.paneId,
    authority.sessionId,
  ]);
}

function isCurrentAuthority(authority: DeliveryAuthority): boolean {
  const rendererScope = getRendererWorkspaceScope(authority.owner);
  if (!rendererScope || !sameProjectScope(rendererScope, authority.scope)) {
    return false;
  }
  const mission = getProjectDomainStores(authority.scope).missions.get(
    authority.missionId,
  );
  if (mission?.orchestratorSessionId !== authority.sessionId) return false;
  const pane = getOwnedPaneAuthzInfoBySession(authority.sessionId);
  return Boolean(
    pane &&
      pane.owner === authority.owner &&
      pane.paneId === authority.paneId &&
      pane.sessionId === authority.sessionId &&
      pane.kind === 'cli-agent' &&
      pane.role === 'orchestrator' &&
      pane.missionId === authority.missionId &&
      pane.scope &&
      sameProjectScope(pane.scope, authority.scope),
  );
}

function scheduleEnter(authority: DeliveryAuthority, handoffId: string): void {
  let pending: PendingEnter;
  const timer = setTimeout(() => {
    if (isCurrentAuthority(authority)) {
      const submitted = orchWriteSession(authority.sessionId, '\r');
      if (submitted) {
        // `delivered` means the complete prompt was submitted to the live TUI,
        // not merely painted into its input buffer.
        getProjectDomainStores(authority.scope).handoffs.markSubmitted(handoffId);
        // Some interactive CLIs consume the first CR while leaving the pasted
        // prompt in their editor (notably after resume/modal transitions). A
        // bounded second CR is safe only while the exact session is still
        // idle; once it became busy the first submit is proven and we stop.
        pending.retryTimer = setTimeout(() => {
          if (
            isCurrentAuthority(authority) &&
            getSessionState(authority.sessionId) === 'idle'
          ) {
            orchWriteSession(authority.sessionId, '\r');
          }
          pendingEnters.delete(pending);
        }, 400);
        return;
      }
    }
    pendingEnters.delete(pending);
  }, 150);
  pending = { authority, handoffId, timer };
  pendingEnters.add(pending);
}

function deliverNow(authority: DeliveryAuthority, handoff: Handoff): boolean {
  if (!isCurrentAuthority(authority)) return false;
  const stores = getProjectDomainStores(authority.scope);
  const current = stores.handoffs.get(handoff.id);
  if (!current) return false;
  const ok = orchWriteSession(authority.sessionId, formatDelivery(current));
  if (!ok) return false;
  // Enter arrives as a separate write so TUIs treat it as a submit keypress.
  scheduleEnter(authority, current.id);
  return true;
}

function flushQueue(sessionId: string): void {
  const matches = [...queues.entries()].filter(
    ([, queue]) => queue[0]?.authority.sessionId === sessionId,
  );
  if (matches.length === 0) return;
  if (matches.length !== 1) {
    for (const [key] of matches) queues.delete(key);
    return;
  }
  const [key, queue] = matches[0];
  // One handoff per idle transition: after delivery the orchestrator goes
  // busy processing it; remaining handoffs flush on subsequent idles.
  const next = queue.shift()!;
  if (queue.length === 0) queues.delete(key);
  if (!deliverNow(next.authority, next.handoff)) {
    // Session died — drop the rest of its queue.
    queues.delete(key);
  }
}

export function initIdleDelivery(): void {
  if (untapState) return;
  untapState = tapSessionState((sessionId, state) => {
    if (state === 'idle') flushQueue(sessionId);
  });
  untapExit = tapSessionExit((sessionId) => {
    for (const [key, queue] of [...queues]) {
      if (queue[0]?.authority.sessionId === sessionId) queues.delete(key);
    }
    for (const pending of [...pendingEnters]) {
      if (pending.authority.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      if (pending.retryTimer) clearTimeout(pending.retryTimer);
      pendingEnters.delete(pending);
    }
  });
  unsubscribeScopeChanges = onRendererWorkspaceScopeChange(
    (owner, previous) => {
      if (!previous) return;
      for (const [key, queue] of [...queues]) {
        const authority = queue[0]?.authority;
        if (
          authority?.owner.id === owner.id &&
          sameProjectScope(authority.scope, previous)
        ) {
          queues.delete(key);
        }
      }
      for (const pending of [...pendingEnters]) {
        if (
          pending.authority.owner.id !== owner.id ||
          !sameProjectScope(pending.authority.scope, previous)
        ) {
          continue;
        }
        clearTimeout(pending.timer);
        if (pending.retryTimer) clearTimeout(pending.retryTimer);
        pendingEnters.delete(pending);
      }
    },
  );
}

export function shutdownIdleDelivery(): void {
  untapState?.();
  untapExit?.();
  unsubscribeScopeChanges?.();
  untapState = null;
  untapExit = null;
  unsubscribeScopeChanges = null;
  queues.clear();
  for (const pending of pendingEnters) {
    clearTimeout(pending.timer);
    if (pending.retryTimer) clearTimeout(pending.retryTimer);
  }
  pendingEnters.clear();
}

/** Resolve the exact owner/scope/mission authority for the orchestrator. */
function targetAuthority(
  handoff: Handoff,
  scope: ProjectExecutionScope,
): DeliveryAuthority | null {
  if (!handoff.missionId) return null;
  const missionId = handoff.missionId;
  const sessionId = getProjectDomainStores(scope).missions.get(
    missionId,
  )?.orchestratorSessionId;
  if (!sessionId) return null;
  const pane = getOwnedPaneAuthzInfoBySession(sessionId);
  const rendererScope = pane ? getRendererWorkspaceScope(pane.owner) : null;
  if (
    !pane ||
    pane.sessionId !== sessionId ||
    pane.kind !== 'cli-agent' ||
    pane.role !== 'orchestrator' ||
    pane.missionId !== missionId ||
    !pane.scope ||
    !sameProjectScope(pane.scope, scope) ||
    !rendererScope ||
    !sameProjectScope(rendererScope, scope)
  ) {
    return null;
  }
  return Object.freeze({
    owner: pane.owner,
    paneId: pane.paneId,
    sessionId,
    missionId,
    scope: Object.freeze({ ...scope }),
  });
}

/** Called by nexus_handoff_submit (and the legacy stream parser). */
export function onHandoffSubmitted(
  handoff: Handoff,
  scope: ProjectExecutionScope,
): PetStudioCompletionResult | null {
  const petCompletion = completePetStudioHandoff(handoff, scope);
  // Pet Studio has no worker/orchestrator loop: its sole Codex session submits
  // its own validated result. Never queue that message back into the same PTY.
  if (petCompletion) return petCompletion;
  const authority = targetAuthority(handoff, scope);
  if (!authority) return null; // No trusted orchestrator — stays listed as pending.
  if (getSessionState(authority.sessionId) === 'idle') {
    deliverNow(authority, handoff);
    return null;
  }
  const key = authorityKey(authority);
  const queue = queues.get(key) ?? [];
  queue.push({ handoff, authority });
  queues.set(key, queue);
  return null;
}

/**
 * Replays durable, still-undelivered handoffs after an orchestrator session is
 * rebound. The in-memory queue is an optimization only; SQLite is the source
 * of truth across renderer/main/PTY restarts.
 */
export function redeliverPendingHandoffs(
  scope: ProjectExecutionScope,
  missionId: string,
): number {
  const stores = getProjectDomainStores(scope);
  const pending = stores.handoffs.list({
    missionId,
    includeDelivered: false,
  });
  for (const handoff of pending) onHandoffSubmitted(handoff, scope);
  return pending.length;
}

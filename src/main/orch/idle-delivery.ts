import type { Handoff } from '../../shared/orch-types';
import {
  getSessionState,
  orchWriteSession,
  tapSessionState,
} from '../pty/pty-manager';
import { getMission } from './mission-store';
import { markDelivered } from './handoff-store';

/**
 * Automatic handoff delivery (Overclock parity): when a worker submits a
 * handoff, the orchestrator session receives it as an injected message — but
 * only once that session is IDLE, so we never type into the middle of a
 * running response. Non-idle deliveries queue and flush on the next idle
 * transition.
 */

const queues = new Map<string, Handoff[]>(); // orchestrator sessionId → queue
let tapInstalled = false;

const MAX_DELIVERY_SUMMARY = 4000;

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
      ? ` artifacts: ${sanitizeForTerminal(JSON.stringify(handoff.artifacts)).slice(0, MAX_DELIVERY_SUMMARY)}`
      : '';
  return (
    `[nexus handoff] from=${from} status=${handoff.status} ` +
    `summary: ${summary}${artifacts}`
  );
}

function deliverNow(sessionId: string, handoff: Handoff): boolean {
  const ok = orchWriteSession(sessionId, formatDelivery(handoff));
  if (!ok) return false;
  // Enter arrives as a separate write so TUIs treat it as a submit keypress.
  setTimeout(() => orchWriteSession(sessionId, '\r'), 150);
  markDelivered(handoff.id);
  return true;
}

function flushQueue(sessionId: string): void {
  const queue = queues.get(sessionId);
  if (!queue || queue.length === 0) return;
  // One handoff per idle transition: after delivery the orchestrator goes
  // busy processing it; remaining handoffs flush on subsequent idles.
  const next = queue.shift()!;
  if (queue.length === 0) queues.delete(sessionId);
  if (!deliverNow(sessionId, next)) {
    // Session died — drop the rest of its queue.
    queues.delete(sessionId);
  }
}

export function initIdleDelivery(): void {
  if (tapInstalled) return;
  tapInstalled = true;
  tapSessionState((sessionId, state) => {
    if (state === 'idle') flushQueue(sessionId);
  });
}

/** Resolve the delivery target for a handoff: its mission's orchestrator. */
function targetSession(handoff: Handoff): string | null {
  if (!handoff.missionId) return null;
  return getMission(handoff.missionId)?.orchestratorSessionId ?? null;
}

/** Called by nexus_handoff_submit (and the legacy stream parser). */
export function onHandoffSubmitted(handoff: Handoff): void {
  const sessionId = targetSession(handoff);
  if (!sessionId) return; // No orchestrator to notify — stays listed as pending.
  if (getSessionState(sessionId) === 'idle') {
    deliverNow(sessionId, handoff);
    return;
  }
  const queue = queues.get(sessionId) ?? [];
  queue.push(handoff);
  queues.set(sessionId, queue);
}

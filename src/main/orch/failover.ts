import type { WebContents } from 'electron';
import { ACCOUNT_CHANNELS, type FailoverEvent } from '../../shared/account-types';
import { tapSessionData, tapSessionExit } from '../pty/pty-manager';
import { stripAnsi, findPane } from './pane-registry';
import { detectLimit } from './limit-detector';
import {
  activateAccount,
  ensureSubscriptionActive,
  getAccount,
  getActiveAccount,
  pickAvailable,
  setCooldown,
} from '../persistence/account-store';

/**
 * Automatic account failover. Watches each pane's output for a limit signature
 * (rate-limit / quota / auth). When one fires: puts the pane's active account
 * on cooldown, switches to the next available account for that adapter, and
 * asks the renderer to re-spawn the pane's CLI with --resume so the
 * conversation continues on the fresh account. Debounced per session so one
 * error burst triggers a single switch.
 */

const WINDOW_CHARS = 4000;
const REARM_MS = 30_000;

interface SessionWatch {
  buffer: string;
  firedAt: number;
}

const watches = new Map<string, SessionWatch>();
const listeners = new Set<WebContents>();

export function registerFailoverListener(wc: WebContents): void {
  listeners.add(wc);
}
export function unregisterFailoverListener(wc: WebContents): void {
  listeners.delete(wc);
}

function emitFailover(event: FailoverEvent): void {
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(ACCOUNT_CHANNELS.failover, event);
  }
}

function handleChunk(sessionId: string, data: string, now: number): void {
  const pane = findPane(sessionId);
  if (!pane || pane.kind !== 'cli-agent' || !pane.adapterId) return;

  let watch = watches.get(sessionId);
  if (!watch) {
    watch = { buffer: '', firedAt: 0 };
    watches.set(sessionId, watch);
  }
  // Debounce: don't re-fire within REARM_MS of a switch.
  if (now - watch.firedAt < REARM_MS) return;

  watch.buffer = (watch.buffer + stripAnsi(data)).slice(-WINDOW_CHARS);
  const hit = detectLimit(watch.buffer);
  if (!hit) return;

  watch.firedAt = now;
  watch.buffer = ''; // consumed

  const adapterId = pane.adapterId;
  const current = getActiveAccount(adapterId);
  const fromLabel = current?.label ?? adapterId;

  // Put the exhausted account on cooldown, then pick the next available one.
  if (current) setCooldown(current.id, now + hit.cooldownMs, hit.reason);
  const next = pickAvailable(adapterId, current?.id ?? null, now);

  if (!next) {
    emitFailover({
      paneId: pane.paneId,
      fromAccountLabel: fromLabel,
      toAccountLabel: '',
      reason: hit.reason,
      switched: false,
    });
    return;
  }

  activateAccount(next.id);
  // Subscription accounts must swap the Claude keychain credential BEFORE the
  // renderer re-spawns the CLI (the new process reads it at startup).
  const account = getAccount(next.id);
  if (account) ensureSubscriptionActive(account);

  emitFailover({
    paneId: pane.paneId,
    fromAccountLabel: fromLabel,
    toAccountLabel: next.label,
    reason: hit.reason,
    switched: true,
  });
}

export function initFailover(): void {
  tapSessionData((sessionId, data) => {
    try {
      handleChunk(sessionId, data, Date.now());
    } catch (err) {
      console.warn('[failover] tap error:', err);
    }
  });
  tapSessionExit((sessionId) => watches.delete(sessionId));
}

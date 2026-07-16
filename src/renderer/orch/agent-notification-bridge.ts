import {
  evaluatePaneTransition,
  type PaneRuntimeHint,
} from '../../shared/agent-notification';
import { listPanes } from '../lib/split-tree';
import { useAgentNotificationStore } from '../state/agent-notification-store';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';

/**
 * Subscribes to pane session transitions and feeds the agent notification
 * inbox. Keeps session-state-store pure (no product side-effects there).
 */

const busyStartedAt = new Map<string, number>();
let lastSnapshot = new Map<string, PaneRuntimeHint>();
let unsub: (() => void) | null = null;
let stopBridge: (() => void) | null = null;

function resolveAgentLabel(paneId: string): string | null {
  try {
    const pane = listPanes(useLayoutStore.getState().root).find(
      (p) => p.id === paneId,
    );
    if (!pane || pane.kind !== 'cli-agent') return null;
    return (
      pane.agentName?.trim() ||
      pane.title?.trim() ||
      pane.adapterId?.trim() ||
      'Agente'
    );
  } catch {
    return null;
  }
}

function processTransition(
  paneId: string,
  prev: PaneRuntimeHint | undefined,
  next: PaneRuntimeHint,
  now: number,
): void {
  const evalResult = evaluatePaneTransition({
    prev,
    next,
    busyStartedAt: busyStartedAt.get(paneId),
    now,
  });

  if (evalResult.busyStartedAt === undefined) {
    busyStartedAt.delete(paneId);
  } else {
    busyStartedAt.set(paneId, evalResult.busyStartedAt);
  }

  if (!evalResult.kind) return;
  const label = resolveAgentLabel(paneId);
  if (!label) return;
  useAgentNotificationStore.getState().push({
    paneId,
    agentLabel: label,
    kind: evalResult.kind,
    createdAt: now,
  });
}

function onSessionStateChange(): void {
  const current = useSessionStateStore.getState().paneStates;
  const now = Date.now();
  const nextSnapshot = new Map<string, PaneRuntimeHint>();

  for (const [paneId, state] of current) {
    nextSnapshot.set(paneId, state);
    const prev = lastSnapshot.get(paneId);
    if (prev === state) continue;
    processTransition(paneId, prev, state, now);
  }

  // Panes removed from the map — drop busy tracking only.
  for (const paneId of lastSnapshot.keys()) {
    if (!current.has(paneId)) busyStartedAt.delete(paneId);
  }

  lastSnapshot = nextSnapshot;
}

/** Idempotent: call once from orch-bridge / app bootstrap. */
export function initAgentNotificationBridge(): () => void {
  if (stopBridge) return stopBridge;
  lastSnapshot = new Map(useSessionStateStore.getState().paneStates);
  unsub = useSessionStateStore.subscribe(onSessionStateChange);
  stopBridge = () => {
    if (!unsub && !stopBridge) return;
    unsub?.();
    unsub = null;
    stopBridge = null;
    busyStartedAt.clear();
    lastSnapshot = new Map();
  };
  return stopBridge;
}

/** Test helper — clear busy epochs without tearing down the bridge. */
export function resetAgentNotificationBridgeForTests(): void {
  busyStartedAt.clear();
  lastSnapshot = new Map();
}

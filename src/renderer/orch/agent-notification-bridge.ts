import {
  evaluatePaneTransition,
  type BusyEpoch,
  type PaneRuntimeHint,
} from '../../shared/agent-notification';
import { listPanes } from '../lib/split-tree';
import { useAgentNotificationStore } from '../state/agent-notification-store';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';

/**
 * Subscribes to pane session transitions and feeds the agent notification
 * inbox. Keeps session-state-store pure (no product side-effects there).
 *
 * Consome `displayStates` (não `paneStates`): a apresentação já segura busy→idle
 * por ~1,4s, então um gap silencioso curto no meio de um turno não vira um
 * "CONCLUÍDO" prematuro — a notificação fica alinhada ao que o chip/borda do
 * pane mostram ao operador.
 */

const busyEpochs = new Map<string, BusyEpoch>();
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
    busyEpoch: busyEpochs.get(paneId),
    now,
  });

  if (evalResult.busyEpoch === undefined) {
    busyEpochs.delete(paneId);
  } else {
    busyEpochs.set(paneId, evalResult.busyEpoch);
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
  const current = useSessionStateStore.getState().displayStates;
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
    if (!current.has(paneId)) busyEpochs.delete(paneId);
  }

  lastSnapshot = nextSnapshot;
}

/** Idempotent: call once from orch-bridge / app bootstrap. */
export function initAgentNotificationBridge(): () => void {
  if (stopBridge) return stopBridge;
  lastSnapshot = new Map(useSessionStateStore.getState().displayStates);
  const thisUnsub = useSessionStateStore.subscribe(onSessionStateChange);
  unsub = thisUnsub;
  stopBridge = () => {
    // Cada init cria seu próprio stop; um handle obsoleto (bridge já
    // reiniciado) não pode derrubar a subscription atual.
    if (unsub !== thisUnsub) return;
    thisUnsub();
    unsub = null;
    stopBridge = null;
    busyEpochs.clear();
    lastSnapshot = new Map();
  };
  return stopBridge;
}

/** Test helper — clear busy epochs without tearing down the bridge. */
export function resetAgentNotificationBridgeForTests(): void {
  busyEpochs.clear();
  lastSnapshot = new Map();
}

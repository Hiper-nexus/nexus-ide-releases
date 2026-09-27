import type { PaneRuntimeState, PaneSnapshot } from '../../shared/orch-types';

/**
 * Colisão de writers delegados (C3, 25/09): na mão do operador, helpers que só
 * leem rodam em paralelo; dois writers nunca dividem o mesmo checkout — o
 * spawn auto-isola o segundo numa worktree própria (0.76.110).
 * Panes que o operador abriu na mão não contam — isolamento entre abas é o B3.
 */
export interface DelegatedPaneFact {
  readonly paneId: string;
  readonly paneNumber?: number;
  readonly state: PaneRuntimeState;
  readonly readOnly: boolean;
  readonly checkoutId?: string;
  readonly executionRoot?: string;
  /** Aberto por agente do operador (tem operatorParentSessionId). */
  readonly delegated: boolean;
}

const INACTIVE: ReadonlySet<PaneRuntimeState> = new Set(['exited', 'parked', 'hibernated']);

export function delegatedPaneFacts(
  snapshots: readonly PaneSnapshot[],
  parentOf: (sessionId: string) => string | undefined,
): DelegatedPaneFact[] {
  return snapshots.map((snapshot) => ({
    paneId: snapshot.paneId,
    ...(snapshot.paneNumber !== undefined ? { paneNumber: snapshot.paneNumber } : {}),
    state: snapshot.state,
    readOnly: snapshot.readOnly === true,
    ...(snapshot.scope?.checkoutId ? { checkoutId: snapshot.scope.checkoutId } : {}),
    executionRoot: (snapshot.executionScope ?? snapshot.scope)?.rootRealPath,
    delegated: Boolean(snapshot.sessionId && parentOf(snapshot.sessionId)),
  }));
}

export function decideDelegatedWriterSpawn(input: {
  spawnReadOnly: boolean;
  checkoutId: string;
  executionRoot?: string;
  panes: readonly DelegatedPaneFact[];
}): { allowed: true } | { allowed: false; reason: string } {
  if (input.spawnReadOnly) return { allowed: true };
  const active = input.panes.find(
    (pane) =>
      pane.delegated &&
      !pane.readOnly &&
      pane.checkoutId === input.checkoutId &&
      (!input.executionRoot || !pane.executionRoot || pane.executionRoot === input.executionRoot) &&
      !INACTIVE.has(pane.state),
  );
  if (!active) return { allowed: true };
  const label = active.paneNumber !== undefined ? `pane ${active.paneNumber}` : active.paneId;
  return {
    allowed: false,
    reason: `writer ${label} ainda ativo — espere a entrega dele ou abra este como readOnly`,
  };
}

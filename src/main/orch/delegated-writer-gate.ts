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

/**
 * Claim síncrono de writer por checkout (0.76.110): o MCP HTTP não serializa
 * `tools/call` por sessão, então dois spawns em paralelo liam os snapshots
 * antes de qualquer pane existir e caíam no mesmo checkout. O claim é tomado
 * no MESMO bloco síncrono da decisão (mesmo padrão de pendingWorkerSpawns) e
 * conta como writer ativo até a sessão real aparecer nos snapshots.
 */
interface WriterClaim {
  readonly executionRoot: string;
  paneId?: string;
}
const writerClaims = new Set<WriterClaim>();

export function hasPendingWriterClaim(
  executionRoot: string,
  snapshots: readonly PaneSnapshot[],
): boolean {
  for (const claim of [...writerClaims]) {
    if (claim.paneId === undefined) continue;
    const pane = snapshots.find((candidate) => candidate.paneId === claim.paneId);
    // Com sessão o pane já conta pelos snapshots; sem pane, o spawn morreu.
    if (!pane || pane.sessionId || pane.state === 'exited') writerClaims.delete(claim);
  }
  return [...writerClaims].some((claim) => claim.executionRoot === executionRoot);
}

/** `settle(paneId)` passa o claim ao pane nascido; sem pane, solta na hora. */
export function claimSameCheckoutWriter(executionRoot: string): { settle: (paneId?: string) => void } {
  const claim: WriterClaim = { executionRoot };
  writerClaims.add(claim);
  let settled = false;
  return {
    settle: (paneId) => {
      if (settled) return;
      settled = true;
      if (paneId) claim.paneId = paneId;
      else writerClaims.delete(claim);
    },
  };
}

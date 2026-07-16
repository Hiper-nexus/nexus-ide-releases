/**
 * Right-drawer mutual exclusion (oh-my-pi crossover).
 *
 * Two right-hand drawers share the SAME absolute slot in App.tsx: the
 * orchestration panel (`.orch-panel`) and the oh-my-pi RPC panel (`.omp-panel`).
 * Before this coordinator both mounted at `top/right` only a z-index apart, so
 * opening one silently buried the other (the TODO documented in omp-rpc.css).
 *
 * Rather than lift both panels' open state into one store — which would rewrite
 * their well-tested per-store semantics — each drawer keeps its own `panelOpen`
 * and routes its OPEN transition through here to close every OTHER registered
 * drawer. The invariant: at most one right drawer is open at a time.
 *
 * Registration (instead of importing the stores here) keeps this module free of
 * any import cycle: the drawer stores depend on this file, never the reverse.
 */

export type RightDrawerId = 'orch' | 'omp';

type CloseFn = () => void;

const closers = new Map<RightDrawerId, CloseFn>();

/**
 * Register a drawer's close action. Idempotent — a store registers once at
 * module load; re-registering just refreshes the callback.
 */
export function registerRightDrawer(id: RightDrawerId, close: CloseFn): void {
  closers.set(id, close);
}

/**
 * Claim the right slot for `id`, closing every other registered drawer. Call
 * this from a drawer's OPEN transition ONLY — never from its close path, which
 * would recurse. Closing an already-shut drawer is a no-op, so a redundant
 * claim is harmless.
 */
export function claimRightDrawer(id: RightDrawerId): void {
  for (const [other, close] of closers) {
    if (other !== id) close();
  }
}

/** Test seam: drop every registration. */
export function resetRightDrawerRegistry(): void {
  closers.clear();
}

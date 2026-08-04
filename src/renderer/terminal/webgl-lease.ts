/**
 * WebGL context lease pool for terminal renderers.
 *
 * Chromium caps live WebGL contexts per page (~8-16) and fires contextlost on
 * the oldest context when the cap is exceeded. The previous scheme granted a
 * context to the first N terminals forever, so in a large squad every later
 * pane was stuck on the slow DOM renderer — even while holding focus.
 *
 * Leases are granted by focus recency instead: opening a terminal takes a free
 * slot when one exists, and focusing a DOM-rendered terminal steals the slot
 * of the least-recently-focused holder (which falls back to the DOM renderer
 * until it is focused again). Whatever the user is interacting with renders on
 * WebGL; the slow path is reserved for the panes untouched the longest.
 */

export interface WebglLeaseEntry {
  /** Create + load a fresh addon. Returns false when the context didn't take. */
  activate(): boolean;
  /** Dispose the live addon; the terminal falls back to the DOM renderer. */
  deactivate(): void;
}

interface LeaseState {
  entry: WebglLeaseEntry;
  active: boolean;
  touchedAt: number;
}

export class WebglLeasePool {
  private readonly leases = new Map<string, LeaseState>();
  private activeCount = 0;

  constructor(
    private readonly max: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Register a terminal; grants a lease immediately when a slot is free. */
  register(id: string, entry: WebglLeaseEntry): void {
    const state: LeaseState = { entry, active: false, touchedAt: this.now() };
    this.leases.set(id, state);
    if (this.activeCount < this.max) this.tryActivate(state);
  }

  /**
   * Focus signal: refresh recency and (re)acquire a lease, stealing from the
   * least-recently-focused holder when the pool is full.
   */
  touch(id: string): void {
    const state = this.leases.get(id);
    if (!state) return;
    state.touchedAt = this.now();
    if (state.active) return;
    if (this.activeCount >= this.max) this.evictLeastRecent(id);
    if (this.activeCount < this.max) this.tryActivate(state);
  }

  /** The holder's context was lost externally (addon disposed by the caller). */
  notifyLost(id: string): void {
    const state = this.leases.get(id);
    if (!state?.active) return;
    state.active = false;
    this.activeCount -= 1;
  }

  /** Park one renderer without forgetting its lease entry. */
  suspend(id: string): void {
    const state = this.leases.get(id);
    if (!state?.active) return;
    state.active = false;
    this.activeCount -= 1;
    state.entry.deactivate();
  }

  /** Remove a terminal, releasing its lease. */
  unregister(id: string): void {
    const state = this.leases.get(id);
    if (!state) return;
    if (state.active) this.suspend(id);
    this.leases.delete(id);
  }

  isActive(id: string): boolean {
    return this.leases.get(id)?.active ?? false;
  }

  get activeLeases(): number {
    return this.activeCount;
  }

  private tryActivate(state: LeaseState): void {
    if (state.entry.activate()) {
      state.active = true;
      this.activeCount += 1;
    }
  }

  private evictLeastRecent(exceptId: string): void {
    let victim: LeaseState | null = null;
    for (const [id, state] of this.leases) {
      if (id === exceptId || !state.active) continue;
      if (!victim || state.touchedAt < victim.touchedAt) victim = state;
    }
    if (!victim) return;
    victim.active = false;
    this.activeCount -= 1;
    victim.entry.deactivate();
  }
}

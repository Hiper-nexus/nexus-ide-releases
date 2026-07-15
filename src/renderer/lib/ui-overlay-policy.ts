/**
 * Overlay / dismiss policy for Nexus surfaces.
 *
 * Problem this encodes (production bug class):
 *   User is mid-form (mission objective, voice keys, diff notes, agent pick)
 *   → clicks Jarvis / chrome under a dimmed overlay → surface closes → draft gone.
 *
 * Rules:
 * 1. SOFT dismiss (overlay click, Escape, "Fechar", Jarvis revealing a pane)
 *    only hides UI. Never wipe user-authored drafts.
 * 2. HARD discard (explicit "Cancelar", successful submit/launch) clears drafts.
 * 3. App chrome (workspace bar + Jarvis HUD) stays above SOFT dimmers so voice
 *    and primary actions remain clickable without hitting the backdrop.
 * 4. HARD modals (confirm, update, destructive) still cover chrome.
 *
 * Z-index ladder (also mirrored as CSS vars in base.css):
 *   content < soft-overlay < soft-panel < app-chrome < hard-modal < voice-hud
 */

export const UI_Z = {
  softOverlay: 45,
  softPanel: 46,
  appChrome: 55,
  hardModal: 1000,
  confirm: 1300,
  voiceHud: 1200,
} as const;

/** Surfaces that must soft-close when Jarvis needs the panes visible. */
export const BLOCKING_SOFT_SURFACES = [
  'mission-wizard',
  'settings-drawer',
  'voice-settings',
  'ops-board',
  'home-deck',
  'operator-profile',
] as const;

export type BlockingSoftSurface = (typeof BLOCKING_SOFT_SURFACES)[number];

/**
 * True when a form draft has user-authored content worth restoring after
 * soft-close. Empty strings / default modes do not count.
 */
export function hasAuthoredText(
  ...parts: Array<string | null | undefined>
): boolean {
  return parts.some((p) => (p ?? '').trim().length > 0);
}

export function hasAuthoredList(list: readonly unknown[] | null | undefined): boolean {
  return Array.isArray(list) && list.length > 0;
}

export interface DraftHydrationBarrier {
  markHydrating(): void;
  shouldSkipPersist(): boolean;
}

/**
 * React runs hydration and persistence effects from the same render with the
 * same stale closure. Consume one save after hydration so restored data cannot
 * be overwritten before the local state update is committed.
 */
export function createDraftHydrationBarrier(): DraftHydrationBarrier {
  let hasPendingHydration = false;
  let hydrationVersion = 0;
  return {
    markHydrating: () => {
      const markedVersion = ++hydrationVersion;
      hasPendingHydration = true;
      // Fallback clear if no persist effect runs in this tick (e.g. early return).
      queueMicrotask(() => {
        if (hydrationVersion === markedVersion) hasPendingHydration = false;
      });
    },
    shouldSkipPersist: () => {
      if (!hasPendingHydration) return false;
      hasPendingHydration = false;
      hydrationVersion += 1;
      return true;
    },
  };
}

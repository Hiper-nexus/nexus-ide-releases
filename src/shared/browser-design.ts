/**
 * Dependency-free contract for the browser pane "design mode" (VISUAL-EDIT-001):
 * the isolated preload pushes selection/mode events to the main process over a
 * closed channel. Remote pages never receive this surface. Unlike the
 * request/response automation channel, this one is page→main PUSH — a click on
 * the picker has no pending request to correlate with.
 */

export const BROWSER_DESIGN_CHANNELS = {
  event: 'browser:design-event',
} as const;

export type BrowserDesignEventType = 'selection' | 'mode' | 'reorder';

/**
 * Drag-reorder intent (F3): computed geometrically in the page (stub) and
 * executed deterministically by the main process when write-back is active.
 * Ids are the ephemeral `data-nexus-id` attributes (L3 instrumentation).
 */
export interface BrowserDesignReorderIntent {
  nexusId: string;
  parentNexusId: string;
  fromIndex: number;
  toIndex: number;
}

export interface BrowserDesignRect {
  /** CSS pixels in the page's viewport coordinate space (multi-DPI safe). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserDesignFramework =
  | 'react'
  | 'vue'
  | 'svelte'
  | 'angular'
  | 'unknown';

export interface BrowserDesignSourceHint {
  /** Path as reported by the framework's dev metadata — advisory, untrusted. */
  file: string;
  line?: number;
  column?: number;
}

/**
 * L1 context: framework internals read from the page's MAIN world (dev builds
 * only — production pages degrade to L0). Best-effort by design: React 19
 * killed `_debugSource`, so component/owner names are the stable signal and
 * file:line only exists where the framework still emits it (Svelte, Vue file).
 */
export interface BrowserDesignFrameworkHints {
  framework: BrowserDesignFramework;
  componentName?: string;
  /** Component owner chain, nearest first (React fiber walk / Svelte dev stack). */
  ownerChain: string[];
  /** Prop NAMES only — values never cross the bridge (secret hygiene). */
  propKeys?: string[];
  source?: BrowserDesignSourceHint;
}

/**
 * L0 element context: everything the picker can extract without framework
 * internals or source mapping. `ref` uses the SAME opaque scheme as the
 * automation commands (`e<N>`), so a selection can later be driven by
 * click/fill/inspect without re-resolution.
 */
export interface BrowserDesignElementContext {
  ref: string;
  tag: string;
  id?: string;
  classes: string[];
  /** Best-effort unique CSS selector (id > path); advisory, not stable. */
  selector: string;
  rect: BrowserDesignRect;
  /** Visible text, redacted and truncated. */
  text: string;
  /** Sanitized outerHTML (redacted, truncated, no inline event handlers). */
  outerHtml: string;
  /** Filtered attribute map (no on* handlers, no oversized values). */
  attributes: Record<string, string>;
  /** Curated computed-style subset relevant for design edits. */
  computedStyles: Record<string, string>;
  /** Page URL with credentials/tokens redacted. */
  url: string;
  /** L1 framework internals (dev pages only); absent when unavailable. */
  frameworkHints?: BrowserDesignFrameworkHints;
  /** Shift+click (F4): add to / toggle within the current selection set. */
  additive?: boolean;
}

export interface BrowserDesignModeState {
  active: boolean;
  reason: 'enable' | 'disable' | 'navigation';
}

export interface BrowserDesignEvent {
  eventId: string;
  /** Main-issued nonce for one enable→disable design-mode generation. */
  generation: string;
  type: BrowserDesignEventType;
  /** Epoch ms at emission time (preload clock). */
  at: number;
  selection?: BrowserDesignElementContext;
  mode?: BrowserDesignModeState;
  reorder?: BrowserDesignReorderIntent;
}

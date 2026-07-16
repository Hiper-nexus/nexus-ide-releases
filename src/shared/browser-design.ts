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
 * Compact ancestor summary (L0 structural context): helps the agent locate the
 * element's place in the page hierarchy without serializing large HTML trees.
 * Mirrors Orca's Grab Mode `ancestorPath`/`nearbyElements` intent, adapted to
 * this project's redaction. Generated/hashed classes are filtered out.
 */
export interface BrowserDesignAncestor {
  tag: string;
  id?: string;
  classes: string[];
  role?: string;
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
  /**
   * Page-relative rect (viewport rect + scroll offsets at selection time).
   * Lets annotation markers follow the page as it scrolls. Absent on payloads
   * produced before this field existed — consumers must degrade gracefully.
   */
  rectPage?: BrowserDesignRect;
  /** True when the element (or an ancestor) is position:fixed/sticky —
   * markers for it track the viewport instead of the page. */
  isFixed?: boolean;
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
  /** Nearest ancestors (parent up to <body>), summarized — structural context. */
  ancestors?: BrowserDesignAncestor[];
  /** Short labels of sibling elements (`tag.cls "text"`) — horizontal context. */
  siblingLabels?: string[];
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

// ---------------------------------------------------------------------------
// Design annotations (Orca Design Mode parity): the user pins numbered notes
// on page elements — comment + intent — and later ships ALL of them to an
// agent as one consolidated "design feedback" prompt. The annotation store is
// MAIN-owned (design-session): the renderer only contributes the typed note;
// the element context is the already-validated selection snapshot.
// Model adapted from stablyai/orca (MIT — see third_party/provenance/
// orca-5e1009.json): BrowserPageAnnotation / annotation intents.
// ---------------------------------------------------------------------------

export type BrowserDesignAnnotationIntent =
  | 'fix'
  | 'change'
  | 'question'
  | 'approve';

export type BrowserDesignAnnotationPriority =
  | 'blocking'
  | 'important'
  | 'suggestion';

export const DESIGN_ANNOTATION_LIMITS = {
  /** Hard cap of live annotations per browser pane (Orca: 20/page). */
  maxPerPane: 20,
  commentMaxChars: 2_000,
  labelMaxChars: 160,
} as const;

/** Full annotation record (main-owned; selection is a frozen snapshot). */
export interface BrowserDesignAnnotation {
  id: string;
  comment: string;
  intent: BrowserDesignAnnotationIntent;
  priority: BrowserDesignAnnotationPriority;
  /** Epoch ms (main clock). */
  createdAt: number;
  /** Short human label derived from the selection (`tag#id.cls "text"`). */
  label: string;
  selection: BrowserDesignElementContext;
}

/** Renderer-facing projection: everything the tray needs, nothing heavy. */
export interface BrowserDesignAnnotationSummary {
  id: string;
  /** 1-based position — matches the numbered badge shown in the page. */
  index: number;
  label: string;
  comment: string;
  intent: BrowserDesignAnnotationIntent;
  priority: BrowserDesignAnnotationPriority;
  createdAt: number;
}

/**
 * In-page numbered badge for one annotation. Geometry-only by design: the
 * preload marker layer never sees comments or element data.
 */
export interface BrowserDesignAnnotationMarker {
  id: string;
  /** 0-based; the badge renders index+1. */
  index: number;
  rectPage: BrowserDesignRect;
  rectViewport: BrowserDesignRect;
  isFixed: boolean;
}

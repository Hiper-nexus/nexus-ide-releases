/**
 * Dependency-free contract between the main process and the isolated preload
 * used by embedded browser panes. Remote pages never receive this surface.
 */

export const BROWSER_AUTOMATION_CHANNELS = {
  request: 'browser:automation-request',
  response: 'browser:automation-response',
  cancel: 'browser:automation-cancel',
} as const;

export type BrowserAutomationCommand =
  | 'read'
  | 'inspect'
  | 'find'
  | 'click'
  | 'fill'
  | 'wait'
  | 'scroll'
  | 'press'
  | 'hover'
  | 'extract_candidates'
  | 'layout_audit'
  | 'visual_masks'
  | 'design_enable'
  | 'design_disable'
  | 'design_set_style_preview'
  | 'design_clear_style_preview'
  | 'design_set_annotation_markers';

export interface BrowserAutomationRequest {
  requestId: string;
  command: BrowserAutomationCommand;
  args: Record<string, unknown>;
}

export interface BrowserAutomationResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BrowserElementDescriptor {
  ref: string;
  tag: string;
  role: string;
  name: string;
  href?: string;
  inputType?: string;
  disabled?: boolean;
  checked?: boolean;
  editable?: boolean;
  /** `aria-invalid="true"` — the page marked this field as failing validation. */
  invalid?: boolean;
  /** `aria-expanded` of a menu button, disclosure or combobox. */
  expanded?: boolean;
  /** `aria-selected` of a tab, option or tree item. */
  selected?: boolean;
}

/** Scroll position snapshot reported by page-side `read`/`scroll`. */
export interface BrowserViewport {
  scrollY: number;
  scrollHeight: number;
  innerHeight: number;
  /** Full viewports still below the fold, 1 decimal; 0 at the bottom. */
  pagesBelow: number;
}

export interface BrowserPageReadResult {
  url: string;
  title: string;
  readyState: string;
  language?: string;
  description?: string;
  bodyText: string;
  headings: Array<{ level: number; text: string }>;
  elements: BrowserElementDescriptor[];
  truncated: boolean;
  viewport: BrowserViewport;
  /** Visible alerts/invalid fields (≤ 10); sensitive trees excluded. */
  alerts: BrowserPageAlert[];
}

/** One `find` hit: an accessible descriptor plus its match score (0–1). */
export interface BrowserFindMatch extends BrowserElementDescriptor {
  score: number;
}

/** Jev tie-break winner among 2–5 score-tied find candidates. */
export interface BrowserFindPick {
  ref: string;
  confidence: number;
}

export interface BrowserFindResult {
  matches: BrowserFindMatch[];
  /** Candidates matching the filters before `limit` truncation. */
  total: number;
  /**
   * Present when a Jev choice broke a 2–5 way score tie at confidence ≥ 0.7.
   * Additive: `matches` stays the lexical ranking either way.
   */
  picked?: BrowserFindPick;
}

/** Post-action page snapshot captured in the main process. */
export interface BrowserAfterState {
  url: string;
  title: string;
  loading: boolean;
}

export interface BrowserChanged {
  url: boolean;
  title: boolean;
  navigated: 'none' | 'same-document' | 'new-document';
}

/** `format: 'compact'` rendering of a page read, built in the main process. */
export interface BrowserCompactPageResult {
  url: string;
  title: string;
  outline: string;
  truncated: boolean;
  viewport: BrowserViewport;
}

export type BrowserWaitCondition = 'load' | 'text' | 'ref';

/** A visible alert/error surface detected page-side during `read`. */
export interface BrowserPageAlert {
  ref?: string;
  role: string;
  text: string;
}

/** One captured failure from the main-side per-pane error ring. */
export interface BrowserErrorItem {
  /** Epoch ms. */
  at: number;
  kind: 'console' | 'http' | 'load';
  message: string;
  status?: number;
  method?: string;
  urlPath?: string;
}

/**
 * Errors observed since the previous action on the pane (or since the last
 * reset, for `read` — which reports without resetting the window).
 */
export interface BrowserErrorReport {
  consoleErrors: number;
  httpErrors: number;
  loadErrors: number;
  /** The ≤ 5 most recent items in the window. */
  items: BrowserErrorItem[];
}

/** Jev page judgment attached when a tool is called with `judge: true`. */
export interface BrowserPageJudgment {
  errorVisible: number;
  blockedByHuman: number;
  stillLoading: number;
  pageKind: { choice: string; confidence: number };
  model: string;
}

export type BrowserJudgmentSkipped =
  | 'surface-disabled'
  | 'no-credential'
  | 'judge-unavailable'
  | 'budget-exceeded';

/** Bounded candidate pool returned by the page-side `extract_candidates`. */
export interface BrowserExtractCandidates {
  /** ≤ 3 parsed `application/ld+json` documents, strings redacted. */
  jsonLd: unknown[];
  pairs: Array<{ label: string; value: string; ref?: string }>;
  tokens: Array<{
    kind: 'number' | 'date' | 'email' | 'money' | 'percent';
    text: string;
    context: string;
  }>;
}

/** Page-side responsive audit at the current (possibly emulated) viewport. */
export interface BrowserLayoutAudit {
  /** CSS layout width (`documentElement.clientWidth`). */
  layoutWidth: number;
  /** Widest of `documentElement`/`body` scrollWidth. */
  scrollWidth: number;
  /** scrollWidth > layoutWidth: the page scrolls sideways. */
  horizontalOverflow: boolean;
  /** Outermost visible elements that straddle the viewport's left/right edge. */
  overflowing: Array<
    BrowserElementDescriptor & { left: number; right: number; overflowPx: number }
  >;
  /** Visible elements whose content is cut by `overflow: hidden|clip`. */
  clipped: Array<BrowserElementDescriptor & { hiddenX: number; hiddenY: number }>;
  /** DOM walk or issue lists hit their bound. */
  truncated: boolean;
}

export interface BrowserExtractField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum';
  enum?: string[];
  hint?: string;
}

export interface BrowserExtractedField {
  value: string | number | boolean | null;
  confidence: number;
  source: 'json-ld' | 'pair' | 'token' | 'jev' | 'none';
  ref?: string;
}

export interface BrowserExtractResult {
  url: string;
  title: string;
  fields: Record<string, BrowserExtractedField>;
  jev: { calls: number; skipped?: BrowserJudgmentSkipped };
}

import type {
  BrowserAutomationCommand,
  BrowserElementDescriptor,
  BrowserExtractCandidates,
  BrowserFindMatch,
  BrowserFindResult,
  BrowserLayoutAudit,
  BrowserPageAlert,
  BrowserPageReadResult,
  BrowserViewport,
  BrowserWaitCondition,
} from '../shared/browser-automation';
import type { BrowserDesignEvent } from '../shared/browser-design';
import { collectBrowserVisualMasks } from './browser-visual-redaction';
import {
  isSensitiveBrowserMarker,
  redactBrowserText,
  redactPageUrl,
} from '../shared/browser-redaction';
import {
  createAnnotationMarkerLayer,
  parseAnnotationMarkers,
  type AnnotationMarkerLayer,
} from './browser-design-annotations';
import {
  createDesignMode,
  type DesignModeController,
} from './browser-design-mode';
import {
  introspectElementFrameworks,
  type MainWorldEvaluator,
} from './browser-framework-introspect';
import {
  createStylePreview,
  type StylePreviewController,
} from './browser-style-preview';

const DEFAULT_TEXT_CHARS = 12_000;
const MAX_TEXT_CHARS = 20_000;
const DEFAULT_ELEMENTS = 100;
const MAX_ELEMENTS = 200;
const MAX_HEADINGS = 40;
const MAX_NAME_CHARS = 320;
const MAX_DOM_NODES = 50_000;
const MAX_LIVE_REFS = 2_000;
const MAX_FILL_CHARS = 8_192;
const MAX_WAIT_MS = 15_000;
// Input types that render as buttons/checkboxes/pickers rather than free
// text — `descriptor.editable` must never be true for these.
const NON_EDITABLE_INPUT_TYPES = new Set([
  'button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'range', 'color', 'file',
]);
const MAX_SCROLL_OFFSET = 100_000;
// layout_audit reads geometry for every element: bound the walk well under
// MAX_DOM_NODES so a huge page cannot stall the capture loop.
const LAYOUT_AUDIT_MAX_NODES = 5_000;
const LAYOUT_AUDIT_MAX_ISSUES = 20;

/** Named keyboard keys accepted by `press` (KeyboardEvent.key values). */
const ALLOWED_PRESS_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ' ', 'Space', 'ContextMenu', 'CapsLock', 'NumLock', 'ScrollLock',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

const ALLOWED_PRESS_MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

// KeyboardEvent.code names describe physical keys. The automation API accepts
// printable ASCII, so punctuation uses the standard US keyboard positions.
const PRINTABLE_PRESS_CODES: Record<string, string> = Object.fromEntries(
  Object.entries({
    Digit0: '0)', Digit1: '1!', Digit2: '2@', Digit3: '3#', Digit4: '4$',
    Digit5: '5%', Digit6: '6^', Digit7: '7&', Digit8: '8*', Digit9: '9(',
    Backquote: '`~', Minus: '-_', Equal: '=+', BracketLeft: '[{',
    BracketRight: ']}', Backslash: '\\|', Semicolon: ';:', Quote: '\'"',
    Comma: ',<', Period: '.>', Slash: '/?', Space: ' ',
  }).flatMap(([code, chars]) => [...chars].map((char) => [char, code])),
);

function pressKeyCode(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  return PRINTABLE_PRESS_CODES[key] ?? key;
}

function isAllowedPressKey(key: string): boolean {
  if (ALLOWED_PRESS_KEYS.has(key)) return true;
  // Single printable ASCII character (letters, digits, punctuation) — covers
  // text input without allowing control/escape sequences.
  return key.length === 1 && /[\x20-\x7e]/.test(key);
}

function finiteClampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}
/** Open shadow roots + same-origin frames searched per read (with the document). */
const MAX_SEARCH_ROOTS = 64;
/** Elements inspected while discovering shadow hosts and frames. */
const MAX_HOST_SCAN = 20_000;
/** Coalescing window after a DOM mutation before re-checking a wait. */
const POLL_MS = 50;
/** Slow tick for changes no mutation reports (layout-only, media queries). */
const WAIT_FALLBACK_TICK_MS = 500;
/** How long input_confirm waits for the trusted event of a native input. */
const INPUT_CONFIRM_WAIT_MS = 300;
/** An armed probe nobody confirmed is dropped after this. */
const INPUT_PROBE_TTL_MS = 5_000;
const ELEMENT_REF_PATTERN = /^e[1-9]\d{0,7}$/;
const DESIGN_GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BrowserDomWindow = Window & typeof globalThis;

// The ARIA widget roles below are what component kits (Radix, shadcn, MUI,
// Headless UI) render instead of native controls: a menu opens into
// `menuitem`s, a tab strip is `tab`s, a toggle is a `switch`. Without them
// the agent could open a dropdown and then not see a single item in it.
// `tabindex="-1"` is only programmatic focus (menu/dialog containers) and is
// left out; a real widget inside one still matches by its role.
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'option',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="treeitem"]',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[contenteditable="plaintext-only"]',
].join(',');

/**
 * A native `<option>` of a collapsed dropdown is not something to click: the
 * popup is drawn by the browser, outside the DOM. Those options are reached
 * through `select`; only options of an always-open list box are elements.
 */
function isCollapsedSelectOption(element: Element): boolean {
  if (element.tagName.toLowerCase() !== 'option') return false;
  const select = element.closest('select') as HTMLSelectElement | null;
  if (!select) return true;
  return !select.multiple && (select.size ?? 0) <= 1;
}

const SKIP_TEXT_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  '[hidden]',
  '[aria-hidden="true"]',
].join(',');

// Redaction moved to shared/browser-redaction.ts so the main process applies
// the same masking to post-action `after` snapshots. Re-exported here because
// browser-design-mode.ts imports them from this module.
export { redactBrowserText, redactPageUrl };

function clampInt(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

function normalizedText(value: string): string {
  return value.replace(/[\t\r\n ]+/g, ' ').trim();
}

// Wikipedia-style infobox labels prefix repeated rows with a bullet, e.g.
// "• Presidente" / "• Vice-presidente" — stripping it lets a field
// query for "presidente" match only the exact row instead of both.
function stripLabelMarker(value: string): string {
  return value.replace(/^[•\-*·]+[\s ]*/, '');
}

/**
 * Text split on `<br>` (at any depth), one normalized entry per non-empty
 * line. Plain `.textContent` glues lines together — the pt.wikipedia
 * infobox "Capital" cell `<a>Brasília</a><br><span>15° 47' S…</span>`
 * reads as "Brasília15° 47′ S…" — while an address cell legitimately
 * spans lines. Callers keep every line and may offer the first alone.
 */
function textLines(win: BrowserDomWindow, element: Element): string[] {
  let out = '';
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === win.Node.TEXT_NODE) out += child.textContent ?? '';
      // nodeType, not instanceof: an iframe element belongs to another realm.
      else if (child.nodeType === 1) {
        if ((child as Element).tagName === 'BR') out += '\n';
        else walk(child);
      }
    }
  };
  walk(element);
  return out.split('\n').map(normalizedText).filter(Boolean);
}

function elementHasSensitiveMarker(element: Element): boolean {
  if (element.tagName.toLowerCase() === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'password') return true;
  }
  const autocomplete = element.getAttribute('autocomplete') ?? '';
  if (/password|one-time-code|cc-number|cc-csc/i.test(autocomplete)) return true;
  if (element.getAttribute('data-sensitive') === 'true') return true;
  const marker = [
    element.id,
    element.getAttribute('name'),
    element.getAttribute('class'),
    element.getAttribute('aria-label'),
    element.getAttribute('data-testid'),
  ]
    .filter(Boolean)
    .join(' ');
  return isSensitiveBrowserMarker(marker);
}

/**
 * The parent in the flattened tree: the light-DOM parent, the host of a shadow
 * root, or the `<iframe>` that holds this document. Visibility and sensitivity
 * must cross those boundaries — a password widget inside a component, or a
 * shadow tree under a `display:none` host, is still what its host says it is.
 */
function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const parent = element.parentNode;
  if (!parent) return null;
  if (parent.nodeType === 11) return (parent as ShadowRoot).host ?? null;
  if (parent.nodeType === 9) {
    try {
      return ((parent as Document).defaultView?.frameElement as Element | null) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export function isSensitiveTree(element: Element): boolean {
  let current: Element | null = element;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (elementHasSensitiveMarker(current)) return true;
    current = composedParent(current);
  }
  return false;
}

const VISIBILITY_STYLE_DEPTH = 16;

function isElementVisible(win: BrowserDomWindow, element: Element): boolean {
  if (!element.isConnected) return false;
  // A detached iframe keeps its document object but no window.
  if (!element.ownerDocument.defaultView) return false;
  let current: Element | null = element;
  let segmentStart = true;
  for (let depth = 0; current && depth < 64; depth += 1) {
    // closest() stops at a shadow or frame boundary; re-check each segment.
    if (segmentStart && current.closest(SKIP_TEXT_SELECTOR)) return false;
    if (depth < VISIBILITY_STYLE_DEPTH) {
      try {
        const styleWin = (current.ownerDocument.defaultView ?? win) as BrowserDomWindow;
        const style = styleWin.getComputedStyle(current);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse'
        ) {
          return false;
        }
      } catch {
        // Cross-browser SVG/style edge: attributes above still provide a safe floor.
      }
    }
    const next = composedParent(current);
    segmentStart = next !== null && next !== current.parentElement;
    current = next;
  }
  return true;
}

function collectVisibleText(win: BrowserDomWindow, root: Node, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  const document = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
  if (!document) return { text: '', truncated: false };
  const walker = document.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
  const chunks: string[] = [];
  let length = 0;
  let visited = 0;
  let truncated = false;

  while (walker.nextNode()) {
    visited += 1;
    if (visited > MAX_DOM_NODES) {
      truncated = true;
      break;
    }
    const textNode = walker.currentNode;
    // Text directly under a shadow root has no parent element: use the host.
    const parent =
      textNode.parentElement ??
      (textNode.parentNode?.nodeType === 11 ? (textNode.parentNode as ShadowRoot).host : null);
    if (!parent || !isElementVisible(win, parent) || isSensitiveTree(parent)) continue;
    const text = normalizedText(walker.currentNode.nodeValue ?? '');
    if (!text) continue;
    const remaining = maxChars - length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const piece = text.slice(0, remaining);
    chunks.push(piece);
    length += piece.length + 1;
    if (piece.length < text.length) {
      truncated = true;
      break;
    }
  }
  return {
    text: redactBrowserText(normalizedText(chunks.join(' '))).slice(0, maxChars),
    truncated,
  };
}

function isContentEditableHost(element: Element): boolean {
  const value = element.getAttribute('contenteditable');
  return value === 'true' || value === '' || value === 'plaintext-only';
}

function implicitRole(element: Element): string {
  const explicit = normalizedText(element.getAttribute('role') ?? '');
  if (explicit) return explicit.toLowerCase();
  const tag = element.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    return 'textbox';
  }
  if (isContentEditableHost(element)) return 'textbox';
  return tag;
}

function elementName(win: BrowserDomWindow, element: Element): string {
  const aria = element.getAttribute('aria-label');
  if (aria) return redactBrowserText(normalizedText(aria)).slice(0, MAX_NAME_CHARS);

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    // ids resolve in the element's own tree (a shadow root has its own ids).
    const scope = element.getRootNode() as Document | ShadowRoot;
    const byId = (id: string): Element | null =>
      (typeof scope.getElementById === 'function' ? scope.getElementById(id) : null) ??
      element.ownerDocument.getElementById(id);
    const text = labelledBy
      .split(/\s+/)
      .slice(0, 8)
      .map((id) => byId(id)?.textContent ?? '')
      .join(' ');
    if (normalizedText(text)) {
      return redactBrowserText(normalizedText(text)).slice(0, MAX_NAME_CHARS);
    }
  }

  const labels = (element as HTMLInputElement).labels;
  if (labels?.length) {
    const text = normalizedText(
      [...labels]
        .slice(0, 8)
        .map((label) => label.textContent ?? '')
        .join(' '),
    );
    if (text) return redactBrowserText(text).slice(0, MAX_NAME_CHARS);
  }

  const placeholder = element.getAttribute('placeholder');
  if (placeholder) {
    return redactBrowserText(normalizedText(placeholder)).slice(0, MAX_NAME_CHARS);
  }
  const alt = element.getAttribute('alt');
  if (alt) return redactBrowserText(normalizedText(alt)).slice(0, MAX_NAME_CHARS);
  const title = element.getAttribute('title');
  if (title) return redactBrowserText(normalizedText(title)).slice(0, MAX_NAME_CHARS);
  return collectVisibleText(win, element, MAX_NAME_CHARS).text;
}

function safeHref(element: Element): string | undefined {
  const raw = element.getAttribute('href');
  if (!raw) return undefined;
  try {
    const resolved = new URL(raw, element.ownerDocument.location.href);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return undefined;
    }
    return redactPageUrl(resolved.toString());
  } catch {
    return undefined;
  }
}

export interface BrowserAutomation {
  run(command: BrowserAutomationCommand, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface BrowserAutomationOptions {
  /** Push sink for design-mode events (VISUAL-EDIT-001); wired by the preload. */
  onDesignEvent?: (event: BrowserDesignEvent) => void;
  /**
   * Main-world evaluator for L1 framework introspection (VISUAL-EDIT-001,
   * Fase 1). In production this is `webFrame.executeJavaScript` — the spike
   * (Fase 0.4) proved it works under sandbox+contextIsolation. Absent in
   * plain L0 environments.
   */
  evalInMainWorld?: MainWorldEvaluator;
  /** Test-only native-event oracle; production deliberately leaves this unset. */
  isTrustedDesignEvent?: (event: Event) => boolean;
  /** Test-only oracle for the native input probe; production reads isTrusted. */
  isTrustedInputEvent?: (event: Event) => boolean;
}

export function createBrowserAutomation(
  win: BrowserDomWindow,
  options: BrowserAutomationOptions = {},
): BrowserAutomation {
  const references = new Map<string, Element>();
  const ids = new WeakMap<Element, string>();
  let sequence = 0;

  function refFor(element: Element): string {
    const existing = ids.get(element);
    if (existing) return existing;
    sequence += 1;
    const ref = `e${sequence}`;
    ids.set(element, ref);
    references.set(ref, element);
    return ref;
  }

  function pruneReferences(): void {
    for (const [ref, element] of references) {
      if (!element.isConnected) references.delete(ref);
    }
    while (references.size > MAX_LIVE_REFS) {
      const oldest = references.keys().next().value as string | undefined;
      if (!oldest) break;
      references.delete(oldest);
    }
  }

  function resolveRef(raw: unknown): Element {
    if (typeof raw !== 'string' || !ELEMENT_REF_PATTERN.test(raw)) {
      throw new Error('invalid browser element reference');
    }
    const element = references.get(raw);
    if (!element || !element.isConnected || !element.ownerDocument.defaultView) {
      references.delete(raw);
      throw new Error('browser element reference is stale; read the page again');
    }
    return element;
  }

  function viewportState(): BrowserViewport {
    const doc = win.document.documentElement;
    const scrollHeight = Math.max(
      doc?.scrollHeight ?? 0,
      win.document.body?.scrollHeight ?? 0,
    );
    const innerHeight = Math.max(0, Math.round(win.innerHeight));
    const scrollY = Math.round(win.scrollY);
    const pagesBelow =
      innerHeight > 0
        ? Math.round(
            Math.max(0, (scrollHeight - scrollY - innerHeight) / innerHeight) * 10,
          ) / 10
        : 0;
    return { scrollY, scrollHeight, innerHeight, pagesBelow };
  }

  function describe(element: Element): BrowserElementDescriptor {
    const tag = element.tagName.toLowerCase();
    const type = tag === 'input' ? (element.getAttribute('type') ?? 'text').toLowerCase() : '';
    const descriptor: BrowserElementDescriptor = {
      ref: refFor(element),
      tag,
      role: implicitRole(element),
      name: isSensitiveTree(element) ? '[sensitive field hidden]' : elementName(win, element),
    };
    const href = safeHref(element);
    if (href) descriptor.href = href;
    if (type) descriptor.inputType = type === 'password' ? 'password' : type;
    if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') {
      descriptor.disabled = true;
    }
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      descriptor.checked = (element as HTMLInputElement).checked;
    } else {
      // ARIA widgets (switch, menuitemcheckbox, custom checkbox) carry their
      // state in aria-checked instead of a native input.
      const ariaChecked = element.getAttribute('aria-checked');
      if (ariaChecked === 'true' || ariaChecked === 'false') {
        descriptor.checked = ariaChecked === 'true';
      }
    }
    if (element.getAttribute('aria-invalid') === 'true') descriptor.invalid = true;
    const ariaExpanded = element.getAttribute('aria-expanded');
    if (ariaExpanded === 'true' || ariaExpanded === 'false') {
      descriptor.expanded = ariaExpanded === 'true';
    }
    const ariaSelected = element.getAttribute('aria-selected');
    if (ariaSelected === 'true' || ariaSelected === 'false') {
      descriptor.selected = ariaSelected === 'true';
    } else if (tag === 'option') {
      descriptor.selected = (element as HTMLOptionElement).selected;
    }
    if (
      (tag === 'input' && !NON_EDITABLE_INPUT_TYPES.has(type)) ||
      tag === 'textarea' ||
      isContentEditableHost(element)
    ) {
      descriptor.editable = !isSensitiveTree(element);
    }
    return descriptor;
  }

  /**
   * Every tree the agent can act in: the document, each OPEN shadow root and
   * each visible same-origin frame (recursively). Closed shadow roots and
   * cross-origin frames stay invisible by construction. Bounded so a page of
   * thousands of components cannot stall a read.
   */
  function searchRoots(): Array<Document | ShadowRoot> {
    const roots: Array<Document | ShadowRoot> = [];
    const pending: Array<Document | ShadowRoot> = [win.document];
    let scanned = 0;
    while (pending.length > 0 && roots.length < MAX_SEARCH_ROOTS) {
      const root = pending.shift()!;
      roots.push(root);
      for (const element of root.querySelectorAll('*')) {
        scanned += 1;
        if (scanned > MAX_HOST_SCAN) return roots;
        const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (shadow) pending.push(shadow);
        if (element.tagName === 'IFRAME' || element.tagName === 'FRAME') {
          let frameDocument: Document | null = null;
          try {
            frameDocument = (element as HTMLIFrameElement).contentDocument;
          } catch {
            frameDocument = null; // cross-origin
          }
          if (frameDocument?.documentElement && isElementVisible(win, element)) {
            pending.push(frameDocument);
          }
        }
      }
    }
    return roots;
  }

  function queryAllDeep(selector: string, roots = searchRoots()): Element[] {
    return roots.flatMap((root) => [...root.querySelectorAll(selector)]);
  }

  /** Visible text of the page and of every searchable shadow root / frame. */
  function visiblePageText(maxChars: number, roots = searchRoots()): { text: string; truncated: boolean } {
    const parts: string[] = [];
    let used = 0;
    let truncated = false;
    for (const root of roots) {
      const node = root.nodeType === 9 ? (root as Document).body : root;
      if (!node) continue;
      const remaining = maxChars - used;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const piece = collectVisibleText(win, node, remaining);
      if (piece.truncated) truncated = true;
      if (!piece.text) continue;
      parts.push(piece.text);
      used += piece.text.length + 1;
    }
    return { text: parts.join(' ').slice(0, maxChars), truncated };
  }

  /** Focus inside shadow roots and same-origin frames, not just their host. */
  function deepActiveElement(): Element | null {
    let active: Element | null = win.document.activeElement;
    for (let depth = 0; active && depth < 16; depth += 1) {
      const shadowActive = (active as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot?.activeElement;
      if (shadowActive) {
        active = shadowActive;
        continue;
      }
      if (active.tagName === 'IFRAME' || active.tagName === 'FRAME') {
        let inner: Element | null = null;
        try {
          inner = (active as HTMLIFrameElement).contentDocument?.activeElement ?? null;
        } catch {
          inner = null;
        }
        if (inner && inner !== active) {
          active = inner;
          continue;
        }
      }
      break;
    }
    return active;
  }

  /** Interactive candidates in document order (fixed selector, never page input). */
  function interactiveElements(roots = searchRoots()): Element[] {
    return queryAllDeep(INTERACTIVE_SELECTOR, roots).filter(
      (element) => !isCollapsedSelectOption(element),
    );
  }

  function read(args: Record<string, unknown>): BrowserPageReadResult {
    pruneReferences();
    const maxChars = clampInt(args.maxChars, DEFAULT_TEXT_CHARS, MAX_TEXT_CHARS);
    const maxElements = clampInt(args.maxElements, DEFAULT_ELEMENTS, MAX_ELEMENTS);
    const roots = searchRoots();
    const text = visiblePageText(maxChars, roots);
    const candidates = interactiveElements(roots);
    const visible = candidates
      .filter((element) => isElementVisible(win, element))
      .slice(0, maxElements);
    const headings = queryAllDeep('h1,h2,h3,h4,h5,h6', roots)
      .filter((element) => isElementVisible(win, element) && !isSensitiveTree(element))
      .slice(0, MAX_HEADINGS)
      .map((heading) => ({
        level: Number.parseInt(heading.tagName.slice(1), 10),
        text: collectVisibleText(win, heading, MAX_NAME_CHARS).text,
      }))
      .filter((heading) => heading.text.length > 0);
    const description = win.document
      .querySelector('meta[name="description"]')
      ?.getAttribute('content');

    return {
      url: redactPageUrl(win.location.href),
      title: redactBrowserText(normalizedText(win.document.title)).slice(0, 512),
      readyState: win.document.readyState,
      ...(win.document.documentElement.lang
        ? { language: win.document.documentElement.lang.slice(0, 32) }
        : {}),
      ...(description
        ? { description: redactBrowserText(normalizedText(description)).slice(0, 1_000) }
        : {}),
      bodyText: text.text,
      headings,
      elements: visible.map(describe),
      truncated: text.truncated || candidates.length > visible.length,
      viewport: viewportState(),
      alerts: collectAlerts(roots),
    };
  }

  const MAX_ALERTS = 10;
  const MAX_ALERT_CHARS = 200;
  const ALERT_ROLE_SELECTOR =
    '[role="alert"],[role="alertdialog"],[aria-invalid="true"]';
  // Semantic error classes only — a fixed allowlist, never a page selector
  // built from outside input.
  const ALERT_CLASS_CANDIDATE_SELECTOR =
    '[class*="error"],[class*="invalid"],[class*="alert"]';
  const ALERT_CLASS_PATTERN =
    /(?:^|[\s_-])(error|errors|invalid|is-invalid|has-error|alert-danger|alert-error|form-error|field-error|error-message)(?:[\s_-]|$)/i;

  function collectAlerts(roots = searchRoots()): BrowserPageAlert[] {
    const out: BrowserPageAlert[] = [];
    const seen = new Set<Element>();
    const push = (element: Element, role: string, ref: boolean): void => {
      if (out.length >= MAX_ALERTS || seen.has(element)) return;
      if (!isElementVisible(win, element) || isSensitiveTree(element)) return;
      const isField = element.getAttribute('aria-invalid') === 'true';
      const text = (
        isField
          ? elementName(win, element)
          : collectVisibleText(win, element, MAX_ALERT_CHARS).text
      ).slice(0, MAX_ALERT_CHARS);
      if (!text) return;
      seen.add(element);
      out.push({
        ...(ref ? { ref: refFor(element) } : {}),
        role,
        text,
      });
    };
    for (const element of queryAllDeep(ALERT_ROLE_SELECTOR, roots)) {
      if (out.length >= MAX_ALERTS) break;
      push(element, implicitRole(element), true);
    }
    for (const element of queryAllDeep(ALERT_CLASS_CANDIDATE_SELECTOR, roots)) {
      if (out.length >= MAX_ALERTS) break;
      const cls = element.getAttribute('class') ?? '';
      if (!ALERT_CLASS_PATTERN.test(cls)) continue;
      push(element, 'alert', false);
    }
    return out;
  }

  /** Diacritics- and case-insensitive fold for `find` matching. */
  function fold(value: string): string {
    return normalizedText(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase();
  }

  const FIND_DEFAULT_LIMIT = 10;
  const FIND_MAX_LIMIT = 25;

  function find(args: Record<string, unknown>): BrowserFindResult {
    const rawText = typeof args.text === 'string' ? normalizedText(args.text) : '';
    if (rawText.length > 200) throw new Error('browser find text is too long');
    const query = fold(rawText);
    const role = typeof args.role === 'string' ? fold(args.role) : '';
    const limit = clampInt(args.limit, FIND_DEFAULT_LIMIT, FIND_MAX_LIMIT);
    // The query NEVER reaches a selector: candidates come from the fixed
    // INTERACTIVE_SELECTOR and are scored by accessible name / href path.
    const scored: BrowserFindMatch[] = [];
    for (const element of interactiveElements()) {
      if (!isElementVisible(win, element)) continue;
      const descriptor = describe(element);
      if (role && descriptor.role !== role) continue;
      let score = 0;
      if (!query) {
        score = 0;
      } else {
        const name = fold(descriptor.name);
        const href = descriptor.href ? fold(descriptor.href) : '';
        if (name === query) score = 1.0;
        else if (name.startsWith(query)) score = 0.9;
        else if (name.includes(query)) score = 0.75;
        else if (href.includes(query)) score = 0.5;
        if (score === 0) continue;
      }
      scored.push({ ...descriptor, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return { matches: scored.slice(0, limit), total: scored.length };
  }

  const EXTRACT_JSONLD_MAX = 3;
  const EXTRACT_JSONLD_CHARS = 8_192;
  const EXTRACT_JSONLD_SOURCE_CHARS = 200_000;
  const EXTRACT_PAIRS_MAX = 60;
  const EXTRACT_TOKENS_MAX = 40;
  const PAIR_LABEL_CHARS = 80;
  const PAIR_VALUE_CHARS = 300;
  const TOKEN_TEXT_CHARS = 60;
  const TOKEN_CONTEXT_CHARS = 80;
  const EXTRACT_MAX_CANDIDATE_NODES = 4_000;
  const LABEL_LINE_PATTERN = /^(.{2,60}?):\s+(\S.{0,299})$/;

  const LABEL_LINE_ELEMENTS = 'p,li,dd,span,div';

  /** Bounded, redacted JSON-LD subtree (never the raw script). */
  function redactJsonLd(value: unknown, depth: number): unknown {
    if (depth > 8) return undefined;
    if (typeof value === 'string') {
      return redactBrowserText(value).slice(0, 512);
    }
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      return value;
    }
    if (Array.isArray(value)) {
      return value
        .slice(0, 20)
        .map((item) => redactJsonLd(item, depth + 1))
        .filter((item) => item !== undefined);
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value).slice(0, 40)) {
        const redacted = redactJsonLd(child, depth + 1);
        if (redacted !== undefined) out[key.slice(0, 64)] = redacted;
      }
      return out;
    }
    return undefined;
  }

  /**
   * `extract_candidates`: the page proposes, never decides — bounded JSON-LD
   * docs, label→value pairs and typed text tokens. Sensitive trees and
   * credential-shaped fields are skipped before anything leaves the page.
   */
  function extractCandidates(): BrowserExtractCandidates {
    pruneReferences();
    const roots = searchRoots();
    const jsonLd: unknown[] = [];
    for (const script of win.document.querySelectorAll(
      'script[type="application/ld+json"]',
    )) {
      if (jsonLd.length >= EXTRACT_JSONLD_MAX) break;
      const raw = script.textContent ?? '';
      if (!raw.trim() || raw.length > EXTRACT_JSONLD_SOURCE_CHARS) continue;
      try {
        const redacted = redactJsonLd(JSON.parse(raw), 0);
        if (JSON.stringify(redacted).length > EXTRACT_JSONLD_CHARS) continue;
        jsonLd.push(redacted);
      } catch {
        // Malformed JSON-LD is skipped.
      }
    }

    const pairs: BrowserExtractCandidates['pairs'] = [];
    const pushPair = (
      label: string,
      value: string,
      element?: Element,
    ): void => {
      if (pairs.length >= EXTRACT_PAIRS_MAX) return;
      const l = redactBrowserText(stripLabelMarker(normalizedText(label))).slice(
        0,
        PAIR_LABEL_CHARS,
      );
      const v = redactBrowserText(normalizedText(value)).slice(0, PAIR_VALUE_CHARS);
      if (!l || !v) return;
      pairs.push({
        label: l,
        value: v,
        ...(element ? { ref: refFor(element) } : {}),
      });
    };

    let visited = 0;
    const overBudget = (): boolean =>
      pairs.length >= EXTRACT_PAIRS_MAX ||
      ++visited > EXTRACT_MAX_CANDIDATE_NODES;

    // dl: dt → next dd sibling.
    for (const dt of queryAllDeep('dt', roots)) {
      if (overBudget()) break;
      if (isSensitiveTree(dt) || !isElementVisible(win, dt)) continue;
      let dd = dt.nextElementSibling;
      while (dd && dd.tagName.toLowerCase() !== 'dd') {
        dd = dd.nextElementSibling;
      }
      if (!dd || isSensitiveTree(dd)) continue;
      const lines = textLines(win, dd);
      pushPair(dt.textContent ?? '', lines.join(' / '), dd);
      // A multi-line value is kept whole; its first line is offered as an
      // extra candidate (e.g. a place name above its coordinates).
      if (lines.length > 1) pushPair(dt.textContent ?? '', lines[0], dd);
    }

    // tables: th → td, or first cell → remaining cells.
    for (const row of queryAllDeep('tr', roots)) {
      if (overBudget()) break;
      if (isSensitiveTree(row) || !isElementVisible(win, row)) continue;
      const cells = [...row.querySelectorAll('th,td')];
      if (cells.length < 2) continue;
      const valueLines = cells.slice(1).map((cell) => textLines(win, cell));
      pushPair(
        cells[0].textContent ?? '',
        valueLines.map((lines) => lines.join(' / ')).join(' · '),
        cells[1],
      );
      if (valueLines.length === 1 && valueLines[0].length > 1) {
        pushPair(cells[0].textContent ?? '', valueLines[0][0], cells[1]);
      }
    }

    // label[for] / wrapping label → campo: só <select> (a opção escolhida é
    // conteúdo da página); valores digitados nunca saem da página — só a
    // opção escolhida de um select.
    for (const label of queryAllDeep('label', roots)) {
      if (overBudget()) break;
      if (isSensitiveTree(label) || !isElementVisible(win, label)) continue;
      const forId = label.getAttribute('for');
      const labelScope = label.getRootNode() as Document | ShadowRoot;
      const field = forId
        ? (typeof labelScope.getElementById === 'function'
            ? labelScope.getElementById(forId)
            : label.ownerDocument.getElementById(forId))
        : label.querySelector('input,textarea,select');
      if (!field || isSensitiveTree(field)) continue;
      if (field.tagName.toLowerCase() !== 'select') continue;
      const value =
        (field as HTMLSelectElement).selectedOptions?.[0]?.textContent ??
        (field as HTMLSelectElement).value ??
        '';
      if (!normalizedText(String(value))) continue;
      const labelText = normalizedText(
        (label.textContent ?? '').replace(String(value), ''),
      );
      pushPair(labelText, String(value), field);
    }

    // "Label: value" on leaf elements.
    for (const el of queryAllDeep(LABEL_LINE_ELEMENTS, roots)) {
      if (overBudget()) break;
      if (isSensitiveTree(el) || !isElementVisible(win, el)) continue;
      if (el.children.length > 0) continue;
      const match = LABEL_LINE_PATTERN.exec(
        normalizedText(el.textContent ?? ''),
      );
      if (!match) continue;
      pushPair(match[1], match[2], el);
    }

    // Typed tokens over the already-redacted visible text.
    const bodyText = visiblePageText(MAX_TEXT_CHARS, roots).text;
    const tokens: BrowserExtractCandidates['tokens'] = [];
    const seenTokens = new Set<string>();
    const collectTokens = (
      kind: BrowserExtractCandidates['tokens'][number]['kind'],
      pattern: RegExp,
    ): void => {
      if (tokens.length >= EXTRACT_TOKENS_MAX) return;
      for (const match of bodyText.matchAll(pattern)) {
        if (tokens.length >= EXTRACT_TOKENS_MAX) break;
        const text = match[0].slice(0, TOKEN_TEXT_CHARS);
        const key = `${kind}:${text}`;
        if (seenTokens.has(key)) continue;
        seenTokens.add(key);
        const index = match.index ?? 0;
        const start = Math.max(0, index - 40);
        const context = bodyText
          .slice(start, index + match[0].length + 40)
          .slice(0, TOKEN_CONTEXT_CHARS);
        tokens.push({ kind, text, context });
      }
    };
    collectTokens('email', /[\w.+-]+@[\w-]+\.[\w.-]+/g);
    collectTokens('money', /(?:R\$|US\$|\$|€|£)\s?\d[\d.,]*/g);
    collectTokens('percent', /\d[\d.,]*\s?%/g);
    collectTokens(
      'date',
      /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b|\b\d{1,2} de (?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro) de \d{4}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4}\b/gi,
    );
    // pt-BR groups thousands with a (non-breaking) space instead of a dot —
    // e.g. "213 421 037" or "8 510 417,771" — which a
    // dot/comma-only pattern never matches (each group alone is < 4 digits).
    collectTokens(
      'number',
      /\b\d{1,3}(?:[.,]\d{3})+[.,]\d+\b|\b\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?\b|\b\d+[.,]\d+\b|\b\d{4,}\b/g,
    );
    return { jsonLd, pairs, tokens };
  }

  function inspect(args: Record<string, unknown>): BrowserElementDescriptor {
    const element = resolveRef(args.ref);
    if (!isElementVisible(win, element)) throw new Error('browser element is not visible');
    return describe(element);
  }

  function clickableTarget(raw: unknown): HTMLElement {
    const element = resolveRef(raw);
    if (!isElementVisible(win, element)) throw new Error('browser element is not visible');
    if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') {
      throw new Error('browser element is disabled');
    }
    const clickable = element as HTMLElement;
    if (typeof clickable.click !== 'function') throw new Error('browser element is not clickable');
    return clickable;
  }

  /**
   * Fallback when Main cannot deliver real input (no sendInputEvent, element
   * covered, no geometry). `element.click()` alone skipped pointerdown and
   * mousedown, and component kits open menus/selects on pointerdown (Radix),
   * so the dropdown never opened. This replays the browser order: pointer
   * down/up, the mouse compatibility events (suppressed when pointerdown
   * cancels its default, as Chrome does), focus, then the activation click.
   */
  function click(args: Record<string, unknown>): { clicked: true; element: BrowserElementDescriptor } {
    const clickable = clickableTarget(args.ref);
    const elementWin = (clickable.ownerDocument.defaultView ?? win) as BrowserDomWindow;
    const rect = clickable.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
      view: elementWin,
    };
    const PointerCtor = elementWin.PointerEvent ?? elementWin.MouseEvent;
    const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    clickable.dispatchEvent(new PointerCtor('pointerover', pointer));
    clickable.dispatchEvent(new PointerCtor('pointermove', pointer));
    const pointerDownAllowed = clickable.dispatchEvent(
      new PointerCtor('pointerdown', { ...pointer, buttons: 1 }),
    );
    let focusAllowed = true;
    if (pointerDownAllowed) {
      focusAllowed = clickable.dispatchEvent(
        new elementWin.MouseEvent('mousedown', { ...base, buttons: 1, detail: 1 }),
      );
    }
    if (focusAllowed) clickable.focus?.({ preventScroll: true });
    clickable.dispatchEvent(new PointerCtor('pointerup', pointer));
    if (pointerDownAllowed) {
      clickable.dispatchEvent(new elementWin.MouseEvent('mouseup', { ...base, detail: 1 }));
    }
    if (!clickable.isConnected) {
      // The page swapped the element on pointerdown (a menu re-render): the
      // activation already happened through the down/up handlers.
      return { clicked: true, element: describe(clickable) };
    }
    clickable.click();
    return { clicked: true, element: describe(clickable) };
  }

  // Native input handshake. Main asks for a point and a probe, sends real
  // input with webContents.sendInputEvent, then asks whether a trusted event
  // reached this document; only if not does it fall back to the synthetic path.
  interface InputProbe {
    seen: boolean;
    waiters: Array<() => void>;
    dispose: () => void;
  }
  const inputProbes = new Map<string, InputProbe>();
  let inputSequence = 0;
  const isTrustedInput = (event: Event): boolean =>
    options.isTrustedInputEvent ? options.isTrustedInputEvent(event) : event.isTrusted === true;

  function armInputProbe(targetWin: Window, types: readonly string[]): string {
    inputSequence += 1;
    const token = `i${inputSequence}`;
    const probe: InputProbe = { seen: false, waiters: [], dispose: () => {} };
    const onEvent = (event: Event): void => {
      if (!isTrustedInput(event) || probe.seen) return;
      probe.seen = true;
      for (const wake of probe.waiters.splice(0)) wake();
    };
    for (const type of types) targetWin.addEventListener(type, onEvent, { capture: true });
    const expiry = win.setTimeout(() => probe.dispose(), INPUT_PROBE_TTL_MS);
    probe.dispose = () => {
      win.clearTimeout(expiry);
      for (const type of types) targetWin.removeEventListener(type, onEvent, { capture: true });
      inputProbes.delete(token);
      for (const wake of probe.waiters.splice(0)) wake();
    };
    inputProbes.set(token, probe);
    return token;
  }

  /** Offset from `element`'s own frame viewport to the top-level viewport. */
  function frameOffsetOf(element: Element): { dx: number; dy: number } | null {
    let dx = 0;
    let dy = 0;
    let frameWin: Window = (element.ownerDocument.defaultView ?? win) as Window;
    while (frameWin !== win) {
      const frame = frameWin.frameElement as HTMLElement | null;
      if (!frame) return null;
      const frameRect = frame.getBoundingClientRect();
      const parentWin = (frame.ownerDocument.defaultView ?? win) as BrowserDomWindow;
      let paddingLeft = 0;
      let paddingTop = 0;
      try {
        const style = parentWin.getComputedStyle(frame);
        paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
        paddingTop = Number.parseFloat(style.paddingTop) || 0;
      } catch {
        // No computed style: border box only.
      }
      dx += frameRect.left + frame.clientLeft + paddingLeft;
      dy += frameRect.top + frame.clientTop + paddingTop;
      frameWin = parentWin;
    }
    return { dx, dy };
  }

  /** `element_rect`: the box a cropped screenshot needs, after scrolling to it. */
  function elementRect(args: Record<string, unknown>): { x: number; y: number; width: number; height: number } {
    const element = resolveRef(args.ref);
    if (!isElementVisible(win, element)) throw new Error('browser element is not visible');
    const scroller = element as HTMLElement & {
      scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
    };
    if (typeof scroller.scrollIntoView === 'function') {
      scroller.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    }
    const rect = element.getBoundingClientRect();
    const offset = frameOffsetOf(element) ?? { dx: 0, dy: 0 };
    return { x: rect.left + offset.dx, y: rect.top + offset.dy, width: rect.width, height: rect.height };
  }

  /** Point of `element` in top-level viewport CSS px, or why there is none. */
  function nativePointFor(element: Element):
    | { x: number; y: number }
    | { reason: 'no-geometry' | 'offscreen' | 'occluded' } {
    const rect = element.getBoundingClientRect();
    if (!(rect.width >= 1 && rect.height >= 1)) return { reason: 'no-geometry' };
    const ownWin = (element.ownerDocument.defaultView ?? win) as BrowserDomWindow;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > ownWin.innerWidth || y > ownWin.innerHeight) return { reason: 'offscreen' };
    const root = element.getRootNode() as Document | ShadowRoot;
    const hitAt = (root as { elementFromPoint?: (x: number, y: number) => Element | null }).elementFromPoint;
    if (typeof hitAt === 'function') {
      const hit = hitAt.call(root, x, y);
      if (hit && hit !== element && !element.contains(hit)) return { reason: 'occluded' };
    }
    // Same-origin frames: add each frame's content-box offset up to the top.
    const offset = frameOffsetOf(element);
    if (!offset) return { reason: 'offscreen' };
    return { x: Math.round(x + offset.dx), y: Math.round(y + offset.dy) };
  }

  function inputPrepare(args: Record<string, unknown>): Record<string, unknown> {
    const kind = args.kind;
    if (kind === 'key') {
      const target = args.ref !== undefined && args.ref !== null
        ? resolveRef(args.ref)
        : (deepActiveElement() ?? win.document.body);
      if (!target) return { token: null, reason: 'no-target' };
      if (args.ref !== undefined && args.ref !== null && !isElementVisible(win, target)) {
        throw new Error('browser element is not visible');
      }
      (target as HTMLElement).focus?.({ preventScroll: true });
      const targetWin = target.ownerDocument.defaultView ?? win;
      return { token: armInputProbe(targetWin, ['keydown']) };
    }
    if (kind !== 'click' && kind !== 'hover') throw new Error('invalid browser input kind');
    const element = kind === 'click' ? clickableTarget(args.ref) : resolveRef(args.ref);
    if (kind === 'hover' && !isElementVisible(win, element)) {
      throw new Error('browser element is not visible');
    }
    const scroller = element as HTMLElement & {
      scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
    };
    if (typeof scroller.scrollIntoView === 'function') {
      scroller.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    }
    const point = nativePointFor(element);
    if ('reason' in point) return { token: null, reason: point.reason };
    const targetWin = element.ownerDocument.defaultView ?? win;
    const token = armInputProbe(
      targetWin,
      kind === 'click' ? ['pointerdown', 'mousedown'] : ['pointermove', 'mousemove', 'mouseover'],
    );
    return { token, x: point.x, y: point.y, element: describe(element) };
  }

  async function inputConfirm(args: Record<string, unknown>): Promise<{ delivered: boolean }> {
    const token = typeof args.token === 'string' ? args.token : '';
    const probe = inputProbes.get(token);
    if (!probe) return { delivered: false };
    if (!probe.seen) {
      await new Promise<void>((resolve) => {
        const timer = win.setTimeout(resolve, INPUT_CONFIRM_WAIT_MS);
        probe.waiters.push(() => {
          win.clearTimeout(timer);
          resolve();
        });
      });
    }
    const delivered = probe.seen;
    probe.dispose();
    return { delivered };
  }

  function fill(args: Record<string, unknown>): {
    filled: true;
    ref: string;
    length: number;
  } {
    const element = resolveRef(args.ref);
    const text = args.text;
    if (typeof text !== 'string' || text.length > MAX_FILL_CHARS) {
      throw new Error('browser fill text is invalid or too long');
    }
    if (!isElementVisible(win, element)) throw new Error('browser element is not visible');
    if (isSensitiveTree(element)) {
      throw new Error('refusing to fill a password, token, payment, or sensitive field');
    }
    if (
      element.hasAttribute('disabled') ||
      element.hasAttribute('readonly') ||
      element.getAttribute('aria-disabled') === 'true'
    ) {
      throw new Error('browser field is disabled or read-only');
    }

    const tag = element.tagName.toLowerCase();
    // The element's own realm: an iframe field has its own prototypes, and
    // React's value tracker only sees the native setter of that realm.
    const realm = (element.ownerDocument.defaultView ?? win) as BrowserDomWindow;
    if (tag === 'input') {
      const input = element as HTMLInputElement;
      const type = (input.type || 'text').toLowerCase();
      if (['password', 'file', 'hidden', 'checkbox', 'radio'].includes(type)) {
        throw new Error('browser input type cannot be filled as text');
      }
      const setter = Object.getOwnPropertyDescriptor(
        realm.HTMLInputElement.prototype,
        'value',
      )?.set;
      if (!setter) throw new Error('browser input setter is unavailable');
      setter.call(input, text);
    } else if (tag === 'textarea') {
      const setter = Object.getOwnPropertyDescriptor(
        realm.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (!setter) throw new Error('browser textarea setter is unavailable');
      setter.call(element, text);
    } else if (isContentEditableHost(element)) {
      element.textContent = text;
    } else {
      throw new Error('browser element is not a fillable text field');
    }

    (element as HTMLElement).focus?.({ preventScroll: true });
    element.dispatchEvent(new realm.Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new realm.Event('change', { bubbles: true, composed: true }));
    return { filled: true, ref: refFor(element), length: text.length };
  }

  const MAX_LISTED_OPTIONS = 30;

  /**
   * `select`: picks one option of a native `<select>` by visible label
   * (case/diacritics-insensitive: exact, then prefix, then substring — a tie
   * is refused with the options listed), by `value` or by `index`. Fires
   * input + change in the element's realm like a person choosing. A target
   * that is not a native select is reported so Main can open the ARIA
   * combobox/listbox and click the option instead.
   */
  function select(args: Record<string, unknown>): {
    selected: true;
    ref: string;
    option: { label: string; index: number };
  } {
    const element = resolveRef(args.ref);
    if (!isElementVisible(win, element)) throw new Error('browser element is not visible');
    if (element.tagName.toLowerCase() !== 'select') {
      throw new Error('browser element is not a native select');
    }
    if (isSensitiveTree(element)) {
      throw new Error('refusing to choose in a password, token, payment, or sensitive field');
    }
    if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') {
      throw new Error('browser select is disabled');
    }
    const selectElement = element as HTMLSelectElement;
    const options = [...selectElement.options];
    const labelOf = (option: HTMLOptionElement): string =>
      redactBrowserText(normalizedText(option.label || option.textContent || '')).slice(0, 120);
    const listed = (): string =>
      options.slice(0, MAX_LISTED_OPTIONS).map(labelOf).filter(Boolean).join(' | ');
    let index = -1;
    if (typeof args.index === 'number' && Number.isInteger(args.index)) {
      index = args.index >= 0 && args.index < options.length ? args.index : -1;
      if (index < 0) throw new Error(`browser select has no option at index ${args.index}; options: ${listed()}`);
    } else if (typeof args.value === 'string') {
      index = options.findIndex((option) => option.value === args.value);
      if (index < 0) throw new Error(`browser select has no option with that value; options: ${listed()}`);
    } else if (typeof args.option === 'string' && args.option.trim()) {
      const wanted = fold(args.option.slice(0, 200));
      const folded = options.map((option) => fold(option.label || option.textContent || ''));
      for (const matches of [
        (label: string) => label === wanted,
        (label: string) => label.startsWith(wanted),
        (label: string) => label.includes(wanted),
      ]) {
        const hits = folded.flatMap((label, position) => (matches(label) ? [position] : []));
        if (hits.length === 1) {
          index = hits[0]!;
          break;
        }
        if (hits.length > 1) {
          const names = hits.slice(0, MAX_LISTED_OPTIONS).map((position) => labelOf(options[position]!)).join(' | ');
          throw new Error(`browser select option is ambiguous: ${names}`);
        }
      }
      if (index < 0) throw new Error(`browser select has no option like that; options: ${listed()}`);
    } else {
      throw new Error('browser select needs option, value or index');
    }
    const chosen = options[index]!;
    if (chosen.disabled) throw new Error('browser select option is disabled');
    if (selectElement.multiple) chosen.selected = true;
    else selectElement.selectedIndex = index;
    const realm = (element.ownerDocument.defaultView ?? win) as BrowserDomWindow;
    selectElement.focus?.({ preventScroll: true });
    element.dispatchEvent(new realm.Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new realm.Event('change', { bubbles: true, composed: true }));
    return { selected: true, ref: refFor(element), option: { label: labelOf(chosen), index } };
  }

  function wait(args: Record<string, unknown>): Promise<{
    matched: true;
    condition: BrowserWaitCondition;
    elapsedMs: number;
  }> {
    const condition = args.condition;
    if (condition !== 'load' && condition !== 'text' && condition !== 'ref') {
      throw new Error('invalid browser wait condition');
    }
    const timeoutMs = clampInt(args.timeoutMs, 5_000, MAX_WAIT_MS);
    const startedAt = Date.now();
    const query =
      condition === 'text' && typeof args.value === 'string'
        ? normalizedText(args.value).slice(0, 256)
        : '';
    if (condition === 'text' && !query) throw new Error('browser wait text is required');
    const ref = condition === 'ref' ? String(args.ref ?? '') : '';
    if (condition === 'ref' && !ELEMENT_REF_PATTERN.test(ref)) {
      throw new Error('browser wait reference is invalid');
    }

    const matches = (): boolean => {
      if (condition === 'load') return win.document.readyState === 'complete';
      if (condition === 'text') {
        return visiblePageText(MAX_TEXT_CHARS)
          .text.toLocaleLowerCase()
          .includes(redactBrowserText(query).toLocaleLowerCase());
      }
      const element = references.get(ref);
      return Boolean(element?.isConnected && isElementVisible(win, element));
    };

    // Event-driven: a full visible-text walk every 50 ms burned CPU on big
    // pages for the whole wait. Mutations (coalesced) and readystatechange
    // trigger a check; a slow tick covers changes no mutation reports (media
    // queries, timers that only touch layout).
    return new Promise((resolve, reject) => {
      let settled = false;
      let pending: number | undefined;
      let observer: MutationObserver | undefined;
      const cleanup = (): void => {
        settled = true;
        observer?.disconnect();
        win.document.removeEventListener('readystatechange', schedule);
        win.clearTimeout(pending);
        win.clearTimeout(deadline);
        win.clearInterval(fallback);
      };
      const check = (): void => {
        pending = undefined;
        if (settled) return;
        if (matches()) {
          cleanup();
          resolve({ matched: true, condition, elapsedMs: Date.now() - startedAt });
        }
      };
      function schedule(): void {
        if (!settled && pending === undefined) pending = win.setTimeout(check, POLL_MS);
      }
      const deadline = win.setTimeout(() => {
        if (settled) return;
        check();
        if (settled) return;
        cleanup();
        reject(new Error('browser wait timed out'));
      }, timeoutMs);
      const fallback = win.setInterval(check, WAIT_FALLBACK_TICK_MS);
      if (typeof win.MutationObserver === 'function') {
        observer = new win.MutationObserver(schedule);
        // Shadow roots and frames do not report to an observer on the document.
        for (const root of searchRoots()) {
          try {
            observer.observe(root, {
              subtree: true, childList: true, characterData: true, attributes: true,
            });
          } catch {
            // A root the observer cannot attach to is still covered by the tick.
          }
        }
      }
      win.document.addEventListener('readystatechange', schedule);
      check();
    });
  }

  // Lazy: pages that never enter design mode pay zero cost. Shares refFor so
  // a picked element's ref works with inspect/click/fill afterwards.
  let designMode: DesignModeController | null = null;
  function ensureDesignMode(): DesignModeController {
    if (!designMode) {
      const evalInMainWorld = options.evalInMainWorld;
      designMode = createDesignMode(win, {
        refFor,
        emit: (event) => options.onDesignEvent?.(event),
        ...(options.isTrustedDesignEvent
          ? { isTrustedEvent: options.isTrustedDesignEvent }
          : {}),
        ...(evalInMainWorld
          ? {
              introspect: (element: Element) =>
                introspectElementFrameworks(win, element, evalInMainWorld),
            }
          : {}),
      });
    }
    return designMode;
  }

  function designGeneration(args: Record<string, unknown>): string {
    if (
      typeof args.generation !== 'string' ||
      !DESIGN_GENERATION_PATTERN.test(args.generation)
    ) {
      throw new Error('design mode requires a valid generation');
    }
    return args.generation;
  }

  // Lazy like the picker: pages that never preview styles pay zero cost.
  let stylePreview: StylePreviewController | null = null;
  function ensureStylePreview(): StylePreviewController {
    if (!stylePreview) stylePreview = createStylePreview(win);
    return stylePreview;
  }

  // Lazy annotation badge layer — independent from the picker overlay, so
  // annotation markers survive toggling design mode off.
  let annotationMarkers: AnnotationMarkerLayer | null = null;
  function ensureAnnotationMarkers(): AnnotationMarkerLayer {
    if (!annotationMarkers) {
      annotationMarkers = createAnnotationMarkerLayer(win);
    }
    return annotationMarkers;
  }

  function stylePreviewArgs(args: Record<string, unknown>): {
    selector: string;
    styles: Record<string, string>;
  } {
    if (typeof args.selector !== 'string' || !args.selector) {
      throw new Error('style preview requires a selector');
    }
    if (!args.styles || typeof args.styles !== 'object' || Array.isArray(args.styles)) {
      throw new Error('style preview requires a styles object');
    }
    return {
      selector: args.selector,
      styles: args.styles as Record<string, string>,
    };
  }

  function scrollResult(target: 'page' | 'element'): {
    scrolled: true;
    scrollX: number;
    scrollY: number;
    target: 'page' | 'element';
    atBottom: boolean;
    viewport: BrowserViewport;
  } {
    const viewport = viewportState();
    return {
      scrolled: true,
      scrollX: Math.round(win.scrollX),
      scrollY: Math.round(win.scrollY),
      target,
      atBottom: viewport.pagesBelow <= 0,
      viewport,
    };
  }

  function scroll(args: Record<string, unknown>): {
    scrolled: true;
    scrollX: number;
    scrollY: number;
    target: 'page' | 'element';
    atBottom: boolean;
    viewport: BrowserViewport;
  } {
    const behavior = args.behavior === 'smooth' ? 'smooth' : 'auto';
    if (args.ref !== undefined && args.ref !== null) {
      // Bring the element into view (centered) without scrolling the page by hand.
      const element = resolveRef(args.ref);
      if (!isElementVisible(win, element)) {
        throw new Error('browser element is not visible');
      }
      const scroller = element as HTMLElement & {
        scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
      };
      // scrollIntoView is a no-op in environments without layout (jsdom); guard
      // so the command degrades gracefully instead of throwing.
      if (typeof scroller.scrollIntoView === 'function') {
        scroller.scrollIntoView({ block: 'center', inline: 'center', behavior });
      }
      return scrollResult('element');
    }
    const dx = finiteClampInt(args.dx, -MAX_SCROLL_OFFSET, MAX_SCROLL_OFFSET, 0);
    const dy = finiteClampInt(args.dy, -MAX_SCROLL_OFFSET, MAX_SCROLL_OFFSET, 0);
    const x =
      args.x === undefined
        ? undefined
        : finiteClampInt(args.x, 0, MAX_SCROLL_OFFSET, win.scrollX);
    const y =
      args.y === undefined
        ? undefined
        : finiteClampInt(args.y, 0, MAX_SCROLL_OFFSET, win.scrollY);
    if (x !== undefined || y !== undefined) {
      win.scrollTo(x ?? win.scrollX, y ?? win.scrollY);
    } else {
      win.scrollBy(dx, dy);
    }
    return scrollResult('page');
  }

  async function press(args: Record<string, unknown>, signal?: AbortSignal): Promise<{
    pressed: true;
    key: string;
    ref?: string;
  }> {
    const key = typeof args.key === 'string' ? args.key : '';
    if (!key || key.length > 32 || !isAllowedPressKey(key)) {
      throw new Error('browser press key is invalid or not allowed');
    }
    const holdMs = args.holdMs === undefined ? 0 : args.holdMs;
    if (typeof holdMs !== 'number' || !Number.isInteger(holdMs) || holdMs < 0 || holdMs > 1_000) {
      throw new Error('browser press holdMs must be an integer from 0 to 1000');
    }
    if (signal?.aborted) throw new Error('browser press cancelled');
    const modifiers = Array.isArray(args.modifiers)
      ? (args.modifiers.filter((m): m is string => typeof m === 'string'))
      : [];
    for (const modifier of modifiers) {
      if (!ALLOWED_PRESS_MODIFIERS.has(modifier)) {
        throw new Error('invalid browser press modifier');
      }
    }
    let target: Element;
    if (args.ref !== undefined && args.ref !== null) {
      target = resolveRef(args.ref);
      if (!isElementVisible(win, target)) {
        throw new Error('browser element is not visible');
      }
    } else {
      target = deepActiveElement() ?? win.document.body;
    }
    (target as HTMLElement).focus?.({ preventScroll: true });
    // Synthesized KeyboardEvents carry isTrusted=false; this is the best a
    // non-CDP preload can do. React/Vue bind on keydown so this covers the
    // common case; sites that gate on isTrusted will not react.
    const opts = {
      key: key === 'Space' ? ' ' : key,
      code: pressKeyCode(key),
      bubbles: true,
      cancelable: true,
      composed: true,
      shiftKey: modifiers.includes('Shift'),
      ctrlKey: modifiers.includes('Control'),
      altKey: modifiers.includes('Alt'),
      metaKey: modifiers.includes('Meta'),
    };
    const documentAtStart = win.document;
    let pageHidden = false;
    let cancelHold: (() => void) | undefined;
    const onPageHide = (): void => { pageHidden = true; cancelHold?.(); };
    win.addEventListener('pagehide', onPageHide, { once: true });
    try {
      target.dispatchEvent(new win.KeyboardEvent('keydown', opts));
      if (holdMs > 0) {
        await new Promise<void>((resolve, reject) => {
          let timer: number | undefined;
          const finish = (cancelled: boolean): void => {
            if (timer !== undefined) win.clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            cancelHold = undefined;
            if (cancelled) reject(new Error('browser press cancelled'));
            else resolve();
          };
          const onAbort = (): void => finish(true);
          cancelHold = onAbort;
          signal?.addEventListener('abort', onAbort, { once: true });
          timer = win.setTimeout(() => finish(false), holdMs);
          if (signal?.aborted || pageHidden) finish(true);
        });
      }
    } finally {
      win.removeEventListener('pagehide', onPageHide);
      // Cancellation releases a held key only in the same live document.
      // Navigation must never deliver the old keyup to a replacement page.
      if (!pageHidden && win.document === documentAtStart) {
        const releaseTarget = target.isConnected ? target : documentAtStart;
        releaseTarget.dispatchEvent(new win.KeyboardEvent('keyup', opts));
      }
    }
    const result: { pressed: true; key: string; ref?: string } = {
      pressed: true,
      key,
    };
    if (args.ref !== undefined && args.ref !== null) {
      result.ref = refFor(target);
    }
    return result;
  }

  function hover(args: Record<string, unknown>): {
    hovered: true;
    element: BrowserElementDescriptor;
  } {
    const element = resolveRef(args.ref);
    if (!isElementVisible(win, element)) {
      throw new Error('browser element is not visible');
    }
    const rect = element.getBoundingClientRect();
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: cx,
      clientY: cy,
    };
    const mousePointer = { ...base, pointerType: 'mouse' as const };
    // Full pointer + mouse over/enter sequence so :hover state, tooltip
    // triggers, and JS hover handlers all fire as a browser would.
    element.dispatchEvent(new win.PointerEvent('pointermove', mousePointer));
    element.dispatchEvent(new win.MouseEvent('mousemove', base));
    element.dispatchEvent(new win.PointerEvent('pointerover', mousePointer));
    element.dispatchEvent(new win.MouseEvent('mouseover', base));
    element.dispatchEvent(
      new win.PointerEvent('pointerenter', { ...mousePointer, bubbles: false }),
    );
    element.dispatchEvent(
      new win.MouseEvent('mouseenter', { ...base, bubbles: false }),
    );
    (element as HTMLElement).focus?.({ preventScroll: true });
    return { hovered: true, element: describe(element) };
  }

  /**
   * `layout_audit`: cheap responsive check at the current viewport — sideways
   * scroll (scrollWidth > clientWidth), the outermost elements that straddle
   * the left/right edge (fully off-canvas drawers are ignored), and elements
   * whose content an `overflow: hidden|clip` box cuts off. Geometry only; no
   * values, names go through the same redacting `describe`.
   */
  async function layoutAudit(): Promise<BrowserLayoutAudit> {
    pruneReferences();
    // Dois frames: a emulação de dispositivo é reaplicada no commit da
    // navegação e o relayout pode ainda estar pendente quando o main pede a
    // auditoria logo após did-finish-load. Pane oculto não pinta frames —
    // o timer garante que a auditoria nunca fica presa esperando um rAF.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      win.requestAnimationFrame(() => win.requestAnimationFrame(finish));
      win.setTimeout(finish, 200);
    });
    const doc = win.document.documentElement;
    const body = win.document.body;
    const layoutWidth = Math.round(doc?.clientWidth || win.innerWidth || 0);
    const scrollWidth = Math.round(Math.max(doc?.scrollWidth ?? 0, body?.scrollWidth ?? 0));
    const overflowing: BrowserLayoutAudit['overflowing'] = [];
    const clipped: BrowserLayoutAudit['clipped'] = [];
    let truncated = false;
    const straddles = (element: Element | null): boolean => {
      if (!element || element === body || element === doc) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return (
        (rect.right > layoutWidth + 1 && rect.left < layoutWidth) ||
        (rect.left < -1 && rect.right > 0)
      );
    };
    const elements = body ? body.querySelectorAll('*') : [];
    if (elements.length > LAYOUT_AUDIT_MAX_NODES) truncated = true;
    for (let i = 0; i < Math.min(elements.length, LAYOUT_AUDIT_MAX_NODES); i += 1) {
      const element = elements[i];
      if (element.closest(SKIP_TEXT_SELECTOR)) continue;
      if (
        overflowing.length < LAYOUT_AUDIT_MAX_ISSUES &&
        straddles(element) &&
        !straddles(element.parentElement) &&
        isElementVisible(win, element)
      ) {
        const rect = element.getBoundingClientRect();
        overflowing.push({
          ...describe(element),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          overflowPx: Math.round(Math.max(rect.right - layoutWidth, -rect.left, 0)),
        });
      }
      const html = element as HTMLElement;
      const hiddenX = html.scrollWidth - html.clientWidth;
      const hiddenY = html.scrollHeight - html.clientHeight;
      if (clipped.length < LAYOUT_AUDIT_MAX_ISSUES && (hiddenX > 1 || hiddenY > 1)) {
        let style: CSSStyleDeclaration | null = null;
        try {
          style = win.getComputedStyle(element);
        } catch {
          style = null;
        }
        const cuts = (value: string | undefined): boolean =>
          value === 'hidden' || value === 'clip';
        const cutX = hiddenX > 1 && cuts(style?.overflowX);
        const cutY = hiddenY > 1 && cuts(style?.overflowY);
        if ((cutX || cutY) && isElementVisible(win, element)) {
          clipped.push({
            ...describe(element),
            hiddenX: cutX ? Math.round(hiddenX) : 0,
            hiddenY: cutY ? Math.round(hiddenY) : 0,
          });
        }
      }
    }
    if (overflowing.length >= LAYOUT_AUDIT_MAX_ISSUES || clipped.length >= LAYOUT_AUDIT_MAX_ISSUES) {
      truncated = true;
    }
    return {
      layoutWidth,
      scrollWidth,
      horizontalOverflow: scrollWidth > layoutWidth + 1,
      overflowing,
      clipped,
      truncated,
    };
  }

  return {
    async run(command, args, options) {
      if (command === 'read') return read(args);
      if (command === 'inspect') return inspect(args);
      if (command === 'find') return find(args);
      if (command === 'click') return click(args);
      if (command === 'input_prepare') return inputPrepare(args);
      if (command === 'input_confirm') return inputConfirm(args);
      if (command === 'element_rect') return elementRect(args);
      if (command === 'fill') return fill(args);
      if (command === 'select') return select(args);
      if (command === 'wait') return wait(args);
      if (command === 'scroll') return scroll(args);
      if (command === 'press') return press(args, options?.signal);
      if (command === 'hover') return hover(args);
      if (command === 'extract_candidates') return extractCandidates();
      if (command === 'layout_audit') return layoutAudit();
      if (command === 'visual_masks') return collectBrowserVisualMasks(win);
      if (command === 'design_enable') {
        return ensureDesignMode().enable(designGeneration(args));
      }
      if (command === 'design_disable') {
        const generation = designGeneration(args);
        return designMode ? designMode.disable(generation) : { active: false };
      }
      if (command === 'design_set_style_preview') {
        const { selector, styles } = stylePreviewArgs(args);
        return ensureStylePreview().set(selector, styles);
      }
      if (command === 'design_clear_style_preview') {
        if (!stylePreview) return { cleared: 0 };
        const selector =
          typeof args.selector === 'string' && args.selector ? args.selector : undefined;
        return stylePreview.clear(selector);
      }
      if (command === 'design_set_annotation_markers') {
        const markers = parseAnnotationMarkers(args.markers);
        // An empty set with no live layer is a no-op — do not mount anything.
        if (markers.length === 0 && !annotationMarkers) {
          return { applied: true, markers: 0 };
        }
        return ensureAnnotationMarkers().set(markers);
      }
      throw new Error('unsupported browser automation command');
    },
  };
}

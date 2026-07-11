import type {
  BrowserDesignAncestor,
  BrowserDesignElementContext,
  BrowserDesignEvent,
  BrowserDesignFrameworkHints,
} from '../shared/browser-design';
import {
  detectFlowAxis,
  dropInsertionIndex,
  insertionToReorderIndex,
  type FlowRect,
} from './browser-design-drag';
import {
  isSensitiveTree,
  redactBrowserText,
  redactPageUrl,
} from './browser-automation';

/**
 * Design-mode picker for embedded browser panes (VISUAL-EDIT-001, Fase 0).
 * Runs in the pane's ISOLATED preload world: the overlay lives in a
 * closed-shadow host with `pointer-events: none`, so the page can neither
 * style it nor receive its pointer input. Hover/click targets come from the
 * events themselves (capture phase on window) — no elementFromPoint, which
 * also keeps every coordinate in CSS pixels (multi-DPI safe on Win/Linux).
 */

type BrowserDomWindow = Window & typeof globalThis;

export const DESIGN_OVERLAY_HOST_ID = 'nexus-design-overlay-host';

const MAX_TEXT_CHARS = 512;
const MAX_OUTER_HTML_CHARS = 4_096;
const MAX_ATTRS = 24;
const MAX_ATTR_KEY_CHARS = 64;
const MAX_ATTR_VALUE_CHARS = 256;
const MAX_CLASSES = 32;
const MAX_CLASS_CHARS = 128;
const MAX_ID_CHARS = 256;
const MAX_SELECTOR_CHARS = 1_024;
const SELECTOR_MAX_DEPTH = 8;
const MAX_CONTEXT_NODES = 512;
const MAX_CONTEXT_DEPTH = 20;
const MAX_SOURCE_TEXT_SCAN_CHARS = 8_192;
// Neighborhood (structural context) budgets — ancestors + sibling labels.
const MAX_ANCESTORS = 6;
const MAX_ANCESTOR_CLASSES = 3;
const MAX_SIBLING_LABELS = 5;
const MAX_SIBLING_TEXT_CHARS = 40;
const MAX_SIBLING_LABEL_CHARS = 120;
const SENSITIVE_ATTRIBUTE_NAME =
  /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential|cookie|session)/i;
const OMIT_ATTRIBUTE_NAME = /^(?:value|srcdoc|formaction)$/i;
const OMIT_CONTENT_TAGS = new Set([
  'input',
  'textarea',
  'select',
  'option',
  'datalist',
]);
const OMIT_ENTIRE_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const SAFE_SENSITIVE_ATTRIBUTES = new Set([
  'type',
  'role',
  'disabled',
  'readonly',
  'required',
  'data-nexus-id',
]);

/** Curated, design-relevant computed-style subset (schema caps at 64). */
const DESIGN_STYLE_PROPS = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'width',
  'height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'flex-direction',
  'justify-content',
  'align-items',
  'gap',
  'grid-template-columns',
  'grid-template-rows',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'color',
  'background-color',
  'background-image',
  'border-radius',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'box-shadow',
  'opacity',
  'overflow',
  'transform',
] as const;

export interface DesignModeDeps {
  refFor(element: Element): string;
  emit(event: BrowserDesignEvent): void;
  /**
   * Production uses Event.isTrusted. Tests may inject an equivalent native-
   * event oracle because DOM emulators cannot manufacture trusted events.
   */
  isTrustedEvent?(event: Event): boolean;
  /**
   * L1 main-world introspection (best-effort). When absent or failing, the
   * selection ships as pure L0 — never blocks nor drops the event.
   */
  introspect?(element: Element): Promise<BrowserDesignFrameworkHints | undefined>;
}

export interface DesignModeController {
  enable(generation: string): { active: boolean };
  disable(generation: string, reason?: 'disable' | 'navigation'): { active: boolean };
  isActive(): boolean;
}

function makeEventId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  // Fallback v4 (schema requires uuid shape); preload always has crypto in
  // production — this covers bare test environments.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function normalizedText(value: string): string {
  return value.replace(/[\t\r\n ]+/g, ' ').trim();
}

function simpleCssIdent(value: string): boolean {
  return /^[A-Za-z_][\w-]*$/.test(value);
}

function nthOfType(element: Element): number {
  let index = 1;
  let sibling = element.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === element.tagName) index += 1;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

// ---------------------------------------------------------------------------
// Unique-selector construction — incremental strategy ported from Orca's Grab
// Mode (https://github.com/stablyai/orca, src/main/browser/grab-guest-script.ts).
// Orca is MIT-licensed; attribution is preserved per its terms. Adapted here to
// TypeScript and to this project's secret redaction. The algorithm climbs the
// ancestor chain and only adds `:nth-of-type` when the partial selector is not
// yet unique, preferring stable class names (e.g. Tailwind utility classes) over
// generated/hashed ones — producing shorter, more robust selectors than a blind
// `tag:nth-of-type(n)` path on every element.
// ---------------------------------------------------------------------------

const UNSTABLE_CLASS_PATTERN = /^css-[a-z0-9]+$/i;

function looksHashy(value: string): boolean {
  // Heuristic for framework-generated class hashes (css-modules, styled
  // components, emotion): long, alphanumeric-with-dashes, mixed case, has a
  // digit. These change between builds and would make selectors fragile.
  return /^[A-Za-z0-9_-]{12,}$/.test(value) && /\d/.test(value) && /[A-Z]/.test(value);
}

function stableClasses(element: Element, maxCount: number): string[] {
  const result: string[] = [];
  for (const cls of Array.from(element.classList)) {
    if (result.length >= maxCount) break;
    if (cls.length > MAX_CLASS_CHARS) continue;
    if (UNSTABLE_CLASS_PATTERN.test(cls) || looksHashy(cls)) continue;
    // Require an escapable CSS identifier so the emitted selector is always valid.
    if (!simpleCssIdent(cls)) continue;
    result.push(cls);
  }
  return result;
}

function isUniqueSelector(doc: Document | null, selector: string): boolean {
  if (!doc) return false;
  try {
    return doc.querySelectorAll(selector).length === 1;
  } catch {
    // Invalid selector (unescaped id/class, exotic chars) — treat as non-unique
    // so the climb continues and a safer suffix is added.
    return false;
  }
}

function selectorPartFor(element: Element, allowIds: boolean): string {
  const tag = element.tagName.toLowerCase();
  if (allowIds && element.id && simpleCssIdent(element.id)) {
    return `${tag}#${element.id}`;
  }
  const classes = stableClasses(element, 2);
  if (classes.length > 0) {
    return `${tag}${classes.map((cls) => `.${cls}`).join('')}`;
  }
  return tag;
}

function nthOfTypeSuffix(element: Element): string {
  const index = nthOfType(element);
  return index > 1 ? `:nth-of-type(${index})` : '';
}

function buildSelector(element: Element, allowIds = true): string {
  // A simple-css-ident id is globally unique in the document: resolve straight
  // to `#id` (fast path, kept for parity with prior behavior and tests).
  if (allowIds && element.id && simpleCssIdent(element.id)) {
    return `#${element.id}`;
  }
  const doc = element.ownerDocument;
  const parts: string[] = [];
  let current: Element | null = element;
  for (let depth = 0; current && depth < SELECTOR_MAX_DEPTH; depth += 1) {
    const tag = current.tagName.toLowerCase();
    // An ancestor with a stable id short-circuits the climb.
    if (allowIds && current.id && simpleCssIdent(current.id)) {
      parts.unshift(`#${current.id}`);
      break;
    }
    let part = selectorPartFor(current, allowIds);
    const parent: Element | null = current.parentElement;
    // Only disambiguate with nth-of-type when the selector-so-far is not unique.
    const candidate = [...parts, part].reverse().join(' > ');
    if (parent && !isUniqueSelector(doc, candidate)) {
      part += nthOfTypeSuffix(current);
    }
    parts.unshift(part);
    if (isUniqueSelector(doc, parts.join(' > '))) {
      break;
    }
    if (tag === 'body' || tag === 'html') break;
    current = parent;
  }
  return (parts.join(' > ') || element.tagName.toLowerCase()).slice(
    0,
    MAX_SELECTOR_CHARS,
  );
}

function omitsContent(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return (
    OMIT_CONTENT_TAGS.has(tag) ||
    element.getAttribute('contenteditable') === 'true'
  );
}

function sanitizedShallowClone(
  source: Element,
  isSensitive: boolean,
): Element {
  const clone = source.ownerDocument.createElementNS(
    source.namespaceURI,
    source.localName,
  );
  let count = 0;
  for (const attr of Array.from(source.attributes)) {
    if (count >= MAX_ATTRS) break;
    if (
      /^on/i.test(attr.name) ||
      OMIT_ATTRIBUTE_NAME.test(attr.name) ||
      (isSensitive && !SAFE_SENSITIVE_ATTRIBUTES.has(attr.name.toLowerCase()))
    ) {
      continue;
    }
    const redacted = SENSITIVE_ATTRIBUTE_NAME.test(attr.name)
      ? '[REDACTED]'
      : redactBrowserText(attr.value.slice(0, MAX_SOURCE_TEXT_SCAN_CHARS));
    clone.setAttribute(attr.name, redacted.slice(0, MAX_ATTR_VALUE_CHARS));
    count += 1;
  }
  return clone;
}

interface CloneBudget {
  nodes: number;
  textChars: number;
}

function sanitizedClone(
  node: Node,
  budget: CloneBudget,
  depth: number,
): Node | null {
  if (budget.nodes >= MAX_CONTEXT_NODES || depth > MAX_CONTEXT_DEPTH) return null;
  budget.nodes += 1;

  if (node.nodeType === 3) {
    const remaining = MAX_OUTER_HTML_CHARS - budget.textChars;
    if (remaining <= 0) return null;
    const text = redactBrowserText(
      (node.nodeValue ?? '').slice(0, MAX_SOURCE_TEXT_SCAN_CHARS),
    ).slice(0, remaining);
    budget.textChars += text.length;
    return node.ownerDocument?.createTextNode(text) ?? null;
  }
  if (node.nodeType !== 1) return null;

  const source = node as Element;
  const tag = source.tagName.toLowerCase();
  if (OMIT_ENTIRE_TAGS.has(tag)) return null;

  const isSensitive = isSensitiveTree(source);
  const clone = sanitizedShallowClone(source, isSensitive);
  if (isSensitive || omitsContent(source)) return clone;

  for (
    let index = 0;
    index < source.childNodes.length && budget.nodes < MAX_CONTEXT_NODES;
    index += 1
  ) {
    const child = sanitizedClone(source.childNodes[index], budget, depth + 1);
    if (child) clone.appendChild(child);
  }
  return clone;
}

function sanitizedOuterHtml(element: Element): string {
  const clone = sanitizedClone(element, { nodes: 0, textChars: 0 }, 0);
  if (!clone || clone.nodeType !== 1) return '';
  return redactBrowserText((clone as Element).outerHTML).slice(
    0,
    MAX_OUTER_HTML_CHARS,
  );
}

function textIsSensitive(parent: Element, root: Element): boolean {
  let current: Element | null = parent;
  while (current) {
    if (
      OMIT_ENTIRE_TAGS.has(current.tagName.toLowerCase()) ||
      omitsContent(current) ||
      isSensitiveTree(current)
    ) {
      return true;
    }
    if (current === root) break;
    current = current.parentElement;
  }
  return false;
}

function safeVisibleText(element: Element): string {
  if (isSensitiveTree(element) || omitsContent(element)) {
    return '[sensitive field hidden]';
  }
  const document = element.ownerDocument;
  const view = document.defaultView;
  if (!view) return '';
  const walker = document.createTreeWalker(
    element,
    view.NodeFilter.SHOW_ELEMENT | view.NodeFilter.SHOW_TEXT,
  );
  const chunks: string[] = [];
  let visited = 0;
  let textChars = 0;
  while (walker.nextNode() && visited < MAX_CONTEXT_NODES) {
    visited += 1;
    if (walker.currentNode.nodeType !== 3) continue;
    const parent = walker.currentNode.parentElement;
    if (!parent || textIsSensitive(parent, element)) continue;
    const remaining = MAX_TEXT_CHARS - textChars;
    if (remaining <= 0) break;
    const text = redactBrowserText(
      normalizedText(
        (walker.currentNode.nodeValue ?? '').slice(
          0,
          MAX_SOURCE_TEXT_SCAN_CHARS,
        ),
      ),
    ).slice(0, remaining);
    if (text) {
      chunks.push(text);
      textChars += text.length + 1;
    }
  }
  return redactBrowserText(normalizedText(chunks.join(' '))).slice(
    0,
    MAX_TEXT_CHARS,
  );
}

function filteredAttributes(
  element: Element,
  isSensitive: boolean,
): Record<string, string> {
  const attributes: Record<string, string> = {};
  let count = 0;
  for (const attr of Array.from(element.attributes)) {
    if (count >= MAX_ATTRS) break;
    if (/^on/i.test(attr.name) || OMIT_ATTRIBUTE_NAME.test(attr.name)) continue;
    if (isSensitive && !SAFE_SENSITIVE_ATTRIBUTES.has(attr.name.toLowerCase())) {
      continue;
    }
    const key = attr.name.slice(0, MAX_ATTR_KEY_CHARS);
    attributes[key] = (
      SENSITIVE_ATTRIBUTE_NAME.test(attr.name)
        ? '[REDACTED]'
        : redactBrowserText(attr.value)
    ).slice(0, MAX_ATTR_VALUE_CHARS);
    count += 1;
  }
  return attributes;
}

function collectComputedStyles(
  win: BrowserDomWindow,
  element: Element,
): Record<string, string> {
  const styles: Record<string, string> = {};
  try {
    const computed = win.getComputedStyle(element);
    for (const prop of DESIGN_STYLE_PROPS) {
      styles[prop] = redactBrowserText(computed.getPropertyValue(prop)).slice(
        0,
        512,
      );
    }
  } catch {
    // Detached elements or exotic hosts: styles stay empty.
  }
  return styles;
}

function summarizeAncestor(element: Element): BrowserDesignAncestor {
  const summary: BrowserDesignAncestor = {
    tag: element.tagName.toLowerCase().slice(0, 32),
    classes: stableClasses(element, MAX_ANCESTOR_CLASSES),
  };
  const role = element.getAttribute('role');
  if (role) summary.role = redactBrowserText(role).slice(0, 64);
  if (element.id && simpleCssIdent(element.id)) {
    summary.id = redactBrowserText(element.id).slice(0, MAX_ID_CHARS);
  }
  return summary;
}

function collectAncestors(
  win: BrowserDomWindow,
  element: Element,
): BrowserDesignAncestor[] {
  const root = win.document.body;
  const result: BrowserDesignAncestor[] = [];
  let current: Element | null = element.parentElement;
  let depth = 0;
  // Stop at <body>/<html>: they add noise without structural value, and keep
  // the payload focused on the element's meaningful hierarchy.
  while (
    current &&
    current !== root &&
    current !== win.document.documentElement &&
    depth < MAX_ANCESTORS
  ) {
    result.push(summarizeAncestor(current));
    current = current.parentElement;
    depth += 1;
  }
  return result;
}

function shortSiblingText(element: Element): string {
  if (isSensitiveTree(element) || omitsContent(element)) return '';
  const raw = element.textContent ?? '';
  return redactBrowserText(normalizedText(raw)).slice(0, MAX_SIBLING_TEXT_CHARS);
}

function collectSiblingLabels(
  win: BrowserDomWindow,
  element: Element,
): string[] {
  const parent = element.parentElement;
  if (!parent) return [];
  const labels: string[] = [];
  for (const sibling of Array.from(parent.children)) {
    if (labels.length >= MAX_SIBLING_LABELS) break;
    if (sibling === element) continue;
    // Skip display:none siblings to reduce noise. We check computed `display`
    // rather than getBoundingClientRect because the latter needs layout
    // (unavailable in jsdom and unreliable mid-paint), while computed display
    // is resolved from style alone.
    try {
      if (win.getComputedStyle(sibling).display === 'none') continue;
    } catch {
      // Exotic host (detached, cross-doc): keep the sibling rather than drop it.
    }
    const tag = sibling.tagName.toLowerCase().slice(0, 16);
    const stable = stableClasses(sibling, 1)[0];
    let label = stable ? `${tag}.${stable}` : tag;
    const text = shortSiblingText(sibling);
    if (text) label += ` "${text}"`;
    labels.push(redactBrowserText(label).slice(0, MAX_SIBLING_LABEL_CHARS));
  }
  return labels;
}

export function createDesignMode(
  win: BrowserDomWindow,
  deps: DesignModeDeps,
): DesignModeController {
  let active = false;
  let host: HTMLElement | null = null;
  let highlight: HTMLElement | null = null;
  let selectedHighlight: HTMLElement | null = null;
  let label: HTMLElement | null = null;
  let stub: HTMLElement | null = null;
  let hovered: Element | null = null;
  let selected: Element | null = null;
  let generation: string | null = null;
  let selectionSequence = 0;

  const DRAG_THRESHOLD_PX = 6;
  interface DragState {
    element: Element;
    parent: Element;
    siblings: Element[];
    fromIndex: number;
    startX: number;
    startY: number;
    dragging: boolean;
    insertion: number;
  }
  let drag: DragState | null = null;

  function isTrustedInteraction(event: Event): boolean {
    return deps.isTrustedEvent?.(event) ?? event.isTrusted;
  }

  function buildContext(element: Element): BrowserDesignElementContext {
    const isSensitive = isSensitiveTree(element);
    const context: BrowserDesignElementContext = {
      ref: deps.refFor(element),
      tag: element.tagName.toLowerCase().slice(0, 32),
      classes: isSensitive
        ? []
        : Array.from(element.classList)
            .slice(0, MAX_CLASSES)
            .map((cls) => redactBrowserText(cls).slice(0, MAX_CLASS_CHARS)),
      selector: redactBrowserText(buildSelector(element, !isSensitive)),
      rect: rectOf(element),
      text: safeVisibleText(element),
      outerHtml: sanitizedOuterHtml(element),
      attributes: filteredAttributes(element, isSensitive),
      computedStyles: collectComputedStyles(win, element),
      url: redactPageUrl(win.location.href),
      ancestors: collectAncestors(win, element),
      siblingLabels: collectSiblingLabels(win, element),
    };
    if (element.id && !isSensitive) {
      context.id = redactBrowserText(element.id).slice(0, MAX_ID_CHARS);
    }
    return context;
  }

  function rectOf(element: Element): BrowserDesignElementContext['rect'] {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  function targetOf(event: Event): Element | null {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const raw = (path[0] ?? event.target) as Node | null;
    if (!raw) return null;
    const element = raw instanceof win.Element ? raw : raw.parentElement;
    if (!element || element === win.document.documentElement) return null;
    if (host && (element === host || host.contains(element))) return null;
    return element;
  }

  function labelText(element: Element): string {
    if (isSensitiveTree(element) || omitsContent(element)) return '';
    const raw = element.textContent ?? '';
    return redactBrowserText(normalizedText(raw)).slice(0, 24);
  }

  function describeForLabel(element: Element, rect: DOMRect): string {
    // Rich hover label (ported intent from Orca's Grab Mode): identity +
    // accessibility role + a short text snippet + box dimensions, so the user
    // can tell apart same-tag siblings without clicking first.
    const parts: string[] = [element.tagName.toLowerCase()];
    if (element.id && simpleCssIdent(element.id)) parts.push(`#${element.id}`);
    const stable = stableClasses(element, 2);
    if (stable.length) parts.push(stable.map((cls) => `.${cls}`).join(''));
    const role = element.getAttribute('role');
    if (role) parts.push(`role=${role}`);
    const text = labelText(element);
    if (text) parts.push(`“${text}”`);
    parts.push(`${Math.round(rect.width)}×${Math.round(rect.height)}`);
    return parts.join(' ');
  }

  function positionHighlight(element: Element | null): void {
    if (!highlight || !label) return;
    if (!element) {
      highlight.style.display = 'none';
      label.style.display = 'none';
      return;
    }
    const rect = element.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    label.style.display = 'block';
    label.style.transform = `translate(${rect.x}px, ${Math.max(0, rect.y - 22)}px)`;
    label.textContent = describeForLabel(element, rect);
  }

  function positionSelectedHighlight(element: Element | null): void {
    if (!selectedHighlight) return;
    if (!element) {
      selectedHighlight.style.display = 'none';
      return;
    }
    const rect = element.getBoundingClientRect();
    selectedHighlight.style.display = 'block';
    selectedHighlight.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    selectedHighlight.style.width = `${rect.width}px`;
    selectedHighlight.style.height = `${rect.height}px`;
  }

  function onPointerMove(event: Event): void {
    if (!isTrustedInteraction(event)) return;
    if (drag) {
      onDragMove(event);
      if (drag?.dragging) return;
    }
    const element = targetOf(event);
    hovered = element;
    positionHighlight(element);
  }

  function emitSelection(element: Element, additive = false): void {
    const eventGeneration = generation;
    if (!active || !eventGeneration) return;
    const requestSequence = ++selectionSequence;
    const base = buildContext(element);
    const selection = additive ? { ...base, additive: true } : base;
    const finish = (hints?: BrowserDesignFrameworkHints): void => {
      if (
        !active ||
        generation !== eventGeneration ||
        selectionSequence !== requestSequence
      ) {
        return;
      }
      deps.emit({
        eventId: makeEventId(),
        generation: eventGeneration,
        type: 'selection',
        at: Date.now(),
        selection: hints ? { ...selection, frameworkHints: hints } : selection,
      });
    };
    if (!deps.introspect) {
      finish();
      return;
    }
    deps.introspect(element).then(finish, () => finish());
  }

  function onClick(event: Event): void {
    if (!isTrustedInteraction(event)) return;
    const element = targetOf(event);
    if (!element) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selected = element;
    // Persist a distinct outline on the selected element so the user sees what
    // they picked while the hover highlight keeps tracking the cursor (multi-shot
    // picker — they may click another element next).
    positionSelectedHighlight(selected);
    emitSelection(element, (event as MouseEvent).shiftKey === true);
  }

  // -- drag reorder (F3): only for the SELECTED element, only when both it
  // and its parent carry ephemeral L3 ids (write-back can execute the move).
  function nexusIdOf(element: Element | null): string | null {
    return element?.getAttribute('data-nexus-id') ?? null;
  }

  function onPointerDown(event: Event): void {
    if (!isTrustedInteraction(event)) return;
    const element = targetOf(event);
    if (!element || element !== selected) return;
    const parent = element.parentElement;
    if (!nexusIdOf(element) || !nexusIdOf(parent)) return;
    const siblings = parent
      ? ([...parent.children] as Element[])
      : [];
    const pointer = event as MouseEvent;
    drag = {
      element,
      parent: parent!,
      siblings,
      fromIndex: siblings.indexOf(element),
      startX: pointer.clientX,
      startY: pointer.clientY,
      dragging: false,
      insertion: siblings.indexOf(element),
    };
  }

  function siblingRects(): FlowRect[] {
    return (drag?.siblings ?? []).map((sibling) => {
      const rect = sibling.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  }

  function positionStub(insertion: number, axis: 'x' | 'y'): void {
    if (!stub || !drag) return;
    const rects = siblingRects();
    if (!rects.length) return;
    const anchor =
      insertion < rects.length ? rects[insertion] : rects[rects.length - 1];
    const after = insertion >= rects.length;
    stub.style.display = 'block';
    if (axis === 'y') {
      const y = after ? anchor.y + anchor.height : anchor.y;
      stub.style.transform = `translate(${anchor.x}px, ${y - 1}px)`;
      stub.style.width = `${anchor.width}px`;
      stub.style.height = '2px';
    } else {
      const x = after ? anchor.x + anchor.width : anchor.x;
      stub.style.transform = `translate(${x - 1}px, ${anchor.y}px)`;
      stub.style.width = '2px';
      stub.style.height = `${anchor.height}px`;
    }
  }

  function onDragMove(event: Event): void {
    if (!isTrustedInteraction(event)) return;
    if (!drag) return;
    const pointer = event as MouseEvent;
    if (!drag.dragging) {
      const distance = Math.hypot(
        pointer.clientX - drag.startX,
        pointer.clientY - drag.startY,
      );
      if (distance < DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
    }
    const rects = siblingRects();
    const axis = detectFlowAxis(rects);
    drag.insertion = dropInsertionIndex(
      rects,
      { x: pointer.clientX, y: pointer.clientY },
      axis,
    );
    positionStub(drag.insertion, axis);
  }

  function onPointerUp(event: Event): void {
    if (!isTrustedInteraction(event)) return;
    if (!drag) return;
    const state = drag;
    drag = null;
    if (stub) stub.style.display = 'none';
    if (!state.dragging) return;
    const toIndex = insertionToReorderIndex(state.fromIndex, state.insertion);
    if (toIndex === state.fromIndex) return;
    deps.emit({
      eventId: makeEventId(),
      generation: generation!,
      type: 'reorder',
      at: Date.now(),
      reorder: {
        nexusId: nexusIdOf(state.element)!,
        parentNexusId: nexusIdOf(state.parent)!,
        fromIndex: state.fromIndex,
        toIndex,
      },
    });
  }

  function onKeyDown(event: Event): void {
    if (!isTrustedInteraction(event)) return;
    if ((event as KeyboardEvent).key === 'Escape' && generation) {
      disable(generation, 'disable');
    }
  }

  function onViewportChange(): void {
    positionHighlight(hovered);
    positionSelectedHighlight(selected);
  }

  function mountOverlay(): void {
    const doc = win.document;
    host = doc.createElement('div');
    host.id = DESIGN_OVERLAY_HOST_ID;
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.pointerEvents = 'none';
    host.style.zIndex = '2147483647';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = [
      '.nx-highlight{position:fixed;top:0;left:0;display:none;',
      'border:1.5px solid #4f8cff;background:rgba(79,140,255,0.12);',
      'border-radius:2px;pointer-events:none;box-sizing:border-box;}',
      // Selected indicator: distinct green outline that persists on the picked
      // element while the blue hover keeps tracking the cursor.
      '.nx-selected{position:fixed;top:0;left:0;display:none;',
      'border:2px solid #16a34a;background:rgba(22,163,74,0.10);',
      'border-radius:2px;pointer-events:none;box-sizing:border-box;',
      'box-shadow:0 0 0 1px rgba(22,163,74,0.45),0 0 6px rgba(22,163,74,0.35);}',
      '.nx-label{position:fixed;top:0;left:0;display:none;',
      'font:11px/1.6 ui-monospace,monospace;color:#fff;background:#2f6ae0;',
      'padding:0 6px;border-radius:3px;pointer-events:none;white-space:nowrap;',
      'max-width:340px;overflow:hidden;text-overflow:ellipsis;}',
      '.nx-stub{position:fixed;top:0;left:0;display:none;background:#2f6ae0;',
      'border-radius:1px;pointer-events:none;box-shadow:0 0 4px #2f6ae0;}',
    ].join('');
    highlight = doc.createElement('div');
    highlight.className = 'nx-highlight';
    selectedHighlight = doc.createElement('div');
    selectedHighlight.className = 'nx-selected';
    label = doc.createElement('div');
    label.className = 'nx-label';
    stub = doc.createElement('div');
    stub.className = 'nx-stub';
    // Order matters: selectedHighlight renders above the hover highlight so the
    // green "picked" state reads clearly even when the cursor is over it.
    shadow.append(style, highlight, selectedHighlight, label, stub);
    doc.documentElement.appendChild(host);
  }

  function unmountOverlay(): void {
    host?.remove();
    host = null;
    highlight = null;
    selectedHighlight = null;
    label = null;
    stub = null;
    hovered = null;
    selected = null;
    drag = null;
  }

  function enable(nextGeneration: string): { active: boolean } {
    if (active && generation === nextGeneration) return { active: true };
    if (active) {
      selected = null;
      drag = null;
      if (stub) stub.style.display = 'none';
      positionSelectedHighlight(null);
      generation = nextGeneration;
      deps.emit({
        eventId: makeEventId(),
        generation: nextGeneration,
        type: 'mode',
        at: Date.now(),
        mode: { active: true, reason: 'enable' },
      });
      return { active: true };
    }
    active = true;
    generation = nextGeneration;
    mountOverlay();
    win.addEventListener('pointermove', onPointerMove, true);
    win.addEventListener('pointerdown', onPointerDown, true);
    win.addEventListener('pointerup', onPointerUp, true);
    win.addEventListener('click', onClick, true);
    win.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('scroll', onViewportChange, true);
    win.addEventListener('resize', onViewportChange, true);
    deps.emit({
      eventId: makeEventId(),
      generation: nextGeneration,
      type: 'mode',
      at: Date.now(),
      mode: { active: true, reason: 'enable' },
    });
    return { active: true };
  }

  function disable(
    expectedGeneration: string,
    reason: 'disable' | 'navigation' = 'disable',
  ): {
    active: boolean;
  } {
    if (!active) return { active: false };
    if (generation !== expectedGeneration) {
      throw new Error('stale design generation');
    }
    const eventGeneration = generation;
    active = false;
    win.removeEventListener('pointermove', onPointerMove, true);
    win.removeEventListener('pointerdown', onPointerDown, true);
    win.removeEventListener('pointerup', onPointerUp, true);
    win.removeEventListener('click', onClick, true);
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('scroll', onViewportChange, true);
    win.removeEventListener('resize', onViewportChange, true);
    unmountOverlay();
    generation = null;
    deps.emit({
      eventId: makeEventId(),
      generation: eventGeneration,
      type: 'mode',
      at: Date.now(),
      mode: { active: false, reason },
    });
    return { active: false };
  }

  return {
    enable,
    disable,
    isActive: () => active,
  };
}

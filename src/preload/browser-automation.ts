import type {
  BrowserAutomationCommand,
  BrowserElementDescriptor,
  BrowserPageReadResult,
  BrowserWaitCondition,
} from '../shared/browser-automation';
import type { BrowserDesignEvent } from '../shared/browser-design';
import { redactVisibleSecrets } from '../shared/vision-ipc';
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
const MAX_SCROLL_OFFSET = 100_000;

/** Named keyboard keys accepted by `press` (KeyboardEvent.key values). */
const ALLOWED_PRESS_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ' ', 'Space', 'ContextMenu', 'CapsLock', 'NumLock', 'ScrollLock',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

const ALLOWED_PRESS_MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

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
const POLL_MS = 50;
const ELEMENT_REF_PATTERN = /^e[1-9]\d{0,7}$/;
const DESIGN_GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BrowserDomWindow = Window & typeof globalThis;

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
].join(',');

const SKIP_TEXT_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  '[hidden]',
  '[aria-hidden="true"]',
].join(',');

const SENSITIVE_MARKER =
  /(?:password|passwd|secret|token|api[_ -]?key|access[_ -]?key|private[_ -]?key|authorization|credential|one[_ -]?time|otp|cookie|session)/i;

function clampInt(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

function normalizedText(value: string): string {
  return value.replace(/[\t\r\n ]+/g, ' ').trim();
}

export function redactBrowserText(value: string): string {
  return redactVisibleSecrets(value);
}

export function redactPageUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    const keys = [...new Set([...url.searchParams.keys()])];
    url.search = '';
    keys.slice(0, 32).forEach((key) => {
      url.searchParams.append(key, SENSITIVE_MARKER.test(key) ? '[REDACTED]' : '');
    });
    if (
      url.hash.length > 129 ||
      SENSITIVE_MARKER.test(url.hash) ||
      !/^#[#/a-z0-9._-]*$/i.test(url.hash)
    ) {
      url.hash = url.hash ? '#[REDACTED]' : '';
    }
    return url.toString();
  } catch {
    return '[invalid URL]';
  }
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
  return SENSITIVE_MARKER.test(marker);
}

export function isSensitiveTree(element: Element): boolean {
  let current: Element | null = element;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (elementHasSensitiveMarker(current)) return true;
    current = current.parentElement;
  }
  return false;
}

function isElementVisible(win: BrowserDomWindow, element: Element): boolean {
  if (!element.isConnected) return false;
  if (element.closest(SKIP_TEXT_SELECTOR)) return false;
  let current: Element | null = element;
  for (let depth = 0; current && depth < 12; depth += 1) {
    try {
      const style = win.getComputedStyle(current);
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
    current = current.parentElement;
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
    const parent = walker.currentNode.parentElement;
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
  if (element.getAttribute('contenteditable') === 'true') return 'textbox';
  return tag;
}

function elementName(win: BrowserDomWindow, element: Element): string {
  const aria = element.getAttribute('aria-label');
  if (aria) return redactBrowserText(normalizedText(aria)).slice(0, MAX_NAME_CHARS);

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .slice(0, 8)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
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
  run(command: BrowserAutomationCommand, args: Record<string, unknown>): Promise<unknown>;
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
    if (!element || !element.isConnected) {
      references.delete(raw);
      throw new Error('browser element reference is stale; read the page again');
    }
    return element;
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
    }
    if (
      tag === 'input' ||
      tag === 'textarea' ||
      element.getAttribute('contenteditable') === 'true'
    ) {
      descriptor.editable = !isSensitiveTree(element);
    }
    return descriptor;
  }

  function read(args: Record<string, unknown>): BrowserPageReadResult {
    pruneReferences();
    const maxChars = clampInt(args.maxChars, DEFAULT_TEXT_CHARS, MAX_TEXT_CHARS);
    const maxElements = clampInt(args.maxElements, DEFAULT_ELEMENTS, MAX_ELEMENTS);
    const body = win.document.body;
    const text = body
      ? collectVisibleText(win, body, maxChars)
      : { text: '', truncated: false };
    const candidates = [...win.document.querySelectorAll(INTERACTIVE_SELECTOR)];
    const visible = candidates
      .filter((element) => isElementVisible(win, element))
      .slice(0, maxElements);
    const headings = [...win.document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
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
    };
  }

  function inspect(args: Record<string, unknown>): BrowserElementDescriptor {
    const element = resolveRef(args.ref);
    if (!isElementVisible(win, element)) throw new Error('browser element is not visible');
    return describe(element);
  }

  function click(args: Record<string, unknown>): { clicked: true; element: BrowserElementDescriptor } {
    const element = resolveRef(args.ref);
    if (!isElementVisible(win, element)) throw new Error('browser element is not visible');
    if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') {
      throw new Error('browser element is disabled');
    }
    const clickable = element as HTMLElement;
    if (typeof clickable.click !== 'function') throw new Error('browser element is not clickable');
    clickable.focus?.({ preventScroll: true });
    clickable.click();
    return { clicked: true, element: describe(element) };
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
    if (tag === 'input') {
      const input = element as HTMLInputElement;
      const type = (input.type || 'text').toLowerCase();
      if (['password', 'file', 'hidden', 'checkbox', 'radio'].includes(type)) {
        throw new Error('browser input type cannot be filled as text');
      }
      const setter = Object.getOwnPropertyDescriptor(
        win.HTMLInputElement.prototype,
        'value',
      )?.set;
      if (!setter) throw new Error('browser input setter is unavailable');
      setter.call(input, text);
    } else if (tag === 'textarea') {
      const setter = Object.getOwnPropertyDescriptor(
        win.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (!setter) throw new Error('browser textarea setter is unavailable');
      setter.call(element, text);
    } else if (element.getAttribute('contenteditable') === 'true') {
      element.textContent = text;
    } else {
      throw new Error('browser element is not a fillable text field');
    }

    (element as HTMLElement).focus?.({ preventScroll: true });
    element.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
    return { filled: true, ref: refFor(element), length: text.length };
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

    return new Promise((resolve, reject) => {
      const check = (): void => {
        let matched = false;
        if (condition === 'load') matched = win.document.readyState === 'complete';
        if (condition === 'text') {
          const body = win.document.body;
          matched = body
            ? collectVisibleText(win, body, MAX_TEXT_CHARS)
                .text.toLocaleLowerCase()
                .includes(redactBrowserText(query).toLocaleLowerCase())
            : false;
        }
        if (condition === 'ref') {
          const element = references.get(ref);
          matched = Boolean(element?.isConnected && isElementVisible(win, element));
        }
        if (matched) {
          resolve({ matched: true, condition, elapsedMs: Date.now() - startedAt });
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error('browser wait timed out'));
          return;
        }
        win.setTimeout(check, POLL_MS);
      };
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

  function scroll(args: Record<string, unknown>): {
    scrolled: true;
    scrollX: number;
    scrollY: number;
    target: 'page' | 'element';
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
      return {
        scrolled: true,
        scrollX: Math.round(win.scrollX),
        scrollY: Math.round(win.scrollY),
        target: 'element',
      };
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
    return {
      scrolled: true,
      scrollX: Math.round(win.scrollX),
      scrollY: Math.round(win.scrollY),
      target: 'page',
    };
  }

  function press(args: Record<string, unknown>): {
    pressed: true;
    key: string;
    ref?: string;
  } {
    const key = typeof args.key === 'string' ? args.key : '';
    if (!key || key.length > 32 || !isAllowedPressKey(key)) {
      throw new Error('browser press key is invalid or not allowed');
    }
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
      target =
        win.document.activeElement instanceof win.Element
          ? win.document.activeElement
          : win.document.body;
    }
    (target as HTMLElement).focus?.({ preventScroll: true });
    // Synthesized KeyboardEvents carry isTrusted=false; this is the best a
    // non-CDP preload can do. React/Vue bind on keydown so this covers the
    // common case; sites that gate on isTrusted will not react.
    const opts = {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
      shiftKey: modifiers.includes('Shift'),
      ctrlKey: modifiers.includes('Control'),
      altKey: modifiers.includes('Alt'),
      metaKey: modifiers.includes('Meta'),
    };
    target.dispatchEvent(new win.KeyboardEvent('keydown', opts));
    target.dispatchEvent(new win.KeyboardEvent('keyup', opts));
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

  return {
    async run(command, args) {
      if (command === 'read') return read(args);
      if (command === 'inspect') return inspect(args);
      if (command === 'click') return click(args);
      if (command === 'fill') return fill(args);
      if (command === 'wait') return wait(args);
      if (command === 'scroll') return scroll(args);
      if (command === 'press') return press(args);
      if (command === 'hover') return hover(args);
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
      throw new Error('unsupported browser automation command');
    },
  };
}

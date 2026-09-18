import type {
  BrowserAutomationCommand,
  BrowserElementDescriptor,
  BrowserExtractCandidates,
  BrowserFindMatch,
  BrowserFindResult,
  BrowserPageAlert,
  BrowserPageReadResult,
  BrowserViewport,
  BrowserWaitCondition,
} from '../shared/browser-automation';
import type { BrowserDesignEvent } from '../shared/browser-design';
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
      viewport: viewportState(),
      alerts: collectAlerts(),
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

  function collectAlerts(): BrowserPageAlert[] {
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
    for (const element of win.document.querySelectorAll(ALERT_ROLE_SELECTOR)) {
      if (out.length >= MAX_ALERTS) break;
      push(element, implicitRole(element), true);
    }
    for (const element of win.document.querySelectorAll(
      ALERT_CLASS_CANDIDATE_SELECTOR,
    )) {
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
    for (const element of win.document.querySelectorAll(INTERACTIVE_SELECTOR)) {
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
      const l = normalizedText(label).slice(0, PAIR_LABEL_CHARS);
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
    for (const dt of win.document.querySelectorAll('dt')) {
      if (overBudget()) break;
      if (isSensitiveTree(dt) || !isElementVisible(win, dt)) continue;
      let dd = dt.nextElementSibling;
      while (dd && dd.tagName.toLowerCase() !== 'dd') {
        dd = dd.nextElementSibling;
      }
      if (!dd || isSensitiveTree(dd)) continue;
      pushPair(dt.textContent ?? '', dd.textContent ?? '', dd);
    }

    // tables: th → td, or first cell → remaining cells.
    for (const row of win.document.querySelectorAll('tr')) {
      if (overBudget()) break;
      if (isSensitiveTree(row) || !isElementVisible(win, row)) continue;
      const cells = [...row.querySelectorAll('th,td')];
      if (cells.length < 2) continue;
      pushPair(
        cells[0].textContent ?? '',
        cells
          .slice(1)
          .map((cell) => cell.textContent ?? '')
          .join(' · '),
        cells[1],
      );
    }

    // label[for] / wrapping label → campo: só <select> (a opção escolhida é
    // conteúdo da página); valores digitados nunca saem da página — só a
    // opção escolhida de um select.
    for (const label of win.document.querySelectorAll('label')) {
      if (overBudget()) break;
      if (isSensitiveTree(label) || !isElementVisible(win, label)) continue;
      const forId = label.getAttribute('for');
      const field = forId
        ? win.document.getElementById(forId)
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
    for (const el of win.document.querySelectorAll(LABEL_LINE_ELEMENTS)) {
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
    const bodyText = win.document.body
      ? collectVisibleText(win, win.document.body, MAX_TEXT_CHARS).text
      : '';
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
    collectTokens('number', /\b\d{1,3}(?:[.,]\d{3})+[.,]\d+\b|\b\d+[.,]\d+\b|\b\d{4,}\b/g);
    return { jsonLd, pairs, tokens };
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
      if (command === 'find') return find(args);
      if (command === 'click') return click(args);
      if (command === 'fill') return fill(args);
      if (command === 'wait') return wait(args);
      if (command === 'scroll') return scroll(args);
      if (command === 'press') return press(args);
      if (command === 'hover') return hover(args);
      if (command === 'extract_candidates') return extractCandidates();
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

/**
 * Bounded accessibility snapshot + opaque UI capabilities.
 * Runs only in the sandboxed preload context; raw DOM nodes never cross the
 * contextBridge boundary.
 */
import type {
  AxActionError,
  AxActionKind,
  AxActionRequest,
  AxActionResult,
  AxNode,
} from '../shared/vision-ipc';

const MAX_DEPTH = 10;
const MAX_AX_NODES = 1_500;
const MAX_ACTION_TEXT_CHARS = 8_192;
const MAX_SNAPSHOTS_PER_DOCUMENT = 999_999;
const AX_REF_RE = /^u([1-9]\d{0,15})e([1-9]\d{0,7})$/;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD']);
const INTERACTIVE_TAGS = new Set([
  'A',
  'BUTTON',
  'DETAILS',
  'INPUT',
  'SELECT',
  'SUMMARY',
  'TEXTAREA',
]);
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);
const SAFE_FILL_INPUT_TYPES = new Set([
  'email',
  'number',
  'search',
  'tel',
  'text',
  'url',
]);
const SENSITIVE_FIELD_RE =
  /(password|passcode|secret|token|api[-_ ]?key|credential|private[-_ ]?key|payment|credit[-_ ]?card|card[-_ ]?(?:number|no)|cc[-_ ]?(?:number|csc|cvv|exp)|cvv|cvc|iban|routing[-_ ]?number|account[-_ ]?number)/i;
const SENSITIVE_AUTOCOMPLETE_RE =
  /(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-name)/i;

function randomInteger(minimum: number, range: number): number {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return minimum + (values[0] % range);
}

// A random per-document prefix prevents refs from becoming valid again after
// a renderer navigation reloads this preload module.
const documentScopeId = String(randomInteger(1_000_000_000, 9_000_000_000));
let snapshotSequence = 0;
let activeSnapshotId = '';
let activeElements = new Map<string, Element>();

interface ExtractContext {
  nodeCount: number;
}

function beginSnapshot(): void {
  if (snapshotSequence >= MAX_SNAPSHOTS_PER_DOCUMENT) {
    throw new Error('accessibility snapshot capacity exceeded');
  }
  snapshotSequence += 1;
  activeSnapshotId = `${documentScopeId}${String(snapshotSequence).padStart(6, '0')}`;
  activeElements = new Map();
}

function isHidden(element: Element): boolean {
  if (
    element instanceof HTMLInputElement &&
    element.type.toLowerCase() === 'hidden'
  ) {
    return true;
  }
  let current: Element | null = element;
  while (current) {
    if (
      current.hasAttribute('hidden') ||
      current.hasAttribute('inert') ||
      current.getAttribute('aria-hidden') === 'true'
    ) {
      return true;
    }
    const style = window.getComputedStyle(current);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0' ||
      style.getPropertyValue('content-visibility') === 'hidden'
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isActionCandidate(element: Element): boolean {
  if (INTERACTIVE_TAGS.has(element.tagName)) return true;
  const role = element.getAttribute('role')?.toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  return (
    element instanceof HTMLElement &&
    (element.tabIndex >= 0 || element.isContentEditable)
  );
}

function assignRef(element: Element): string | undefined {
  if (!isActionCandidate(element)) return undefined;
  let ref = '';
  do {
    ref = `u${activeSnapshotId}e${randomInteger(10_000_000, 90_000_000)}`;
  } while (activeElements.has(ref));
  activeElements.set(ref, element);
  return ref;
}

function ariaOf(element: Element): Record<string, string> {
  const aria: Record<string, string> = {};
  const sensitive = isSensitiveControl(element);
  const keys = [
    'role', 'label', 'labelledby', 'describedby', 'level',
    'disabled', 'hidden', 'expanded', 'pressed', 'selected',
    'checked', 'valuenow', 'valuemin', 'valuemax', 'valuetext',
    'haspopup', 'current', 'live', 'atomic', 'relevant',
    'orientation', 'modal', 'multiline', 'multiselectable',
    'readonly', 'required', 'sort',
  ];
  for (const key of keys) {
    if (sensitive && key === 'valuetext') continue;
    const value = element.getAttribute(`aria-${key}`);
    if (value !== null) aria[key] = value.slice(0, 500);
  }
  return aria;
}

function textOf(element: Element): string | null {
  if (isSensitiveControl(element)) return null;
  let text: string | null = null;
  for (const child of element.childNodes) {
    if (child.nodeType !== Node.TEXT_NODE) continue;
    const value = child.textContent?.trim();
    if (value) text = (text ? `${text} ` : '') + value;
  }
  if (text) return text.slice(0, 200);
  return element.textContent?.trim().slice(0, 200) || null;
}

function extractNode(
  element: Element,
  depth: number,
  context: ExtractContext,
): AxNode | null {
  if (depth > MAX_DEPTH || context.nodeCount >= MAX_AX_NODES) return null;
  if (SKIP_TAGS.has(element.tagName) || isHidden(element)) return null;
  context.nodeCount += 1;
  const children: AxNode[] = [];
  for (const child of element.children) {
    const node = extractNode(child, depth + 1, context);
    if (node) children.push(node);
    if (context.nodeCount >= MAX_AX_NODES) break;
  }
  const ref = assignRef(element);
  return {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') ?? element.getAttribute('aria-role') ?? null,
    aria: ariaOf(element),
    text: textOf(element),
    ...(ref ? { ref } : {}),
    children,
  };
}

function isFormField(element: Element): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

function isSensitiveControl(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === 'password' || type === 'file' || type === 'hidden') return true;
    if (SENSITIVE_AUTOCOMPLETE_RE.test(element.autocomplete)) return true;
  }
  if (!isFormField(element)) return false;
  const labelledByText = (element.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent)
    .filter(Boolean);
  const labelText =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
      ? [...(element.labels ?? [])].map((label) => label.textContent)
      : [element.closest('label')?.textContent];
  const descriptor = [
    element.id,
    element.getAttribute('name'),
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
    element.getAttribute('autocomplete'),
    element.getAttribute('data-testid'),
    ...labelledByText,
    ...labelText,
  ]
    .filter(Boolean)
    .join(' ');
  return SENSITIVE_FIELD_RE.test(descriptor);
}

function isDisabled(element: Element): boolean {
  if (element.getAttribute('aria-disabled') === 'true') return true;
  let parent = element.parentElement;
  while (parent) {
    if (parent.getAttribute('aria-disabled') === 'true') return true;
    parent = parent.parentElement;
  }
  try {
    if (element.matches(':disabled')) return true;
  } catch {
    // Non-HTML elements do not necessarily support :disabled.
  }
  return 'disabled' in element && Boolean((element as { disabled?: unknown }).disabled);
}

function isReadonly(element: Element): boolean {
  return (
    element.getAttribute('aria-readonly') === 'true' ||
    (element instanceof HTMLInputElement && element.readOnly) ||
    (element instanceof HTMLTextAreaElement && element.readOnly)
  );
}

function resultError(
  request: Pick<AxActionRequest, 'action' | 'ref'>,
  error: AxActionError,
): AxActionResult {
  return { ok: false, action: request.action, ref: request.ref, error };
}

function dispatchValueEvents(element: Element): void {
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype = Object.getPrototypeOf(element) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function fillControl(element: Element, request: AxActionRequest): AxActionResult {
  const value = request.text!;
  if (isReadonly(element)) return resultError(request, 'readonly_control');
  if (element instanceof HTMLInputElement) {
    if (!SAFE_FILL_INPUT_TYPES.has(element.type.toLowerCase())) {
      return resultError(request, 'unsupported_action');
    }
    setNativeValue(element, value);
  } else if (element instanceof HTMLTextAreaElement) {
    setNativeValue(element, value);
  } else if (element instanceof HTMLElement && element.isContentEditable) {
    element.textContent = value;
  } else {
    return resultError(request, 'unsupported_action');
  }
  dispatchValueEvents(element);
  return { ok: true, action: request.action, ref: request.ref };
}

function selectControl(element: Element, request: AxActionRequest): AxActionResult {
  if (!(element instanceof HTMLSelectElement)) {
    return resultError(request, 'unsupported_action');
  }
  if (isReadonly(element)) return resultError(request, 'readonly_control');
  const option = [...element.options].find((candidate) => candidate.value === request.text);
  if (!option) return resultError(request, 'option_not_found');
  if (option.disabled) return resultError(request, 'disabled_control');
  setNativeValue(element, request.text!);
  dispatchValueEvents(element);
  return { ok: true, action: request.action, ref: request.ref };
}

function normalizeRequest(raw: unknown): AxActionRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const action = value.action;
  const ref = value.ref;
  if (
    (action !== 'click' && action !== 'focus' && action !== 'fill' && action !== 'select') ||
    typeof ref !== 'string' ||
    !AX_REF_RE.test(ref) ||
    Object.keys(value).some((key) => key !== 'action' && key !== 'ref' && key !== 'text')
  ) {
    return null;
  }
  const needsText = action === 'fill' || action === 'select';
  if (
    (needsText && typeof value.text !== 'string') ||
    (!needsText && value.text !== undefined) ||
    (typeof value.text === 'string' && value.text.length > MAX_ACTION_TEXT_CHARS)
  ) {
    return null;
  }
  return {
    action,
    ref,
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
  };
}

/** Capture a new AX snapshot. Every previous ref becomes stale immediately. */
export function getAxTree(): AxNode {
  beginSnapshot();
  if (!document.body) {
    return { tag: 'html', role: null, aria: {}, text: null, children: [] };
  }
  return (
    extractNode(document.body, 0, { nodeCount: 0 }) ??
    { tag: 'body', role: null, aria: {}, text: null, children: [] }
  );
}

/** Execute a bounded action using only a ref from the currently active snapshot. */
export function performAxAction(raw: AxActionRequest): AxActionResult {
  const request = normalizeRequest(raw);
  if (!request) {
    const safeRef =
      typeof raw?.ref === 'string' && AX_REF_RE.test(raw.ref) ? raw.ref : '';
    const fallbackAction: AxActionKind =
      raw?.action === 'click' ||
      raw?.action === 'fill' ||
      raw?.action === 'select'
        ? raw.action
        : 'focus';
    return {
      ok: false,
      action: fallbackAction,
      ref: safeRef,
      error: safeRef ? 'invalid_request' : 'invalid_ref',
    };
  }
  const match = AX_REF_RE.exec(request.ref)!;
  if (match[1] !== activeSnapshotId) return resultError(request, 'stale_ref');
  const element = activeElements.get(request.ref);
  if (!element) return resultError(request, 'unknown_ref');
  if (!element.isConnected) return resultError(request, 'detached_control');
  if (isHidden(element)) return resultError(request, 'hidden_control');
  if (isSensitiveControl(element)) return resultError(request, 'sensitive_control');
  if (isDisabled(element)) return resultError(request, 'disabled_control');

  if (request.action === 'fill') return fillControl(element, request);
  if (request.action === 'select') return selectControl(element, request);
  if (!(element instanceof HTMLElement)) {
    return resultError(request, 'unsupported_action');
  }
  if (request.action === 'click') element.click();
  else element.focus({ preventScroll: true });
  return { ok: true, action: request.action, ref: request.ref };
}

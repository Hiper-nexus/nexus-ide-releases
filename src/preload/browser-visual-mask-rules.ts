import { isSensitiveBrowserMarker, redactBrowserText } from '../shared/browser-redaction';

/**
 * Pure decisions behind the pixel mask. They run in the isolated browser preload
 * and take plain data so they stay testable without layout (jsdom has none).
 */

/** Credential shapes `redactBrowserText` does not know: they must hide the pixels, not only the text. */
const PREFIXED_TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bwhsec_[A-Za-z0-9]{16,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bxapp-[A-Za-z0-9-]{10,}/,
  /\b(?:glpat|dop_v1|shpat|shpss|hvs|pat)[_-][A-Za-z0-9_-]{16,}/,
  /\b[A-Za-z]{2,10}_(?:live|test|prod)_[A-Za-z0-9]{8,}/,
];
/** Base64 secrets (AWS, JWT parts) contain `+`, `/` and `=`: those stay inside a run. */
const WORD_RUN_SEPARATOR = /[^A-Za-z0-9_+/=-]+/;
const OPAQUE_RUN_MIN_CHARS = 32;
const HEX_SECRET_MIN_CHARS = 40;
/** Beyond this a text blob is a data dump: scanning it costs more than hiding it. */
const MAX_SCANNED_TEXT_CHARS = 50_000;
const MAX_SCANNED_RUN_CHARS = 512;

/** Linear scan (no lookahead regex): a hostile page can hold megabytes of word characters. */
function hasOpaqueSecretRun(text: string): boolean {
  for (const run of text.split(WORD_RUN_SEPARATOR)) {
    if (run.length < OPAQUE_RUN_MIN_CHARS) continue;
    if (run.length > MAX_SCANNED_RUN_CHARS) return true;
    if (run.length >= HEX_SECRET_MIN_CHARS && /^[A-Fa-f0-9]+$/.test(run)) return true;
    if (/\d/.test(run) && /[A-Za-z]/.test(run)) return true;
  }
  return false;
}

/** The text itself looks like a credential (no label needed): known formats, prefixed tokens, opaque runs. */
export function hasSecretShape(text: string): boolean {
  if (!text.trim()) return false;
  if (text.length > MAX_SCANNED_TEXT_CHARS) return true;
  return redactBrowserText(text) !== text || PREFIXED_TOKEN_PATTERNS.some(pattern => pattern.test(text)) || hasOpaqueSecretRun(text);
}

/** A label such as "API key" or "Token" counts too: its value usually sits in a neighbouring node. */
export function isSensitiveVisualText(text: string): boolean {
  if (!text.trim()) return false;
  return isSensitiveBrowserMarker(text) || hasSecretShape(text);
}

/** A secret split by inline markup (`<span>sk_live_</span><span>…</span>`) is only visible in the joined text. */
export const SPLIT_SECRET_MAX_CHILD_NODES = 12;
export const SPLIT_SECRET_MAX_CHARS = 400;

/** Frames and embedded media can show anything the DOM text cannot reveal. */
export const OPAQUE_VISUAL_SELECTOR = 'input,textarea,select,[contenteditable],[role="textbox"],iframe,canvas,object,embed,img,svg,video,picture';
const MEDIA_TAGS: ReadonlySet<string> = new Set(['IFRAME', 'CANVAS', 'OBJECT', 'EMBED', 'IMG', 'SVG', 'VIDEO', 'PICTURE']);
/** Icons and bullets carry no secret; anything larger is hidden (CSS background images remain a known gap). */
export const MIN_MASKED_MEDIA_EDGE_PX = 24;
export const NON_RENDERED_TAGS: ReadonlySet<string> = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'HEAD']);

export function isMediaTag(tagName: string): boolean { return MEDIA_TAGS.has(tagName.toUpperCase()); }
export function shouldMaskMedia(rect: { width: number; height: number }): boolean {
  return Math.max(rect.width, rect.height) >= MIN_MASKED_MEDIA_EDGE_PX;
}

export interface MaskBlockNode {
  readonly tagName: string;
  readonly parentElement: MaskBlockNode | null;
  readonly childElementCount: number;
}

const INLINE_TAGS: ReadonlySet<string> = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'BUTTON', 'CITE', 'CODE', 'DEL', 'DFN', 'EM', 'FONT',
  'I', 'INS', 'KBD', 'LABEL', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR']);
/** Containers that group unrelated content: escalating to one of them would hide the page, not the row. */
const BROAD_CONTAINERS: ReadonlySet<string> = new Set(['BODY', 'HTML', 'MAIN', 'ARTICLE', 'SECTION', 'ASIDE', 'NAV', 'HEADER', 'FOOTER',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'UL', 'OL']);
const SELF_CONTAINED_TAGS: ReadonlySet<string> = new Set(['LI', 'TR']);
const MAX_ROW_CHILDREN = 6;

const tag = (node: MaskBlockNode): string => node.tagName.toUpperCase();

function closestRow(node: MaskBlockNode): MaskBlockNode | null {
  for (let current: MaskBlockNode | null = node; current; current = current.parentElement) {
    if (tag(current) === 'TR') return current;
  }
  return null;
}

function smallRowParent(node: MaskBlockNode): MaskBlockNode | null {
  const parent = node.parentElement;
  return parent && !BROAD_CONTAINERS.has(tag(parent)) && parent.childElementCount <= MAX_ROW_CHILDREN ? parent : null;
}

/**
 * The element to hide when a text node is (or labels) a secret. A label and its
 * value live in sibling nodes — `<td>`/`<td>`, `<dt>`/`<dd>`, `<div>`/`<div>` —
 * so a sensitive node hides its whole row, not only its own text.
 */
export function sensitiveBlockAncestor(start: MaskBlockNode | null): MaskBlockNode | null {
  let node = start;
  while (node && INLINE_TAGS.has(tag(node))) node = node.parentElement;
  if (!node) return start;
  const name = tag(node);
  if (name === 'TD' || name === 'TH') return closestRow(node) ?? node;
  if (name === 'DT' || name === 'DD') return node.parentElement ?? node;
  if (SELF_CONTAINED_TAGS.has(name) || BROAD_CONTAINERS.has(name)) return node;
  return smallRowParent(node) ?? node;
}

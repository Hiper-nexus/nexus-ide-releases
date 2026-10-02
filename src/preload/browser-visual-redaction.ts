import type { BrowserVisualMasks, BrowserVisualRect } from '../shared/browser-visual';
import { isSensitiveBrowserMarker } from '../shared/browser-redaction';
import {
  isMediaTag, isSensitiveVisualText, NON_RENDERED_TAGS, OPAQUE_VISUAL_SELECTOR, sensitiveBlockAncestor, shouldMaskMedia,
  type MaskBlockNode,
} from './browser-visual-mask-rules';

const MAX_NODES = 50_000;
const MAX_RECTS = 2_000;
/** A block this large would hide the page, not the secret: fall back to the text's own rectangles. */
const MAX_BLOCK_VIEWPORT_SHARE = 0.4;

function sensitiveElement(element: Element): boolean {
  return element.matches(OPAQUE_VISUAL_SELECTOR) || [...element.attributes].some(attribute =>
    isSensitiveBrowserMarker(attribute.name) ||
    ['id', 'class', 'name', 'aria-label', 'autocomplete'].includes(attribute.name) && isSensitiveBrowserMarker(attribute.value));
}

const area = (rect: { width: number; height: number }): number => rect.width * rect.height;

/** Only geometry leaves the isolated world. Frames, canvas and media are opaque. */
export function collectBrowserVisualMasks(win: Window & typeof globalThis): BrowserVisualMasks {
  const rectangles: BrowserVisualRect[] = [];
  let visited = 0;
  const viewportArea = win.innerWidth * win.innerHeight;
  const append = (rect: { x: number; y: number; width: number; height: number }): void => {
    if (rect.width <= 0 || rect.height <= 0) return;
    if (rectangles.length >= MAX_RECTS) throw new Error('visual mask limit reached');
    rectangles.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  };
  const appendTextRects = (text: Node): void => {
    const range = win.document.createRange(); range.selectNodeContents(text);
    if (typeof range.getClientRects !== 'function') { if (text.parentElement) append(text.parentElement.getBoundingClientRect()); return; }
    for (const rect of range.getClientRects()) append(rect);
  };
  const maskElement = (element: Element): void => {
    const rect = element.getBoundingClientRect();
    if (isMediaTag(element.tagName)) {
      // One rectangle covers the children of an svg/picture; only visible-size media hides anything.
      if (shouldMaskMedia(rect)) append(rect);
      return;
    }
    append(rect);
    for (const child of element.querySelectorAll('*')) append(child.getBoundingClientRect());
  };
  const maskSensitiveText = (text: Node): void => {
    const block = sensitiveBlockAncestor(text.parentElement as unknown as MaskBlockNode | null) as unknown as Element | null;
    const rect = block?.getBoundingClientRect();
    if (rect && area(rect) <= viewportArea * MAX_BLOCK_VIEWPORT_SHARE) append(rect);
    else appendTextRects(text);
  };
  const visitText = (node: Node): void => {
    const parent = node.parentElement;
    if (!parent || NON_RENDERED_TAGS.has(parent.tagName.toUpperCase())) return;
    if (isSensitiveVisualText(node.textContent ?? '')) maskSensitiveText(node);
  };
  const walk = (root: Node): void => {
    const walker = win.document.createTreeWalker(root, win.NodeFilter.SHOW_ELEMENT | win.NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (++visited > MAX_NODES) throw new Error('visual DOM limit reached');
      if (node.nodeType !== win.Node.ELEMENT_NODE) { visitText(node); continue; }
      const element = node as Element;
      if (sensitiveElement(element)) maskElement(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(win.document);
  return { width: win.innerWidth, height: win.innerHeight, scrollX: win.scrollX, scrollY: win.scrollY, rectangles };
}

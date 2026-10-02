import type { BrowserVisualMasks, BrowserVisualRect } from '../shared/browser-visual';
import { isSensitiveBrowserMarker } from '../shared/browser-redaction';
import {
  hasSecretShape, isMediaTag, isSensitiveVisualText, NON_RENDERED_TAGS, OPAQUE_VISUAL_SELECTOR, sensitiveBlockAncestor, shouldMaskMedia,
  SPLIT_SECRET_MAX_CHARS, SPLIT_SECRET_MAX_CHILD_NODES, type MaskBlockNode,
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
  const rectangleKeys = new Set<string>();
  const maskedNodes = new WeakSet<Node>();
  let maskedVisits = 0;
  let visited = 0;
  const viewportArea = win.innerWidth * win.innerHeight;
  const append = (rect: { x: number; y: number; width: number; height: number }): void => {
    if (rect.width <= 0 || rect.height <= 0) return;
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
    if (rectangleKeys.has(key)) return;
    if (rectangles.length >= MAX_RECTS) throw new Error('visual mask limit reached');
    rectangleKeys.add(key);
    rectangles.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  };
  const sameRect = (a: { x: number; y: number; width: number; height: number } | null, b: { x: number; y: number; width: number; height: number }): boolean =>
    a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  /** The pixels a node's text occupies. `already` is a rectangle just appended: not repeated. */
  const appendTextRects = (node: Node, already: { x: number; y: number; width: number; height: number } | null = null): void => {
    const range = win.document.createRange(); range.selectNodeContents(node);
    if (typeof range.getClientRects !== 'function') {
      const owner = node.nodeType === win.Node.ELEMENT_NODE ? node as Element : owningElement(node);
      const rect = owner?.getBoundingClientRect();
      if (rect && !sameRect(already, rect)) append(rect);
      return;
    }
    for (const rect of range.getClientRects()) if (!sameRect(already, rect)) append(rect);
  };
  const maskSubtree = (root: Node, already: { x: number; y: number; width: number; height: number } | null): void => {
    const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (maskedNodes.has(node)) continue;
      maskedNodes.add(node);
      if (++maskedVisits > MAX_NODES) throw new Error('visual mask DOM limit reached');
      if (node.nodeType === win.Node.ELEMENT_NODE) {
        const element = node as Element;
        if (NON_RENDERED_TAGS.has(element.tagName.toUpperCase())) continue;
        if (node !== root) append(element.getBoundingClientRect());
        if (element.shadowRoot) pending.push(element.shadowRoot);
      } else if (node.nodeType === win.Node.TEXT_NODE) appendTextRects(node, already);
      for (const child of node.childNodes) pending.push(child);
    }
  };
  const maskElement = (element: Element): void => {
    const rect = element.getBoundingClientRect();
    if (isMediaTag(element.tagName)) {
      // One rectangle covers the children of an svg/picture; only visible-size media hides anything.
      if (shouldMaskMedia(rect)) append(rect);
      return;
    }
    append(rect);
    maskSubtree(element, rect);
  };
  /** Text directly under a shadow root has no parentElement: its host stands in for it. */
  const owningElement = (text: Node): Element | null =>
    text.parentElement ?? (text.parentNode instanceof win.ShadowRoot ? text.parentNode.host : null);
  const maskSensitiveText = (text: Node): void => {
    const block = sensitiveBlockAncestor(owningElement(text) as unknown as MaskBlockNode | null) as unknown as Element | null;
    const rect = block?.getBoundingClientRect();
    // Bloco sem caixa (display:none, sem layout) não esconde nada: o texto cai nos próprios retângulos.
    const usable = rect !== undefined && rect.width > 0 && rect.height > 0 && area(rect) <= viewportArea * MAX_BLOCK_VIEWPORT_SHARE;
    if (usable) append(rect);
    if (block) maskSubtree(block, usable ? rect : null);
    // O texto pode ser desenhado fora da caixa do bloco (overflow visível, coluna estreita): os próprios retângulos entram sempre.
    appendTextRects(text, usable ? rect : null);
  };
  /**
   * Segredo partido por marcação (`<span>sk_live_</span><span>…</span>`): só o texto junto o revela. Só
   * elementos "folha" (filhos sem filhos) são juntados, então cada nó de texto é lido uma vez: custo linear.
   */
  const maskSplitSecret = (element: Element): void => {
    if (element.childNodes.length < 2 || element.childNodes.length > SPLIT_SECRET_MAX_CHILD_NODES || element.childElementCount === 0) return;
    for (const child of element.children) if (child.childElementCount > 0) return;
    let joined = '';
    for (const child of element.childNodes) {
      if (child.nodeType === win.Node.ELEMENT_NODE && NON_RENDERED_TAGS.has((child as Element).tagName.toUpperCase())) continue;
      joined += child.textContent ?? '';
      if (joined.length > SPLIT_SECRET_MAX_CHARS) return;
    }
    if (!hasSecretShape(joined)) return;
    appendTextRects(element);
  };
  const visitText = (node: Node): void => {
    const parent = owningElement(node);
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
      maskSplitSecret(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(win.document);
  return { width: win.innerWidth, height: win.innerHeight, scrollX: win.scrollX, scrollY: win.scrollY, rectangles };
}

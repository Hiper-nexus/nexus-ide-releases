import type { BrowserVisualMasks, BrowserVisualRect } from '../shared/browser-visual';
import { isSensitiveBrowserMarker, redactBrowserText } from '../shared/browser-redaction';

const MAX_NODES = 50_000;
const MAX_RECTS = 2_000;
const OPAQUE_SELECTOR = 'input,textarea,select,[contenteditable],[role="textbox"],iframe,canvas,object,embed';

function sensitiveElement(element: Element): boolean {
  return element.matches(OPAQUE_SELECTOR) || [...element.attributes].some(attribute =>
    isSensitiveBrowserMarker(attribute.name) ||
    ['id', 'class', 'name', 'aria-label', 'autocomplete'].includes(attribute.name) && isSensitiveBrowserMarker(attribute.value));
}

/** Only geometry leaves the isolated world. Frames and canvas are opaque. */
export function collectBrowserVisualMasks(win: Window & typeof globalThis): BrowserVisualMasks {
  const rectangles: BrowserVisualRect[] = [];
  let visited = 0;
  const append = (rect: DOMRect): void => {
    if (rect.width <= 0 || rect.height <= 0) return;
    if (rectangles.length >= MAX_RECTS) throw new Error('visual mask limit reached');
    rectangles.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  };
  const walk = (root: Node): void => {
    const walker = win.document.createTreeWalker(root, win.NodeFilter.SHOW_ELEMENT | win.NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (++visited > MAX_NODES) throw new Error('visual DOM limit reached');
      if (node.nodeType === win.Node.ELEMENT_NODE) {
        const element = node as Element;
        if (sensitiveElement(element)) {
          append(element.getBoundingClientRect());
          for (const child of element.querySelectorAll('*')) append(child.getBoundingClientRect());
        }
        if (element.shadowRoot) walk(element.shadowRoot);
      } else {
        const text = node.textContent ?? '';
        if (redactBrowserText(text) !== text) {
          const range = win.document.createRange(); range.selectNodeContents(node);
          for (const rect of range.getClientRects()) append(rect);
        }
      }
    }
  };
  walk(win.document);
  return { width: win.innerWidth, height: win.innerHeight, scrollX: win.scrollX, scrollY: win.scrollY, rectangles };
}

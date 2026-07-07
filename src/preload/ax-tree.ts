/**
 * Accessibility tree extractor — Fase 5 Jarvis Vision.
 * Runs in the preload context, exposed to the renderer via contextBridge.
 * Extracts a simplified DOM + ARIA tree from the current page.
 */
import type { AxNode } from '../shared/vision-ipc';

const MAX_DEPTH = 10;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD']);

function isHidden(el: Element): boolean {
  const style = window.getComputedStyle(el);
  return (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    el.getAttribute('aria-hidden') === 'true'
  );
}

function extractNode(el: Element, depth: number): AxNode | null {
  if (depth > MAX_DEPTH) return null;
  if (SKIP_TAGS.has(el.tagName)) return null;
  if (isHidden(el)) return null;

  const tag = el.tagName.toLowerCase();

  // ARIA attributes
  const aria: Record<string, string> = {};
  const ariaKeys = [
    'role', 'label', 'labelledby', 'describedby', 'level',
    'disabled', 'hidden', 'expanded', 'pressed', 'selected',
    'checked', 'valuenow', 'valuemin', 'valuemax', 'valuetext',
    'haspopup', 'current', 'live', 'atomic', 'relevant',
    'orientation', 'modal', 'multiline', 'multiselectable',
    'readonly', 'required', 'sort',
  ];
  for (const key of ariaKeys) {
    const value = el.getAttribute(`aria-${key}`);
    if (value !== null) {
      aria[key] = value;
    }
  }

  // Role
  const role = el.getAttribute('role') ?? el.getAttribute('aria-role') ?? null;

  // Direct text content (only immediate text nodes, not children)
  let text: string | null = null;
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent?.trim();
      if (t) {
        text = (text ? text + ' ' : '') + t;
      }
    }
  }
  // If no direct text, use a short snippet from full textContent
  if (!text) {
    const full = el.textContent?.trim().slice(0, 200) || null;
    if (full) text = full;
  }

  // Children
  const children: AxNode[] = [];
  for (const child of el.children) {
    const node = extractNode(child, depth + 1);
    if (node) children.push(node);
  }

  return { tag, role, aria, text, children };
}

/**
 * Extract the accessibility tree from the current document.
 * Called from the renderer via window.nexus.vision.getAxTree().
 */
export function getAxTree(): AxNode {
  if (!document.body) {
    return { tag: 'html', role: null, aria: {}, text: null, children: [] };
  }
  const root = extractNode(document.body, 0);
  return (
    root ?? { tag: 'body', role: null, aria: {}, text: null, children: [] }
  );
}

/**
 * Floating UI over a native browser view.
 *
 * A WebContentsView is a native sibling of the renderer, so it paints above
 * every DOM node and no `z-index` can reach it. A popover, menu or modal that
 * crosses a browser slot ends up hidden behind the page and cannot be clicked.
 *
 * Instead of each popover announcing itself, the probe reads the contract
 * those surfaces already keep for assistive tech: the `dialog`, `alertdialog`,
 * `menu` and `listbox` roles and `aria-modal`. A new popover that carries the
 * right role is covered without touching this file.
 */

export const FLOATING_SURFACE_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]';

export interface FloatingSurface {
  element: Element;
  rect: { left: number; top: number; right: number; bottom: number };
  /** `aria-modal`: blocks the whole app, not only what its box covers. */
  modal: boolean;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Surfaces on screen right now. Reads layout; call once per sync batch. */
export function collectFloatingSurfaces(): FloatingSurface[] {
  const surfaces: FloatingSurface[] = [];
  for (const element of document.querySelectorAll(FLOATING_SURFACE_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    // display:none and detached boxes measure 0x0; visibility:hidden keeps its box.
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (getComputedStyle(element).visibility === 'hidden') continue;
    surfaces.push({
      element,
      rect,
      modal: element.getAttribute('aria-modal') === 'true',
    });
  }
  return surfaces;
}

/**
 * True when a surface would be painted under the native view at `view`. A
 * surface that wraps the slot (or lives inside it) is the pane's own frame,
 * not something on top of it.
 */
export function isCoveredByFloatingSurface(
  view: Box,
  slot: Element,
  surfaces: readonly FloatingSurface[],
): boolean {
  const right = view.x + view.width;
  const bottom = view.y + view.height;
  return surfaces.some(({ element, rect, modal }) => {
    if (element.contains(slot) || slot.contains(element)) return false;
    return (
      modal ||
      (rect.left < right &&
        rect.right > view.x &&
        rect.top < bottom &&
        rect.bottom > view.y)
    );
  });
}

function touchesSurface(node: Node): boolean {
  return (
    node.nodeType === 1 &&
    ((node as Element).matches(FLOATING_SURFACE_SELECTOR) ||
      (node as Element).querySelector(FLOATING_SURFACE_SELECTOR) !== null)
  );
}

function concernsSurface(record: MutationRecord): boolean {
  if (record.type === 'attributes') {
    // Losing the role leaves nothing to match, so these two always count.
    return (
      record.attributeName === 'role' ||
      record.attributeName === 'aria-modal' ||
      touchesSurface(record.target)
    );
  }
  // Content added to an open surface can make it grow over a view.
  if (
    record.target.nodeType === 1 &&
    (record.target as Element).closest(FLOATING_SURFACE_SELECTOR)
  ) {
    return true;
  }
  return (
    Array.from(record.addedNodes).some(touchesSurface) ||
    Array.from(record.removedNodes).some(touchesSurface)
  );
}

/**
 * Calls `onChange` (in the mutation microtask, before the next paint) when a
 * floating surface appears, disappears or changes. Style/class churn is NOT
 * observed on purpose: it is constant and a popover that is shown by CSS alone
 * is picked up by the next regular bounds sync instead.
 */
export function watchFloatingSurfaces(onChange: () => void): () => void {
  const observer = new MutationObserver((records) => {
    if (records.some(concernsSurface)) onChange();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['role', 'aria-modal', 'hidden', 'open', 'inert'],
  });
  return () => observer.disconnect();
}

import type {
  BrowserDesignAnnotationMarker,
  BrowserDesignRect,
} from '../shared/browser-design';
import { DESIGN_ANNOTATION_LIMITS } from '../shared/browser-design';

/**
 * In-page numbered badges for design annotations (Orca Design Mode parity).
 *
 * Adapted from stablyai/orca at commit
 * 5e100914d3f557953c810da36448986a87efec14
 * (`src/shared/browser-annotation-viewport-bridge.ts` — the persisted-badge
 * overlay). Copyright (c) 2026 Lovecast Inc. Licensed under the MIT License;
 * see third_party/licenses/orca-MIT.txt. Nexus changes: Orca injects a JS
 * string template into the page and mirrors viewport geometry over console
 * messages; Nexus keeps its preload-module architecture — the layer is a
 * TypeScript module in the pane's ISOLATED world, driven only by the closed
 * automation channel, and carries geometry plus an advisory selector ONLY
 * (no comments, no element data ever reach the page side). Badges track the
 * LIVE element box when the selector still resolves (reflow/breakpoint/sticky
 * safe) and fall back to the frozen selection-time rects otherwise.
 *
 * Deliberately independent from the design-mode picker overlay: annotations
 * survive toggling the picker off, so their badges must too.
 */

type BrowserDomWindow = Window & typeof globalThis;

export const DESIGN_ANNOTATION_HOST_ID = 'nexus-design-annotation-host';

const MAX_MARKERS = DESIGN_ANNOTATION_LIMITS.maxPerPane;
const MAX_MARKER_ID_CHARS = 64;
const MAX_MARKER_SELECTOR_CHARS = 1_024;
const MARKER_SIZE = 24;
const MAX_COORD = 10_000_000;

export interface AnnotationMarkerLayer {
  set(markers: BrowserDesignAnnotationMarker[]): {
    applied: true;
    markers: number;
  };
}

function finiteCoord(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_COORD
  );
}

function parseRect(raw: unknown): BrowserDesignRect {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('annotation marker rect is invalid');
  }
  const rect = raw as Record<string, unknown>;
  if (
    !finiteCoord(rect.x) ||
    !finiteCoord(rect.y) ||
    !finiteCoord(rect.width) ||
    !finiteCoord(rect.height) ||
    (rect.width as number) < 0 ||
    (rect.height as number) < 0
  ) {
    throw new Error('annotation marker rect is invalid');
  }
  return {
    x: rect.x as number,
    y: rect.y as number,
    width: rect.width as number,
    height: rect.height as number,
  };
}

/** Strict page-side validation — the channel is closed but still crosses a
 * process boundary, so args are treated exactly like every other command's. */
export function parseAnnotationMarkers(
  raw: unknown,
): BrowserDesignAnnotationMarker[] {
  if (!Array.isArray(raw) || raw.length > MAX_MARKERS) {
    throw new Error(
      `annotation markers must be an array of at most ${MAX_MARKERS}`,
    );
  }
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('annotation marker is invalid');
    }
    const marker = entry as Record<string, unknown>;
    if (
      typeof marker.id !== 'string' ||
      marker.id.length === 0 ||
      marker.id.length > MAX_MARKER_ID_CHARS
    ) {
      throw new Error('annotation marker id is invalid');
    }
    if (
      typeof marker.index !== 'number' ||
      !Number.isInteger(marker.index) ||
      marker.index < 0 ||
      marker.index >= 100
    ) {
      throw new Error('annotation marker index is invalid');
    }
    if (
      marker.selector !== undefined &&
      (typeof marker.selector !== 'string' ||
        marker.selector.length > MAX_MARKER_SELECTOR_CHARS)
    ) {
      throw new Error('annotation marker selector is invalid');
    }
    return {
      id: marker.id,
      index: marker.index,
      rectPage: parseRect(marker.rectPage),
      rectViewport: parseRect(marker.rectViewport),
      isFixed: marker.isFixed === true,
      ...(marker.selector ? { selector: marker.selector } : {}),
    };
  });
}

export function createAnnotationMarkerLayer(
  win: BrowserDomWindow,
): AnnotationMarkerLayer {
  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let markers: BrowserDesignAnnotationMarker[] = [];
  const badges = new Map<string, HTMLElement>();
  /** Live element per marker id — null after a failed resolution. */
  const elements = new Map<string, Element | null>();
  let raf = 0;

  function teardown(): void {
    if (raf) {
      win.cancelAnimationFrame?.(raf);
      raf = 0;
    }
    if (host) {
      win.removeEventListener('scroll', requestUpdate, true);
      win.removeEventListener('resize', requestUpdate, true);
    }
    host?.remove();
    host = null;
    shadow = null;
    badges.clear();
    elements.clear();
    markers = [];
  }

  function ensureOverlay(): ShadowRoot | null {
    if (host && shadow) return shadow;
    const doc = win.document;
    const root = doc.documentElement;
    if (!root) return null;
    host = doc.createElement('div');
    host.id = DESIGN_ANNOTATION_HOST_ID;
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.pointerEvents = 'none';
    // One below the picker overlay so hover labels keep reading above badges.
    host.style.zIndex = '2147483646';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = [
      '.nx-badge{box-sizing:border-box;position:fixed;top:0;left:0;',
      `width:${MARKER_SIZE}px;height:${MARKER_SIZE}px;display:flex;`,
      'align-items:center;justify-content:center;border-radius:9999px;',
      'border:1px solid rgba(255,255,255,0.95);background:#2f6ae0;color:#fff;',
      'font:600 11px/1 ui-monospace,monospace;',
      'box-shadow:0 2px 8px rgba(0,0,0,0.35);pointer-events:none;',
      'user-select:none;will-change:transform;}',
    ].join('');
    shadow.appendChild(style);
    root.appendChild(host);
    // Listener lifetime == host lifetime (attached on mount, removed in
    // teardown) — no separate flag to fall out of sync.
    win.addEventListener('scroll', requestUpdate, true);
    win.addEventListener('resize', requestUpdate, true);
    return shadow;
  }

  function scrollOffsets(): { x: number; y: number } {
    const x = typeof win.scrollX === 'number' ? win.scrollX : 0;
    const y = typeof win.scrollY === 'number' ? win.scrollY : 0;
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    };
  }

  function resolveElement(marker: BrowserDesignAnnotationMarker): Element | null {
    const cached = elements.get(marker.id);
    if (cached && cached.isConnected) return cached;
    if (!marker.selector) return null;
    try {
      const element = win.document.querySelector(marker.selector);
      elements.set(marker.id, element);
      return element;
    } catch {
      elements.set(marker.id, null);
      return null;
    }
  }

  /** Viewport-space box for a marker: the LIVE element when it resolves
   * (reflow/sticky safe), else the frozen selection-time geometry. */
  function viewportBox(
    marker: BrowserDesignAnnotationMarker,
    scroll: { x: number; y: number },
  ): { x: number; y: number; width: number; height: number } {
    const element = resolveElement(marker);
    if (element) {
      const rect = element.getBoundingClientRect();
      // Zero-size boxes mean "hidden/unmounted" far more often than a real
      // 0×0 element — fall back to the frozen rect instead of stacking
      // badges at a collapsed point.
      if (rect.width > 0 || rect.height > 0) {
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    const source = marker.isFixed ? marker.rectViewport : marker.rectPage;
    return {
      x: marker.isFixed ? source.x : source.x - scroll.x,
      y: marker.isFixed ? source.y : source.y - scroll.y,
      width: source.width,
      height: source.height,
    };
  }

  function position(): void {
    if (!markers.length) return;
    const scroll = scrollOffsets();
    const viewportWidth = win.innerWidth || 0;
    const viewportHeight = win.innerHeight || 0;
    for (const marker of markers) {
      const badge = badges.get(marker.id);
      if (!badge) continue;
      const box = viewportBox(marker, scroll);
      const visible =
        box.x + box.width >= 0 &&
        box.y + box.height >= 0 &&
        box.x <= viewportWidth &&
        box.y <= viewportHeight;
      if (!visible) {
        badge.style.display = 'none';
        continue;
      }
      badge.style.display = 'flex';
      // Bottom-center of the element, like Orca's badge anchoring.
      const bx = box.x + box.width / 2 - MARKER_SIZE / 2;
      const by = box.y + box.height - MARKER_SIZE / 2;
      badge.style.transform = `translate(${bx}px, ${by}px)`;
    }
  }

  function requestUpdate(): void {
    if (raf) return;
    const schedule = win.requestAnimationFrame?.bind(win);
    if (!schedule) {
      position();
      return;
    }
    raf = schedule(() => {
      raf = 0;
      position();
    });
  }

  function set(next: BrowserDesignAnnotationMarker[]): {
    applied: true;
    markers: number;
  } {
    if (next.length === 0) {
      teardown();
      return { applied: true, markers: 0 };
    }
    const target = ensureOverlay();
    if (!target) return { applied: true, markers: 0 };
    markers = next;
    const live = new Set<string>();
    for (const marker of markers) {
      live.add(marker.id);
      let badge = badges.get(marker.id);
      if (!badge) {
        badge = win.document.createElement('span');
        badge.className = 'nx-badge';
        target.appendChild(badge);
        badges.set(marker.id, badge);
      }
      badge.textContent = String(marker.index + 1);
    }
    for (const [id, badge] of badges) {
      if (!live.has(id)) {
        badge.remove();
        badges.delete(id);
        elements.delete(id);
      }
    }
    position();
    return { applied: true, markers: markers.length };
  }

  return { set };
}

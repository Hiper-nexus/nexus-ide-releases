import type {
  BrowserDesignAnnotationMarker,
  BrowserDesignRect,
} from '../shared/browser-design';

/**
 * In-page numbered badges for design annotations (Orca Design Mode parity).
 *
 * Adapted from stablyai/orca at commit
 * 5e100914d3f557953c810da36448986a87efec14
 * (`src/shared/browser-annotation-viewport-bridge.ts` — the persisted-badge
 * overlay). Copyright (c) 2026 Lovecast Inc. Licensed under the MIT License;
 * see third_party/licenses/orca-MIT.txt. Nexus changes: Orca injects a JS
 * string template into the page and mirrors viewport geometry back over
 * console messages; Nexus keeps its preload-module architecture — the layer
 * is a TypeScript module in the pane's ISOLATED world, driven only by the
 * closed automation channel, and carries geometry ONLY (no comments, no
 * element data ever reach the page side).
 *
 * Deliberately independent from the design-mode picker overlay: annotations
 * survive toggling the picker off, so their badges must too.
 */

type BrowserDomWindow = Window & typeof globalThis;

export const DESIGN_ANNOTATION_HOST_ID = 'nexus-design-annotation-host';

/** Mirrors DESIGN_ANNOTATION_LIMITS.maxPerPane; enforced page-side too. */
const MAX_MARKERS = 20;
const MAX_MARKER_ID_CHARS = 64;
const MARKER_SIZE = 24;
const MAX_COORD = 10_000_000;

export interface AnnotationMarkerLayer {
  set(markers: BrowserDesignAnnotationMarker[]): {
    applied: true;
    markers: number;
  };
  count(): number;
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
    throw new Error('annotation markers must be an array of at most 20');
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
    return {
      id: marker.id,
      index: marker.index,
      rectPage: parseRect(marker.rectPage),
      rectViewport: parseRect(marker.rectViewport),
      isFixed: marker.isFixed === true,
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
  let raf = 0;
  let listening = false;

  function teardown(): void {
    if (raf) {
      win.cancelAnimationFrame?.(raf);
      raf = 0;
    }
    if (listening) {
      win.removeEventListener('scroll', requestUpdate, true);
      win.removeEventListener('resize', requestUpdate, true);
      listening = false;
    }
    host?.remove();
    host = null;
    shadow = null;
    badges.clear();
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

  function position(): void {
    if (!markers.length) return;
    const scroll = scrollOffsets();
    const viewportWidth = win.innerWidth || 0;
    const viewportHeight = win.innerHeight || 0;
    for (const marker of markers) {
      const badge = badges.get(marker.id);
      if (!badge) continue;
      const source = marker.isFixed ? marker.rectViewport : marker.rectPage;
      const x = marker.isFixed ? source.x : source.x - scroll.x;
      const y = marker.isFixed ? source.y : source.y - scroll.y;
      const visible =
        x + source.width >= 0 &&
        y + source.height >= 0 &&
        x <= viewportWidth &&
        y <= viewportHeight;
      if (!visible) {
        badge.style.display = 'none';
        continue;
      }
      badge.style.display = 'flex';
      // Bottom-center of the element, like Orca's badge anchoring.
      const bx = x + source.width / 2 - MARKER_SIZE / 2;
      const by = y + source.height - MARKER_SIZE / 2;
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
      }
    }
    if (!listening) {
      win.addEventListener('scroll', requestUpdate, true);
      win.addEventListener('resize', requestUpdate, true);
      listening = true;
    }
    position();
    return { applied: true, markers: markers.length };
  }

  return {
    set,
    count: () => markers.length,
  };
}

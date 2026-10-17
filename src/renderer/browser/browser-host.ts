import type { BrowserPaneState, PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import {
  collectFloatingSurfaces,
  isCoveredByFloatingSurface,
  watchFloatingSurfaces,
  type FloatingSurface,
} from './browser-occlusion';
import { applyViewportOverride } from './viewport-override';

interface BrowserHost {
  paneId: string;
  created: boolean;
}

interface CreationWaiter {
  resolve: (state: BrowserPaneState) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CREATE_TIMEOUT_MS = 25_000;
const hosts = new Map<string, BrowserHost>();
const attachedSlots = new Map<string, HTMLElement>();
const suppressionReasons = new Set<string>();
/** Panes whose native view is hidden only because a popover/menu/modal crosses it. */
const coveredPanes = new Set<string>();
let stopSurfaceWatch: (() => void) | null = null;
/** Breakpoint preview widths per pane (F4); null/absent = full slot. */
const viewportOverrides = new Map<string, number>();
const lastStates = new Map<string, BrowserPaneState>();
const creationWaiters = new Map<string, CreationWaiter[]>();
let pendingBoundsFrame: number | null = null;

export function boundsOf(slot: HTMLElement): {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
} {
  const rect = slot.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = Math.max(0, rect.left);
  let y = Math.max(0, rect.top);
  let right = Math.min(vw, rect.right);
  let bottom = Math.min(vh, rect.bottom);
  // Native views are siblings of the renderer, so CSS overflow does not clip
  // them. Intersect each clipping ancestor's client box (excluding its border
  // and scrollbars), independently per axis, in window coordinates.
  const clips = /^(auto|scroll|hidden|clip|overlay)$/;
  for (let parent = slot.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clipX = clips.test(style.overflowX || style.overflow);
    const clipY = clips.test(style.overflowY || style.overflow);
    if (!clipX && !clipY) continue;
    const box = parent.getBoundingClientRect();
    const scaleX = parent.offsetWidth > 0 ? box.width / parent.offsetWidth : 1;
    const scaleY = parent.offsetHeight > 0 ? box.height / parent.offsetHeight : 1;
    const left = box.left + parent.clientLeft * scaleX;
    const top = box.top + parent.clientTop * scaleY;
    if (clipX) {
      x = Math.max(x, left);
      right = Math.min(right, left + parent.clientWidth * scaleX);
    }
    if (clipY) {
      y = Math.max(y, top);
      bottom = Math.min(bottom, top + parent.clientHeight * scaleY);
    }
  }
  const width = Math.max(0, right - x);
  const height = Math.max(0, bottom - y);
  return {
    x,
    y,
    width,
    height,
    visible: width > 8 && height > 8,
  };
}

/**
 * The native view hides while the app suppresses it (other destination, hard
 * modal) OR while a floating surface crosses it: the page would paint over the
 * surface and swallow its clicks. Only the view that is crossed hides, so a
 * menu elsewhere on screen never blanks a page the operator is reading.
 */
function suppressedBounds(
  paneId: string,
  slot: HTMLElement,
  surfaces?: readonly FloatingSurface[],
): ReturnType<typeof boundsOf> {
  const bounds = boundsOf(slot);
  const suppressed = suppressionReasons.size > 0;
  const covered =
    !suppressed &&
    bounds.visible &&
    isCoveredByFloatingSurface(bounds, slot, surfaces ?? collectFloatingSurfaces());
  if (covered) coveredPanes.add(paneId);
  else coveredPanes.delete(paneId);
  return {
    ...bounds,
    visible: bounds.visible && !suppressed && !covered,
  };
}

function syncPaneBounds(
  paneId: string,
  slot: HTMLElement,
  surfaces?: readonly FloatingSurface[],
): void {
  window.nexus.browser.setBounds(
    paneId,
    applyViewportOverride(
      suppressedBounds(paneId, slot, surfaces),
      viewportOverrides.get(paneId) ?? null,
    ),
  );
}

/** One DOM scan shared by every slot of the batch. */
function syncAllPaneBounds(): void {
  const surfaces =
    suppressionReasons.size === 0 ? collectFloatingSurfaces() : undefined;
  for (const [paneId, slot] of attachedSlots) {
    syncPaneBounds(paneId, slot, surfaces);
  }
}

/**
 * A floating surface appeared, went away or changed: resync only the panes
 * whose covered state flips (the common case is none, so no IPC).
 */
function refreshOcclusion(): void {
  if (suppressionReasons.size > 0) return;
  const surfaces = collectFloatingSurfaces();
  for (const [paneId, slot] of attachedSlots) {
    const bounds = boundsOf(slot);
    const covered =
      bounds.visible && isCoveredByFloatingSurface(bounds, slot, surfaces);
    if (covered !== coveredPanes.has(paneId)) {
      syncPaneBounds(paneId, slot, surfaces);
    }
  }
}

/**
 * React Flow moves panes with CSS transforms. Those transforms do not fire a
 * ResizeObserver, so native WebContentsViews otherwise stay at their previous
 * screen coordinates and bleed outside the visual pane. Coalesce all move,
 * drag and zoom notifications into the next painted frame.
 */
export function scheduleBrowserPaneBoundsSync(): void {
  if (pendingBoundsFrame !== null) return;
  pendingBoundsFrame = requestAnimationFrame(() => {
    pendingBoundsFrame = null;
    syncAllPaneBounds();
  });
}

/** Breakpoint preview (F4): narrow the view to `width` CSS px (null = full). */
export function setBrowserViewportOverride(
  paneId: string,
  width: number | null,
): void {
  if (width) {
    viewportOverrides.set(paneId, width);
  } else {
    viewportOverrides.delete(paneId);
  }
  const slot = attachedSlots.get(paneId);
  if (slot) syncPaneBounds(paneId, slot);
}

export function getBrowserViewportOverride(paneId: string): number | null {
  return viewportOverrides.get(paneId) ?? null;
}

function ensureHost(pane: PaneModel): BrowserHost {
  let host = hosts.get(pane.id);
  if (host) return host;
  host = { paneId: pane.id, created: false };
  hosts.set(pane.id, host);
  return host;
}

function settleCreation(
  paneId: string,
  outcome:
    | { ok: true; state: BrowserPaneState }
    | { ok: false; error: Error },
): void {
  const waiters = creationWaiters.get(paneId);
  if (!waiters) return;
  creationWaiters.delete(paneId);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    if (outcome.ok) {
      waiter.resolve(outcome.state);
    } else {
      waiter.reject(outcome.error);
    }
  }
}

export function waitForBrowserPaneCreated(
  paneId: string,
  timeoutMs = CREATE_TIMEOUT_MS,
): Promise<BrowserPaneState> {
  const state = lastStates.get(paneId);
  if (hosts.get(paneId)?.created && state) return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiters = creationWaiters.get(paneId) ?? [];
      creationWaiters.set(
        paneId,
        waiters.filter((waiter) => waiter.timer !== timer),
      );
      if (creationWaiters.get(paneId)?.length === 0) {
        creationWaiters.delete(paneId);
      }
      reject(new Error('browser pane creation timed out'));
    }, timeoutMs);
    const waiters = creationWaiters.get(paneId) ?? [];
    waiters.push({ resolve, reject, timer });
    creationWaiters.set(paneId, waiters);
  });
}

export function attachBrowserPane(
  pane: PaneModel,
  slot: HTMLElement,
  onState: (state: BrowserPaneState) => void,
): () => void {
  const host = ensureHost(pane);
  let disposed = false;

  const syncBounds = () => {
    if (disposed) return;
    syncPaneBounds(pane.id, slot);
  };

  const rafIds: number[] = [];
  /**
   * WebContentsView bounds must be applied AFTER create resolves. Early
   * setBounds IPC is stashed on main (pendingBounds) until create finishes.
   */
  const syncBoundsAfterLayout = () => {
    if (disposed) return;
    syncBounds();
    const id1 = requestAnimationFrame(() => {
      if (disposed) return;
      syncBounds();
      // Second frame: flex/grid often settles height after first paint.
      const id2 = requestAnimationFrame(syncBounds);
      rafIds.push(id2);
    });
    rafIds.push(id1);
  };

  if (!host.created) {
    host.created = true;
    void window.nexus.browser
      .create(pane.id, pane.browserUrl)
      .then((state) => {
        lastStates.set(pane.id, state);
        settleCreation(pane.id, { ok: true, state });
        if (!disposed) {
          onState(state);
          syncBoundsAfterLayout();
        }
      })
      .catch((err) => {
        host.created = false;
        const error = err instanceof Error ? err : new Error(String(err));
        settleCreation(pane.id, { ok: false, error });
        if (!disposed) {
          onState({
            paneId: pane.id,
            url: pane.browserUrl ?? 'about:blank',
            title: 'browser',
            canGoBack: false,
            canGoForward: false,
            loading: false,
            error: error.message,
          });
        }
      });
  } else {
    // Re-attach (HMR / remount): view already exists — push geometry now.
    syncBoundsAfterLayout();
  }

  const unsub = window.nexus.browser.onState((state) => {
    if (state.paneId !== pane.id) return;
    lastStates.set(pane.id, state);
    onState(state);
    if (state.url) {
      useLayoutStore.getState().setBrowserUrl(pane.id, state.url);
    }
    if (state.title && state.title !== 'about:blank') {
      useLayoutStore.getState().setTitle(pane.id, state.title);
    }
  });

  const ro = new ResizeObserver(syncBounds);
  const focusPane = () => useLayoutStore.getState().focus(pane.id);
  if (attachedSlots.size === 0) {
    // Scroll does not bubble. Capture also covers ancestors introduced by a
    // reparent without installing one listener for every scroll container.
    window.addEventListener('scroll', scheduleBrowserPaneBoundsSync, { capture: true, passive: true });
    stopSurfaceWatch = watchFloatingSurfaces(refreshOcclusion);
  }
  attachedSlots.set(pane.id, slot);
  ro.observe(slot);
  window.addEventListener('resize', syncBounds);
  slot.addEventListener('mousedown', focusPane);
  // Optimistic early sync (no-op until create finishes); real fix is post-create.
  syncBounds();
  requestAnimationFrame(syncBounds);

  return () => {
    disposed = true;
    for (const id of rafIds) cancelAnimationFrame(id);
    ro.disconnect();
    window.removeEventListener('resize', syncBounds);
    slot.removeEventListener('mousedown', focusPane);
    if (attachedSlots.get(pane.id) === slot) {
      attachedSlots.delete(pane.id);
      coveredPanes.delete(pane.id);
    }
    if (attachedSlots.size === 0) {
      stopSurfaceWatch?.();
      stopSurfaceWatch = null;
      window.removeEventListener('scroll', scheduleBrowserPaneBoundsSync, true);
      if (pendingBoundsFrame !== null) cancelAnimationFrame(pendingBoundsFrame);
      pendingBoundsFrame = null;
    }
    window.nexus.browser.setBounds(pane.id, {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      visible: false,
    });
    unsub();
  };
}

export function reconcileBrowserPanes(liveIds: Set<string>): void {
  for (const [paneId] of hosts) {
    if (!liveIds.has(paneId)) {
      window.nexus.browser.destroy(paneId);
      hosts.delete(paneId);
      lastStates.delete(paneId);
      settleCreation(paneId, {
        ok: false,
        error: new Error('browser pane was removed before creation'),
      });
    }
  }
}

export function setBrowserPaneSuppression(reason: string, active: boolean): void {
  const before = suppressionReasons.size;
  if (active) {
    suppressionReasons.add(reason);
  } else {
    suppressionReasons.delete(reason);
  }
  if (suppressionReasons.size === before) return;
  syncAllPaneBounds();
}

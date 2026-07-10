import type { BrowserPaneState, PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
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
/** Breakpoint preview widths per pane (F4); null/absent = full slot. */
const viewportOverrides = new Map<string, number>();
const lastStates = new Map<string, BrowserPaneState>();
const creationWaiters = new Map<string, CreationWaiter[]>();

function boundsOf(slot: HTMLElement): {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
} {
  const rect = slot.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = Math.max(0, rect.left);
  const y = Math.max(0, rect.top);
  const right = Math.min(vw, rect.right);
  const bottom = Math.min(vh, rect.bottom);
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

function suppressedBounds(slot: HTMLElement): ReturnType<typeof boundsOf> {
  const bounds = boundsOf(slot);
  return {
    ...bounds,
    visible: bounds.visible && suppressionReasons.size === 0,
  };
}

function syncPaneBounds(paneId: string, slot: HTMLElement): void {
  window.nexus.browser.setBounds(
    paneId,
    applyViewportOverride(
      suppressedBounds(slot),
      viewportOverrides.get(paneId) ?? null,
    ),
  );
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

  if (!host.created) {
    host.created = true;
    void window.nexus.browser
      .create(pane.id, pane.browserUrl)
      .then((state) => {
        lastStates.set(pane.id, state);
        settleCreation(pane.id, { ok: true, state });
        if (!disposed) onState(state);
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
  attachedSlots.set(pane.id, slot);
  ro.observe(slot);
  window.addEventListener('resize', syncBounds);
  slot.addEventListener('mousedown', focusPane);
  syncBounds();
  requestAnimationFrame(syncBounds);

  return () => {
    disposed = true;
    ro.disconnect();
    window.removeEventListener('resize', syncBounds);
    slot.removeEventListener('mousedown', focusPane);
    if (attachedSlots.get(pane.id) === slot) attachedSlots.delete(pane.id);
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
  for (const [paneId, slot] of attachedSlots) {
    syncPaneBounds(paneId, slot);
  }
}

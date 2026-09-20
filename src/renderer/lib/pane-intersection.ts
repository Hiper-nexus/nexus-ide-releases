/**
 * IntersectionObserver reports `isIntersecting: false` both when a pane
 * scrolled off the mosaic AND when an ancestor is `display:none` (Settings,
 * Missions). Chromium often keeps the LAST non-zero box in that second
 * case, so a 0×0 check is not enough.
 *
 * Treating that as "off-screen" hid the xterm (`visibility: hidden`) and
 * often never got a second callback when the workspace came back — the
 * operator's live pane vanished until they spawned another pane (which
 * resized the grid and retriggered IO). F-603.
 */
export function paneSlotIsLaidOut(rect: {
  readonly width: number;
  readonly height: number;
}): boolean {
  return rect.width > 0 && rect.height > 0;
}

export function paneIntersectionApplies(entry: {
  readonly boundingClientRect: {
    readonly width: number;
    readonly height: number;
  };
  readonly target: EventTarget | null;
}): boolean {
  if (!paneSlotIsLaidOut(entry.boundingClientRect)) return false;
  return !(
    entry.target instanceof Element && entry.target.closest('[hidden]') !== null
  );
}

const revealListeners = new Set<() => void>();

export function subscribePaneWorkspaceReveal(listener: () => void): () => void {
  revealListeners.add(listener);
  return () => {
    revealListeners.delete(listener);
  };
}

export function notifyPaneWorkspaceReveal(): void {
  for (const listener of revealListeners) listener();
}

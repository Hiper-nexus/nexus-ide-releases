export interface ActivateWindowState {
  readonly isShutdownInProgress: boolean;
  readonly isShutdownComplete: boolean;
  readonly windowCount: number;
}

export function shouldCreateWindowOnActivate(
  state: ActivateWindowState,
): boolean {
  return (
    !state.isShutdownInProgress &&
    !state.isShutdownComplete &&
    state.windowCount === 0
  );
}

export interface ActivatableMainWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * macOS emits `activate` both when the Dock icon is clicked and when another
 * process asks LaunchServices to foreground an already-running app.
 *
 * A live-but-hidden BrowserWindow must be revealed here. Merely declining to
 * create a duplicate leaves the process running with no recoverable surface.
 */
export function restoreMainWindowOnActivate(
  state: Omit<ActivateWindowState, 'windowCount'>,
  window: ActivatableMainWindow | null | undefined,
  focusApp: () => void,
): boolean {
  if (
    state.isShutdownInProgress ||
    state.isShutdownComplete ||
    !window ||
    window.isDestroyed()
  ) {
    return false;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  focusApp();
  window.focus();
  return true;
}

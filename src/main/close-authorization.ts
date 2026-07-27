let appQuitAuthorized = false;

export function authorizeAppQuit(): void {
  appQuitAuthorized = true;
}

export function isAppQuitAuthorized(): boolean {
  return appQuitAuthorized;
}

/** A failed physical shutdown keeps the app open and requires fresh consent. */
export function revokeAppQuitAuthorization(): void {
  appQuitAuthorized = false;
}

export function closeNeedsConfirmation(opts: {
  sessionCount: number;
  authorized: boolean;
  smokeTest: boolean;
}): boolean {
  return opts.sessionCount > 0 && !opts.authorized && !opts.smokeTest;
}

export interface ConfirmedWindowCloseDeps {
  readonly sealRuntimeAdmission: () => void;
  readonly quitApp: () => void;
}

/**
 * The sole main window cannot be closed as a mere presentation teardown, even
 * when its current process snapshot is empty: queued orchestration may acquire
 * a child in the next microtask. Seal admission synchronously, then route
 * through app.quit(), whose before-quit lane awaits orchestration settlement
 * and physical proof before Electron may destroy WebContents.
 */
export function completeConfirmedWindowClose(
  deps: ConfirmedWindowCloseDeps,
): "app-shutdown" {
  deps.sealRuntimeAdmission();
  authorizeAppQuit();
  deps.quitApp();
  return "app-shutdown";
}

export function resetCloseAuthorizationForTest(): void {
  revokeAppQuitAuthorization();
}

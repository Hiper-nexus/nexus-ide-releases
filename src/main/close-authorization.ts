let appQuitAuthorized = false;

export function authorizeAppQuit(): void {
  appQuitAuthorized = true;
}

export function isAppQuitAuthorized(): boolean {
  return appQuitAuthorized;
}

export function closeNeedsConfirmation(opts: {
  sessionCount: number;
  authorized: boolean;
  smokeTest: boolean;
}): boolean {
  return opts.sessionCount > 0 && !opts.authorized && !opts.smokeTest;
}

export function resetCloseAuthorizationForTest(): void {
  appQuitAuthorized = false;
}

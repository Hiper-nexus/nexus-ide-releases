import { app } from 'electron';

import { createSmokeSettler, isSmokeTest, SMOKE_TIMEOUT_MS } from './smoke-core';

// CI smoke test: `NexusIDE --smoke-test` boots the app for real (full main
// init + window + renderer bundle) and exits 0 as soon as the renderer
// finishes loading, or 1 on any startup failure. The release workflow runs
// this against the packaged .app before publishing, so a build that crashes
// at boot never reaches a release.
//
// Limitation: an import-time crash in the main bundle happens before this
// code runs (Electron shows its exception dialog and hangs). The workflow
// step wraps the run in an outer timeout to catch that case.
export function initSmokeTest(): void {
  if (!isSmokeTest(process.argv)) {
    return;
  }

  const settle = createSmokeSettler(
    (code) => app.exit(code),
    (line, isError) => (isError ? console.error(line) : console.log(line)),
  );

  // Registering a listener suppresses Electron's blocking exception dialog,
  // turning a post-import crash into a clean non-zero exit.
  process.on('uncaughtException', (err) => {
    settle('uncaught-exception', err instanceof Error ? (err.stack ?? err.message) : String(err));
  });

  setTimeout(() => {
    settle('timeout', `renderer did not load within ${SMOKE_TIMEOUT_MS}ms`);
  }, SMOKE_TIMEOUT_MS);

  app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', () => settle('renderer-loaded'));
    win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame) {
        settle('renderer-failed', `${errorCode} ${errorDescription}`);
      }
    });
  });
}

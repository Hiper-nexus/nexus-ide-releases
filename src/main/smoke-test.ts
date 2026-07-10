import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain } from 'electron';

import {
  createSmokeSettler,
  gracefulSmokeExit,
  isSmokeTest,
  SMOKE_TIMEOUT_MS,
} from './smoke-core';
import { WINDOW_CHANNELS } from '../shared/channels';
import {
  FUNCTIONAL_SMOKE_FILE_CONTENT,
  parseFunctionalSmokeResult,
} from '../shared/smoke-types';

// CI smoke test: `NexusIDE --smoke-test` boots the app for real (full main
// init + window + renderer bundle) and exits 0 only after React commits a real
// frame AND a closed set of real preload→main IPC/MCP probes, or 1 on any
// startup/functional failure. The release workflow runs this against the
// packaged .app before publishing, so a build with a mounted but disconnected
// renderer never reaches a release.
//
// Limitation: an import-time crash in the main bundle happens before this
// code runs (Electron shows its exception dialog and hangs). The workflow
// step wraps the run in an outer timeout to catch that case.
export function initSmokeTest(): void {
  if (!isSmokeTest(process.argv)) {
    return;
  }

  const settle = createSmokeSettler(
    (code) =>
      gracefulSmokeExit(code, {
        setExitCode: (status) => {
          process.exitCode = status;
        },
        quit: () => app.quit(),
      }),
    (line, isError) => (isError ? console.error(line) : console.log(line)),
  );

  // Registering a listener suppresses Electron's blocking exception dialog,
  // turning a post-import crash into a clean non-zero exit.
  process.on('uncaughtException', (err) => {
    settle('uncaught-exception', err instanceof Error ? (err.stack ?? err.message) : String(err));
  });

  setTimeout(() => {
    settle('timeout', `functional smoke did not complete within ${SMOKE_TIMEOUT_MS}ms`);
  }, SMOKE_TIMEOUT_MS);

  app.on('browser-window-created', (_event, win) => {
    const wc = win.webContents;
    const removeListeners = () => {
      ipcMain.removeListener(WINDOW_CHANNELS.mounted, onMounted);
      ipcMain.removeListener(WINDOW_CHANNELS.functionalSmokeResult, onFunctionalResult);
    };
    const onFunctionalResult = (event: Electron.IpcMainEvent, raw: unknown) => {
      if (event.sender !== wc) return;
      const result = parseFunctionalSmokeResult(raw);
      if (!result) {
        removeListeners();
        settle('functional-failed', 'invalid-report');
        return;
      }
      if (!result.ok) {
        removeListeners();
        settle('functional-failed', result.failedProbe);
        return;
      }
      removeListeners();
      settle(
        'functional-ready',
        `${result.probes.length} probes, ${result.toolCount} tools, ${result.adapterCount} adapters`,
      );
    };
    const onMounted = (
      event: Electron.IpcMainEvent,
      report?: { ok?: unknown; error?: unknown },
    ) => {
      if (event.sender !== wc) return;
      ipcMain.removeListener(WINDOW_CHANNELS.mounted, onMounted);
      if (report?.ok === false) {
        ipcMain.removeListener(WINDOW_CHANNELS.functionalSmokeResult, onFunctionalResult);
        settle(
          'renderer-failed',
          typeof report.error === 'string' ? report.error : 'React error boundary mounted',
        );
        return;
      }
      console.log('[smoke] renderer-mounted');
      try {
        const workspacePath = path.join(app.getPath('userData'), 'functional-smoke-workspace');
        fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(workspacePath, 'smoke.txt'),
          FUNCTIONAL_SMOKE_FILE_CONTENT,
          { encoding: 'utf8', mode: 0o600 },
        );
        wc.send(WINDOW_CHANNELS.functionalSmokeRun, { workspacePath });
      } catch {
        ipcMain.removeListener(WINDOW_CHANNELS.functionalSmokeResult, onFunctionalResult);
        settle('functional-failed', 'workspace-open');
      }
    };
    ipcMain.on(WINDOW_CHANNELS.functionalSmokeResult, onFunctionalResult);
    ipcMain.on(WINDOW_CHANNELS.mounted, onMounted);
    win.once('closed', () => {
      removeListeners();
    });
    win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame) {
        settle('renderer-failed', `${errorCode} ${errorDescription}`);
      }
    });
  });
}

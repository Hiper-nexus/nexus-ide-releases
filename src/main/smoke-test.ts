import fs from "node:fs";
import path from "node:path";
import { app, ipcMain } from "electron";

import {
  createSmokeSettler,
  gracefulSmokeExit,
  isCurrentProcessSmokeTest,
  SMOKE_TIMEOUT_MS,
  type SmokeSettler,
} from "./smoke-core";
import { WINDOW_CHANNELS } from "../shared/channels";
import {
  FUNCTIONAL_SMOKE_FILE_CONTENT,
  parseFunctionalSmokeResult,
} from "../shared/smoke-types";
import { grantWorkspacePathFromTrustedMain } from "./persistence/workspace-store";
import { createRealPtyHost } from "./pty/pty-host-client";
import { proveDarwinPtyPipelineForSmoke } from "./pty/darwin-pty-smoke";
import { isSmokeBusyBannerProbeRequested, proveMountedBusyBannerForSmoke } from './hang-watchdog/smoke-busy-banner';
import { SMOKE_HANG_PROBE_BLOCK_MS } from './hang-watchdog/smoke-hang-probe';
import { isSoakSmokeRequested, proveSoakForSmoke } from './soak-smoke';
import { SOAK_POLICY } from '../shared/soak-smoke';
import { runtimeGateConfiguration } from './runtime-gate-mode';
import { RUNTIME_TIMEOUT_MS } from '../shared/runtime-gates';



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
  if (!isCurrentProcessSmokeTest()) {
    return;
  }
  const busyBannerProbe = isSmokeBusyBannerProbeRequested({
    smokeTest: true, env: process.env, userDataPath: app.getPath('userData'),
  });
  const soak = isSoakSmokeRequested({ smokeTest: true, packaged: app.isPackaged, env: process.env, userData: app.getPath('userData') });
  const runtime = runtimeGateConfiguration({ smokeTest: true, packaged: app.isPackaged, env: process.env, userData: app.getPath('userData') });
  const soakCancellation = new AbortController();
  let soakFlight: Promise<void> | null = null;
  // The forty-second live-renderer hang must not consume the ordinary functional deadline.
  const smokeTimeoutMs = SMOKE_TIMEOUT_MS + (busyBannerProbe ? SMOKE_HANG_PROBE_BLOCK_MS + 10_000 : 0) + (soak ? SOAK_POLICY.timeoutMs : 0) + (runtime ? RUNTIME_TIMEOUT_MS : 0);

  const settleNow = createSmokeSettler(
    (code) =>
      gracefulSmokeExit(code, {
        setExitCode: (status) => {
          process.exitCode = status;
        },
        quit: () => app.quit(),
      }),
    (line, isError) => (isError ? console.error(line) : console.log(line)),
  );
  const settle: SmokeSettler = (event, detail) => {
    if (soakFlight && event !== 'functional-ready') {
      soakCancellation.abort();
      // FAIL enters the existing sealed physical shutdown immediately, even
      // if the soak is still awaiting setup IO or a wedged renderer callback.
      // Shutdown owns the real drain/quit ceiling; no success is inferred.
      settleNow(event, detail);
    } else settleNow(event, detail);
  };


  // Registering a listener suppresses Electron's blocking exception dialog,
  // turning a post-import crash into a clean non-zero exit.
  process.on("uncaughtException", (err) => {
    settle(
      "uncaught-exception",
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
  });

  setTimeout(() => {
    settle(
      "timeout",
      `functional smoke did not complete within ${smokeTimeoutMs}ms`,
    );
  }, smokeTimeoutMs);

  app.on("browser-window-created", (_event, win) => {
    const wc = win.webContents;
    let smokeWorkspacePath = '';
    // The utility-process pipeline below is the production path and subsumes
    // the direct helper self-probe. Running both trace-exec proofs inside the
    // Electron process can deadlock Security.framework during AppKit startup.
    const darwinPtyPipelineProof = proveDarwinPtyPipelineForSmoke(
      createRealPtyHost(),
      {
        cwd: process.cwd(),
        environment: process.env,
      },
    );
    void darwinPtyPipelineProof
      .then((ready) => {
        if (ready) console.log("[smoke] darwin-pty-supervisor-ready");
      })
      .catch((error) => {
        settle("functional-failed", smokeErrorMessage(error));
      });
    const removeListeners = () => {
      ipcMain.removeListener(WINDOW_CHANNELS.mounted, onMounted);
      ipcMain.removeListener(
        WINDOW_CHANNELS.functionalSmokeResult,
        onFunctionalResult,
      );
    };
    const onFunctionalResult = (event: Electron.IpcMainEvent, raw: unknown) => {
      if (event.sender !== wc || event.senderFrame !== wc.mainFrame) return;
      const result = parseFunctionalSmokeResult(raw);
      if (!result) {
        removeListeners();
        settle("functional-failed", "invalid-report");
        return;
      }
      if (!result.ok) {
        removeListeners();
        settle(
          "functional-failed",
          result.reason
            ? `${result.failedProbe} (${result.reason})`
            : result.failedProbe,
        );
        return;
      }
      removeListeners();
      if (runtime) {
        if (soak || busyBannerProbe) { settle('functional-failed', 'runtime verifier cannot combine acceptance modes'); return; }
        console.log('[smoke] runtime-start: initial functional probes passed');
        soakFlight = import('./runtime-gates').then(({ proveRuntimeGates }) => proveRuntimeGates(win, { ipc: ipcMain, userData: app.getPath('userData'),
          appVersion: app.getVersion(), packaged: app.isPackaged, smokeTest: true, workspacePath: smokeWorkspacePath, signal: soakCancellation.signal,
          requestPhysicalShutdown: () => settleNow('functional-failed', 'runtime failure; entering physical shutdown') }));
        void soakFlight.then(() => settle('functional-ready', 'runtime observations and repeated functional probes passed'),
          () => settle('functional-failed', 'runtime activity/cleanup proof failed'));
        return;
      }
      if (soak) {
        console.log('[smoke] soak-start: initial functional probes passed');
        soakFlight = proveSoakForSmoke(win, { ipc: ipcMain, userData: app.getPath('userData'),
          appVersion: app.getVersion(), packaged: app.isPackaged, smokeTest: true, workspacePath: smokeWorkspacePath, signal: soakCancellation.signal,
          requestPhysicalShutdown: () => settleNow('functional-failed', 'soak failure; entering physical shutdown') });
        void soakFlight.then(() => settle('functional-ready', 'soak and repeated functional probes passed'),
          () => settle('functional-failed', 'soak activity/memory/cleanup proof failed'));
        return;
      }
      settle(
        "functional-ready",
        `${result.probes.length} probes, ${result.toolCount} tools, ${result.adapterCount} adapters`,
      );
    };
    const onMounted = (
      event: Electron.IpcMainEvent,
      report?: { ok?: unknown; error?: unknown },
    ) => {
      if (event.sender !== wc || event.senderFrame !== wc.mainFrame) return;
      ipcMain.removeListener(WINDOW_CHANNELS.mounted, onMounted);
      if (report?.ok === false) {
        ipcMain.removeListener(
          WINDOW_CHANNELS.functionalSmokeResult,
          onFunctionalResult,
        );
        settle(
          "renderer-failed",
          typeof report.error === "string"
            ? report.error
            : "React error boundary mounted",
        );
        return;
      }
      console.log("[smoke] renderer-mounted");
      void darwinPtyPipelineProof
        .then(async () => {
          if (busyBannerProbe) {
            await proveMountedBusyBannerForSmoke(win, {
              ipc: ipcMain, userData: app.getPath('userData'), appVersion: app.getVersion(),
              packaged: app.isPackaged, smokeTest: true,
            });
          }
          const workspacePath = path.join(
            app.getPath("userData"),
            "functional-smoke-workspace",
          );
          fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
          fs.writeFileSync(
            path.join(workspacePath, "smoke.txt"),
            FUNCTIONAL_SMOKE_FILE_CONTENT,
            { encoding: "utf8", mode: 0o600 },
          );
          const canonicalWorkspacePath = grantWorkspacePathFromTrustedMain(
            wc,
            workspacePath,
          );
          if (!canonicalWorkspacePath) {
            throw new Error("could not grant smoke workspace");
          }
          smokeWorkspacePath = canonicalWorkspacePath;
          wc.send(WINDOW_CHANNELS.functionalSmokeRun, {
            workspacePath: canonicalWorkspacePath,
          });
        })
        .catch((error) => {
          console.error(
            `[smoke] workspace setup error: ${smokeErrorMessage(error)}`,
          );
          ipcMain.removeListener(
            WINDOW_CHANNELS.functionalSmokeResult,
            onFunctionalResult,
          );
          settle("functional-failed", "workspace-open");
        });
    };
    ipcMain.on(WINDOW_CHANNELS.functionalSmokeResult, onFunctionalResult);
    ipcMain.on(WINDOW_CHANNELS.mounted, onMounted);
    win.once("closed", () => {
      removeListeners();
    });
    win.webContents.on(
      "did-fail-load",
      (_e, errorCode, errorDescription, _url, isMainFrame) => {
        if (isMainFrame) {
          settle("renderer-failed", `${errorCode} ${errorDescription}`);
        }
      },
    );
  });
}

function smokeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 512);
}

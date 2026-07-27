import type { PtyHost, PtyProcHandle } from "./pty-host-core";
import {
  currentDarwinPtySupervisorRuntime,
  DARWIN_PTY_PROVIDER_PROBE_MODE,
  DARWIN_PTY_PROVIDER_PROBE_RECEIPT,
  resolvePackagedDarwinPtySmokeProviderSeal,
} from "./darwin-pty-supervisor";
import type { DarwinTrustedExecutableSeal } from "./trusted-native-cli-binary";

export const DARWIN_PTY_SMOKE_TIMEOUT_MS = 10_000;
export const DARWIN_PTY_SMOKE_TERM_TIMEOUT_MS = 1_500;
export const DARWIN_PTY_SMOKE_KILL_TIMEOUT_MS = 4_000;

function stringEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * Packaged smoke proof for the complete production path:
 * main -> Electron utilityProcess -> node-pty -> /usr/bin/perl bootstrap ->
 * signed responsibility supervisor -> provider.
 */
export function proveDarwinPtyPipelineForSmoke(
  host: PtyHost,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly cwd?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly resolveProviderSeal?: () => DarwinTrustedExecutableSeal;
  } = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") {
    return Promise.resolve(false);
  }
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? DARWIN_PTY_SMOKE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("invalid Darwin PTY smoke timeout"));
  }
  let providerSeal: DarwinTrustedExecutableSeal;
  try {
    providerSeal =
      options.resolveProviderSeal?.() ??
      resolvePackagedDarwinPtySmokeProviderSeal(
        currentDarwinPtySupervisorRuntime(__dirname),
      );
  } catch (error) {
    return Promise.reject(
      error instanceof Error
        ? error
        : new Error(`Darwin PTY smoke provider seal failed: ${String(error)}`),
    );
  }

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let timeoutOwnsSettlement = false;
    let handle: PtyProcHandle | null = null;
    let output = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(true);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timeoutOwnsSettlement = true;
      const timedOutHandle = handle;
      if (timedOutHandle === null) {
        finish(
          new Error(
            "Darwin PTY utility pipeline smoke timed out; " +
              "physical cleanup was not proven because no handle exists",
          ),
        );
        return;
      }
      void timedOutHandle
        .terminate({
          termTimeoutMs: DARWIN_PTY_SMOKE_TERM_TIMEOUT_MS,
          killTimeoutMs: DARWIN_PTY_SMOKE_KILL_TIMEOUT_MS,
        })
        .then((proof) => {
          if (!proof.ok || !proof.rootExited || !proof.descendantsExited) {
            finish(
              new Error(
                "Darwin PTY utility pipeline smoke timed out; " +
                  "physical cleanup was not proven" +
                  (proof.error ? `: ${proof.error}` : ""),
              ),
            );
            return;
          }
          finish(new Error("Darwin PTY utility pipeline smoke timed out"));
        })
        .catch((error) => {
          finish(
            new Error(
              "Darwin PTY utility pipeline smoke timed out; " +
                `physical cleanup failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
            ),
          );
        });
    }, timeoutMs);

    try {
      handle = host.spawn(
        {
          sessionId: `packaged-smoke-${process.pid}-${Date.now()}`,
          file: providerSeal.executablePath,
          args: [DARWIN_PTY_PROVIDER_PROBE_MODE],
          cwd,
          cols: 80,
          rows: 24,
          env: {
            ...stringEnvironment(options.environment ?? process.env),
            TERM: "xterm-256color",
          },
          darwinExecutableSeal: providerSeal,
        },
        {
          onData: (chunk) => {
            output = `${output}${chunk}`.slice(-2_048);
          },
          onExit: (exitCode, signal) => {
            if (timeoutOwnsSettlement) return;
            if (
              exitCode === 0 &&
              (signal === undefined || signal === 0) &&
              output.includes(DARWIN_PTY_PROVIDER_PROBE_RECEIPT)
            ) {
              finish();
              return;
            }
            finish(
              new Error(
                `Darwin PTY utility pipeline exited ${exitCode}` +
                  (signal === undefined ? "" : ` signal=${signal}`) +
                  (output ? ` output=${JSON.stringify(output)}` : ""),
              ),
            );
          },
        },
      );
    } catch (error) {
      finish(
        error instanceof Error
          ? error
          : new Error(`Darwin PTY utility pipeline failed: ${String(error)}`),
      );
    }
  });
}

import type { PtyHost, PtyProcHandle } from "./pty-host-core";

export const DARWIN_PTY_SMOKE_TIMEOUT_MS = 10_000;

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

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
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
      try {
        handle?.kill("SIGKILL");
      } catch {
        // The timeout itself remains the failure receipt.
      }
      finish(new Error("Darwin PTY utility pipeline smoke timed out"));
    }, timeoutMs);

    try {
      handle = host.spawn(
        {
          sessionId: `packaged-smoke-${process.pid}-${Date.now()}`,
          file: "/usr/bin/true",
          args: [],
          cwd,
          cols: 80,
          rows: 24,
          env: {
            ...stringEnvironment(options.environment ?? process.env),
            TERM: "xterm-256color",
          },
        },
        {
          onData: (chunk) => {
            output = `${output}${chunk}`.slice(-2_048);
          },
          onExit: (exitCode, signal) => {
            if (exitCode === 0 && (signal === undefined || signal === 0)) {
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

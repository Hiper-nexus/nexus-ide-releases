import type { PtyHost, PtyProcHandle } from "./pty-host-core";
import {
  currentDarwinPtySupervisorRuntime,
  DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
  DARWIN_PTY_PROVIDER_PROBE_MODE,
  DARWIN_PTY_PROVIDER_PROBE_RECEIPT,
  resolvePackagedDarwinPtySmokeProviderSeal,
} from "./darwin-pty-supervisor";
import type { DarwinPtyExecutableSeal } from "./darwin-pty-supervisor";

export const DARWIN_PTY_SMOKE_TIMEOUT_MS = 10_000;
export const DARWIN_PTY_SMOKE_TERM_TIMEOUT_MS = 1_500;
export const DARWIN_PTY_SMOKE_KILL_TIMEOUT_MS = 4_000;
/**
 * Saída 0 SEM NENHUM byte é a assinatura do macOS descartando a saída não
 * lida do PTY quando o host não lê antes do último close do slave (máquina
 * carregada; o node-pty destrói o socket 200 ms depois do exit). Nova
 * tentativa só nesse caso: o recibo continua obrigatório, e saída não-zero,
 * sinal ou saída sem recibo reprovam na hora.
 */
export const DARWIN_PTY_SMOKE_ATTEMPTS = 3;

class EmptyCleanExitError extends Error {}

interface DarwinPtySmokeOptions {
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly resolveProviderSeal?: () => DarwinPtyExecutableSeal;
}

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
  options: DarwinPtySmokeOptions = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") {
    return Promise.resolve(false);
  }
  const attempt = async (remaining: number): Promise<boolean> => {
    try {
      return await proveDarwinPtyPipelineOnce(host, options, remaining);
    } catch (error) {
      if (error instanceof EmptyCleanExitError && remaining > 1) {
        console.warn(`[smoke] ${error.message}; nova tentativa`);
        return attempt(remaining - 1);
      }
      throw error;
    }
  };
  return attempt(DARWIN_PTY_SMOKE_ATTEMPTS);
}

function proveDarwinPtyPipelineOnce(
  host: PtyHost,
  options: DarwinPtySmokeOptions,
  attemptsLeft: number,
): Promise<boolean> {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? DARWIN_PTY_SMOKE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("invalid Darwin PTY smoke timeout"));
  }
  let providerSeal: DarwinPtyExecutableSeal;
  try {
    providerSeal =
      options.resolveProviderSeal?.() ??
      resolvePackagedDarwinPtySmokeProviderSeal(
        currentDarwinPtySupervisorRuntime(
          __dirname,
          DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
        ),
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
          sessionId: `packaged-smoke-${process.pid}-${Date.now()}-${attemptsLeft}`,
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
          darwinTrustProfile: DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
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
            if (exitCode === 0 && (signal === undefined || signal === 0) && output === "") {
              finish(
                new EmptyCleanExitError(
                  `Darwin PTY utility pipeline exited 0 with no output (unread PTY output discarded)`,
                ),
              );
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

// Pure logic for the packaged-app smoke test (--smoke-test). The electron
// wiring lives in smoke-test.ts; keeping this file dependency-free makes it
// unit-testable and guarantees the smoke machinery itself can never be the
// thing that breaks the boot it is guarding.

/** Legacy switch retained for direct developer invocations. */
export const SMOKE_FLAG = '--smoke-test';
/**
 * Positional app argument used by the packaged harness. Chromium may consume
 * unknown switches before Electron exposes process.argv, whereas a positional
 * argument reliably reaches the main process.
 */
export const SMOKE_ARGUMENT = 'nexus-smoke-test';
export const SMOKE_TIMEOUT_MS = 60_000;

export type SmokeEvent =
  | 'functional-ready'
  | 'functional-failed'
  | 'renderer-failed'
  | 'uncaught-exception'
  | 'timeout';

export function isSmokeTest(argv: readonly string[]): boolean {
  return argv.includes(SMOKE_FLAG) || argv.includes(SMOKE_ARGUMENT);
}

/**
 * Electron may normalize process.argv after app readiness. Capture launch mode
 * while the positional sentinel is still present so later boot gates cannot
 * accidentally prompt, access the real vault, or contact the network.
 */
export function captureSmokeTestMode(
  startupArgv: readonly string[],
): () => boolean {
  const captured = isSmokeTest(startupArgv);
  return () => captured;
}

export const isCurrentProcessSmokeTest = captureSmokeTestMode(process.argv);

export function shouldUseUserDataOverride(
  isPackaged: boolean,
  argv: readonly string[],
  override: string | undefined,
): boolean {
  if (!override) return false;
  return !isPackaged || isSmokeTest(argv);
}

/** A packaged smoke must never decrypt the user's real vault. */
export function shouldAccessSecureStorage(argv: readonly string[]): boolean {
  return !isSmokeTest(argv);
}

/** A boot smoke must not depend on a network update source or user CLI auth. */
export function shouldInitializeAutoUpdater(argv: readonly string[]): boolean {
  return !isSmokeTest(argv);
}

/** A packaged smoke must never wait on first-launch global hook consent. */
export function shouldInitializeManagedAgentHooks(argv: readonly string[]): boolean {
  return !isSmokeTest(argv);
}

/** The boot smoke validates startup, not TCC; permission UI would make CI hang. */
export function shouldRequestMicrophoneAccess(
  platform: NodeJS.Platform,
  argv: readonly string[],
): boolean {
  return platform === 'darwin' && !isSmokeTest(argv);
}

export function smokeExitCode(event: SmokeEvent): 0 | 1 {
  return event === 'functional-ready' ? 0 : 1;
}

export function gracefulSmokeExit(
  code: 0 | 1,
  hooks: { setExitCode(code: 0 | 1): void; quit(): void },
): void {
  hooks.setExitCode(code);
  hooks.quit();
}

export type SmokeSettler = (event: SmokeEvent, detail?: string) => void;

/**
 * First event wins: whichever outcome arrives first decides the exit code;
 * everything after is ignored so a late timeout can't flip a success.
 */
export function createSmokeSettler(
  exit: (code: 0 | 1) => void,
  log: (line: string, isError: boolean) => void,
): SmokeSettler {
  let settled = false;
  return (event, detail) => {
    if (settled) {
      return;
    }
    settled = true;
    const code = smokeExitCode(event);
    log(`[smoke] ${event}${detail ? `: ${detail}` : ''}`, code !== 0);
    exit(code);
  };
}

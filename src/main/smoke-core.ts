// Pure logic for the packaged-app smoke test (--smoke-test). The electron
// wiring lives in smoke-test.ts; keeping this file dependency-free makes it
// unit-testable and guarantees the smoke machinery itself can never be the
// thing that breaks the boot it is guarding.

export const SMOKE_FLAG = '--smoke-test';
export const SMOKE_TIMEOUT_MS = 60_000;

export type SmokeEvent =
  | 'renderer-loaded'
  | 'renderer-failed'
  | 'uncaught-exception'
  | 'timeout';

export function isSmokeTest(argv: readonly string[]): boolean {
  return argv.includes(SMOKE_FLAG);
}

export function smokeExitCode(event: SmokeEvent): 0 | 1 {
  return event === 'renderer-loaded' ? 0 : 1;
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

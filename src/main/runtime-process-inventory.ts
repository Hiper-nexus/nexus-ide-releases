import {
  liveSessionSummary,
  sealPtySessionAdmissionForShutdown,
  isPtySessionAdmissionSealedForShutdown,
  ptySessionAdmissionAbortSignal,
} from "./pty/pty-manager";

export interface LiveRuntimeProcessSummary {
  readonly total: number;
  readonly busy: number;
}

/**
 * Global Main-owned runtime inventory used by native close/quit decisions.
 * Renderer ownership is deliberately irrelevant: mission PTYs can be headless
 * while continuing to hold physical process authority.
 */
export function liveRuntimeProcessSummary(): LiveRuntimeProcessSummary {
  return Object.freeze(liveSessionSummary());
}

/**
 * Atomic admission half of native close. It runs before app.quit()/any await,
 * closing the PTY child-process backend so a zero snapshot cannot become a
 * live process in the next microtask.
 */
export function sealRuntimeProcessAdmissionForShutdown(): void {
  sealPtySessionAdmissionForShutdown();
}

/** The same sticky Main shutdown fence used by native process admission. */
export function isRuntimeProcessAdmissionSealedForShutdown(): boolean {
  return isPtySessionAdmissionSealedForShutdown();
}

export function runtimeProcessAdmissionAbortSignal(): AbortSignal {
  return ptySessionAdmissionAbortSignal();
}

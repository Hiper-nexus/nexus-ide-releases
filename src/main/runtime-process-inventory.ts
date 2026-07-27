import {
  liveOmpRpcRuntimeSummary,
  sealOmpRpcAdmissionForShutdown,
} from "./adapters/omp-rpc-ipc";
import {
  liveSessionSummary,
  sealPtySessionAdmissionForShutdown,
} from "./pty/pty-manager";

export interface LiveRuntimeProcessSummary {
  readonly total: number;
  readonly busy: number;
}

/**
 * Global Main-owned runtime inventory used by native close/quit decisions.
 * Renderer ownership is deliberately irrelevant: mission PTYs and OMP workers
 * can both be headless while continuing to hold physical process authority.
 */
export function liveRuntimeProcessSummary(): LiveRuntimeProcessSummary {
  const pty = liveSessionSummary();
  const omp = liveOmpRpcRuntimeSummary();
  return Object.freeze({
    total: pty.total + omp.total,
    busy: pty.busy + omp.busy,
  });
}

/**
 * Atomic admission half of native close. It runs before app.quit()/any await,
 * closing both child-process backends so a zero snapshot cannot become a live
 * process in the next microtask.
 */
export function sealRuntimeProcessAdmissionForShutdown(): void {
  sealPtySessionAdmissionForShutdown();
  sealOmpRpcAdmissionForShutdown();
}

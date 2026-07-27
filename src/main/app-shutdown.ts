import type { TerminateAllSessionsResult } from "./pty/pty-manager";

export interface PhysicalPtyShutdownDeps {
  readonly terminateAllSessions: () => Promise<TerminateAllSessionsResult>;
  readonly shutdownPtyHost: () => void;
}

export interface OrchestrationPtyShutdownDeps
  extends PhysicalPtyShutdownDeps {
  readonly quiesceOrchestration: () => Promise<void>;
  readonly reconcileOrchestratorExits: () => boolean;
}

export interface PhysicalSessionShutdownResult {
  readonly ok: boolean;
  readonly attemptedSessionIds: readonly string[];
  readonly terminatedSessionIds: readonly string[];
  readonly failedSessionIds: readonly string[];
}

export interface OrchestrationRuntimeShutdownDeps
  extends OrchestrationPtyShutdownDeps {
  readonly terminateAllOmpSessions: () => Promise<PhysicalSessionShutdownResult>;
  readonly closeOrchestration: () => Promise<void>;
}

export interface OrchestrationRuntimeShutdownResult {
  readonly pty: TerminateAllSessionsResult;
  readonly omp: PhysicalSessionShutdownResult;
}

export class PhysicalPtyShutdownError extends Error {
  readonly result: TerminateAllSessionsResult;

  constructor(result: TerminateAllSessionsResult) {
    const failed = result.failedSessionIds.join(", ") || "inventário divergente";
    super(`PTY process-tree exit was not proven for: ${failed}`);
    this.name = "PhysicalPtyShutdownError";
    this.result = result;
  }
}

export class PhysicalOmpShutdownError extends Error {
  readonly result: PhysicalSessionShutdownResult;

  constructor(result: PhysicalSessionShutdownResult) {
    const failed = result.failedSessionIds.join(", ") || "inventário divergente";
    super(`OMP process-tree exit was not proven for: ${failed}`);
    this.name = "PhysicalOmpShutdownError";
    this.result = result;
  }
}

function hasExactPhysicalInventoryProof(
  result: PhysicalSessionShutdownResult,
): boolean {
  const attempted = new Set(result.attemptedSessionIds);
  const terminated = new Set(result.terminatedSessionIds);
  return (
    attempted.size === result.attemptedSessionIds.length &&
    terminated.size === result.terminatedSessionIds.length &&
    attempted.size === terminated.size &&
    result.attemptedSessionIds.every((sessionId) =>
      terminated.has(sessionId),
    )
  );
}

/**
 * The app may destroy its PTY utilityProcess only after main has proof that
 * every registered root and captured descendant exited. Host death is not a
 * substitute for that proof because detached descendants can survive it.
 */
export async function shutdownPtyRuntimeWithProof(
  deps: PhysicalPtyShutdownDeps,
): Promise<TerminateAllSessionsResult> {
  const result = await deps.terminateAllSessions();
  if (
    !result.ok ||
    result.failedSessionIds.length > 0 ||
    !hasExactPhysicalInventoryProof(result)
  ) {
    throw new PhysicalPtyShutdownError(result);
  }
  deps.shutdownPtyHost();
  return result;
}

/**
 * Quiesce periodic effects and prove the PTY half without removing the exact
 * exit observer or project stores. The all-runtime boundary below owns their
 * eventual teardown only after every process family has settled.
 */
export async function shutdownOrchestrationPtyRuntimeWithProof(
  deps: OrchestrationPtyShutdownDeps,
): Promise<TerminateAllSessionsResult> {
  await deps.quiesceOrchestration();
  const result = await shutdownPtyRuntimeWithProof(deps);
  if (!deps.reconcileOrchestratorExits()) {
    throw new Error(
      "orchestrator exit reconciliation is not durably complete",
    );
  }
  return result;
}

/**
 * Full process-bearing orchestration shutdown. OMP termination can publish
 * external-session lifecycle into project stores, so those stores and the PTY
 * exit observer remain alive until both PTY and OMP inventories are proven.
 * Any rejection leaves the same state installed, allowing the native retry to
 * run reconciliation again instead of reading a disposed registry.
 */
export async function shutdownOrchestrationRuntimesWithProof(
  deps: OrchestrationRuntimeShutdownDeps,
): Promise<OrchestrationRuntimeShutdownResult> {
  const pty = await shutdownOrchestrationPtyRuntimeWithProof(deps);
  const omp = await deps.terminateAllOmpSessions();
  if (
    !omp.ok ||
    omp.failedSessionIds.length > 0 ||
    !hasExactPhysicalInventoryProof(omp)
  ) {
    throw new PhysicalOmpShutdownError(omp);
  }
  await deps.closeOrchestration();
  return Object.freeze({ pty, omp });
}

export interface ShutdownFailureNotice {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}

/** Reader-facing, actionable explanation used by the native quit dialog. */
export function buildShutdownFailureNotice(
  error: unknown,
): ShutdownFailureNotice {
  if (error instanceof PhysicalPtyShutdownError) {
    const ids =
      error.result.failedSessionIds.length > 0
        ? error.result.failedSessionIds.join(", ")
        : "inventário PTY inconsistente";
    return {
      title: "O NexusIDE continua aberto",
      message:
        "Não foi possível comprovar o encerramento de todos os processos.",
      detail:
        `Sessões sem prova física: ${ids}.\n\n` +
        "O host dos terminais não foi encerrado. Aguarde ou finalize o " +
        "processo resistente pelo sistema operacional e tente novamente. " +
        "A admissão de novos runtimes permanece bloqueada até a nova tentativa.",
    };
  }
  const reason = error instanceof Error ? error.message : String(error);
  return {
    title: "O NexusIDE continua aberto",
    message: "A preparação segura para sair não foi concluída.",
    detail:
      `${reason}\n\nNenhum encerramento forçado foi declarado. ` +
      "A admissão de novos runtimes permanece bloqueada; revise o erro e " +
      "tente novamente.",
  };
}

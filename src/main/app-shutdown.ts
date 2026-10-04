import type { TerminateAllSessionsResult } from "./pty/pty-manager";

export interface PhysicalPtyShutdownDeps {
  readonly terminateAllSessions: () => Promise<TerminateAllSessionsResult>;
  readonly shutdownPtyHost: () => void | Promise<void>;
}

export interface OrchestrationPtyShutdownDeps
  extends PhysicalPtyShutdownDeps {
  readonly quiesceOrchestration: () => Promise<void>;
  readonly reconcileOrchestratorExits: () => boolean;
}

export interface OrchestrationRuntimeShutdownDeps
  extends OrchestrationPtyShutdownDeps {
  readonly closeOrchestration: () => Promise<void>;
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

export function hasExactPhysicalInventoryProof(
  result: TerminateAllSessionsResult,
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
  await deps.shutdownPtyHost();
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
 * Full process-bearing orchestration shutdown. Project stores and the PTY exit
 * observer remain alive until the physical inventory and durable lifecycle
 * reconciliation are proven. Any rejection leaves the same state installed,
 * allowing the native retry to reconcile against the live registry.
 */
export async function shutdownOrchestrationRuntimesWithProof(
  deps: OrchestrationRuntimeShutdownDeps,
): Promise<TerminateAllSessionsResult> {
  const pty = await shutdownOrchestrationPtyRuntimeWithProof(deps);
  await deps.closeOrchestration();
  return pty;
}

/**
 * Encerramento sem veto (diretiva do dono, 06/08): uma sessão sem prova
 * física de morte é um INCIDENTE registrado, não um motivo para manter o app
 * inteiro vivo. O caminho da prova continua idêntico; quando ela falha, o
 * teardown segue até o fim com o incidente gravado — o processo resistente é
 * abandonado ao SIGKILL do teto, nunca aguardado para sempre.
 */
export async function shutdownOrchestrationRuntimesRecordingStragglers(
  deps: OrchestrationRuntimeShutdownDeps,
  record: (incident: {
    readonly kind: "sessions-unproven" | "reconciliation-incomplete";
    readonly sessionIds?: readonly string[];
    readonly detail: string;
  }) => void,
): Promise<TerminateAllSessionsResult> {
  await deps.quiesceOrchestration();
  const result = await deps.terminateAllSessions();
  const proven =
    result.ok &&
    result.failedSessionIds.length === 0 &&
    hasExactPhysicalInventoryProof(result);
  if (!proven) {
    record({
      kind: "sessions-unproven",
      sessionIds: result.failedSessionIds,
      detail:
        result.failedSessionIds.join(", ") || "inventário PTY inconsistente",
    });
  }
  await deps.shutdownPtyHost();
  if (!deps.reconcileOrchestratorExits()) {
    record({
      kind: "reconciliation-incomplete",
      detail: "orchestrator exit reconciliation is not durably complete",
    });
  }
  await deps.closeOrchestration();
  return result;
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

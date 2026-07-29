import { createHash } from "node:crypto";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import type { ProjectExecutionScope } from "../../shared/types";
import { createTaskDispatchStore } from "./task-dispatch-store";
import { requestMissionWorkerPaneRetirement } from "./pane-registry";
import { decideProviderFailureTaskPolicy } from "./provider-failure-task-policy";
import { requestMissionDriverTick } from "./mission-driver-runtime";
import type { LimitHit } from "./limit-detector";

/**
 * Main-owned glue entre o failover (que detecta o hit de provider no PTY) e o
 * dispatch store (única autoridade de conclusão). Quando não existe conta/rota
 * alternativa para um mission worker:
 *
 * - advisory Guided raiz sem consumidores → persiste o waiver
 *   `advisory_provider_unavailable` (CAS-bound), fecha a sessão física exata e
 *   acorda o scheduler (o estado `completed` já liberou o slot maxWorkers);
 * - qualquer outra task → NUNCA sucesso sintético: término da sessão pela
 *   identidade exata + o caminho limitado de retry/failover existente
 *   (espera-pela-irmã do failover e a recuperação de session-exit do
 *   scheduler, com teto de tentativas físicas).
 *
 * O renderer nunca participa da decisão; o fechamento usa a mesma função
 * authority-sealed do retirement coordinator, que re-prova
 * paneId+sessionId+missionId+workerIncarnationId+scope antes de encerrar.
 */

export interface ProviderFailureNoRouteInput {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly paneId: string;
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly adapterId: string;
  readonly hit: LimitHit;
}

export type ProviderFailureNoRouteOutcome = "waived" | "retry";

let configuredRuntimeManager: ProjectRuntimeManager | null = null;

/** Bootstrap de produção (main.ts) instala o runtime; testes reconfiguram. */
export function configureProviderFailureWaiver(input: {
  readonly runtimeManager: ProjectRuntimeManager | null;
}): void {
  configuredRuntimeManager = input.runtimeManager;
}

function requestExactWorkerClose(
  input: ProviderFailureNoRouteInput,
  context: string,
): void {
  void requestMissionWorkerPaneRetirement({
    paneId: input.paneId,
    sessionId: input.sessionId,
    missionId: input.missionId,
    workerIncarnationId: input.workerIncarnationId,
    scope: input.scope,
  }).then(
    (closed) => {
      if (!closed) {
        // Fail-closed: a identidade mudou ou é ambígua; o retry limitado e o
        // watchdog de session-exit continuam donos da recuperação.
        console.warn(
          "[failover] close de worker recusado para a identidade exata:",
          JSON.stringify({
            context,
            missionId: input.missionId,
            paneId: input.paneId,
            sessionId: input.sessionId,
          }),
        );
      }
    },
    (error) => {
      console.warn("[failover] erro ao fechar worker mission:", error);
    },
  );
}

export function handleMissionWorkerProviderNoRoute(
  input: ProviderFailureNoRouteInput,
): ProviderFailureNoRouteOutcome {
  const runtimeManager = configuredRuntimeManager;
  if (!runtimeManager) return "retry";
  const store = createTaskDispatchStore(runtimeManager, input.scope);
  const dispatch = store
    .list(input.missionId)
    .find(
      (candidate) =>
        candidate.paneId === input.paneId &&
        candidate.sessionId === input.sessionId &&
        candidate.workerIncarnationId === input.workerIncarnationId,
    );
  if (!dispatch) {
    console.info(
      "[failover]",
      JSON.stringify({
        providerNoRoute: "sem dispatch exato; retry limitado",
        missionId: input.missionId,
        paneId: input.paneId,
        sessionId: input.sessionId,
      }),
    );
    return "retry";
  }

  let decision: ReturnType<typeof decideProviderFailureTaskPolicy>;
  try {
    const eligibility = store.readProviderFailureWaiverEligibility(
      dispatch.taskId,
    );
    decision = eligibility
      ? decideProviderFailureTaskPolicy({
          guidedTaskKind: eligibility.guidedTaskKind,
          dependsOn: eligibility.dependsOn,
          consumers: eligibility.consumers,
          hitKind: input.hit.kind,
        })
      : {
          decision: "retry-required",
          reason: "plano selado não re-provado para a elegibilidade",
        };
  } catch (error) {
    console.warn(
      "[failover] elegibilidade do waiver falhou; mantido o retry limitado:",
      error,
    );
    return "retry";
  }

  if (decision.decision === "waive") {
    const causeSha256 = createHash("sha256")
      .update(input.hit.reason)
      .digest("hex");
    try {
      store.completeSealedAdvisoryProviderWaiver({
        taskId: dispatch.taskId,
        revision: dispatch.revision,
        paneId: input.paneId,
        sessionId: input.sessionId,
        workerIncarnationId: input.workerIncarnationId,
        adapterId: input.adapterId,
        hitKind: input.hit.kind,
        causeSha256,
      });
    } catch (error) {
      console.warn(
        "[failover] waiver advisory recusado pelo store; mantido o retry limitado:",
        error,
      );
      return "retry";
    }
    console.info(
      "[failover]",
      JSON.stringify({
        waiver: "advisory_provider_unavailable",
        missionId: input.missionId,
        taskId: dispatch.taskId,
        paneId: input.paneId,
        sessionId: input.sessionId,
        workerIncarnationId: input.workerIncarnationId,
        adapterId: input.adapterId,
        hitKind: input.hit.kind,
        causeSha256,
      }),
    );
    // Waiver commitado: fecha a sessão física exata e acorda o scheduler.
    requestExactWorkerClose(input, "advisory-waiver");
    requestMissionDriverTick();
    return "waived";
  }

  // Task requerida (ou advisory estruturalmente inelegível): término da sessão
  // problemática pela identidade exata — o dispatch segue non-terminal e a
  // recuperação limitada existente decide o destino; nada é marcado como done.
  console.info(
    "[failover]",
    JSON.stringify({
      providerNoRoute: "retry-required",
      policy: decision.decision,
      reason: decision.reason,
      missionId: input.missionId,
      taskId: dispatch.taskId,
      paneId: input.paneId,
      sessionId: input.sessionId,
      adapterId: input.adapterId,
      hitKind: input.hit.kind,
    }),
  );
  requestExactWorkerClose(input, "retry-required");
  return "retry";
}

import { createHash } from "node:crypto";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import type { ProjectExecutionScope } from "../../shared/types";
import { createTaskDispatchStore } from "./task-dispatch-store";
import { requestMissionWorkerPaneRetirement } from "./pane-registry";
import { decideProviderFailureTaskPolicy } from "./provider-failure-task-policy";
import { requestMissionDriverTick } from "./mission-driver-runtime";
import { getProjectDomainStores } from "./project-domain-store-registry";
import { rerouteLiveProviderDeadDispatch } from "./mission-scheduler-reconciliation";
import type { TaskProviderWaiverHitKind } from "./task-dispatch-codec";
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

export type ProviderFailureNoRouteOutcome = "rerouted" | "waived" | "retry";

/**
 * Kinds em que a CLI está durávelmente inutilizável — auth revogada não volta
 * sozinha e cota é janela multi-hora. rate-limit/transient se resolvem em
 * minutos pela espera-pela-irmã; re-rotear por eles jogaria fora um agente
 * saudável por um soluço.
 */
const LIVE_REROUTE_HIT_KINDS = new Set<TaskProviderWaiverHitKind>([
  "auth",
  "quota",
]);

const WAIVER_CAUSE_PT: Record<TaskProviderWaiverHitKind, string> = {
  quota: "a cota do provider acabou",
  "rate-limit": "o provider impôs limite de taxa",
  auth: "a credencial expirou ou foi revogada",
  transient: "o provider ficou indisponível",
};

/**
 * O waiver já era durável — o recibo em `integration_receipt_json` guarda causa,
 * adapter e CAS binding. O que faltava era ele CHEGAR ao operador: a task grava
 * `done` e o dispatch `completed`, então na tela a tarefa dispensada é idêntica
 * a uma que trabalhou. Sem esta entrada, a missão fecha parecendo completa com
 * trabalho que ninguém fez — a origem da queixa de "critérios não seguidos".
 */
export function providerWaiverLearning(input: {
  readonly taskTitle: string;
  readonly adapterId: string;
  readonly hitKind: TaskProviderWaiverHitKind;
}): string {
  const cause = WAIVER_CAUSE_PT[input.hitKind];
  const remedy =
    input.hitKind === "auth"
      ? " Refaça o login dessa CLI e reabra a missão para que a tarefa seja executada de fato."
      : "";
  return (
    "## Tarefa dispensada por provider indisponível\n" +
    `A tarefa "${input.taskTitle}" **não foi executada**: ${cause} ` +
    `na CLI ${input.adapterId}, e não havia conta alternativa para assumir.\n\n` +
    "Ela é consultiva e não bloqueia a entrega, então a missão seguiu sem ela — " +
    `mas o resultado final foi produzido sem essa contribuição.${remedy}`
  ).slice(0, 4_000);
}

let configuredRuntimeManager: ProjectRuntimeManager | null = null;
let configuredLiveReroute: typeof rerouteLiveProviderDeadDispatch | null = null;

/** Bootstrap de produção (main.ts) instala o runtime; testes reconfiguram.
 *  `attemptLiveReroute` é injetável porque o resolvedor real depende de
 *  adapters instalados e settings vivos — os testes provam a ORDEM
 *  (reroute antes de waiver) com um dublê determinístico. */
export function configureProviderFailureWaiver(input: {
  readonly runtimeManager: ProjectRuntimeManager | null;
  readonly attemptLiveReroute?: typeof rerouteLiveProviderDeadDispatch | null;
}): void {
  configuredRuntimeManager = input.runtimeManager;
  configuredLiveReroute =
    input.attemptLiveReroute === undefined
      ? rerouteLiveProviderDeadDispatch
      : input.attemptLiveReroute;
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

  // ORDEM: reroute dentro do roster ANTES de qualquer waiver ou retry. A frota
  // que o operador aprovou existe para isto — dispensar uma task (ou queimar 3
  // respawns num binário 401) enquanto outro agente da mesma categoria está
  // vivo é desperdiçar o roster. Só kinds duráveis re-roteiam; soluços curtos
  // seguem a espera-pela-irmã.
  if (configuredLiveReroute && LIVE_REROUTE_HIT_KINDS.has(input.hit.kind)) {
    try {
      const candidate = configuredLiveReroute(input.scope, {
        missionId: input.missionId,
        taskId: dispatch.taskId,
        paneId: input.paneId,
        sessionId: input.sessionId,
        workerIncarnationId: input.workerIncarnationId,
        deadAdapterId: input.adapterId,
      });
      if (candidate) {
        console.info(
          "[failover]",
          JSON.stringify({
            liveReroute: "provider morto re-roteado dentro do roster",
            missionId: input.missionId,
            taskId: dispatch.taskId,
            paneId: input.paneId,
            fromAdapterId: input.adapterId,
            toAgent: candidate.agentName,
            toCli: candidate.cli,
            hitKind: input.hit.kind,
          }),
        );
        // Diretiva commitada: fecha a sessão física morta e acorda o
        // scheduler para despachar pelo agente alternativo.
        requestExactWorkerClose(input, "live-reroute");
        requestMissionDriverTick();
        return "rerouted";
      }
    } catch (error) {
      console.warn(
        "[failover] reroute ao vivo falhou; caindo para waiver/retry:",
        error,
      );
    }
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
    // Best-effort e nunca fatal: a dispensa já está commitada e auditável no
    // recibo; falhar em narrá-la não pode reverter nem travar a missão.
    try {
      const stores = getProjectDomainStores(input.scope);
      const taskTitle =
        stores.tasks
          .list(input.missionId)
          .find((task) => task.id === dispatch.taskId)?.title ??
        dispatch.taskId;
      stores.missions.appendLearning(
        input.missionId,
        providerWaiverLearning({
          taskTitle,
          adapterId: input.adapterId,
          hitKind: input.hit.kind,
        }),
      );
    } catch (error) {
      console.warn(
        "[failover] waiver commitado, mas o aprendizado não foi registrado:",
        error,
      );
    }
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

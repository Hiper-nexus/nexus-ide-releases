import type { HandoffDeliveryRuntimeRecoveryRequest } from "./idle-delivery";
import { redeliverPendingHandoffs } from "./idle-delivery";
import {
  getPaneRuntimeAuthorityBySession,
  requestMissionPaneRecovery,
} from "./pane-registry";
import { getProjectDomainStores } from "./project-domain-store-registry";
import { sameProjectScope } from "./project-scoped-broadcast";

function recoveryRecap(
  request: HandoffDeliveryRuntimeRecoveryRequest,
): string {
  return [
    "# Recuperação automática do Maestro",
    "A sessão anterior permaneceu viva, mas não aceitou a entrega durável " +
      "após o limite seguro de tentativas. O Main encerrou somente aquela " +
      "identidade física e abriu este contexto fresco.",
    `Missão: ${request.missionId}`,
    `Handoff pendente: ${request.handoffId}`,
    "Retome a missão aprovada sem pedir intervenção ao operador. Leia os " +
      "handoffs pendentes, reconheça cada um com nexus_handoff_ack e conclua " +
      "a síntese final conforme o contrato vigente.",
  ].join("\n\n");
}

export async function recoverHandoffDeliveryRuntime(
  request: HandoffDeliveryRuntimeRecoveryRequest,
): Promise<boolean> {
  const stores = getProjectDomainStores(request.scope);
  const mission = stores.missions.get(request.missionId);
  const handoff = stores.handoffs.get(request.handoffId);
  if (
    !mission ||
    mission.status !== "running" ||
    mission.orchestratorSessionId !== request.sessionId ||
    !handoff ||
    handoff.missionId !== request.missionId ||
    handoff.delivered ||
    handoff.deliveryState !== "queued"
  ) {
    // The trigger is obsolete: terminal mission, consumed handoff or a newer
    // Maestro already owns the mission. Treat it as settled so no retry can
    // terminate a healthy replacement.
    return true;
  }
  const runtime = getPaneRuntimeAuthorityBySession(request.sessionId);
  if (
    runtime &&
    (runtime.sessionId !== request.sessionId ||
      runtime.paneId !== request.paneId ||
      runtime.missionId !== request.missionId ||
      runtime.role !== "orchestrator" ||
      !runtime.scope ||
      !sameProjectScope(runtime.scope, request.scope))
  ) {
    return true;
  }
  const panes = stores.missionPanes
    .list(request.missionId)
    .filter(
      (pane) =>
        pane.role === "orchestrator" && pane.paneId === request.paneId,
    );
  const pane = panes.length === 1 ? panes[0] : undefined;
  if (!pane?.paneId || !pane.authoritySeal) return false;
  const result = await requestMissionPaneRecovery({
    missionId: request.missionId,
    paneId: request.paneId,
    role: "orchestrator",
    expectedSessionId: request.sessionId,
    pane,
    scope: request.scope,
    recap: recoveryRecap(request),
    // F-1581: o terminal diz que o Maestro não aceitou a entrega.
    reason: "handoff-delivery",
  });
  if (!result.ok || !result.sessionId) return false;
  const rebound = stores.missions.rebindOrchestratorSession(
    request.missionId,
    result.sessionId,
  );
  if (rebound?.orchestratorSessionId !== result.sessionId) return false;
  redeliverPendingHandoffs(request.scope, request.missionId);
  return true;
}

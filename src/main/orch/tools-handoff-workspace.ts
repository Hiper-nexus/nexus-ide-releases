import { handoffStatusSchema } from "../../shared/orch-types";
import {
  embedTelemetryArtifact,
  sanitizeHandoffTelemetry,
} from "../../shared/handoff-telemetry";
import type { AgentGateContext } from "./gate";
import {
  assertMcpInvocationCurrent,
  type McpToolInvocation,
} from "./mcp-protocol";
import { resolveWorkspaceHandoffParent } from "./workspace-handoff-authority";
import { listPaneSnapshots } from "./pane-registry";
import { getProjectDomainStores } from "./project-domain-store-registry";
import { injectPrompt, requireStr } from "./tool-util";
import { normalizeHandoffStatusInput } from "./legacy-handoff";
import { filterAntiSocialChatter } from "./swarm-protocol";
import {
  capHandoffFullText,
  condenseHandoffSummary,
} from "./handoff-summary-rule";
import {
  deliveryContractExhaustedArtifact,
  deliveryContractRetryMessage,
  disarmDeliveryContract,
  evaluateDeliveryContract,
} from "./delivery-contract";

/** Workspace delivery is untrusted correspondence, never mission completion evidence. */
export async function submitWorkspaceHandoff(
  args: Record<string, unknown>,
  ctx: AgentGateContext,
  invocation?: McpToolInvocation,
  metadata: unknown[] = [],
) {
  const destination = resolveWorkspaceHandoffParent(ctx);
  if (!destination)
    throw new Error(
      "handoff exige missão ou pane filho do operador com pai vivo no mesmo workspace; use nexus_pane_write/nexus_pane_ask ou crie uma missão",
    );
  const rawSummary = requireStr(args, "summary").trim();
  if (rawSummary.length < 20 || /^<.*>$/.test(rawSummary)) {
    throw new Error(
      "summary inválido: descreva de verdade o que foi feito (mínimo 20 caracteres, sem placeholders).",
    );
  }
  // Mission evidence cannot become workspace authority, even if guessed correctly.
  if (
    args.evidenceIds !== undefined &&
    (!Array.isArray(args.evidenceIds) || args.evidenceIds.length > 0)
  ) {
    throw new Error("trusted handoff evidence requires missionId");
  }
  const declaredStatus = handoffStatusSchema.parse(
    normalizeHandoffStatusInput(args.status),
  );
  const verdict =
    declaredStatus === "success"
      ? evaluateDeliveryContract(ctx.sessionId, args.artifacts)
      : ({ kind: "none" } as const);
  if (verdict.kind === "retry")
    throw new Error(deliveryContractRetryMessage(verdict));
  const status = verdict.kind === "exhausted" ? "blocked" : declaredStatus;
  const condensed = condenseHandoffSummary(
    filterAntiSocialChatter(rawSummary).clean,
  );
  const telemetry = sanitizeHandoffTelemetry(args.telemetry);
  const artifacts = [
    ...(Array.isArray(args.artifacts) ? args.artifacts : []),
    ...metadata,
    ...(condensed.condensed && condensed.original && !args.fullText
      ? [
          {
            kind: "overclock.fullText",
            payload: capHandoffFullText(condensed.original),
          },
        ]
      : []),
    ...(verdict.kind === "exhausted"
      ? [deliveryContractExhaustedArtifact(verdict, declaredStatus)]
      : []),
    ...(telemetry ? [embedTelemetryArtifact(telemetry)] : []),
  ];
  const assertDestinationCurrent = () => {
    assertMcpInvocationCurrent(invocation);
    const current = resolveWorkspaceHandoffParent(ctx);
    if (
      !current ||
      current.child.paneId !== destination.child.paneId ||
      current.parent.paneId !== destination.parent.paneId ||
      current.parentContext !== destination.parentContext
    ) {
      throw new Error(
        "workspace handoff parent authority changed; delivery remains queued",
      );
    }
  };
  assertDestinationCurrent();
  const store = getProjectDomainStores(ctx.scope).handoffs;
  // ponytail: the existing nullable mission_id is the workspace discriminator;
  // no mission receipt chain or task/mission transition is minted here.
  const handoff = store.submit({
    status,
    summary: condensed.summary,
    artifacts,
    sessionId: ctx.sessionId,
    fromAgent: ctx.agentName ?? ctx.label,
  });
  if (verdict.kind !== "none" && ctx.sessionId)
    disarmDeliveryContract(ctx.sessionId);
  let deliveryError: string | undefined;
  let delivered = false;
  try {
    const snapshot = listPaneSnapshots().find(
      (pane) =>
        pane.sessionId === ctx.sessionId &&
        pane.paneId === destination.child.paneId,
    );
    const title = (snapshot?.title ?? ctx.label).replace(/[\r\n\u001b]/g, " ");
    await injectPrompt(
      destination.parentContext.sessionId!,
      `[handoff sem missão] de ${destination.child.paneId} (${title}): ${handoff.summary}\n`,
      { ...invocation, assertCurrentAuthority: assertDestinationCurrent },
    );
    assertDestinationCurrent();
    delivered = store.markSubmitted(handoff.id);
  } catch (error) {
    // Persist first: a dead parent must never erase the worker's delivery.
    deliveryError = error instanceof Error ? error.message : String(error);
  }
  return {
    ok: true,
    handoffId: handoff.id,
    evidenceTrust: handoff.evidenceTrust,
    stopGateSatisfied: false,
    delivered,
    ...(deliveryError ? { deliveryError } : {}),
  };
}

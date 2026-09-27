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
import { WORKSPACE_HANDOFF_DELIVERY_PREFIX } from "./workspace-handoff-delivery";
import { findPane, listPaneSnapshots, requestPaneClose } from "./pane-registry";
import { scheduleAutoCloseAfterHandoff } from "./pane-close-scopes";
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
import { normalizeFilesModified } from "./worker-files-modified";
import {
  reviewMissionHandoff,
  type JevReviewVerdict,
} from "./jev-handoff-review";
import {
  evaluateHandoffRegressionGate,
  type RegressionHandoffVerdict,
} from "../regression-gate/regression-gate-handoff";
import { executionScopeFor } from "./gate";

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
  const declaredFiles = normalizeFilesModified({
    filesModified: args.filesModified,
    "files-modified": args["files-modified"],
    artifacts: args.artifacts,
  });
  // Portão de regressão do "+ Pane": mesmo contrato do handoff de missão —
  // teste impactado falhando devolve ao helper; esgotado, entra como blocked.
  let regressionVerdict: RegressionHandoffVerdict = {
    kind: "skipped",
    reason: "not-run",
  };
  if (
    declaredStatus === "success" &&
    ctx.readOnly !== true &&
    verdict.kind !== "exhausted"
  ) {
    assertMcpInvocationCurrent(invocation);
    regressionVerdict = await evaluateHandoffRegressionGate({
      sessionId: ctx.sessionId,
      scope: executionScopeFor(ctx),
      declaredFiles,
    });
    if (regressionVerdict.kind === "retry")
      throw new Error(regressionVerdict.message);
  }
  const status =
    verdict.kind === "exhausted" || regressionVerdict.kind === "exhausted"
      ? "blocked"
      : declaredStatus;
  const condensed = condenseHandoffSummary(
    filterAntiSocialChatter(rawSummary).clean,
  );
  // Revisão de evidência Jev no handoff sem missão: mesmo motor do handoff de
  // missão (1 devolução, depois `[evidência fraca]` no resumo que vai ao store
  // e ao pane pai + artifact `nexus.jevReview`). A correspondência continua
  // `unverified` — a revisão só filtra relatórios vazios para o operador, não
  // minta evidência nem recibo.
  let jevVerdict: JevReviewVerdict = { kind: "skipped", reason: "not-run" };
  let reviewedSummary = condensed.summary;
  if (
    declaredStatus === "success" &&
    ctx.readOnly !== true &&
    verdict.kind !== "exhausted" &&
    regressionVerdict.kind !== "exhausted"
  ) {
    assertMcpInvocationCurrent(invocation);
    try {
      jevVerdict = await reviewMissionHandoff({
        sessionId: ctx.sessionId,
        signal: invocation?.signal,
        declaredStatus,
        summary: rawSummary,
        fullText: typeof args.fullText === "string" ? args.fullText : undefined,
        accomplished: args.accomplished,
        blockers: args.blockers,
        nextSteps: args.nextSteps,
        declaredFiles,
        artifactKinds: (Array.isArray(args.artifacts) ? args.artifacts : [])
          .filter(
            (a): a is { kind: string } =>
              !!a &&
              typeof a === "object" &&
              typeof (a as Record<string, unknown>).kind === "string",
          )
          .map((a) => a.kind),
        evidenceIdsCount: 0,
        hasObservedCommit: false,
      });
    } catch (error) {
      console.warn("[handoff-workspace] revisão Jev falhou (ignorada):", error);
      jevVerdict = { kind: "skipped", reason: "review-error" };
    }
    if (jevVerdict.kind === "retry") {
      throw new Error(jevVerdict.message);
    }
    if (jevVerdict.kind === "weak") {
      reviewedSummary = `[evidência fraca] ${condensed.summary}`;
    }
  }
  if (regressionVerdict.kind === "exhausted") {
    reviewedSummary = `[testes impactados falhando] ${condensed.summary}`;
  }
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
    ...((regressionVerdict.kind === "accepted" ||
      regressionVerdict.kind === "exhausted") &&
    regressionVerdict.artifact
      ? [regressionVerdict.artifact]
      : []),
    ...(telemetry ? [embedTelemetryArtifact(telemetry)] : []),
    ...(jevVerdict.kind === "ok" || jevVerdict.kind === "weak"
      ? [jevVerdict.artifact]
      : []),
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
    summary: reviewedSummary,
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
      `${WORKSPACE_HANDOFF_DELIVERY_PREFIX} de ${destination.child.paneId} (${title}): ${handoff.summary}\n`,
      { ...invocation, assertCurrentAuthority: assertDestinationCurrent },
    );
    assertDestinationCurrent();
    delivered = store.markSubmitted(handoff.id);
  } catch (error) {
    // Persist first: a dead parent must never erase the worker's delivery.
    deliveryError = error instanceof Error ? error.message : String(error);
  }
  if (delivered) {
    scheduleAutoCloseAfterHandoff(
      ctx.sessionId,
      status,
      (sessionId) => findPane(sessionId)?.paneId ?? null,
      requestPaneClose,
    );
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

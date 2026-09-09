import { randomUUID } from "node:crypto";
import { emitDestructiveReversalEvent } from "./mission-event-emit";
import { hasReversiblePath } from "./destructive-reversibility";
import {
  hasCurrentApprovedDispatchContract,
  hasCurrentDispatchAuthority,
  reserveEffectfulSpend,
} from "../../shared/mission-intent";
import type { Mission } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import { confirmationReason } from "../jarvis/guardrails";
import {
  auditDenied,
  auditError,
  auditIntent,
  auditSuccess,
  ensureAuditLogWritable,
} from "../jarvis/audit-log";
import { consumePermission } from "../jarvis/permissions";
import {
  bindContextRevision,
  canonicalToolName,
  gateContextAbortSignal,
  isInternalPrevcReviewerToolAllowed,
  isCurrentGateContext,
  isToolAllowedForRole,
  type AgentGateContext,
} from "./gate";
import {
  effectPolicyForTool,
  isEffectfulTool,
  isToolAllowedForReadOnlyContext,
  permitsOperatorPaneEffect,
} from "./mcp-effect-policy";
import { validateToolArgs } from "./mcp-args-validation";
import type { McpRegistry, McpToolDef } from "./mcp-protocol";
import { getContextWorkflowService } from "../context/context-workflow-registry";
import { mutationTargetPaths } from "../context/context-workflow-service";
import { assertMissionIntentAllowsTool } from "./mission-intent-gate";
import {
  cancelMissionPrompt,
  completeMissionPrompt,
  enqueueMissionPrompt,
  getMissionPromptAbortSignal,
  getMissionPromptQueue,
  peekMissionPromptQueue,
  startMissionPrompt,
} from "./mission-prompt-queue-registry";
import { getProjectDomainStores } from "./project-domain-store-registry";
import {
  normalizeDispatchSessionId,
  permissionScopeForTool,
  type CommittedPhysicalHandoffReplayCandidate,
  type CommittedPhysicalHandoffReplayCandidateResolver,
  type IntentGateMissionResolver,
  type McpDispatchOptions,
  type McpDispatchSource,
  type ToolDispatchResult,
  type WorkflowAuthorityResolver,
  type WorkflowEffectAuthority,
} from "./mcp-dispatch-contract";
import {
  RENDERER_EXACT_CONSENT_TOOLS,
  isDestructiveEffect,
  requiresExactConsentReceipt,
  requiresPerActionConsent,
  requiresToolConfirmation,
} from "./mcp-consent-policy";
import { mintAgentTransportPhysicalReceipt } from "./http-mcp-boundary";
import { assertGovernedWorkspaceControlBoundary } from "./governed-workspace-control-boundary";
import {
  handoffLogicalOperationKey,
  handoffRawPayloadSha256,
} from "./handoff-payload-identity";

export {
  normalizeDispatchSessionId,
  permissionScopeForTool,
  type CommittedPhysicalHandoffReplayCandidate,
  type CommittedPhysicalHandoffReplayCandidateResolver,
  type IntentGateMissionResolver,
  type McpConfirmationHandler,
  type McpConfirmationRequest,
  type McpDispatchOptions,
  type McpDispatchSource,
  type MissionBudgetReserver,
  type ToolDispatchResult,
  type WorkflowAuthorityResolver,
  type WorkflowEffectAuthority,
} from "./mcp-dispatch-contract";

function resolveProductionWorkflowAuthority(
  scope: ProjectExecutionScope,
  missionId: string,
): WorkflowEffectAuthority {
  const service = getContextWorkflowService(scope);
  const stored = service.getMissionWorkflow(missionId).contract;
  // Via Rápida: sem PREVC cerimonial. Contratos congelados legados ainda
  // ganham o guard de mutação do workflow; o caminho simples só protege o
  // contexto versionado contra escrita de executores.
  if (!stored) {
    return Object.freeze({
      contextRevision: undefined,
      assertExecutionEffectAllowed: (
        _toolName: string,
        args: Readonly<Record<string, unknown>>,
      ) => {
        for (const candidate of mutationTargetPaths(args)) {
          if (candidate === ".context" || candidate.startsWith(".context/")) {
            throw new Error(
              "versioned context authority is read-only to executors",
            );
          }
        }
      },
    });
  }
  return Object.freeze({
    contextRevision: stored.contract.contextRevision,
    assertExecutionEffectAllowed: (
      toolName: string,
      args: Readonly<Record<string, unknown>>,
      callerReadOnly = false,
    ) =>
      service.assertMutationAllowed(missionId, toolName, args, callerReadOnly),
  });
}

function auditUnavailableResult(
  tool: string,
  err: unknown,
  effectMayHaveCommitted = false,
): ToolDispatchResult {
  console.warn("[mcp-dispatch] audit persistence unavailable:", err);
  return {
    ok: false,
    tool,
    error: "audit_unavailable",
    effectMayHaveCommitted,
  };
}

function resolveProductionMissionForIntentGate(
  scope: ProjectExecutionScope,
  missionId: string,
): ReturnType<IntentGateMissionResolver> {
  const suite = getProjectDomainStores(scope);
  const mission = suite.missions.get(missionId);
  if (!mission) return null;
  return {
    mission,
    taskCount: suite.tasks.list(mission.id).length,
    workerPaneCount: suite.missionPanes
      .list(mission.id)
      .filter((pane) => pane.role === "worker").length,
  };
}

/**
 * Read-only admission hint for the one terminal state in which the ordinary
 * mission intent gate is expected to be closed: a physical worker already
 * committed its handoff but lost the HTTP/RPC response.
 *
 * This never authorizes the replay by itself. The handoff store consumes the
 * fresh one-shot receipt and re-proves the durable original receipt/audit,
 * session/incarnation, payload and dispatch state in one IMMEDIATE
 * transaction. The retry never creates another durable receipt/effect.
 */
function resolveProductionCommittedPhysicalHandoffReplayCandidate(
  scope: ProjectExecutionScope,
  candidate: CommittedPhysicalHandoffReplayCandidate,
): boolean {
  try {
    const suite = getProjectDomainStores(scope);
    const durableMission = suite.missions.get(candidate.missionId);
    if (
      !durableMission ||
      durableMission.status !== candidate.missionStatus ||
      !hasCurrentApprovedDispatchContract(durableMission)
    ) {
      return false;
    }
    const matchingHandoffs = suite.handoffs
      .list({ missionId: candidate.missionId, includeDelivered: true })
      .filter(
        (handoff) =>
          handoff.authorityOrigin === "agent" &&
          handoff.sessionId === candidate.sessionId &&
          handoff.workerIncarnationId === candidate.workerIncarnationId &&
          (candidate.missionStatus === "done"
            ? handoff.status === "success"
            : handoff.status !== "success") &&
          handoff.mcpProvenance?.missionId === candidate.missionId &&
          handoff.mcpProvenance.sessionId === candidate.sessionId &&
          handoff.mcpProvenance.workerIncarnationId ===
            candidate.workerIncarnationId &&
          handoff.mcpProvenance.rawPayloadSha256 ===
            candidate.rawPayloadSha256 &&
          handoff.mcpProvenance.logicalOperationKey ===
            handoffLogicalOperationKey({
              scope,
              missionId: candidate.missionId,
              sessionId: candidate.sessionId,
              workerIncarnationId: candidate.workerIncarnationId,
            }),
      );
    if (matchingHandoffs.length !== 1) return false;
    const handoff = matchingHandoffs[0]!;
    const matchingDispatches = suite.taskDispatches
      .list(candidate.missionId)
      .filter(
        (dispatch) =>
          dispatch.sessionId === candidate.sessionId &&
          dispatch.workerIncarnationId === candidate.workerIncarnationId,
      );
    if (matchingDispatches.length === 0) return true;
    if (matchingDispatches.length !== 1) return false;
    const dispatch = matchingDispatches[0]!;
    const stateMatches = candidate.missionStatus === "done"
      ? dispatch.state === "handoff_ready" ||
        dispatch.state === "merging" ||
        dispatch.state === "completed"
      : dispatch.state === "blocked";
    return stateMatches && dispatch.handoffId === handoff.id;
  } catch {
    return false;
  }
}

function isCommittedPhysicalHandoffReplayCandidate(
  scope: ProjectExecutionScope,
  missionId: string,
  ctx: AgentGateContext,
  args: Readonly<Record<string, unknown>>,
  resolvedMission: Mission,
  resolveCandidate: CommittedPhysicalHandoffReplayCandidateResolver,
): boolean {
  if (
    ctx.role !== "worker" ||
    !ctx.sessionId ||
    !hasCurrentApprovedDispatchContract(resolvedMission)
  ) {
    return false;
  }
  const status = args.status;
  const success = status === "success";
  const nonSuccess =
    status === "partial" || status === "blocked" || status === "failed";
  if (!success && !nonSuccess) return false;
  const missionStatus =
    success && resolvedMission.status === "done"
      ? "done"
      : nonSuccess && resolvedMission.status === "blocked"
        ? "blocked"
        : null;
  if (!missionStatus) return false;
  try {
    return resolveCandidate(scope, {
      missionId,
      sessionId: ctx.sessionId,
      workerIncarnationId: ctx.workerIncarnationId,
      rawPayloadSha256: handoffRawPayloadSha256(args),
      handoffStatus: status,
      missionStatus,
    });
  } catch {
    return false;
  }
}

function reserveProductionMissionBudget(
  scope: ProjectExecutionScope,
  missionId: string,
  toolName: string,
  expectedIntentVersion: number,
): void {
  const suite = getProjectDomainStores(scope);
  const mission = suite.missions.get(missionId);
  if (
    !mission?.intentContract ||
    mission.intentVersion !== expectedIntentVersion ||
    !hasCurrentDispatchAuthority(mission)
  ) {
    throw new Error(
      "approval_required: mission intent changed before budget reservation",
    );
  }
  const reserved = reserveEffectfulSpend(mission.intentContract, toolName);
  if (!reserved.ok) throw new Error(reserved.error);
  const updated = suite.missions.update(missionId, {
    intentContract: reserved.contract,
  });
  if (!updated) {
    throw new Error("mission budget reservation could not be persisted");
  }
}

function writeAudit(
  write: () => void,
  tool: string,
  effectMayHaveCommitted = false,
): ToolDispatchResult | null {
  try {
    write();
    return null;
  } catch (err) {
    return auditUnavailableResult(tool, err, effectMayHaveCommitted);
  }
}

function resolveDispatchTool(
  registry: McpRegistry,
  name: string,
): McpToolDef | null {
  const canonical = canonicalToolName(name);
  return (
    registry.tools.find((tool) => canonicalToolName(tool.name) === canonical) ??
    null
  );
}

function bindEffectAuthority(
  source: McpDispatchSource,
  ctx: AgentGateContext,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  resolver: WorkflowAuthorityResolver,
): {
  readonly contextRevision: string | undefined;
  readonly workflowAuthority?: WorkflowEffectAuthority;
} {
  const policy = effectPolicyForTool(toolName);
  if (
    policy === "read-only" ||
    policy === "bootstrap-authority" ||
    policy === "handoff-authority"
  ) {
    return { contextRevision: ctx.contextRevision };
  }
  if (policy === "delegation-authority") {
    // Mão do operador sem missão: pane_spawn é o mesmo gesto que abrir um
    // pane pela UI. Ver OPERATOR_PANE_EFFECT_TOOLS.
    if (permitsOperatorPaneEffect(ctx, toolName)) {
      return { contextRevision: ctx.contextRevision };
    }
    if (ctx.role !== "orchestrator" || !ctx.missionId) {
      throw new Error(
        "delegation authority requires an orchestrator bound to a mission",
      );
    }
    return { contextRevision: ctx.contextRevision };
  }
  if (policy === "renderer-authorized-effect") {
    if (source !== "ipc-renderer" || ctx.role !== "user") {
      throw new Error(
        "renderer-authorized effect requires renderer user authority",
      );
    }
    return { contextRevision: ctx.contextRevision };
  }
  if (policy === "routine-local-operation") {
    if (source !== "ipc-renderer" || ctx.role !== "user") {
      throw new Error(
        "routine local operation requires renderer user authority",
      );
    }
    return { contextRevision: ctx.contextRevision };
  }
  if (!ctx.missionId) {
    if (permitsOperatorPaneEffect(ctx, toolName)) {
      return { contextRevision: ctx.contextRevision };
    }
    throw new Error(
      "mission effect blocked: projectId, checkoutId, missionId and contextRevision are required",
    );
  }
  const authority = resolver(ctx.scope, ctx.missionId);
  // Sem contrato congelado a autoridade permissiva não traz revision para
  // vincular — a execução segue sem bind (PREVC degrada, não bloqueia).
  if (authority.contextRevision) {
    bindContextRevision(ctx, authority.contextRevision);
  } else if (ctx.contextRevision) {
    // Paridade peer ADE: missão sem contrato PREVC congelado (ex.: lane ops)
    // não deve matar o canal de execução do agente. O token pode carregar um
    // contextRevision de spawn/rebind stale; sem contrato vivo para validar,
    // o fence degrada em vez de bloquear, preservando o circuito breaker via
    // assertExecutionEffectAllowed quando a política é execution-effect.
  }
  if (policy === "execution-effect") {
    authority.assertExecutionEffectAllowed(toolName, args, ctx.readOnly === true);
  }
  return {
    contextRevision: authority.contextRevision,
    workflowAuthority: authority,
  };
}

export async function dispatchToolCall(
  source: McpDispatchSource,
  registry: McpRegistry,
  toolName: string,
  rawArgs: unknown,
  ctx: AgentGateContext,
  options: McpDispatchOptions = {},
): Promise<ToolDispatchResult> {
  const startMs = Date.now();
  const sessionId = normalizeDispatchSessionId(source, ctx);
  const physicalAgentTransport =
    source === "http-mcp" ||
    source === "acp-stdio" ||
    source === "pty-stream" ||
    source === "mission-shim";
  const hasCurrentBearerAuthority = () =>
    (!physicalAgentTransport || isCurrentGateContext(ctx)) &&
    (options.assertCurrentCaller?.() ?? true);
  if (!hasCurrentBearerAuthority()) {
    return {
      ok: false,
      tool: toolName,
      denied: true,
      error: "session_authority_revoked",
    };
  }
  let auditContext = {
    scope: ctx.scope,
    missionId: ctx.missionId,
    contextRevision: ctx.contextRevision,
  };

  try {
    ensureAuditLogWritable(auditContext);
  } catch (err) {
    return auditUnavailableResult(toolName, err);
  }

  const tool = resolveDispatchTool(registry, toolName);
  if (!tool) {
    const args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    const auditFailure = writeAudit(
      () =>
        auditError(
          auditContext,
          sessionId,
          toolName,
          args,
          Date.now() - startMs,
          `unknown tool: ${toolName}`,
          false,
          source,
          undefined,
        ),
      toolName,
    );
    if (auditFailure) return auditFailure;
    return { ok: false, tool: toolName, error: `unknown tool: ${toolName}` };
  }

  let args: Record<string, unknown>;
  try {
    args = validateToolArgs(tool.name, rawArgs ?? {});
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const auditFailure = writeAudit(
      () =>
        auditError(
          auditContext,
          sessionId,
          tool.name,
          {},
          Date.now() - startMs,
          `invalid arguments: ${detail}`,
          false,
          source,
          undefined,
        ),
      tool.name,
    );
    if (auditFailure) return auditFailure;
    return {
      ok: false,
      tool: tool.name,
      error: `invalid arguments: ${detail}`,
    };
  }

  const denyBeforeIntent = (reason: string): ToolDispatchResult => {
    const auditFailure = writeAudit(
      () =>
        auditDenied(
          auditContext,
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          reason,
          source,
        ),
      tool.name,
    );
    return (
      auditFailure ?? {
        ok: false,
        tool: tool.name,
        denied: true,
        error: reason,
      }
    );
  };

  if (!isInternalPrevcReviewerToolAllowed(ctx, tool.name)) {
    return denyBeforeIntent(
      `tool "${tool.name}" is outside this internal reviewer's exact profile`,
    );
  }

  if (
    !isToolAllowedForRole(
      ctx.role,
      ctx.allowedTools,
      tool.name,
      ctx.petStudioMediaAuthority,
    )
  ) {
    const reason =
      `tool "${tool.name}" is outside this agent's allowlist ` +
      `(agent: ${ctx.label})`;
    const auditFailure = writeAudit(
      () =>
        auditDenied(
          auditContext,
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          reason,
          source,
        ),
      tool.name,
    );
    if (auditFailure) return auditFailure;
    return {
      ok: false,
      tool: tool.name,
      denied: true,
      error: reason,
    };
  }

  const internalReviewerReadOnlyException =
    ctx.internalPrevcReviewerAuthority !== undefined &&
    isInternalPrevcReviewerToolAllowed(ctx, tool.name);
  if (
    ctx.readOnly &&
    !internalReviewerReadOnlyException &&
    !isToolAllowedForReadOnlyContext(tool.name)
  ) {
    const reason =
      `read-only authority denied tool "${tool.name}": workspace, process, ` +
      `delegation, and external effects are unavailable (agent: ${ctx.label})`;
    const auditFailure = writeAudit(
      () =>
        auditDenied(
          auditContext,
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          reason,
          source,
        ),
      tool.name,
    );
    if (auditFailure) return auditFailure;
    return {
      ok: false,
      tool: tool.name,
      denied: true,
      error: reason,
    };
  }

  const effectPolicy = effectPolicyForTool(tool.name);
  const canonical = canonicalToolName(tool.name);
  const permitsUnboundEffect =
    canonical === "mission_create" ||
    // memory_retain é a única bootstrap-authority efetiva que precisa rodar
    // fora de missão: a memória agentic é compartilhada por TODAS as CLIs
    // hospedadas, panes livres inclusive. Exención ESTREITA por nome — não a
    // classe bootstrap-authority inteira — para não abrir escrita não-ligada a
    // missão a outras tools. A mutação é estreita e validada (≤8KB, redação de
    // segredo, dedupe) e toca só o banco de memória em userData.
    canonical === "memory_retain" ||
    // context_draft_review é a decisão do reviewer independente do bootstrap:
    // drafts de contexto de PROJETO têm missionId nulo e o reviewer pane é
    // deliberadamente spawnado sem vínculo de missão (cli-context-draft-reviewer
    // só vincula quando o draft tem missão). Sem esta exención, todo draft de
    // projeto fica eternamente 'proposed' e nenhuma missão congela contrato.
    // A autoridade real vive no handler: reviewer ≠ autor (id/sessão), provider
    // distinto e re-hash de fontes/alvo antes de aprovar (context-draft-store).
    canonical === "context_draft_review" ||
    effectPolicy === "mission-control" ||
    effectPolicy === "renderer-authorized-effect" ||
    effectPolicy === "routine-local-operation" ||
    // Mão do operador: pane_spawn/write/ask/close sem missão (campo 09/09).
    permitsOperatorPaneEffect(ctx, tool.name);
  if (isEffectfulTool(tool.name) && !ctx.missionId && !permitsUnboundEffect) {
    // Toda recusa diz o caminho que funciona. O operador num pane sem missão
    // que tenta handoff precisa ouvir "fale com o pane" ou "crie a missão",
    // não uma lista de campos internos.
    // `error` fica canônico: o smoke empacotado (mcp-write-guard) e o renderer
    // comparam a string exata. A dica de caminho vai em `hint`.
    const error =
      "mission effect blocked: projectId, checkoutId, missionId and contextRevision are required";
    const hint =
      ctx.role === "user" && canonical === "handoff_submit"
        ? "handoff exige missão: para falar com outro pane use nexus_pane_write ou nexus_pane_ask; para registrar um handoff, crie uma missão com nexus_mission_create"
        : ctx.role === "user"
          ? `${tool.name} exige missão neste pane: crie uma com nexus_mission_create (spawn/write/ask/close de panes funcionam sem missão)`
          : undefined;
    const auditFailure = writeAudit(
      () =>
        auditDenied(
          auditContext,
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          error,
          source,
        ),
      tool.name,
    );
    if (auditFailure) return auditFailure;
    return {
      ok: false,
      tool: tool.name,
      denied: true,
      error,
      ...(hint ? { hint } : {}),
    };
  }

  const resolveMission =
    options.resolveMissionForIntentGate ??
    resolveProductionMissionForIntentGate;
  const resolveCommittedReplayCandidate =
    options.resolveCommittedPhysicalHandoffReplayCandidate ??
    resolveProductionCommittedPhysicalHandoffReplayCandidate;
  type IntentCheck =
    | {
        readonly ok: true;
        readonly resolved: ReturnType<IntentGateMissionResolver>;
      }
    | { readonly ok: false; readonly error: string };
  const checkMissionIntent = (): IntentCheck => {
    if (!ctx.missionId || !isEffectfulTool(tool.name)) {
      return { ok: true, resolved: null };
    }
    try {
      const resolved = resolveMission(ctx.scope, ctx.missionId);
      if (!resolved) {
        return {
          ok: false,
          error:
            "intent_required: mission not found for intent authority check",
        };
      }
      const gate = assertMissionIntentAllowsTool(
        tool.name,
        {
          mission: resolved.mission,
          taskCount: resolved.taskCount,
          workerPaneCount: resolved.workerPaneCount,
          role: ctx.role,
          sessionId,
        },
        args,
      );
      if (gate.ok) return { ok: true, resolved };
      if (
        canonical === "handoff_submit" &&
        isCommittedPhysicalHandoffReplayCandidate(
          ctx.scope,
          ctx.missionId,
          ctx,
          args,
          resolved.mission,
          resolveCommittedReplayCandidate,
        )
      ) {
        return { ok: true, resolved };
      }
      return { ok: false, error: gate.error };
    } catch (err) {
      console.warn("[mcp-dispatch] intent gate lookup failed (deny):", err);
      return { ok: false, error: "intent_gate_unavailable" };
    }
  };
  const denyIntentCheck = (error: string): ToolDispatchResult => {
    const auditFailure = writeAudit(
      () =>
        auditDenied(
          auditContext,
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          error,
          source,
        ),
      tool.name,
    );
    return auditFailure ?? { ok: false, tool: tool.name, denied: true, error };
  };

  // First check avoids asking for confirmation when authority is already stale.
  const initialIntent = checkMissionIntent();
  if (!initialIntent.ok) return denyIntentCheck(initialIntent.error);

  try {
    const boundAuthority = bindEffectAuthority(
      source,
      ctx,
      tool.name,
      args,
      options.resolveWorkflowAuthority ?? resolveProductionWorkflowAuthority,
    );
    auditContext = {
      scope: ctx.scope,
      missionId: ctx.missionId,
      contextRevision: boundAuthority.contextRevision,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const auditFailure = writeAudit(
      () =>
        auditDenied(
          auditContext,
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          reason,
          source,
        ),
      tool.name,
    );
    if (auditFailure) return auditFailure;
    return { ok: false, tool: tool.name, denied: true, error: reason };
  }

  // The main-owned provider marker is minted at spawn time and does not depend
  // on PREVC availability. Enforce it before any handler can cross the Codex
  // process boundary.
  try {
    assertGovernedWorkspaceControlBoundary(
      ctx,
      tool.name,
      mutationTargetPaths(args),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const auditFailure = writeAudit(
      () =>
        auditDenied(
          auditContext,
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          reason,
          source,
        ),
      tool.name,
    );
    if (auditFailure) return auditFailure;
    return {
      ok: false,
      tool: tool.name,
      denied: true,
      error: reason,
    };
  }

  if (RENDERER_EXACT_CONSENT_TOOLS.has(canonicalToolName(tool.name))) {
    const exactConsentSurface =
      canonicalToolName(tool.name) === "catalog_install"
        ? "Marketplace para revisar commit, digest e alertas"
        : canonicalToolName(tool.name) === "squad_save"
          ? "editor de squads para revisar o JSON normalizado e o fingerprint"
          : "editor de agentes para revisar o conteúdo integral e o fingerprint";
    const error =
      "renderer_exact_confirmation_required: use a superfície nativa do " +
      exactConsentSurface;
    const auditFailure = writeAudit(
      () =>
        auditDenied(
          auditContext,
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          error,
          source,
        ),
      tool.name,
    );
    return (
      auditFailure ?? {
        ok: false,
        tool: tool.name,
        denied: true,
        error,
      }
    );
  }

  const confirmationRequired = requiresToolConfirmation(tool.name, args);
  const effectful = isEffectfulTool(tool.name);
  let userAuthorized = false;

  if (confirmationRequired) {
    const workspaceId = ctx.scope.rootRealPath;
    const scope = permissionScopeForTool(sessionId, ctx.scope, tool.name, args);
    userAuthorized = consumePermission(scope);
    // Piloto automático: a aprovação da missão (intent contract corrente) É a
    // autorização — o agente não para em modal a cada ação (foi o stall de
    // minutos por comando). O modal permanece para ferramentas sem missão e
    // missões sem aprovação corrente. Tudo segue auditado (userAuthorized).
    //
    // O piso destrutivo SAIU daqui: ele existia como defesa contra perda de
    // dados, e essa defesa agora é o preparo de reversibilidade acima (lixeira
    // + ref do tip anterior), que protege sem interromper. A ordem importou —
    // o mecanismo entrou antes de a pergunta sair.
    if (
      !userAuthorized &&
      initialIntent.ok &&
      initialIntent.resolved &&
      hasCurrentApprovedDispatchContract(initialIntent.resolved.mission) &&
      // O piso destrutivo cai SOMENTE onde o desfazer existe. Sem preparador
      // ligado (seams de teste, caminhos ainda não migrados) ele permanece: a
      // pergunta é pior que nada, mas melhor que perda de dados silenciosa.
      // O piso destrutivo cai SOMENTE onde o desfazer existe de fato: é preciso
      // haver preparador ligado E o comando ter caminho de volta em princípio.
      // Sem a segunda metade, mkfs/dd/DROP TABLE/unpublish — todos sem volta —
      // rodariam sem pergunta E sem desfazer, estritamente pior que a fricção
      // que a N1 removeu. Classificação é PURA: perguntar não custa efeito.
      !(
        isDestructiveEffect(tool.name, args) &&
        !(
          options.prepareDestructiveReversibility &&
          hasReversiblePath(typeof args.command === "string" ? args.command : "")
        )
      ) &&
      !requiresPerActionConsent(tool.name, args)
    ) {
      userAuthorized = true;
    }
    if (!userAuthorized) {
      const reason = confirmationReason(tool.name, args);
      if (options.confirm) {
        let approved = false;
        try {
          approved = await options.confirm({
            source,
            sessionId,
            workspaceId,
            projectId: ctx.scope.projectId,
            checkoutId: ctx.scope.checkoutId,
            missionId: ctx.missionId,
            contextRevision: ctx.contextRevision,
            toolName: tool.name,
            args,
            reason,
            agentLabel: ctx.label,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const error = "confirmation_failed";
          const auditFailure = writeAudit(
            () =>
              auditDenied(
                auditContext,
                sessionId,
                tool.name,
                args,
                Date.now() - startMs,
                `${error}: ${detail}: ${reason}`,
                source,
              ),
            tool.name,
          );
          if (auditFailure) return auditFailure;
          return {
            ok: false,
            tool: tool.name,
            denied: true,
            requiredConfirmation: true,
            confirmationReason: reason,
            error,
          };
        }

        if (approved) {
          userAuthorized = true;
        } else {
          const error = "user_denied";
          const auditFailure = writeAudit(
            () =>
              auditDenied(
                auditContext,
                sessionId,
                tool.name,
                args,
                Date.now() - startMs,
                `${error}: ${reason}`,
                source,
              ),
            tool.name,
          );
          if (auditFailure) return auditFailure;
          return {
            ok: false,
            tool: tool.name,
            denied: true,
            requiredConfirmation: true,
            confirmationReason: reason,
            error,
          };
        }
      }

      if (!userAuthorized) {
        const error = physicalAgentTransport
          ? "confirmation_ui_unavailable"
          : undefined;
        const auditReason = error ? `${error}: ${reason}` : reason;
        const auditFailure = writeAudit(
          () =>
            auditDenied(
              auditContext,
              sessionId,
              tool.name,
              args,
              Date.now() - startMs,
              auditReason,
              source,
            ),
          tool.name,
        );
        if (auditFailure) return auditFailure;
        return {
          ok: false,
          tool: tool.name,
          denied: true,
          requiredConfirmation: true,
          confirmationReason: reason,
          error,
        };
      }
    }
  }

  // Confirmation can outlive the intent or frozen workflow revision. Rebind
  // both authorities immediately before reserving budget and starting effects.
  let boundWorkflowAuthority: WorkflowEffectAuthority | undefined;
  let boundWorkflowRevision: string | undefined;
  try {
    const boundAuthority = bindEffectAuthority(
      source,
      ctx,
      tool.name,
      args,
      options.resolveWorkflowAuthority ?? resolveProductionWorkflowAuthority,
    );
    auditContext = {
      scope: ctx.scope,
      missionId: ctx.missionId,
      contextRevision: boundAuthority.contextRevision,
    };
    boundWorkflowAuthority = boundAuthority.workflowAuthority;
    boundWorkflowRevision = boundAuthority.contextRevision;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return denyIntentCheck(reason);
  }

  const finalIntent = checkMissionIntent();
  if (!finalIntent.ok) return denyIntentCheck(finalIntent.error);

  const invocationId = effectful ? randomUUID() : undefined;
  if (invocationId) {
    const auditFailure = writeAudit(
      () =>
        auditIntent(
          auditContext,
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          userAuthorized,
          source,
          invocationId,
        ),
      tool.name,
    );
    if (auditFailure) return auditFailure;
  }

  // Once an effect intent exists, every exit path must append exactly one
  // correlated terminal outcome. In particular, queue arbitration and bearer
  // revocation happen after auditIntent but before/after the handler and used
  // to leave an orphan `intent` record behind.
  let outcomeAuditWritten = false;
  const writeOutcomeAudit = (
    outcome: "success" | "error",
    error: string | undefined,
    effectStarted: boolean,
  ): ToolDispatchResult | null => {
    if (outcomeAuditWritten) return null;
    outcomeAuditWritten = true;
    return writeAudit(
      () => {
        if (outcome === "success") {
          auditSuccess(
            auditContext,
            sessionId,
            tool.name,
            args,
            Date.now() - startMs,
            userAuthorized,
            source,
            invocationId,
          );
          return;
        }
        auditError(
          auditContext,
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          error ?? "tool dispatch failed",
          userAuthorized,
          source,
          invocationId,
        );
      },
      tool.name,
      effectStarted,
    );
  };

  const denyAfterIntent = (error: string): ToolDispatchResult => {
    const auditFailure = writeOutcomeAudit("error", error, false);
    return (
      auditFailure ?? {
        ok: false,
        tool: tool.name,
        denied: true,
        error,
      }
    );
  };

  // Persist the correlated effect intent before charging mission budget. If
  // the audit INSERT fails, the reservation callback is never reached, so a
  // consumed step can never become invisible. Physical handoff spend is the
  // sole exception: its store reserves inside the same IMMEDIATE transaction
  // as receipt + payload + dispatch, avoiding both double charge and a charge
  // that survives a later dispatch CAS rollback.
  if (
    effectful &&
    canonical !== "handoff_submit" &&
    ctx.missionId &&
    finalIntent.resolved &&
    hasCurrentDispatchAuthority(finalIntent.resolved.mission)
  ) {
    try {
      (options.reserveMissionBudget ?? reserveProductionMissionBudget)(
        ctx.scope,
        ctx.missionId,
        tool.name,
        finalIntent.resolved.mission.intentVersion ?? 0,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        "[mcp-dispatch] mission budget reservation failed (deny):",
        err,
      );
      const error = /^(budget_exhausted|approval_required):/.test(detail)
        ? detail
        : "budget_reservation_unavailable";
      return denyAfterIntent(error);
    }
  }
  // Physical handoff spend is admitted and persisted by the handoff store in
  // the same IMMEDIATE transaction as the first receipt/handoff/dispatch
  // commit. An exact replay returns before that CAS, so concurrent retries can
  // never charge the logical operation twice.

  // Track only warm/bootstrap tools on the prompt queue (not mission_create /
  // set_status). Newer intentVersion preempts in-flight doctor/map work.
  let queuePromptId: string | null = null;
  let queueSignal: AbortSignal | undefined;
  const warmBootstrap =
    /context_doctor|code_map_refresh|context_scaffold|context_draft|mission_freeze/i.test(
      tool.name,
    );
  if (ctx.missionId && warmBootstrap && !ctx.readOnly) {
    try {
      const intentVersion = finalIntent.resolved?.mission.intentVersion ?? 1;
      const enq = enqueueMissionPrompt({
        scope: ctx.scope,
        missionId: ctx.missionId,
        kind: "bootstrap",
        body: tool.name,
        intentVersion,
        source: "system",
      });
      const item = enq.state.items.at(-1);
      if (item && item.status === "queued") {
        queuePromptId = item.id;
        const started = startMissionPrompt(ctx.scope, ctx.missionId, item.id);
        const executing = started.state.items.find(
          (entry) => entry.id === item.id && entry.status === "executing",
        );
        if (!executing) {
          // Retry join: when the executing slot already runs the SAME tool,
          // skip the queue and run the handler directly — the flight dedup
          // (e.g. contextDoctorFlights in tools-context) joins the in-flight
          // promise, and doctor/map/scaffold handlers are idempotent anyway.
          // Freeze is NOT idempotent, so a duplicate freeze keeps the
          // fail-safe prompt_queue_busy deny, as does a different tool.
          const current = peekMissionPromptQueue(
            ctx.scope,
            ctx.missionId,
          ).executing;
          const joinable =
            current?.body === tool.name && !/mission_freeze/i.test(tool.name);
          cancelMissionPrompt(ctx.scope, ctx.missionId, item.id);
          if (!joinable) {
            return denyAfterIntent("prompt_queue_busy");
          }
          queuePromptId = null;
        } else {
          queueSignal = getMissionPromptAbortSignal(
            ctx.scope,
            ctx.missionId,
            item.id,
          );
        }
      } else if (item?.status === "cancelled") {
        return denyAfterIntent(
          "intent_preempted: bootstrap cancelled by newer user intent",
        );
      }
    } catch (err) {
      console.warn("[mcp-dispatch] prompt queue unavailable (deny):", err);
      return denyAfterIntent("prompt_queue_unavailable");
    }
  }

  let handlerStarted = false;
  try {
    // If preempted after start (race with user submit), abort before handler.
    if (queuePromptId && ctx.missionId) {
      const current = getMissionPromptQueue(
        ctx.scope,
        ctx.missionId,
      ).items.find((entry) => entry.id === queuePromptId);
      if (current?.status === "cancelled") {
        return denyAfterIntent(
          "intent_preempted: bootstrap cancelled by newer user intent",
        );
      }
    }

    if (!hasCurrentBearerAuthority()) {
      if (queuePromptId && ctx.missionId) {
        completeMissionPrompt(ctx.scope, ctx.missionId, queuePromptId, false);
      }
      return denyAfterIntent("session_authority_revoked");
    }
    const gateSignal = physicalAgentTransport
      ? gateContextAbortSignal(ctx)
      : undefined;
    if (physicalAgentTransport && !gateSignal) {
      if (queuePromptId && ctx.missionId) {
        completeMissionPrompt(ctx.scope, ctx.missionId, queuePromptId, false);
      }
      return denyAfterIntent("session_authority_revoked");
    }
    const invocationSignals = [
      queueSignal,
      gateSignal,
      options.callerSignal,
    ].filter((signal): signal is AbortSignal => Boolean(signal));
    const invocationSignal =
      invocationSignals.length > 1
        ? AbortSignal.any(invocationSignals)
        : invocationSignals[0];
    const assertCurrentAuthorityState = (recheckIntent: boolean): void => {
      if (
        !hasCurrentBearerAuthority() ||
        gateSignal?.aborted ||
        options.callerSignal?.aborted
      ) {
        throw new Error("session_authority_revoked");
      }
      if (queueSignal?.aborted) {
        throw new Error(
          "intent_preempted: bootstrap cancelled by newer user intent",
        );
      }
      if (recheckIntent) {
        const currentIntent = checkMissionIntent();
        if (!currentIntent.ok) throw new Error(currentIntent.error);
      }
      if (boundWorkflowAuthority && ctx.missionId) {
        const currentWorkflowAuthority = (
          options.resolveWorkflowAuthority ?? resolveProductionWorkflowAuthority
        )(ctx.scope, ctx.missionId);
        if (
          currentWorkflowAuthority.contextRevision !== boundWorkflowRevision
        ) {
          throw new Error(
            "workflow_authority_revoked: context revision changed during tool execution",
          );
        }
        if (effectPolicy === "execution-effect") {
          currentWorkflowAuthority.assertExecutionEffectAllowed(
            tool.name,
            args,
            ctx.readOnly === true,
          );
        }
      }
    };
    const assertCurrentAuthority = (): void => {
      assertCurrentAuthorityState(true);
    };
    assertCurrentAuthority();
    const exactUserConsent =
      // Recibo, não modal: mintado sempre que o store exige prova de mutação
      // única — inclusive quando a autorização veio da aprovação da missão.
      // Amarrar isto ao modal era o que fazia "tirar a pergunta" quebrar o cron.
      userAuthorized && requiresExactConsentReceipt(tool.name, args)
        ? Object.freeze({
            toolName: canonicalToolName(tool.name),
            action:
              typeof args.action === "string"
                ? args.action.trim().toLowerCase()
                : "invoke",
            grantedAt: Date.now(),
            receiptId: invocationId!,
          })
        : undefined;
    const agentTransportPhysicalReceipt =
      physicalAgentTransport &&
      (
        tool.name === "nexus_handoff_submit" ||
        tool.name === "nexus_handoff_ack" ||
        (
          tool.name === "nexus_mission_set_status" &&
          args.status === "done" &&
          typeof args.note === "string" &&
          /(?:^|\n)#{1,6}[ \t]+Maestro[ \t]*(?:\r?\n|$)/iu.test(args.note)
        )
      )
        ? mintAgentTransportPhysicalReceipt({
            ctx,
            toolCallId: invocationId!,
            toolName: tool.name,
          })
        : undefined;
    // Reversibilidade ANTES do efeito (N1). O piso de consentimento destrutivo
    // existia porque `rm -rf`, `push --force` e `reset --hard` eram tidos como
    // sem volta — e só são sem volta se nada for feito antes. Construído o
    // caminho de volta, o dono deixa de ser perguntado e passa a ser informado.
    //
    // Falha aqui ABORTA: sem desfazer construído, a ação destrutiva não roda.
    // Trocar pergunta por perda de dados seria pior do que a fricção original.
    if (options.prepareDestructiveReversibility && isDestructiveEffect(tool.name, args)) {
      const command = typeof args.command === "string" ? args.command : "";
      const cwd =
        typeof args.cwd === "string" && args.cwd.length > 0
          ? args.cwd
          : ctx.scope.rootRealPath;
      const reversal = await options.prepareDestructiveReversibility({
        command,
        cwd,
      });
      if (ctx.missionId) {
        emitDestructiveReversalEvent(ctx.missionId, {
          toolName: tool.name,
          revertPath: reversal.revertPath,
          reversible: reversal.reversible,
        });
      }
    }
    handlerStarted = true;
    const result = await tool.handler(args, ctx, {
      signal: invocationSignal,
      assertCurrentAuthority,
      ...(invocationId
        ? {
            effectIntent: Object.freeze({
              toolCallId: invocationId,
              toolName: tool.name,
              source,
              issuedAt: Date.now(),
            }),
          }
        : {}),
      ...(exactUserConsent ? { exactUserConsent } : {}),
      ...(agentTransportPhysicalReceipt
        ? { agentTransportPhysicalReceipt }
        : {}),
    });
    // The handler may have awaited an OS/network boundary without performing
    // its own final checkpoint. Revalidate centrally before reporting success.
    //
    // Both physical terminal writes are intentionally self-revoking. A
    // successful handoff may demote a task/mission and mission_set_status may
    // finish it, so repeating the pre-commit running-state gate would report a
    // false error after the durable write. Their handlers checkpoint authority
    // before consuming the one-shot physical receipt. Keep bearer, abort,
    // guided and workflow checks here without requiring the former intent.
    const recheckIntent =
      canonical !== "handoff_submit" && canonical !== "mission_set_status";
    assertCurrentAuthorityState(recheckIntent);
    if (queuePromptId && ctx.missionId) {
      completeMissionPrompt(ctx.scope, ctx.missionId, queuePromptId, true);
    }
    const auditFailure = writeOutcomeAudit("success", undefined, effectful);
    if (auditFailure) return auditFailure;
    return {
      ok: true,
      tool: tool.name,
      result,
      userAuthorized,
    };
  } catch (err) {
    if (queuePromptId && ctx.missionId) {
      completeMissionPrompt(ctx.scope, ctx.missionId, queuePromptId, false);
    }
    const authorityRevoked =
      !hasCurrentBearerAuthority() ||
      gateContextAbortSignal(ctx)?.aborted === true ||
      options.callerSignal?.aborted === true;
    const errorMsg = authorityRevoked
      ? "session_authority_revoked"
      : queueSignal?.aborted
        ? "intent_preempted: bootstrap cancelled by newer user intent"
        : err instanceof Error
          ? err.message
          : String(err);
    const effectMayHaveCommitted = effectful && handlerStarted;
    const auditFailure = writeOutcomeAudit(
      "error",
      errorMsg,
      effectMayHaveCommitted,
    );
    if (auditFailure) return auditFailure;
    return {
      ok: false,
      tool: tool.name,
      error: errorMsg,
      denied: authorityRevoked || undefined,
      userAuthorized,
      effectMayHaveCommitted: effectMayHaveCommitted || undefined,
    };
  }
}

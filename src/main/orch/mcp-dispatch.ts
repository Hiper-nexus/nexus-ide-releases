import { randomUUID } from 'node:crypto';
import {
  hasCurrentDispatchAuthority,
  reserveEffectfulSpend,
} from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/types';
import { requiresConfirmation, confirmationReason } from '../jarvis/guardrails';
import {
  auditDenied,
  auditError,
  auditIntent,
  auditSuccess,
  ensureAuditLogWritable,
  type AuditSource,
} from '../jarvis/audit-log';
import {
  consumePermission,
  type PermissionScope,
} from '../jarvis/permissions';
import {
  bindContextRevision,
  canonicalToolName,
  isToolAllowedForRole,
  type AgentGateContext,
} from './gate';
import {
  effectPolicyForTool,
  isEffectfulTool,
} from './mcp-effect-policy';
import { validateToolArgs } from './mcp-args-validation';
import type { McpRegistry, McpToolDef } from './mcp-protocol';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import { assertMissionIntentAllowsTool } from './mission-intent-gate';
import {
  cancelMissionPrompt,
  completeMissionPrompt,
  enqueueMissionPrompt,
  getMissionPromptAbortSignal,
  getMissionPromptQueue,
  startMissionPrompt,
} from './mission-prompt-queue-registry';
import { getProjectDomainStores } from './project-domain-store-registry';

export type McpDispatchSource = AuditSource;

export interface ToolDispatchResult {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string;
  denied?: boolean;
  requiredConfirmation?: boolean;
  confirmationReason?: string;
  userAuthorized?: boolean;
  /** True when a failed dispatch started a high-impact handler. Never retry blindly. */
  effectMayHaveCommitted?: boolean;
}

export interface McpConfirmationRequest {
  source: McpDispatchSource;
  sessionId: string;
  workspaceId: string;
  projectId: string;
  checkoutId: string;
  missionId?: string;
  contextRevision?: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  agentLabel: string;
}

export type McpConfirmationHandler = (
  request: McpConfirmationRequest,
) => Promise<boolean>;

export interface IntentGateMissionResolver {
  (
    scope: ProjectExecutionScope,
    missionId: string,
  ): {
    mission: import('../../shared/orch-types').Mission;
    taskCount: number;
    workerPaneCount: number;
  } | null;
}

export interface McpDispatchOptions {
  confirm?: McpConfirmationHandler;
  /** Internal seam for isolated dispatch tests; production uses PREVC. */
  resolveWorkflowAuthority?: WorkflowAuthorityResolver;
  /**
   * Internal seam for intent-gate tests. Production resolves via project
   * domain stores. Missing mission always fails closed for effectful tools.
   */
  resolveMissionForIntentGate?: IntentGateMissionResolver;
  /** Internal seam; production reserves synchronously in the scoped store. */
  reserveMissionBudget?: MissionBudgetReserver;
}

export type MissionBudgetReserver = (
  scope: ProjectExecutionScope,
  missionId: string,
  toolName: string,
  expectedIntentVersion: number,
) => void;

export interface WorkflowEffectAuthority {
  readonly contextRevision: string;
  assertExecutionEffectAllowed(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): void;
}

export type WorkflowAuthorityResolver = (
  scope: ProjectExecutionScope,
  missionId: string,
) => WorkflowEffectAuthority;

const RENDERER_SESSION_ID = 'jarvis-renderer';

function resolveProductionWorkflowAuthority(
  scope: ProjectExecutionScope,
  missionId: string,
): WorkflowEffectAuthority {
  const service = getContextWorkflowService(scope);
  const stored = service.getMissionWorkflow(missionId).contract;
  if (!stored) {
    throw new Error('mission effect blocked until context and contract are frozen');
  }
  return Object.freeze({
    contextRevision: stored.contract.contextRevision,
    assertExecutionEffectAllowed: (
      toolName: string,
      args: Readonly<Record<string, unknown>>,
    ) => service.assertMutationAllowed(missionId, toolName, args),
  });
}

function normalizeSessionId(source: McpDispatchSource, ctx: AgentGateContext): string {
  if (source === 'ipc-renderer') return RENDERER_SESSION_ID;
  if (source === 'jarvis-voice') return 'jarvis-voice';
  return ctx.sessionId ?? `http:${ctx.token.slice(0, 16)}`;
}

export function permissionScopeForTool(
  sessionId: string,
  projectScope: ProjectExecutionScope,
  toolName: string,
  args: Record<string, unknown>,
): PermissionScope {
  return {
    sessionId,
    workspaceId: projectScope.rootRealPath,
    projectId: projectScope.projectId,
    checkoutId: projectScope.checkoutId,
    toolName,
    args,
  };
}

function auditUnavailableResult(
  tool: string,
  err: unknown,
  effectMayHaveCommitted = false,
): ToolDispatchResult {
  console.warn('[mcp-dispatch] audit persistence unavailable:', err);
  return {
    ok: false,
    tool,
    error: 'audit_unavailable',
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
      .filter((pane) => pane.role === 'worker').length,
  };
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
    throw new Error('approval_required: mission intent changed before budget reservation');
  }
  const reserved = reserveEffectfulSpend(mission.intentContract, toolName);
  if (!reserved.ok) throw new Error(reserved.error);
  const updated = suite.missions.update(missionId, {
    intentContract: reserved.contract,
  });
  if (!updated) {
    throw new Error('mission budget reservation could not be persisted');
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

function needsConfirmation(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  return requiresConfirmation(toolName, args);
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
): string | undefined {
  const policy = effectPolicyForTool(toolName);
  if (
    policy === 'read-only' ||
    policy === 'bootstrap-authority' ||
    policy === 'handoff-authority'
  ) {
    return ctx.contextRevision;
  }
  if (policy === 'delegation-authority') {
    if (ctx.role !== 'orchestrator' || !ctx.missionId) {
      throw new Error(
        'delegation authority requires an orchestrator bound to a mission',
      );
    }
    return ctx.contextRevision;
  }
  if (policy === 'renderer-authorized-effect') {
    if (source !== 'ipc-renderer' || ctx.role !== 'user') {
      throw new Error(
        'renderer-authorized effect requires renderer user authority',
      );
    }
    return ctx.contextRevision;
  }
  if (policy === 'routine-local-operation') {
    if (source !== 'ipc-renderer' || ctx.role !== 'user') {
      throw new Error(
        'routine local operation requires renderer user authority',
      );
    }
    return ctx.contextRevision;
  }
  if (!ctx.missionId) {
    throw new Error(
      'mission effect blocked: projectId, checkoutId, missionId and contextRevision are required',
    );
  }
  const authority = resolver(ctx.scope, ctx.missionId);
  bindContextRevision(ctx, authority.contextRevision);
  if (policy === 'execution-effect') {
    authority.assertExecutionEffectAllowed(toolName, args);
  }
  return ctx.contextRevision;
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
  const sessionId = normalizeSessionId(source, ctx);
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
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
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
    return { ok: false, tool: tool.name, error: `invalid arguments: ${detail}` };
  }

  if (!isToolAllowedForRole(ctx.role, ctx.allowedTools, tool.name)) {
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

  const effectPolicy = effectPolicyForTool(tool.name);
  const canonical = canonicalToolName(tool.name);
  const permitsUnboundEffect =
    canonical === 'mission_create' ||
    effectPolicy === 'mission-control' ||
    effectPolicy === 'renderer-authorized-effect' ||
    effectPolicy === 'routine-local-operation';
  if (isEffectfulTool(tool.name) && !ctx.missionId && !permitsUnboundEffect) {
    const error =
      'mission effect blocked: projectId, checkoutId, missionId and contextRevision are required';
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
    return { ok: false, tool: tool.name, denied: true, error };
  }

  const resolveMission =
    options.resolveMissionForIntentGate ?? resolveProductionMissionForIntentGate;
  type IntentCheck =
    | { readonly ok: true; readonly resolved: ReturnType<IntentGateMissionResolver> }
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
          error: 'intent_required: mission not found for intent authority check',
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
      return gate.ok ? { ok: true, resolved } : { ok: false, error: gate.error };
    } catch (err) {
      console.warn('[mcp-dispatch] intent gate lookup failed (deny):', err);
      return { ok: false, error: 'intent_gate_unavailable' };
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
    return (
      auditFailure ?? { ok: false, tool: tool.name, denied: true, error }
    );
  };

  // First check avoids asking for confirmation when authority is already stale.
  const initialIntent = checkMissionIntent();
  if (!initialIntent.ok) return denyIntentCheck(initialIntent.error);

  try {
    const contextRevision = bindEffectAuthority(
      source,
      ctx,
      tool.name,
      args,
      options.resolveWorkflowAuthority ?? resolveProductionWorkflowAuthority,
    );
    auditContext = {
      scope: ctx.scope,
      missionId: ctx.missionId,
      contextRevision,
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

  const confirmationRequired = needsConfirmation(tool.name, args);
  const effectful = isEffectfulTool(tool.name);
  let userAuthorized = false;

  if (confirmationRequired) {
    const workspaceId = ctx.scope.rootRealPath;
    const scope = permissionScopeForTool(sessionId, ctx.scope, tool.name, args);
    userAuthorized = consumePermission(scope);
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
          const error = 'confirmation_failed';
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
          const error = 'user_denied';
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
        const error =
          source === 'http-mcp' ? 'confirmation_ui_unavailable' : undefined;
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
  try {
    const contextRevision = bindEffectAuthority(
      source,
      ctx,
      tool.name,
      args,
      options.resolveWorkflowAuthority ?? resolveProductionWorkflowAuthority,
    );
    auditContext = {
      scope: ctx.scope,
      missionId: ctx.missionId,
      contextRevision,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return denyIntentCheck(reason);
  }

  const finalIntent = checkMissionIntent();
  if (!finalIntent.ok) return denyIntentCheck(finalIntent.error);

  if (
    effectful &&
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
      console.warn('[mcp-dispatch] mission budget reservation failed (deny):', err);
      const error = /^(budget_exhausted|approval_required):/.test(detail)
        ? detail
        : 'budget_reservation_unavailable';
      return denyIntentCheck(error);
    }
  }

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

  // Track only warm/bootstrap tools on the prompt queue (not mission_create /
  // set_status). Newer intentVersion preempts in-flight doctor/map work.
  let queuePromptId: string | null = null;
  let queueSignal: AbortSignal | undefined;
  const warmBootstrap =
    /context_doctor|code_map_refresh|context_scaffold|context_draft|mission_freeze/i.test(
      tool.name,
    );
  if (ctx.missionId && warmBootstrap) {
    try {
      const intentVersion = finalIntent.resolved?.mission.intentVersion ?? 1;
      const enq = enqueueMissionPrompt({
        missionId: ctx.missionId,
        kind: 'bootstrap',
        body: tool.name,
        intentVersion,
        source: 'system',
      });
      const item = enq.state.items.at(-1);
      if (item && item.status === 'queued') {
        queuePromptId = item.id;
        const started = startMissionPrompt(ctx.missionId, item.id);
        const executing = started.state.items.find(
          (entry) => entry.id === item.id && entry.status === 'executing',
        );
        if (!executing) {
          cancelMissionPrompt(ctx.missionId, item.id);
          return {
            ok: false,
            tool: tool.name,
            denied: true,
            error: 'prompt_queue_busy',
          };
        }
        queueSignal = getMissionPromptAbortSignal(ctx.missionId, item.id);
      } else if (item?.status === 'cancelled') {
        return {
          ok: false,
          tool: tool.name,
          denied: true,
          error: 'intent_preempted: bootstrap cancelled by newer user intent',
        };
      }
    } catch (err) {
      console.warn('[mcp-dispatch] prompt queue unavailable (deny):', err);
      return {
        ok: false,
        tool: tool.name,
        denied: true,
        error: 'prompt_queue_unavailable',
      };
    }
  }

  try {
    // If preempted after start (race with user submit), abort before handler.
    if (queuePromptId && ctx.missionId) {
      const current = getMissionPromptQueue(ctx.missionId).items.find(
        (entry) => entry.id === queuePromptId,
      );
      if (current?.status === 'cancelled') {
        return {
          ok: false,
          tool: tool.name,
          denied: true,
          error: 'intent_preempted: bootstrap cancelled by newer user intent',
        };
      }
    }

    const result = await tool.handler(args, ctx, { signal: queueSignal });
    if (queueSignal?.aborted) {
      throw new Error('intent_preempted: bootstrap cancelled by newer user intent');
    }
    if (queuePromptId && ctx.missionId) {
      completeMissionPrompt(ctx.missionId, queuePromptId, true);
    }
    const auditFailure = writeAudit(
      () =>
        auditSuccess(
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
      effectful,
    );
    if (auditFailure) return auditFailure;
    return {
      ok: true,
      tool: tool.name,
      result,
      userAuthorized,
    };
  } catch (err) {
    if (queuePromptId && ctx.missionId) {
      completeMissionPrompt(ctx.missionId, queuePromptId, false);
    }
    const errorMsg = queueSignal?.aborted
      ? 'intent_preempted: bootstrap cancelled by newer user intent'
      : err instanceof Error
        ? err.message
        : String(err);
    const auditFailure = writeAudit(
      () =>
        auditError(
          auditContext,
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          errorMsg,
          userAuthorized,
          source,
          invocationId,
        ),
      tool.name,
      effectful,
    );
    if (auditFailure) return auditFailure;
    return {
      ok: false,
      tool: tool.name,
      error: errorMsg,
      userAuthorized,
      effectMayHaveCommitted: effectful,
    };
  }
}

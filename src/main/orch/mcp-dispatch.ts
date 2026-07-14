import { randomUUID } from 'node:crypto';
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

export interface McpDispatchOptions {
  confirm?: McpConfirmationHandler;
  /** Internal seam for isolated dispatch tests; production uses PREVC. */
  resolveWorkflowAuthority?: WorkflowAuthorityResolver;
}

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
  const detail = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    tool,
    error: `audit_unavailable: ${detail}`,
    effectMayHaveCommitted,
  };
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

  // Intent-first gate: bootstrap/delegation cannot invent work without a goal.
  if (ctx.missionId && isEffectfulTool(tool.name)) {
    try {
      const suite = getProjectDomainStores(ctx.scope);
      const mission = suite.missions.get(ctx.missionId);
      if (mission) {
        const gate = assertMissionIntentAllowsTool(tool.name, {
          mission,
          taskCount: suite.tasks.list(mission.id).length,
          workerPaneCount: suite.missionPanes
            .list(mission.id)
            .filter((pane) => pane.role === 'worker').length,
        });
        if (!gate.ok) {
          const auditFailure = writeAudit(
            () =>
              auditDenied(
                auditContext,
                sessionId,
                tool.name,
                args,
                Date.now() - startMs,
                gate.error,
                source,
              ),
            tool.name,
          );
          if (auditFailure) return auditFailure;
          return {
            ok: false,
            tool: tool.name,
            denied: true,
            error: gate.error,
          };
        }
      }
    } catch (err) {
      // Store not ready — fail open only for read-only already filtered above.
      console.warn('[mcp-dispatch] intent gate lookup failed:', err);
    }
  }

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
          const error = `confirmation_failed: ${detail}`;
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

  try {
    const result = await tool.handler(args, ctx);
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
    const errorMsg = err instanceof Error ? err.message : String(err);
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

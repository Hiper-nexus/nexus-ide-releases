import fs from 'node:fs';
import path from 'node:path';
import { activeWorkspaceOrNull } from '../persistence/workspace-store';
import { requiresConfirmation, confirmationReason } from '../jarvis/guardrails';
import {
  auditDenied,
  auditError,
  auditSuccess,
  ensureAuditLogWritable,
  type AuditSource,
} from '../jarvis/audit-log';
import { hasPermission, type PermissionScope } from '../jarvis/permissions';
import {
  canonicalToolName,
  isToolAllowed,
  type AgentGateContext,
} from './gate';
import { validateToolArgs } from './mcp-args-validation';
import type { McpRegistry, McpToolDef } from './mcp-protocol';

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
}

const RENDERER_SESSION_ID = 'jarvis-renderer';

function normalizeSessionId(source: McpDispatchSource, ctx: AgentGateContext): string {
  if (source === 'ipc-renderer') return RENDERER_SESSION_ID;
  if (source === 'jarvis-voice') return 'jarvis-voice';
  return ctx.sessionId ?? `http:${ctx.token.slice(0, 16)}`;
}

export function currentPermissionWorkspaceId(): string {
  const workspace = activeWorkspaceOrNull();
  if (!workspace) return 'no-workspace';
  return fs.realpathSync(path.resolve(workspace));
}

export function permissionScopeForTool(
  sessionId: string,
  workspaceId: string,
  toolName: string,
  args: Record<string, unknown>,
): PermissionScope {
  return { sessionId, workspaceId, toolName, args };
}

function auditUnavailableResult(tool: string, err: unknown): ToolDispatchResult {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    tool,
    error: `audit_unavailable: ${detail}`,
  };
}

function writeAudit(
  write: () => void,
  tool: string,
): ToolDispatchResult | null {
  try {
    write();
    return null;
  } catch (err) {
    return auditUnavailableResult(tool, err);
  }
}

function needsConfirmation(
  tool: McpToolDef,
  args: Record<string, unknown>,
): boolean {
  return tool.requiresConfirm === true || requiresConfirmation(tool.name, args);
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

export async function dispatchToolCall(
  source: McpDispatchSource,
  registry: McpRegistry,
  toolName: string,
  rawArgs: unknown,
  ctx: AgentGateContext,
): Promise<ToolDispatchResult> {
  const startMs = Date.now();
  const sessionId = normalizeSessionId(source, ctx);

  try {
    ensureAuditLogWritable();
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
          sessionId,
          toolName,
          args,
          Date.now() - startMs,
          `unknown tool: ${toolName}`,
          false,
          source,
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
          sessionId,
          tool.name,
          {},
          Date.now() - startMs,
          `invalid arguments: ${detail}`,
          false,
          source,
        ),
      tool.name,
    );
    if (auditFailure) return auditFailure;
    return { ok: false, tool: tool.name, error: `invalid arguments: ${detail}` };
  }

  if (!isToolAllowed(ctx.allowedTools, tool.name)) {
    const reason =
      `tool "${tool.name}" is outside this agent's allowlist ` +
      `(agent: ${ctx.label})`;
    const auditFailure = writeAudit(
      () =>
        auditDenied(
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

  const confirmationRequired = needsConfirmation(tool, args);
  let userAuthorized = false;

  if (confirmationRequired) {
    let workspaceId: string;
    try {
      workspaceId = currentPermissionWorkspaceId();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, tool: tool.name, error: `workspace_unavailable: ${detail}` };
    }

    const scope = permissionScopeForTool(sessionId, workspaceId, tool.name, args);
    userAuthorized = hasPermission(scope);
    if (!userAuthorized) {
      const reason = confirmationReason(tool.name, args);
      const error =
        source === 'http-mcp' ? 'confirmation_ui_unavailable' : undefined;
      const auditReason = error ? `${error}: ${reason}` : reason;
      const auditFailure = writeAudit(
        () =>
          auditDenied(
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

  try {
    const result = await tool.handler(args, ctx);
    const auditFailure = writeAudit(
      () =>
        auditSuccess(
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          userAuthorized,
          source,
        ),
      tool.name,
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
          sessionId,
          tool.name,
          args,
          Date.now() - startMs,
          errorMsg,
          userAuthorized,
          source,
        ),
      tool.name,
    );
    if (auditFailure) return auditFailure;
    return {
      ok: false,
      tool: tool.name,
      error: errorMsg,
      userAuthorized,
    };
  }
}

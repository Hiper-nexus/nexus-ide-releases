/**
 * MCP Invoke IPC handler for Jarvis agent (Fase 4).
 *
 * Bridges renderer → main process for MCP tool invocations.
 * Applies guardrails, permission cache, and audit logging before
 * executing the tool. This is the same path CLI agents use through
 * the embedded MCP server, but reached via IPC instead of HTTP.
 */

import { dialog, ipcMain } from 'electron';
import { MCP_CHANNELS } from '../../shared/channels';
import type {
  McpConfirmRequest,
  McpConfirmResult,
  McpInvokeRequest,
  McpInvokeResult,
} from '../../shared/mcp-types';
import { resolveTool } from '../orch/mcp-protocol';
import type { McpRegistry } from '../orch/mcp-protocol';
import { buildToolset } from '../orch/tools';
import { requiresConfirmation, confirmationReason } from '../jarvis/guardrails';
import {
  grantPermission,
  clearSession,
} from '../jarvis/permissions';
import { redactArgs } from '../jarvis/audit-log';
import {
  consumeConfirmationToken,
  createConfirmationToken,
} from './confirmation-tokens';
import {
  currentPermissionWorkspaceId,
  dispatchToolCall,
  permissionScopeForTool,
} from '../orch/mcp-dispatch';
import { validateToolArgs } from '../orch/mcp-args-validation';

let registry: McpRegistry | null = null;
const RENDERER_SESSION_ID = 'jarvis-renderer';

function getRegistry(): McpRegistry {
  if (!registry) {
    registry = {
      tools: buildToolset(),
      serverName: 'nexus-ide',
      serverVersion: '0.0.0',
    };
  }
  return registry;
}

function rendererToolContext() {
  return {
    token: 'renderer-ipc',
    label: 'Jarvis Renderer',
    role: 'user' as const,
    // The local user/Jarvis surface explicitly exposes the complete registry.
    // This matters for the small high-impact subset that the server gate never
    // grants through a null (implicit) allowlist. Guardrails still require an
    // exact native confirmation and audit entry before those handlers run.
    allowedTools: getRegistry().tools.map((tool) => tool.name),
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

export async function invokeMcpTool(raw: McpInvokeRequest): Promise<McpInvokeResult> {
  const toolName = raw?.tool;

  if (!toolName || typeof toolName !== 'string') {
    return { ok: false, tool: '', error: 'invalid tool name' };
  }

  return dispatchToolCall(
    'ipc-renderer',
    getRegistry(),
    toolName,
    raw?.args ?? {},
    rendererToolContext(),
  );
}

async function requestNativeConfirmation(
  toolName: string,
  args: Record<string, unknown>,
  reason: string,
  workspaceId: string,
): Promise<boolean> {
  const redacted = JSON.stringify(redactArgs(args), null, 2);
  const result = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Deny', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: `Allow MCP tool "${toolName}"?`,
    detail:
      `Source: renderer IPC\n` +
      `Workspace: ${workspaceId}\n` +
      `Reason: ${reason}\n\n` +
      `Arguments:\n${redacted}`,
  });
  return result.response === 1;
}

export async function confirmMcpTool(raw: McpConfirmRequest): Promise<McpConfirmResult> {
  const toolName = raw?.tool;
  if (!toolName || typeof toolName !== 'string') {
    return { ok: false, error: 'invalid tool name' };
  }
  const tool = resolveTool(getRegistry(), toolName);
  if (!tool) {
    return { ok: false, error: `unknown tool: ${toolName}` };
  }

  let args: Record<string, unknown>;
  try {
    args = validateToolArgs(tool.name, raw?.args ?? {});
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `invalid arguments: ${detail}` };
  }

  let workspaceId: string;
  try {
    workspaceId = currentPermissionWorkspaceId();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `workspace_unavailable: ${detail}` };
  }

  const scope = permissionScopeForTool(
    RENDERER_SESSION_ID,
    workspaceId,
    tool.name,
    args,
  );

  if (raw.granted === true) {
    if (typeof raw.token !== 'string' || !consumeConfirmationToken(raw.token, scope)) {
      return { ok: false, error: 'invalid_confirmation_token' };
    }
    grantPermission(scope);
    return { ok: true };
  }

  if (!requiresConfirmation(tool.name, args) && tool.requiresConfirm !== true) {
    return { ok: true };
  }

  const reason = confirmationReason(tool.name, args);
  const approved = await requestNativeConfirmation(
    tool.name,
    args,
    reason,
    workspaceId,
  );
  if (!approved) return { ok: false, error: 'user_denied' };

  const token = createConfirmationToken(scope);
  if (!consumeConfirmationToken(token, scope)) {
    return { ok: false, error: 'invalid_confirmation_token' };
  }
  grantPermission(scope);
  return { ok: true };
}

export function clearMcpRendererSession(): { ok: boolean } {
  clearSession(RENDERER_SESSION_ID);
  return { ok: true };
}

/**
 * Register the mcp:invoke IPC handler.
 * This is called from main.ts during bootstrap.
 */
export function registerMcpInvokeIpc(): void {
  ipcMain.handle(
    MCP_CHANNELS.invoke,
    async (_event, raw: McpInvokeRequest): Promise<McpInvokeResult> =>
      invokeMcpTool(raw),
  );
}

/**
 * Grant permission for a tool invocation (called after user confirms).
 */
export function registerMcpConfirmIpc(): void {
  ipcMain.handle(
    MCP_CHANNELS.confirm,
    async (_event, raw: McpConfirmRequest): Promise<McpConfirmResult> =>
      confirmMcpTool(raw),
  );
}

/**
 * Clear the renderer session permissions (called when Jarvis session ends).
 */
export function registerMcpClearSessionIpc(): void {
  ipcMain.handle(MCP_CHANNELS.clearSession, async () => clearMcpRendererSession());
}

/**
 * Register all MCP invoke IPC handlers.
 */
export function registerMcpIpc(): void {
  registerMcpInvokeIpc();
  registerMcpConfirmIpc();
  registerMcpClearSessionIpc();
}

/**
 * MCP Invoke IPC handler for Jarvis agent (Fase 4).
 *
 * Bridges renderer → main process for MCP tool invocations.
 * Applies guardrails, permission cache, and audit logging before
 * executing the tool. This is the same path CLI agents use through
 * the embedded MCP server, but reached via IPC instead of HTTP.
 */

import { ipcMain } from 'electron';
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
  hasPermission,
  grantPermission,
  clearSession,
} from '../jarvis/permissions';
import { auditSuccess, auditError, auditDenied } from '../jarvis/audit-log';

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

function normalizeArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function rendererToolContext() {
  return {
    token: 'renderer-ipc',
    label: 'Jarvis Renderer',
    role: 'user' as const,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

export async function invokeMcpTool(raw: McpInvokeRequest): Promise<McpInvokeResult> {
  const toolName = raw?.tool;
  const args = normalizeArgs(raw?.args);

  if (!toolName || typeof toolName !== 'string') {
    return { ok: false, tool: '', error: 'invalid tool name' };
  }

  const startMs = Date.now();
  const sessionId = RENDERER_SESSION_ID;

  const tool = resolveTool(getRegistry(), toolName);
  if (!tool) {
    const durationMs = Date.now() - startMs;
    auditError(
      sessionId,
      toolName,
      args,
      durationMs,
      `unknown tool: ${toolName}`,
      false,
    );
    return {
      ok: false,
      tool: toolName,
      error: `unknown tool: ${toolName}`,
    };
  }

  const needsConfirmation = requiresConfirmation(tool.name, args);
  const isUserAuthorized = needsConfirmation && hasPermission(sessionId, tool.name, args);
  if (needsConfirmation && !isUserAuthorized) {
    const durationMs = Date.now() - startMs;
    const reason = confirmationReason(tool.name, args);
    auditDenied(sessionId, tool.name, args, durationMs, reason);
    return {
      ok: false,
      tool: tool.name,
      denied: true,
      requiredConfirmation: true,
      confirmationReason: reason,
    };
  }

  try {
    const result = await tool.handler(args, rendererToolContext());
    const durationMs = Date.now() - startMs;
    auditSuccess(
      sessionId,
      tool.name,
      args,
      durationMs,
      isUserAuthorized,
    );
    return {
      ok: true,
      tool: tool.name,
      result,
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errorMsg = err instanceof Error ? err.message : String(err);
    auditError(
      sessionId,
      tool.name,
      args,
      durationMs,
      errorMsg,
      isUserAuthorized,
    );
    return {
      ok: false,
      tool: tool.name,
      error: errorMsg,
    };
  }
}

export function confirmMcpTool(raw: McpConfirmRequest): McpConfirmResult {
  const toolName = raw?.tool;
  const args = normalizeArgs(raw?.args);
  if (!toolName || typeof toolName !== 'string') {
    return { ok: false, error: 'invalid tool name' };
  }
  const tool = resolveTool(getRegistry(), toolName);
  if (!tool) {
    return { ok: false, error: `unknown tool: ${toolName}` };
  }
  grantPermission(RENDERER_SESSION_ID, tool.name, args);
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

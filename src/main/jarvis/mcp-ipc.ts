/**
 * MCP Invoke IPC handler for Jarvis agent (Fase 4).
 *
 * Bridges renderer → main process for MCP tool invocations.
 * Applies guardrails, permission cache, and audit logging before
 * executing the tool. This is the same path CLI agents use through
 * the embedded MCP server, but reached via IPC instead of HTTP.
 */

import { ipcMain } from 'electron';
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

export interface McpInvokeRequest {
  tool: string;
  args: Record<string, unknown>;
}

export interface McpInvokeResult {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string;
  denied?: boolean;
  requiredConfirmation?: boolean;
  confirmationReason?: string;
}

/**
 * Register the mcp:invoke IPC handler.
 * This is called from main.ts during bootstrap.
 */
export function registerMcpInvokeIpc(): void {
  ipcMain.handle(
    'mcp:invoke',
    async (_event, raw: McpInvokeRequest): Promise<McpInvokeResult> => {
      const { tool: toolName, args } = raw;

      if (!toolName || typeof toolName !== 'string') {
        return { ok: false, tool: '', error: 'invalid tool name' };
      }

      const startMs = Date.now();
      const sessionId = 'jarvis-renderer'; // Single session for renderer-initiated calls

      // Resolve the tool
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

      // Check guardrails for confirmation requirement
      const needsConfirmation = requiresConfirmation(tool.name, args);
      if (needsConfirmation && !hasPermission(sessionId, tool.name, args)) {
        const reason = confirmationReason(tool.name, args);
        return {
          ok: false,
          tool: tool.name,
          requiredConfirmation: true,
          confirmationReason: reason,
        };
      }

      // Execute the tool
      try {
        // Create a minimal context for the tool handler
        const ctx = {
          token: 'renderer-ipc',
          label: 'Jarvis Renderer',
          role: 'user' as const,
          allowedTools: null,
          allowedSkills: null,
          stopAttempts: 0,
          handoffSubmitted: false,
        };
        const result = await tool.handler(args, ctx);
        const durationMs = Date.now() - startMs;
        auditSuccess(
          sessionId,
          tool.name,
          args,
          durationMs,
          needsConfirmation,
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
          needsConfirmation,
        );
        return {
          ok: false,
          tool: tool.name,
          error: errorMsg,
        };
      }
    },
  );
}

/**
 * Grant permission for a tool invocation (called after user confirms).
 */
export function registerMcpConfirmIpc(): void {
  ipcMain.handle(
    'mcp:confirm',
    async (_event, raw: { tool: string; args: Record<string, unknown> }): Promise<{ ok: boolean }> => {
      const sessionId = 'jarvis-renderer';
      grantPermission(sessionId, raw.tool, raw.args);
      return { ok: true };
    },
  );
}

/**
 * Clear the renderer session permissions (called when Jarvis session ends).
 */
export function registerMcpClearSessionIpc(): void {
  ipcMain.handle('mcp:clearSession', async () => {
    clearSession('jarvis-renderer');
    return { ok: true };
  });
}

/**
 * Register all MCP invoke IPC handlers.
 */
export function registerMcpIpc(): void {
  registerMcpInvokeIpc();
  registerMcpConfirmIpc();
  registerMcpClearSessionIpc();
}
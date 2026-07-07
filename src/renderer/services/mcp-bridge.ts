/**
 * MCP Bridge — renderer-side client for invoking MCP tools through IPC.
 *
 * Instead of the renderer calling actions directly (the old switch in
 * voice-controller.ts), this bridge routes tool invocations through the
 * main process MCP server so they follow the same path as CLI agents:
 * guardrails → permissions → audit log → tool execution.
 *
 * Usage:
 *   import { mcpInvoke } from '../services/mcp-bridge';
 *   const result = await mcpInvoke('nexus_file_read', { path: 'src/main.ts' });
 */

import type { JarvisAction } from '../../shared/voice-ipc';
import type { McpInvokeResult } from '../../shared/mcp-types';

/**
 * Map a JarvisAction to the corresponding MCP tool name and args.
 * Returns null for actions that don't have an MCP equivalent yet.
 */
export function mapActionToTool(
  action: JarvisAction,
): { tool: string; args: Record<string, unknown> } | null {
  switch (action.type) {
    case 'none':
      return null;
    case 'open_squad':
      return null; // Squad launch is UI-only, no MCP equivalent
    case 'open_workspace':
      return null; // Workspace switching is UI-only
    case 'design_squad':
      return null; // Squad design is UI-only
    case 'new_mission':
      return null; // Mission wizard is UI-only
    case 'open_terminal':
      return { tool: 'nexus_pane_spawn', args: { adapterId: 'shell', title: 'Terminal' } };
    case 'close_pane':
      return null; // Needs paneId from focused pane — deferred
    case 'open_board':
      return null; // UI toggle
    case 'send_to_pane':
      return {
        tool: 'nexus_pane_write',
        args: { text: action.text, submit: true },
      };
    case 'run_command':
      return { tool: 'nexus_terminal_run', args: { command: action.command } };
    default:
      return null;
  }
}

/**
 * Invoke an MCP tool through the IPC bridge.
 * This goes through the main process, which applies guardrails,
 * permissions, and audit logging.
 */
export async function mcpInvoke(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<McpInvokeResult> {
  try {
    const result = await window.nexus.mcp.invoke(tool, args);
    return result;
  } catch (err) {
    return {
      ok: false,
      tool,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function mcpConfirm(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    return await window.nexus.mcp.confirm(tool, args);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function mcpClearSession(): Promise<{ ok: boolean }> {
  try {
    return await window.nexus.mcp.clearSession();
  } catch {
    return { ok: false };
  }
}

/**
 * Convenience: invoke a JarvisAction through MCP when possible.
 * Falls back to null for actions without MCP equivalents.
 */
export async function invokeActionViaMcp(
  action: JarvisAction,
): Promise<McpInvokeResult | null> {
  const mapping = mapActionToTool(action);
  if (!mapping) return null;
  return mcpInvoke(mapping.tool, mapping.args);
}

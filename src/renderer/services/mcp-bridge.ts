/**
 * MCP Bridge — renderer-side client for invoking MCP tools through IPC.
 */

import type { JarvisAction } from '../../shared/voice-ipc';
import type { McpInvokeResult } from '../../shared/mcp-types';

export interface McpPaneContext {
  focusedPaneId?: string | null;
  orchestratorPaneId?: string | null;
}

/**
 * Map a JarvisAction to the corresponding MCP tool name and args.
 * Returns null for actions that must stay on the UI path (squads, panes, wizards).
 */
export function mapActionToTool(
  action: JarvisAction,
  paneCtx?: McpPaneContext,
): { tool: string; args: Record<string, unknown> } | null {
  switch (action.type) {
    case 'none':
      return null;
    case 'mcp_tool':
      return { tool: action.tool, args: action.args ?? {} };
    case 'open_squad':
    case 'open_workspace':
    case 'design_squad':
    case 'new_mission':
    case 'new_workspace':
    case 'open_board':
    case 'open_terminal':
    case 'open_settings':
    case 'open_voice_settings':
    case 'open_canvas':
    case 'open_grid':
    case 'open_browser':
    case 'browser_back':
    case 'browser_forward':
    case 'browser_reload':
    case 'focus_next_pane':
    case 'focus_previous_pane':
    case 'focus_pane':
    case 'close_pane':
      return null;
    case 'send_to_pane': {
      const paneId = paneCtx?.orchestratorPaneId ?? paneCtx?.focusedPaneId;
      if (!paneId) return null;
      return {
        tool: 'nexus_pane_write',
        args: { paneId, text: action.text, submit: true },
      };
    }
    case 'run_command':
      return { tool: 'nexus_terminal_run', args: { command: action.command } };
    default:
      return null;
  }
}

export async function mcpInvoke(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<McpInvokeResult> {
  try {
    return await window.nexus.mcp.invoke(tool, args);
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

/** Confirma (se necessário) e executa um tool MCP com guardrails do main. */
export async function invokeMcpWithConfirm(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<McpInvokeResult> {
  let result = await mcpInvoke(tool, args);
  if (result.ok) return result;
  if (result.denied && result.requiredConfirmation) {
    const confirm = await mcpConfirm(tool, args);
    if (!confirm.ok) {
      return { ok: false, tool, error: confirm.error ?? 'user_denied' };
    }
    return mcpInvoke(tool, args);
  }
  return result;
}

export async function mcpClearSession(): Promise<{ ok: boolean }> {
  try {
    return await window.nexus.mcp.clearSession();
  } catch {
    return { ok: false };
  }
}

export async function invokeActionViaMcp(
  action: JarvisAction,
  paneCtx?: McpPaneContext,
): Promise<McpInvokeResult | null> {
  const mapping = mapActionToTool(action, paneCtx);
  if (!mapping) return null;
  return invokeMcpWithConfirm(mapping.tool, mapping.args);
}

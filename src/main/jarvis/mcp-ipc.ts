/**
 * MCP Invoke IPC handler for Jarvis agent (Fase 4).
 *
 * Bridges renderer → main process for MCP tool invocations.
 * Applies guardrails, permission cache, and audit logging before
 * executing the tool. This is the same path CLI agents use through
 * the embedded MCP server, but reached via IPC instead of HTTP.
 */

import { ipcMain } from 'electron';
import { showMessageBoxWithoutBlocking } from '../native-confirm';
import { MCP_CHANNELS } from '../../shared/channels';
import type {
  McpConfirmRequest,
  McpConfirmResult,
  McpInvokeRequest,
  McpInvokeResult,
} from '../../shared/mcp-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { resolveTool } from '../orch/mcp-protocol';
import type { McpRegistry } from '../orch/mcp-protocol';
import { loadToolset } from '../orch/toolset-loader';
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
  dispatchToolCall,
  permissionScopeForTool,
  type McpDispatchOptions,
} from '../orch/mcp-dispatch';
import { validateToolArgs } from '../orch/mcp-args-validation';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { isRuntimeProcessAdmissionSealedForShutdown, runtimeProcessAdmissionAbortSignal } from '../runtime-process-inventory';
import { sameProjectScope } from '../orch/project-scoped-broadcast';

let registry: McpRegistry | null = null;
const RENDERER_SESSION_ID = 'jarvis-renderer';

async function getRegistry(): Promise<McpRegistry> {
  if (!registry) {
    registry = {
      tools: await loadToolset(),
      serverName: 'nexus-ide',
      serverVersion: '0.0.0',
    };
  }
  return registry;
}

async function rendererToolContext(scope: ProjectExecutionScope) {
  const tools = (await getRegistry()).tools;
  return {
    token: 'renderer-ipc',
    label: 'Jarvis Renderer',
    role: 'user' as const,
    // The local user/Jarvis surface explicitly exposes the complete registry.
    // This matters for the small high-impact subset that the server gate never
    // grants through a null (implicit) allowlist. Guardrails still require an
    // exact native confirmation and audit entry before those handlers run.
    allowedTools: tools.map((tool) => tool.name),
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    scope,
    executionScope: scope,
  };
}

export async function invokeMcpTool(
  raw: McpInvokeRequest,
  projectScope: ProjectExecutionScope,
  dispatchOptions: Pick<
    McpDispatchOptions,
    'assertCurrentCaller' | 'callerSignal'
  > = {},
): Promise<McpInvokeResult> {
  const toolName = raw?.tool;
  if(isRuntimeProcessAdmissionSealedForShutdown()) return {ok:false,tool:typeof toolName==='string'?toolName:'',denied:true,error:'app_shutdown'};

  if (!toolName || typeof toolName !== 'string') {
    return { ok: false, tool: '', error: 'invalid tool name' };
  }

  return dispatchToolCall(
    'ipc-renderer',
    await getRegistry(),
    toolName,
    raw?.args ?? {},
    await rendererToolContext(projectScope),
    {
      ...dispatchOptions,
      callerSignal: dispatchOptions.callerSignal
        ? AbortSignal.any([dispatchOptions.callerSignal,runtimeProcessAdmissionAbortSignal()])
        : runtimeProcessAdmissionAbortSignal(),
      assertCurrentCaller: () => !isRuntimeProcessAdmissionSealedForShutdown() && (dispatchOptions.assertCurrentCaller?.() ?? true),
    },
  );
}

async function requestNativeConfirmation(
  toolName: string,
  args: Record<string, unknown>,
  reason: string,
  workspaceId: string,
): Promise<boolean> {
  const redacted = JSON.stringify(redactArgs(args), null, 2);
  // F-1202: a JARVIS decide a ação por voz, com o Nexus muitas vezes fora de
  // foco. Sem janela-mãe o macOS prendia a main thread até o clique. Sheet numa
  // janela viva; sem janela, nega.
  const result = await showMessageBoxWithoutBlocking({
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
  return result?.response === 1;
}

export async function confirmMcpTool(
  raw: McpConfirmRequest,
  projectScope: ProjectExecutionScope,
): Promise<McpConfirmResult> {
  const toolName = raw?.tool;
  if(isRuntimeProcessAdmissionSealedForShutdown()) return {ok:false,error:'app_shutdown'};
  if (!toolName || typeof toolName !== 'string') {
    return { ok: false, error: 'invalid tool name' };
  }
  const tool = resolveTool(await getRegistry(), toolName);
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

  const scope = permissionScopeForTool(
    RENDERER_SESSION_ID,
    projectScope,
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

  if (!requiresConfirmation(tool.name, args)) {
    return { ok: true };
  }

  const reason = confirmationReason(tool.name, args);
  const approved = await requestNativeConfirmation(
    tool.name,
    args,
    reason,
    projectScope.rootRealPath,
  );
  if(isRuntimeProcessAdmissionSealedForShutdown()) return {ok:false,error:'app_shutdown'};
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
    async (event, raw: McpInvokeRequest): Promise<McpInvokeResult> => {
      const sender = event.sender;
      const projectScope = requireRendererWorkspaceScope(sender);
      const callerAbort = new AbortController();
      const abortCaller = (): void => callerAbort.abort();
      sender.once('destroyed', abortCaller);
      sender.once('render-process-gone', abortCaller);
      try {
        return await invokeMcpTool(raw, projectScope, {
          callerSignal: callerAbort.signal,
          assertCurrentCaller: () => {
            if (sender.isDestroyed() || sender.isCrashed()) return false;
            try {
              return sameProjectScope(
                requireRendererWorkspaceScope(sender),
                projectScope,
              );
            } catch {
              return false;
            }
          },
        });
      } finally {
        sender.removeListener('destroyed', abortCaller);
        sender.removeListener('render-process-gone', abortCaller);
      }
    },
  );
}

/**
 * Grant permission for a tool invocation (called after user confirms).
 */
export function registerMcpConfirmIpc(): void {
  ipcMain.handle(
    MCP_CHANNELS.confirm,
    async (event, raw: McpConfirmRequest): Promise<McpConfirmResult> =>
      confirmMcpTool(raw, requireRendererWorkspaceScope(event.sender)),
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

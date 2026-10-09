import { createHash } from 'node:crypto';
import { canonicalJson } from '../context/canonical-json';
import { executionScopeFor, isCurrentGateContext, type AgentGateContext } from './gate';
import type { McpDispatchSource } from './mcp-dispatch-contract';

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Main computes both key and binding; neither is accepted from tool arguments.
 * RPC ids remain correlation only. A changed binding under the same supported
 * explicit id is a conflict, not a new executable key. No auth fingerprint or
 * raw bearer/provider credential is retained in this metadata.
 */
export function captureCommandDispatchIdentity(
  source: McpDispatchSource,
  ctx: AgentGateContext,
  tool: string,
  args: Record<string, unknown>,
  explicitId: string | undefined,
  intentVersion?: number,
): { readonly commandId?: string; readonly bindingDigest: string; readonly args: Record<string, unknown> } {
  if (explicitId !== undefined &&
      (typeof explicitId !== 'string' || !explicitId.length || explicitId.length > 128 || /[\0-\x1f]/u.test(explicitId))) {
    throw new Error('command_operation_id_invalid');
  }
  if (explicitId !== undefined &&
      (!['http-mcp','acp-stdio','pty-stream','mission-shim'].includes(source) ||
       !ctx.sessionId || !isCurrentGateContext(ctx) || (ctx.role === 'worker' && !ctx.workerIncarnationId))) {
    throw new Error('command_operation_identity_unsupported');
  }
  const snapshot = freezeJson(JSON.parse(canonicalJson(args)) as Record<string, unknown>);
  const caller = {
    source,
    installationId: ctx.scope.installationId,
    projectId: ctx.scope.projectId,
    checkoutId: ctx.scope.checkoutId,
    sessionId: ctx.sessionId,
    workerIncarnationId: ctx.workerIncarnationId,
    providerId: ctx.providerId,
  };
  return {
    commandId: explicitId === undefined ? undefined : digest({ caller, explicitId }),
    bindingDigest: digest({
      caller, tool, args: snapshot, scope: ctx.scope, executionScope: executionScopeFor(ctx),
      missionId: ctx.missionId, contextRevision: ctx.contextRevision, intentVersion,
      role: ctx.role, readOnly: ctx.readOnly === true,
      promotedFromUserSession: ctx.promotedFromUserSession === true,
      agentName: ctx.agentName, governedNativeProvider: ctx.governedNativeProvider,
      allowedTools: ctx.allowedTools, allowedSkills: ctx.allowedSkills,
      isolatedWriter: ctx.isolatedWriter === true, sharedTabWorktree: ctx.sharedTabWorktree === true,
      petStudioMediaAuthority: ctx.petStudioMediaAuthority === true,
      internalPrevcReviewerAuthority: ctx.internalPrevcReviewerAuthority,
      operatorParentSessionId: ctx.operatorParentSessionId, visualTask: ctx.visualTask,
      tokenDigest: createHash('sha256').update(ctx.token).digest('hex'),
    }),
    args: snapshot,
  };
}

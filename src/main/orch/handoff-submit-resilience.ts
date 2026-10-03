/**
 * Envoltório do `nexus_handoff_submit` — o handler (contrato, Jev, portão de
 * regressão, recibo físico) fica intacto; aqui entram deveres de resiliência
 * que precisam enxergar TODO submit, de qualquer transporte (http-mcp,
 * mission-shim, pty-stream):
 *
 *  - F-794: depois de um handoff persistido por writer isolado, agenda a
 *    salvaguarda da worktree (alteração sem commit vira commit em
 *    refs/nexus-salvage/, sem tocar branch, índice ou arquivos).
 */
import type { McpToolDef } from './mcp-protocol';
import { executionScopeFor, type AgentGateContext } from './gate';
import { isIsolatedWriterContext } from './isolated-writer-policy';
import { OPERATOR_HAND_WORKTREE_KEY } from './isolated-writer-worktree';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import type { WorktreeRecord } from '../runtime/worktree-contract';
import { scheduleWorktreeSalvage } from './isolated-writer-salvage';

function handoffIdOf(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  return record.ok === true && typeof record.handoffId === 'string' ? record.handoffId : undefined;
}

/**
 * F-794: o writer isolado entregou — se a worktree dele ainda tem alteração sem
 * commit, o Nexus guarda um snapshot. A worktree é a do registro do Main (a
 * mesma prova de `assertIsolatedGitAuthority`), nunca um caminho do agente.
 */
export function scheduleHandoffWorktreeSalvage(
  ctx: AgentGateContext,
  handoffId: string,
): boolean {
  if (ctx.readOnly === true || !isIsolatedWriterContext(ctx)) return false;
  const registryKey = ctx.missionId ?? (ctx.isolatedWriter === true ? OPERATOR_HAND_WORKTREE_KEY : undefined);
  if (!registryKey) return false;
  const worktreePath = executionScopeFor(ctx).rootRealPath;
  let record: WorktreeRecord | undefined;
  try {
    record = requireWorktreeRuntimeRegistry()
      .listMission(ctx.scope, registryKey)
      .find((candidate) => candidate.worktreePath === worktreePath && candidate.ownerKind === 'pane');
  } catch (error) {
    console.warn('[worktree-salvage] registro da worktree indisponível no handoff:', error);
    return false;
  }
  if (!record) return false;
  void scheduleWorktreeSalvage({
    worktreePath: record.worktreePath,
    branchRef: record.branchRef,
    missionId: registryKey,
    taskId: record.taskId,
    reason: 'handoff',
    handoffId,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    agentLabel: ctx.agentName ?? ctx.label,
  }, { scope: ctx.scope, notify: ctx.missionId !== undefined });
  return true;
}

export function withHandoffSubmitResilience(tool: McpToolDef): McpToolDef {
  return {
    ...tool,
    handler: async (args, ctx, invocation) => {
      const result = await tool.handler(args, ctx, invocation);
      const handoffId = handoffIdOf(result);
      if (handoffId) {
        try {
          scheduleHandoffWorktreeSalvage(ctx, handoffId);
        } catch (error) {
          // Salvaguarda é rede de segurança: nunca derruba o handoff entregue.
          console.warn('[worktree-salvage] agendamento no handoff falhou:', error);
        }
      }
      return result;
    },
  };
}

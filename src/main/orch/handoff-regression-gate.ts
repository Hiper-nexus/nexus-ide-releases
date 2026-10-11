/**
 * Etapa COMUM do portão de regressão antes de persistir um handoff de
 * escrita: MCP de missão, MCP do "+ Pane", bloco no PTY e fechamento
 * mecânico passam todos por aqui, com as mesmas entradas resolvidas pelo Main
 * — base (registro durável do writer isolado > worktree da missão > HEAD no
 * spawn), spawn da sessão e o checkout principal do projeto para dependências.
 * Nada vem do transporte ou do texto do agente.
 */
import type { Mission } from '../../shared/orch-types';
import { executionScopeFor, type AgentGateContext } from './gate';
import type { McpToolInvocation } from './mcp-protocol';
import { missionExecutionBaseSha } from './mission-execution-scope';
import { isolatedWriterBaseShaOfSession } from './isolated-writer-worktree';
import { getSessionFirstIncarnationAtMs } from '../pty/pty-manager';
import {
  evaluateHandoffRegressionGate,
  type RegressionHandoffVerdict,
} from '../regression-gate/regression-gate-handoff';

export function evaluateWriterHandoffRegression(
  ctx: Pick<AgentGateContext, 'sessionId' | 'scope' | 'executionScope'>,
  input: {
    readonly declaredFiles?: readonly string[];
    readonly mission?: Pick<Mission, 'intentContract'>;
    readonly invocation?: McpToolInvocation;
    /** false: transporte sem canal de volta (PTY) — falha entra como blocked. */
    readonly returnable?: boolean;
  } = {},
): Promise<RegressionHandoffVerdict> {
  const execution = executionScopeFor(ctx);
  let baseSha = ctx.sessionId
    ? isolatedWriterBaseShaOfSession(ctx.scope, execution.rootRealPath, ctx.sessionId)
    : undefined;
  if (!baseSha && input.mission) {
    try {
      baseSha = missionExecutionBaseSha(ctx.scope, input.mission);
    } catch {
      baseSha = undefined;
    }
  }
  return evaluateHandoffRegressionGate({
    sessionId: ctx.sessionId,
    scope: execution,
    projectScope: ctx.scope,
    declaredFiles: input.declaredFiles,
    baseSha,
    // Sem base registrada: o HEAD no spawn é a base, e o WIP sujo antes do
    // spawn (operador, outro writer) não é cobrado de quem entrega. Retomada
    // exata conta desde a primeira encarnação da conversa (F-1237).
    startedAtMs: ctx.sessionId ? (getSessionFirstIncarnationAtMs(ctx.sessionId) ?? undefined) : undefined,
    trustedDependencyRoot: ctx.scope.rootRealPath,
    signal: input.invocation?.signal,
    authority: input.invocation,
    returnable: input.returnable,
  });
}

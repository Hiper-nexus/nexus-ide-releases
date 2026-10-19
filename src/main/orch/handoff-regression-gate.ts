/**
 * Etapa COMUM do portão de regressão antes de persistir um handoff de
 * escrita: MCP de missão, MCP do "+ Pane", bloco no PTY e fechamento
 * mecânico passam todos por aqui, com as mesmas entradas resolvidas pelo Main
 * — base (registro durável do writer isolado > worktree da missão > HEAD no
 * spawn), spawn da sessão e o checkout principal do projeto para dependências.
 * Nada vem do transporte ou do texto do agente.
 */
import path from 'node:path';
import type { Mission } from '../../shared/orch-types';
import { executionScopeFor, type AgentGateContext } from './gate';
import type { McpToolInvocation } from './mcp-protocol';
import { missionExecutionBaseSha } from './mission-execution-scope';
import { isolatedWriterBaseShaOfSession } from './isolated-writer-worktree';
import { getSessionSpawnedAtMs } from '../pty/pty-manager';
import { confineEditedPath, recordedEditsForSession } from './hook-edit-provenance';
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
    /** Persistir o handoff primeiro e executar o portão fora da resposta MCP. */
    readonly background?: boolean;
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
  // F-1283: caminho declarado absoluto dentro da raiz de execução vira
  // relativo (realpath, mesmo confinamento da proveniência). O portão descarta
  // caminho absoluto: na retomada de CLI sem PostToolUse, o arquivo que o
  // próprio writer declarou passava por WIP alheio e a falha por herdada.
  const root = execution.rootRealPath;
  const declaredFiles = input.declaredFiles?.map((file) =>
    path.isAbsolute(file) ? (confineEditedPath(root, root, file) ?? file) : file,
  );
  return evaluateHandoffRegressionGate({
    sessionId: ctx.sessionId,
    scope: execution,
    projectScope: ctx.scope,
    declaredFiles,
    baseSha,
    // Sem base registrada: o HEAD no spawn é a base, e o WIP sujo antes do
    // spawn (operador, outro writer) não é cobrado de quem entrega.
    startedAtMs: ctx.sessionId ? (getSessionSpawnedAtMs(ctx.sessionId) ?? undefined) : undefined,
    // F-1237: retomada exata responde pelo que a própria conversa editou.
    recordedEdits: recordedEditsForSession(ctx.sessionId, execution.rootRealPath),
    trustedDependencyRoot: ctx.scope.rootRealPath,
    signal: input.invocation?.signal,
    authority: input.invocation,
    returnable: input.returnable,
    background: input.background,
  });
}

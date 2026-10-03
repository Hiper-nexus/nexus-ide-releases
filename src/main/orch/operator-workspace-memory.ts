import type { AgentGateContext } from './gate';
import { isOperatorHandContext, providerReceivesContextOnlyByHook } from './operator-hand-context';
import {
  standingWorkspaceMemoryBlock,
  workspaceMemoryContextBlock,
} from '../memory/workspace-memory-context';

type OperatorContext = Pick<AgentGateContext, 'role' | 'missionId' | 'providerId'> &
  Partial<Pick<AgentGateContext, 'scope' | 'executionScope' | 'promotedFromUserSession' | 'operatorParentSessionId'>>;

/**
 * `<workspace-memory>` do "+ Pane" (sem missão, sem brief), pelos canais do
 * `<business-model>`: `instructions` do MCP para toda CLI — o que alcança
 * o Grok, sem hook que injete contexto — e o hook para o Codex (cola as
 * instructions em cada tool) e o Kimi (não as lê, F-802). Helper (tem pane pai) e missão já
 * recebem o bloco no brief de spawn (tool-util): aqui ficam de fora.
 * No hook há prompt, então o recall é por relevância; no MCP, as mais
 * importantes do projeto.
 */
export function operatorWorkspaceMemoryContext(
  ctx: OperatorContext,
  channel: 'mcp' | 'hook',
  prompt?: string,
): string | null {
  if (!isOperatorHandContext(ctx) || ctx.operatorParentSessionId) return null;
  if (providerReceivesContextOnlyByHook(ctx.providerId) !== (channel === 'hook')) return null;
  const scope = ctx.executionScope ?? ctx.scope;
  if (!scope) return null;
  return channel === 'hook'
    ? workspaceMemoryContextBlock(scope, prompt ?? '', 'execution')
    : standingWorkspaceMemoryBlock(scope);
}

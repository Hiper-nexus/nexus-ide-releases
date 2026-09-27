import type { AgentGateContext } from './gate';
import { businessModelContextBlock } from '../context/business-model/business-model-context-block';

type OperatorContext = Pick<AgentGateContext, 'role' | 'missionId' | 'providerId'> &
  Partial<Pick<AgentGateContext, 'scope' | 'executionScope'>>;

/**
 * `<business-model>` para o pane da mão do operador ("+ Pane", sem missão),
 * que não nasce com brief. Mesmo canal da doutrina de delegação: `instructions`
 * do MCP para toda CLI, e hook UserPromptSubmit para o Codex (que cola as
 * instructions em cada tool). Missão recebe no brief de spawn (tool-util).
 */
export function operatorBusinessModelContext(
  ctx: OperatorContext,
  channel: 'mcp' | 'hook',
): string | null {
  if (ctx.role !== 'user' || ctx.missionId) return null;
  if ((ctx.providerId === 'codex') !== (channel === 'hook')) return null;
  const root = ctx.executionScope?.rootRealPath ?? ctx.scope?.rootRealPath;
  return root ? businessModelContextBlock(root) : null;
}

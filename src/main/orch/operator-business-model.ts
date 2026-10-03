import type { AgentGateContext } from './gate';
import { isOperatorHandContext } from './operator-hand-context';
import { businessModelContextBlock } from '../context/business-model/business-model-context-block';
import { getAdapter } from '../adapters/adapter-registry';
import { acceptsClaudeMcpCliFlags } from './spawn-home-policy';

type OperatorContext = Pick<AgentGateContext, 'role' | 'missionId' | 'providerId'> &
  Partial<Pick<AgentGateContext, 'scope' | 'executionScope' | 'promotedFromUserSession'>>;

/**
 * O pane do provider recebe o `UserPromptSubmit → /hook/delegate`? Claude-family
 * (settings `--settings`/HOME efêmero), Codex (`-c hooks.…`) e, desde o F-802,
 * Kimi (`hooks` do config.toml do overlay; a saída do comando entra no contexto
 * como mensagem) têm o hook Nexus instalado no spawn — é lá que o bloco POR
 * TAREFA chega. Grok (o hook só observa: a saída é descartada), agy (outro
 * evento e schema), MiMo e MiniMax (hook só por plugin) seguem recebendo o
 * bloco ESTÁTICO pelas `instructions` do MCP initialize.
 */
export function providerHasDelegateHook(providerId: string | undefined): boolean {
  if (!providerId) return false;
  const id = providerId.trim().toLowerCase();
  // Builtins claude/openclaude/codex: o registry vazio (teste, boot cedo) não
  // pode fingir que um pane Claude não tem hook — ele tem por construção.
  if (id === 'codex' || id === 'claude' || id === 'openclaude' || id === 'kimi') return true;
  const adapter = getAdapter(providerId);
  return adapter !== null && adapter.kind === 'cli-pty' && acceptsClaudeMcpCliFlags(adapter);
}

/**
 * `<business-model>` para o pane da mão do operador ("+ Pane", sem missão),
 * que não nasce com brief. Canal por provider: hook para quem tem o delegate
 * (a seleção por tarefa chega lá), instructions do MCP para quem não tem.
 * Missão recebe no brief de spawn (tool-util).
 */
export function operatorBusinessModelContext(
  ctx: OperatorContext,
  channel: 'mcp' | 'hook',
): string | null {
  if (!isOperatorHandContext(ctx)) return null;
  if (providerHasDelegateHook(ctx.providerId) !== (channel === 'hook')) return null;
  const scope = ctx.executionScope ?? ctx.scope;
  return scope ? businessModelContextBlock(scope, ctx.scope) : null;
}

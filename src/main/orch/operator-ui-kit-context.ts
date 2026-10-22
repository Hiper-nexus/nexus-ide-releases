import type { AgentGateContext } from './gate';
import { isOperatorHandContext } from './operator-hand-context';
import { providerHasDelegateHook } from './operator-business-model';
import { UI_KIT_BRIEF_LINE } from './design-charter';

type OperatorContext = Pick<AgentGateContext, 'role' | 'missionId' | 'providerId'> &
  Partial<Pick<AgentGateContext, 'promotedFromUserSession'>>;

/**
 * The UI kit line for a "+ Pane" whose CLI has no `/hook/delegate`.
 *
 * The design charter — and the kit inside it — reaches the operator's pane on
 * its first UI request through the delegate hook. AGY, Grok, Qwen, Devin,
 * MiMo, MiniMax, Muse and OpenCode have no such hook, so they never heard of
 * the kit (review 22/10). Their channel is the MCP `initialize` instructions,
 * the same one the business model uses; the line is two sentences and
 * self-gating ("install a component instead of re-typing it"), so it costs a
 * backend task nothing. Mission workers get it in their brief instead.
 */
export function operatorUiKitContext(
  ctx: OperatorContext,
  channel: 'mcp' | 'hook',
): string | null {
  if (channel !== 'mcp') return null;
  if (!isOperatorHandContext(ctx)) return null;
  if (providerHasDelegateHook(ctx.providerId)) return null;
  return UI_KIT_BRIEF_LINE;
}

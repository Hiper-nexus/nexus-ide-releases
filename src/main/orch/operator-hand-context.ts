import type { AgentGateContext } from './gate';

/** Main-owned origin survives promotion: adopting a mission is still the operator's pane. */
export function isOperatorHandContext(
  ctx: Pick<AgentGateContext, 'role' | 'missionId'> &
    Partial<Pick<AgentGateContext, 'promotedFromUserSession'>>,
): boolean {
  return ctx.role === 'user'
    ? !ctx.missionId
    : ctx.role === 'orchestrator' && ctx.promotedFromUserSession === true;
}

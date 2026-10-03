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

/**
 * F-802: CLIs cujo contexto do motor chega SÓ pelo hook `UserPromptSubmit`.
 * O Codex cola as `instructions` do MCP no começo da descrição de CADA tool
 * (a doutrina viraria ~150 KB); o Kimi nem as lê (o cliente MCP guarda o campo
 * e nada o consome — leitura estática do binário instalado, 03/10/2026). Para as duas,
 * doutrina, modelo de negócio e memória vão pelo hook, uma vez por sessão a
 * cada 30 min, em vez de pelo `initialize`.
 */
export function providerReceivesContextOnlyByHook(providerId: string | undefined): boolean {
  const id = providerId?.trim().toLowerCase();
  return id === 'codex' || id === 'kimi';
}

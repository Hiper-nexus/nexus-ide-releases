import type { AgentGateContext } from './gate';
import { providerReceivesContextOnlyByHook } from './operator-hand-context';

/**
 * Doutrina de delegação dos panes da mão do operador (C1, 25/09): todo pane
 * sem missão — os abertos no "+" e os helpers que eles abrem — distribui o
 * trabalho em vez de executar tudo sozinho, e leva um ponteiro curto para as
 * regras de código (ponytail) e de UI que os workers recebem no spawn. Vai no
 * `instructions` do `initialize` do MCP. Quem as lê (leitura estática dos
 * binários, 03/10/2026): Claude/OpenClaude, Qwen e OpenCode; provável no Grok e
 * no agy; Kimi, MiMo e MiniMax as ignoram (o Kimi recebe pelo hook; MiMo e
 * MiniMax ficam sem canal — F-802). Teto: 1,5 KB.
 * Missão tem doutrina própria (orchestrator-doctrine.ts) e não recebe esta.
 */
export const OPERATOR_DELEGATION_DOCTRINE = [
  'NEXUS — COMO TRABALHAR NESTE PANE:',
  '1. Delegue o que for divisível, pesado ou paralelizável: nexus_pane_spawn({ task, prompt }). O Nexus escolhe CLI, modelo e esforço; só use adapterId + model se o operador nomeou a CLI ou o modelo.',
  '2. Pesquisa, revisão, análise e leitura de testes: readOnly: true, em paralelo.',
  '3. Quem altera código: writers em paralelo, cada um em worktree/branch própria (isolatedWriter: true); você integra.',
  '4. Depois de delegar, encerre o turno: a entrega chega sozinha. Não leia panes em loop.',
  '5. Ao receber cada entrega: integre, verifique e reporte ao operador.',
  '6. Tarefa pequena ou conversa: faça você mesmo.',
  '7. Helper (aberto por outro pane): termine com nexus_handoff_submit uma vez — o que fez, validou e bloqueou.',
  '8. Spawn recusado (teto de panes): não insista — faça a parte ou espere a entrega em curso.',
  '9. Dúvida de CLI, modelo, esforço ou skill: nexus_route_task({ task }) (devolve a skill sugerida). Dúvida de ferramenta: nexus_tool_pick({ need }). Decisão do projeto: nexus_memory_recall antes.',
  '10. Código: skill ponytail — reuse o que existe, o menor diff correto e um teste que falhe se a lógica quebrar.',
  '11. UI: leia o contrato (DESIGN.md ou .context/docs/design-system.md); sem ele, use uma referência de nexus_design_system_local_list e diga qual. Sem cara de IA: emoji como ícone, texto em gradiente, gradiente roxo, cards iguais.',
  '12. Páginas (ler, extrair, responsividade, screenshot): nexus_browser_* (já tem sessão), não WebFetch, Playwright ou Firecrawl.',
].join('\n');

/**
 * O Codex (0.155, provado em 25/09) cola as instructions do servidor MCP no
 * começo da descrição de CADA tool: a doutrina viraria ~150 KB num pane
 * gravável de 165 tools. O Kimi nem lê as instructions (F-802). Para os dois a
 * doutrina vai pelo hook UserPromptSubmit (hook-delegate-endpoint), uma vez por
 * sessão.
 */
export function operatorDelegationInstructions(
  ctx: Pick<AgentGateContext, 'role' | 'missionId' | 'providerId'>,
): string | undefined {
  if (ctx.role !== 'user' || ctx.missionId || providerReceivesContextOnlyByHook(ctx.providerId)) {
    return undefined;
  }
  return OPERATOR_DELEGATION_DOCTRINE;
}

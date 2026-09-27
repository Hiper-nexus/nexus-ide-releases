import type { AgentGateContext } from './gate';

/**
 * Doutrina de delegação dos panes da mão do operador (C1, 25/09): todo pane
 * sem missão — os abertos no "+" e os helpers que eles abrem — distribui o
 * trabalho em vez de executar tudo sozinho, e leva um ponteiro curto para as
 * regras de código (ponytail) e de UI que os workers recebem no spawn. Vai no
 * `instructions` do `initialize` do MCP, que qualquer CLI com MCP pode ler
 * (inclusive as sem hook UserPromptSubmit). Teto: 1,5 KB.
 * Missão tem doutrina própria (orchestrator-doctrine.ts) e não recebe esta.
 */
export const OPERATOR_DELEGATION_DOCTRINE = [
  'NEXUS — COMO TRABALHAR NESTE PANE:',
  '1. Delegue o que for divisível, pesado ou paralelizável: nexus_pane_spawn({ task, prompt }). O Nexus (Jev) escolhe CLI, modelo e esforço — descreva a tarefa em task. Para um modelo específico, passe adapterId + model (ex.: codex + gpt-6-astra).',
  '2. Pesquisa, revisão, análise e leitura de testes: readOnly: true. Esses helpers rodam em paralelo.',
  '3. Quem altera código: writers em paralelo, cada um em worktree/branch própria (isolatedWriter: true; o Nexus isola sozinho quem colidiria). Você integra as branches entregues.',
  '4. Depois de delegar, encerre o turno: a entrega chega sozinha no seu input. Não fique lendo panes em loop.',
  '5. Ao receber cada entrega: integre, verifique e reporte ao operador.',
  '6. Tarefa pequena ou conversa: faça você mesmo.',
  '7. Se você foi aberto por outro pane (é helper), termine com nexus_handoff_submit uma vez: o que fez, o que validou, o que bloqueou.',
  '8. Spawn recusado (teto de panes): não insista — faça a parte você mesmo ou espere a entrega em curso.',
  '9. Código: siga a skill ponytail — reuse o que existe, o menor diff correto e um teste que falhe se a lógica quebrar.',
  '10. UI: leia antes o contrato do projeto (DESIGN.md ou .context/docs/design-system.md); sem contrato, escolha uma referência com nexus_design_system_local_list e diga qual usou. Nada de cara de IA: emoji como ícone, texto em gradiente, gradiente roxo, cards idênticos.',
].join('\n');

/**
 * O Codex (0.155, provado em 25/09) cola as instructions do servidor MCP no
 * começo da descrição de CADA tool: a doutrina viraria ~150 KB num pane
 * gravável de 165 tools. Para ele a doutrina vai pelo hook UserPromptSubmit
 * (hook-delegate-endpoint), uma vez por sessão.
 */
export function operatorDelegationInstructions(
  ctx: Pick<AgentGateContext, 'role' | 'missionId' | 'providerId'>,
): string | undefined {
  if (ctx.role !== 'user' || ctx.missionId || ctx.providerId === 'codex') return undefined;
  return OPERATOR_DELEGATION_DOCTRINE;
}

import type { AgentGateContext } from './gate';

/**
 * Doutrina de delegação dos panes da mão do operador (C1, 25/09): todo pane
 * sem missão — os abertos no "+" e os helpers que eles abrem — distribui o
 * trabalho em vez de executar tudo sozinho. Vai no `instructions` do
 * `initialize` do MCP, que qualquer CLI com MCP pode ler. Teto: 1,5 KB.
 * Missão tem doutrina própria (orchestrator-doctrine.ts) e não recebe esta.
 */
export const OPERATOR_DELEGATION_DOCTRINE = [
  'NEXUS — COMO TRABALHAR NESTE PANE:',
  '1. Delegue o que for divisível, pesado ou paralelizável: nexus_pane_spawn({ task, prompt }). O Nexus (Jev) escolhe CLI, modelo e esforço — descreva a tarefa em task.',
  '2. Pesquisa, revisão, análise e leitura de testes: readOnly: true. Esses helpers rodam em paralelo.',
  '3. Quem altera código: um helper por vez. Enquanto um helper que escreve estiver rodando, você não edita arquivos.',
  '4. Depois de delegar, encerre o turno: a entrega chega sozinha no seu input. Não fique lendo panes em loop.',
  '5. Ao receber cada entrega: integre, verifique e reporte ao operador.',
  '6. Tarefa pequena ou conversa: faça você mesmo.',
  '7. Se você foi aberto por outro pane (é helper), termine com nexus_handoff_submit uma vez: o que fez, o que validou, o que bloqueou.',
  '8. Spawn recusado (writer ativo, teto de panes): não insista — faça a parte você mesmo ou espere a entrega em curso.',
].join('\n');

export function operatorDelegationInstructions(
  ctx: Pick<AgentGateContext, 'role' | 'missionId'>,
): string | undefined {
  return ctx.role === 'user' && !ctx.missionId ? OPERATOR_DELEGATION_DOCTRINE : undefined;
}

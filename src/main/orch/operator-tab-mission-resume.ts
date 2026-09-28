import type { Mission, MissionPaneSpec, SquadAgent } from '../../shared/orch-types';

/**
 * Retomada da missão da aba (F-661).
 *
 * A missão leve da aba (0.76.110) nasce SEM squad, do pane que o operador
 * abriu pelo "+ Pane", e é esse pane que a lidera. Quando o app fecha, a
 * missão é estacionada e o PTY do pane morre; no "Retomar" (ou "Pedir um
 * ajuste") o respawn subia o Maestro do squad padrão com o título da missão
 * como brief — um Claude novo, sem a conversa, perguntando "o que devo fazer?".
 * Retomar a missão da aba é retomar a CONVERSA de quem a liderava.
 */

/** Nota colada na conversa retomada quando o operador não mandou ajuste. */
export const OPERATOR_TAB_RESUME_NOTE =
  '[Nexus] Esta conversa foi retomada como orquestrador da missão da aba ' +
  '(o app reiniciou ou a missão foi reaberta). Continue de onde parou; se ' +
  'estava esperando uma resposta minha, pergunte de novo. ' +
  'Para trabalho divisível, pesado ou paralelizável, use nexus_pane_spawn({task, prompt}); ' +
  'análise/revisão usa readOnly:true, escrita paralela usa isolatedWriter:true quando o escopo permitir. ' +
  'Não duplique trabalho já despachado: consulte os handoffs. Integre e valide as entregas; feche os helpers após usá-los. ' +
  'Tarefa pequena ou conversa pode ser feita aqui. Respeite pausas, orçamento e restrições explícitas do operador e do ambiente; ' +
  'se alguma restrição impedir delegar, explique qual em vez de ficar parado.';

/**
 * O orquestrador cuja conversa deve ser retomada, ou null quando a missão não
 * é da aba (tem squad ou não adotou um pane). Devolve o orquestrador MAIS
 * RECENTE da composição: a cada retomada a conversa continua no pane novo, e
 * `list` devolve os orquestradores em ordem de criação.
 */
export function operatorTabMissionResumeSpec(
  mission: Pick<Mission, 'squadId' | 'intentContract'>,
  specs: readonly MissionPaneSpec[],
): MissionPaneSpec | null {
  if (mission.squadId) return null;
  if (!mission.intentContract?.workspaceBinding?.adoptedPaneId) return null;
  const orchestrators = specs.filter(
    (spec) => spec.role === 'orchestrator' && Boolean(spec.paneId) && Boolean(spec.adapterId),
  );
  return orchestrators.at(-1) ?? null;
}

/** O pane do operador descrito como o orquestrador que o spawn espera. */
export function operatorTabResumeAgent(spec: MissionPaneSpec): SquadAgent {
  return {
    id: 'operator-tab-orchestrator',
    agentName: spec.agentName?.trim() || spec.title?.trim() || 'Orquestrador',
    category: 'orchestrator',
    cli: spec.adapterId,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort } : {}),
    allowedTools: spec.allowedTools ?? null,
    allowedSkills: spec.allowedSkills ?? null,
  };
}

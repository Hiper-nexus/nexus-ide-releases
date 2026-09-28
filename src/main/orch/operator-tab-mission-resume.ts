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

/** Missão leve da aba: sem squad, liderada pelo pane que o operador abriu. */
export function isOperatorTabMission(
  mission: Pick<Mission, 'squadId' | 'intentContract'>,
): boolean {
  return !mission.squadId && Boolean(mission.intentContract?.workspaceBinding?.adoptedPaneId);
}

/** Nota colada na conversa retomada quando o operador não mandou ajuste. */
export const OPERATOR_TAB_RESUME_NOTE =
  '[Nexus] Esta conversa foi retomada como orquestrador da missão da aba ' +
  '(o app reiniciou ou a missão foi reaberta). Continue de onde parou; se ' +
  'estava esperando uma resposta minha, pergunte de novo. Se esta conversa ' +
  'começou agora, sem histórico, diga isso ao operador e leia ' +
  'nexus_handoff_list({full:true}) antes de agir — não invente o objetivo.';

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
  if (!isOperatorTabMission(mission)) return null;
  const orchestrators = specs.filter(
    (spec) => spec.role === 'orchestrator' && Boolean(spec.paneId) && Boolean(spec.adapterId),
  );
  return orchestrators.at(-1) ?? null;
}

/**
 * O orquestrador que abriu a missão: o pane do "+ Pane" do operador. Dele vêm
 * o modelo e o esforço quando a linha da conversa não guarda um (F-664: o
 * Maestro que a 0.76.111 subia por engano nascia sem modelo e cada retomada
 * herdava o padrão da CLI).
 */
export function operatorTabMissionLeader(
  specs: readonly MissionPaneSpec[],
): MissionPaneSpec | null {
  return specs.find((spec) => spec.role === 'orchestrator' && Boolean(spec.adapterId)) ?? null;
}

/** O pane do operador descrito como o orquestrador que o spawn espera. */
export function operatorTabResumeAgent(
  spec: MissionPaneSpec,
  leader?: MissionPaneSpec | null,
): SquadAgent {
  const sameCli = leader?.adapterId === spec.adapterId ? leader : null;
  const model = spec.model ?? sameCli?.model;
  const effort = spec.effort ?? sameCli?.effort;
  return {
    id: 'operator-tab-orchestrator',
    agentName: spec.agentName?.trim() || spec.title?.trim() || 'Orquestrador',
    category: 'orchestrator',
    cli: spec.adapterId,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    allowedTools: spec.allowedTools ?? null,
    allowedSkills: spec.allowedSkills ?? null,
  };
}

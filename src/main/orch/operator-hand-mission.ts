import {
  compileIntentContract,
  MISSION_INTENT_GOAL_MAX_CHARS,
  suggestMissionLaneFromGoal,
  type MissionIntentContract,
} from '../../shared/mission-intent';
import { TAB_COMPLETION_INSTRUCTION } from './operator-tab-completion';

/**
 * Contrato da missão que a mão do operador cria em Autopilot: aprovado e
 * despachado agora (é o próprio operador pedindo), em modo livre. Os
 * guardrails que não são cerimônia — containment, allowlists, 1 escritor por
 * checkout, maxWorkers — continuam valendo a jusante.
 *
 * F-785: a categoria de entrega (lane) nasce AQUI, classificada pelo mesmo
 * classificador do wizard — sem ela um pedido de só sincronizar o repositório
 * nascia `standard` e o done era recusado por não haver arquivo, embora o
 * gate de entrega já aceitasse ops/consulta com nota durável.
 */
export function operatorHandMissionContract(
  title: string,
  description: string | undefined,
  milestones: readonly string[],
): MissionIntentContract {
  const now = Date.now();
  const acceptanceCriteria = milestones
    .map((milestone) => milestone.trim().slice(0, 2_048))
    .filter((milestone) => milestone.length > 0)
    .slice(0, 32);
  const goal = (description?.trim() || title).slice(0, MISSION_INTENT_GOAL_MAX_CHARS);
  return {
    ...compileIntentContract({
      goal,
      lane: suggestMissionLaneFromGoal(goal) ?? undefined,
      source: 'typed',
      intentVersion: 1,
      executionMode: 'autopilot',
      contextPolicy: 'on-demand',
      freeAgentChoice: true,
      ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    }),
    approvedAt: now,
    dispatchedAt: now,
  };
}

/**
 * A linha que o pane recém-promovido recebe: sem ela o Quadro mostra uma
 * missão em andamento cujo orquestrador não sabe que lidera. Uma linha só,
 * colada como qualquer briefing; falhar em avisar nunca desfaz a promoção.
 */
export function tabMissionLeaderNotice(missionTitle: string): string {
  const title = missionTitle.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Missão da aba';
  return (
    `[Nexus] Você agora orquestra a ${title}. Helpers que abrir com ` +
    'nexus_pane_spawn entram nela e as entregas deles chegam aqui. ' + TAB_COMPLETION_INSTRUCTION
  );
}

export async function announceTabMissionLeader(
  sessionId: string,
  missionTitle: string,
  inject: (sessionId: string, text: string) => Promise<void>,
): Promise<boolean> {
  try {
    await inject(sessionId, tabMissionLeaderNotice(missionTitle));
    return true;
  } catch (error) {
    console.warn('[tab-mission] aviso ao orquestrador não entregue:', error);
    return false;
  }
}

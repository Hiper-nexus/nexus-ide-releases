import {
  compileIntentContract,
  isExplicitGitSyncGoal,
  MISSION_INTENT_GOAL_MAX_CHARS,
  type MissionIntentContract,
  type MissionLane,
} from '../../shared/mission-intent';
import { TAB_COMPLETION_INSTRUCTION } from './operator-tab-completion';
import { MAESTRO_STANDING_DOCTRINE } from './orchestrator-doctrine';

/**
 * Única categoria que a mão do operador aceita derivar do texto: `ops` quando o
 * objetivo INTEIRO é, de forma explícita, sincronizar o repositório (F-785,
 * F-811). Nunca consult nem plan.
 */
export function operatorHandMissionLane(goal: string): MissionLane | undefined {
  return isExplicitGitSyncGoal(goal) ? 'ops' : undefined;
}

/**
 * Contrato da missão que a mão do operador cria em Autopilot: aprovado e
 * despachado agora (é o próprio operador pedindo), em modo livre. Os
 * guardrails que não são cerimônia — containment, allowlists, 1 escritor por
 * checkout, maxWorkers — continuam valendo a jusante.
 *
 * F-810: a missão da mão do operador existe para HOSPEDAR helpers (o "+ Pane",
 * o `/hook/delegate`, "Tornar orquestrador", `nexus_mission_create`). A
 * categoria de entrega NUNCA vem do classificador de texto livre do wizard:
 * ele devolvia consult/plan/ops para "Analise o fluxo de login…" ou para uma
 * aba chamada "Deploy"/"Auditoria"/"Planejamento", e essas lanes zeram
 * `maxWorkers` — o pane virava orquestrador de uma missão que recusava todo
 * `nexus_pane_spawn` ("budget_exhausted: maxWorkers is 0"). Por padrão a missão
 * é `standard`.
 *
 * Única exceção (F-785): quem CRIA a missão para si com um objetivo que é, por
 * inteiro e de forma explícita, sincronizar o repositório
 * (`recognizeGitSync`, só `nexus_mission_create`) nasce `ops`, para o done
 * com nota durável fechar sem arquivo. Os caminhos que adotam o pane ou o
 * primeiro helper (título = pedido/nome da aba) nunca passam essa opção.
 */
export function operatorHandMissionContract(
  title: string,
  description: string | undefined,
  milestones: readonly string[],
  options: { readonly recognizeGitSync?: boolean } = {},
): MissionIntentContract {
  const now = Date.now();
  const acceptanceCriteria = milestones
    .map((milestone) => milestone.trim().slice(0, 2_048))
    .filter((milestone) => milestone.length > 0)
    .slice(0, 32);
  const goal = (description?.trim() || title).slice(0, MISSION_INTENT_GOAL_MAX_CHARS);
  const lane = options.recognizeGitSync ? operatorHandMissionLane(goal) : undefined;
  return {
    ...compileIntentContract({
      goal,
      ...(lane ? { lane } : {}),
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
 *
 * Bug7: o pane nasceu `user` e o `initialize` do MCP já entregou a doutrina
 * do operador ("tarefa pequena: faça você"); a promoção só mutava o ctx em
 * memória e a doutrina do Maestro nunca chegava. O aviso carrega a doutrina
 * permanente inteira (achatada numa linha, como o resto do aviso); o hook
 * a reentrega a cada 30 min para o promovido (hook-delegate-endpoint).
 */
export function tabMissionLeaderNotice(missionTitle: string): string {
  const title = missionTitle.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Missão da aba';
  return (
    `[Nexus] Você agora orquestra a ${title}. Helpers que abrir com ` +
    'nexus_pane_spawn entram nela e as entregas deles chegam aqui. ' +
    'A doutrina do pane do operador não vale mais aqui; vale esta: ' +
    MAESTRO_STANDING_DOCTRINE.replace(/\n/gu, ' ') +
    ' ' + TAB_COMPLETION_INSTRUCTION
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

import type { Mission } from '../../shared/orch-types';
import { missionBlockCause } from '../../shared/mission-block-cause';
import {
  isInFlightStatus,
  missionIsOperationallyActive,
} from '../lib/mission-rail-groups';

/**
 * WHAT A SOLITARY VACANCY SHOULD SAY.
 *
 * Pure: no store, no React — the copy decision is testable on its own and the
 * component only renders it.
 *
 * The grid area is never "nothing". Either the workspace genuinely has no work
 * on screen (and the vacancy must teach what the area is and how to claim it),
 * or a mission owns this workspace's attention and has not put a pane on screen
 * yet — and THAT is the content. A shell prompt in that second case is the
 * worst available answer: it reads as work in progress and tells the operator
 * nothing about a mission that is, in fact, waiting on them.
 */

export type PaneVacancyIntent =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'mission-unstaged';
      readonly missionId: string;
      readonly missionTitle: string;
      /** What happened, one sentence. */
      readonly headline: string;
      /** What the operator does now — never truncated away. */
      readonly nextStep: string;
    };

/**
 * The mission that owns the attention of an empty grid.
 *
 * `blocked` outranks `running`: a blocked mission is the one waiting on a
 * human, while a running one that has not presented yet is seconds away from
 * replacing this vacancy outright (I1). Ties break on the most recent update.
 *
 * `hasVisiblePanes` is false by construction — the caller only reaches here
 * when the whole tree is one vacancy, so no pane is bound to any mission.
 */
export function paneVacancyMission(
  missions: readonly Mission[],
): Mission | null {
  const candidates = missions.filter(
    (mission) =>
      isInFlightStatus(mission.status) ||
      missionIsOperationallyActive(mission, false),
  );
  if (candidates.length === 0) return null;
  const rank = (mission: Mission): number =>
    mission.status === 'blocked' ? 0 : 1;
  return (
    [...candidates].sort(
      (a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt,
    )[0] ?? null
  );
}

const PREPARING_HEADLINE =
  'A missão está preparando os agentes — nenhum pane foi aberto ainda.';
const PREPARING_NEXT_STEP =
  'Abra o diagnóstico se ela não abrir nenhum agente em instantes.';

export function paneVacancyIntent(
  missions: readonly Mission[],
): PaneVacancyIntent {
  const mission = paneVacancyMission(missions);
  if (!mission) return { kind: 'idle' };
  if (mission.status !== 'blocked') {
    return {
      kind: 'mission-unstaged',
      missionId: mission.id,
      missionTitle: mission.title,
      headline: PREPARING_HEADLINE,
      nextStep: PREPARING_NEXT_STEP,
    };
  }
  // A razão já é durável: nunca inventar aqui, só transportar.
  const cause = missionBlockCause({
    status: mission.status,
    intentState: mission.intentState ?? null,
    description: mission.description ?? '',
  });
  return {
    kind: 'mission-unstaged',
    missionId: mission.id,
    missionTitle: mission.title,
    headline: cause.headline,
    nextStep: cause.action,
  };
}

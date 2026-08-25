import type { Mission } from '../../shared/orch-types';
import { missionBlockCause } from '../../shared/mission-block-cause';
import { wasUpdatedBeforeThisProcess } from '../../shared/session-restore-liveness';
import {
  isInFlightStatus,
  missionIsOperationallyActive,
} from '../lib/mission-rail-groups';
import {
  bootstrapStepLabel,
  progressAgeLabel,
  type ChefIdleProgress,
  type PaneVacancyProgress,
} from './pane-vacancy-progress';

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
 *
 * Leftover de boot anterior NÃO narra a vacancy: o espelho legado carrega o
 * status cru do SQLite, então uma missão que morreu com o app anterior (ou há
 * dias, noutra sessão) abriria o workspace já "falando de missão" como se o
 * operador tivesse pedido algo. Reabrir é cockpit limpo — trabalho velho mora
 * na rail, não no grid. A vacancy só pertence ao que ESTA sessão tocou.
 */
export function paneVacancyMission(
  missions: readonly Mission[],
): Mission | null {
  const candidates = missions.filter(
    (mission) =>
      (isInFlightStatus(mission.status) ||
        missionIsOperationallyActive(mission, false)) &&
      !wasUpdatedBeforeThisProcess(mission.updatedAt),
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
  'A missão está montando a equipe — ainda não há nada para ver aqui.';
const PREPARING_NEXT_STEP =
  'Se em alguns instantes nada aparecer, toque em “Ver a missão”.';

/**
 * `progress` is the live bootstrap step polled from the mission journal.
 * `chefIdle` is the latest chef-idle-awaiting-workers event for the mission.
 * Both only change the headline of a NON-blocked mission and only when they
 * belong to that exact mission — a stale page from a previous poll must not
 * leak onto another mission. Without them the copy is byte-for-byte static.
 */
export function paneVacancyIntent(
  missions: readonly Mission[],
  progress: PaneVacancyProgress | null = null,
  now: number = Date.now(),
  chefIdle: ChefIdleProgress | null = null,
): PaneVacancyIntent {
  const mission = paneVacancyMission(missions);
  if (!mission) return { kind: 'idle' };
  if (mission.status !== 'blocked') {
    let headline: string;
    if (progress && progress.missionId === mission.id) {
      headline = `${bootstrapStepLabel(progress.step)} · ${progressAgeLabel(
        progress.occurredAt,
        now,
      )}`;
    } else if (chefIdle && chefIdle.missionId === mission.id) {
      const n = chefIdle.workerCount;
      headline = `Coordenador aguardando ${n} ajudante${n !== 1 ? 's' : ''} · ${progressAgeLabel(chefIdle.occurredAt, now)}`;
    } else {
      headline = PREPARING_HEADLINE;
    }
    return {
      kind: 'mission-unstaged',
      missionId: mission.id,
      missionTitle: mission.title,
      headline,
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

const UNRECORDED_HEADLINE = 'Motivo não registrado.';

/**
 * Chrome do cartão: estado da vaga, não o briefing. URL + parágrafo no
 * título era o cartaz do print 25/08.
 */
export function paneVacancyCardCopy(
  intent: Extract<PaneVacancyIntent, { readonly kind: 'mission-unstaged' }>,
): { readonly title: string; readonly lines: readonly string[] } {
  const preparing =
    /montando a equipe|Equipe definida|Coordenador aguardando/u.test(
      intent.headline,
    );
  const title = preparing ? 'Montando a equipe' : 'Missão em pausa';
  const lines: string[] = [];
  if (
    intent.headline &&
    intent.headline !== UNRECORDED_HEADLINE &&
    intent.headline !== PREPARING_HEADLINE
  ) {
    lines.push(intent.headline);
  }
  if (intent.nextStep) lines.push(intent.nextStep);
  if (lines.length === 0) {
    lines.push('Abra o quadro para ver o que aconteceu.');
  }
  return { title, lines };
}

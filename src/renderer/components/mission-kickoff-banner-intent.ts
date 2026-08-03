import type { Mission } from '../../shared/orch-types';
import { paneVacancyMission } from './pane-vacancy-intent';

/**
 * WHEN THE GLOBAL KICKOFF BANNER OWNS THE SCREEN.
 *
 * The vacancy card narrates a mission boot only when the grid is a single
 * empty vacancy. On every other screen — the operator's shell, a browser
 * pane, an old mission's panes — a 30-90s bootstrap was pure silence and read
 * as a frozen app. The banner fills exactly that gap:
 *
 *   - a mission owns the workspace's attention (in flight or blocked), AND
 *   - it has not presented a single pane yet, AND
 *   - no vacancy card is on screen already telling this story.
 *
 * Pure: no store, no React — the decision is testable on its own and the
 * component only renders it.
 */
export function missionKickoffBannerMission(
  missions: readonly Mission[],
  boundMissionIds: ReadonlySet<string>,
  vacancyOnScreen: boolean,
): Mission | null {
  if (vacancyOnScreen) return null;
  // A mission with a pane on screen is already telling its own story; only
  // the paneless ones compete for the banner (same rank as the vacancy card).
  return paneVacancyMission(
    missions.filter((mission) => !boundMissionIds.has(mission.id)),
  );
}

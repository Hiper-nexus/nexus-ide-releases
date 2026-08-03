import { useEffect, useMemo, useState } from 'react';
import { isStructuralPlaceholderPane, listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { missionKickoffBannerMission } from './mission-kickoff-banner-intent';
import { paneVacancyIntent } from './pane-vacancy-intent';
import {
  latestBootstrapProgress,
  type PaneVacancyProgress,
} from './pane-vacancy-progress';

/**
 * Global kickoff feedback. Between the mission approval and the first agent
 * pane there are 30-90s of bootstrap; on any screen without a vacancy card
 * that interval was silence and read as a frozen app. The banner appears the
 * moment a mission owns the workspace's attention with zero panes, narrates
 * the live bootstrap step from the journal ("‹etapa› · há Ns") and disappears
 * on the first pane bind — the same contract the vacancy card already keeps.
 */
export function MissionKickoffBanner() {
  const missions = useOrchStore((state) => state.missions);
  const paneMissions = useOrchStore((state) => state.paneMissions);
  const root = useLayoutStore((state) => state.root);

  const vacancyOnScreen = useMemo(
    () => listPanes(root).some(isStructuralPlaceholderPane),
    [root],
  );
  const boundMissionIds = useMemo(
    () => new Set(Object.values(paneMissions)),
    [paneMissions],
  );
  // O rank/copy vem da mesma lógica do card de vaga, mas só entre as missões
  // sem pane — a que já apresentou conta a própria história no grid.
  const unboundMissions = useMemo(
    () => missions.filter((candidate) => !boundMissionIds.has(candidate.id)),
    [missions, boundMissionIds],
  );
  const mission = useMemo(
    () => missionKickoffBannerMission(missions, boundMissionIds, vacancyOnScreen),
    [missions, boundMissionIds, vacancyOnScreen],
  );

  // Só missão em voo e ainda não bloqueada tem boot para acompanhar; a
  // bloqueada já tem veredito durável e não recebe etapa de progresso.
  const pollingMissionId =
    mission && mission.status !== 'blocked' ? mission.id : null;
  const [progress, setProgress] = useState<PaneVacancyProgress | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!pollingMissionId) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const eventsRecent = window.nexus?.orch?.missionEventsRecent;
        if (!eventsRecent) return;
        const recent = await eventsRecent({
          missionId: pollingMissionId,
          limit: 30,
        });
        if (cancelled || !recent || recent.enabled === false) return;
        setProgress(
          latestBootstrapProgress(
            (recent.events as unknown[]) ?? [],
            pollingMissionId,
          ),
        );
      } catch {
        // Jornal indisponível: o banner mantém a copy estática de sempre.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollingMissionId]);

  // "há Ns" precisa andar sozinho — congelar Date.now() foi exatamente o bug
  // do MissionRecoveryStatus. Um tick por segundo só enquanto visível.
  useEffect(() => {
    if (!mission) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [mission]);

  if (!mission) return null;
  const intent = paneVacancyIntent(unboundMissions, progress, now);
  if (intent.kind !== 'mission-unstaged' || intent.missionId !== mission.id) {
    return null;
  }
  const blocked = mission.status === 'blocked';

  return (
    <div
      className={`kickoff-banner${blocked ? ' kickoff-banner--blocked' : ''}`}
      role="status"
      aria-live="polite"
    >
      {blocked ? (
        <span className="kickoff-banner__warn" aria-hidden="true">
          !
        </span>
      ) : (
        <span className="kickoff-banner__spinner" aria-hidden="true" />
      )}
      <div className="kickoff-banner__text">
        <span className="kickoff-banner__title">{intent.missionTitle}</span>
        <span className="kickoff-banner__step">{intent.headline}</span>
      </div>
      <button
        type="button"
        className="kickoff-banner__action"
        onClick={() => useOrchStore.getState().openMissionDetail(mission.id)}
      >
        Ver missão
      </button>
    </div>
  );
}

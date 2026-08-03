import { useEffect, useMemo, useState } from 'react';
import type { PaneModel } from '../../shared/types';
import { useHomeStore } from '../state/home-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { ActionCard, EmptyState } from './ActionCard';
import { PaneInteractionSurface } from './PaneInteractionSurface';
import { PaneToolbar } from './PaneToolbar';
import {
  paneVacancyIntent,
  paneVacancyMission,
} from './pane-vacancy-intent';
import {
  latestBootstrapProgress,
  type PaneVacancyProgress,
} from './pane-vacancy-progress';

/**
 * A structural placeholder is a VACANCY — a slot the tree needs because it can
 * never be empty — not a session. It used to render as a terminal simply
 * because it is minted with `kind: 'shell'`, which dragged in scrollback
 * replay, a PTY spawn and a prompt. That is what made "an empty pane covering
 * everything" indistinguishable from work in progress: the operator saw a
 * shell, with output, apparently doing something.
 *
 * Here the vacancy looks like a vacancy and says what the workspace is actually
 * doing. Claiming it is one click away, so the operator who WANTS a terminal
 * still gets a real one — the same claim `split`, `＋Terminal`, the Home deck
 * and the voice executor already perform through the store.
 */
export function PaneVacancy({ pane }: { readonly pane: PaneModel }) {
  const isFocused = useLayoutStore((state) => state.focusedPaneId === pane.id);
  return (
    <PaneInteractionSurface
      pane={pane}
      className={`pane pane--vacancy ${isFocused ? 'pane--focused' : ''}`}
    >
      <PaneToolbar pane={pane} isFocused={isFocused} />
      <PaneVacancyBody pane={pane} />
    </PaneInteractionSurface>
  );
}

/**
 * The vacancy itself, without pane chrome — ONE implementation shared by every
 * surface that can host a pane (grid leaf and canvas node). A second copy is
 * how the placeholder ended up behaving differently depending on which view
 * you happened to be in.
 */
export function PaneVacancyBody({ pane }: { readonly pane: PaneModel }) {
  const missions = useOrchStore((state) => state.missions);
  const vacancyMission = useMemo(
    () => paneVacancyMission(missions),
    [missions],
  );
  // Só missão em voo e ainda não bloqueada tem boot para acompanhar; a
  // bloqueada já tem veredito durável e não recebe etapa de progresso.
  const pollingMissionId =
    vacancyMission && vacancyMission.status !== 'blocked'
      ? vacancyMission.id
      : null;
  const [progress, setProgress] = useState<PaneVacancyProgress | null>(null);

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
        // Jornal indisponível: o card mantém a copy estática de sempre.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollingMissionId]);

  const intent = useMemo(
    () => paneVacancyIntent(missions, progress),
    [missions, progress],
  );

  function claim(): void {
    const layout = useLayoutStore.getState();
    layout.claimStructuralPlaceholder(pane.id);
    layout.focus(pane.id);
  }

  const openTerminal = (
    <ActionCard
      icon="terminal"
      size="sm"
      variant={intent.kind === 'idle' ? 'primary' : 'ghost'}
      title="Abrir terminal aqui"
      subtitle="Esta vaga vira um terminal seu"
      onClick={(event) => {
        event.stopPropagation();
        claim();
      }}
    />
  );

  return (
    // Clicar na área vazia É reivindicá-la: substitui o mousedown que o
    // elemento do xterm registrava, e que deixa de existir sem terminal.
    <div className="pane__vacancy" onClick={claim} role="presentation">
        {intent.kind === 'idle' ? (
          <EmptyState
            icon="grid"
            title="Vaga livre no grid"
            body={
              <p>
                Nenhum agente ocupa esta área. Quando uma missão apresentar um
                agente, ele nasce aqui.
              </p>
            }
            action={
              <>
                {openTerminal}
                <ActionCard
                  icon="mission"
                  size="sm"
                  variant="ghost"
                  title="Começar uma missão"
                  subtitle="Descrever o objetivo no início"
                  onClick={(event) => {
                    event.stopPropagation();
                    useHomeStore.getState().show();
                  }}
                />
              </>
            }
          />
        ) : (
          <EmptyState
            icon="warn"
            role="alert"
            title={`"${intent.missionTitle}" ainda não abriu nenhum agente`}
            body={
              <>
                <p>{intent.headline}</p>
                <p>{intent.nextStep}</p>
              </>
            }
            action={
              <>
                <ActionCard
                  icon="mission"
                  size="sm"
                  variant="primary"
                  title="Ver a missão"
                  subtitle="Diagnóstico e próximo passo"
                  onClick={(event) => {
                    event.stopPropagation();
                    useOrchStore.getState().openMissionDetail(intent.missionId);
                  }}
                />
                {openTerminal}
              </>
            }
          />
        )}
    </div>
  );
}

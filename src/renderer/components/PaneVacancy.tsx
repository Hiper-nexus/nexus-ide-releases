import { useEffect, useMemo, useState } from 'react';
import type { PaneModel } from '../../shared/types';
import { routeMissionAttention } from '../lib/mission-attention-route';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useTerminalGridDialogStore } from '../state/terminal-grid-dialog-store';
import { CoffeeSpillCorner } from '../pet/CoffeeCup';
import { ActionCard, EmptyState } from './ActionCard';
import { PaneInteractionSurface } from './PaneInteractionSurface';
import { PaneToolbar } from './PaneToolbar';
import {
  paneVacancyCardCopy,
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
 * doing. Claiming it is one click away, so the operator who wants a terminal
 * still gets a real one through the same store-backed claim path.
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
      {/* Derrame — overlay decorativo no canto; só quando o pane tem foco.
          Montado/desmontado com o foco → animação replays a cada visita.
          position: absolute dentro de .pane (position: relative; overflow: hidden).
          pointer-events: none — nunca rouba input do terminal ou do grid. */}
      {isFocused && <CoffeeSpillCorner />}
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
  const destination = useProductNavigationStore((state) => state.destination);
  const vacancySurfaceLive =
    destination.kind === 'terminal' ||
    (destination.kind === 'mission' && destination.surface === 'terminals');
  const [progress, setProgress] = useState<PaneVacancyProgress | null>(null);

  useEffect(() => {
    if (!pollingMissionId || !vacancySurfaceLive) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    const poll = async (): Promise<void> => {
      if (document.hidden) return;
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
    const onVisibility = (): void => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pollingMissionId, vacancySurfaceLive]);

  const intent = useMemo(
    () => paneVacancyIntent(missions, progress),
    [missions, progress],
  );
  const unstagedCopy =
    intent.kind === 'mission-unstaged' ? paneVacancyCardCopy(intent) : null;

  function claim(): void {
    const layout = useLayoutStore.getState();
    layout.claimStructuralPlaceholder(pane.id);
    layout.focus(pane.id);
  }

  const openTerminal = (
    <ActionCard
      icon="terminal"
      size="sm"
      variant="primary"
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
                Nenhum agente ocupa esta área. Inicie um terminal diretamente ou monte uma grade de terminais.
              </p>
            }
            action={
              <>
                {openTerminal}
                <ActionCard
                  icon="grid"
                  size="sm"
                  variant="default"
                  title="Montar grade de terminais"
                  subtitle="Escolha a quantidade de terminais e IAs"
                  onClick={(event) => {
                    event.stopPropagation();
                    useTerminalGridDialogStore.getState().open({ initialCount: 2 });
                  }}
                />
                <ActionCard
                  icon="mission"
                  size="sm"
                  variant="ghost"
                  title="Começar uma missão"
                  subtitle="Descrever o objetivo no início"
                  onClick={(event) => {
                    event.stopPropagation();
                    useProductNavigationStore.getState().openNewMission();
                  }}
                />
              </>
            }
          />
        ) : unstagedCopy ? (
          <EmptyState
            icon={vacancyMission?.status === 'blocked' ? 'warn' : 'mission'}
            role={vacancyMission?.status === 'blocked' ? 'alert' : 'status'}
            title={unstagedCopy.title}
            body={
              <>
                {unstagedCopy.lines.map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
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
                    routeMissionAttention({
                      missionId: intent.missionId,
                      cause:
                        vacancyMission?.status === 'blocked'
                          ? 'technical-failure'
                          : 'technical-recovery',
                    });
                  }}
                />
                {openTerminal}
              </>
            }
          />
        ) : null}
    </div>
  );
}

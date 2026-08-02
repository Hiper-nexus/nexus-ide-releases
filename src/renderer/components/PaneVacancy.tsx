import { useMemo } from 'react';
import type { PaneModel } from '../../shared/types';
import { useHomeStore } from '../state/home-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { ActionCard, EmptyState } from './ActionCard';
import { PaneInteractionSurface } from './PaneInteractionSurface';
import { PaneToolbar } from './PaneToolbar';
import { paneVacancyIntent } from './pane-vacancy-intent';

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
  const missions = useOrchStore((state) => state.missions);
  const intent = useMemo(() => paneVacancyIntent(missions), [missions]);

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
    <PaneInteractionSurface
      pane={pane}
      className={`pane pane--vacancy ${isFocused ? 'pane--focused' : ''}`}
    >
      <PaneToolbar pane={pane} isFocused={isFocused} />
      {/* Clicar na área vazia É reivindicá-la: substitui o mousedown que o
          elemento do xterm registrava, e que deixa de existir sem terminal. */}
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
    </PaneInteractionSurface>
  );
}

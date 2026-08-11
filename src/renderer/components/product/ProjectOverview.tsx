import { useState, type FormEvent } from 'react';
import type { PaneSessionState } from '../../../shared/types';
import { listPanes } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { useMissionSetupStore } from '../../state/mission-setup-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useSessionStateStore } from '../../state/session-state-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { requestPaneClose } from '../../terminal/pane-close-guard';
import { PixelIcon } from '../PixelIcon';

const STATUS_LABEL: Record<PaneSessionState, string> = {
  spawning: 'Iniciando',
  busy: 'Trabalhando',
  idle: 'Idle',
  exited: 'Encerrado',
  hibernated: 'Hibernado',
};

export interface ProjectOverviewProps {
  workspaceName: string;
  workspacePath: string;
}

/**
 * Project-first flock surface (Xirp clean-room parity): header, goal box that
 * hands off to Mission Setup, and a compact session minimap.
 */
export function ProjectOverview({
  workspaceName,
  workspacePath,
}: ProjectOverviewProps) {
  const root = useLayoutStore((s) => s.root);
  const focus = useLayoutStore((s) => s.focus);
  const displayStates = useSessionStateStore((s) => s.displayStates);
  const panes = listPanes(root);
  const [goal, setGoal] = useState('');

  const submitGoal = (event: FormEvent) => {
    event.preventDefault();
    const text = goal.trim();
    if (!text) return;
    const setup = useMissionSetupStore.getState();
    setup.clearEntryContext();
    setup.setWorkspace(workspacePath);
    setup.setObjective(text);
    setup.setStep('express');
    useProductNavigationStore.getState().openMissionSetup();
  };

  return (
    <div className="project-overview" data-testid="project-overview">
      <header className="project-overview__header">
        <h1 className="project-overview__title">{workspaceName}</h1>
        <p className="project-overview__path">{workspacePath}</p>
      </header>

      <form className="project-overview__goal" onSubmit={submitGoal}>
        <label className="project-overview__goal-label" htmlFor="project-goal">
          Objetivo
        </label>
        <textarea
          id="project-goal"
          className="project-overview__goal-input"
          rows={3}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="Descreva o que o flock deve fazer…"
        />
        <button
          type="submit"
          className="project-overview__goal-submit"
          disabled={!goal.trim()}
        >
          Preparar missão
        </button>
      </form>

      <section
        className="project-overview__flock"
        aria-label="Sessões do workspace"
      >
        <h2 className="project-overview__flock-title">Sessões</h2>
        {panes.length === 0 ? (
          <p className="project-overview__empty">
            Nenhuma sessão aberta. Prepare uma missão ou abra um terminal.
          </p>
        ) : (
          <ul className="project-overview__list">
            {panes.map((pane) => {
              const state = displayStates.get(pane.id) ?? 'idle';
              return (
                <li key={pane.id} className="project-overview__item">
                  <button
                    type="button"
                    className="project-overview__session"
                    onClick={() => {
                      useProductNavigationStore.getState().openTerminal();
                      focus(pane.id);
                    }}
                  >
                    <span className="project-overview__session-icon" aria-hidden>
                      <PixelIcon
                        name={
                          state === 'busy' || state === 'spawning'
                            ? 'status-busy'
                            : state === 'exited'
                              ? 'status-exited'
                              : 'status-idle'
                        }
                        size={12}
                      />
                    </span>
                    <span className="project-overview__session-copy">
                      <span className="project-overview__session-title">
                        {pane.title || pane.adapterId || pane.id}
                      </span>
                      <span className="project-overview__session-meta">
                        {STATUS_LABEL[state]}
                        {pane.adapterId ? ` · ${pane.adapterId}` : ''}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="project-overview__close"
                    aria-label={`Fechar ${pane.title || pane.id}`}
                    onClick={() => requestPaneClose(pane.id)}
                  >
                    <PixelIcon name="close" size={11} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Connected wrapper that reads the active workspace. */
export function ProjectOverviewConnected() {
  const workspace = useWorkspaceStore((s) => s.current);
  if (!workspace) {
    return (
      <div className="project-overview project-overview--empty">
        <p>Abra um workspace para ver o overview do projeto.</p>
      </div>
    );
  }
  return (
    <ProjectOverview
      workspaceName={workspace.name}
      workspacePath={workspace.path}
    />
  );
}

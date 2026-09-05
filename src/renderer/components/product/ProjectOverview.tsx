import { useState, type FormEvent } from 'react';
import type { PaneSessionState } from '../../../shared/types';
import { isStructuralPlaceholderPane, listPanes } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { useMissionSetupStore } from '../../state/mission-setup-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useSessionStateStore } from '../../state/session-state-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useTerminalGridDialogStore } from '../../state/terminal-grid-dialog-store';
import { requestPaneClose } from '../../terminal/pane-close-guard';
import { paneSessionView } from '../../../shared/pane-session-view';
import { PixelIcon } from '../PixelIcon';
import { EmptyState } from '../ActionCard';

// O vocabulário de estado tem UMA fonte (`pane-session-view`). Este arquivo
// mantinha um terceiro mapa próprio — e nele `idle` era "Idle", em inglês,
// enquanto a fonte dizia outra coisa. Mapa local de enum é como o produto
// passa a falar dois idiomas na mesma tela.
const statusLabel = (state: PaneSessionState): string =>
  paneSessionView(state).chip;

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
  const panes = listPanes(root).filter((pane) => !isStructuralPlaceholderPane(pane));
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
    <section className="product-workspace product-page project-overview" data-testid="project-overview">
      <header className="product-workspace__header">
        <div className="product-workspace__identity">
          <span className="product-workspace__badge" aria-hidden="true"><PixelIcon name="files" size={16} /></span>
          <div className="product-workspace__heading">
            <span className="product-workspace__context">Projeto</span>
            <h1>{workspaceName}</h1>
          </div>
        </div>
        <p className="project-overview__path" title={workspacePath}>{workspacePath}</p>
      </header>

      <div className="product-workspace__content project-overview__content">
      <form className="project-overview__goal" onSubmit={submitGoal}>
        <label className="project-overview__goal-label" htmlFor="project-goal">
          Qual é a próxima entrega?
        </label>
        <p className="project-overview__hint" id="project-goal-hint">Descreva o resultado para preparar a missão.</p>
        <textarea
          id="project-goal"
          className="project-overview__goal-input"
          rows={3}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="Ex.: corrigir o fluxo de agendamento de clientes"
          aria-describedby="project-goal-hint"
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
        aria-label="Painéis do projeto"
      >
        <div className="project-overview__sessions-heading">
          <h2 className="project-overview__flock-title">Painéis abertos</h2>
          <span className="project-overview__count">{panes.length}</span>
        </div>
        {panes.length === 0 ? (
          <EmptyState
            icon="terminal"
            title="Nenhum painel aberto"
            body="Prepare uma missão ou monte seus terminais para começar."
            className="project-overview__empty"
            action={<button type="button" className="project-overview__secondary" onClick={() => useTerminalGridDialogStore.getState().open({ initialCount: 1 })}>Montar terminais</button>}
          />
        ) : (
          <ul className="project-overview__list">
            {panes.map((pane) => {
              const state = displayStates.get(pane.id) ?? 'idle';
              return (
                <li key={pane.id} className="project-overview__item" data-state={paneSessionView(state).mod}>
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
                        {statusLabel(state)}
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
    </section>
  );
}

/** Connected wrapper that reads the active workspace. */
export function ProjectOverviewConnected() {
  const workspace = useWorkspaceStore((s) => s.current);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async () => {
    setOpening(true);
    setError(null);
    try {
      await useWorkspaceStore.getState().pick();
    } catch {
      setError('Não foi possível abrir o projeto. Tente novamente.');
    } finally {
      setOpening(false);
    }
  };
  if (!workspace) {
    return (
      <section className="product-workspace product-page project-overview project-overview--empty" aria-label="Projeto">
        <h1 className="project-overview__empty-heading">Projeto</h1>
        <EmptyState icon="files" title="Abra um projeto" body="Escolha a pasta para preparar missões e acompanhar seus painéis."
          action={<button type="button" className="project-overview__goal-submit" disabled={opening} onClick={() => void pick()}>{opening ? 'Abrindo…' : 'Escolher pasta'}</button>}
        />
        {error ? <p role="alert" className="project-overview__error">{error}</p> : null}
      </section>
    );
  }
  return (
    <ProjectOverview
      workspaceName={workspace.name}
      workspacePath={workspace.path}
    />
  );
}

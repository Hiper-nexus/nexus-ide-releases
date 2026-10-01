import { paneStateView } from './access-view';

export interface AccessPane {
  id: string;
  title: string;
}

interface AccessPaneListProps {
  panes: readonly AccessPane[];
  /** Estado de sessão por pane (`idle`, `busy`…); ausente = só preservado. */
  states: ReadonlyMap<string, string>;
  onClose: (paneId: string) => void;
}

/**
 * Terminais que continuam vivos atrás da tela de acesso. Sem terminais não há
 * o que mostrar: a seção inteira some em vez de exibir uma lista vazia.
 */
export function AccessPaneList({ panes, states, onClose }: AccessPaneListProps) {
  if (panes.length === 0) return null;
  return (
    <section className="access-panes" aria-labelledby="access-panes-title">
      <header className="access-panes__head">
        <h2 id="access-panes-title">Seus terminais</h2>
        <span>{panes.length === 1 ? '1 preservado' : `${panes.length} preservados`}</span>
      </header>
      <ul className="access-panes__list">
        {panes.map((pane) => {
          const view = paneStateView(states.get(pane.id));
          return (
            <li key={pane.id} className="access-pane">
              <span className={`access-pane__dot access-pane__dot--${view.tone}`} aria-hidden="true" />
              <span className="access-pane__title" title={pane.title}>{pane.title}</span>
              <span className="access-pane__state">{view.label}</span>
              <button
                type="button"
                className="access-btn access-btn--quiet access-btn--small"
                aria-label={`Fechar ${pane.title}`}
                onClick={() => onClose(pane.id)}
              >
                Fechar
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

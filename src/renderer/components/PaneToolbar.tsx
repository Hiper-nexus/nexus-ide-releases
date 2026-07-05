import { useState } from 'react';
import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { respawnWithResume, scrollPaneToBottom } from '../terminal/terminal-host';
import { CostBadge } from './CostBadge';

interface Props {
  pane: PaneModel;
  isFocused: boolean;
  /** When true, hides grid-specific split buttons (canvas panes float freely). */
  isCanvas?: boolean;
}

function StateIndicator({ paneId }: { paneId: string }) {
  const state = useSessionStateStore((s) => s.paneStates.get(paneId));
  if (!state) return null;

  const view =
    state === 'idle'
      ? { dot: '●', mod: 'idle', label: 'pronto' }
      : state === 'busy'
        ? { dot: '◌', mod: 'busy', label: 'trabalhando' }
        : state === 'exited'
          ? { dot: '✕', mod: 'exited', label: 'encerrado — use ↻ para reabrir' }
          : { dot: '○', mod: 'spawning', label: 'iniciando' };

  return (
    <span
      className={`toolbar__state toolbar__state--${view.mod}`}
      title={`agente: ${view.label}`}
      aria-label={`estado do agente: ${view.label}`}
    >
      {view.dot}
    </span>
  );
}

/**
 * Per-pane header: focus indicator, title, session-kind badge, agent state
 * indicator for cli-agent panes, and the split/close controls.
 */
export function PaneToolbar({ pane, isFocused, isCanvas }: Props) {
  const split = useLayoutStore((s) => s.split);
  const close = useLayoutStore((s) => s.close);
  const renameTitle = useLayoutStore((s) => s.renameTitle);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pane.title);

  const adapterLabel = pane.adapterId
    ? `${pane.adapterId}${pane.model ? ` · ${pane.model}` : ''}`
    : null;

  function commit() {
    const clean = draft.trim();
    if (clean && clean !== pane.title) renameTitle(pane.id, clean);
    setEditing(false);
  }

  return (
    <div className="toolbar" data-focused={isFocused}>
      <span className={`toolbar__dot ${isFocused ? 'toolbar__dot--on' : ''}`} />
      {editing ? (
        <input
          className="toolbar__rename nodrag"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="toolbar__title"
          title={`${pane.title} — duplo-clique para renomear`}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(pane.title);
            setEditing(true);
          }}
        >
          {pane.title}
        </span>
      )}
      {pane.role === 'orchestrator' && (
        <span
          className="toolbar__badge toolbar__badge--orch"
          title="Orquestrador da missão — coordena e delega para os workers"
        >
          ⬢ orq
        </span>
      )}
      {pane.role === 'worker' && pane.agentName && (
        <span
          className="toolbar__badge toolbar__badge--worker"
          title={`Worker do squad: ${pane.agentName}`}
        >
          ⬡ {pane.agentName}
        </span>
      )}
      {adapterLabel ? (
        <span
          className="toolbar__badge toolbar__badge--agent"
          title={`CLI/modelo operando este pane: ${adapterLabel}`}
        >
          {adapterLabel}
        </span>
      ) : (
        <span className="toolbar__badge">{pane.kind}</span>
      )}
      {pane.kind === 'cli-agent' && <StateIndicator paneId={pane.id} />}
      {pane.kind === 'cli-agent' && <CostBadge paneId={pane.id} />}
      <div className="toolbar__spacer" />
      <button
        className="toolbar__btn nodrag"
        title="Descer até a última mensagem"
        aria-label="Descer até a última mensagem"
        onClick={(e) => {
          e.stopPropagation();
          scrollPaneToBottom(pane.id, pane.kind === 'cli-agent');
        }}
      >
        ⤓
      </button>
      {pane.kind === 'cli-agent' && (
        <button
          className="toolbar__btn nodrag"
          title="Reiniciar a CLI e retomar a conversa anterior (--resume). NÃO é scroll — encerra o processo atual."
          aria-label="Reiniciar a CLI e retomar conversa anterior"
          onClick={(e) => {
            e.stopPropagation();
            const state = useSessionStateStore.getState().paneStates.get(pane.id);
            if (
              state === 'busy' &&
              !window.confirm(
                'O agente está trabalhando agora. Reiniciar a CLI interrompe a tarefa em andamento. Continuar?',
              )
            ) {
              return;
            }
            respawnWithResume(pane, '[nexus] retomando a sessão anterior…');
          }}
        >
          ↻
        </button>
      )}
      {!isCanvas && (
        <>
          <button
            className="toolbar__btn nodrag"
            title="Split right (⌘D)"
            aria-label="Dividir à direita"
            onClick={(e) => {
              e.stopPropagation();
              split(pane.id, 'row');
            }}
          >
            ▯▮
          </button>
          <button
            className="toolbar__btn nodrag"
            title="Split down (⌘⇧D)"
            aria-label="Dividir para baixo"
            onClick={(e) => {
              e.stopPropagation();
              split(pane.id, 'column');
            }}
          >
            ▭▬
          </button>
        </>
      )}
      <button
        className="toolbar__btn toolbar__btn--close nodrag"
        title="Close pane (⌘W)"
        aria-label="Fechar pane"
        onClick={(e) => {
          e.stopPropagation();
          close(pane.id);
        }}
      >
        ✕
      </button>
    </div>
  );
}

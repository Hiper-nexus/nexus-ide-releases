import { useState } from 'react';
import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { respawnWithResume } from '../terminal/terminal-host';
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

  const dot =
    state === 'idle' ? '●' : state === 'busy' ? '◌' : '○';
  const color =
    state === 'idle' ? '#4caf50' : state === 'busy' ? '#ff9800' : '#9e9e9e';
  const label =
    state === 'idle' ? 'idle' : state === 'busy' ? 'busy' : 'spawning';

  return (
    <span
      className="toolbar__state"
      style={{ color }}
      title={`agent state: ${label}`}
    >
      {dot}
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
          className="toolbar__rename"
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
      {pane.kind === 'cli-agent' && (
        <button
          className="toolbar__btn"
          title="Retomar a conversa anterior (re-inicia a CLI com --resume, útil após reiniciar o app)"
          onMouseDown={(e) => {
            e.stopPropagation();
            respawnWithResume(pane, '[nexus] retomando a sessão anterior…');
          }}
        >
          ↻
        </button>
      )}
      {!isCanvas && (
        <>
          <button
            className="toolbar__btn"
            title="Split right (⌘D)"
            onMouseDown={(e) => {
              e.stopPropagation();
              split(pane.id, 'row');
            }}
          >
            ▯▮
          </button>
          <button
            className="toolbar__btn"
            title="Split down (⌘⇧D)"
            onMouseDown={(e) => {
              e.stopPropagation();
              split(pane.id, 'column');
            }}
          >
            ▭▬
          </button>
        </>
      )}
      <button
        className="toolbar__btn toolbar__btn--close"
        title="Close pane (⌘W)"
        onMouseDown={(e) => {
          e.stopPropagation();
          close(pane.id);
        }}
      >
        ✕
      </button>
    </div>
  );
}

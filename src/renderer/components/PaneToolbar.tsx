import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';

interface Props {
  pane: PaneModel;
  isFocused: boolean;
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
export function PaneToolbar({ pane, isFocused }: Props) {
  const split = useLayoutStore((s) => s.split);
  const close = useLayoutStore((s) => s.close);

  const adapterLabel = pane.adapterId
    ? `${pane.adapterId}${pane.model ? ` · ${pane.model}` : ''}`
    : null;

  return (
    <div className="toolbar" data-focused={isFocused}>
      <span className={`toolbar__dot ${isFocused ? 'toolbar__dot--on' : ''}`} />
      <span className="toolbar__title" title={pane.title}>
        {pane.title}
      </span>
      {adapterLabel ? (
        <span className="toolbar__badge toolbar__badge--agent" title={adapterLabel}>
          {adapterLabel}
        </span>
      ) : (
        <span className="toolbar__badge">{pane.kind}</span>
      )}
      {pane.kind === 'cli-agent' && <StateIndicator paneId={pane.id} />}
      <div className="toolbar__spacer" />
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

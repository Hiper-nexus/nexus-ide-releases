import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';

interface Props {
  pane: PaneModel;
  isFocused: boolean;
}

/**
 * Per-pane header: focus indicator, title, session-kind badge, and the
 * split/close controls. Buttons stop propagation so they don't also focus the
 * terminal underneath.
 */
export function PaneToolbar({ pane, isFocused }: Props) {
  const split = useLayoutStore((s) => s.split);
  const close = useLayoutStore((s) => s.close);

  return (
    <div className="toolbar" data-focused={isFocused}>
      <span className={`toolbar__dot ${isFocused ? 'toolbar__dot--on' : ''}`} />
      <span className="toolbar__title" title={pane.title}>
        {pane.title}
      </span>
      <span className="toolbar__badge">{pane.kind}</span>
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

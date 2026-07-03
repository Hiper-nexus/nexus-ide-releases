import { useLayoutStore } from '../state/layout-store';
import { listPanes } from '../lib/split-tree';

/** Slim top chrome: brand, live pane count, and split shortcuts hint. */
export function WorkspaceBar() {
  const root = useLayoutStore((s) => s.root);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const split = useLayoutStore((s) => s.split);
  const paneCount = listPanes(root).length;

  const onSplit = (direction: 'row' | 'column') => {
    if (focusedPaneId) split(focusedPaneId, direction);
  };

  return (
    <header className="workspace-bar">
      <div className="workspace-bar__brand">
        <span className="workspace-bar__logo">◈</span>
        <span className="workspace-bar__name">NexusIDE</span>
        <span className="workspace-bar__tag">terminal grid</span>
      </div>
      <div className="workspace-bar__actions">
        <span className="workspace-bar__count">
          {paneCount} pane{paneCount === 1 ? '' : 's'}
        </span>
        <button className="workspace-bar__btn" onClick={() => onSplit('row')}>
          Split →
        </button>
        <button className="workspace-bar__btn" onClick={() => onSplit('column')}>
          Split ↓
        </button>
      </div>
    </header>
  );
}

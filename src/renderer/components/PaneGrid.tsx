import { useEffect } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { LayoutNode } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { listPanes } from '../lib/split-tree';
import { reconcileHosts } from '../terminal/terminal-host';
import { reconcileBrowserPanes } from '../browser/browser-host';
import { PaneLeaf } from './PaneLeaf';

/**
 * Renders the binary layout tree with react-resizable-panels (MIT). Each split
 * node is a two-panel Group with a draggable Separator; leaves render a
 * PaneLeaf. Every group always holds exactly two panels, so the library never
 * sees a changing panel count — reshapes stay warning-free.
 */
function renderNode(node: LayoutNode): React.ReactNode {
  if (node.kind === 'leaf') {
    return <PaneLeaf pane={node.pane} />;
  }

  const orientation = node.direction === 'row' ? 'horizontal' : 'vertical';
  const [a, b] = node.children;

  return (
    <Group orientation={orientation} className="panel-group">
      <Panel className="panel" minSize="12%" defaultSize="50%">
        {renderNode(a)}
      </Panel>
      <Separator className={`resize-handle resize-handle--${orientation}`} />
      <Panel className="panel" minSize="12%" defaultSize="50%">
        {renderNode(b)}
      </Panel>
    </Group>
  );
}

export function PaneGrid() {
  const root = useLayoutStore((s) => s.root);

  // Dispose terminals for panes that have left the tree (after close).
  useEffect(() => {
    const liveIds = new Set(listPanes(root).map((p) => p.id));
    reconcileHosts(liveIds);
    reconcileBrowserPanes(liveIds);
  }, [root]);

  return <div className="grid">{renderNode(root)}</div>;
}

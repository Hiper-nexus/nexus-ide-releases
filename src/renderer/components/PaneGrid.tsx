import { useEffect, useMemo } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { LayoutNode } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { listPanes } from '../lib/split-tree';
import { reconcileHosts } from '../terminal/terminal-host';
import { reconcileBrowserPanes } from '../browser/browser-host';
import { PaneLeaf } from './PaneLeaf';
import { PanePicker } from './PanePicker';

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

  // minSize baixo: com 6–12 panes a grelha binária ainda encolhe sem
  // "engolir" um leaf (12% tornava 3+ splits na mesma dimensão ilegíveis).
  return (
    <Group orientation={orientation} className="panel-group">
      <Panel className="panel" minSize="6%" defaultSize="50%">
        {renderNode(a)}
      </Panel>
      <Separator className={`resize-handle resize-handle--${orientation}`} />
      <Panel className="panel" minSize="6%" defaultSize="50%">
        {renderNode(b)}
      </Panel>
    </Group>
  );
}

export function PaneGrid() {
  const root = useLayoutStore((s) => s.root);
  const maximizedPaneId = useLayoutStore((s) => s.maximizedPaneId);
  const maximizedPane = useMemo(
    () =>
      maximizedPaneId
        ? listPanes(root).find((pane) => pane.id === maximizedPaneId) ?? null
        : null,
    [root, maximizedPaneId],
  );

  // Dispose terminals for panes that have left the tree (after close).
  useEffect(() => {
    const liveIds = new Set(listPanes(root).map((p) => p.id));
    reconcileHosts(liveIds);
    reconcileBrowserPanes(liveIds);
  }, [root]);

  return (
    <div className={`grid${maximizedPane ? ' grid--pane-maximized' : ''}`}>
      {maximizedPane ? <PaneLeaf pane={maximizedPane} /> : renderNode(root)}
      {/* Controle flutuante da grelha: abrir um pane novo sem sair do trabalho. */}
      <PanePicker />
    </div>
  );
}

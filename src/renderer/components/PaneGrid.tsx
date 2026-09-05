import { useEffect, useMemo } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { LayoutNode } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { buildGridTree, listPanes } from '../lib/split-tree';
import { reconcileHosts } from '../terminal/terminal-host';
import { reconcileBrowserPanes } from '../browser/browser-host';
import { minimumPaneGridSize } from '../lib/pane-grid-size';
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

  const axis = node.direction === 'row' ? 'width' : 'height';
  return (
    <Group orientation={orientation} className="panel-group">
      <Panel className="panel" minSize={`${minimumPaneGridSize(a)[axis]}px`} defaultSize="50%">
        {renderNode(a)}
      </Panel>
      <Separator className={`resize-handle resize-handle--${orientation}`} />
      <Panel className="panel" minSize={`${minimumPaneGridSize(b)[axis]}px`} defaultSize="50%">
        {renderNode(b)}
      </Panel>
    </Group>
  );
}

export function PaneGrid({
  visiblePaneIds,
  onPaneCreated,
}: {
  readonly visiblePaneIds?: ReadonlySet<string>;
  /** Repassado ao picker: o id do pane que o operador acabou de criar. */
  readonly onPaneCreated?: (paneId: string) => void;
} = {}) {
  const root = useLayoutStore((s) => s.root);
  const maximizedPaneId = useLayoutStore((s) => s.maximizedPaneId);
  const displayRoot = useMemo(() => {
    if (!visiblePaneIds) return root;
    const visible = listPanes(root).filter((pane) => visiblePaneIds.has(pane.id));
    return visible.length === 0 ? null : buildGridTree(visible);
  }, [root, visiblePaneIds]);
  const maximizedPane = useMemo(() => {
    if (!maximizedPaneId || !displayRoot) return null;
    return (
      listPanes(displayRoot).find((pane) => pane.id === maximizedPaneId) ?? null
    );
  }, [displayRoot, maximizedPaneId]);

  // Dispose only when the pane left the CANONICAL tree — never because the
  // vista da missão escondeu o mosaico das outras.
  useEffect(() => {
    const liveIds = new Set(listPanes(root).map((p) => p.id));
    reconcileHosts(liveIds);
    reconcileBrowserPanes(liveIds);
  }, [root]);

  if (!displayRoot) {
    return (
      <div
        className="grid grid--mission-empty"
        aria-label="Nenhum terminal desta missão"
      />
    );
  }

  return (
    <div className={`grid${maximizedPane ? ' grid--pane-maximized' : ''}`}>
      {maximizedPane ? <PaneLeaf pane={maximizedPane} /> : (
        <div className="grid__scroll">
          <div className="grid__sized" style={{ minWidth: minimumPaneGridSize(displayRoot).width, minHeight: minimumPaneGridSize(displayRoot).height }}>
            {renderNode(displayRoot)}
          </div>
        </div>
      )}
      {/* Controle flutuante da grelha: abrir um pane novo sem sair do trabalho. */}
      <PanePicker onPaneCreated={onPaneCreated} />
    </div>
  );
}

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  type NodeChange,
  type Node,
  type NodeTypes,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useLayoutStore } from '../state/layout-store';
import { listPanes } from '../lib/split-tree';
import { defaultCanvasLayout } from '../lib/canvas-layout';
import { reconcileHosts } from '../terminal/terminal-host';
import {
  CanvasPaneNode,
  type CanvasPaneNodeData,
} from './CanvasPaneNode';
import type { CanvasNodeLayout, PaneModel } from '../../shared/types';

const NODE_TYPES: NodeTypes = { canvasPane: CanvasPaneNode };

function buildNode(
  pane: PaneModel,
  layout: CanvasNodeLayout,
  focusedPaneId: string | null,
): Node<CanvasPaneNodeData> {
  return {
    id: pane.id,
    type: 'canvasPane',
    position: layout.position,
    width: layout.size.width,
    height: layout.size.height,
    zIndex: pane.id === focusedPaneId ? 1000 : layout.z,
    data: { pane },
    // Prevent xyflow from auto-measuring (we control dimensions explicitly).
    measured: { width: layout.size.width, height: layout.size.height },
    style: { width: layout.size.width, height: layout.size.height },
  };
}

function buildNodes(
  panes: PaneModel[],
  layouts: Record<string, CanvasNodeLayout>,
  focusedPaneId: string | null,
): Node<CanvasPaneNodeData>[] {
  return panes.map((pane, i) => {
    const layout = layouts[pane.id] ?? defaultCanvasLayout(i);
    return buildNode(pane, layout, focusedPaneId);
  });
}

/**
 * Infinite draggable canvas view — the NexusIDE differentiator over Overclock.
 *
 * Hosts every pane as a freely positionable, resizable xyflow node.  The
 * terminal inside each node is the *same* xterm+PTY instance as the grid view,
 * re-parented via terminal-host.attachHost — zero shell restarts on toggle.
 */
export function CanvasView() {
  const root = useLayoutStore((s) => s.root);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const canvasNodeLayouts = useLayoutStore((s) => s.canvasNodeLayouts);
  const canvasViewport = useLayoutStore((s) => s.canvasViewport);
  const updateCanvasNodeLayout = useLayoutStore((s) => s.updateCanvasNodeLayout);
  const setCanvasViewport = useLayoutStore((s) => s.setCanvasViewport);

  const panes = useMemo(() => listPanes(root), [root]);
  const paneIdsKey = panes.map((p) => p.id).join(',');

  const layoutsRef = useRef(canvasNodeLayouts);
  layoutsRef.current = canvasNodeLayouts;
  const focusedRef = useRef(focusedPaneId);
  focusedRef.current = focusedPaneId;

  const [nodes, setNodes] = useState<Node<CanvasPaneNodeData>[]>(() =>
    buildNodes(panes, canvasNodeLayouts, focusedPaneId),
  );

  // Sync when pane set changes (panes added or removed).
  useEffect(() => {
    const currentPanes = listPanes(root);
    setNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]));
      return currentPanes.map((pane, i) => {
        if (prevMap.has(pane.id)) {
          // Keep xyflow's current position/size but refresh pane data.
          const existing = prevMap.get(pane.id)!;
          return { ...existing, data: { pane } };
        }
        const layout = layoutsRef.current[pane.id] ?? defaultCanvasLayout(i);
        return buildNode(pane, layout, focusedRef.current);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneIdsKey]);

  // Update z-index when focused node changes.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => ({
        ...n,
        zIndex: n.id === focusedPaneId ? 1000 : (canvasNodeLayouts[n.id]?.z ?? 0),
      })),
    );
  }, [focusedPaneId, canvasNodeLayouts]);

  // Reconcile terminal hosts when pane set changes.
  useEffect(() => {
    const liveIds = new Set(panes.map((p) => p.id));
    reconcileHosts(liveIds);
  }, [panes]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<CanvasPaneNodeData>>[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));

      // Persist dimension changes at resize end.
      for (const change of changes) {
        if (change.type === 'dimensions' && change.dimensions && !change.resizing) {
          updateCanvasNodeLayout(change.id, { size: change.dimensions });
        }
      }
    },
    [updateCanvasNodeLayout],
  );

  const onNodeDragStop = useCallback(
    (_: MouseEvent | TouchEvent, node: Node) => {
      updateCanvasNodeLayout(node.id, { position: node.position });
    },
    [updateCanvasNodeLayout],
  );

  const onViewportChange = useCallback(
    (vp: Viewport) => {
      setCanvasViewport(vp);
    },
    [setCanvasViewport],
  );

  return (
    <div className="canvas-container">
      <ReactFlow
        nodes={nodes}
        edges={[]}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={NODE_TYPES}
        defaultViewport={canvasViewport}
        onViewportChange={onViewportChange}
        onlyRenderVisibleElements
        fitView={false}
        minZoom={0.1}
        maxZoom={2}
        panOnScroll
        selectionOnDrag={false}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
      >
        <Background gap={20} size={1} color="var(--border)" />
        <MiniMap
          nodeColor="var(--bg-elevated)"
          maskColor="rgba(11,14,20,0.7)"
          style={{ background: 'var(--bg-bar)', border: '1px solid var(--border)' }}
        />
        <Controls
          style={{ background: 'var(--bg-bar)', border: '1px solid var(--border)' }}
          showInteractive={false}
        />
      </ReactFlow>
    </div>
  );
}

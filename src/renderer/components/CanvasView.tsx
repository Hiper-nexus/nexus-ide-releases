import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  type NodeChange,
  type Node,
  type Edge,
  type Connection,
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
import { StickyNoteNode } from './StickyNoteNode';
import { AddNoteButton } from './AddNoteButton';
import {
  buildNoteNodes,
  isNoteNodeId,
  onNoteDragStop as persistNoteDrag,
} from '../lib/note-nodes';
import { useNotesStore, useNotesController } from '../state/notes-store';
import { usePipeStore, usePipeController } from '../state/pipe-store';
import type { CanvasNodeLayout, PaneModel } from '../../shared/types';

const NODE_TYPES: NodeTypes = {
  canvasPane: CanvasPaneNode,
  stickyNote: StickyNoteNode,
};

/** Default mode for a freshly drawn edge: send the last response when the
 * source agent goes idle (clean hand-off, no raw-TUI spam between panes). */
const DEFAULT_PIPE_MODE = 'onIdle' as const;

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
 *
 * Two extra layers ride on the same canvas:
 *  - sticky notes (namespaced `note:<id>` nodes), and
 *  - "edges que conversam": dragging a connection between two panes pipes the
 *    source pane's output into the target pane's input (see pane-pipe.ts).
 */
export function CanvasView() {
  const root = useLayoutStore((s) => s.root);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const canvasNodeLayouts = useLayoutStore((s) => s.canvasNodeLayouts);
  const canvasViewport = useLayoutStore((s) => s.canvasViewport);
  const updateCanvasNodeLayout = useLayoutStore((s) => s.updateCanvasNodeLayout);
  const setCanvasViewport = useLayoutStore((s) => s.setCanvasViewport);

  // Sticky notes + pipes (each hydrates once and live-updates from main).
  useNotesController();
  usePipeController();
  const notes = useNotesStore((s) => s.notes);
  const pipes = usePipeStore((s) => s.pipes);
  const addPipe = usePipeStore((s) => s.add);
  const removePipe = usePipeStore((s) => s.remove);

  const panes = useMemo(() => listPanes(root), [root]);
  const paneIdsKey = panes.map((p) => p.id).join(',');

  const layoutsRef = useRef(canvasNodeLayouts);
  layoutsRef.current = canvasNodeLayouts;
  const focusedRef = useRef(focusedPaneId);
  focusedRef.current = focusedPaneId;

  const [nodes, setNodes] = useState<Node[]>(() =>
    buildNodes(panes, canvasNodeLayouts, focusedPaneId),
  );

  // Sync when pane set changes (panes added or removed). Note nodes live in the
  // same array and must be preserved across a pane-set rebuild.
  useEffect(() => {
    const currentPanes = listPanes(root);
    setNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]));
      const paneNodes = currentPanes.map((pane, i) => {
        if (prevMap.has(pane.id)) {
          const existing = prevMap.get(pane.id)!;
          return { ...existing, data: { pane } };
        }
        const layout = layoutsRef.current[pane.id] ?? defaultCanvasLayout(i);
        return buildNode(pane, layout, focusedRef.current);
      });
      return [...paneNodes, ...prev.filter((n) => isNoteNodeId(n.id))];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneIdsKey]);

  // Sync note nodes into the same state array (controlled mode: notes must be
  // in `nodes` for applyNodeChanges to animate their drag).
  useEffect(() => {
    setNodes((prev) => [
      ...prev.filter((n) => !isNoteNodeId(n.id)),
      ...buildNoteNodes(notes),
    ]);
  }, [notes]);

  // Update z-index when focused node changes (notes keep their own z).
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) =>
        isNoteNodeId(n.id)
          ? n
          : {
              ...n,
              zIndex:
                n.id === focusedPaneId ? 1000 : (canvasNodeLayouts[n.id]?.z ?? 0),
            },
      ),
    );
  }, [focusedPaneId, canvasNodeLayouts]);

  // Reconcile terminal hosts when pane set changes.
  useEffect(() => {
    const liveIds = new Set(panes.map((p) => p.id));
    reconcileHosts(liveIds);
  }, [panes]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));

      // Persist pane dimension changes at resize end (notes persist their own).
      for (const change of changes) {
        if (
          change.type === 'dimensions' &&
          change.dimensions &&
          !change.resizing &&
          !isNoteNodeId(change.id)
        ) {
          updateCanvasNodeLayout(change.id, { size: change.dimensions });
        }
      }
    },
    [updateCanvasNodeLayout],
  );

  const onNodeDragStop = useCallback(
    (_: MouseEvent | TouchEvent, node: Node) => {
      if (isNoteNodeId(node.id)) {
        persistNoteDrag(node.id, node.position.x, node.position.y);
        return;
      }
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

  // "Edges que conversam": one edge per pipe; drawing one pipes source→target.
  const edges: Edge[] = useMemo(
    () =>
      pipes.map((p) => ({
        id: p.id,
        source: p.sourcePaneId,
        target: p.targetPaneId,
        animated: p.mode === 'stream',
        label: p.mode === 'stream' ? 'stream' : 'ao ficar idle',
        style: { stroke: 'var(--accent)', strokeWidth: 2 },
        labelStyle: { fill: 'var(--text-dim)', fontSize: 10 },
      })),
    [pipes],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (conn.source && conn.target && conn.source !== conn.target) {
        void addPipe(conn.source, conn.target, DEFAULT_PIPE_MODE);
      }
    },
    [addPipe],
  );

  // Double-click an edge to remove the pipe (single click is too easy to hit).
  const onEdgeDoubleClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      void removePipe(edge.id);
    },
    [removePipe],
  );

  return (
    <div className="canvas-container">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onEdgeDoubleClick={onEdgeDoubleClick}
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
        nodesConnectable
        elementsSelectable={false}
        deleteKeyCode={null}
      >
        <Background gap={20} size={1} color="var(--border)" />
        <AddNoteButton />
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

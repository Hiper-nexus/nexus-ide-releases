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
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useLayoutStore } from '../state/layout-store';
import { listPanes } from '../lib/split-tree';
import { defaultCanvasLayout } from '../lib/canvas-layout';
import { reconcileHosts } from '../terminal/terminal-host';
import {
  reconcileBrowserPanes,
  scheduleBrowserPaneBoundsSync,
} from '../browser/browser-host';
import {
  CanvasPaneNode,
  type CanvasPaneNodeData,
} from './CanvasPaneNode';
import { ensureReadableCanvasSize } from './canvas-pane-layout';
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
import {
  PIPE_ACTIVITY_MOTION_MS,
  isPipeRecentlyActive,
} from './pipe-motion';
import { useSessionStateStore } from '../state/session-state-store';
import { useOrchStore } from '../state/orch-store';
import { PixelIcon } from './PixelIcon';

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
  const readableSize = ensureReadableCanvasSize(layout.size);
  return {
    id: pane.id,
    type: 'canvasPane',
    position: layout.position,
    width: readableSize.width,
    height: readableSize.height,
    zIndex: pane.id === focusedPaneId ? 1000 : layout.z,
    dragHandle: '.toolbar, .canvas-pane__snapshot',
    data: { pane },
    // Prevent xyflow from auto-measuring (we control dimensions explicitly).
    measured: { width: readableSize.width, height: readableSize.height },
    style: { width: readableSize.width, height: readableSize.height },
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

interface CanvasCommandBarProps {
  paneCount: number;
  busyCount: number;
  startingCount: number;
  unavailableCount: number;
  activeMissionCount: number;
  pipeCount: number;
  onCenter(): void;
  onAddTerminal(): void;
}

function shouldIgnoreCanvasShortcut(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, button, [contenteditable="true"], .term-host, .browser-pane',
    ) !== null
  );
}

function CanvasCommandBar({
  paneCount,
  busyCount,
  startingCount,
  unavailableCount,
  activeMissionCount,
  pipeCount,
  onCenter,
  onAddTerminal,
}: CanvasCommandBarProps) {
  const activity =
    busyCount > 0
      ? `${busyCount} trabalhando`
      : unavailableCount > 0
        ? `${unavailableCount} requer atenção`
        : startingCount > 0
          ? `${startingCount} iniciando`
          : 'todos prontos';

  return (
    <div className="canvas-command" aria-label="Estado e ações do canvas">
      <div className="canvas-command__state" aria-live="polite">
        <span
          className={`canvas-command__signal ${busyCount > 0 ? 'canvas-command__signal--live' : ''}`}
          aria-hidden="true"
        />
        <strong>{activity}</strong>
        <span>
          {paneCount} pane{paneCount === 1 ? '' : 's'}
        </span>
        {activeMissionCount > 0 && (
          <span>
            {activeMissionCount} miss{activeMissionCount === 1 ? 'ão ativa' : 'ões ativas'}
          </span>
        )}
        {unavailableCount > 0 && busyCount > 0 && (
          <span className="canvas-command__attention">
            {unavailableCount} requer atenção
          </span>
        )}
        {pipeCount > 0 && (
          <span>
            {pipeCount} conex{pipeCount === 1 ? 'ão' : 'ões'}
          </span>
        )}
      </div>
      <div className="canvas-command__actions">
        <button type="button" onClick={onCenter} title="Centralizar todos os panes (F)">
          <PixelIcon name="canvas" size={10} />
          Centralizar <kbd>F</kbd>
        </button>
        <button type="button" onClick={onAddTerminal}>
          <PixelIcon name="terminal" size={10} />
          Terminal
        </button>
      </div>
    </div>
  );
}

/**
 * Infinite draggable canvas view.
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
  const addShellPane = useLayoutStore((s) => s.addShellPane);
  const paneStates = useSessionStateStore((s) => s.paneStates);
  const paneMissions = useOrchStore((s) => s.paneMissions);

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
  const flowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const [pipeMotionNow, setPipeMotionNow] = useState(() => Date.now());

  // Memoize derived counts to avoid O(n) iteration on every render.
  const busyCount = useMemo(
    () => panes.filter((pane) => paneStates.get(pane.id) === 'busy').length,
    [panes, paneStates],
  );
  const startingCount = useMemo(
    () =>
      panes.filter((pane) => {
        if (pane.kind === 'browser') return false;
        const state = paneStates.get(pane.id);
        return state === undefined || state === 'spawning';
      }).length,
    [panes, paneStates],
  );
  const unavailableCount = useMemo(
    () =>
      panes.filter((pane) => {
        const state = paneStates.get(pane.id);
        return state === 'exited' || state === 'hibernated';
      }).length,
    [panes, paneStates],
  );
  const activeMissionCount = useMemo(
    () => new Set(Object.values(paneMissions)).size,
    [paneMissions],
  );

  const centerPanes = useCallback(() => {
    const reduceMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    void flowRef.current?.fitView({
      padding: 0.12,
      duration: reduceMotion ? 0 : 180,
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.toLowerCase() !== 'f' ||
        shouldIgnoreCanvasShortcut(event.target)
      ) {
        return;
      }
      event.preventDefault();
      centerPanes();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [centerPanes]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settleExpiredMotion = () => {
      const now = Date.now();
      setPipeMotionNow(now);
      const remaining = pipes
        .map((pipe) =>
          pipe.lastDeliveredAt === undefined
            ? 0
            : pipe.lastDeliveredAt + PIPE_ACTIVITY_MOTION_MS - now + 1,
        )
        .filter((delay) => delay > 0);
      if (remaining.length > 0) {
        timer = setTimeout(settleExpiredMotion, Math.min(...remaining));
      }
    };
    settleExpiredMotion();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [pipes]);

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
    reconcileBrowserPanes(liveIds);
  }, [panes]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      scheduleBrowserPaneBoundsSync();

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
      scheduleBrowserPaneBoundsSync();
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
      scheduleBrowserPaneBoundsSync();
    },
    [setCanvasViewport],
  );

  // "Edges que conversam": one edge per pipe; drawing one pipes source→target.
  const edges: Edge[] = useMemo(
    () =>
      pipes.map((p) => {
        const count = p.deliveryCount ?? 0;
        const badge = count > 0 ? ` (${count})` : '';
        return {
          id: p.id,
          source: p.sourcePaneId,
          target: p.targetPaneId,
          animated: isPipeRecentlyActive(p.lastDeliveredAt, pipeMotionNow),
          label: (p.mode === 'stream' ? 'stream' : 'ao ficar idle') + badge,
          style: { stroke: 'var(--accent)', strokeWidth: 2 },
          labelStyle: { fill: 'var(--text-dim)', fontSize: 10 },
        };
      }),
    [pipes, pipeMotionNow],
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
      <CanvasCommandBar
        paneCount={panes.length}
        busyCount={busyCount}
        startingCount={startingCount}
        unavailableCount={unavailableCount}
        activeMissionCount={activeMissionCount}
        pipeCount={pipes.length}
        onCenter={centerPanes}
        onAddTerminal={addShellPane}
      />
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
        onInit={(instance) => {
          flowRef.current = instance;
        }}
      >
        <Background gap={28} size={1} color="var(--border-strong)" />
        <AddNoteButton />
        <MiniMap
          nodeColor="rgba(110, 168, 254, 0.45)"
          nodeStrokeColor="var(--accent)"
          nodeStrokeWidth={2}
          maskColor="rgba(11, 14, 20, 0.55)"
          pannable
          zoomable
          style={{ background: 'var(--bg-bar)', border: '1px solid var(--border-strong)' }}
        />
        <Controls
          style={{ background: 'var(--bg-bar)', border: '1px solid var(--border)' }}
          showInteractive={false}
        />
      </ReactFlow>
    </div>
  );
}

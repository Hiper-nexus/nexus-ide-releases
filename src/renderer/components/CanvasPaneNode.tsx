import { memo, useEffect, useRef } from 'react';
import {
  NodeResizer,
  Handle,
  Position,
  useViewport,
  type NodeProps,
  type Node,
} from '@xyflow/react';
import { attachHost, focusHost } from '../terminal/terminal-host';
import { PaneToolbar } from './PaneToolbar';
import { BrowserPane } from './BrowserPane';
import { useLayoutStore } from '../state/layout-store';
import type { PaneModel } from '../../shared/types';

/**
 * When the user zooms the canvas out below this threshold the live xterm is
 * hidden behind a lightweight placeholder — keeping GPU load low when many
 * terminals are in view at once.  Above the threshold the real terminal is
 * shown and interactable.
 */
const SNAPSHOT_THRESHOLD = 0.45;

export type CanvasPaneNodeData = {
  pane: PaneModel;
};

export type CanvasPaneNodeType = Node<CanvasPaneNodeData, 'canvasPane'>;

/**
 * A xyflow custom node that hosts a real xterm terminal.
 *
 * Re-parenting mechanics: the terminal DOM node (host.element) lives in the
 * module-level hosts Map inside terminal-host.ts.  On mount this component
 * appends that node into its slot div.  Switching views (canvas↔grid) just
 * moves the same element to a different slot — zero PTY restart.
 */
export const CanvasPaneNode = memo(function CanvasPaneNode({
  data,
  id,
}: NodeProps<CanvasPaneNodeType>) {
  const { pane } = data;
  const slotRef = useRef<HTMLDivElement>(null);
  const { zoom } = useViewport();
  const isFocused = useLayoutStore((s) => s.focusedPaneId === id);
  const focus = useLayoutStore((s) => s.focus);
  const isSnapshot = zoom < SNAPSHOT_THRESHOLD;

  // Attach (or re-attach after snapshot) the terminal into this slot.
  useEffect(() => {
    if (pane.kind === 'browser') return undefined;
    const slot = slotRef.current;
    if (!slot || isSnapshot) return undefined;
    attachHost(pane, slot);
    // On snapshot-enter (or unmount) detach the xterm element from the slot
    // BEFORE React drops the slot div — otherwise the dead slot keeps the
    // terminal (and its WebGL canvas) parented off-tree, pressuring the GPU
    // with many panes. Purely visual: the PTY session and buffer stay alive
    // in terminal-host; re-attach on snapshot-exit re-parents the same node.
    return () => {
      for (const child of Array.from(slot.children)) child.remove();
    };
    // pane.id is the stable identity; isSnapshot controls live vs. frozen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, isSnapshot]);

  useEffect(() => {
    if (pane.kind !== 'browser' && isFocused && !isSnapshot) focusHost(id);
  }, [isFocused, id, isSnapshot, pane.kind]);

  return (
    <div
      className={`canvas-pane ${isFocused ? 'canvas-pane--focused' : ''}`}
      onMouseDown={() => focus(id)}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <NodeResizer
        minWidth={280}
        minHeight={200}
        isVisible={isFocused}
        lineStyle={{ borderColor: 'var(--accent)' }}
        handleStyle={{ borderColor: 'var(--accent)', background: 'var(--bg)' }}
      />
      {/* "Edges que conversam": drag from the right handle of one pane to the
          left handle of another to pipe its output into that pane's input. */}
      <Handle
        type="target"
        position={Position.Left}
        className="canvas-pane__handle canvas-pane__handle--in"
        title="Receber saída de outro pane"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="canvas-pane__handle canvas-pane__handle--out"
        title="Enviar saída para outro pane"
      />
      {pane.kind === 'browser' ? (
        <BrowserPane pane={pane} isCanvas />
      ) : isSnapshot ? (
        <div className="canvas-pane__snapshot">
          <span className="canvas-pane__snapshot-label">{pane.title}</span>
          <span className="canvas-pane__snapshot-meta">
            {pane.adapterId ?? pane.kind}
          </span>
        </div>
      ) : (
        <>
          <PaneToolbar pane={pane} isFocused={isFocused} isCanvas />
          <div ref={slotRef} className="canvas-pane__terminal nodrag" />
        </>
      )}
    </div>
  );
});

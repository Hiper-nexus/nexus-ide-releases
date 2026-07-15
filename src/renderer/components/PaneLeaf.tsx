import { useEffect, useRef } from 'react';
import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { attachHost, blurHost, focusHost } from '../terminal/terminal-host';
import { BrowserPane } from './BrowserPane';
import { PaneToolbar } from './PaneToolbar';

interface Props {
  pane: PaneModel;
}

/**
 * A leaf in the grid. The React wrapper (chrome + slot) is cheap and may remount
 * as the tree reshapes, but the actual terminal DOM node is owned by the
 * persistent terminal host and merely re-parented into this slot — so the shell
 * behind the pane never resets on split/close.
 */
export function PaneLeaf({ pane }: Props) {
  if (pane.kind === 'browser') {
    return <BrowserPane pane={pane} />;
  }
  return <TerminalPaneLeaf pane={pane} />;
}

function TerminalPaneLeaf({ pane }: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const isFocused = useLayoutStore((s) => s.focusedPaneId === pane.id);
  // Display state (busy sticky) — true state flips on short PTY gaps; using it
  // here restarts border animations and reads as terminal flicker.
  const sessionState = useSessionStateStore((s) => s.displayStates.get(pane.id));

  useEffect(() => {
    const slot = slotRef.current;
    if (slot) attachHost(pane, slot);
    // No teardown here: the host lives beyond this wrapper. Reconciliation in
    // PaneGrid disposes it only when the pane leaves the tree entirely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useEffect(() => {
    if (isFocused) focusHost(pane.id);
    else blurHost(pane.id);
  }, [isFocused, pane.id]);

  return (
    <div
      className={`pane ${isFocused ? 'pane--focused' : ''} ${
        sessionState ? `pane--state-${sessionState}` : ''
      }`}
    >
      <PaneToolbar pane={pane} isFocused={isFocused} />
      <div className="pane__terminal" ref={slotRef} />
    </div>
  );
}

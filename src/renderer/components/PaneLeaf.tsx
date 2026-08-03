import { useLayoutEffect, useRef, useState, useCallback } from 'react';
import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { isStructuralPlaceholderPane } from '../lib/split-tree';
import { attachHost, blurHost, focusHost, refreshHost } from '../terminal/terminal-host';
import { BrowserPane } from './BrowserPane';
import { PaneActivityStrip } from './PaneActivityStrip';
import { PaneBirthOverlay } from './PaneBirthOverlay';
import { PaneInteractionSurface } from './PaneInteractionSurface';
import { PaneToolbar } from './PaneToolbar';
import { PaneVacancy } from './PaneVacancy';
import { AcpPaneView } from './AcpPaneView';

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
  // The marker outranks the kind. A structural placeholder is minted as a
  // shell for one reason only — the tree has no "empty slot" type — and every
  // terminal behaviour it inherits (scrollback replay, PTY spawn, prompt) is
  // an accident of that choice. Branching here, on the same predicate the
  // store uses, keeps the rendered surface and the layout rule from drifting.
  if (isStructuralPlaceholderPane(pane)) {
    return <PaneVacancy pane={pane} />;
  }
  if (pane.kind === 'browser') {
    return <BrowserPane pane={pane} />;
  }
  if (pane.kind === 'cli-agent' && pane.agentTransport === 'acp') {
    return <AcpPaneLeaf pane={pane} />;
  }
  return <TerminalPaneLeaf pane={pane} />;
}

function AcpPaneLeaf({ pane }: Props) {
  const isFocused = useLayoutStore((s) => s.focusedPaneId === pane.id);
  return (
    <PaneInteractionSurface
      pane={pane}
      className={`pane ${isFocused ? 'pane--focused' : ''} pane--acp`}
    >
      <PaneToolbar pane={pane} isFocused={isFocused} />
      <AcpPaneView missionId={pane.missionId ?? ''} />
    </PaneInteractionSurface>
  );
}

function TerminalPaneLeaf({ pane }: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const isFocused = useLayoutStore((s) => s.focusedPaneId === pane.id);
  // Display state (busy sticky) — true state flips on short PTY gaps; using it
  // here restarts border animations and reads as terminal flicker.
  const sessionState = useSessionStateStore((s) => s.displayStates.get(pane.id));

  // Visible-only rendering: pause terminal rendering when off-screen.
  // The browser skips painting hidden elements, and we force a repaint
  // when the pane re-enters the viewport.
  const [isVisible, setIsVisible] = useState(true);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const handleIntersection = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      for (const entry of entries) {
        const nowVisible = entry.isIntersecting;
        setIsVisible((prev) => {
          if (prev === nowVisible) return prev;
          // Force repaint when becoming visible again
          if (nowVisible) {
            requestAnimationFrame(() => refreshHost(pane.id));
          }
          return nowVisible;
        });
      }
    },
    [pane.id],
  );

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    observerRef.current = new IntersectionObserver(handleIntersection, {
      root: null,
      threshold: 0.1, // Consider visible when 10% is in viewport
    });
    observerRef.current.observe(slot);
    return () => {
      observerRef.current?.disconnect();
    };
  }, [handleIntersection]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (slot) attachHost(pane, slot);
    // No teardown here: the host lives beyond this wrapper. Reconciliation in
    // PaneGrid disposes it only when the pane leaves the tree entirely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useLayoutEffect(() => {
    if (isFocused) focusHost(pane.id);
    else blurHost(pane.id);
  }, [isFocused, pane.id]);

  return (
    <PaneInteractionSurface
      pane={pane}
      className={`pane ${isFocused ? 'pane--focused' : ''} ${
        sessionState ? `pane--state-${sessionState}` : ''
      }`}
    >
      <PaneToolbar pane={pane} isFocused={isFocused} />
      {pane.kind === 'cli-agent' && <PaneActivityStrip paneId={pane.id} />}
      {/* Irmão do slot, nunca filho: o nó do terminal é re-parentado para
          dentro de `pane__terminal` por fora do React. */}
      {pane.kind === 'cli-agent' && <PaneBirthOverlay pane={pane} />}
      <div
        className="pane__terminal"
        ref={slotRef}
        style={isVisible ? undefined : { visibility: 'hidden' }}
      />
    </PaneInteractionSurface>
  );
}

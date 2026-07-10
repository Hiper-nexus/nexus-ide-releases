import { useState } from 'react';
import type { PaneModel } from '../../shared/types';
import { waitForBrowserPaneCreated } from '../browser/browser-host';
import { useDevServerStore } from '../state/dev-server-store';
import { useLayoutStore } from '../state/layout-store';

type Props = {
  pane: PaneModel;
};

function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * "Abrir no browser pane" (VISUAL-EDIT-001, F1.5): shows up in a PTY pane's
 * toolbar once its output announces a dev-server URL. Opening goes through the
 * regular user navigation path (about:blank + load), so the existing
 * private-network confirmation still guards localhost.
 */
export function DevServerChip({ pane }: Props) {
  const info = useDevServerStore((s) => s.byPane[pane.id]);
  const [isOpening, setIsOpening] = useState(false);
  if (!info || pane.kind === 'browser') return null;

  async function open(): Promise<void> {
    if (isOpening) return;
    setIsOpening(true);
    try {
      const paneId = useLayoutStore.getState().addBrowserPane('about:blank');
      await waitForBrowserPaneCreated(paneId);
      await window.nexus.browser.load(paneId, info.url);
    } catch {
      // Denied private-network confirmation or closed pane: nothing to clean.
    } finally {
      setIsOpening(false);
    }
  }

  return (
    <button
      type="button"
      data-testid="devserver-chip"
      className="devserver-chip nodrag"
      title={`Dev server detectado — abrir ${info.url} num browser pane`}
      disabled={isOpening}
      onClick={() => void open()}
    >
      🌐 {hostLabel(info.url)}
    </button>
  );
}

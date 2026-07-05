import { useEffect, useRef, useState } from 'react';
import type { BrowserPaneState, PaneModel } from '../../shared/types';
import { attachBrowserPane } from '../browser/browser-host';
import { useLayoutStore } from '../state/layout-store';
import { PaneToolbar } from './PaneToolbar';

interface Props {
  pane: PaneModel;
  isCanvas?: boolean;
}

const EMPTY_STATE: BrowserPaneState = {
  paneId: '',
  url: 'about:blank',
  title: 'browser',
  canGoBack: false,
  canGoForward: false,
  loading: false,
};

export function BrowserPane({ pane, isCanvas }: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const isFocused = useLayoutStore((s) => s.focusedPaneId === pane.id);
  const [state, setState] = useState<BrowserPaneState>({
    ...EMPTY_STATE,
    paneId: pane.id,
    url: pane.browserUrl ?? 'about:blank',
  });
  const [draftUrl, setDraftUrl] = useState(state.url);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    return attachBrowserPane(pane, slot, (next) => {
      setState(next);
      setDraftUrl(next.url);
    });
  }, [pane.id]);

  async function load(url: string): Promise<void> {
    const clean = url.trim();
    if (!clean) return;
    try {
      const next = await window.nexus.browser.load(pane.id, clean);
      setState(next);
      setDraftUrl(next.url);
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      }));
    }
  }

  async function nav(action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> {
    try {
      const next = await window.nexus.browser[action](pane.id);
      setState(next);
      setDraftUrl(next.url);
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  return (
    <div className={`pane ${isFocused ? 'pane--focused' : ''}`}>
      <PaneToolbar pane={pane} isFocused={isFocused} isCanvas={isCanvas} />
      <form
        className="browser-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void load(draftUrl);
        }}
      >
        <button
          type="button"
          className="browser-bar__btn"
          disabled={!state.canGoBack}
          title="Voltar"
          aria-label="Voltar"
          onClick={() => void nav('back')}
        >
          ‹
        </button>
        <button
          type="button"
          className="browser-bar__btn"
          disabled={!state.canGoForward}
          title="Avançar"
          aria-label="Avançar"
          onClick={() => void nav('forward')}
        >
          ›
        </button>
        <button
          type="button"
          className="browser-bar__btn"
          title={state.loading ? 'Parar' : 'Recarregar'}
          aria-label={state.loading ? 'Parar' : 'Recarregar'}
          onClick={() => void nav(state.loading ? 'stop' : 'reload')}
        >
          {state.loading ? '×' : '↻'}
        </button>
        <input
          className="browser-bar__url"
          value={draftUrl}
          spellCheck={false}
          onChange={(e) => setDraftUrl(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="URL do browser"
        />
      </form>
      {state.error && <div className="browser-pane__error">{state.error}</div>}
      <div ref={slotRef} className="browser-pane__surface" />
    </div>
  );
}

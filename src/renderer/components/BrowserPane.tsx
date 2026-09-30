import { useEffect, useRef, useState } from 'react';
import type { BrowserPaneState, PaneModel } from '../../shared/types';
import { attachBrowserPane } from '../browser/browser-host';
import { browserAddressInput } from '../browser/address-input';
import { useLayoutStore } from '../state/layout-store';
import { PixelIcon } from './PixelIcon';
import { BrowserDesignBar } from './BrowserDesignBar';
import { DesignSidebar } from './DesignSidebar';
import { PaneToolbar } from './PaneToolbar';
import { BrowserProfilePanel } from './BrowserProfilePanel';

interface Props {
  pane: PaneModel;
}

const EMPTY_STATE: BrowserPaneState = {
  paneId: '',
  url: 'about:blank',
  title: 'browser',
  canGoBack: false,
  canGoForward: false,
  loading: false,
};

export function BrowserPane({ pane }: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const isFocused = useLayoutStore((s) => s.focusedPaneId === pane.id);
  const [state, setState] = useState<BrowserPaneState>({
    ...EMPTY_STATE,
    paneId: pane.id,
    url: pane.browserUrl ?? 'about:blank',
  });
  const [draftUrl, setDraftUrl] = useState(state.url);
  const [stylesOpen, setStylesOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

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
      const next = await window.nexus.browser.load(pane.id, browserAddressInput(clean));
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
      <PaneToolbar pane={pane} isFocused={isFocused} />
      <form
        className="browser-bar nodrag"
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
          <PixelIcon name="arrow-left" size={12} />
        </button>
        <button
          type="button"
          className="browser-bar__btn"
          disabled={!state.canGoForward}
          title="Avançar"
          aria-label="Avançar"
          onClick={() => void nav('forward')}
        >
          <PixelIcon name="arrow-right" size={12} />
        </button>
        <button
          type="button"
          className="browser-bar__btn"
          title={state.loading ? 'Parar' : 'Recarregar'}
          aria-label={state.loading ? 'Parar' : 'Recarregar'}
          onClick={() => void nav(state.loading ? 'stop' : 'reload')}
        >
          <PixelIcon name={state.loading ? 'stop' : 'refresh'} size={12} />
        </button>
        <input
          className="browser-bar__url"
          value={draftUrl}
          spellCheck={false}
          onChange={(e) => setDraftUrl(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Buscar ou digitar endereço"
          placeholder="Buscar ou digitar endereço"
        />
        <button type="button" className="browser-profile-toggle" aria-expanded={profileOpen} onClick={() => setProfileOpen((open) => !open)}>Perfil e logins</button>
      </form>
      {profileOpen && <BrowserProfilePanel paneId={pane.id} onClose={() => setProfileOpen(false)} />}
      {state.loading && (
        <div className="browser-bar__progress nodrag" aria-hidden="true" />
      )}
      <BrowserDesignBar
        paneId={pane.id}
        stylesOpen={stylesOpen}
        onToggleStyles={() => setStylesOpen((open) => !open)}
      />
      {state.error && <div className="browser-pane__error nodrag">{state.error}</div>}
      <div className="browser-pane__body">
        <div ref={slotRef} className="browser-pane__surface nodrag" />
        {stylesOpen && <DesignSidebar paneId={pane.id} />}
      </div>
    </div>
  );
}

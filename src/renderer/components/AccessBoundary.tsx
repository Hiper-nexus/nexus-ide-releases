import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccessBlockedReason } from '../../shared/billing-types';
import { useAccess, WorkspaceInertContext } from '../state/access-store';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { listPanes } from '../lib/split-tree';
import { nextTrapFocus } from '../lib/focus-trap';
import { requestPaneClose } from '../terminal/pane-close-guard';
import { AccountSection } from './settings/AccountSection';
import { AccessPaneList } from './access/AccessPaneList';
import { ACCESS_COPY, accessTitle } from './access/access-view';
import { NexusMark } from './NexusMark';
import { UpdateNotifier } from './UpdateModal';
import '../styles/access-boundary.css';

/** Keep the workspace mounted: access changes never dispose hosts or mutate layout. */
export function AccessBoundary({ children }: { children: ReactNode }) {
  const access = useAccess();
  return <>
    <WorkspaceInertContext.Provider value={!access.canUseApp}>
      <div className="access-workspace" ref={node => { node?.toggleAttribute('inert', !access.canUseApp); }}>{children}</div>
    </WorkspaceInertContext.Provider>
    {!access.canUseApp && <AccessScreen loading={access.loading} reason={access.blockedReason} />}
  </>;
}

/** A ação principal da tela (um só botão), marcada por AccessAccountCard. */
const INITIAL_FOCUS = '[data-access-initial-focus]:not(:disabled)';

function AccessScreen({ loading, reason }: { loading: boolean; reason: AccessBlockedReason | null }) {
  const ref = useRef<HTMLElement>(null);
  const root = useLayoutStore(s => s.root);
  const states = useSessionStateStore(s => s.paneStates);
  const workspace = useWorkspaceStore(s => s.current);
  const [folderError, setFolderError] = useState(false);
  const panes = listPanes(root);
  useEffect(() => {
    const screen = ref.current;
    screen?.querySelector<HTMLElement>(INITIAL_FOCUS)?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      const screen = ref.current;
      if (!screen) return;
      // Confirmations and the updater live outside inert and own their own focus.
      const dialog = document.activeElement?.closest('[role="dialog"], [role="alertdialog"]');
      if (dialog && dialog !== screen) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      if (event.key !== 'Tab') return;
      const result = nextTrapFocus(screen, document.activeElement, event.shiftKey);
      if (result.handled) { event.preventDefault(); result.next?.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [loading, reason]);
  return <section ref={ref} className="access-screen" role="dialog" aria-modal="true" aria-labelledby="access-title">
    <div className="access-screen__content">
      <div className="access-brand">
        <NexusMark size={22} />
        <span>NexusIDE</span>
      </div>
      <header className="access-head">
        <h1 id="access-title">{accessTitle(loading, reason)}</h1>
        <p role="status">{ACCESS_COPY[loading ? 'startup-pending' : (reason ?? 'verification-unavailable')]}</p>
        <p>Seus projetos e terminais continuam preservados.</p>
      </header>
      <AccountSection accessOnly />
      <AccessPaneList
        panes={panes}
        states={states}
        onClose={paneId => void requestPaneClose(paneId)}
      />
      <footer className="access-footer">
        <UpdateNotifier alwaysVisible />
        {workspace && <button type="button" className="access-btn access-btn--quiet" onClick={() => {
          setFolderError(false);
          void window.nexus.app.openTerminalPath(workspace.path).then(result => { if (!result.ok) setFolderError(true); }).catch(() => setFolderError(true));
        }}>Abrir pasta do projeto</button>}
        {folderError && <p className="access-error" role="alert">Não foi possível abrir a pasta do projeto.</p>}
      </footer>
    </div>
  </section>;
}

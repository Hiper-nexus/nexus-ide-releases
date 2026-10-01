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
import { UpdateNotifier } from './UpdateModal';
import '../styles/access-boundary.css';

export const ACCESS_COPY: Record<AccessBlockedReason, string> = {
  'startup-pending': 'Consultando seu acesso…',
  'login-required': 'Entre na sua conta Nexus para começar.',
  'verification-unavailable': 'Não foi possível consultar seu acesso agora. Tente novamente.',
  'invalid-license': 'Não foi possível validar sua licença. Entre novamente para atualizar o acesso.',
  'license-expired': 'Sua licença precisa ser renovada. Entre novamente para atualizar o acesso.',
  'account-mismatch': 'A licença pertence a outra conta. Entre com a conta da assinatura.',
  suspended: 'Seu acesso está suspenso. Consulte sua assinatura no portal de cobrança.',
  inactive: 'Sua assinatura está inativa. Consulte o portal de cobrança ou assine o Pro.',
  'trial-ended': 'Seu teste de 15 dias terminou. Assine o Pro para continuar.',
};

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

function AccessScreen({ loading, reason }: { loading: boolean; reason: AccessBlockedReason | null }) {
  const ref = useRef<HTMLElement>(null);
  const root = useLayoutStore(s => s.root);
  const states = useSessionStateStore(s => s.paneStates);
  const workspace = useWorkspaceStore(s => s.current);
  const [folderError, setFolderError] = useState(false);
  const panes = listPanes(root);
  useEffect(() => {
    const selector = reason === 'trial-ended' || reason === 'inactive' ? '.account__plan-cta' : '.settings-btn--primary:not(:disabled)';
    ref.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
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
      <header>
        <h1 id="access-title">{loading ? 'Consultando seu acesso' : 'Seu acesso ao NexusIDE'}</h1>
        <p role="status">{loading ? 'Aguarde a confirmação da sua conta.' : ACCESS_COPY[reason ?? 'verification-unavailable']}</p>
        <p>Seus projetos e terminais continuam preservados.</p>
      </header>
      <AccountSection accessOnly />
      <section aria-label="Terminais preservados">
        <h2>Seus terminais</h2>
        <ul className="access-screen__panes">
          {panes.map(pane => <li key={pane.id}>
            <span>{pane.title} · {({ idle: 'Aguardando', busy: 'Trabalhando', spawning: 'Iniciando', exited: 'Encerrado', hibernated: 'Em pausa' } as Record<string, string>)[states.get(pane.id) ?? ''] ?? 'Preservado'}</span>
            <button className="settings-btn" onClick={() => void requestPaneClose(pane.id)}>Fechar {pane.title}</button>
          </li>)}
        </ul>
      </section>
      <footer className="access-screen__utilities">
        <UpdateNotifier alwaysVisible />
        {workspace && <button className="settings-btn" onClick={() => {
          setFolderError(false);
          void window.nexus.app.openTerminalPath(workspace.path).then(result => { if (!result.ok) setFolderError(true); }).catch(() => setFolderError(true));
        }}>Abrir pasta do projeto</button>}
        {folderError && <p role="alert">Não foi possível abrir a pasta do projeto.</p>}
      </footer>
    </div>
  </section>;
}

import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installRestoredAgentsGate } from './orch/restore-agents-gate';
import { installSoakRenderer } from './soak-smoke';
import { installRuntimeGateRenderer } from './runtime-gates';
import './styles/global.css';

// Hold every restored CLI first; mission panes resume only after Main confirms
// their exact persisted authority, while standalone agents follow user policy.
installRestoredAgentsGate();
installSoakRenderer();
installRuntimeGateRenderer();

// No StrictMode: its dev-time double-mount would spawn/kill PTYs twice per pane.
const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element missing from index.html');
}

// O documento carrega em paralelo ao bootstrap do Main: o React só monta
// quando o gate boot:ready resolve — nenhum IPC do app roda antes dele e um
// bootstrap falho rejeita o gate sem expor renderer parcial. A flag avisa o
// poll de mount do Main: página viva aguardando não é renderer morto.
const bootWindow = window as Window & { __nexusBootAwaiting?: boolean };
const mountApp = (): void => {
  bootWindow.__nexusBootAwaiting = false;
  document.getElementById('nexus-boot-splash')?.remove();
  // The ErrorBoundary both renders a readable screen on a boot crash (instead of a
  // black window) and fires the main-process mount signal from its post-commit
  // lifecycle — see ErrorBoundary for why this replaces the old `[diag]` log.
  createRoot(container).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
};
if (typeof window.nexus?.app?.ready === 'function') {
  bootWindow.__nexusBootAwaiting = true;
  void window.nexus.app.ready().then(
    mountApp,
    (error: unknown) => {
      // Bootstrap falhou: o Main mostra o motivo e encerra. A flag segue de pé
      // (documento vivo esperando) até o processo morrer.
      console.error('[boot] gate boot:ready rejeitado:', error);
    },
  );
} else {
  // Sem preload (preview web do vite): não há gate para esperar.
  mountApp();
}

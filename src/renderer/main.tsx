import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installRestoredAgentsGate } from './orch/restore-agents-gate';
import './styles/global.css';

// Hold restored mission agents until the user confirms — never silent auto-work.
installRestoredAgentsGate();

// No StrictMode: its dev-time double-mount would spawn/kill PTYs twice per pane.
const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element missing from index.html');
}
// The ErrorBoundary both renders a readable screen on a boot crash (instead of a
// black window) and fires the main-process mount signal from its post-commit
// lifecycle — see ErrorBoundary for why this replaces the old `[diag]` log.
createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

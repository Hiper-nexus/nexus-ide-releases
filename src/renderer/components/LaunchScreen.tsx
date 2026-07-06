import { useState } from 'react';
import { useWorkspaceStore } from '../state/workspace-store';
import { useSettingsStore } from '../state/settings-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { NexusMark } from './NexusMark';
import { PixelIcon } from './PixelIcon';

/**
 * Launch / onboarding screen — the first surface when no workspace is open:
 * open a folder (picker), or reopen a recent workspace.
 * Choosing a workspace roots every new pane/mission at that folder.
 */

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins}m atrás`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h atrás`;
  return `${Math.floor(hours / 24)}d atrás`;
}

export function LaunchScreen() {
  const recents = useWorkspaceStore((s) => s.recents);
  const open = useWorkspaceStore((s) => s.open);
  const remove = useWorkspaceStore((s) => s.remove);
  const openSettings = useSettingsStore((s) => s.toggleDrawer);
  const openWizard = useMissionWizardStore((s) => s.openForNewWorkspace);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);

  async function openManual() {
    const path = manual.trim();
    if (!path) return;
    setBusy(true);
    try {
      await open(path);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="launch">
      <header className="launch__topbar">
        <div className="workspace-bar__brand">
          <NexusMark size={15} className="workspace-bar__logo" />
          <span className="workspace-bar__name">NexusIDE</span>
        </div>
        <button
          className="workspace-bar__btn"
          onClick={openSettings}
          title="Providers, keys, catálogo e temas"
        >
          <PixelIcon name="config" />
          Configurações
        </button>
      </header>
      <div className="launch__panel">
        <header className="launch__head">
          <NexusMark size={30} className="launch__logo" />
          <div>
            <h1 className="launch__title">NexusIDE</h1>
            <p className="launch__tagline">
              Múltiplos agentes de IA. Um workspace.
            </p>
          </div>
        </header>

        <div className="launch__actions">
          <button
            className="launch__primary"
            onClick={openWizard}
            disabled={busy}
          >
            ＋ Novo workspace
          </button>
          <div className="launch__manual">
            <input
              className="launch__input"
              value={manual}
              placeholder="/caminho/para/o/projeto"
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void openManual()}
            />
            <button
              className="launch__secondary"
              onClick={() => void openManual()}
              disabled={busy || !manual.trim()}
            >
              Abrir →
            </button>
          </div>
        </div>

        <section className="launch__recents">
          <h2 className="launch__section">Workspaces recentes</h2>
          {recents.length === 0 ? (
            <p className="launch__empty">
              Nenhum workspace ainda. Escolha uma pasta para começar.
            </p>
          ) : (
            <ul className="launch__list">
              {recents.map((ws) => (
                <li key={ws.path} className="launch__item">
                  <button
                    className="launch__item-open"
                    onClick={() => void open(ws.path)}
                    disabled={busy}
                  >
                    <span className="launch__item-name">{ws.name}</span>
                    <span className="launch__item-path">{ws.path}</span>
                  </button>
                  <span className="launch__item-meta">
                    {timeAgo(ws.lastOpenedAt)}
                  </span>
                  <button
                    className="launch__item-remove"
                    onClick={() => void remove(ws.path)}
                    title="Remover dos recentes"
                    aria-label="Remover dos recentes"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="launch__footer">
          <span className="launch__hint">
            Configure providers, keys, catálogo e temas em ⚙ Configurações (barra
            superior).
          </span>
        </footer>
      </div>
    </div>
  );
}

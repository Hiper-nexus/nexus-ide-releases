import { useEffect, useMemo, useState } from 'react';
import type { AdapterInfo } from '../../shared/types';
import type { ProgressiveLaunch } from '../../shared/progressive-onboarding';
import { useWorkspaceStore } from '../state/workspace-store';
import { useSettingsStore } from '../state/settings-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useOrchStore } from '../state/orch-store';
import {
  clearProgressiveLaunch,
  stashProgressiveLaunch,
} from '../lib/progressive-launch';
import { NexusMark } from './NexusMark';
import { PixelIcon } from './PixelIcon';
import { ProgressiveOnboarding } from './ProgressiveOnboarding';
import { useProductFlags } from '../lib/use-product-flags';
import { formatShortcut } from '../lib/platform';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';

/**
 * Launch / onboarding screen — the first surface when no workspace is open:
 * progressive Start flow by default, with skip → classic advanced launcher.
 * Choosing a workspace roots every new pane/mission at that folder.
 */

const SKIP_KEY = 'nexus.progressiveOnboarding.skipped';

function timeAgo(ts: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins}m atrás`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h atrás`;
  return `${Math.floor(hours / 24)}d atrás`;
}

export function LaunchScreen() {
  const productFlags = useProductFlags();
  const recents = useWorkspaceStore((s) => s.recents);
  const open = useWorkspaceStore((s) => s.open);
  const pick = useWorkspaceStore((s) => s.pick);
  const remove = useWorkspaceStore((s) => s.remove);
  const openSettings = useSettingsStore((s) => s.toggleDrawer);
  const openWizard = useMissionWizardStore((s) => s.openForNewWorkspace);
  const mcpInfo = useOrchStore((s) => s.mcpInfo);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [adaptersLoaded, setAdaptersLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(() => {
    try {
      return sessionStorage.getItem(SKIP_KEY) === '1';
    } catch {
      return false;
    }
  });

  const installed = useMemo(
    () => adapters.filter((adapter) => adapter.installed),
    [adapters],
  );
  const mostRecent = recents[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    void window.nexus.adapters
      .list()
      .then((next) => {
        if (!cancelled) setAdapters(next);
      })
      .catch(() => {
        if (!cancelled) setError('Não foi possível verificar as CLIs instaladas.');
      })
      .finally(() => {
        if (!cancelled) setAdaptersLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'o'
      ) {
        event.preventDefault();
        openWizard();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openWizard]);

  async function openPath(path: string) {
    if (!path || busy) return;
    setBusy(true);
    setError(null);
    try {
      await open(path);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível abrir este workspace.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function openManual() {
    const path = manual.trim();
    if (!path) return;
    await openPath(path);
  }

  async function handleProgressiveLaunch(plan: ProgressiveLaunch) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      stashProgressiveLaunch(plan);
      if (plan.recentWorkspacePath) {
        await open(plan.recentWorkspacePath);
        return;
      }
      // Folder picker opens a workspace; plan applies after layout hydrate.
      const before = useWorkspaceStore.getState().current?.path ?? null;
      await pick();
      const after = useWorkspaceStore.getState().current?.path ?? null;
      if (!after || after === before) {
        // User cancelled the dialog — drop stashed plan.
        clearProgressiveLaunch();
      }
    } catch (cause) {
      clearProgressiveLaunch();
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível abrir este workspace.',
      );
    } finally {
      setBusy(false);
    }
  }

  function skipToAdvanced() {
    try {
      sessionStorage.setItem(SKIP_KEY, '1');
    } catch {
      /* ignore */
    }
    setAdvanced(true);
  }

  if (!advanced) {
    return (
      <div className="launch launch--progressive" data-testid="launch-progressive">
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
        <main className="launch__panel" aria-busy={busy}>
          <ProgressiveOnboarding
            flagEnabled={
              productFlags[FEATURE_FLAG_IDS.progressiveOnboarding] !== false
            }
            recents={recents.map((r) => ({ path: r.path, label: r.name }))}
            onLaunch={(plan) => void handleProgressiveLaunch(plan)}
            onSkip={skipToAdvanced}
            onOpenTerminalOnly={() => {
              stashProgressiveLaunch({
                mode: 'terminal-only',
                paneCount: 1,
                agentDistribution: 'none',
                openWithoutAi: true,
              });
              void pick().catch((cause) => {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : 'Não foi possível abrir este workspace.',
                );
              });
            }}
          />
          {error && (
            <p className="launch__error" role="alert" style={{ marginTop: 12 }}>
              {error}
            </p>
          )}
        </main>
      </div>
    );
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
          onClick={() => {
            try {
              sessionStorage.removeItem(SKIP_KEY);
            } catch {
              /* ignore */
            }
            setAdvanced(false);
          }}
          title="Voltar ao início guiado"
        >
          Início guiado
        </button>
        <button
          className="workspace-bar__btn"
          onClick={openSettings}
          title="Providers, keys, catálogo e temas"
        >
          <PixelIcon name="config" />
          Configurações
        </button>
      </header>
      <main className="launch__panel" aria-busy={busy}>
        <section className="launch__command" aria-labelledby="launch-title">
          <header className="launch__head">
            <NexusMark size={32} className="launch__logo" />
            <div>
              <h1 id="launch-title" className="launch__title">NexusIDE</h1>
              <p className="launch__tagline">
                Centro de operações multiagente
              </p>
            </div>
          </header>

          <div className="launch__readiness" aria-label="Estado do sistema">
            <span className={installed.length > 0 ? 'is-live' : ''}>
              <i aria-hidden="true" />
              {adaptersLoaded
                ? `${installed.length} CLI${installed.length === 1 ? '' : 's'} pronta${installed.length === 1 ? '' : 's'}`
                : 'Verificando CLIs'}
            </span>
            <span className={mcpInfo?.running ? 'is-live' : ''}>
              <i aria-hidden="true" />
              {mcpInfo?.running
                ? `MCP online · ${mcpInfo.toolCount} ferramentas`
                : mcpInfo
                  ? 'MCP indisponível'
                  : 'MCP conectando'}
            </span>
          </div>

          <div className="launch__next">
            <p className="launch__next-label">Próxima ação</p>
            <h2>
              {mostRecent ? `Retomar ${mostRecent.name}` : 'Abrir seu primeiro workspace'}
            </h2>
            <p>
              {mostRecent
                ? 'Reabra o último contexto com seus panes e missões preservados.'
                : 'Escolha a pasta que vai delimitar os terminais, agentes e ferramentas.'}
            </p>
          </div>

          <div className="launch__actions">
            {mostRecent ? (
              <button
                className="launch__primary"
                onClick={() => void openPath(mostRecent.path)}
                disabled={busy}
                autoFocus
              >
                <PixelIcon name="mission" size={14} />
                {busy ? 'Abrindo…' : `Continuar ${mostRecent.name}`}
              </button>
            ) : (
              <button
                className="launch__primary"
                onClick={openWizard}
                disabled={busy}
                autoFocus
              >
                <PixelIcon name="plus" size={14} />
                Novo workspace
              </button>
            )}
            {mostRecent && (
              <button className="launch__secondary" onClick={openWizard} disabled={busy}>
                <PixelIcon name="plus" size={12} />
                Novo workspace <kbd>{formatShortcut('mod', 'O')}</kbd>
              </button>
            )}
          </div>

          <form
            className="launch__manual"
            onSubmit={(event) => {
              event.preventDefault();
              void openManual();
            }}
          >
            <label htmlFor="launch-workspace-path">Abrir por caminho</label>
            <div className="launch__manual-row">
              <input
                id="launch-workspace-path"
                className="launch__input"
                value={manual}
                placeholder="/caminho/para/o/projeto"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setManual(event.target.value)}
              />
              <button
                className="launch__secondary"
                type="submit"
                disabled={busy || !manual.trim()}
              >
                Abrir pasta
              </button>
            </div>
          </form>
          {error && <p className="launch__error" role="alert">{error}</p>}
        </section>

        <section className="launch__recents" aria-labelledby="launch-recents">
          <header className="launch__recents-head">
            <h2 id="launch-recents" className="launch__section">Workspaces recentes</h2>
            <span>{recents.length}</span>
          </header>
          {recents.length === 0 ? (
            <div className="launch__empty">
              <PixelIcon name="files" size={18} />
              <p>Nenhum workspace recente.</p>
              <span>Use “Novo workspace” para escolher uma pasta.</span>
            </div>
          ) : (
            <ul className="launch__list">
              {recents.map((ws) => (
                <li key={ws.path} className="launch__item">
                  <button
                    className="launch__item-open"
                    onClick={() => void openPath(ws.path)}
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
                    onClick={() => {
                      setError(null);
                      void remove(ws.path).catch((cause) => {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : 'Não foi possível remover este workspace dos recentes.',
                        );
                      });
                    }}
                    disabled={busy}
                    title="Remover dos recentes"
                    aria-label={`Remover ${ws.name} dos recentes`}
                  >
                    <PixelIcon name="close" size={9} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <footer className="launch__footer">
            <span>Selecione um workspace para restaurar o contexto.</span>
            <kbd>{formatShortcut('mod', ',')}</kbd> configurações
          </footer>
        </section>
      </main>
    </div>
  );
}

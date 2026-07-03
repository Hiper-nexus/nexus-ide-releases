import { useEffect, useState } from 'react';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useSettingsStore } from '../state/settings-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useCloseWorkspaceStore } from './CloseWorkspaceDialog';
import { useFilesStore } from '../state/files-store';
import { listPanes } from '../lib/split-tree';
import { VoiceButton } from './VoiceButton';
import type { AdapterInfo } from '../../shared/types';

/** Brief label identifying the active view mode. */
function viewLabel(kind: 'grid' | 'canvas'): string {
  return kind === 'canvas' ? '⬡ Canvas' : '⊞ Grid';
}

/** Slim top chrome: brand, pane count, split shortcuts, view toggle, and the agent launcher. */
export function WorkspaceBar() {
  const root = useLayoutStore((s) => s.root);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const viewKind = useLayoutStore((s) => s.viewKind);
  const split = useLayoutStore((s) => s.split);
  const spawnAgent = useLayoutStore((s) => s.spawnAgent);
  const toggleView = useLayoutStore((s) => s.toggleView);
  const paneCount = listPanes(root).length;

  const orchPanelOpen = useOrchStore((s) => s.panelOpen);
  const toggleOrchPanel = useOrchStore((s) => s.togglePanel);
  const toggleSettings = useSettingsStore((s) => s.toggleDrawer);
  const workspace = useWorkspaceStore((s) => s.current);
  const openWizard = useMissionWizardStore((s) => s.openForMission);
  const openNewWorkspace = useMissionWizardStore((s) => s.openForNewWorkspace);
  const askCloseWorkspace = useCloseWorkspaceStore((s) => s.ask);
  const filesOpen = useFilesStore((s) => s.open);
  const toggleFiles = useFilesStore((s) => s.togglePanel);
  const activeTodo = useOrchStore((s) => {
    for (const list of s.todoLists) {
      const current = list.items.find((item) => item.status === 'in_progress');
      if (current) return current.name;
    }
    return null;
  });

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedAdapter, setSelectedAdapter] = useState<AdapterInfo | null>(null);
  const [selectedModel, setSelectedModel] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.nexus.adapters.list().then((list) => {
      if (!cancelled) setAdapters(list);
    });
    const unsub = window.nexus.adapters.onChanged((list) => {
      setAdapters(list);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const onSplit = (direction: 'row' | 'column') => {
    if (focusedPaneId) split(focusedPaneId, direction);
  };

  const installedAdapters = adapters.filter((a) => a.installed);

  function openPicker() {
    const first = installedAdapters[0] ?? null;
    setSelectedAdapter(first);
    setSelectedModel(first?.models.default ?? '');
    setPickerOpen(true);
  }

  function closePicker() {
    setPickerOpen(false);
  }

  function confirmSpawn() {
    if (!selectedAdapter) return;
    spawnAgent(selectedAdapter.id, selectedModel || selectedAdapter.models.default);
    closePicker();
  }

  function handleAdapterChange(id: string) {
    const a = installedAdapters.find((x) => x.id === id) ?? null;
    setSelectedAdapter(a);
    setSelectedModel(a?.models.default ?? '');
  }

  return (
    <header className="workspace-bar">
      <div className="workspace-bar__brand">
        <span className="workspace-bar__logo">◈</span>
        {workspace ? (
          <>
            <span className="workspace-bar__name" title={workspace.path}>
              {workspace.name}
            </span>
            <button
              className="workspace-bar__ws-btn"
              onClick={openNewWorkspace}
              title="Abrir/criar outro workspace"
            >
              ＋ novo
            </button>
            <button
              className="workspace-bar__ws-btn workspace-bar__ws-btn--close"
              onClick={askCloseWorkspace}
              title="Fechar este workspace"
            >
              ✕ fechar
            </button>
          </>
        ) : (
          <span className="workspace-bar__name">NexusIDE</span>
        )}
      </div>
      <div className="workspace-bar__actions">
        {activeTodo && (
          <span className="workspace-bar__todo" title="Current orchestration task">
            ▸ {activeTodo}
          </span>
        )}
        <button
          className="workspace-bar__btn workspace-bar__btn--agent"
          onClick={openWizard}
          title="Nova missão (livre ou squad)"
        >
          ＋ Missão
        </button>
        <span className="workspace-bar__count">
          {paneCount} pane{paneCount === 1 ? '' : 's'}
        </span>
        {viewKind === 'grid' && (
          <>
            <button className="workspace-bar__btn" onClick={() => onSplit('row')}>
              Split →
            </button>
            <button className="workspace-bar__btn" onClick={() => onSplit('column')}>
              Split ↓
            </button>
          </>
        )}
        <button
          className={`workspace-bar__btn workspace-bar__btn--view ${viewKind === 'canvas' ? 'workspace-bar__btn--view-active' : ''}`}
          onClick={toggleView}
          title={viewKind === 'grid' ? 'Switch to canvas (free drag)' : 'Switch to grid (split panes)'}
        >
          {viewLabel(viewKind)}
        </button>
        <button
          className={`workspace-bar__btn ${filesOpen ? 'workspace-bar__btn--view-active' : ''}`}
          onClick={toggleFiles}
          title="Arquivos do workspace (ver/editar)"
        >
          🗂 Files
        </button>
        <button
          className={`workspace-bar__btn ${orchPanelOpen ? 'workspace-bar__btn--view-active' : ''}`}
          onClick={toggleOrchPanel}
          title="Missions, handoffs, todos and squads"
        >
          ⛭ Orch
        </button>
        <button
          className="workspace-bar__btn"
          onClick={toggleSettings}
          title="Módulos e catálogo (terminal, voz, providers, marketplace…)"
        >
          ⚙ Configurações
        </button>
        <VoiceButton />
        <button
          className="workspace-bar__btn workspace-bar__btn--agent"
          onClick={openPicker}
          title="Launch an AI CLI agent in a new pane"
        >
          + Agent
        </button>
      </div>

      {pickerOpen && (
        <div className="agent-picker" role="dialog" aria-label="Launch agent">
          <div className="agent-picker__overlay" onClick={closePicker} />
          <div className="agent-picker__panel">
            <h3 className="agent-picker__title">Launch Agent</h3>

            {installedAdapters.length === 0 ? (
              <p className="agent-picker__empty">
                No CLI adapters found. Install one to get started.
                {adapters.length > 0 && (
                  <span>
                    {' '}Try: <code>{adapters[0].installCommand}</code>
                  </span>
                )}
              </p>
            ) : (
              <>
                <label className="agent-picker__label">
                  Adapter
                  <select
                    className="agent-picker__select"
                    value={selectedAdapter?.id ?? ''}
                    onChange={(e) => handleAdapterChange(e.target.value)}
                  >
                    {installedAdapters.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.icon} {a.label}
                      </option>
                    ))}
                  </select>
                </label>

                {selectedAdapter && selectedAdapter.models.list.length > 0 && (
                  <label className="agent-picker__label">
                    Model
                    <select
                      className="agent-picker__select"
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                    >
                      {selectedAdapter.models.list.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {selectedAdapter?.loginHint && (
                  <p className="agent-picker__hint">{selectedAdapter.loginHint}</p>
                )}

                <div className="agent-picker__actions">
                  <button className="agent-picker__btn" onClick={closePicker}>
                    Cancel
                  </button>
                  <button
                    className="agent-picker__btn agent-picker__btn--primary"
                    onClick={confirmSpawn}
                    disabled={!selectedAdapter}
                  >
                    Launch
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

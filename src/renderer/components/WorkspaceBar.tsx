import { useEffect, useState } from 'react';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useSettingsStore } from '../state/settings-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useCloseWorkspaceStore } from './CloseWorkspaceDialog';
import { useFilesStore } from '../state/files-store';
import { CostSummary } from './CostBadge';
import { OperatorHud } from './OperatorHud';
import { listPanes } from '../lib/split-tree';
import { VoiceButton } from './VoiceButton';
import { VisionIndicator } from './VisionIndicator';
import { NexusMark } from './NexusMark';
import { PixelIcon } from './PixelIcon';
import { UpdateModal, UpdateStatusButton, useUpdateState } from './UpdateModal';
import type { AdapterInfo } from '../../shared/types';
import { setBrowserPaneSuppression } from '../browser/browser-host';

function adapterModelLabel(adapter: AdapterInfo, model: string): string {
  const info = adapter.models.info?.[model];
  const tags = [
    info?.availability ?? null,
    info?.costTier && info.costTier !== 'unknown' ? `cost:${info.costTier}` : null,
  ].filter(Boolean);
  return tags.length > 0 ? `${model} (${tags.join(', ')})` : model;
}

/** Slim top chrome: brand, pane count, split shortcuts, view toggle, and the agent launcher. */
export function WorkspaceBar() {
  const root = useLayoutStore((s) => s.root);
  const viewKind = useLayoutStore((s) => s.viewKind);
  const spawnAgent = useLayoutStore((s) => s.spawnAgent);
  const addShellPane = useLayoutStore((s) => s.addShellPane);
  const addBrowserPane = useLayoutStore((s) => s.addBrowserPane);
  const toggleView = useLayoutStore((s) => s.toggleView);
  const paneCount = listPanes(root).length;

  const orchPanelOpen = useOrchStore((s) => s.panelOpen);
  const toggleOrchPanel = useOrchStore((s) => s.togglePanel);
  const opsBoardOpen = useOrchStore((s) => s.boardOpen);
  const toggleOpsBoard = useOrchStore((s) => s.toggleBoard);
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
  const updateState = useUpdateState();
  const [updateOpen, setUpdateOpen] = useState(false);
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

  useEffect(() => {
    setBrowserPaneSuppression('agent-picker', pickerOpen);
    return () => setBrowserPaneSuppression('agent-picker', false);
  }, [pickerOpen]);

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
        <NexusMark size={15} className="workspace-bar__logo" />
        {workspace ? (
          <>
            <span className="workspace-bar__name" title={workspace.path}>
              {workspace.name}
            </span>
            <button
              className="workspace-bar__ws-btn"
              onClick={openNewWorkspace}
              title="Abrir/criar outro workspace"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
            >
              <PixelIcon name="plus" size={10} /> novo
            </button>
            <button
              className="workspace-bar__ws-btn workspace-bar__ws-btn--close"
              onClick={askCloseWorkspace}
              title="Fechar este workspace"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
            >
              <PixelIcon name="close" size={10} /> fechar
            </button>
            <button
              className={`workspace-bar__ws-btn workspace-bar__ws-btn--board ${opsBoardOpen ? 'workspace-bar__ws-btn--active' : ''}`}
              onClick={toggleOpsBoard}
              title="Ops Board — pipeline de missões (⌘B)"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
            >
              <PixelIcon name="board" size={10} /> board
            </button>
          </>
        ) : (
          <span className="workspace-bar__name">NexusIDE</span>
        )}
      </div>
      <div className="workspace-bar__actions">
        <div className="workspace-bar__actions-pinned">
          <OperatorHud />
          <CostSummary />
          {activeTodo && (
            <span
              className="workspace-bar__todo"
              title="Current orchestration task"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <PixelIcon name="mission" size={10} /> {activeTodo}
            </span>
          )}
        </div>
        <div className="workspace-bar__actions-scroll">
          <button
            className="workspace-bar__btn workspace-bar__btn--primary"
            onClick={openWizard}
            title="Nova missão (livre ou squad)"
          >
            <PixelIcon name="mission" />
            Missão
          </button>
          <button
            className="workspace-bar__btn workspace-bar__btn--agent"
            onClick={openPicker}
            title="Abrir um agente de IA em um pane novo"
          >
            <PixelIcon name="agent" />
            Agent
          </button>
          <button
            className="workspace-bar__btn"
            onClick={addShellPane}
            title={`Abrir um terminal shell novo (${paneCount} pane${paneCount === 1 ? '' : 's'} aberto${paneCount === 1 ? '' : 's'} · ⌘D divide o pane focado)`}
          >
            <PixelIcon name="terminal" />
            Terminal
          </button>
          <button
            className="workspace-bar__btn"
            onClick={() => addBrowserPane()}
            title="Abrir um browser embutido em um pane novo"
          >
            <PixelIcon name="browser" />
            Browser
          </button>
          <span className="workspace-bar__sep" aria-hidden="true" />
          <button
            className={`workspace-bar__btn workspace-bar__btn--view ${viewKind === 'canvas' ? 'workspace-bar__btn--view-active' : ''}`}
            onClick={toggleView}
            title={viewKind === 'grid' ? 'Mudar para canvas (arrastar livre)' : 'Mudar para grid (panes divididos)'}
          >
            <PixelIcon name={viewKind === 'canvas' ? 'grid' : 'canvas'} />
            {viewKind === 'canvas' ? 'Grid' : 'Canvas'}
          </button>
          <button
            className={`workspace-bar__btn ${filesOpen ? 'workspace-bar__btn--view-active' : ''}`}
            onClick={toggleFiles}
            title="Arquivos do workspace (ver/editar)"
          >
            <PixelIcon name="files" />
            Files
          </button>
          <button
            className={`workspace-bar__btn ${opsBoardOpen ? 'workspace-bar__btn--view-active' : ''}`}
            onClick={toggleOpsBoard}
            title="Ops Board — pipeline de missões (⌘B)"
          >
            <PixelIcon name="board" />
            Board
          </button>
          <button
            className={`workspace-bar__btn ${orchPanelOpen ? 'workspace-bar__btn--view-active' : ''}`}
            onClick={toggleOrchPanel}
            title="Missões, handoffs, todos e squads"
          >
            <PixelIcon name="orch" />
            Orch
          </button>
          <span className="workspace-bar__sep" aria-hidden="true" />
          <VoiceButton />
          <VisionIndicator />
          {updateState && (
            <UpdateStatusButton
              state={updateState}
              alwaysVisible
              onClick={() => setUpdateOpen(true)}
            />
          )}
          <button
            className="workspace-bar__btn"
            onClick={() => {
              setUpdateOpen(false);
              toggleSettings();
            }}
            title="Conta, plano, módulos e catálogo (⌘,)"
          >
            <PixelIcon name="config" />
            Config
          </button>
        </div>
      </div>

      {updateOpen && updateState && (
        <UpdateModal state={updateState} onClose={() => setUpdateOpen(false)} />
      )}

      {pickerOpen && (
        <div className="agent-picker" role="dialog" aria-label="Abrir agente">
          <div className="agent-picker__overlay" onClick={closePicker} />
          <div className="agent-picker__panel">
            <h3 className="agent-picker__title">Abrir agente</h3>

            {installedAdapters.length === 0 ? (
              <p className="agent-picker__empty">
                Nenhuma CLI encontrada. Instale uma para começar.
                {adapters.length > 0 && (
                  <span>
                    {' '}Tente: <code>{adapters[0].installCommand}</code>
                  </span>
                )}
              </p>
            ) : (
              <>
                <label className="agent-picker__label">
                  Adaptador
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
                    Modelo
                    <select
                      className="agent-picker__select"
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                    >
                      {selectedAdapter.models.list.map((m) => (
                        <option key={m} value={m}>
                          {adapterModelLabel(selectedAdapter, m)}
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
                    Cancelar
                  </button>
                  <button
                    className="agent-picker__btn agent-picker__btn--primary"
                    onClick={confirmSpawn}
                    disabled={!selectedAdapter}
                  >
                    Abrir
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

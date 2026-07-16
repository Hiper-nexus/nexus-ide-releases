import { useEffect, useMemo, useRef, useState } from 'react';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useSettingsStore } from '../state/settings-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useCloseWorkspaceStore } from './CloseWorkspaceDialog';
import { useFilesStore } from '../state/files-store';
import { CostSummary } from './CostBadge';
import { QuotaChip } from './QuotaChip';
import { listPanes } from '../lib/split-tree';
import { VoiceButton } from './VoiceButton';
import { VisionIndicator } from './VisionIndicator';
import { NexusMark } from './NexusMark';
import { ProviderLogo } from './ProviderLogo';
import { PixelIcon, type PixelIconName } from './PixelIcon';
import { ActionCard, EmptyState } from './ActionCard';
import { EndorphinPresence } from './EndorphinPresence';
import { UpdateModal, UpdateStatusButton, useUpdateState } from './UpdateModal';
import type { AdapterInfo } from '../../shared/types';
import { agentPickerEmptyBeat } from '../../shared/endorphin';
import { setBrowserPaneSuppression } from '../browser/browser-host';
import { AccountSwitcher } from './AccountSwitcher';
import { useAccountStore } from '../state/account-store';
import {
  restartPanesForPendingAccount,
} from '../orch/account-restart-controller';
import { confirmAndReopenMission } from '../orch/confirm-reopen-mission';
import { statusLabel } from '../lib/mission-rail-groups';
import { FleetChip } from './FleetChip';
import {
  clearEphemeralDraft,
  peekEphemeralDraft,
  saveEphemeralDraft,
} from '../state/ephemeral-draft-store';

const AGENT_PICKER_EMPTY = agentPickerEmptyBeat();

function adapterModelLabel(adapter: AdapterInfo, model: string): string {
  const info = adapter.models.info?.[model];
  const tags = [
    info?.availability ?? null,
    info?.costTier && info.costTier !== 'unknown' ? `cost:${info.costTier}` : null,
  ].filter(Boolean);
  return tags.length > 0 ? `${model} (${tags.join(', ')})` : model;
}

type BarDensity = 'full' | 'icons' | 'compact';

function densityFromWidth(width: number): BarDensity {
  // Thresholds um pouco mais cedo: labels longos em PT não devem empurrar
  // botões uns sobre os outros nem sobrepor o brand.
  if (width < 1080) return 'compact';
  if (width < 1380) return 'icons';
  return 'full';
}

function useBarDensity(): BarDensity {
  const [density, setDensity] = useState<BarDensity>(() =>
    typeof window === 'undefined' ? 'full' : densityFromWidth(window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setDensity(densityFromWidth(window.innerWidth));
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return density;
}

interface ToolDef {
  id: string;
  label: string;
  icon: PixelIconName;
  title: string;
  active?: boolean;
  onClick: () => void;
}

/** Slim top chrome: brand, status, primary actions, overflow tools, system zone. */
export function WorkspaceBar({
  onOpenDiff,
  onOpenIntegrations,
}: {
  onOpenDiff?: () => void;
  onOpenIntegrations?: () => void;
} = {}) {
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
  const missions = useOrchStore((s) => s.missions);
  const boundWorkspacePath = useOrchStore((s) => s.boundWorkspacePath);
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

  const density = useBarDensity();
  const showLabels = density === 'full';
  const compact = density === 'compact';
  const restartAdapterId = useAccountStore((s) => s.restartAdapterId);

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const updateState = useUpdateState();
  const [updateOpen, setUpdateOpen] = useState(false);
  const [selectedAdapter, setSelectedAdapter] = useState<AdapterInfo | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [missionMenuOpen, setMissionMenuOpen] = useState(false);
  const [missionBusy, setMissionBusy] = useState(false);
  const wsMenuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const missionMenuRef = useRef<HTMLDivElement>(null);

  const localMissions = useMemo(() => {
    if (!workspace?.path || boundWorkspacePath !== workspace.path) return [];
    return [...missions].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [boundWorkspacePath, missions, workspace?.path]);

  const quickMissions = useMemo(
    () =>
      localMissions
        .filter((m) => m.status === 'running' || m.status === 'blocked' || m.status === 'pending')
        .slice(0, 8),
    [localMissions],
  );

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

  useEffect(() => {
    if (!wsMenuOpen && !moreOpen && !missionMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wsMenuOpen && wsMenuRef.current && !wsMenuRef.current.contains(t)) {
        setWsMenuOpen(false);
      }
      if (moreOpen && moreRef.current && !moreRef.current.contains(t)) {
        setMoreOpen(false);
      }
      if (
        missionMenuOpen &&
        missionMenuRef.current &&
        !missionMenuRef.current.contains(t)
      ) {
        setMissionMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setWsMenuOpen(false);
        setMoreOpen(false);
        setMissionMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [wsMenuOpen, moreOpen, missionMenuOpen]);

  const installedAdapters = adapters.filter((a) => a.installed);

  function openPicker() {
    const draft = peekEphemeralDraft<{ adapterId: string; model: string }>(
      'agent-picker',
    );
    const fromDraft = draft
      ? installedAdapters.find((a) => a.id === draft.adapterId) ?? null
      : null;
    const first = fromDraft ?? installedAdapters[0] ?? null;
    setSelectedAdapter(first);
    setSelectedModel(
      fromDraft && draft
        ? draft.model || first?.models.default || ''
        : first?.models.default ?? '',
    );
    setPickerOpen(true);
  }

  /** Soft-close: keep adapter/model selection for the next open. */
  function softClosePicker() {
    if (selectedAdapter) {
      saveEphemeralDraft('agent-picker', {
        adapterId: selectedAdapter.id,
        model: selectedModel,
      });
    }
    setPickerOpen(false);
  }

  /** Explicit cancel discards the selection draft. */
  function discardClosePicker() {
    clearEphemeralDraft('agent-picker');
    setPickerOpen(false);
  }

  function confirmSpawn() {
    if (!selectedAdapter) return;
    spawnAgent(selectedAdapter.id, selectedModel || selectedAdapter.models.default);
    clearEphemeralDraft('agent-picker');
    setPickerOpen(false);
  }

  function handleAdapterChange(id: string) {
    const a = installedAdapters.find((x) => x.id === id) ?? null;
    setSelectedAdapter(a);
    setSelectedModel(a?.models.default ?? '');
  }

  const secondaryTools: ToolDef[] = [
    {
      id: 'terminal',
      label: 'Terminal',
      icon: 'terminal',
      title: `Abrir um terminal shell novo (${paneCount} pane${paneCount === 1 ? '' : 's'} aberto${paneCount === 1 ? '' : 's'} · ⌘D divide o pane focado)`,
      onClick: addShellPane,
    },
    {
      id: 'browser',
      label: 'Navegador',
      icon: 'browser',
      title: 'Abrir um navegador embutido em um painel novo',
      onClick: () => addBrowserPane(),
    },
    {
      id: 'view',
      label: viewKind === 'canvas' ? 'Grade' : 'Canvas',
      icon: viewKind === 'canvas' ? 'grid' : 'canvas',
      title:
        viewKind === 'grid'
          ? 'Mudar para Canvas (arrastar painéis livremente)'
          : 'Mudar para Grade (painéis divididos)',
      active: viewKind === 'canvas',
      onClick: toggleView,
    },
    {
      id: 'files',
      label: 'Arquivos',
      icon: 'files',
      title: 'Arquivos do workspace (ver/editar)',
      active: filesOpen,
      onClick: toggleFiles,
    },
    {
      id: 'board',
      label: 'Painel',
      icon: 'board',
      title: 'Painel de operações — pipeline de missões (⌘B)',
      active: opsBoardOpen,
      onClick: toggleOpsBoard,
    },
    {
      id: 'orch',
      label: 'Equipe',
      icon: 'orch',
      title: 'Missões, handoffs, tarefas e squads',
      active: orchPanelOpen,
      onClick: toggleOrchPanel,
    },
  ];

  // Dieta da bar (critique P1): só Terminal fica inline; todo o resto mora no
  // ⋯ em TODAS as densidades — e a 1 tecla via ⌘K. Cada control visível
  // precisa merecer o lugar.
  if (onOpenDiff) {
    secondaryTools.push({
      id: 'diff',
      label: 'Diff',
      icon: 'files',
      title: 'Ver diferenças e anotar para o agente',
      onClick: onOpenDiff,
    });
  }
  if (onOpenIntegrations) {
    secondaryTools.push({
      id: 'apps',
      label: 'GitHub e integrações',
      icon: 'bolt',
      title: 'GitHub (PRs, issues), Linear e port forward — também no ⌘K',
      onClick: onOpenIntegrations,
    });
  }
  const inlineTools = secondaryTools.filter((t) => t.id === 'terminal');
  const overflowTools = secondaryTools.filter((t) => t.id !== 'terminal');

  function renderToolBtn(tool: ToolDef, opts?: { menu?: boolean }) {
    if (opts?.menu) {
      return (
        <button
          key={tool.id}
          type="button"
          className={`workspace-bar__menu-item ${tool.active ? 'workspace-bar__menu-item--active' : ''}`}
          title={tool.title}
          onClick={() => {
            tool.onClick();
            setMoreOpen(false);
          }}
        >
          <PixelIcon name={tool.icon} size={12} />
          <span>{tool.label}</span>
        </button>
      );
    }
    return (
      <button
        key={tool.id}
        type="button"
        className={`workspace-bar__btn ${tool.active ? 'workspace-bar__btn--view-active' : ''} ${tool.id === 'view' ? 'workspace-bar__btn--view' : ''}`}
        onClick={tool.onClick}
        title={tool.title}
        aria-label={tool.title}
      >
        <PixelIcon name={tool.icon} />
        {showLabels && <span className="workspace-bar__btn-label">{tool.label}</span>}
      </button>
    );
  }

  return (
    <header
      className={`workspace-bar workspace-bar--${density}`}
      data-density={density}
    >
      {/* Brand: logo + name + workspace menu (novo/fechar) — no Board duplicate */}
      <div className="workspace-bar__brand">
        <NexusMark size={15} className="workspace-bar__logo" />
        {workspace ? (
          <>
            <div className="workspace-bar__ws" ref={wsMenuRef}>
              <button
                type="button"
                className="workspace-bar__name-btn"
                title={workspace.path}
                aria-haspopup="menu"
                aria-expanded={wsMenuOpen}
                onClick={() => {
                  setWsMenuOpen((o) => !o);
                  setMoreOpen(false);
                }}
              >
                <span className="workspace-bar__name">{workspace.name}</span>
                <span className="workspace-bar__name-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {wsMenuOpen && (
                <div className="workspace-bar__menu" role="menu">
                  <button
                    type="button"
                    className="workspace-bar__menu-item"
                    role="menuitem"
                    onClick={() => {
                      openNewWorkspace();
                      setWsMenuOpen(false);
                    }}
                  >
                    <PixelIcon name="plus" size={12} />
                    <span>Novo workspace</span>
                  </button>
                  <button
                    type="button"
                    className="workspace-bar__menu-item"
                    role="menuitem"
                    onClick={() => {
                      askCloseWorkspace();
                      setWsMenuOpen(false);
                    }}
                  >
                    <PixelIcon name="close" size={12} />
                    <span>Fechar workspace</span>
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="workspace-bar__new-workspace"
              title="Criar e abrir um novo workspace"
              aria-label="Novo workspace"
              onClick={openNewWorkspace}
            >
              <PixelIcon name="plus" size={12} />
              <span>Novo workspace</span>
            </button>
          </>
        ) : (
          <span className="workspace-bar__name">NexusIDE</span>
        )}
      </div>

      <div className="workspace-bar__actions">
        {/* Status: frota + cost (capped width). O OperatorHud (XP) mora no
            rail — a zona de status da bar é só sinal operacional. */}
        <div className="workspace-bar__zone workspace-bar__zone--status">
          <FleetChip />
          <QuotaChip />
          {!compact && <CostSummary />}
          {activeTodo && !compact && (
            <span
              className="workspace-bar__todo"
              title="Tarefa de orquestração atual"
            >
              <PixelIcon name="mission" size={10} />
              <span className="workspace-bar__todo-text">{activeTodo}</span>
            </span>
          )}
        </div>

        {/* Primary: always visible — Nova missão + seletor local desta pasta */}
        <div className="workspace-bar__zone workspace-bar__zone--primary">
          <button
            className="workspace-bar__btn workspace-bar__btn--primary"
            onClick={openWizard}
            title="Nova missão neste workspace (⌘N)"
            aria-label="Nova missão neste workspace"
          >
            <PixelIcon name="plus" />
            <span className="workspace-bar__btn-label">
              {compact ? 'Nova' : 'Nova missão'}
            </span>
          </button>
          <div className="workspace-bar__mission-menu" ref={missionMenuRef}>
            <button
              type="button"
              className={`workspace-bar__btn workspace-bar__btn--missions ${
                missionMenuOpen ? 'workspace-bar__btn--view-active' : ''
              }`}
              title={
                workspace
                  ? `Missões de ${workspace.name} — abrir ou retomar`
                  : 'Missões do workspace'
              }
              aria-label="Lista de missões deste workspace"
              aria-haspopup="menu"
              aria-expanded={missionMenuOpen}
              onClick={() => {
                setMissionMenuOpen((o) => !o);
                setMoreOpen(false);
                setWsMenuOpen(false);
              }}
            >
              <PixelIcon name="mission" />
              {!compact && (
                <span className="workspace-bar__btn-label">
                  Missões
                  {localMissions.length > 0 ? ` (${localMissions.length})` : ''}
                </span>
              )}
              {compact && localMissions.length > 0 && (
                <span className="workspace-bar__mission-count">
                  {localMissions.length}
                </span>
              )}
            </button>
            {missionMenuOpen && (
              <div
                className="workspace-bar__menu workspace-bar__menu--missions"
                role="menu"
              >
                <div className="workspace-bar__menu-heading">
                  {workspace ? workspace.name : 'Workspace'}
                  <span className="workspace-bar__menu-heading-meta">
                    só esta pasta
                  </span>
                </div>
                <button
                  type="button"
                  className="workspace-bar__menu-item workspace-bar__menu-item--accent"
                  role="menuitem"
                  onClick={() => {
                    openWizard();
                    setMissionMenuOpen(false);
                  }}
                >
                  <PixelIcon name="plus" size={12} />
                  <span>Nova missão</span>
                </button>
                {quickMissions.length === 0 ? (
                  <p className="workspace-bar__menu-empty">
                    Nenhuma missão ativa aqui.
                  </p>
                ) : (
                  quickMissions.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="workspace-bar__menu-item"
                      role="menuitem"
                      disabled={missionBusy}
                      title={m.title}
                      onClick={() => {
                        setMissionBusy(true);
                        void confirmAndReopenMission(m)
                          .catch(() => undefined)
                          .finally(() => {
                            setMissionBusy(false);
                            setMissionMenuOpen(false);
                          });
                      }}
                    >
                      <PixelIcon name="mission" size={12} />
                      <span className="workspace-bar__menu-mission">
                        <span className="workspace-bar__menu-mission-title">
                          {m.title}
                        </span>
                        <span className="workspace-bar__menu-mission-meta">
                          {statusLabel(m.status)}
                        </span>
                      </span>
                    </button>
                  ))
                )}
                <div className="workspace-bar__menu-sep" />
                <button
                  type="button"
                  className="workspace-bar__menu-item"
                  role="menuitem"
                  onClick={() => {
                    toggleOpsBoard();
                    setMissionMenuOpen(false);
                  }}
                >
                  <PixelIcon name="board" size={12} />
                  <span>Painel de operações</span>
                </button>
              </div>
            )}
          </div>
          <button
            className="workspace-bar__btn workspace-bar__btn--agent"
            onClick={openPicker}
            title="Abrir um agente de IA em um painel novo"
            aria-label="Abrir agente"
          >
            <PixelIcon name="agent" />
            {showLabels && <span className="workspace-bar__btn-label">Agente</span>}
          </button>
        </div>

        <span className="workspace-bar__sep" aria-hidden="true" />

        {/* Secondary tools + overflow */}
        <div className="workspace-bar__zone workspace-bar__zone--tools">
          {inlineTools.map((tool) => renderToolBtn(tool))}
          {overflowTools.length > 0 && (
            <div className="workspace-bar__more" ref={moreRef}>
              <button
                type="button"
                className={`workspace-bar__btn workspace-bar__btn--more ${moreOpen ? 'workspace-bar__btn--view-active' : ''}`}
                title="Mais ferramentas"
                aria-label="Mais ferramentas"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => {
                  setMoreOpen((o) => !o);
                  setWsMenuOpen(false);
                }}
              >
                ⋯
              </button>
              {moreOpen && (
                <div className="workspace-bar__menu workspace-bar__menu--end" role="menu">
                  {overflowTools.map((tool) => renderToolBtn(tool, { menu: true }))}
                  {compact && (
                    <>
                      <div className="workspace-bar__menu-sep" />
                      <button
                        type="button"
                        className="workspace-bar__menu-item"
                        role="menuitem"
                        onClick={() => {
                          setUpdateOpen(true);
                          setMoreOpen(false);
                        }}
                      >
                        <PixelIcon name="update" size={12} />
                        <span>Atualizações</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <span className="workspace-bar__sep" aria-hidden="true" />

        {/* System: always visible — voice, vision, update, config */}
        <div className="workspace-bar__zone workspace-bar__zone--system">
          <VoiceButton />
          <VisionIndicator />
          {!compact && (
            <div className="workspace-bar__account-zone" title="Hot-swap de contas CLI">
              <AccountSwitcher compact />
              {restartAdapterId && (
                <button
                  type="button"
                  className="workspace-bar__account-restart"
                  title={`Reiniciar panes ${restartAdapterId} após troca de conta`}
                  aria-label={`Reiniciar panes ${restartAdapterId} após troca de conta`}
                  onClick={() => restartPanesForPendingAccount()}
                >
                  <PixelIcon name="restart" size={12} />
                </button>
              )}
            </div>
          )}
          {updateState && !compact && (
            <UpdateStatusButton
              state={updateState}
              alwaysVisible
              compact={density !== 'full'}
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
            aria-label="Configurações"
          >
            <PixelIcon name="config" />
            {showLabels && <span className="workspace-bar__btn-label">Config</span>}
          </button>
        </div>
      </div>

      {updateOpen && updateState && (
        <UpdateModal state={updateState} onClose={() => setUpdateOpen(false)} />
      )}

      {pickerOpen && (
        <div className="agent-picker" role="dialog" aria-label="Abrir agente">
          <div className="agent-picker__overlay" onClick={softClosePicker} />
          <div className="agent-picker__panel">
            <h3 className="agent-picker__title">Abrir agente</h3>

            {installedAdapters.length === 0 ? (
              <EmptyState
                className="agent-picker__empty agent-picker__empty--story"
                icon="key"
                title={AGENT_PICKER_EMPTY.title}
                body={
                  <>
                    <EndorphinPresence
                      kicker={AGENT_PICKER_EMPTY.kicker}
                      mood="idle"
                      size={44}
                      className="endorphin-presence--row agent-picker__empty-presence"
                    />
                    <p>{AGENT_PICKER_EMPTY.line}</p>
                    {adapters.length > 0 && (
                      <p>
                        Ex.: <code>{adapters[0].installCommand}</code>
                      </p>
                    )}
                  </>
                }
                action={
                  <ActionCard
                    icon="key"
                    title="Abrir Providers"
                    subtitle="chaves · CLIs"
                    variant="primary"
                    onClick={() => {
                      softClosePicker();
                      useSettingsStore.getState().openDrawer('providers');
                    }}
                  />
                }
              />
            ) : (
              <>
                <label className="agent-picker__label">
                  Adaptador
                  <span className="agent-picker__select-row">
                    {selectedAdapter && (
                      <ProviderLogo
                        adapterId={selectedAdapter.id}
                        label={selectedAdapter.label}
                        fallback={selectedAdapter.icon}
                        size="sm"
                      />
                    )}
                    <select
                      className="agent-picker__select"
                      value={selectedAdapter?.id ?? ''}
                      onChange={(e) => handleAdapterChange(e.target.value)}
                    >
                      {installedAdapters.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </span>
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
                  <button className="agent-picker__btn" onClick={discardClosePicker}>
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

import { useEffect, useMemo, useState } from 'react';
import type {
  MissionLifecycleState,
  MissionStateReason,
} from '../../../shared/mission-engine-contract';
import {
  MISSION_LIFECYCLE_LABELS,
  MISSION_RUNNING_ATTENTION_LABEL,
  missionLifecycleLabel,
} from '../../lib/mission-lifecycle-copy';
import { missionChromeTitle } from '../../../shared/mission-identity';
import { listPanes } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { useOrchStore } from '../../state/orch-store';
import { useSessionStateStore } from '../../state/session-state-store';
import { useGitScmStore } from '../../state/git-scm-store';
import { useQuotaStore } from '../../state/quota-store';
import { useAdapterStore } from '../../state/adapter-store';
import { prioritizeReportedQuotas, shortWindowsLine } from '../../lib/quota-display';
import { ProviderLogo } from '../ProviderLogo';
import { useTerminalGridDialogStore } from '../../state/terminal-grid-dialog-store';
import { useCommandPaletteStore } from '../../state/command-palette-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { WorkspaceCleanup } from './WorkspaceCleanup';
import { NexusMark } from '../NexusMark';
import { PixelIcon, type PixelIconName } from '../PixelIcon';

export interface WorkspaceRailMission {
  id: string;
  title: string;
  status: MissionLifecycleState;
  needsAttention: boolean;
  stateReason?: Pick<MissionStateReason, 'code' | 'label'>;
  /** Entrega pronta para revisar; o aceite humano continua pendente. */
  awaitsOperatorReview?: boolean;
}

export interface WorkspaceRailWorkspace {
  id: string;
  name: string;
  missions: readonly WorkspaceRailMission[];
}

export type WorkspaceRailSelection =
  | { kind: 'launcher' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'mission'; missionId: string }
  | { kind: 'terminals' }
  | { kind: 'project' }
  | { kind: 'task-board' }
  | { kind: 'memory' }
  | { kind: 'settings' }
  | null;

export interface WorkspaceRailProps {
  activeWorkspaces: readonly WorkspaceRailWorkspace[];
  recentWorkspaces: readonly WorkspaceRailWorkspace[];
  selection: WorkspaceRailSelection;
  onCreateNew: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  /**
   * workspaceId presente quando a missão mora num workspace vizinho: o
   * chamador troca de workspace antes de navegar (rail multi-workspace).
   */
  onSelectMission: (missionId: string, workspaceId?: string) => void;
  onRemoveWorkspace?: (workspaceId: string) => void;
  onRemoveMission?: (missionId: string, workspaceId: string) => void;
  projectEnabled?: boolean;
  onOpenProject?: () => void;
  onOpenTaskBoard: () => void;
  onOpenMemory: () => void;
  onOpenSettings: () => void;
  onOpenUsageQuota?: () => void;
  /** Destino explícito do grid. Não é o nome do workspace. */
  onOpenTerminals: () => void;
  /**
   * Volta ao Início. Sem isto, quem clica em Quadro ou Memória perde para
   * sempre a tela que responde "o que você quer fazer agora?" — e o único
   * botão de abrir pasta da interface.
   */
  onOpenLauncher?: () => void;
  /**
   * Workspace aberto agora. A lixeira dele NÃO remove dos recentes: o main
   * desvia para o diálogo de fechar projeto (App.tsx), que encerra todas as
   * sessões. O rótulo precisa prometer o que de fato acontece.
   */
  currentWorkspaceId?: string;
  /** Quantos itens esperam a pessoa. Zero esconde a linha por completo. */
  attentionCount?: number;
  onOpenAttention?: () => void;
}

type MissionStatusTone =
  | 'running'
  | 'ready'
  | 'blocked'
  | 'failed'
  | 'pending'
  | 'done';

interface MissionStatusDisplay {
  label: string;
  icon: PixelIconName;
  tone: MissionStatusTone;
}

const MISSION_STATUS: Record<MissionLifecycleState, MissionStatusDisplay> = {
  draft: { label: MISSION_LIFECYCLE_LABELS.draft, icon: 'file', tone: 'pending' },
  review_ready: {
    label: MISSION_LIFECYCLE_LABELS.review_ready,
    icon: 'status-idle',
    tone: 'ready',
  },
  starting: {
    label: MISSION_LIFECYCLE_LABELS.starting,
    icon: 'status-spawning',
    tone: 'pending',
  },
  running: {
    label: MISSION_LIFECYCLE_LABELS.running,
    icon: 'status-busy',
    tone: 'running',
  },
  blocked_user: {
    label: MISSION_LIFECYCLE_LABELS.blocked_user,
    icon: 'user',
    tone: 'blocked',
  },
  blocked_technical: {
    label: MISSION_LIFECYCLE_LABELS.blocked_technical,
    icon: 'warn',
    tone: 'blocked',
  },
  recovering: {
    label: MISSION_LIFECYCLE_LABELS.recovering,
    icon: 'restart',
    tone: 'running',
  },
  stopping: {
    label: MISSION_LIFECYCLE_LABELS.stopping,
    icon: 'stop',
    tone: 'pending',
  },
  failed: {
    label: MISSION_LIFECYCLE_LABELS.failed,
    icon: 'status-exited',
    tone: 'failed',
  },
  completed: {
    label: MISSION_LIFECYCLE_LABELS.completed,
    icon: 'check',
    tone: 'done',
  },
};

const RUNNING_WARNING_STATUS: MissionStatusDisplay = {
  label: MISSION_RUNNING_ATTENTION_LABEL,
  icon: 'warn',
  tone: 'blocked',
};

function missionStatusDisplay(
  state: MissionLifecycleState,
  needsAttention: boolean,
  stateReason?: Pick<MissionStateReason, 'code' | 'label'>,
  awaitsOperatorReview = false,
): MissionStatusDisplay {
  const label = missionLifecycleLabel(
    state,
    needsAttention,
    stateReason?.code,
    awaitsOperatorReview,
  );
  if (label === 'Dormindo' || label === 'Parou') {
    return {
      label,
      icon: label === 'Dormindo' ? 'status-idle' : 'stop',
      tone: 'blocked',
    };
  }
  return state === 'running' && needsAttention
    ? RUNNING_WARNING_STATUS
    : { ...MISSION_STATUS[state], label };
}

interface WorkspaceGroupProps {
  currentWorkspaceId?: string;
  label: string;
  group: 'active' | 'recent';
  workspaces: readonly WorkspaceRailWorkspace[];
  selection: WorkspaceRailSelection;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectMission: (missionId: string, workspaceId?: string) => void;
  onRemoveWorkspace?: (workspaceId: string) => void;
  onRemoveMission?: (missionId: string, workspaceId: string) => void;
}

function WorkspaceGroup({
  currentWorkspaceId,
  label,
  group,
  workspaces,
  selection,
  onSelectWorkspace,
  onSelectMission,
  onRemoveWorkspace,
  onRemoveMission,
}: WorkspaceGroupProps) {
  if (workspaces.length === 0) return null;
  const labelId = `workspace-rail-${group}-label`;

  const paneMissions = useOrchStore((s) => s.paneMissions);
  const root = useLayoutStore((s) => s.root);
  const paneStates = useSessionStateStore((s) => s.paneStates);
  const currentBranch = useGitScmStore((s) => s.branch);
  const adapters = useAdapterStore((s) => s.adapters);
  const allPanes = useMemo(() => listPanes(root), [root]);
  const adapterMetaById = useMemo(() => {
    const map = new Map<string, { label: string; icon: string }>();
    for (const adapter of adapters) {
      map.set(adapter.id, { label: adapter.label, icon: adapter.icon });
    }
    return map;
  }, [adapters]);
  // Estilo Orca: a missão selecionada já abre com os agentes visíveis.
  const selectedMissionId =
    selection?.kind === 'mission' ? selection.missionId : null;
  const [expandedMissions, setExpandedMissions] = useState<
    Record<string, boolean>
  >(() => (selectedMissionId ? { [selectedMissionId]: true } : {}));
  // O inicializador do useState roda uma vez: sem isto, navegar para outra
  // missão depois do mount nunca expandia os agentes dela.
  useEffect(() => {
    if (!selectedMissionId) return;
    setExpandedMissions((prev) =>
      prev[selectedMissionId] ? prev : { ...prev, [selectedMissionId]: true },
    );
  }, [selectedMissionId]);

  return (
    <section
      className="workspace-rail__group"
      data-rail-group={group}
      aria-labelledby={labelId}
    >
      <div className="workspace-rail__group-header">
        <span id={labelId} className="workspace-rail__group-title">
          {label}
        </span>
        <span className="workspace-rail__group-pill">
          {workspaces.reduce((acc, w) => acc + w.missions.length, 0)}
        </span>
      </div>
      <ul className="workspace-rail__workspace-list">
        {workspaces.map((workspace) => {
          const workspaceSelected =
            selection?.kind === 'workspace' &&
            selection.workspaceId === workspace.id;

          return (
            <li className="workspace-rail__workspace-item" key={workspace.id}>
              <div className="workspace-rail__workspace-row-wrapper">
                <button
                  type="button"
                  className={`workspace-rail__row workspace-rail__workspace${
                    workspaceSelected ? ' workspace-rail__row--selected' : ''
                  }`}
                  data-workspace-id={workspace.id}
                  aria-current={workspaceSelected ? 'page' : undefined}
                  aria-label={`Abrir workspace ${workspace.name}`}
                  title={workspace.name}
                  onClick={() => onSelectWorkspace(workspace.id)}
                >
                  <span className="workspace-rail__workspace-icon" aria-hidden>
                    <PixelIcon name="files" size={12} />
                  </span>
                  <span className="workspace-rail__row-label">
                    {workspace.name}
                  </span>
                </button>
                {onRemoveWorkspace ? (
                  <button
                    type="button"
                    className="workspace-rail__workspace-action"
                    data-action="remove-workspace"
                    data-workspace-id={workspace.id}
                    aria-label={
                      workspace.id === currentWorkspaceId
                        ? `Fechar o projeto ${workspace.name}`
                        : `Remover workspace ${workspace.name} dos recentes`
                    }
                    title={
                      workspace.id === currentWorkspaceId
                        ? `Fechar este projeto (encerra as sessões abertas)`
                        : `Remover ${workspace.name} dos recentes`
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveWorkspace(workspace.id);
                    }}
                  >
                    <PixelIcon name="trash" size={11} />
                  </button>
                ) : null}
              </div>

              {workspace.missions.length > 0 ? (
                <ul
                  className="workspace-rail__mission-list"
                  aria-label={`Missões em ${workspace.name}`}
                >
                  {workspace.missions.map((mission) => {
                    const status = missionStatusDisplay(
                      mission.status,
                      mission.needsAttention,
                      mission.stateReason,
                      mission.awaitsOperatorReview === true,
                    );
                    const missionSelected =
                      selection?.kind === 'mission' &&
                      selection.missionId === mission.id;
                    const chromeTitle = missionChromeTitle(mission.title);
                    const missionPanes = allPanes.filter(
                      (p) => (p.missionId ?? paneMissions[p.id]) === mission.id,
                    );
                    const isExpanded = expandedMissions[mission.id] ?? false;

                    return (
                      <li key={mission.id} className="workspace-rail__mission-card-item">
                        <div className="workspace-rail__mission-row">
                          <button
                            type="button"
                            className={`workspace-rail__row workspace-rail__mission workspace-rail__mission--${status.tone}${
                              missionSelected
                                ? ' workspace-rail__row--selected'
                                : ''
                            }`}
                            data-mission-id={mission.id}
                            data-mission-state={mission.status}
                            aria-current={missionSelected ? 'page' : undefined}
                            aria-label={`${chromeTitle}. ${status.label}`}
                            title={`${mission.title}: ${status.label}`}
                            onClick={() =>
                              onSelectMission(mission.id, workspace.id)
                            }
                          >
                            <div className="workspace-rail__mission-card-top">
                              <span
                                className="workspace-rail__mission-indicator"
                                aria-hidden="true"
                              >
                                <span className="workspace-rail__mission-dot" />
                                <PixelIcon name={status.icon} size={11} className="workspace-rail__mission-icon-fallback" />
                              </span>
                              <span className="workspace-rail__row-label">
                                {chromeTitle}
                              </span>
                            </div>
                            <span className="workspace-rail__mission-copy">
                              <span className="workspace-rail__mission-meta-line">
                                <span className="workspace-rail__mission-repo-chip" title={workspace.name}>
                                  <span className="workspace-rail__mission-repo-mark" aria-hidden="true" />
                                  <span className="workspace-rail__mission-repo-name">{workspace.name}</span>
                                </span>
                                {workspace.id === currentWorkspaceId && currentBranch ? (
                                  <span className="workspace-rail__mission-branch" title={currentBranch}>
                                    {currentBranch}
                                  </span>
                                ) : null}
                                <span className="workspace-rail__mission-status">
                                  {status.label}
                                </span>
                              </span>
                            </span>
                          </button>
                          {onRemoveMission ? (
                            <button
                              type="button"
                              className="workspace-rail__mission-remove"
                              data-action="remove-mission"
                              data-mission-id={mission.id}
                              aria-label={`Remover missão ${mission.title}`}
                              title={`Remover "${mission.title}" — apaga a missão e o histórico`}
                              onClick={(event) => {
                                event.stopPropagation();
                                onRemoveMission(mission.id, workspace.id);
                              }}
                            >
                              <PixelIcon name="trash" size={11} />
                            </button>
                          ) : null}
                        </div>

                        {missionPanes.length > 0 && (
                          <div className="workspace-rail__agents-block">
                            <button
                              type="button"
                              className="workspace-rail__agents-toggle"
                              aria-label={`${missionPanes.length} agentes nesta missão`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedMissions((prev) => ({
                                  ...prev,
                                  [mission.id]: !isExpanded,
                                }));
                              }}
                            >
                              <span className="workspace-rail__agents-pill">
                                <PixelIcon name="users" size={10} />
                                <span>
                                  {missionPanes.length}{' '}
                                  {missionPanes.length === 1 ? 'agente' : 'agentes'}
                                </span>
                              </span>
                              <span
                                className={`workspace-rail__agents-chevron${
                                  isExpanded
                                    ? ' workspace-rail__agents-chevron--open'
                                    : ''
                                }`}
                              >
                                <PixelIcon name="chevron-down" size={9} />
                              </span>
                            </button>
                            {isExpanded && (
                              <ul className="workspace-rail__agents-list">
                                {missionPanes.map((pane) => {
                                  const state = paneStates.get(pane.id) ?? 'idle';
                                  const adapterMeta = pane.adapterId
                                    ? adapterMetaById.get(pane.adapterId)
                                    : undefined;
                                  return (
                                    <li
                                      key={pane.id}
                                      className="workspace-rail__agent-item"
                                    >
                                      <button
                                        type="button"
                                        className="workspace-rail__agent-btn"
                                        title={`Focar ${pane.title || 'agente'}`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          useLayoutStore.getState().focus(pane.id);
                                          useProductNavigationStore.getState().openTerminal();
                                        }}
                                      >
                                        <span
                                          className={`workspace-rail__agent-dot workspace-rail__agent-dot--${state}`}
                                        />
                                        {pane.adapterId ? (
                                          <ProviderLogo
                                            adapterId={pane.adapterId}
                                            label={
                                              adapterMeta?.label ?? pane.adapterId
                                            }
                                            fallback={adapterMeta?.icon}
                                            size="xs"
                                          />
                                        ) : null}
                                        <span className="workspace-rail__agent-name">
                                          {pane.title || 'Agente'}
                                        </span>
                                        {pane.adapterId &&
                                        !adapterMeta ? (
                                          <span className="workspace-rail__agent-adapter">
                                            {pane.adapterId}
                                          </span>
                                        ) : null}
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function isSelected(
  selection: WorkspaceRailSelection,
  kind:
    | 'launcher'
    | 'project'
    | 'task-board'
    | 'memory'
    | 'settings'
    | 'terminals',
): boolean {
  return selection?.kind === kind;
}

/** Pure navigation view: mission lifecycle has already been projected by its caller. */
export function WorkspaceRail({
  activeWorkspaces,
  recentWorkspaces,
  selection,
  onCreateNew,
  onSelectWorkspace,
  onSelectMission,
  onRemoveWorkspace,
  onRemoveMission,
  projectEnabled = false,
  onOpenProject,
  onOpenTaskBoard,
  onOpenMemory,
  onOpenSettings,
  onOpenUsageQuota,
  onOpenTerminals,
  onOpenLauncher,
  currentWorkspaceId,
  attentionCount = 0,
  onOpenAttention,
}: WorkspaceRailProps) {
  const launcherSelected = isSelected(selection, 'launcher');
  const projectSelected = isSelected(selection, 'project');
  const terminalsSelected = isSelected(selection, 'terminals');
  const taskBoardSelected = isSelected(selection, 'task-board');
  const memorySelected = isSelected(selection, 'memory');
  const settingsSelected = isSelected(selection, 'settings');

  const layoutRoot = useLayoutStore((s) => s.root);
  const totalPanes = listPanes(layoutRoot).length;
  const quotaEntries = useQuotaStore((s) => s.snapshot.entries);

  return (
    <nav className="workspace-rail__navigation" aria-label="Destinos do Nexus">
      <header className="workspace-rail__identity">
        <div className="workspace-rail__brand">
          <span className="workspace-rail__mark" aria-hidden="true">
            <NexusMark size={15} />
          </span>
          <strong className="workspace-rail__brand-name">Nexus</strong>
        </div>
        <button
          type="button"
          className="workspace-rail__new"
          aria-label="Criar nova missão"
          onClick={onCreateNew}
        >
          <PixelIcon name="plus" size={11} />
          <span>Novo</span>
        </button>
      </header>

      <div className="workspace-rail__search-wrap">
        <button
          type="button"
          className="workspace-rail__search-btn"
          aria-label="Buscar missões e atalhos"
          title="Buscar (⌘K)"
          onClick={() => useCommandPaletteStore.getState().toggle()}
        >
          <PixelIcon name="search" size={11} />
          <span className="workspace-rail__search-placeholder">Buscar</span>
          <kbd className="workspace-rail__search-kbd">⌘K</kbd>
        </button>
      </div>

      <div className="workspace-rail__scroll">
        <button
          type="button"
          className="workspace-rail__mission-cta"
          aria-label="Criar nova missão neste workspace — descreva o objetivo"
          title="Descreva o objetivo — o Nexus monta a equipe neste workspace"
          data-testid="rail-new-mission"
          onClick={onCreateNew}
        >
          <span
            className="workspace-rail__mission-cta-icon"
            aria-hidden="true"
          >
            <PixelIcon name="mission" size={15} />
          </span>
          <span className="workspace-rail__mission-cta-copy">
            <span className="workspace-rail__mission-cta-title">
              Nova missão
            </span>
            <span className="workspace-rail__mission-cta-sub">
              Descreva o objetivo — o Nexus monta a equipe
            </span>
          </span>
          <span
            className="workspace-rail__mission-cta-plus"
            aria-hidden="true"
          >
            <PixelIcon name="plus" size={11} />
          </span>
        </button>
        <WorkspaceGroup
          label="Em andamento"
          group="active"
          workspaces={activeWorkspaces}
          selection={selection}
          onSelectWorkspace={onSelectWorkspace}
          onSelectMission={onSelectMission}
          onRemoveWorkspace={onRemoveWorkspace}
          currentWorkspaceId={currentWorkspaceId}
          onRemoveMission={onRemoveMission}
        />
        <WorkspaceGroup
          label="Recentes"
          group="recent"
          workspaces={recentWorkspaces}
          selection={selection}
          onSelectWorkspace={onSelectWorkspace}
          onSelectMission={onSelectMission}
          onRemoveWorkspace={onRemoveWorkspace}
          currentWorkspaceId={currentWorkspaceId}
          onRemoveMission={onRemoveMission}
        />
      </div>

      <WorkspaceCleanup />
      <ul className="workspace-rail__fixed" aria-label="Destinos fixos">
        {onOpenLauncher ? (
          <li>
            <button
              type="button"
              className={`workspace-rail__row workspace-rail__fixed-row${
                launcherSelected ? ' workspace-rail__row--selected' : ''
              }`}
              aria-current={launcherSelected ? 'page' : undefined}
              aria-label="Voltar ao Início"
              onClick={onOpenLauncher}
            >
              <PixelIcon name="grid" size={12} />
              <span className="workspace-rail__row-label">Início</span>
            </button>
          </li>
        ) : null}
        {projectEnabled && onOpenProject ? (
          <li>
            <button
              type="button"
              className={`workspace-rail__row workspace-rail__fixed-row${
                projectSelected ? ' workspace-rail__row--selected' : ''
              }`}
              aria-current={projectSelected ? 'page' : undefined}
              aria-label="Abrir Projeto"
              onClick={onOpenProject}
            >
              <PixelIcon name="files" size={12} />
              <span className="workspace-rail__row-label">Projeto</span>
            </button>
          </li>
        ) : null}
        <li>
          <div className="workspace-rail__fixed-row-wrap">
            <button
              type="button"
              className={`workspace-rail__row workspace-rail__fixed-row${
                terminalsSelected ? ' workspace-rail__row--selected' : ''
              }`}
              aria-current={terminalsSelected ? 'page' : undefined}
              aria-label="Abrir Terminais"
              onClick={onOpenTerminals}
            >
              <PixelIcon name="terminal" size={12} />
              <span className="workspace-rail__row-label">Terminais</span>
              {totalPanes > 0 ? (
                <span className="workspace-rail__row-count">{totalPanes}</span>
              ) : null}
            </button>
            <button
              type="button"
              className="workspace-rail__row-grid-action"
              aria-label="Grade de terminais (escolher quantidade)"
              title="Abrir grade de terminais"
              onClick={(e) => {
                e.stopPropagation();
                useTerminalGridDialogStore.getState().open({ initialCount: 2 });
              }}
            >
              <PixelIcon name="plus" size={10} />
            </button>
          </div>
        </li>
        <li>
          <button
            type="button"
            className={`workspace-rail__row workspace-rail__fixed-row${
              taskBoardSelected ? ' workspace-rail__row--selected' : ''
            }`}
            aria-current={taskBoardSelected ? 'page' : undefined}
            aria-label="Abrir Quadro"
            onClick={onOpenTaskBoard}
          >
            <PixelIcon name="board" size={12} />
            <span className="workspace-rail__row-label">Quadro</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className={`workspace-rail__row workspace-rail__fixed-row${
              memorySelected ? ' workspace-rail__row--selected' : ''
            }`}
            aria-current={memorySelected ? 'page' : undefined}
            aria-label="Abrir Memória"
            onClick={onOpenMemory}
          >
            <PixelIcon name="file" size={12} />
            <span className="workspace-rail__row-label">Memória</span>
          </button>
        </li>
      </ul>

      <footer className="workspace-rail__footer">
        {onOpenAttention && attentionCount > 0 ? (
          <button
            type="button"
            className="workspace-rail__row workspace-rail__fixed-row"
            aria-label={`Abrir a lista do que precisa de você (${attentionCount})`}
            onClick={onOpenAttention}
          >
            <PixelIcon name="warn" size={12} />
            <span className="workspace-rail__row-label">Precisa de você</span>
            <span className="workspace-rail__row-count">{attentionCount}</span>
          </button>
        ) : null}

        {quotaEntries.length > 0 ? (
          <div
            className="workspace-rail__cockpit"
            onClick={onOpenUsageQuota ?? onOpenSettings}
            role="button"
            tabIndex={0}
            aria-label="Ver uso de cotas nas Configurações"
            title="Cotas de IA disponíveis — clique para detalhes"
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                (onOpenUsageQuota ?? onOpenSettings)();
              }
            }}
          >
            <div className="workspace-rail__cockpit-header">
              <span className="workspace-rail__cockpit-title">Cotas</span>
              <span className="workspace-rail__cockpit-detail-hint">Ver</span>
            </div>
            <div className="workspace-rail__cockpit-bars">
              {prioritizeReportedQuotas(quotaEntries).slice(0, 2).map((entry) => {
                let worst: number | null = null;
                for (const window of entry.windows) {
                  if (window.usedRatio === null) continue;
                  if (worst === null || window.usedRatio > worst) {
                    worst = window.usedRatio;
                  }
                }
                if (entry.onCooldown) worst = 1;
                const tone =
                  worst === null
                    ? 'unknown'
                    : worst >= 0.8
                      ? 'danger'
                      : worst >= 0.5
                        ? 'warn'
                        : 'ok';
                const percentLabel =
                  worst === null ? '—' : `${Math.round(worst * 100)}%`;
                // Estilo Orca: todas as janelas ("5 Horas 35% · Semanal 41%").
                const line = shortWindowsLine(entry);
                return (
                  <div key={entry.id} className="workspace-rail__quota-item">
                    <div className="workspace-rail__quota-info">
                      <span className="workspace-rail__quota-name"><ProviderLogo adapterId={entry.adapterId} label={entry.label} size="xs" /><span>{entry.label}</span></span>
                      <span
                        className={`workspace-rail__quota-val workspace-rail__quota-val--${tone}`}
                      >
                        {percentLabel}
                      </span>
                    </div>
                    {line ? (
                      <span
                        className="workspace-rail__quota-line"
                        title={line}
                      >
                        {line}
                      </span>
                    ) : null}
                    <div className="workspace-rail__quota-track">
                      <div
                        className={`workspace-rail__quota-bar workspace-rail__quota-bar--${tone}`}
                        style={{
                          width: `${Math.min(
                            100,
                            Math.max(0, (worst ?? 0) * 100),
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="workspace-rail__cockpit-status">
          <button
            type="button"
            className={`workspace-rail__row workspace-rail__settings${
              settingsSelected ? ' workspace-rail__row--selected' : ''
            }`}
            aria-current={settingsSelected ? 'page' : undefined}
            aria-label="Abrir Configurações"
            onClick={onOpenSettings}
          >
            <PixelIcon name="config" size={12} />
            <span className="workspace-rail__row-label">Configurações</span>
          </button>
          <div
            className="workspace-rail__cockpit-conn"
            title="Runtime local ativo e monitorado"
          >
            <span className="workspace-rail__cockpit-led" aria-hidden="true" />
            <span className="workspace-rail__cockpit-conn-label">Local</span>
          </div>
        </div>
      </footer>
    </nav>
  );
}

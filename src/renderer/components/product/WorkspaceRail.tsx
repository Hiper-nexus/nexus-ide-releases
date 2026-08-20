import type {
  MissionLifecycleState,
  MissionStateReason,
} from '../../../shared/mission-engine-contract';
import {
  MISSION_LIFECYCLE_LABELS,
  MISSION_RUNNING_ATTENTION_LABEL,
  missionLifecycleLabel,
} from '../../lib/mission-lifecycle-copy';
import { NexusMark } from '../NexusMark';
import { PixelIcon, type PixelIconName } from '../PixelIcon';

export interface WorkspaceRailMission {
  id: string;
  title: string;
  status: MissionLifecycleState;
  needsAttention: boolean;
  stateReason?: Pick<MissionStateReason, 'code' | 'label'>;
}

export interface WorkspaceRailWorkspace {
  id: string;
  name: string;
  missions: readonly WorkspaceRailMission[];
}

export type WorkspaceRailSelection =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'mission'; missionId: string }
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
  onRemoveMission?: (missionId: string) => void;
  projectEnabled?: boolean;
  onOpenProject?: () => void;
  onOpenTaskBoard: () => void;
  onOpenMemory: () => void;
  onOpenSettings: () => void;
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
): MissionStatusDisplay {
  const label = missionLifecycleLabel(state, needsAttention, stateReason?.code);
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
  label: string;
  group: 'active' | 'recent';
  workspaces: readonly WorkspaceRailWorkspace[];
  selection: WorkspaceRailSelection;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectMission: (missionId: string, workspaceId?: string) => void;
  onRemoveWorkspace?: (workspaceId: string) => void;
  onRemoveMission?: (missionId: string) => void;
}

function WorkspaceGroup({
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

  return (
    <section
      className="workspace-rail__group"
      data-rail-group={group}
      aria-labelledby={labelId}
    >
      <span id={labelId} className="workspace-rail__group-title">
        {label}
      </span>
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
                    aria-label={`Remover workspace ${workspace.name} dos recentes`}
                    title={`Remover ${workspace.name} dos recentes`}
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
                    );
                    const missionSelected =
                      selection?.kind === 'mission' &&
                      selection.missionId === mission.id;

                    return (
                      <li key={mission.id}>
                        <div className="workspace-rail__workspace-row">
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
                            aria-label={`${mission.title}. ${status.label}`}
                            title={`${mission.title}: ${status.label}`}
                            onClick={() =>
                              onSelectMission(mission.id, workspace.id)
                            }
                          >
                            <span
                              className="workspace-rail__mission-indicator"
                              aria-hidden="true"
                            >
                              <PixelIcon name={status.icon} size={11} />
                            </span>
                            <span className="workspace-rail__mission-copy">
                              <span className="workspace-rail__row-label">
                                {mission.title}
                              </span>
                              <span className="workspace-rail__mission-status">
                                {status.label}
                              </span>
                            </span>
                          </button>
                          {onRemoveMission ? (
                            <button
                              type="button"
                              className="workspace-rail__workspace-action"
                              data-action="remove-mission"
                              data-mission-id={mission.id}
                              aria-label={`Remover missão ${mission.title}`}
                              title={`Remover "${mission.title}" — apaga a missão e o histórico`}
                              onClick={(event) => {
                                event.stopPropagation();
                                onRemoveMission(mission.id);
                              }}
                            >
                              <PixelIcon name="trash" size={11} />
                            </button>
                          ) : null}
                        </div>
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
  kind: 'project' | 'task-board' | 'memory' | 'settings',
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
}: WorkspaceRailProps) {
  const projectSelected = isSelected(selection, 'project');
  const taskBoardSelected = isSelected(selection, 'task-board');
  const memorySelected = isSelected(selection, 'memory');
  const settingsSelected = isSelected(selection, 'settings');

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

      <div className="workspace-rail__scroll">
        <WorkspaceGroup
          label="Em andamento"
          group="active"
          workspaces={activeWorkspaces}
          selection={selection}
          onSelectWorkspace={onSelectWorkspace}
          onSelectMission={onSelectMission}
          onRemoveWorkspace={onRemoveWorkspace}
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
          onRemoveMission={onRemoveMission}
        />
      </div>

      <ul className="workspace-rail__fixed" aria-label="Destinos fixos">
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
      </footer>
    </nav>
  );
}

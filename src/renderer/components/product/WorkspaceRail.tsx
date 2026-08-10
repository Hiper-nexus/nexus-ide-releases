import type { MissionLifecycleState } from '../../../shared/mission-engine-contract';
import { NexusMark } from '../NexusMark';
import { PixelIcon, type PixelIconName } from '../PixelIcon';

export interface WorkspaceRailMission {
  id: string;
  title: string;
  status: MissionLifecycleState;
  needsAttention: boolean;
}

export interface WorkspaceRailWorkspace {
  id: string;
  name: string;
  missions: readonly WorkspaceRailMission[];
}

export type WorkspaceRailSelection =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'mission'; missionId: string }
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
  onSelectMission: (missionId: string) => void;
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
  draft: { label: 'Preparando', icon: 'file', tone: 'pending' },
  review_ready: {
    label: 'Pronta para iniciar',
    icon: 'status-idle',
    tone: 'ready',
  },
  starting: { label: 'Iniciando', icon: 'status-spawning', tone: 'pending' },
  running: { label: 'Trabalhando', icon: 'status-busy', tone: 'running' },
  blocked_user: {
    label: 'Precisa de resposta',
    icon: 'user',
    tone: 'blocked',
  },
  blocked_technical: {
    label: 'Precisa de reparo',
    icon: 'warn',
    tone: 'blocked',
  },
  recovering: { label: 'Recuperando', icon: 'restart', tone: 'running' },
  stopping: { label: 'Parando', icon: 'stop', tone: 'pending' },
  failed: { label: 'Falhou', icon: 'status-exited', tone: 'failed' },
  completed: { label: 'Concluída', icon: 'check', tone: 'done' },
};

const RUNNING_WARNING_STATUS: MissionStatusDisplay = {
  label: 'Trabalhando · aviso',
  icon: 'warn',
  tone: 'blocked',
};

function missionStatusDisplay(
  state: MissionLifecycleState,
  needsAttention: boolean,
): MissionStatusDisplay {
  return state === 'running' && needsAttention
    ? RUNNING_WARNING_STATUS
    : MISSION_STATUS[state];
}

interface WorkspaceGroupProps {
  label: string;
  group: 'active' | 'recent';
  workspaces: readonly WorkspaceRailWorkspace[];
  selection: WorkspaceRailSelection;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectMission: (missionId: string) => void;
}

function WorkspaceGroup({
  label,
  group,
  workspaces,
  selection,
  onSelectWorkspace,
  onSelectMission,
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

              {workspace.missions.length > 0 ? (
                <ul
                  className="workspace-rail__mission-list"
                  aria-label={`Missões em ${workspace.name}`}
                >
                  {workspace.missions.map((mission) => {
                    const status = missionStatusDisplay(
                      mission.status,
                      mission.needsAttention,
                    );
                    const missionSelected =
                      selection?.kind === 'mission' &&
                      selection.missionId === mission.id;

                    return (
                      <li key={mission.id}>
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
                          onClick={() => onSelectMission(mission.id)}
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
  kind: 'task-board' | 'memory' | 'settings',
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
  onOpenTaskBoard,
  onOpenMemory,
  onOpenSettings,
}: WorkspaceRailProps) {
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
        />
        <WorkspaceGroup
          label="Recentes"
          group="recent"
          workspaces={recentWorkspaces}
          selection={selection}
          onSelectWorkspace={onSelectWorkspace}
          onSelectMission={onSelectMission}
        />
      </div>

      <ul className="workspace-rail__fixed" aria-label="Destinos fixos">
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

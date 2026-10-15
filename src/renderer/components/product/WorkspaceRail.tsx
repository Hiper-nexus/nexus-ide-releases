import {
  useEffect,
  useId,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
} from 'react';
import type {
  MissionLifecycleState,
  MissionStateReason,
  MissionWorktree,
} from '../../../shared/mission-engine-contract';
import {
  MISSION_LIFECYCLE_LABELS,
  MISSION_RUNNING_ATTENTION_LABEL,
  missionLifecycleLabel,
} from '../../lib/mission-lifecycle-copy';
import { MISSION_AWAITING_INSTRUCTION_REASON_CODE } from '../../../shared/session-restore-liveness';
import { missionChromeTitle } from '../../../shared/mission-identity';
import { listPanes } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { useOrchStore } from '../../state/orch-store';
import { useSessionStateStore } from '../../state/session-state-store';
import { usePaneParkedStore } from '../../state/pane-parked-store';
import { formatShortcut } from '../../lib/platform';
import { useQuotaStore } from '../../state/quota-store';
import { useLifetimeUsage } from '../../state/lifetime-usage';
import { useAdapterStore } from '../../state/adapter-store';
import { useMinuteTick } from '../../lib/use-minute-tick';
import {
  emptyRosterFleet,
  groupRosterFleets,
  workingNowLabel,
  type RosterFleet,
  type RosterFleets,
} from '../../lib/agent-roster';
import { RailAgentRoster, type RailAgentMeta } from './RailAgentRoster';
import { useTerminalGridDialogStore } from '../../state/terminal-grid-dialog-store';
import { useCommandPaletteStore } from '../../state/command-palette-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { WorkspaceCleanup } from './WorkspaceCleanup';
import { RailQuotaCard } from './RailQuotaCard';
import { RailMemoryPressure } from './RailMemoryPressure';
import { ReportProblemButton } from '../bug-report/ReportProblemButton';
import { NexusMark } from '../NexusMark';
import { TrialNoticeCard } from './TrialNoticeCard';
import { OperatorHud } from '../OperatorHud';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { workspacePathLabels } from './workspace-path-label';
import { relativeAgeLabel } from '../../../shared/mission-kanban';
import {
  flattenMissionBranchGroups,
  worktreeStatusLabel,
} from './mission-branch-groups';
import {
  loadCollapsedWorkspacePaths,
  saveCollapsedWorkspacePaths,
} from '../../lib/mission-rail-prefs';
import { useRailListMotion } from '../../lib/rail-list-motion';

export interface WorkspaceRailMission {
  id: string;
  title: string;
  status: MissionLifecycleState;
  needsAttention: boolean;
  stateReason?: Pick<MissionStateReason, 'code' | 'label'>;
  /** Entrega pronta para revisar; o aceite humano continua pendente. */
  awaitsOperatorReview?: boolean;
  /** Worktrees da missão: a branch é o nó da árvore, como no herdr/Sidecar. */
  worktrees?: readonly MissionWorktree[];
  updatedAt?: number;
}

export interface WorkspaceRailWorkspace {
  id: string;
  name: string;
  /**
   * Caminho da pasta no disco. O apelido sozinho não distingue dois `web`
   * abertos de repositórios diferentes — era exatamente o que o rail mostrava.
   */
  path?: string;
  missions: readonly WorkspaceRailMission[];
  /** Panes vivos conhecidos deste workspace (só o corrente tem esse dado). */
  livePaneCount?: number;
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
  onOpenApiKeys?: () => void;
  onOpenVoiceSettings?: () => void;
  onOpenUsageQuota?: () => void;
  /** Destino explícito do grid. Não é o nome do workspace. */
  onOpenTerminals: () => void;
  /**
   * Volta ao Início. Sem isto, quem clica em Quadro ou Memória perde para
   * sempre a tela que responde "o que você quer fazer agora?" — e o único
   * botão de abrir pasta da interface.
   */
  onOpenLauncher?: () => void;
  /** Opens a folder without going through the creation form. */
  onOpenWorkspace?: () => void;
  /**
   * Workspace aberto agora. A lixeira dele NÃO remove dos recentes: o main
   * desvia para o diálogo de fechar projeto (App.tsx), que encerra todas as
   * sessões. O rótulo precisa prometer o que de fato acontece.
   */
  currentWorkspaceId?: string;
  /**
   * A pasta do projeto aberto sumiu do disco (worktree removido por fora).
   * O selo "atual" vira "pasta não encontrada" — a pessoa precisa ver ONDE
   * está antes de entender por que nenhum pane novo nasce.
   */
  currentWorkspaceMissing?: boolean;
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
  if (
    state === 'running' &&
    stateReason?.code === MISSION_AWAITING_INSTRUCTION_REASON_CODE
  ) {
    return { label, icon: 'status-idle', tone: 'ready' };
  }
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
  currentWorkspaceMissing?: boolean;
  label: string;
  group: 'active' | 'recent';
  workspaces: readonly WorkspaceRailWorkspace[];
  /**
   * Calculado sobre os DOIS grupos: o rótulo de `web` só é honesto se levar em
   * conta o outro `web`, mesmo que ele esteja na outra seção.
   */
  pathLabels: ReadonlyMap<string, string>;
  /**
   * Agentes do layout aberto por missão e soltos, já com o estado vivo. Só o
   * workspace corrente tem panes no renderer; os vizinhos seguem só com o
   * estado das missões.
   */
  fleets: RosterFleets;
  adapterMeta: ReadonlyMap<string, RailAgentMeta>;
  selection: WorkspaceRailSelection;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectMission: (missionId: string, workspaceId?: string) => void;
  onRemoveWorkspace?: (workspaceId: string) => void;
  onRemoveMission?: (missionId: string, workspaceId: string) => void;
}

/** Chave do bloco de agentes soltos de um projeto em `expandedRosters`. */
function looseRosterKey(workspaceId: string): string {
  return `loose:${workspaceId}`;
}

/**
 * O bloco de agentes abre por escolha do operador; sem escolha, abre sozinho
 * na missão selecionada e enquanto alguém trabalha nele.
 */
function rosterOpen(
  expanded: Readonly<Record<string, boolean>>,
  key: string,
  fleet: RosterFleet,
  selected = false,
): boolean {
  return expanded[key] ?? (selected || fleet.workingCount > 0);
}

/**
 * O agente pertence a esta missão. Abrir a superfície global aqui misturava o
 * mosaico dela com os panes de outras missões; o foco precisa preservar a
 * fronteira da missão.
 */
function focusMissionAgent(missionId: string, paneId: string): void {
  useLayoutStore.getState().focus(paneId);
  const navigation = useProductNavigationStore.getState();
  navigation.openMission(missionId);
  navigation.showMissionTerminals();
}

/** Agente solto: os Terminais levam a aba até o pane que recebeu o foco. */
function focusLooseAgent(paneId: string): void {
  useLayoutStore.getState().focus(paneId);
  useProductNavigationStore.getState().openTerminal();
}

/**
 * Missões visíveis por pasta antes do "mostrar mais". O rail estreito não
 * comporta as 100+ missões de um workspace antigo (campo: "Em andamento 125").
 */
const RAIL_MISSION_PAGE_SIZE = 10;

/**
 * Lista da rail com continuidade: projetos e missões que entram, saem ou
 * trocam de lugar deslizam em vez de pular (`rail-list-motion`).
 */
function RailMotionList({
  layoutKey,
  ...props
}: ComponentPropsWithoutRef<'ul'> & { layoutKey: string }) {
  const ref = useRailListMotion<HTMLUListElement>(layoutKey);
  return <ul ref={ref} {...props} />;
}

function WorkspaceGroup({
  currentWorkspaceId,
  currentWorkspaceMissing = false,
  label,
  group,
  workspaces,
  pathLabels,
  fleets,
  adapterMeta,
  selection,
  onSelectWorkspace,
  onSelectMission,
  onRemoveWorkspace,
  onRemoveMission,
}: WorkspaceGroupProps) {
  const labelId = `workspace-rail-${group}-label`;
  // O contador é de repositórios listados na seção, nos dois grupos: contar
  // missões em "Em andamento" fazia a pill dizer 1 com 2 projetos na tela.
  const groupCount = workspaces.length;

  // Paginação por pasta: o rail estreito não comporta 100+ missões.
  const [missionListLimits, setMissionListLimits] = useState<
    Record<string, number>
  >({});
  // Estilo Orca: a missão selecionada já abre com os agentes visíveis. Sem
  // escolha do operador, o bloco também abre sozinho enquanto alguém trabalha
  // nele; recolher é uma escolha explícita (e os agentes trabalhando continuam
  // à vista mesmo recolhido — ver RailAgentRoster). As chaves são ids de missão
  // e `loose:<projeto>` (ver looseRosterKey) — por isso "rosters", não missões.
  const selectedMissionId =
    selection?.kind === 'mission' ? selection.missionId : null;
  const [expandedRosters, setExpandedRosters] = useState<
    Record<string, boolean>
  >(() => (selectedMissionId ? { [selectedMissionId]: true } : {}));
  const toggleRoster = (key: string, expanded: boolean) =>
    setExpandedRosters((prev) => ({ ...prev, [key]: !expanded }));
  // Árvore de spaces: projeto recolhível, preferência persistida por caminho.
  // Default = tudo aberto (comportamento de sempre); o projeto da missão
  // selecionada abre mesmo recolhido, para a seleção nunca sumir da vista.
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<
    ReadonlySet<string>
  >(() => new Set(loadCollapsedWorkspacePaths()));
  const toggleWorkspaceCollapsed = (workspaceId: string) => {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      saveCollapsedWorkspacePaths([...next]);
      return next;
    });
  };
  // O inicializador do useState roda uma vez: sem isto, navegar para outra
  // missão depois do mount nunca expandia os agentes dela.
  useEffect(() => {
    if (!selectedMissionId) return;
    setExpandedRosters((prev) =>
      prev[selectedMissionId] ? prev : { ...prev, [selectedMissionId]: true },
    );
  }, [selectedMissionId]);
  // Tudo que muda ordem, conjunto ou altura das linhas: quando muda, as
  // listas medem e animam; renders de status/idade não mexem em nada.
  const railLayoutKey = useMemo(() => {
    // Altura do bloco de agentes: quantos, quantos trabalhando (some e aparece
    // com o trabalho) e se a lista inteira está aberta.
    const rosterKey = (fleet: RosterFleet, open: boolean) =>
      `${fleet.agents.length}.${fleet.workingCount}${open ? 'x' : ''}`;
    const workspaceKeys = workspaces.map((workspace) => {
      const isCurrentWorkspace = workspace.id === currentWorkspaceId;
      const loose = isCurrentWorkspace ? fleets.loose : emptyRosterFleet();
      const live = isCurrentWorkspace && fleets.all.workingCount > 0 ? 'L' : '';
      return [
        workspace.id,
        collapsedWorkspaces.has(workspace.id) ? 'c' : 'o',
        missionListLimits[workspace.id] ?? '',
        `${live}${rosterKey(loose, rosterOpen(expandedRosters, looseRosterKey(workspace.id), loose))}`,
        workspace.missions
          .map((mission) => {
            const fleet = fleets.byMission.get(mission.id) ?? emptyRosterFleet();
            return `${mission.id}/${mission.worktrees?.map((w) => `${w.branch}=${w.status}`).join(';') ?? ''}/${rosterKey(
              fleet,
              rosterOpen(
                expandedRosters,
                mission.id,
                fleet,
                mission.id === selectedMissionId,
              ),
            )}`;
          })
          .join(','),
      ].join(':');
    });
    return `${selectedMissionId ?? ''}#${workspaceKeys.join('|')}`;
  }, [
    fleets,
    workspaces,
    currentWorkspaceId,
    collapsedWorkspaces,
    missionListLimits,
    expandedRosters,
    selectedMissionId,
  ]);

  if (workspaces.length === 0) return null;

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
        {groupCount > 0 ? (
          <span className="workspace-rail__group-pill">{groupCount}</span>
        ) : null}
      </div>
      <RailMotionList
        className="workspace-rail__workspace-list"
        layoutKey={railLayoutKey}
      >
        {workspaces.map((workspace) => {
          const workspaceSelected =
            selection?.kind === 'workspace' &&
            selection.workspaceId === workspace.id;
          // A selecionada sempre aparece, mesmo além da página atual.
          const selectedIndex =
            selection?.kind === 'mission'
              ? workspace.missions.findIndex(
                  (mission) => mission.id === selection.missionId,
                )
              : -1;
          const defaultMissionLimit = Math.max(
            RAIL_MISSION_PAGE_SIZE,
            selectedIndex + 1,
          );
          const missionLimit =
            missionListLimits[workspace.id] ?? defaultMissionLimit;
          const visibleMissions = workspace.missions.slice(0, missionLimit);
          const hiddenMissionCount =
            workspace.missions.length - visibleMissions.length;
          const missionRows = flattenMissionBranchGroups(visibleMissions);
          const isCollapsed =
            collapsedWorkspaces.has(workspace.id) && selectedIndex < 0;
          // "Onde estamos" é independente de seleção: selecionar a missão de
          // outra pasta não pode apagar qual projeto está aberto agora.
          const isCurrent = workspace.id === currentWorkspaceId;
          const isMissing = isCurrent && currentWorkspaceMissing;
          const currentNote = isMissing
            ? 'Projeto aberto agora — a pasta não existe mais no disco'
            : 'Projeto aberto agora';
          const where = workspace.path ? ` em ${workspace.path}` : '';
          // Só o projeto aberto tem panes no renderer: os vizinhos seguem só
          // com o estado das missões e não inventam contagem de agentes.
          const liveFleet = isCurrent ? fleets.all : emptyRosterFleet();
          const liveNote =
            liveFleet.workingCount > 0
              ? workingNowLabel(liveFleet.workingCount)
              : null;
          const looseFleet = isCurrent ? fleets.loose : emptyRosterFleet();
          const looseKey = looseRosterKey(workspace.id);
          const looseOpen = rosterOpen(expandedRosters, looseKey, looseFleet);
          // O recolher do projeto só existe com missões; sem elas não há botão
          // para reabrir, então os agentes soltos não podem ficar presos nele.
          const rostersHidden = isCollapsed && workspace.missions.length > 0;

          return (
            <li className="workspace-rail__workspace-item" key={workspace.id}>
              <div className="workspace-rail__workspace-row-wrapper">
                <button
                  type="button"
                  className={`workspace-rail__row workspace-rail__workspace${
                    workspaceSelected ? ' workspace-rail__row--selected' : ''
                  }${isCurrent ? ' workspace-rail__workspace--current' : ''}`}
                  data-workspace-id={workspace.id}
                  data-current={isCurrent || undefined}
                  data-missing={isMissing || undefined}
                  data-working={liveFleet.workingCount || undefined}
                  aria-current={workspaceSelected ? 'page' : undefined}
                  aria-label={
                    (isCurrent
                      ? `${currentNote}: ${workspace.name}${where}`
                      : `Abrir workspace ${workspace.name}${where}`) +
                    (liveNote ? `. ${liveNote}` : '')
                  }
                  title={[
                    workspace.name,
                    workspace.path,
                    isCurrent ? currentNote : null,
                    liveNote,
                  ]
                    .filter(Boolean)
                    .join('\n')}
                  onClick={() => onSelectWorkspace(workspace.id)}
                >
                  <span className="workspace-rail__workspace-icon" aria-hidden>
                    <PixelIcon name="files" size={12} />
                  </span>
                  <span className="workspace-rail__workspace-copy">
                    <span className="workspace-rail__workspace-title">
                      <span className="workspace-rail__row-label">
                        {workspace.name}
                      </span>
                      {isCurrent ? (
                        <span
                          className={`workspace-rail__workspace-current${
                            isMissing
                              ? ' workspace-rail__workspace-current--missing'
                              : ''
                          }`}
                        >
                          {isMissing ? 'pasta sumiu' : 'atual'}
                        </span>
                      ) : null}
                    </span>
                    {workspace.path ? (
                      <span
                        className="workspace-rail__workspace-path"
                        title={workspace.path}
                      >
                        {pathLabels.get(workspace.id) ?? workspace.path}
                      </span>
                    ) : null}
                    {group === 'active' &&
                    (workspace.missions.length > 0 ||
                      (workspace.livePaneCount ?? 0) > 0) ? (
                      <span className="workspace-rail__workspace-activity">
                        {workspace.missions.length > 0
                          ? `${workspace.missions.length} ${workspace.missions.length === 1 ? 'missão' : 'missões'}`
                          : 'sem missão'}
                        {(workspace.livePaneCount ?? 0) > 0
                          ? ` · ${workspace.livePaneCount} ${workspace.livePaneCount === 1 ? 'pane aberto' : 'panes abertos'}`
                          : ''}
                      </span>
                    ) : null}
                    {liveNote ? (
                      <span className="workspace-rail__workspace-live">
                        <span
                          className="workspace-rail__live-dot"
                          aria-hidden="true"
                        />
                        {liveNote}
                        {liveFleet.parallel ? (
                          <span className="workspace-rail__live-tag">
                            em paralelo
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                </button>
                {workspace.missions.length > 0 ? (
                  <button
                    type="button"
                    className={`workspace-rail__workspace-toggle${
                      isCollapsed ? ' workspace-rail__workspace-toggle--collapsed' : ''
                    }`}
                    data-action="toggle-workspace"
                    data-workspace-id={workspace.id}
                    aria-expanded={!isCollapsed}
                    aria-label={
                      isCollapsed
                        ? `Mostrar as ${workspace.missions.length} missões de ${workspace.name}`
                        : `Recolher as missões de ${workspace.name}`
                    }
                    title={isCollapsed ? 'Mostrar missões' : 'Recolher missões'}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleWorkspaceCollapsed(workspace.id);
                    }}
                  >
                    <PixelIcon name="chevron-down" size={10} />
                    {isCollapsed ? (
                      <span className="workspace-rail__workspace-count">
                        {workspace.missions.length}
                      </span>
                    ) : null}
                  </button>
                ) : null}
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

              {!rostersHidden && looseFleet.agents.length > 0 ? (
                <div className="workspace-rail__loose-agents">
                  <RailAgentRoster
                    fleet={looseFleet}
                    scopeLabel="nos terminais"
                    heading="Terminais"
                    expanded={looseOpen}
                    onToggle={() => toggleRoster(looseKey, looseOpen)}
                    onFocusAgent={focusLooseAgent}
                    adapterMeta={adapterMeta}
                  />
                </div>
              ) : null}

              {workspace.missions.length > 0 && !isCollapsed ? (
                <RailMotionList
                  className="workspace-rail__mission-list"
                  aria-label={`Missões em ${workspace.name}`}
                  layoutKey={railLayoutKey}
                >
                  {missionRows.map((row) => {
                    if (row.kind === 'branch') {
                      const statusLabel = worktreeStatusLabel(row.status);
                      return (
                        <li
                          key={`branch:${row.branch}`}
                          className={`workspace-rail__branch workspace-rail__branch--${row.status}`}
                          data-rail-branch={row.branch}
                          aria-label={`Branch ${row.branch}${statusLabel ? ` (${statusLabel})` : ''}`}
                          title={row.branch}
                        >
                          <span className="workspace-rail__branch-glyph" aria-hidden="true">
                            ⑂
                          </span>
                          <span className="workspace-rail__branch-name">{row.branch}</span>
                          {statusLabel ? (
                            <span className="workspace-rail__branch-status">{statusLabel}</span>
                          ) : null}
                        </li>
                      );
                    }
                    const mission = row.mission;
                    const status = missionStatusDisplay(
                      mission.status,
                      mission.needsAttention,
                      mission.stateReason,
                      mission.awaitsOperatorReview === true,
                    );
                    const missionSelected =
                      selection?.kind === 'mission' &&
                      selection.missionId === mission.id;
                    // O rail mostra o titulo em ate 2 linhas: o corte de chrome (48) partia
                    // o titulo no meio da palavra; o tooltip guarda o titulo inteiro.
                    const chromeTitle = missionChromeTitle(mission.title, 96);
                    const missionFleet =
                      fleets.byMission.get(mission.id) ?? emptyRosterFleet();
                    const isExpanded = rosterOpen(
                      expandedRosters,
                      mission.id,
                      missionFleet,
                      missionSelected,
                    );

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
                                <span className="workspace-rail__mission-status">
                                  {status.label}
                                </span>
                                {mission.updatedAt ? (
                                  <span
                                    className="workspace-rail__mission-age"
                                    title={new Date(mission.updatedAt).toLocaleString()}
                                  >
                                    {relativeAgeLabel(mission.updatedAt, Date.now())}
                                  </span>
                                ) : null}
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

                        <RailAgentRoster
                          fleet={missionFleet}
                          scopeLabel="nesta missão"
                          expanded={isExpanded}
                          onToggle={() => toggleRoster(mission.id, isExpanded)}
                          onFocusAgent={(paneId) =>
                            focusMissionAgent(mission.id, paneId)
                          }
                          adapterMeta={adapterMeta}
                        />
                      </li>
                    );
                  })}
                </RailMotionList>
              ) : null}
              {workspace.missions.length > 0 &&
                hiddenMissionCount > 0 ? (
                  <button
                    type="button"
                    className="workspace-rail__missions-more"
                    aria-expanded={false}
                    aria-label={`Mostrar mais ${hiddenMissionCount} missões em ${workspace.name}`}
                    onClick={() =>
                      setMissionListLimits((prev) => ({
                        ...prev,
                        [workspace.id]:
                          missionLimit + RAIL_MISSION_PAGE_SIZE,
                      }))
                    }
                  >
                    Mostrar mais {hiddenMissionCount}…
                  </button>
                ) : missionLimit > defaultMissionLimit ? (
                  <button
                    type="button"
                    className="workspace-rail__missions-more"
                    aria-expanded={true}
                    aria-label={`Mostrar menos missões em ${workspace.name}`}
                    onClick={() =>
                      setMissionListLimits((prev) => ({
                        ...prev,
                        [workspace.id]: defaultMissionLimit,
                      }))
                    }
                  >
                    Mostrar menos
                  </button>
                ) : null}
            </li>
          );
        })}
      </RailMotionList>
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
  onOpenApiKeys,
  onOpenVoiceSettings,
  onOpenUsageQuota,
  onOpenTerminals,
  onOpenLauncher,
  onOpenWorkspace,
  currentWorkspaceId,
  currentWorkspaceMissing = false,
  attentionCount = 0,
  onOpenAttention,
}: WorkspaceRailProps) {
  const launcherSelected = isSelected(selection, 'launcher');
  const projectSelected = isSelected(selection, 'project');
  const terminalsSelected = isSelected(selection, 'terminals');
  const taskBoardSelected = isSelected(selection, 'task-board');
  const memorySelected = isSelected(selection, 'memory');
  const settingsSelected = isSelected(selection, 'settings');
  // Início e Projeto dividem a primeira linha da grade; sozinho, ocupa a linha.
  const pairedStart = Boolean(onOpenLauncher && projectEnabled && onOpenProject);

  const layoutRoot = useLayoutStore((s) => s.root);
  const allPanes = useMemo(() => listPanes(layoutRoot), [layoutRoot]);
  const totalPanes = allPanes.length;
  const paneMissions = useOrchStore((s) => s.paneMissions);
  // `displayStates` é o estado de apresentação (o busy fica um instante depois
  // de ociosar): a mesma fonte do chip da toolbar, para o rail não piscar.
  const displayStates = useSessionStateStore((s) => s.displayStates);
  const parkedPanes = usePaneParkedStore((s) => s.parked);
  const adapters = useAdapterStore((s) => s.adapters);
  const adapterMeta = useMemo(() => {
    const map = new Map<string, RailAgentMeta>();
    for (const adapter of adapters) {
      map.set(adapter.id, { label: adapter.label, icon: adapter.icon });
    }
    return map;
  }, [adapters]);
  // Uma só leitura da frota por render, para o rail inteiro: o grupo, a linha
  // do projeto e o chip de Terminais nunca discordam na contagem.
  const fleets = useMemo(
    () =>
      groupRosterFleets(allPanes, paneMissions, {
        states: displayStates,
        parked: parkedPanes,
        adapterLabel: (adapterId) => adapterMeta.get(adapterId)?.label,
      }),
    [allPanes, paneMissions, displayStates, parkedPanes, adapterMeta],
  );
  const liveWorking = fleets.all.workingCount;
  const liveChipId = useId();
  const quotaEntries = useQuotaStore((s) => s.snapshot.entries);
  const lifetimeUsage = useLifetimeUsage();
  const quotaTick = useMinuteTick();
  const pathLabels = useMemo(
    () => workspacePathLabels([...activeWorkspaces, ...recentWorkspaces]),
    [activeWorkspaces, recentWorkspaces],
  );

  return (
    <nav className="workspace-rail__navigation" aria-label="Destinos do Nexus">
      <header className="workspace-rail__identity">
        <div className="workspace-rail__brand">
          <span className="workspace-rail__mark" aria-hidden="true">
            <NexusMark size={20} />
          </span>
          <strong className="workspace-rail__brand-name">Nexus</strong>
        </div>
        <ReportProblemButton
          className="workspace-rail__report"
          title={`Reportar um problema (${formatShortcut('mod', 'shift', 'B')})`}
        >
          Reportar bug
        </ReportProblemButton>
      </header>

      <div className="workspace-rail__search-wrap">
        <button
          type="button"
          className="workspace-rail__search-btn"
          aria-label="Buscar missões e atalhos"
          title={`Buscar (${formatShortcut('mod', 'K')})`}
          onClick={() => useCommandPaletteStore.getState().toggle()}
        >
          <PixelIcon name="search" size={11} />
          <span className="workspace-rail__search-placeholder">Buscar</span>
          <kbd className="workspace-rail__search-kbd">{formatShortcut('mod', 'K')}</kbd>
        </button>
      </div>

      <div className="workspace-rail__actions">
        <button
          type="button"
          className="workspace-rail__mission-cta"
          aria-label="Novo pedido"
          title="Descreva um novo pedido para sua equipe de IA"
          data-testid="rail-new-mission"
          onClick={onCreateNew}
        >
          <span
            className="workspace-rail__mission-cta-icon"
            aria-hidden="true"
          >
            <PixelIcon name="plus" size={14} />
          </span>
          <span className="workspace-rail__mission-cta-copy">
            <span className="workspace-rail__mission-cta-title">
              Novo pedido
            </span>
          </span>
        </button>
        {/* As duas entradas de trabalho lado a lado: criar ou abrir o que já existe. */}
        {onOpenWorkspace ? (
          <button
            type="button"
            className="workspace-rail__open-project"
            aria-label="Abrir projeto existente"
            title="Abrir projeto"
            onClick={onOpenWorkspace}
          >
            <PixelIcon name="files" size={12} />
          </button>
        ) : null}
      </div>

      <ul className="workspace-rail__fixed" aria-label="Destinos fixos">
        {onOpenLauncher ? (
          <li className={pairedStart ? undefined : 'workspace-rail__fixed-item--wide'}>
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
          <li className={pairedStart ? undefined : 'workspace-rail__fixed-item--wide'}>
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
        <li className="workspace-rail__fixed-item--wide">
          <div className="workspace-rail__fixed-row-wrap">
            <button
              type="button"
              className={`workspace-rail__row workspace-rail__fixed-row${
                terminalsSelected ? ' workspace-rail__row--selected' : ''
              }`}
              aria-current={terminalsSelected ? 'page' : undefined}
              aria-label="Abrir Terminais"
              aria-describedby={liveWorking > 0 ? liveChipId : undefined}
              onClick={onOpenTerminals}
            >
              <PixelIcon name="terminal" size={12} />
              <span className="workspace-rail__row-label">Terminais</span>
              {liveWorking > 0 ? (
                // Fica na faixa fixa, fora da rolagem: quantos agentes
                // trabalham agora é visível mesmo com a lista de projetos
                // rolada ou recolhida.
                <span
                  id={liveChipId}
                  className="workspace-rail__live-chip"
                  title={workingNowLabel(liveWorking)}
                >
                  <span
                    className="workspace-rail__live-dot"
                    aria-hidden="true"
                  />
                  <span aria-hidden="true">{liveWorking}</span>
                  <span className="workspace-rail__sr-only">
                    {workingNowLabel(liveWorking)}
                  </span>
                </span>
              ) : null}
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

      <div className="workspace-rail__scroll">
        <WorkspaceGroup
          label={activeWorkspaces.some((workspace) => workspace.missions.length > 0 || (workspace.livePaneCount ?? 0) > 0) ? 'Em andamento' : 'Projeto atual'}
          group="active"
          workspaces={activeWorkspaces}
          pathLabels={pathLabels}
          fleets={fleets}
          adapterMeta={adapterMeta}
          selection={selection}
          onSelectWorkspace={onSelectWorkspace}
          onSelectMission={onSelectMission}
          onRemoveWorkspace={onRemoveWorkspace}
          currentWorkspaceId={currentWorkspaceId}
          currentWorkspaceMissing={currentWorkspaceMissing}
          onRemoveMission={onRemoveMission}
        />
        <WorkspaceGroup
          label="Recentes"
          group="recent"
          workspaces={recentWorkspaces}
          pathLabels={pathLabels}
          fleets={fleets}
          adapterMeta={adapterMeta}
          selection={selection}
          onSelectWorkspace={onSelectWorkspace}
          onSelectMission={onSelectMission}
          onRemoveWorkspace={onRemoveWorkspace}
          currentWorkspaceId={currentWorkspaceId}
          currentWorkspaceMissing={currentWorkspaceMissing}
          onRemoveMission={onRemoveMission}
        />
      </div>

      <footer className="workspace-rail__footer">
        {/*
          Tudo que pode ceder altura mora aqui: numa janela baixa esta faixa
          encolhe (e rola) em vez de esmagar a lista de projetos acima.
        */}
        <div className="workspace-rail__utilities">
        <TrialNoticeCard />
        <WorkspaceCleanup />
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

        <RailMemoryPressure onOpen={onOpenUsageQuota} />

        {quotaEntries.length > 0 ? (
          <RailQuotaCard
            entries={quotaEntries}
            now={quotaTick}
            lifetimeUsage={lifetimeUsage}
            onOpenUsage={onOpenUsageQuota ?? onOpenSettings}
          />
        ) : null}

        <OperatorHud />
        </div>

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
          <button
            type="button"
            className="workspace-rail__row-grid-action"
            title="Chaves de API (Gemini, Grok, Groq, OpenAI...)"
            aria-label="Chaves de API"
            onClick={onOpenApiKeys ?? (() => useProductNavigationStore.getState().openSettings('api-keys'))}
          >
            <PixelIcon name="key" size={12} />
          </button>
          <button
            type="button"
            className="workspace-rail__row-grid-action"
            title="Jarvis & Voz"
            aria-label="Jarvis & Voz"
            onClick={onOpenVoiceSettings ?? (() => useProductNavigationStore.getState().openSettings('voice'))}
          >
            <PixelIcon name="mic" size={12} />
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

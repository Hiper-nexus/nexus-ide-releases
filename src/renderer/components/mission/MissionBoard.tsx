import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  MissionAllowedAction,
  MissionEngineCommand,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import {
  missionEventSchema,
  type MissionEvent,
} from '../../../shared/mission-events';
import { missionLifecycleLabel } from '../../lib/mission-lifecycle-copy';
import { missionBoardHeading } from '../../lib/mission-board-heading';
import { missionAwaitsOperatorReview } from '../../../shared/mission-recovery-policy';
import {
  MISSION_BACKGROUND_NOTICE,
  qualitativeProgress,
} from '../../lib/mission-progress-line';
import { MISSION_AWAITING_INSTRUCTION_REASON_CODE } from '../../../shared/session-restore-liveness';

/** Estados em que a missão está de fato trabalhando agora. */
const MISSION_LIVE_STATES: ReadonlySet<string> = new Set([
  'running',
  'starting',
  'recovering',
]);
import {
  aggregateMissionTelemetry,
  formatMissionTelemetry,
} from '../../../shared/handoff-telemetry';
import { useMissionInspectorStore } from '../../state/mission-inspector-store';
import {
  MISSION_INSPECTOR_WIDTH_MAX,
  MISSION_INSPECTOR_WIDTH_MIN,
  useInspectorWidthStore,
} from '../../state/mission-inspector-width-store';
import { toUserFacingMissionRecovery } from '../../lib/user-facing-mission-error';
import { listPanes } from '../../lib/split-tree';
import { askConfirm } from '../../state/confirm-store';
import { useLayoutStore } from '../../state/layout-store';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import {
  closeMissionNote,
  closeMissionRuntimeAndPanes,
} from '../../orch/close-mission-runtime';
import {
  discardMissionPrompt,
  missionActionCopy,
  missionBoardLifecycleAction,
  removeMissionPrompt,
  type MissionListAction,
} from '../../orch/mission-list-action';
import { rebindLiveMaestroOfMission } from '../../terminal/terminal-host';
import { MissionGraph } from './MissionGraph';
import { DirectionComposer } from './DirectionComposer';
import { MissionInspector, type MissionJournalHistory } from './MissionInspector';
import type { TimelineItemModel } from './AgentActivityTimeline';
import {
  formatQuote,
  type QuoteDraft,
  type QuoteOrigin,
} from '../../lib/quote-reference';
import {
  mergeRecentJournalWindow,
  prependOlderJournalPage,
} from '../../lib/mission-journal-window';
import {
  MissionQuestion,
  type MissionQuestionState,
} from './MissionQuestion';
import {
  MissionInterruptedCard,
  missionIsInterrupted,
} from './MissionInterruptedCard';

/** Tamanho da janela recente E de cada página anterior pedida ao Main. */
const RECENT_EVENT_LIMIT = 40;
/** `runId` com que o Main grava a orientação aceita e o desfecho da entrega dela. */
const OPERATOR_DIRECTION_RUN_ID = 'operator-direction';
/**
 * D2: teto do replay do Main (MISSION_REPLAY_MAX_EVENTS). Até ele vêm todas as
 * orientações da missão; acima, as mais novas.
 */
const OPERATOR_DIRECTION_REPLAY_LIMIT = 128;

interface JournalHistoryState {
  readonly total: number | null;
  readonly hasMore: boolean;
  readonly loading: boolean;
}

const EMPTY_JOURNAL_HISTORY: JournalHistoryState = {
  total: null,
  hasMore: false,
  loading: false,
};
const WORKSPACE_STACK_BREAKPOINT = 1099;
const MISSION_INSPECTOR_COLLAPSED_KEY = 'nexus.mission.inspector-collapsed';
/**
 * Empilhado (quadro ≤ 1099px) o inspetor vive embaixo do grafo e sua medida é
 * ALTURA — fração da área de trabalho, só desta sessão. Lado a lado a medida é
 * a largura persistida do `useInspectorWidthStore`.
 */
const STACKED_INSPECTOR_DEFAULT_RATIO = 0.4;
const STACKED_INSPECTOR_MIN_RATIO = 0.3;
const STACKED_INSPECTOR_MAX_RATIO = 0.6;
const SPLITTER_KEYBOARD_STEP = 16;
/**
 * Arraste a partir do trilho recolhido só reabre depois de o ponteiro andar
 * este tanto para dentro do quadro: um clique trêmulo não vira
 * redimensionamento (limiar do Agent Orchestrator).
 */
const INSPECTOR_RAIL_EXPAND_THRESHOLD = 8;

type SplitterOrientation = 'horizontal' | 'vertical';

type WorkspaceDimensions = Readonly<{ width: number; height: number }>;

function workspaceOrientation(width: number): SplitterOrientation {
  return width > 0 && width <= WORKSPACE_STACK_BREAKPOINT
    ? 'horizontal'
    : 'vertical';
}

function clampStackedInspectorHeight(size: number, extent: number): number {
  return Math.min(
    extent * STACKED_INSPECTOR_MAX_RATIO,
    Math.max(extent * STACKED_INSPECTOR_MIN_RATIO, size),
  );
}

function readStoredInspectorCollapsed(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      window.localStorage.getItem(MISSION_INSPECTOR_COLLAPSED_KEY) === '1'
    );
  } catch {
    // Storage bloqueado não pode impedir o quadro de montar.
    return false;
  }
}

function persistInspectorCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      MISSION_INSPECTOR_COLLAPSED_KEY,
      collapsed ? '1' : '0',
    );
  } catch {
    // Preferência é best-effort; o estado da sessão já vale.
  }
}


const MISSION_BOARD_COLLAPSED_KEY = 'nexus.mission.board-collapsed';

function readStoredBoardCollapsed(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      window.localStorage.getItem(MISSION_BOARD_COLLAPSED_KEY) === '1'
    );
  } catch {
    // Storage bloqueado não pode impedir o quadro de montar: nasce expandido.
    return false;
  }
}

function persistBoardCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      MISSION_BOARD_COLLAPSED_KEY,
      collapsed ? '1' : '0',
    );
  } catch {
    // Preferência é best-effort; o estado da sessão já vale.
  }
}

type HeaderAction = Extract<
  MissionAllowedAction,
  'retry-kickoff' | 'resume' | 'stop'
>;

type LifecycleAction = Exclude<MissionListAction, 'none'>;
type PendingBoardAction =
  | HeaderAction
  | LifecycleAction
  | 'leader-drift-rebind';

interface BoardActionAttempt {
  readonly requestedMissionId: string;
  readonly requestGeneration: number;
  readonly sessionGeneration: number;
  readonly invoker: HTMLButtonElement;
}

const HEADER_ACTIONS: readonly HeaderAction[] = [
  'retry-kickoff',
  'resume',
  'stop',
];

const HEADER_ACTION_LABELS: Readonly<Record<HeaderAction, string>> = {
  'retry-kickoff': 'Retomar o coordenador',
  resume: 'Retomar',
  stop: 'Parar',
};

/**
 * Em missão concluída, `resume` não é "retomar de onde parou": é o operador
 * dizendo que a entrega ainda não está aprovada. O rótulo precisa nomear a
 * ação real, senão a única ação de uma missão pronta lê como repetir trabalho.
 */
export function headerActionLabel(
  action: HeaderAction,
  missionState: string,
): string {
  if (action === 'resume' && missionState === 'completed') {
    return 'Pedir um ajuste';
  }
  // Em falha, "Retomar" lê como continuar de onde parou — e não há de onde.
  // O que o operador quer ali é uma segunda chance.
  if (action === 'resume' && missionState === 'failed') {
    return 'Tentar de novo';
  }
  // F-245: em bloqueio técnico o Retomar reabre a missão e respawna o
  // coordenador — nomeie o que volta, não a ação abstrata.
  if (action === 'resume' && missionState === 'blocked_technical') {
    return 'Retomar o coordenador';
  }
  return HEADER_ACTION_LABELS[action];
}

/** A única ação sólida do cabeçalho; tudo o mais mora no menu Mais. */
export type PrimaryHeaderAction = HeaderAction | 'leader-drift-rebind';

/**
 * Hierarquia do cabeçalho: religar ao Maestro à deriva vem primeiro (é o
 * reparo que destrava a missão), depois Retomar, depois retomar o
 * coordenador. Sem nenhuma delas o cabeçalho não inventa primária — Parar e
 * as ações de ciclo de vida nunca são o botão sólido.
 */
export function primaryHeaderAction(
  allowedActions: readonly MissionAllowedAction[],
  stateReasonCode: string | undefined,
): PrimaryHeaderAction | null {
  if (stateReasonCode === 'leader-drift') return 'leader-drift-rebind';
  if (allowedActions.includes('resume')) return 'resume';
  if (allowedActions.includes('retry-kickoff')) return 'retry-kickoff';
  return null;
}

export interface MissionBoardProps {
  readonly missionId: string;
  readonly onOpenTerminals: (missionId: string) => void;
}

function emptyQuestionState(): MissionQuestionState {
  return {
    optionId: null,
    text: '',
    pending: false,
    error: null,
  };
}

function parseJournalEvents(
  rawEvents: unknown,
  missionId: string,
): MissionEvent[] {
  if (!Array.isArray(rawEvents)) return [];

  const events: MissionEvent[] = [];
  for (const rawEvent of rawEvents) {
    const parsed = missionEventSchema.safeParse(rawEvent);
    if (parsed.success && parsed.data.missionId === missionId) {
      events.push(parsed.data);
    }
  }
  events.sort(
    (left, right) =>
      left.sequence - right.sequence || left.occurredAt - right.occurredAt,
  );
  return events;
}


function preferNewestSnapshot(
  current: MissionSnapshot | null,
  candidate: MissionSnapshot,
): MissionSnapshot {
  if (!current || current.id !== candidate.id) return candidate;
  if (candidate.version !== current.version) {
    return candidate.version > current.version ? candidate : current;
  }
  return candidate.updatedAt >= current.updatedAt ? candidate : current;
}

export function MissionBoard({
  missionId,
  onOpenTerminals,
}: MissionBoardProps) {
  const headingId = useId();
  const inspectorRegionId = useId();
  const missionIdRef = useRef(missionId);
  const sessionGenerationRef = useRef(0);
  const snapshotGenerationRef = useRef(0);
  const snapshotRef = useRef<MissionSnapshot | null>(null);
  const journalGenerationRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const actionPendingRef = useRef(false);
  const refreshSnapshotRef = useRef<(() => void) | null>(null);
  const refreshJournalRef = useRef<(() => void) | null>(null);
  // F-1005: páginas anteriores do journal, pedidas ao Main sob demanda.
  const loadOlderJournalRef = useRef<(() => void) | null>(null);
  const olderPagesLoadedRef = useRef(false);
  const eventsRef = useRef<MissionEvent[]>([]);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  missionIdRef.current = missionId;

  const [snapshot, setSnapshot] = useState<MissionSnapshot | null>(null);
  snapshotRef.current = snapshot;
  const [events, setEvents] = useState<MissionEvent[]>([]);
  eventsRef.current = events;
  // D2: orientações do operador lidas por runId, fora da janela recente de `events`.
  const [operatorDirectionEvents, setOperatorDirectionEvents] = useState<
    MissionEvent[]
  >([]);
  const [journalHistory, setJournalHistory] = useState(EMPTY_JOURNAL_HISTORY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] =
    useState<PendingBoardAction | null>(null);
  const [actionAnnouncement, setActionAnnouncement] = useState<string | null>(
    null,
  );
  const [questionState, setQuestionState] =
    useState<MissionQuestionState>(emptyQuestionState);
  const [workspaceDimensions, setWorkspaceDimensions] =
    useState<WorkspaceDimensions>({ width: 0, height: 0 });
  const [inspectorCollapsed, setInspectorCollapsed] = useState(
    readStoredInspectorCollapsed,
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const [boardCollapsed, setBoardCollapsed] = useState(
    readStoredBoardCollapsed,
  );
  const toggleBoardCollapsed = useCallback((): void => {
    setMoreOpen(false);
    setBoardCollapsed((current) => {
      const next = !current;
      persistBoardCollapsed(next);
      return next;
    });
  }, []);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuId = useId();
  const boardBodyId = useId();
  // Trocar de missão com o menu aberto mostraria ações da missão anterior.
  useEffect(() => {
    setMoreOpen(false);
  }, [missionId]);
  // Menu Mais aberto: foco no primeiro item habilitado e clique fora fecha
  // (mesmo idioma do PaneContextMenu).
  useEffect(() => {
    if (!moreOpen) return;
    const items = [
      ...(moreMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? []),
    ];
    items.find((item) => !item.disabled)?.focus({ preventScroll: true });
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (
        moreMenuRef.current?.contains(target) ||
        moreButtonRef.current?.contains(target)
      ) {
        return;
      }
      setMoreOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [moreOpen]);
  const closeMoreMenu = useCallback((restoreFocus: boolean): void => {
    setMoreOpen(false);
    if (restoreFocus) {
      moreButtonRef.current?.focus({ preventScroll: true });
    }
  }, []);
  // Ação disparada do menu usa o botão Mais como invocador: é ele que
  // continua montado para receber o foco de volta quando a ação termina.
  const runFromMoreMenu = (
    run: (invoker: HTMLButtonElement) => void,
  ): void => {
    const invoker = moreButtonRef.current;
    setMoreOpen(false);
    if (invoker) run(invoker);
  };
  const handleMoreMenuKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMoreMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      setMoreOpen(false);
      return;
    }
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    const items = [
      ...(moreMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? []),
    ].filter((item) => !item.disabled);
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowUp'
            ? (current - 1 + items.length) % items.length
            : (current + 1) % items.length;
    items[next]?.focus({ preventScroll: true });
  };
  const toggleInspectorCollapsed = useCallback((): void => {
    setInspectorCollapsed((current) => {
      const next = !current;
      persistInspectorCollapsed(next);
      return next;
    });
  }, []);
  // Reaberto pelo trilho, o foco tem que pousar no divisor que o substitui —
  // senão quem veio pelo teclado cai no body.
  const splitterRef = useRef<HTMLDivElement | null>(null);
  const focusSplitterAfterExpandRef = useRef(false);
  const expandInspectorFromRail = useCallback((): void => {
    focusSplitterAfterExpandRef.current = true;
    setInspectorCollapsed((current) => {
      if (!current) return current;
      persistInspectorCollapsed(false);
      return false;
    });
  }, []);
  useEffect(() => {
    if (inspectorCollapsed || !focusSplitterAfterExpandRef.current) return;
    focusSplitterAfterExpandRef.current = false;
    splitterRef.current?.focus({ preventScroll: true });
  }, [inspectorCollapsed]);
  const inspectorWidth = useInspectorWidthStore((state) => state.width);
  const setInspectorWidth = useInspectorWidthStore((state) => state.setWidth);
  const resetInspectorWidth = useInspectorWidthStore((state) => state.reset);
  const [stackedInspectorRatio, setStackedInspectorRatio] = useState(
    STACKED_INSPECTOR_DEFAULT_RATIO,
  );

  const currentMission = useOrchStore(
    (state) =>
      state.missions.find((mission) => mission.id === missionId) ?? null,
  );
  const paneMissions = useOrchStore((state) => state.paneMissions);
  // Telemetria autorrelatada nos handoffs (overclick, 19/08): "34 min · 1.2M
  // tokens · autorrelato N/M". Ausência declarada — sem autorrelato, sem linha.
  const missionHandoffs = useOrchStore((state) => state.handoffs);
  const telemetryLine = useMemo(() => {
    const ofMission = missionHandoffs.filter(
      (handoff) => handoff.missionId === missionId,
    );
    const aggregate = aggregateMissionTelemetry(ofMission);
    return aggregate ? formatMissionTelemetry(aggregate) : null;
  }, [missionHandoffs, missionId]);
  const layoutRoot = useLayoutStore((state) => state.root);
  const firstVisibleMissionPaneId = useMemo(
    () =>
      listPanes(layoutRoot).find(
        (pane) =>
          (pane.missionId ?? paneMissions[pane.id]) === missionId,
      )?.id ?? null,
    [layoutRoot, missionId, paneMissions],
  );
  const hasVisibleMissionPanes = firstVisibleMissionPaneId !== null;
  const openMountedMissionTerminals = () => {
    onOpenTerminals(missionId);
    if (firstVisibleMissionPaneId) {
      useLayoutStore.getState().focus(firstVisibleMissionPaneId);
    }
  };
  const lifecycleAction: MissionListAction = missionBoardLifecycleAction(
    snapshot?.id === missionId ? snapshot.state : null,
    currentMission,
    hasVisibleMissionPanes,
  );
  const lifecycleCopy = missionActionCopy(lifecycleAction);

  const selectedAgentId = useMissionInspectorStore(
    (state) => state.selectedAgentId,
  );
  const selectAgent = useMissionInspectorStore((state) => state.selectAgent);

  useEffect(() => {
    let cancelled = false;
    const sessionGeneration = ++sessionGenerationRef.current;

    setSnapshot(null);
    setEvents([]);
    setOperatorDirectionEvents([]);
    eventsRef.current = [];
    olderPagesLoadedRef.current = false;
    setJournalHistory(EMPTY_JOURNAL_HISTORY);
    setLoading(true);
    setLoadError(null);
    setCommandError(null);
    setActionAnnouncement(null);
    setJournalError(null);
    setPendingAction(null);
    setQuestionState(emptyQuestionState());
    actionPendingRef.current = false;

    const isCurrentSession = (): boolean =>
      !cancelled &&
      missionIdRef.current === missionId &&
      sessionGenerationRef.current === sessionGeneration;

    const refreshSnapshot = async (): Promise<void> => {
      const requestGeneration = ++snapshotGenerationRef.current;
      if (isCurrentSession() && snapshotRef.current?.id !== missionId) {
        setLoading(true);
        setLoadError(null);
      }

      try {
        const nextSnapshot = await window.nexus.mission.snapshot(missionId);
        if (
          !isCurrentSession() ||
          snapshotGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        setSnapshot((current) => preferNewestSnapshot(current, nextSnapshot));
        setLoadError(null);
        setCommandError(null);
      } catch (reason) {
        if (
          isCurrentSession() &&
          snapshotGenerationRef.current === requestGeneration
        ) {
          setLoadError(
            toUserFacingMissionRecovery(
              reason,
              'Não foi possível carregar o estado atual da missão. Tente novamente.',
            ),
          );
        }
      } finally {
        if (
          isCurrentSession() &&
          snapshotGenerationRef.current === requestGeneration
        ) {
          setLoading(false);
        }
      }
    };

    const refreshJournal = async (): Promise<void> => {
      const requestGeneration = ++journalGenerationRef.current;
      try {
        const recent = await window.nexus.orch.missionEventsRecent({
          missionId,
          limit: RECENT_EVENT_LIMIT,
        });
        if (
          !isCurrentSession() ||
          journalGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        setJournalError(
          recent.enabled !== false && recent.error
            ? toUserFacingMissionRecovery(
                recent.error,
                'Não foi possível carregar toda a atividade recente. Tente novamente.',
              )
            : null,
        );
        const recentEvents =
          recent.enabled === false
            ? []
            : parseJournalEvents(recent.events, missionId);
        // F-1005: páginas antigas pedidas pelo operador sobrevivem à
        // atualização enquanto encostam na janela recente.
        const merged = olderPagesLoadedRef.current
          ? mergeRecentJournalWindow(eventsRef.current, recentEvents)
          : { events: recentEvents, keptOlder: false };
        olderPagesLoadedRef.current = merged.keptOlder;
        eventsRef.current = merged.events;
        setEvents(merged.events);
        setJournalHistory((current) => ({
          total: typeof recent.total === 'number' ? recent.total : null,
          hasMore: merged.keptOlder ? current.hasMore : recent.hasMore === true,
          loading: current.loading,
        }));
        // D2: a janela recente é de TODOS os eventos (cada chamada de ferramenta
        // de cada pane conta) e empurra a orientação do operador para fora dela
        // em minutos. Orientação e desfecho moram numa corrida própria: busca só
        // essa e a aba Conversa mescla com a janela, sem tocar na paginação.
        try {
          const replay = await window.nexus.orch.missionEventsReplay?.({
            missionId,
            runId: OPERATOR_DIRECTION_RUN_ID,
            limit: OPERATOR_DIRECTION_REPLAY_LIMIT,
          });
          if (
            replay &&
            !replay.error &&
            isCurrentSession() &&
            journalGenerationRef.current === requestGeneration
          ) {
            setOperatorDirectionEvents(
              replay.enabled === false
                ? []
                : parseJournalEvents(replay.events, missionId),
            );
          }
        } catch {
          // Evidência suplementar: a lista segue com a última leitura boa.
        }
      } catch (reason) {
        if (
          isCurrentSession() &&
          journalGenerationRef.current === requestGeneration
        ) {
          setJournalError(
            toUserFacingMissionRecovery(
              reason,
              'Não foi possível carregar a atividade recente. Tente novamente.',
            ),
          );
        }
        // The journal is supplementary evidence; retain the last good view.
      }
    };

    // F-1005: "carregar mais" pede ao Main só a página anterior à sequência
    // mais antiga na tela — o histórico nunca vem inteiro para o renderer.
    let olderPending = false;
    const loadOlderJournal = async (): Promise<void> => {
      const before = eventsRef.current[0]?.sequence;
      if (olderPending || before === undefined) return;
      olderPending = true;
      setJournalHistory((current) => ({ ...current, loading: true }));
      try {
        const page = await window.nexus.orch.missionEventsRecent({
          missionId,
          limit: RECENT_EVENT_LIMIT,
          beforeSequence: before,
        });
        // A janela mudou no meio (troca de missão ou atualização com buraco):
        // a página não encosta mais em nada — descarta.
        if (!isCurrentSession() || eventsRef.current[0]?.sequence !== before) {
          return;
        }
        if (page.error) {
          setJournalError(
            toUserFacingMissionRecovery(
              page.error,
              'Não foi possível carregar a atividade anterior. Tente novamente.',
            ),
          );
          return;
        }
        const older = parseJournalEvents(page.events, missionId);
        const next = prependOlderJournalPage(eventsRef.current, older);
        olderPagesLoadedRef.current = true;
        eventsRef.current = next;
        setEvents(next);
        setJournalHistory((current) => ({
          total: typeof page.total === 'number' ? page.total : current.total,
          hasMore: page.hasMore === true,
          loading: current.loading,
        }));
      } catch (reason) {
        if (isCurrentSession()) {
          setJournalError(
            toUserFacingMissionRecovery(
              reason,
              'Não foi possível carregar a atividade anterior. Tente novamente.',
            ),
          );
        }
      } finally {
        olderPending = false;
        if (isCurrentSession()) {
          setJournalHistory((current) => ({ ...current, loading: false }));
        }
      }
    };

    refreshSnapshotRef.current = () => void refreshSnapshot();
    refreshJournalRef.current = () => void refreshJournal();
    loadOlderJournalRef.current = () => void loadOlderJournal();

    const unsubscribe = window.nexus.mission.onChanged((items) => {
      if (
        isCurrentSession() &&
        items.some((item) => item.id === missionId)
      ) {
        void refreshSnapshot();
        void refreshJournal();
      }
    });

    void refreshSnapshot();
    void refreshJournal();

    return () => {
      cancelled = true;
      unsubscribe();
      if (sessionGenerationRef.current === sessionGeneration) {
        sessionGenerationRef.current += 1;
      }
      snapshotGenerationRef.current += 1;
      journalGenerationRef.current += 1;
      actionGenerationRef.current += 1;
      actionPendingRef.current = false;
      if (refreshSnapshotRef.current) refreshSnapshotRef.current = null;
      if (refreshJournalRef.current) refreshJournalRef.current = null;
      loadOlderJournalRef.current = null;
    };
  }, [missionId]);

  const journal = useMemo<MissionJournalHistory>(
    () => ({
      ...journalHistory,
      onLoadMore: () => loadOlderJournalRef.current?.(),
    }),
    [journalHistory],
  );

  const currentSnapshot = snapshot?.id === missionId ? snapshot : null;
  const questionKey = currentSnapshot?.question
    ? `${currentSnapshot.id}:${currentSnapshot.question.id}`
    : null;

  useEffect(() => {
    setQuestionState(emptyQuestionState());
  }, [questionKey]);
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    const updateDimensions = (width: number, height: number): void => {
      const nextDimensions = {
        width: Math.max(0, width),
        height: Math.max(0, height),
      };

      setWorkspaceDimensions((current) =>
        current.width === nextDimensions.width &&
        current.height === nextDimensions.height
          ? current
          : nextDimensions,
      );
    };

    const initialRect = workspace.getBoundingClientRect();
    updateDimensions(initialRect.width, initialRect.height);

    if (typeof ResizeObserver === 'undefined') {
      return () => dragCleanupRef.current?.();
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry?.target === workspace) {
        updateDimensions(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(workspace);

    return () => {
      observer.disconnect();
      dragCleanupRef.current?.();
    };
  }, [currentSnapshot?.id]);

  const splitterOrientation = workspaceOrientation(workspaceDimensions.width);
  const isSideBySide = splitterOrientation === 'vertical';
  const stackedExtent = workspaceDimensions.height;
  const stackedInspectorHeight =
    stackedExtent > 0
      ? Math.round(
          clampStackedInspectorHeight(
            stackedInspectorRatio * stackedExtent,
            stackedExtent,
          ),
        )
      : 0;
  const inspectorMinimum = isSideBySide
    ? MISSION_INSPECTOR_WIDTH_MIN
    : stackedExtent * STACKED_INSPECTOR_MIN_RATIO;
  const inspectorMaximum = isSideBySide
    ? MISSION_INSPECTOR_WIDTH_MAX
    : stackedExtent * STACKED_INSPECTOR_MAX_RATIO;
  const inspectorSize = isSideBySide ? inspectorWidth : stackedInspectorHeight;
  const stackedInspectorPercent =
    stackedExtent > 0
      ? Math.round((stackedInspectorHeight / stackedExtent) * 100)
      : STACKED_INSPECTOR_DEFAULT_RATIO * 100;
  const inspectorValueText = isSideBySide
    ? `Inspetor com ${inspectorWidth}px de largura`
    : `Inspetor ocupa ${stackedInspectorPercent}% da altura do quadro`;
  // A medida viva mora na raiz do quadro como CSS var: o CSS lê, nenhum filho
  // carrega `style` próprio.
  const boardStyle = {
    '--nexus-inspector-w': `${inspectorWidth}px`,
    '--mission-inspector-size':
      stackedExtent > 0 ? `${stackedInspectorHeight}px` : '40%',
  } as CSSProperties;

  const resizeStackedInspectorTo = (size: number, extent: number): void => {
    if (extent <= 0) return;
    setStackedInspectorRatio(
      clampStackedInspectorHeight(size, extent) / extent,
    );
  };

  const handleSplitterKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    let nextSize: number;
    switch (event.key) {
      case 'Home':
        nextSize = inspectorMinimum;
        break;
      case 'End':
        nextSize = inspectorMaximum;
        break;
      case 'ArrowLeft':
        if (!isSideBySide) return;
        nextSize = inspectorSize + SPLITTER_KEYBOARD_STEP;
        break;
      case 'ArrowRight':
        if (!isSideBySide) return;
        nextSize = inspectorSize - SPLITTER_KEYBOARD_STEP;
        break;
      case 'ArrowUp':
        if (isSideBySide) return;
        nextSize = inspectorSize + SPLITTER_KEYBOARD_STEP;
        break;
      case 'ArrowDown':
        if (isSideBySide) return;
        nextSize = inspectorSize - SPLITTER_KEYBOARD_STEP;
        break;
      default:
        return;
    }

    event.preventDefault();
    if (isSideBySide) {
      setInspectorWidth(nextSize);
      return;
    }
    resizeStackedInspectorTo(nextSize, stackedExtent);
  };

  const resizeInspectorAt = (clientX: number, clientY: number): void => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    const rect = workspace.getBoundingClientRect();
    if (workspaceOrientation(rect.width) === 'vertical') {
      setInspectorWidth(rect.right - clientX);
      return;
    }

    const nextDimensions = { width: rect.width, height: rect.height };
    setWorkspaceDimensions((current) =>
      current.width === nextDimensions.width &&
      current.height === nextDimensions.height
        ? current
        : nextDimensions,
    );
    resizeStackedInspectorTo(rect.bottom - clientY, rect.height);
  };

  const beginPointerDrag = (
    onMove: (moveEvent: MouseEvent) => void,
    onRelease?: () => void,
  ): void => {
    dragCleanupRef.current?.();

    function finishDrag(): void {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', finishDrag);
      if (dragCleanupRef.current === finishDrag) {
        dragCleanupRef.current = null;
      }
    }

    function handleMouseUp(): void {
      finishDrag();
      onRelease?.();
    }

    dragCleanupRef.current = finishDrag;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', finishDrag);
  };

  const handleSplitterMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.focus();
    beginPointerDrag((moveEvent) => {
      resizeInspectorAt(moveEvent.clientX, moveEvent.clientY);
    });
  };

  const handleRailMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.focus();
    const startX = event.clientX;
    const startY = event.clientY;
    const railOrientation = splitterOrientation;
    let expanded = false;
    beginPointerDrag(
      (moveEvent) => {
        // Arrastar para dentro do quadro é puxar o inspetor de volta.
        const travel =
          railOrientation === 'vertical'
            ? startX - moveEvent.clientX
            : startY - moveEvent.clientY;
        if (!expanded) {
          if (travel < INSPECTOR_RAIL_EXPAND_THRESHOLD) return;
          expanded = true;
          expandInspectorFromRail();
        }
        resizeInspectorAt(moveEvent.clientX, moveEvent.clientY);
      },
      () => {
        // Sem arraste o gesto foi um clique: reabre na medida guardada.
        if (!expanded) expandInspectorFromRail();
      },
    );
  };

  const handleRailKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    const opensInspector =
      event.key === 'Enter' ||
      event.key === ' ' ||
      (isSideBySide ? event.key === 'ArrowLeft' : event.key === 'ArrowUp');
    if (!opensInspector) return;
    event.preventDefault();
    expandInspectorFromRail();
  };

  const beginBoardAction = (
    action: PendingBoardAction,
    invoker: HTMLButtonElement,
  ): BoardActionAttempt | null => {
    if (actionPendingRef.current) return null;

    actionPendingRef.current = true;
    const attempt: BoardActionAttempt = {
      requestedMissionId: missionId,
      requestGeneration: ++actionGenerationRef.current,
      sessionGeneration: sessionGenerationRef.current,
      invoker,
    };
    setPendingAction(action);
    setCommandError(null);
    setActionAnnouncement(null);
    return attempt;
  };

  const isCurrentBoardAction = (attempt: BoardActionAttempt): boolean =>
    missionIdRef.current === attempt.requestedMissionId &&
    sessionGenerationRef.current === attempt.sessionGeneration &&
    actionGenerationRef.current === attempt.requestGeneration;

  const finishBoardAction = (
    attempt: BoardActionAttempt,
    restoreFocus: boolean,
  ): void => {
    if (!isCurrentBoardAction(attempt)) return;

    actionPendingRef.current = false;
    setPendingAction(null);
    if (!restoreFocus) return;

    window.setTimeout(() => {
      if (isCurrentBoardAction(attempt) && attempt.invoker.isConnected) {
        attempt.invoker.focus({ preventScroll: true });
      }
    }, 0);
  };

  const routeAfterLifecycleSuccess = (): void => {
    const navigation = useProductNavigationStore.getState();
    if (useWorkspaceStore.getState().current) {
      navigation.openTerminal();
    } else {
      navigation.openLauncher();
    }
  };

  const executeCommand = useCallback(
    async (command: MissionEngineCommand): Promise<MissionSnapshot> => {
      const requestedMissionId = missionId;
      const sessionGeneration = sessionGenerationRef.current;
      const nextSnapshot = await window.nexus.mission.command(command);
      const isCurrent =
        missionIdRef.current === requestedMissionId &&
        sessionGenerationRef.current === sessionGeneration;

      if (isCurrent) {
        setSnapshot((current) => preferNewestSnapshot(current, nextSnapshot));
        setLoadError(null);
        setCommandError(null);
        if (command.kind === 'direct') refreshJournalRef.current?.();
      }
      return nextSnapshot;
    },
    [missionId],
  );

  // WEB-17: "Citar" na timeline leva trecho + origem estável do evento ao
  // composer da barra. A origem sai do journal (evento, run, pane), nunca da
  // posição do item na lista.
  const [pendingQuote, setPendingQuote] = useState<QuoteDraft | null>(null);
  const quoteNonceRef = useRef(0);
  const quoteActivity = useCallback((item: TimelineItemModel) => {
    const current = snapshotRef.current;
    if (!current || current.id !== missionIdRef.current) return;
    const agent = item.paneId
      ? current.agents.find((candidate) => candidate.paneId === item.paneId)
      : undefined;
    const origin: QuoteOrigin = {
      missionId: current.id,
      eventId: item.id,
      sequence: item.sequence,
      ...(item.runId ? { runId: item.runId } : {}),
      ...(item.paneId ? { paneId: item.paneId } : {}),
      ...(agent ? { agentName: agent.agentName } : {}),
    };
    const excerpt = [item.subtitle, item.detail].filter(Boolean).join('\n');
    quoteNonceRef.current += 1;
    setPendingQuote({
      origin,
      text: formatQuote(origin, item.title, excerpt || item.title),
      nonce: quoteNonceRef.current,
    });
  }, []);
  const consumeQuote = useCallback((nonce: number) => {
    setPendingQuote((current) => (current?.nonce === nonce ? null : current));
  }, []);

  const runHeaderAction = (
    action: HeaderAction,
    invoker: HTMLButtonElement,
  ): void => {
    const attempt = beginBoardAction(action, invoker);
    if (!attempt) return;

    void (async () => {
      let restoreFocus = false;
      try {
        const reopenForAdjustment =
          action === 'resume' && snapshotRef.current?.state === 'completed';
        await executeCommand({ kind: action, missionId });
        if (action === 'resume' && isCurrentBoardAction(attempt)) {
          useMissionInspectorStore.getState().selectTab('chat');
          if (!reopenForAdjustment) {
            setActionAnnouncement(
              'Retomada em andamento — os agentes voltam em instantes.',
            );
          }
          if (reopenForAdjustment) {
            setActionAnnouncement(
              'Diga o ajuste embaixo. A missão não fecha até você orientar.',
            );
          }
        }
      } catch (reason) {
        if (isCurrentBoardAction(attempt)) {
          setCommandError(
            toUserFacingMissionRecovery(
              reason,
              'Não foi possível executar esta ação. Tente novamente.',
            ),
          );
          restoreFocus = true;
        }
      } finally {
        finishBoardAction(attempt, restoreFocus);
      }
    })();
  };

  // leader-drift: o Maestro religou a CLI numa sessão nova e a missão ainda
  // aponta a que morreu. A ação religa a sessão viva; os desfechos sem
  // rebind orientam o operador sem derrubar a tela.
  const runLeaderDriftRebind = (invoker: HTMLButtonElement): void => {
    const attempt = beginBoardAction('leader-drift-rebind', invoker);
    if (!attempt) return;

    void (async () => {
      let restoreFocus = false;
      try {
        const result = await rebindLiveMaestroOfMission(missionId);
        if (!isCurrentBoardAction(attempt)) return;
        if (result === 'rebound') {
          // A liderança durável mudou no Main: o refresh normal do snapshot
          // limpa o "Precisa de reparo" sozinho.
          refreshSnapshotRef.current?.();
          return;
        }
        setActionAnnouncement(
          result === 'no-live-maestro'
            ? 'O terminal do Maestro não está vivo — abra Terminais e use Retomar.'
            : 'O Nexus recusou religar a missão. Tente novamente neste quadro.',
        );
        restoreFocus = true;
      } catch (reason) {
        if (isCurrentBoardAction(attempt)) {
          setCommandError(
            toUserFacingMissionRecovery(
              reason,
              'Não foi possível religar a missão ao Maestro. Tente novamente.',
            ),
          );
          restoreFocus = true;
        }
      } finally {
        finishBoardAction(attempt, restoreFocus);
      }
    })();
  };

  const runLifecycleAction = (
    invoker: HTMLButtonElement,
    actionOverride?: MissionListAction,
  ): void => {
    const mission = currentMission;
    const action = actionOverride ?? lifecycleAction;
    if (action === 'none') return;
    if (!mission && action !== 'remove') return;

    const attempt = beginBoardAction(action, invoker);
    if (!attempt) return;

    void (async () => {
      let restoreFocus = false;
      try {
        if (action === 'close-runtime' || action === 'stop-recovery') {
          if (!mission) return;
          const result = await closeMissionRuntimeAndPanes(
            mission.id,
            'mission-board-close',
          );
          if (!isCurrentBoardAction(attempt)) return;

          if (!result.ok && result.cancelled) {
            setActionAnnouncement(
              action === 'stop-recovery'
                ? 'Parada da recuperação cancelada.'
                : 'Encerramento cancelado.',
            );
            restoreFocus = true;
            return;
          }
          if (!result.ok) {
            setCommandError(
              toUserFacingMissionRecovery(
                result.error,
                'Não foi possível encerrar a missão com segurança. Tente novamente.',
              ),
            );
            restoreFocus = true;
            return;
          }

          setActionAnnouncement(
            action === 'stop-recovery'
              ? 'Recuperação automática parada. Histórico preservado.'
              : closeMissionNote(result.terminatedSessionIds.length),
          );
          routeAfterLifecycleSuccess();
          return;
        }

        if (action === 'complete') {
          if (!mission) return;
          const result = await window.nexus.orch.completeMissionByOperator(
            mission.id,
          );
          if (!isCurrentBoardAction(attempt)) return;

          if (!result.ok && result.cancelled) {
            setActionAnnouncement('Conclusão cancelada.');
            restoreFocus = true;
            return;
          }
          if (!result.ok) {
            setCommandError(
              toUserFacingMissionRecovery(
                result.error,
                'Não foi possível marcar a missão como concluída. Tente novamente.',
              ),
            );
            restoreFocus = true;
            return;
          }

          setActionAnnouncement(
            'Missão marcada como concluída. Histórico preservado.',
          );
          refreshSnapshotRef.current?.();
          return;
        }

        if (action === 'remove') {
          const prompt = removeMissionPrompt({
            title: mission?.title ?? snapshotRef.current?.title ?? 'missão',
          });
          const confirmed = await askConfirm({ ...prompt, danger: true });
          if (!isCurrentBoardAction(attempt)) return;
          if (!confirmed) {
            setActionAnnouncement('Remoção cancelada.');
            restoreFocus = true;
            return;
          }

          const result = await window.nexus.orch.removeMission(
            mission?.id ?? missionId,
          );
          if (!isCurrentBoardAction(attempt)) return;
          setActionAnnouncement(
            result.removed
              ? 'Missão removida.'
              : 'A missão já não estava na lista.',
          );
          routeAfterLifecycleSuccess();
          return;
        }

        if (!mission) return;
        const prompt = discardMissionPrompt(mission);
        const confirmed = await askConfirm({ ...prompt, danger: true });
        if (!isCurrentBoardAction(attempt)) return;
        if (!confirmed) {
          setActionAnnouncement('Descarte cancelado.');
          restoreFocus = true;
          return;
        }

        const result = await window.nexus.orch.removeMission(mission.id);
        if (!isCurrentBoardAction(attempt)) return;
        setActionAnnouncement(
          result.removed
            ? 'Missão descartada.'
            : 'A missão já não estava na lista.',
        );
        routeAfterLifecycleSuccess();
      } catch (reason) {
        if (isCurrentBoardAction(attempt)) {
          const fallback =
            action === 'discard'
              ? 'Não foi possível descartar a missão. Tente novamente.'
              : action === 'remove'
                ? 'Não foi possível remover a missão. Tente novamente.'
                : action === 'complete'
                  ? 'Não foi possível marcar a missão como concluída. Tente novamente.'
                : 'Não foi possível encerrar a missão com segurança. Tente novamente.';
          setCommandError(toUserFacingMissionRecovery(reason, fallback));
          restoreFocus = true;
        }
      } finally {
        finishBoardAction(attempt, restoreFocus);
      }
    })();
  };

  if (!currentSnapshot) {
    return (
      <section
        className="mission-board mission-board--loading"
        aria-label="Quadro da missão"
        aria-busy={loading}
      >
        {loadError ? (
          <div className="mission-board__inline-error" role="alert">
            <p>{loadError}</p>
            <button
              type="button"
              className="mission-board__button mission-board__button--secondary"
              onClick={() => refreshSnapshotRef.current?.()}
            >
              Tentar novamente
            </button>
            <button
              type="button"
              className="mission-board__button mission-board__button--secondary"
              onClick={() => useProductNavigationStore.getState().openLauncher()}
            >
              Voltar ao Início
            </button>
          </div>
        ) : (
          <p className="mission-board__loading" role="status" aria-live="polite">
            Carregando missão…
          </p>
        )}
      </section>
    );
  }

  const primaryAction = primaryHeaderAction(
    currentSnapshot.allowedActions,
    currentSnapshot.stateReason?.code,
  );
  const visibleHeaderActions = HEADER_ACTIONS.filter(
    (action) =>
      currentSnapshot.allowedActions.includes(action) &&
      (action !== 'stop' || currentMission === null),
  );
  const secondaryHeaderActions = visibleHeaderActions.filter(
    (action) => action !== primaryAction,
  );
  const canAnswerQuestion =
    currentSnapshot.allowedActions.includes('answer-question');
  const question = currentSnapshot.question ? (
    canAnswerQuestion ? (
      <MissionQuestion
        missionId={missionId}
        question={currentSnapshot.question}
        state={questionState}
        onStateChange={setQuestionState}
        onCommand={executeCommand}
        onDismiss={async () => {
          const questionId = currentSnapshot.question?.id;
          if (!questionId) return;
          await window.nexus.orch.answerClarify({
            missionId,
            questionId,
            dismiss: true,
          });
          const nextSnapshot = await window.nexus.mission.snapshot(missionId);
          setSnapshot((current) => preferNewestSnapshot(current, nextSnapshot));
        }}
      />
    ) : (
      <section
        className="mission-board__question mission-board__question--readonly"
        aria-label="Pergunta aguardando liberação"
      >
        <h3 className="mission-board__question-prompt">
          {currentSnapshot.question.prompt}
        </h3>
        {currentSnapshot.question.detail && (
          <p className="mission-board__question-detail">
            {currentSnapshot.question.detail}
          </p>
        )}
        <p className="mission-board__question-detail">
          A resposta não está disponível no estado atual da missão.
        </p>
      </section>
    )
  ) : null;

  // Interrompida: o card nomeia o motivo e devolve a equipe — reaproveita a
  // primária do cabeçalho, sem criar uma segunda. Com pergunta pendente o
  // caminho continua sendo "Responder", nunca "Retomar".
  const interruptedCard =
    currentMission != null &&
    currentSnapshot.question == null &&
    missionIsInterrupted(
      currentMission,
      currentSnapshot.stateReason?.code,
      currentSnapshot.state,
    );
  const primaryButton =
    primaryAction === 'leader-drift-rebind' ? (
      <button
        type="button"
        className="mission-board__button"
        data-mission-command="leader-drift-rebind"
        disabled={pendingAction !== null}
        aria-busy={pendingAction === 'leader-drift-rebind'}
        onClick={(event) => runLeaderDriftRebind(event.currentTarget)}
      >
        Religar a missão ao Maestro
      </button>
    ) : primaryAction === 'resume' || primaryAction === 'retry-kickoff' ? (
      <button
        type="button"
        className="mission-board__button"
        disabled={pendingAction !== null}
        aria-busy={pendingAction === primaryAction}
        onClick={(event) =>
          runHeaderAction(primaryAction, event.currentTarget)
        }
      >
        {headerActionLabel(primaryAction, currentSnapshot.state)}
      </button>
    ) : null;

  return (
    <article
      className={
        boardCollapsed ? 'mission-board mission-board--collapsed' : 'mission-board'
      }
      data-board-collapsed={boardCollapsed}
      data-state={currentSnapshot.state}
      aria-labelledby={headingId}
      aria-busy={loading || pendingAction !== null}
      style={boardStyle}
    >
      <header
        className={
          moreOpen
            ? 'mission-board__header mission-board__header--menu-open'
            : 'mission-board__header'
        }
      >
        <div className="mission-board__identity">
          <h1 id={headingId} title={currentSnapshot.title}>
            {missionBoardHeading(currentSnapshot.title)}
          </h1>
          <p className="mission-board__workspace">
            {currentSnapshot.workspaceLabel}
          </p>
        </div>

        <div
          className="mission-board__status-group"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span
            className="mission-board__status"
            data-state={currentSnapshot.state}
          >
            {missionLifecycleLabel(
              currentSnapshot.state,
              false,
              currentSnapshot.stateReason?.code,
              Boolean(
                currentMission && missionAwaitsOperatorReview(currentMission),
              ),
            )}
          </span>
          {/* Sem tasks planejadas (Via Rápida) o contador some — correto, mas
              deixava a pessoa sem NENHUM sinal durante todo o trabalho, e a
              missão parecia travada. A contagem vem dos agentes, que existem
              sempre. */}
          {currentSnapshot.progress.total === 0 &&
            MISSION_LIVE_STATES.has(currentSnapshot.state) &&
            currentSnapshot.stateReason?.code !==
              MISSION_AWAITING_INSTRUCTION_REASON_CODE && (
              <span className="mission-board__progress-line">
                {qualitativeProgress(currentSnapshot.agents)?.line ??
                  'A equipe está começando'}
              </span>
            )}
          {currentSnapshot.progress.total > 0 && (
            <div className="mission-board__progress">
              <span>
                {currentSnapshot.progress.completed} /{' '}
                {currentSnapshot.progress.total}
              </span>
              <progress
                aria-label={`Progresso da missão: ${currentSnapshot.progress.completed} de ${currentSnapshot.progress.total}`}
                value={currentSnapshot.progress.completed}
                max={currentSnapshot.progress.total}
              >
                {currentSnapshot.progress.completed} de{' '}
                {currentSnapshot.progress.total}
              </progress>
            </div>
          )}
          {MISSION_LIVE_STATES.has(currentSnapshot.state) &&
            currentSnapshot.stateReason?.code !==
              MISSION_AWAITING_INSTRUCTION_REASON_CODE && (
              <span className="mission-board__background-notice">
                {MISSION_BACKGROUND_NOTICE}
              </span>
            )}
          {telemetryLine && (
            <span
              className="mission-board__telemetry"
              title="Duração e tokens autorrelatados pelos agentes nos handoffs desta missão"
            >
              {telemetryLine}
            </span>
          )}
        </div>

        {interruptedCard ? (
          <MissionInterruptedCard
            missionId={missionId}
            focusAction
            action={primaryButton}
            onOpenWhy={() =>
              useMissionInspectorStore
                .getState()
                .selectMissionTab(missionId, 'activity')
            }
          />
        ) : (
          currentSnapshot.stateReason && (
            <p className="mission-board__reason">
              <strong>{currentSnapshot.stateReason.label}</strong>
              {currentSnapshot.stateReason.detail && (
                <span>{currentSnapshot.stateReason.detail}</span>
              )}
            </p>
          )
        )}

        <div className="mission-board__actions" aria-label="Ações da missão">
          {/* leader-drift: o terminal do Maestro está vivo numa sessão nova e
              a missão ainda aponta a que morreu — a ação primária aqui é
              religar, não parar. */}
          {!interruptedCard && primaryButton}
          <div className="mission-board__more">
            <button
              ref={moreButtonRef}
              type="button"
              className="mission-board__button mission-board__button--secondary mission-board__more-button"
              aria-label="Mais ações da missão"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-controls={moreMenuId}
              onClick={() => setMoreOpen((current) => !current)}
            >
              Mais
            </button>
            <div
              ref={moreMenuRef}
              id={moreMenuId}
              className="mission-board__menu"
              role="menu"
              aria-label="Mais ações da missão"
              hidden={!moreOpen}
              onKeyDown={handleMoreMenuKeyDown}
            >
          {/* Sempre no quadro: o destino é a superfície da missão, nunca o
              grid global. Sem pane, o mosaico vazio ensina; com pane, foca. */}
          <button
            type="button"
            className="mission-board__button mission-board__button--secondary"
            disabled={pendingAction !== null}
            role="menuitem"
            onClick={() => {
              setMoreOpen(false);
              openMountedMissionTerminals();
            }}
          >
            Terminais
          </button>
          {/* F-527: com uma missão rolando, começar outra exigia sair da
              superfície e achar o rail. Aqui é 1 clique → Caminho Expresso. */}
          <button
            type="button"
            className="mission-board__button mission-board__button--secondary"
            onClick={() =>
              {
                setMoreOpen(false);
                useProductNavigationStore.getState().openNewMission();
              }
            }
            role="menuitem"
          >
            + Nova missão
          </button>
          {secondaryHeaderActions.map((action) => (
            <button
              key={action}
              type="button"
              className={`mission-board__button mission-board__button--secondary${
                action === 'stop' ? ' mission-board__button--danger' : ''
              }`}
              disabled={pendingAction !== null}
              aria-busy={pendingAction === action}
              role="menuitem"
              onClick={() =>
                runFromMoreMenu((invoker) => runHeaderAction(action, invoker))
              }
            >
              {headerActionLabel(action, currentSnapshot.state)}
            </button>
          ))}
          {(currentMission || lifecycleAction === 'remove') &&
            lifecycleAction !== 'none' && (
            <button
              type="button"
              className={
                lifecycleAction === 'complete'
                  ? 'mission-board__button mission-board__button--secondary'
                  : 'mission-board__button mission-board__button--secondary mission-board__button--danger'
              }
              title={lifecycleCopy.title}
              aria-label={`${lifecycleCopy.verb}: ${lifecycleCopy.title}`}
              disabled={pendingAction !== null}
              aria-busy={pendingAction === lifecycleAction}
              role="menuitem"
              onClick={() =>
                runFromMoreMenu((invoker) => runLifecycleAction(invoker))
              }
            >
              {lifecycleCopy.verb}
            </button>
          )}
          {/* Ordem do operador (20/08): Remover SEMPRE disponível — o main já
              encerra o runtime antes de apagar, a escada Encerrar→Concluir→
              Remover era cerimônia de UI. Confirm de perigo continua. */}
          {currentMission && lifecycleAction !== 'remove' && (
            <button
              type="button"
              className="mission-board__button mission-board__button--secondary mission-board__button--danger"
              title="Apagar missão e todo o histórico desta execução"
              aria-label="Remover: apagar missão e todo o histórico desta execução"
              disabled={pendingAction !== null}
              aria-busy={pendingAction === 'remove'}
              role="menuitem"
              onClick={() =>
                runFromMoreMenu((invoker) =>
                  runLifecycleAction(invoker, 'remove'),
                )
              }
            >
              Remover
            </button>
          )}
            </div>
          </div>
          <button
            type="button"
            className="mission-board__button mission-board__button--secondary mission-board__collapse-toggle"
            aria-expanded={!boardCollapsed}
            aria-controls={boardBodyId}
            aria-label={
              boardCollapsed
                ? 'Expandir painel da missão'
                : 'Minimizar painel da missão'
            }
            title={
              boardCollapsed
                ? 'Expandir painel da missão'
                : 'Minimizar painel da missão'
            }
            onClick={toggleBoardCollapsed}
          >
            {boardCollapsed ? 'Expandir' : 'Minimizar'}
          </button>
        </div>
      </header>


      {loadError && (
        <div className="mission-board__inline-error" role="alert">
          <p>{loadError}</p>
          <button
            type="button"
            className="mission-board__button mission-board__button--secondary"
            onClick={() => refreshSnapshotRef.current?.()}
          >
            Tentar novamente
          </button>
        </div>
      )}

      {journalError && (
        <div className="mission-board__inline-error">
          <p role="status" aria-live="polite">
            {journalError}
          </p>
          <button
            type="button"
            className="mission-board__button mission-board__button--secondary"
            onClick={() => refreshJournalRef.current?.()}
          >
            Tentar carregar atividade
          </button>
        </div>
      )}

      {commandError && (
        <p className="mission-board__inline-error" role="alert">
          {commandError}
        </p>
      )}

      {actionAnnouncement && (
        <p
          className="mission-board__announcement"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {actionAnnouncement}
        </p>
      )}

      <div
        id={boardBodyId}
        className="mission-board__body"
        hidden={boardCollapsed}
      >
      {question && (
        <section
          className="mission-board__question-region"
          aria-label="Pergunta pendente"
        >
          {question}
        </section>
      )}

      <div
        ref={workspaceRef}
        className="mission-board__workspace-layout"
      >
        <div className="mission-board__graph-region">
          <MissionGraph
            snapshot={currentSnapshot}
            selectedAgentId={selectedAgentId}
            onSelectAgent={selectAgent}
            onOpenAgentPane={(paneId) => {
              openMountedMissionTerminals();
              useLayoutStore.getState().focus(paneId);
            }}
            onRetry={() => refreshSnapshotRef.current?.()}
          />
          <button
            type="button"
            className="mission-board__inspector-toggle"
            onClick={toggleInspectorCollapsed}
            aria-expanded={!inspectorCollapsed}
            aria-controls={inspectorRegionId}
            title={
              inspectorCollapsed
                ? 'Mostrar o painel de detalhes da missão'
                : 'Fechar o painel de detalhes e deixar só o time'
            }
          >
            {inspectorCollapsed ? '‹ detalhes' : 'detalhes ›'}
          </button>
        </div>
        {inspectorCollapsed ? (
          // Recolhido, sobra um trilho de 8px na borda onde o inspetor
          // reabre: clique, arraste para dentro ou Enter trazem o painel
          // de volta sem depender do botão "detalhes".
          <div
            className="mission-board__inspector-rail"
            role="separator"
            tabIndex={0}
            aria-label="Reabrir inspetor da missão"
            aria-orientation={splitterOrientation}
            aria-valuemin={0}
            aria-valuemax={Math.round(inspectorMaximum)}
            aria-valuenow={0}
            aria-valuetext="Inspetor recolhido"
            title="Clique ou arraste para reabrir o inspetor"
            onKeyDown={handleRailKeyDown}
            onMouseDown={handleRailMouseDown}
          />
        ) : (
          <>
            <div
              ref={splitterRef}
              className="mission-board__splitter"
              role="separator"
              tabIndex={0}
              aria-label="Redimensionar inspetor da missão"
              aria-controls={inspectorRegionId}
              aria-orientation={splitterOrientation}
              aria-valuemin={Math.round(inspectorMinimum)}
              aria-valuemax={Math.round(inspectorMaximum)}
              aria-valuenow={inspectorSize}
              aria-valuetext={inspectorValueText}
              title={
                isSideBySide
                  ? 'Arraste para ajustar a largura; clique duplo restaura o padrão'
                  : 'Arraste para ajustar a altura'
              }
              onKeyDown={handleSplitterKeyDown}
              onMouseDown={handleSplitterMouseDown}
              onDoubleClick={isSideBySide ? resetInspectorWidth : undefined}
            />
            <div
              id={inspectorRegionId}
              className="mission-board__inspector-region"
            >
              <MissionInspector
                snapshot={currentSnapshot}
                events={events}
                operatorDirectionEvents={operatorDirectionEvents}
                onCommand={executeCommand}
                question={question}
                onOpenTerminals={openMountedMissionTerminals}
                journal={journal}
                onQuoteActivity={
                  currentSnapshot.allowedActions.includes('direct')
                    ? quoteActivity
                    : undefined
                }
              />
            </div>
          </>
        )}
      </div>

      {currentSnapshot && (
        <div className="mission-board__direct-bar">
          <DirectionComposer
            missionId={currentSnapshot.id}
            agents={currentSnapshot.agents}
            // O engine rejeita `direct` fora das ações permitidas (failed
            // incluso) — desabilitar só em completed gerava erro de comando.
            disabled={!currentSnapshot.allowedActions.includes('direct')}
            onCommand={executeCommand}
            quote={
              pendingQuote?.origin.missionId === currentSnapshot.id
                ? pendingQuote
                : null
            }
            onQuoteConsumed={consumeQuote}
          />
        </div>
      )}
      </div>
    </article>
  );
}

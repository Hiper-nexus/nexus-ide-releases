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
import {
  aggregateMissionTelemetry,
  formatMissionTelemetry,
} from '../../../shared/handoff-telemetry';
import { useMissionInspectorStore } from '../../state/mission-inspector-store';
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
import { MissionGraph } from './MissionGraph';
import { DirectionComposer } from './DirectionComposer';
import { MissionInspector } from './MissionInspector';
import {
  MissionQuestion,
  type MissionQuestionState,
} from './MissionQuestion';

const RECENT_EVENT_LIMIT = 40;
const WORKSPACE_STACK_BREAKPOINT = 1099;
const MISSION_INSPECTOR_COLLAPSED_KEY = 'nexus.mission.inspector-collapsed';
const DEFAULT_INSPECTOR_RATIO = 0.4;
const VERTICAL_MIN_INSPECTOR_SIZE = 320;
const VERTICAL_MAX_INSPECTOR_RATIO = 0.5;
const HORIZONTAL_MIN_INSPECTOR_RATIO = 0.3;
const HORIZONTAL_MAX_INSPECTOR_RATIO = 0.6;
const SPLITTER_KEYBOARD_STEP = 16;

type SplitterOrientation = 'horizontal' | 'vertical';

type WorkspaceDimensions = Readonly<{ width: number; height: number }>;

function workspaceOrientation(width: number): SplitterOrientation {
  return width > 0 && width <= WORKSPACE_STACK_BREAKPOINT
    ? 'horizontal'
    : 'vertical';
}

function inspectorExtent(
  orientation: SplitterOrientation,
  dimensions: WorkspaceDimensions,
): number {
  return orientation === 'vertical' ? dimensions.width : dimensions.height;
}

function minimumInspectorSize(
  orientation: SplitterOrientation,
  extent: number,
): number {
  return orientation === 'vertical'
    ? Math.min(VERTICAL_MIN_INSPECTOR_SIZE, extent * VERTICAL_MAX_INSPECTOR_RATIO)
    : extent * HORIZONTAL_MIN_INSPECTOR_RATIO;
}


function clampInspectorSize(
  size: number,
  orientation: SplitterOrientation,
  extent: number,
): number {
  const maximum =
    extent *
    (orientation === 'vertical'
      ? VERTICAL_MAX_INSPECTOR_RATIO
      : HORIZONTAL_MAX_INSPECTOR_RATIO);
  return Math.min(
    maximum,
    Math.max(minimumInspectorSize(orientation, extent), size),
  );
}


type HeaderAction = Extract<
  MissionAllowedAction,
  'retry-kickoff' | 'resume' | 'stop'
>;

type LifecycleAction = Exclude<MissionListAction, 'none'>;
type PendingBoardAction = HeaderAction | LifecycleAction;

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
  'retry-kickoff': 'Tentar início novamente',
  resume: 'Retomar',
  stop: 'Parar',
};

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
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  missionIdRef.current = missionId;

  const [snapshot, setSnapshot] = useState<MissionSnapshot | null>(null);
  snapshotRef.current = snapshot;
  const [events, setEvents] = useState<MissionEvent[]>([]);
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
    () =>
      typeof window !== 'undefined' &&
      window.localStorage.getItem(MISSION_INSPECTOR_COLLAPSED_KEY) === '1',
  );
  const toggleInspectorCollapsed = useCallback((): void => {
    setInspectorCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(
          MISSION_INSPECTOR_COLLAPSED_KEY,
          next ? '1' : '0',
        );
      } catch {
        // Preferência é best-effort; o estado da sessão já vale.
      }
      return next;
    });
  }, []);
  const [inspectorRatio, setInspectorRatio] = useState(
    DEFAULT_INSPECTOR_RATIO,
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
  const hasVisibleMissionPanes = useMemo(
    () =>
      listPanes(layoutRoot).some(
        (pane) =>
          (pane.missionId ?? paneMissions[pane.id]) === missionId,
      ),
    [layoutRoot, missionId, paneMissions],
  );
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
        setEvents(
          recent.enabled === false
            ? []
            : parseJournalEvents(recent.events, missionId),
        );
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

    refreshSnapshotRef.current = () => void refreshSnapshot();
    refreshJournalRef.current = () => void refreshJournal();

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
    };
  }, [missionId]);

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
      const nextOrientation = workspaceOrientation(nextDimensions.width);

      setWorkspaceDimensions((current) =>
        current.width === nextDimensions.width &&
        current.height === nextDimensions.height
          ? current
          : nextDimensions,
      );
      setInspectorRatio((current) => {
        const extent = inspectorExtent(nextOrientation, nextDimensions);
        if (extent <= 0) return current;
        return (
          clampInspectorSize(current * extent, nextOrientation, extent) / extent
        );
      });
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
  const currentInspectorExtent = inspectorExtent(
    splitterOrientation,
    workspaceDimensions,
  );
  const inspectorMinimum = minimumInspectorSize(
    splitterOrientation,
    currentInspectorExtent,
  );
  const inspectorMaximum =
    currentInspectorExtent *
    (splitterOrientation === 'vertical'
      ? VERTICAL_MAX_INSPECTOR_RATIO
      : HORIZONTAL_MAX_INSPECTOR_RATIO);
  const inspectorSize =
    currentInspectorExtent > 0
      ? Math.round(
          clampInspectorSize(
            inspectorRatio * currentInspectorExtent,
            splitterOrientation,
            currentInspectorExtent,
          ),
        )
      : 0;
  const inspectorPercent =
    currentInspectorExtent > 0
      ? Math.round((inspectorSize / currentInspectorExtent) * 100)
      : DEFAULT_INSPECTOR_RATIO * 100;
  const workspaceStyle = {
    '--mission-inspector-size':
      currentInspectorExtent > 0 ? `${inspectorSize}px` : '40%',
  } as CSSProperties;

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
        if (splitterOrientation !== 'vertical') return;
        nextSize = inspectorSize + SPLITTER_KEYBOARD_STEP;
        break;
      case 'ArrowRight':
        if (splitterOrientation !== 'vertical') return;
        nextSize = inspectorSize - SPLITTER_KEYBOARD_STEP;
        break;
      case 'ArrowUp':
        if (splitterOrientation !== 'horizontal') return;
        nextSize = inspectorSize + SPLITTER_KEYBOARD_STEP;
        break;
      case 'ArrowDown':
        if (splitterOrientation !== 'horizontal') return;
        nextSize = inspectorSize - SPLITTER_KEYBOARD_STEP;
        break;
      default:
        return;
    }

    if (currentInspectorExtent <= 0) return;
    event.preventDefault();
    setInspectorRatio(
      clampInspectorSize(
        nextSize,
        splitterOrientation,
        currentInspectorExtent,
      ) / currentInspectorExtent,
    );
  };

  const resizeInspectorAt = (clientX: number, clientY: number): void => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    const rect = workspace.getBoundingClientRect();
    const nextDimensions = { width: rect.width, height: rect.height };
    const nextOrientation = workspaceOrientation(rect.width);
    const nextExtent = inspectorExtent(nextOrientation, nextDimensions);
    if (nextExtent <= 0) return;

    const requestedSize =
      nextOrientation === 'vertical'
        ? rect.right - clientX
        : rect.bottom - clientY;
    setWorkspaceDimensions((current) =>
      current.width === nextDimensions.width &&
      current.height === nextDimensions.height
        ? current
        : nextDimensions,
    );
    setInspectorRatio(
      clampInspectorSize(requestedSize, nextOrientation, nextExtent) /
        nextExtent,
    );
  };

  const handleSplitterMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.focus();
    dragCleanupRef.current?.();

    function handleMouseMove(moveEvent: MouseEvent): void {
      resizeInspectorAt(moveEvent.clientX, moveEvent.clientY);
    }

    function finishDrag(): void {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', finishDrag);
      window.removeEventListener('blur', finishDrag);
      if (dragCleanupRef.current === finishDrag) {
        dragCleanupRef.current = null;
      }
    }

    dragCleanupRef.current = finishDrag;
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', finishDrag);
    window.addEventListener('blur', finishDrag);
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

  const runHeaderAction = (
    action: HeaderAction,
    invoker: HTMLButtonElement,
  ): void => {
    const attempt = beginBoardAction(action, invoker);
    if (!attempt) return;

    void (async () => {
      let restoreFocus = false;
      try {
        await executeCommand({ kind: action, missionId });
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

  const runLifecycleAction = (invoker: HTMLButtonElement): void => {
    const mission = currentMission;
    const action = lifecycleAction;
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
          </div>
        ) : (
          <p className="mission-board__loading" role="status" aria-live="polite">
            Carregando missão…
          </p>
        )}
      </section>
    );
  }

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

  return (
    <article
      className="mission-board"
      data-state={currentSnapshot.state}
      aria-labelledby={headingId}
      aria-busy={loading || pendingAction !== null}
    >
      <header className="mission-board__header">
        <div className="mission-board__identity">
          <h1 id={headingId}>{currentSnapshot.title}</h1>
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
            )}
          </span>
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
          {telemetryLine && (
            <span
              className="mission-board__telemetry"
              title="Duração e tokens autorrelatados pelos agentes nos handoffs desta missão"
            >
              {telemetryLine}
            </span>
          )}
        </div>

        {currentSnapshot.stateReason && (
          <p className="mission-board__reason">
            <strong>{currentSnapshot.stateReason.label}</strong>
            {currentSnapshot.stateReason.detail && (
              <span>{currentSnapshot.stateReason.detail}</span>
            )}
          </p>
        )}

        <div className="mission-board__actions" aria-label="Ações da missão">
          <button
            type="button"
            className="mission-board__button mission-board__button--secondary"
            disabled={pendingAction !== null}
            onClick={() => onOpenTerminals(missionId)}
          >
            Terminais
          </button>
          {HEADER_ACTIONS.filter(
            (action) =>
              currentSnapshot.allowedActions.includes(action) &&
              (action !== 'stop' || currentMission === null),
          ).map((action) => (
            <button
              key={action}
              type="button"
              className={`mission-board__button${
                action === 'stop'
                  ? ' mission-board__button--secondary mission-board__button--danger'
                  : ''
              }`}
              disabled={pendingAction !== null}
              aria-busy={pendingAction === action}
              onClick={(event) =>
                runHeaderAction(action, event.currentTarget)
              }
            >
              {HEADER_ACTION_LABELS[action]}
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
              onClick={(event) => runLifecycleAction(event.currentTarget)}
            >
              {lifecycleCopy.verb}
            </button>
          )}
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
        style={workspaceStyle}
      >
        <div className="mission-board__graph-region">
          <MissionGraph
            snapshot={currentSnapshot}
            selectedAgentId={selectedAgentId}
            onSelectAgent={selectAgent}
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
        {!inspectorCollapsed && (
          <>
            <div
              className="mission-board__splitter"
              role="separator"
              tabIndex={0}
              aria-label="Redimensionar inspetor da missão"
              aria-controls={inspectorRegionId}
              aria-orientation={splitterOrientation}
              aria-valuemin={Math.round(inspectorMinimum)}
              aria-valuemax={Math.round(inspectorMaximum)}
              aria-valuenow={inspectorSize}
              aria-valuetext={`Inspetor ocupa ${inspectorPercent}% da ${
                splitterOrientation === 'vertical' ? 'largura' : 'altura'
              } do quadro`}
              onKeyDown={handleSplitterKeyDown}
              onMouseDown={handleSplitterMouseDown}
            />
            <div
              id={inspectorRegionId}
              className="mission-board__inspector-region"
            >
              <MissionInspector
                snapshot={currentSnapshot}
                events={events}
                onCommand={executeCommand}
                question={question}
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
            disabled={currentSnapshot.state === 'completed'}
            onCommand={executeCommand}
          />
        </div>
      )}
    </article>
  );
}

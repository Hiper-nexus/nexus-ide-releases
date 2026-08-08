import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type {
  MissionAllowedAction,
  MissionEngineCommand,
  MissionLifecycleState,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import {
  missionEventSchema,
  type MissionEvent,
} from '../../../shared/mission-events';
import { useMissionInspectorStore } from '../../state/mission-inspector-store';
import { toUserFacingMissionRecovery } from '../../lib/user-facing-mission-error';
import { MissionGraph } from './MissionGraph';
import { MissionInspector } from './MissionInspector';
import {
  MissionQuestion,
  type MissionQuestionState,
} from './MissionQuestion';

const RECENT_EVENT_LIMIT = 40;
const WORKSPACE_STACK_BREAKPOINT = 1099;
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

const LIFECYCLE_LABELS: Readonly<Record<MissionLifecycleState, string>> = {
  draft: 'Preparando',
  review_ready: 'Pronta para iniciar',
  starting: 'Iniciando',
  running: 'Trabalhando',
  blocked_user: 'Precisa de resposta',
  blocked_technical: 'Precisa de reparo',
  recovering: 'Recuperando',
  stopping: 'Parando',
  failed: 'Falhou',
  completed: 'Concluída',
};

type HeaderAction = Extract<
  MissionAllowedAction,
  'retry-kickoff' | 'resume' | 'stop'
>;

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
  const [pendingAction, setPendingAction] = useState<HeaderAction | null>(null);
  const [questionState, setQuestionState] =
    useState<MissionQuestionState>(emptyQuestionState);
  const [workspaceDimensions, setWorkspaceDimensions] =
    useState<WorkspaceDimensions>({ width: 0, height: 0 });
  const [inspectorRatio, setInspectorRatio] = useState(
    DEFAULT_INSPECTOR_RATIO,
  );

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

  const runHeaderAction = (action: HeaderAction): void => {
    if (actionPendingRef.current) return;

    actionPendingRef.current = true;
    const requestGeneration = ++actionGenerationRef.current;
    const sessionGeneration = sessionGenerationRef.current;
    setPendingAction(action);
    setCommandError(null);

    void executeCommand({ kind: action, missionId })
      .catch((reason: unknown) => {
        if (
          missionIdRef.current === missionId &&
          sessionGenerationRef.current === sessionGeneration &&
          actionGenerationRef.current === requestGeneration
        ) {
          setCommandError(
            toUserFacingMissionRecovery(
              reason,
              'Não foi possível executar esta ação. Tente novamente.',
            ),
          );
        }
      })
      .finally(() => {
        if (
          missionIdRef.current === missionId &&
          sessionGenerationRef.current === sessionGeneration &&
          actionGenerationRef.current === requestGeneration
        ) {
          actionPendingRef.current = false;
          setPendingAction(null);
        }
      });
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
            {LIFECYCLE_LABELS[currentSnapshot.state]}
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
            onClick={() => onOpenTerminals(missionId)}
          >
            Terminais
          </button>
          {HEADER_ACTIONS.filter((action) =>
            currentSnapshot.allowedActions.includes(action),
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
              onClick={() => runHeaderAction(action)}
            >
              {HEADER_ACTION_LABELS[action]}
            </button>
          ))}
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
        </div>
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
      </div>
    </article>
  );
}

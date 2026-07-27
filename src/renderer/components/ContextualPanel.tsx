import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  CONTEXTUAL_TAB_COPY,
  CONTEXTUAL_TABS,
  contextualPanelStateSchema,
  type ContextualPanelState,
  type ContextualTab,
} from '../../shared/contextual-panel';
import {
  browserLocalStorage,
  loadContextualPanelState,
  saveContextualPanelState,
  type KeyValueStorage,
} from '../../shared/contextual-panel-persist';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { useContextualPanelNavStore } from '../state/contextual-panel-nav-store';

const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = 900;
const MIN_CANVAS_WIDTH = 320;
const COMPACT_PANEL_BREAKPOINT = 900;
const PANEL_KEYBOARD_STEP = 16;

function clampPanelWidth(
  widthPx: number,
  maximum = MAX_PANEL_WIDTH,
): number {
  return Math.min(maximum, Math.max(MIN_PANEL_WIDTH, widthPx));
}

export interface ContextualPanelProps {
  readonly flagEnabled?: boolean;
  readonly workspaceId?: string;
  readonly initial?: Partial<ContextualPanelState>;
  /** Optional controlled active tab; undefined keeps navigation internal. */
  readonly activeTab?: ContextualTab;
  readonly onStateChange?: (state: ContextualPanelState) => void;
  readonly children?: Partial<Record<ContextualTab, React.ReactNode>>;
  /** Inject storage for tests; defaults to localStorage when available. */
  readonly storage?: KeyValueStorage | null;
  /**
   * Tabs relevant to the active launcher mode. When provided, irrelevant tabs
   * are hidden to reduce clutter; the active tab always stays visible so the
   * user never loses their current context.
   */
  readonly relevantTabs?: readonly ContextualTab[];
}

function initialState(
  workspaceId: string | undefined,
  initial: Partial<ContextualPanelState> | undefined,
  controlledTab: ContextualTab | undefined,
  storage: KeyValueStorage | null,
): ContextualPanelState {
  const persisted =
    workspaceId && storage
      ? loadContextualPanelState(workspaceId, storage)
      : null;
  return contextualPanelStateSchema.parse({
    ...initial,
    ...persisted,
    workspaceId,
    ...(controlledTab ? { activeTab: controlledTab } : {}),
  });
}

/**
 * Painel direito unificado: Browser / Editor / Git / Skills / Memória / Missão / Handoff / Busca.
 * Tab/width/visible persistem por workspace via contextual-panel-persist.
 * Abrir uma aba nunca concede permissões extras.
 */
export function ContextualPanel({
  flagEnabled = true,
  workspaceId,
  initial,
  activeTab: controlledTab,
  onStateChange,
  children,
  storage: storageProp,
  relevantTabs,
}: ContextualPanelProps) {
  const storage =
    storageProp === undefined ? browserLocalStorage() : storageProp;

  const [state, setState] = useState<ContextualPanelState>(() =>
    initialState(workspaceId, initial, controlledTab, storage),
  );
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );
  const requestedTab = useContextualPanelNavStore(
    (nav) => nav.requestedTab,
  );
  const requestId = useContextualPanelNavStore((nav) => nav.requestId);
  const handledRequestId = useRef(0);
  const tabRefs = useRef(new Map<ContextualTab, HTMLButtonElement>());
  const generatedId = useId().replaceAll(':', '');
  const panelDomId = `ctx-panel-${generatedId}`;
  const panelBodyId = `${panelDomId}-body`;
  const compactPresentation = viewportWidth < COMPACT_PANEL_BREAKPOINT;
  const missionRailWidth = viewportWidth <= 1120 ? 210 : 248;
  const responsiveMaximum = compactPresentation
    ? Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, viewportWidth - 16))
    : Math.min(
        MAX_PANEL_WIDTH,
        Math.max(
          MIN_PANEL_WIDTH,
          viewportWidth - missionRailWidth - MIN_CANVAS_WIDTH,
        ),
      );
  const renderedWidth = clampPanelWidth(
    state.widthPx,
    responsiveMaximum,
  );

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Rehydrate when workspace changes (real product path).
  useEffect(() => {
    setState(initialState(workspaceId, initial, controlledTab, storage));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on workspaceId
  }, [workspaceId]);

  const update = useCallback(
    (patch: Partial<ContextualPanelState>) => {
      setState((prev) => {
        const next = contextualPanelStateSchema.parse({
          ...prev,
          ...patch,
          workspaceId: workspaceId ?? prev.workspaceId,
        });
        if (workspaceId && storage) {
          saveContextualPanelState(workspaceId, next, storage);
        }
        onStateChange?.(next);
        return next;
      });
    },
    [onStateChange, workspaceId, storage],
  );

  useEffect(() => {
    if (controlledTab && controlledTab !== state.activeTab) {
      update({ activeTab: controlledTab, visible: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional controlled prop
  }, [controlledTab]);

  useEffect(() => {
    if (
      requestId > handledRequestId.current &&
      requestedTab
    ) {
      handledRequestId.current = requestId;
      update({ activeTab: requestedTab, visible: true });
    }
  }, [requestId, requestedTab, update]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === ']') {
        e.preventDefault();
        update({ visible: !state.visible });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.visible, update]);

  if (!flagEnabled) {
    return (
      <aside
        className="ctx-panel ctx-panel--off"
        data-flag={FEATURE_FLAG_IDS.contextualPanel}
        hidden
      />
    );
  }

  if (!state.visible) {
    return (
      <button
        type="button"
        className="ctx-panel__show"
        onClick={() => update({ visible: true })}
        title="Abrir painel de contexto (Alt+])"
        aria-label="Abrir painel de contexto"
      >
        Abrir contexto
      </button>
    );
  }

  const copy = CONTEXTUAL_TAB_COPY[state.activeTab];
  const body = children?.[state.activeTab];
  const visibleTabs = relevantTabs
    ? [...new Set([...relevantTabs, state.activeTab])]
    : [...CONTEXTUAL_TABS];

  const onTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    tab: ContextualTab,
  ) => {
    const currentIndex = visibleTabs.indexOf(tab);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % visibleTabs.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex =
        (currentIndex - 1 + visibleTabs.length) % visibleTabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = visibleTabs.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = visibleTabs[nextIndex];
    if (!nextTab) return;
    update({ activeTab: nextTab });
    tabRefs.current.get(nextTab)?.focus();
  };

  const onSplitterKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey
      ? PANEL_KEYBOARD_STEP * 4
      : PANEL_KEYBOARD_STEP;
    let widthPx: number | null = null;
    if (event.key === 'ArrowLeft') {
      widthPx = state.widthPx + step;
    } else if (event.key === 'ArrowRight') {
      widthPx = state.widthPx - step;
    } else if (event.key === 'Home') {
      widthPx = MIN_PANEL_WIDTH;
    } else if (event.key === 'End') {
      widthPx = responsiveMaximum;
    }
    if (widthPx === null) return;
    event.preventDefault();
    update({ widthPx: clampPanelWidth(widthPx, responsiveMaximum) });
  };

  return (
    <aside
      id={panelDomId}
      className="ctx-panel"
      data-testid="contextual-panel"
      data-presentation={compactPresentation ? 'drawer' : 'sidebar'}
      style={{ width: renderedWidth }}
      aria-label="Painel contextual"
    >
      <div className="ctx-panel__tabs">
        <div
          className="ctx-panel__tablist"
          role="tablist"
          aria-label="Abas do painel"
          aria-orientation="horizontal"
        >
          {visibleTabs.map((tab) => (
            <button
              key={tab}
              ref={(node) => {
                if (node) tabRefs.current.set(tab, node);
                else tabRefs.current.delete(tab);
              }}
              id={`${panelDomId}-tab-${tab}`}
              type="button"
              role="tab"
              aria-controls={panelBodyId}
              aria-selected={state.activeTab === tab}
              tabIndex={state.activeTab === tab ? 0 : -1}
              className={state.activeTab === tab ? 'is-active' : ''}
              onClick={() => update({ activeTab: tab })}
              onKeyDown={(event) => onTabKeyDown(event, tab)}
            >
              {CONTEXTUAL_TAB_COPY[tab].title}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ctx-panel__hide"
          onClick={() => update({ visible: false })}
          title="Ocultar (Alt+])"
          aria-label="Ocultar painel"
        >
          ×
        </button>
      </div>
      <div
        id={panelBodyId}
        className="ctx-panel__body"
        role="tabpanel"
        aria-labelledby={`${panelDomId}-tab-${state.activeTab}`}
        data-testid={`ctx-tab-${state.activeTab}`}
      >
        {body ?? (
          <div className="ctx-panel__empty">
            <h3>{copy.title}</h3>
            <p>{copy.empty}</p>
          </div>
        )}
      </div>
      <div
        className="ctx-panel__splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionar painel de contexto"
        aria-controls={panelBodyId}
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={responsiveMaximum}
        aria-valuenow={renderedWidth}
        aria-valuetext={`${renderedWidth} pixels`}
        tabIndex={0}
        onKeyDown={onSplitterKeyDown}
        onMouseDown={(e) => {
          const startX = e.clientX;
          const startW = renderedWidth;
          let pendingWidth = renderedWidth;
          let animationFrame = 0;
          const onMove = (ev: MouseEvent) => {
            pendingWidth = clampPanelWidth(
              startW + (startX - ev.clientX),
              responsiveMaximum,
            );
            if (animationFrame) return;
            animationFrame = window.requestAnimationFrame(() => {
              animationFrame = 0;
              // Drag feedback is transient: durable localStorage and external
              // callbacks run once on pointer release, not every mousemove.
              setState((previous) =>
                contextualPanelStateSchema.parse({
                  ...previous,
                  widthPx: pendingWidth,
                  workspaceId: workspaceId ?? previous.workspaceId,
                }),
              );
            });
          };
          const onUp = () => {
            if (animationFrame) {
              window.cancelAnimationFrame(animationFrame);
              animationFrame = 0;
            }
            update({ widthPx: pendingWidth });
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
      />
    </aside>
  );
}

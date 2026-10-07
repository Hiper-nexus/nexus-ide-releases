import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { useRailWidthStore } from '../state/rail-width-store';
import { PixelIcon } from './PixelIcon';

const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = 900;
const MIN_STAGE_WIDTH = 320;
const COMPACT_PANEL_BREAKPOINT = 900;
const PANEL_KEYBOARD_STEP = 16;
/** Folga ao revelar uma aba: a largura da borda esmaecida da faixa (--space-5). */
const TAB_REVEAL_MARGIN = 24;

function clampPanelWidth(
  widthPx: number,
  maximum = MAX_PANEL_WIDTH,
): number {
  return Math.min(maximum, Math.max(MIN_PANEL_WIDTH, widthPx));
}

export type ContextualPanelFocusTarget = 'show-control' | 'active-tab';
export type ContextualPanelPlacement = 'header' | 'inspector';

export interface ContextualPanelProps {
  readonly flagEnabled?: boolean;
  readonly workspaceId?: string;
  readonly initial?: Partial<ContextualPanelState>;
  /** Optional controlled active tab; undefined keeps navigation internal. */
  readonly activeTab?: ContextualTab;
  readonly onStateChange?: (state: ContextualPanelState) => void;
  /** Actual AppShell slot; omitted when the component is not reparented. */
  readonly placement?: ContextualPanelPlacement;
  /** Focus handoff owned by a parent that reparents this component. */
  readonly focusTarget?: ContextualPanelFocusTarget | null;
  readonly onFocusTargetChange?: (
    target: ContextualPanelFocusTarget | null,
  ) => void;
  readonly children?: Partial<Record<ContextualTab, React.ReactNode>>;
  /** Inject storage for tests; defaults to localStorage when available. */
  readonly storage?: KeyValueStorage | null;
  /**
   * Tabs relevant to the active product surface. Unsupported persisted or
   * requested tabs normalize to Mission when possible, otherwise to the first
   * supported tab.
   */
  readonly relevantTabs?: readonly ContextualTab[];
}

function supportedTabs(
  relevantTabs: readonly ContextualTab[] | undefined,
): ContextualTab[] {
  const tabs = relevantTabs
    ? [...new Set(relevantTabs)]
    : [...CONTEXTUAL_TABS];
  return tabs.length > 0 ? tabs : ['mission'];
}

function normalizeActiveTab(
  activeTab: ContextualTab,
  relevantTabs: readonly ContextualTab[] | undefined,
): ContextualTab {
  const tabs = supportedTabs(relevantTabs);
  if (tabs.includes(activeTab)) return activeTab;
  return tabs.includes('mission') ? 'mission' : (tabs[0] ?? 'mission');
}

function initialState(
  workspaceId: string | undefined,
  initial: Partial<ContextualPanelState> | undefined,
  controlledTab: ContextualTab | undefined,
  storage: KeyValueStorage | null,
  relevantTabs: readonly ContextualTab[] | undefined,
): ContextualPanelState {
  const persisted =
    workspaceId && storage
      ? loadContextualPanelState(workspaceId, storage)
      : null;
  const parsed = contextualPanelStateSchema.parse({
    ...initial,
    ...persisted,
    workspaceId,
    ...(controlledTab ? { activeTab: controlledTab } : {}),
  });
  return {
    ...parsed,
    activeTab: normalizeActiveTab(parsed.activeTab, relevantTabs),
  };
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
  placement,
  focusTarget,
  onFocusTargetChange,
  children,
  storage: storageProp,
  relevantTabs,
}: ContextualPanelProps) {
  const storage =
    storageProp === undefined ? browserLocalStorage() : storageProp;

  const [state, setState] = useState<ContextualPanelState>(() =>
    initialState(
      workspaceId,
      initial,
      controlledTab,
      storage,
      relevantTabs,
    ),
  );
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );
  const requestedTab = useContextualPanelNavStore(
    (nav) => nav.requestedTab,
  );
  const requestId = useContextualPanelNavStore((nav) => nav.requestId);
  const focusRequested = useContextualPanelNavStore(
    (nav) => nav.focusRequested,
  );
  const acknowledgeRequest = useContextualPanelNavStore(
    (nav) => nav.acknowledge,
  );
  const handledRequestId = useRef(0);
  const showButtonRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef(new Map<ContextualTab, HTMLButtonElement>());
  const generatedId = useId().replaceAll(':', '');
  const panelDomId = `ctx-panel-${generatedId}`;
  const panelBodyId = `${panelDomId}-body`;
  const compactPresentation = viewportWidth < COMPACT_PANEL_BREAKPOINT;
  // A coluna do shell segue a largura do painel; o teto precisa descontar o
  // rail real (ajustável) para o palco nunca ficar abaixo do mínimo.
  const railWidth = useRailWidthStore((rail) => rail.width);
  const responsiveMaximum = compactPresentation
    ? Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, viewportWidth - 16))
    : Math.min(
        MAX_PANEL_WIDTH,
        Math.max(
          MIN_PANEL_WIDTH,
          viewportWidth - railWidth - MIN_STAGE_WIDTH,
        ),
      );
  const visibleTabs = supportedTabs(relevantTabs);
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
    const next = initialState(
      workspaceId,
      initial,
      controlledTab,
      storage,
      relevantTabs,
    );
    setState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on workspaceId
  }, [workspaceId]);

  useEffect(() => {
    onStateChange?.(state);
  }, [onStateChange, state]);

  const update = useCallback(
    (patch: Partial<ContextualPanelState>) => {
      setState((prev) => {
        const next = contextualPanelStateSchema.parse({
          ...prev,
          ...patch,
          activeTab: normalizeActiveTab(
            patch.activeTab ?? prev.activeTab,
            relevantTabs,
          ),
          workspaceId: workspaceId ?? prev.workspaceId,
        });
        if (workspaceId && storage) {
          saveContextualPanelState(workspaceId, next, storage);
        }
        return next;
      });
    },
    [workspaceId, storage, relevantTabs],
  );

  useEffect(() => {
    if (controlledTab && controlledTab !== state.activeTab) {
      update({ activeTab: controlledTab, visible: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional controlled prop
  }, [controlledTab]);

  useEffect(() => {
    if (requestId <= handledRequestId.current || !requestedTab) return;
    handledRequestId.current = requestId;
    if (focusRequested) {
      onFocusTargetChange?.('active-tab');
    }
    update({ activeTab: requestedTab, visible: true });
    acknowledgeRequest(requestId);
  }, [
    acknowledgeRequest,
    focusRequested,
    onFocusTargetChange,
    requestId,
    requestedTab,
    update,
  ]);

  useEffect(() => {
    const normalized = normalizeActiveTab(state.activeTab, relevantTabs);
    if (normalized !== state.activeTab) {
      update({ activeTab: normalized });
    }
  }, [relevantTabs, state.activeTab, update]);

  useLayoutEffect(() => {
    if (!focusTarget) return;
    let target: HTMLButtonElement | null | undefined;
    if (focusTarget === 'show-control') {
      if (
        state.visible ||
        (placement !== undefined && placement !== 'header')
      ) {
        return;
      }
      target = showButtonRef.current;
    } else {
      if (
        !state.visible ||
        (placement !== undefined && placement !== 'inspector')
      ) {
        return;
      }
      target = tabRefs.current.get(state.activeTab);
    }
    if (!target) return;
    target.focus();
    onFocusTargetChange?.(null);
  }, [
    focusTarget,
    onFocusTargetChange,
    placement,
    state.activeTab,
    state.visible,
  ]);

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

  // The tab strip is intentionally single-line so narrow panels do not turn
  // into a two-row toolbar. Keep the active context reachable after keyboard
  // navigation or a launcher request — scrolling ONLY the strip.
  // `scrollIntoView` also scrolled every ancestor (inspector, shell) and
  // dragged the whole layout sideways whenever a tab was activated.
  useEffect(() => {
    if (!state.visible) return;
    const tab = tabRefs.current.get(state.activeTab);
    const strip = tab?.parentElement;
    if (!tab || !strip) return;
    const stripBox = strip.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    if (tabBox.left < stripBox.left + TAB_REVEAL_MARGIN) {
      strip.scrollLeft -= stripBox.left + TAB_REVEAL_MARGIN - tabBox.left;
    } else if (tabBox.right > stripBox.right - TAB_REVEAL_MARGIN) {
      strip.scrollLeft += tabBox.right - (stripBox.right - TAB_REVEAL_MARGIN);
    }
  }, [state.activeTab, state.visible]);

  if (!flagEnabled) {
    return (
      <aside
        className="ctx-panel ctx-panel--off"
        data-flag={FEATURE_FLAG_IDS.contextualPanel}
        hidden
      />
    );
  }

  // No slot do inspector o painel oculto continua desenhado: é a cópia que o
  // AppShell mantém inerte durante a saída (o botão de reabrir nasce no
  // cabeçalho). Trocar pelo botão encolheria a coluna antes da hora e
  // redimensionaria o terminal duas vezes.
  if (!state.visible && placement !== 'inspector') {
    return (
      <button
        ref={showButtonRef}
        type="button"
        className="ctx-panel__show"
        onClick={(event) => {
          if (document.activeElement === event.currentTarget) {
            onFocusTargetChange?.('active-tab');
          }
          update({ visible: true });
        }}
        title="Abrir painel de contexto (Alt+])"
        aria-label="Abrir painel de contexto"
      >
        <PixelIcon name="chevron" size={12} />
      </button>
    );
  }

  const copy = CONTEXTUAL_TAB_COPY[state.activeTab];
  const body = children?.[state.activeTab];

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
          onClick={(event) => {
            if (document.activeElement === event.currentTarget) {
              onFocusTargetChange?.('show-control');
            }
            update({ visible: false });
          }}
          title="Ocultar (Alt+])"
          aria-label="Ocultar painel"
        >
          <PixelIcon name="close" size={12} />
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

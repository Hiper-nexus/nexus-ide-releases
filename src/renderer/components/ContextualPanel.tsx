import { useCallback, useEffect, useState } from 'react';
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

export interface ContextualPanelProps {
  readonly flagEnabled?: boolean;
  readonly workspaceId?: string;
  readonly initial?: Partial<ContextualPanelState>;
  /** Controlled active tab (ModeLauncher); undefined = internal state only. */
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
        title="Mostrar painel (Alt+])"
      >
        Painel
      </button>
    );
  }

  const copy = CONTEXTUAL_TAB_COPY[state.activeTab];
  const body = children?.[state.activeTab];
  const visibleTabs = relevantTabs
    ? CONTEXTUAL_TABS.filter(
        (tab) => tab === state.activeTab || relevantTabs.includes(tab),
      )
    : CONTEXTUAL_TABS;

  return (
    <aside
      className="ctx-panel"
      data-testid="contextual-panel"
      style={{ width: state.widthPx }}
      aria-label="Painel contextual"
    >
      <div className="ctx-panel__tabs" role="tablist" aria-label="Abas do painel">
        {visibleTabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={state.activeTab === tab}
            className={state.activeTab === tab ? 'is-active' : ''}
            onClick={() => update({ activeTab: tab })}
          >
            {CONTEXTUAL_TAB_COPY[tab].title}
          </button>
        ))}
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
        className="ctx-panel__body"
        role="tabpanel"
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
        onMouseDown={(e) => {
          const startX = e.clientX;
          const startW = state.widthPx;
          const onMove = (ev: MouseEvent) => {
            update({
              widthPx: Math.min(900, Math.max(200, startW + (startX - ev.clientX))),
            });
          };
          const onUp = () => {
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

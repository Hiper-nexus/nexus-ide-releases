import { useCallback, useEffect, useState } from 'react';
import {
  CONTEXTUAL_TAB_COPY,
  CONTEXTUAL_TABS,
  contextualPanelStateSchema,
  type ContextualPanelState,
  type ContextualTab,
} from '../../shared/contextual-panel';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';

export interface ContextualPanelProps {
  readonly flagEnabled?: boolean;
  readonly workspaceId?: string;
  readonly initial?: Partial<ContextualPanelState>;
  /** Controlled active tab (ModeLauncher); undefined = internal state only. */
  readonly activeTab?: ContextualTab;
  readonly onStateChange?: (state: ContextualPanelState) => void;
  readonly children?: Partial<Record<ContextualTab, React.ReactNode>>;
}

/**
 * Unified right panel: Browser / Editor / Git / Skills / Memory / Mission / Handoff / Search.
 * Splitter width via CSS resize; hide/show with Alt+].
 * Opening a tab never implies extra permissions.
 */
export function ContextualPanel({
  flagEnabled = true,
  workspaceId,
  initial,
  activeTab: controlledTab,
  onStateChange,
  children,
}: ContextualPanelProps) {
  const [state, setState] = useState<ContextualPanelState>(() =>
    contextualPanelStateSchema.parse({
      ...initial,
      workspaceId,
      ...(controlledTab ? { activeTab: controlledTab } : {}),
    }),
  );

  const update = useCallback(
    (patch: Partial<ContextualPanelState>) => {
      setState((prev) => {
        const next = contextualPanelStateSchema.parse({ ...prev, ...patch });
        onStateChange?.(next);
        return next;
      });
    },
    [onStateChange],
  );

  useEffect(() => {
    if (controlledTab && controlledTab !== state.activeTab) {
      update({ activeTab: controlledTab, visible: true });
    }
    // Only re-sync when parent drives tab changes.
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
        title="Show panel (Alt+])"
      >
        Panel
      </button>
    );
  }

  const copy = CONTEXTUAL_TAB_COPY[state.activeTab];
  const body = children?.[state.activeTab];

  return (
    <aside
      className="ctx-panel"
      data-testid="contextual-panel"
      style={{ width: state.widthPx }}
      aria-label="Contextual panel"
    >
      <div className="ctx-panel__tabs" role="tablist">
        {CONTEXTUAL_TABS.map((tab) => (
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
          title="Hide (Alt+])"
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
            update({ widthPx: Math.min(900, Math.max(200, startW + (startX - ev.clientX))) });
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

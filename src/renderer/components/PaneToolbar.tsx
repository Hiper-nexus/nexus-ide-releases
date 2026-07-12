import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import {
  hibernateHost,
  respawnWithResume,
  scrollPaneToBottom,
  wakeHost,
} from '../terminal/terminal-host';
import { CostBadge } from './CostBadge';
import { DevServerChip } from './DevServerChip';
import { PixelIcon, type PixelIconName } from './PixelIcon';
import { requestPaneClose } from '../terminal/pane-close-guard';
import { askConfirm } from '../state/confirm-store';

interface Props {
  pane: PaneModel;
  isFocused: boolean;
  /** When true, hides grid-specific split buttons (canvas panes float freely). */
  isCanvas?: boolean;
}

type Density = 'full' | 'icons' | 'compact';

interface ToolbarAction {
  id: string;
  label: string;
  detail: string;
  shortcut?: string;
  icon: PixelIconName;
  danger?: boolean;
  active?: boolean;
  /** Keep visible even in compact mode (not buried in ⋯). */
  primary?: boolean;
  run: () => void;
}

function StateIndicator({ paneId }: { paneId: string }) {
  const state = useSessionStateStore((s) => s.paneStates.get(paneId));
  if (!state) return null;

  const view =
    state === 'idle'
      ? { icon: 'status-idle' as PixelIconName, mod: 'idle', label: 'pronto' }
      : state === 'busy'
        ? { icon: 'status-busy' as PixelIconName, mod: 'busy', label: 'trabalhando' }
        : state === 'exited'
          ? {
              icon: 'status-exited' as PixelIconName,
              mod: 'exited',
              label: 'encerrado — use Reiniciar',
            }
          : state === 'hibernated'
            ? {
                icon: 'status-hibernated' as PixelIconName,
                mod: 'hibernated',
                label: 'dormindo — use Acordar',
              }
            : {
                icon: 'status-spawning' as PixelIconName,
                mod: 'spawning',
                label: 'iniciando',
              };

  return (
    <span
      className={`toolbar__state toolbar__state--${view.mod}`}
      data-tip={`Agente: ${view.label}`}
      aria-label={`estado do agente: ${view.label}`}
    >
      <PixelIcon name={view.icon} size={10} />
    </span>
  );
}

function tipText(action: ToolbarAction): string {
  return action.shortcut
    ? `${action.detail} · ${action.shortcut}`
    : action.detail;
}

function ToolbarBtn({
  action,
  density,
  menu,
}: {
  action: ToolbarAction;
  density: Density;
  menu?: boolean;
}) {
  return (
    <button
      type="button"
      className={[
        menu ? 'toolbar__menu-item' : 'toolbar__btn',
        'nodrag',
        action.danger ? 'toolbar__btn--close' : '',
        action.active ? 'toolbar__btn--active' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={action.label}
      data-tip={tipText(action)}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        action.run();
      }}
    >
      <PixelIcon name={action.icon} size={menu ? 12 : 11} />
      {(menu || density === 'full') && (
        <span className={menu ? 'toolbar__menu-item-label' : 'toolbar__btn-label'}>
          {action.label}
        </span>
      )}
      {menu && action.shortcut && (
        <span className="toolbar__menu-item-kbd">{action.shortcut}</span>
      )}
    </button>
  );
}

/**
 * Per-pane header: identity left; actions right with floating tooltips.
 * Density adapts to pane width; compact mode collapses secondary actions into ⋯.
 */
export function PaneToolbar({ pane, isFocused, isCanvas }: Props) {
  const split = useLayoutStore((s) => s.split);
  const renameTitle = useLayoutStore((s) => s.renameTitle);
  const paneState = useSessionStateStore((s) => s.paneStates.get(pane.id));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pane.title);
  const [density, setDensity] = useState<Density>('full');
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const adapterLabel = pane.adapterId
    ? `${pane.adapterId}${pane.model ? ` · ${pane.model}` : ''}`
    : null;
  const isHibernated = paneState === 'hibernated';

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 500;
      if (w < 280) setDensity('compact');
      else if (w < 420) setDensity('icons');
      else setDensity('full');
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  function commit() {
    const clean = draft.trim();
    if (clean && clean !== pane.title) renameTitle(pane.id, clean);
    setEditing(false);
  }

  const actions = useMemo((): ToolbarAction[] => {
    const list: ToolbarAction[] = [];

    if (pane.kind !== 'browser') {
      list.push({
        id: 'scroll-end',
        label: 'Fim',
        detail: 'Ir para o fim do terminal (última saída)',
        icon: 'scroll-bottom',
        run: () => scrollPaneToBottom(pane.id, pane.kind === 'cli-agent'),
      });
      list.push({
        id: 'hibernate',
        label: isHibernated ? 'Acordar' : 'Dormir',
        detail: isHibernated
          ? 'Reabre o processo deste pane'
          : 'Encerra o processo e mantém o buffer na tela',
        icon: isHibernated ? 'sun' : 'moon',
        active: isHibernated,
        run: () => {
          if (isHibernated) {
            wakeHost(pane);
            return;
          }
          if (pane.kind !== 'cli-agent' || paneState !== 'busy') {
            hibernateHost(pane.id);
            return;
          }
          void askConfirm({
            title: 'Dormir este agente?',
            body: 'O agente está trabalhando. Dormir encerra o processo atual.',
            confirmLabel: 'Dormir agente',
            danger: true,
          }).then((ok) => {
            if (ok) hibernateHost(pane.id);
          });
        },
      });
    }

    if (pane.kind === 'cli-agent') {
      list.push({
        id: 'restart',
        label: 'Reiniciar',
        detail: 'Reinicia a CLI e retoma a conversa (--resume)',
        icon: 'restart',
        primary: true,
        run: () => {
          const state = useSessionStateStore.getState().paneStates.get(pane.id);
          if (state !== 'busy') {
            respawnWithResume(pane, '[nexus] retomando a sessão anterior…');
            return;
          }
          void askConfirm({
            title: 'Reiniciar este agente?',
            body: 'O agente está trabalhando. Reiniciar interrompe a tarefa atual e retoma a conversa (--resume).',
            confirmLabel: 'Reiniciar agente',
            danger: true,
          }).then((ok) => {
            if (ok) respawnWithResume(pane, '[nexus] retomando a sessão anterior…');
          });
        },
      });
    }

    if (!isCanvas) {
      list.push({
        id: 'split-right',
        label: 'À direita',
        detail: 'Cria um novo pane ao lado (não copia o terminal)',
        shortcut: '⌘D',
        icon: 'split-right',
        primary: true,
        run: () => split(pane.id, 'row'),
      });
      list.push({
        id: 'split-down',
        label: 'Abaixo',
        detail: 'Cria um novo pane abaixo (não copia o terminal)',
        shortcut: '⌘⇧D',
        icon: 'split-down',
        primary: true,
        run: () => split(pane.id, 'column'),
      });
    }

    list.push({
      id: 'close',
      label: 'Fechar',
      detail: 'Fecha este pane',
      shortcut: '⌘W',
      icon: 'close',
      danger: true,
      primary: true,
      run: () => requestPaneClose(pane.id),
    });

    return list;
  }, [pane, isCanvas, isHibernated, paneState, split]);

  const overflow =
    density === 'compact' ? actions.filter((a) => !a.primary) : [];
  const visible =
    density === 'compact' ? actions.filter((a) => a.primary) : actions;

  // Group for visual clusters when not compact
  const sessionIds = new Set(['scroll-end', 'hibernate', 'restart']);
  const layoutIds = new Set(['split-right', 'split-down']);

  function renderGroup(ids: Set<string>, aria: string) {
    const items = visible.filter((a) => ids.has(a.id));
    if (items.length === 0) return null;
    return (
      <div className="toolbar__group" role="group" aria-label={aria}>
        {items.map((a) => (
          <ToolbarBtn key={a.id} action={a} density={density} />
        ))}
      </div>
    );
  }

  return (
    <div
      className="toolbar"
      data-focused={isFocused}
      data-density={density}
      ref={rootRef}
    >
      <span className={`toolbar__dot ${isFocused ? 'toolbar__dot--on' : ''}`} />
      {editing ? (
        <input
          className="toolbar__rename nodrag"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="toolbar__title"
          data-tip="Duplo-clique para renomear"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(pane.title);
            setEditing(true);
          }}
        >
          {pane.title}
        </span>
      )}
      {pane.role === 'orchestrator' && (
        <span
          className="toolbar__badge toolbar__badge--orch"
          data-tip="Orquestrador — coordena e delega para os workers"
        >
          orq
        </span>
      )}
      {pane.role === 'worker' && pane.agentName && (
        <span
          className="toolbar__badge toolbar__badge--worker"
          data-tip={`Worker do squad: ${pane.agentName}`}
        >
          {pane.agentName}
        </span>
      )}
      {adapterLabel ? (
        <span
          className="toolbar__badge toolbar__badge--agent"
          data-tip={`CLI/modelo neste pane: ${adapterLabel}`}
        >
          {adapterLabel}
        </span>
      ) : (
        <span className="toolbar__badge">{pane.kind}</span>
      )}
      {pane.kind === 'cli-agent' && <StateIndicator paneId={pane.id} />}
      {pane.kind === 'cli-agent' && <CostBadge paneId={pane.id} />}
      <DevServerChip pane={pane} />

      <div className="toolbar__spacer" />

      {density === 'compact' ? (
        <>
          <div className="toolbar__group" role="group" aria-label="Ações">
            {visible
              .filter((a) => a.id !== 'close')
              .map((a) => (
                <ToolbarBtn key={a.id} action={a} density={density} />
              ))}
          </div>
          {overflow.length > 0 && (
            <div className="toolbar__more" ref={menuRef}>
              <button
                type="button"
                className={`toolbar__btn nodrag${menuOpen ? ' toolbar__btn--active' : ''}`}
                aria-label="Mais ações do pane"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                data-tip="Mais ações (dormir, fim do terminal…)"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((v) => !v);
                }}
              >
                <PixelIcon name="more" size={11} />
              </button>
              {menuOpen && (
                <div className="toolbar__menu" role="menu">
                  <p className="toolbar__menu-head">Ações do pane</p>
                  {overflow.map((a) => (
                    <ToolbarBtn
                      key={a.id}
                      action={{
                        ...a,
                        run: () => {
                          setMenuOpen(false);
                          a.run();
                        },
                      }}
                      density="full"
                      menu
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          {visible
            .filter((a) => a.id === 'close')
            .map((a) => (
              <div
                key={a.id}
                className="toolbar__group toolbar__group--danger"
                role="group"
                aria-label="Fechar"
              >
                <ToolbarBtn action={a} density={density} />
              </div>
            ))}
        </>
      ) : (
        <>
          {renderGroup(sessionIds, 'Sessão')}
          {renderGroup(layoutIds, 'Layout')}
          {renderGroup(new Set(['close']), 'Fechar')}
        </>
      )}
    </div>
  );
}

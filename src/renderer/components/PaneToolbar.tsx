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
import { useOrchStore } from '../state/orch-store';
import { AgentAvatar, resolveAgentCategory } from './AgentAvatar';
import { ProviderLogo } from './ProviderLogo';
import { CommandBlockMenu } from './CommandBlockMenu';
import { paneSessionView } from '../../shared/pane-session-view';
import { formatShortcut } from '../lib/platform';
import {
  isStructuralPlaceholderPane,
  listPanes,
  paneSlotOf,
} from '../lib/split-tree';

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

const STATE_ICON: Record<
  ReturnType<typeof paneSessionView>['mod'],
  PixelIconName
> = {
  idle: 'status-idle',
  busy: 'status-busy',
  spawning: 'status-spawning',
  exited: 'status-exited',
  hibernated: 'status-hibernated',
};

function StateIndicator({
  paneId,
  compact,
}: {
  paneId: string;
  /** Só ícone quando a toolbar está no modo mais apertado. */
  compact: boolean;
}) {
  // displayStates lags busy→idle so Trabalho↔Pronto does not flash every quiet gap.
  const state = useSessionStateStore((s) => s.displayStates.get(paneId));
  if (!state) return null;

  const view = paneSessionView(state);

  return (
    <span
      className={`toolbar__state toolbar__state--chip toolbar__state--${view.mod}`}
      data-tip={view.tip}
      aria-label={view.tip}
    >
      <PixelIcon name={STATE_ICON[view.mod]} size={10} />
      {!compact && <span className="toolbar__state-label">{view.chip}</span>}
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
  const isVacancy = isStructuralPlaceholderPane(pane);
  const split = useLayoutStore((s) => s.split);
  const maximizedPaneId = useLayoutStore((s) => s.maximizedPaneId);
  const toggleMaximizePane = useLayoutStore((s) => s.toggleMaximizePane);
  const renameTitle = useLayoutStore((s) => s.renameTitle);
  // Slot posicional ⌘1-9: derivado do layout AO VIVO — recalcula quando panes
  // abrem/fecham, exatamente como o atalho resolve o alvo.
  const paneSlot = useLayoutStore((s) =>
    s.root ? paneSlotOf(s.root, pane.id) : null,
  );
  const paneCount = useLayoutStore((s) =>
    s.root ? listPanes(s.root).length : 0,
  );
  // True state for actions (dormir/reiniciar guards); display for avatar chrome.
  const paneState = useSessionStateStore((s) => s.paneStates.get(pane.id));
  const displayState = useSessionStateStore((s) => s.displayStates.get(pane.id));
  const agentCategory = useOrchStore((s) =>
    resolveAgentCategory(s.squads, pane.agentName, pane.role),
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pane.title);
  const [density, setDensity] = useState<Density>('full');
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const adapterLabel = pane.adapterId
    ? `${pane.adapterId}${pane.model ? ` · ${pane.model}` : ''}`
    : null;
  const isHibernated = paneState === 'hibernated';
  const isMaximized = maximizedPaneId === pane.id;

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      // Thresholds altos: com 3+ panes na grelha a toolbar morre cedo e o
      // Fechar era empurrado para fora (overflow do .pane). Compact cedo.
      const w = entries[0]?.contentRect.width ?? 500;
      if (w < 360) setDensity('compact');
      else if (w < 580) setDensity('icons');
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

    // A vacancy has no session, so "Fim" and "Dormir" would operate on
    // nothing. Offering them is the same lie as rendering a prompt: controls
    // that imply a process behind the pane. Layout actions stay — splitting a
    // vacancy is one of the ways the operator claims it.
    if (
      pane.kind !== 'browser' &&
      pane.agentTransport !== 'acp' &&
      !isVacancy
    ) {
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

    if (pane.kind === 'cli-agent' && pane.agentTransport !== 'acp') {
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
        id: 'maximize',
        label: isMaximized ? 'Restaurar' : 'Ampliar',
        detail: isMaximized
          ? 'Restaura a grade com todos os panes'
          : 'Amplia este pane sem fechar os outros',
        icon: isMaximized ? 'grid' : 'maximize',
        active: isMaximized,
        primary: true,
        run: () => toggleMaximizePane(pane.id),
      });
      // Splits NÃO são primary: em pane estreito empurravam o Fechar para fora
      // da toolbar e o utilizador ficava sem forma de fechar a janela.
      list.push({
        id: 'split-right',
        label: 'À direita',
        detail: 'Cria um novo pane ao lado (não copia o terminal)',
        shortcut: formatShortcut('mod', 'D'),
        icon: 'split-right',
        run: () => split(pane.id, 'row'),
      });
      list.push({
        id: 'split-down',
        label: 'Abaixo',
        detail: 'Cria um novo pane abaixo (não copia o terminal)',
        shortcut: formatShortcut('mod', 'shift', 'D'),
        icon: 'split-down',
        run: () => split(pane.id, 'column'),
      });
    }

    return list;
  }, [
    pane,
    isVacancy,
    isCanvas,
    isHibernated,
    isMaximized,
    paneState,
    split,
    toggleMaximizePane,
  ]);

  const closeAction: ToolbarAction = {
    id: 'close',
    label: 'Fechar',
    detail: `Fecha este pane (${formatShortcut('mod', 'W')})`,
    shortcut: formatShortcut('mod', 'W'),
    icon: 'close',
    danger: true,
    primary: true,
    run: () => void requestPaneClose(pane.id),
  };

  // Layout actions (split-right, split-down, maximize) are critical controls
  // and must always stay visible on the toolbar. Telemetry/session actions
  // (scroll-end, hibernate) go to overflow in icons/compact density.
  const overflow =
    density === 'compact'
      ? actions.filter((a) => a.id === 'scroll-end' || a.id === 'hibernate' || a.id === 'restart')
      : density === 'icons'
        ? actions.filter((a) => a.id === 'scroll-end' || a.id === 'hibernate')
        : [];
  const sessionVisible = actions.filter((a) =>
    density === 'compact'
      ? false
      : density === 'icons'
        ? a.id === 'restart'
        : a.id === 'scroll-end' || a.id === 'hibernate' || a.id === 'restart',
  );
  const layoutVisible = actions.filter(
    (a) => a.id === 'maximize' || a.id === 'split-right' || a.id === 'split-down',
  );

  function renderGroup(items: ToolbarAction[], aria: string) {
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
      {/* Meta shrinks first — never steal space from the close pin. */}
      <div className="toolbar__meta">
        <span className={`toolbar__dot ${isFocused ? 'toolbar__dot--on' : ''}`} />
        {/*
          Nome humano do pane. Existe para ser LIDO e repetido: "o pane 7
          travou" só aponta para algo exato se o 7 estiver na tela. É nome, não
          posição — não muda quando outro pane fecha.
        */}
        {pane.paneNumber !== undefined && (
          <button
            type="button"
            className="toolbar__pane-number nodrag"
            aria-label={`Pane ${pane.paneNumber}. Copiar identificador ${pane.id}`}
            data-tip={
              copiedId
                ? 'ID copiado'
                : `Pane ${pane.paneNumber} — nome fixo deste pane (fala e comandos). Clique para copiar o ID: ${pane.id}`
            }
            onClick={(event) => {
              event.stopPropagation();
              void navigator.clipboard.writeText(pane.id).then(() => {
                setCopiedId(true);
                window.setTimeout(() => setCopiedId(false), 1_500);
              });
            }}
          >
            {copiedId ? 'copiado' : `pane ${pane.paneNumber}`}
          </button>
        )}
        {/*
          Slot posicional (⌘1-9): POSIÇÃO no grid visível, não identidade —
          muda quando o layout muda. Namespace separado do nome durável de
          propósito; o chip só aparece quando há mais de um pane (com um só,
          o atalho não disputa nada).
        */}
        {paneSlot !== null && paneCount > 1 && (
          <span
            className="toolbar__pane-slot"
            data-tip={`⌘${paneSlot} foca este pane — posição no grid, muda quando o layout muda`}
          >
            ⌘{paneSlot}
          </span>
        )}
        {pane.kind === 'cli-agent' && (
          <AgentAvatar
            category={agentCategory}
            state={displayState ?? paneState ?? 'spawning'}
            size="micro"
            label={pane.agentName ?? pane.title}
            className="toolbar__agent-avatar"
          />
        )}
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
        {/*
          O hexadecimal só aparece para quem NÃO tem nome falável (layout
          antigo, antes da numeração). Com o número na tela, "#e05ae6" era ruído
          disputando o lugar do nome — mas o id continua a um clique daqui,
          porque é ele que a depuração e o protocolo usam.
        */}
        {pane.paneNumber === undefined && (
          <button
            type="button"
            className="toolbar__badge toolbar__pane-id nodrag"
            aria-label={`Copiar identificador do pane ${pane.id}`}
            data-tip={copiedId ? 'ID copiado' : `Copiar ID do pane: ${pane.id}`}
            onClick={(event) => {
              event.stopPropagation();
              void navigator.clipboard.writeText(pane.id).then(() => {
                setCopiedId(true);
                window.setTimeout(() => setCopiedId(false), 1_500);
              });
            }}
          >
            {copiedId ? 'copiado' : `#${pane.id.slice(-6)}`}
          </button>
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
            <ProviderLogo
              adapterId={pane.adapterId!}
              label={pane.adapterId!}
              size="xs"
            />
            <span className="toolbar__badge-text">{adapterLabel}</span>
          </span>
        ) : (
          <span className="toolbar__badge">
            {pane.agentTransport === 'acp' ? 'acp' : pane.kind}
          </span>
        )}
        {pane.kind === 'cli-agent' && (
          <StateIndicator paneId={pane.id} compact={density === 'compact'} />
        )}
        {pane.kind === 'cli-agent' && <CostBadge paneId={pane.id} />}
        <DevServerChip pane={pane} />
      </div>

      <div className="toolbar__actions">
        {renderGroup(sessionVisible, 'Sessão')}
        {pane.kind !== 'browser' && !isVacancy && density !== 'compact' && (
          <div className="toolbar__group" role="group" aria-label="Command blocks">
            <CommandBlockMenu paneId={pane.id} density={density} />
          </div>
        )}
        {renderGroup(layoutVisible, 'Layout')}
        {overflow.length > 0 && (
          <div className="toolbar__more" ref={menuRef}>
            <button
              type="button"
              className={`toolbar__btn nodrag${menuOpen ? ' toolbar__btn--active' : ''}`}
              aria-label="Mais ações do pane"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-tip="Mais ações (dormir, dividir, fim…)"
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
      </div>

      {/* Close pin: always last, never inside overflow, never clipped by meta. */}
      <button
        type="button"
        className="toolbar__close nodrag"
        aria-label="Fechar este pane"
        data-tip={closeAction.detail}
        title={`Fechar pane (${formatShortcut('mod', 'W')})`}
        onClick={(e) => {
          e.stopPropagation();
          closeAction.run();
        }}
      >
        <PixelIcon name="close" size={12} />
        <span className="toolbar__close-label">Fechar</span>
      </button>
    </div>
  );
}

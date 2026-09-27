import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MissionLifecycleState } from '../../../shared/mission-engine-contract';
import { missionLifecycleLabel } from '../../lib/mission-lifecycle-copy';
import type { PaneScopeEntry } from '../../lib/pane-spaces';
import { PanePicker } from '../PanePicker';
import { PixelIcon, type PixelIconName } from '../PixelIcon';

/**
 * Barra de abas do workspace — cada aba é uma FEATURE: os panes que o operador
 * abre nela e a missão que um deles começou (o orquestrador e os workers vão
 * junto). Substitui o rack de cartões de missão + pinos A/B + "Todos": o
 * operador lia a tela como três ferramentas diferentes para a mesma coisa
 * (campo 23/09: "a organização visual não tá legal").
 *
 * Linguagem de editor, não de dashboard: a aba ativa é o mesmo chão da grelha
 * (sem fio embaixo) com um fio de acento em cima; as demais são texto sobre a
 * barra. Estado nunca viaja só em cor: o glifo muda e o tooltip diz a palavra.
 */
export interface WorkspaceTabsProps {
  readonly scopes: readonly PaneScopeEntry[];
  /** Aba desenhada à esquerda; `null` na visão geral. */
  readonly activeScopeKey: string | null;
  /** Aba aberta ao lado da ativa (tela dividida). */
  readonly sideScopeKey: string | null;
  /** Visão geral: todos os panes do workspace num mosaico só. */
  readonly overview: boolean;
  readonly editing: { readonly key: string; readonly draft: string } | null;
  readonly onFocusScope: (scopeKey: string) => void;
  readonly onToggleOverview: () => void;
  /** Abre (ou, se já está, fecha) a aba ao lado da ativa. */
  readonly onToggleBeside: (scopeKey: string) => void;
  readonly onCloseBeside: () => void;
  readonly onStartRename: (scope: PaneScopeEntry) => void;
  readonly onRenameDraft: (draft: string) => void;
  readonly onCommitRename: () => void;
  readonly onCancelRename: () => void;
  readonly onCloseTab: (scope: PaneScopeEntry) => void;
  /** Pane criado pelo "+" da barra: ele nasce numa aba nova. */
  readonly onTabPaneCreated: (paneId: string) => void;
  readonly onNewMission: () => void;
  /**
   * Aba sem missão: o orquestrador dela (ou a primeira IA) passa a liderar a
   * missão leve da aba — um clique, sem assistente.
   */
  readonly onStartTabMission?: (scope: PaneScopeEntry) => void;
}

const LIFECYCLE_STATES: ReadonlySet<string> = new Set<MissionLifecycleState>([
  'draft',
  'review_ready',
  'starting',
  'running',
  'blocked_user',
  'blocked_technical',
  'recovering',
  'stopping',
  'failed',
  'completed',
]);

export type WorkspaceTabTone =
  | 'live'
  | 'attention'
  | 'repair'
  | 'done'
  | 'failed'
  | 'idle';

/** Um estado, uma cor — o mesmo mapa das superfícies de missão (`--state-*`). */
export function workspaceTabTone(state: string | undefined): WorkspaceTabTone | null {
  switch (state) {
    case 'running':
    case 'starting':
    case 'recovering':
      return 'live';
    case 'blocked_user':
      return 'attention';
    case 'blocked_technical':
      return 'repair';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'draft':
    case 'review_ready':
    case 'stopping':
      return 'idle';
    default:
      return null;
  }
}

function stateLabel(state: string | undefined): string | null {
  if (!state || !LIFECYCLE_STATES.has(state)) return null;
  return missionLifecycleLabel(state as MissionLifecycleState);
}

/** Missão da aba que ainda pode receber um orquestrador. */
function isActiveTabMission(mission: { readonly state?: string }): boolean {
  return mission.state === undefined || ['setup', 'running', 'blocked'].includes(mission.state);
}

const CLOSABLE_MISSION_STATES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'draft',
  'review_ready',
]);

/**
 * Fechar a aba encerra os panes dela. Uma missão viva (ou que o renderer ainda
 * não conhece) não se encerra por um × de aba: o caminho é o Quadro, que sabe
 * parar a coordenação sem deixar trabalho pela metade.
 */
export function workspaceTabIsClosable(scope: PaneScopeEntry): boolean {
  if (scope.kind === 'mission') {
    return scope.state !== undefined && CLOSABLE_MISSION_STATES.has(scope.state);
  }
  return scope.missions.every(
    (mission) =>
      mission.state !== undefined && CLOSABLE_MISSION_STATES.has(mission.state),
  );
}

function tabGlyph(scope: PaneScopeEntry): PixelIconName {
  if (scope.orchestrator) return 'orch';
  if (scope.kind === 'mission' || scope.missions.length > 0) return 'mission';
  return 'terminal';
}

function tabTooltip(scope: PaneScopeEntry, side: boolean): string {
  const lines = [scope.title];
  if (scope.isolated) lines.push('Pasta isolada desta aba');
  const label = stateLabel(scope.state);
  if (scope.kind === 'mission') {
    if (label) lines.push(`Missão · ${label}`);
  } else {
    for (const mission of scope.missions) {
      const missionLabel = stateLabel(mission.state);
      lines.push(`Missão: ${mission.title}${missionLabel ? ` · ${missionLabel}` : ''}`);
    }
  }
  if (scope.orchestrator) lines.push(`Orquestrador: ${scope.orchestrator.title}`);
  lines.push(`${scope.paneCount} ${scope.paneCount === 1 ? 'painel' : 'painéis'}`);
  if (side) lines.push('Aberta ao lado');
  if (scope.kind !== 'mission') lines.push('Duplo clique para renomear');
  return lines.join('\n');
}

function tabAccessibleName(scope: PaneScopeEntry): string {
  const label = stateLabel(scope.state);
  const count = `${scope.paneCount} ${scope.paneCount === 1 ? 'painel' : 'painéis'}`;
  return [scope.title, label, count].filter(Boolean).join(', ');
}

interface TabMenuState {
  readonly scope: PaneScopeEntry;
  readonly x: number;
  readonly y: number;
}

export function WorkspaceTabs({
  scopes,
  activeScopeKey,
  sideScopeKey,
  overview,
  editing,
  onFocusScope,
  onToggleOverview,
  onToggleBeside,
  onCloseBeside,
  onStartRename,
  onRenameDraft,
  onCommitRename,
  onCancelRename,
  onCloseTab,
  onTabPaneCreated,
  onNewMission,
  onStartTabMission,
}: WorkspaceTabsProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<TabMenuState | null>(null);

  // A aba ativa nunca fica escondida atrás da rolagem da barra.
  useLayoutEffect(() => {
    const selected = railRef.current?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
    selected?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeScopeKey, scopes.length]);

  const besideTarget =
    scopes.find((scope) => scope.key !== activeScopeKey)?.key ?? null;
  const canSplit = !overview && Boolean(activeScopeKey) && besideTarget !== null;

  // ←/→ entre as abas (ativação automática, padrão WAI-ARIA de tablist).
  const onRailKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const tabs = [
      ...(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []),
    ];
    const current = tabs.findIndex((tab) => tab === document.activeElement);
    if (current < 0) return;
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else if (event.key === 'F2') {
      const scope = scopes[current];
      if (scope && scope.kind !== 'mission') {
        event.preventDefault();
        onStartRename(scope);
      }
      return;
    } else return;
    event.preventDefault();
    tabs[next]?.focus();
    const scope = scopes[next];
    if (scope) onFocusScope(scope.key);
  };

  return (
    <header className="workspace-tabs" aria-label="Abas do workspace">
      <button
        type="button"
        className="workspace-tabs__icon-btn workspace-tabs__overview"
        aria-pressed={overview}
        aria-label="Visão geral: todos os painéis do workspace"
        title="Visão geral: todos os painéis do workspace num mosaico só"
        onClick={onToggleOverview}
      >
        <PixelIcon name="grid" size={12} />
      </button>
      <div
        ref={railRef}
        className="workspace-tabs__rail"
        role="tablist"
        aria-label="Abas de trabalho"
        onKeyDown={onRailKeyDown}
      >
        {scopes.map((scope) => {
          const active = !overview && scope.key === activeScopeKey;
          const side = !overview && scope.key === sideScopeKey;
          const tone = workspaceTabTone(scope.state);
          const closable = workspaceTabIsClosable(scope);
          const isEditing = editing?.key === scope.key;
          return (
            <div
              key={scope.key}
              className="workspace-tab"
              role="presentation"
              data-active={active || undefined}
              data-side={side || undefined}
              data-scope-kind={scope.kind}
              data-tone={tone ?? undefined}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ scope, x: event.clientX, y: event.clientY });
              }}
            >
              {isEditing ? (
                <div className="workspace-tab__main workspace-tab__main--editing">
                  <span className="workspace-tab__glyph" aria-hidden="true">
                    <PixelIcon name={tabGlyph(scope)} size={11} />
                  </span>
                  <input
                    className="workspace-tab__rename"
                    value={editing.draft}
                    autoFocus
                    aria-label={`Renomear a aba ${scope.title}`}
                    maxLength={120}
                    onChange={(event) => onRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        onCommitRename();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        onCancelRename();
                      }
                    }}
                    onBlur={onCommitRename}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  role="tab"
                  className="workspace-tab__main"
                  aria-selected={active}
                  aria-label={tabAccessibleName(scope)}
                  tabIndex={active || (!activeScopeKey && scope === scopes[0]) ? 0 : -1}
                  title={tabTooltip(scope, side)}
                  onClick={() => onFocusScope(scope.key)}
                  onDoubleClick={
                    scope.kind !== 'mission'
                      ? (event) => {
                          event.preventDefault();
                          onStartRename(scope);
                        }
                      : undefined
                  }
                >
                  <span className="workspace-tab__glyph" aria-hidden="true">
                    <PixelIcon name={tabGlyph(scope)} size={11} />
                  </span>
                  <span className="workspace-tab__title">{scope.title}</span>
                  {side ? (
                    <span className="workspace-tab__side" aria-hidden="true">
                      <PixelIcon name="split-right" size={10} />
                    </span>
                  ) : null}
                  <span className="workspace-tab__count" aria-hidden="true">
                    {scope.paneCount}
                  </span>
                </button>
              )}
              {closable && !isEditing ? (
                <button
                  type="button"
                  className="workspace-tab__close"
                  tabIndex={-1}
                  aria-label={`Fechar a aba ${scope.title}`}
                  title="Fechar a aba e os painéis dela"
                  onClick={() => onCloseTab(scope)}
                >
                  <PixelIcon name="close" size={8} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <PanePicker
        placement="tabbar"
        acceptsPendingOpen={false}
        onPaneCreated={onTabPaneCreated}
        trigger={{
          ariaLabel: 'Nova aba',
          title: 'Nova aba: escolha o terminal ou a IA que abre nela',
        }}
      />
      <div className="workspace-tabs__actions">
        {canSplit ? (
          <button
            type="button"
            className="workspace-tabs__icon-btn"
            aria-pressed={sideScopeKey !== null}
            aria-label={sideScopeKey ? 'Fechar a divisão' : 'Ver outra aba ao lado'}
            title={
              sideScopeKey
                ? 'Fechar a divisão e voltar para uma aba só'
                : 'Ver outra aba ao lado (clique direito numa aba para escolher qual)'
            }
            onClick={() =>
              sideScopeKey ? onCloseBeside() : besideTarget && onToggleBeside(besideTarget)
            }
          >
            <PixelIcon name="split-right" size={12} />
          </button>
        ) : null}
        <button type="button" className="workspace-tabs__mission" onClick={onNewMission}>
          <PixelIcon name="plus" size={10} />
          <span>Nova missão</span>
        </button>
      </div>
      {menu ? (
        <WorkspaceTabMenu
          menu={menu}
          active={!overview && menu.scope.key === activeScopeKey}
          side={!overview && menu.scope.key === sideScopeKey}
          canShowBeside={!overview && Boolean(activeScopeKey)}
          onClose={() => setMenu(null)}
          onToggleBeside={() => onToggleBeside(menu.scope.key)}
          onRename={() => onStartRename(menu.scope)}
          onCloseTab={() => onCloseTab(menu.scope)}
          onStartTabMission={
            onStartTabMission ? () => onStartTabMission(menu.scope) : undefined
          }
        />
      ) : null}
    </header>
  );
}

interface WorkspaceTabMenuProps {
  readonly menu: TabMenuState;
  readonly active: boolean;
  readonly side: boolean;
  readonly canShowBeside: boolean;
  readonly onClose: () => void;
  readonly onToggleBeside: () => void;
  readonly onRename: () => void;
  readonly onCloseTab: () => void;
  readonly onStartTabMission?: () => void;
}

const MENU_WIDTH = 268;
const MENU_HEIGHT = 240;

/** Mesmo vocabulário do menu de contexto do pane — nada de segunda linguagem. */
function WorkspaceTabMenu({
  menu,
  active,
  side,
  canShowBeside,
  onClose,
  onToggleBeside,
  onRename,
  onCloseTab,
  onStartTabMission,
}: WorkspaceTabMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { scope } = menu;

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = [
        ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
      ];
      if (items.length === 0) return;
      event.preventDefault();
      const index = items.findIndex((item) => item === document.activeElement);
      const next =
        event.key === 'ArrowDown'
          ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const items: Array<{
    readonly id: string;
    readonly icon: PixelIconName;
    readonly label: string;
    readonly detail: string;
    readonly run: () => void;
  }> = [];
  if (canShowBeside && !active) {
    items.push({
      id: 'beside',
      icon: 'split-right',
      label: side ? 'Fechar a divisão' : 'Ver ao lado',
      detail: side
        ? 'Volta a mostrar só a aba ativa.'
        : 'Divide a tela entre a aba ativa e esta.',
      run: onToggleBeside,
    });
  }
  // Só missão ATIVA conta — a mesma regra de "Tornar orquestrador": aba cuja
  // missão encerrou pode começar outra.
  if (onStartTabMission && scope.kind !== 'mission' && !scope.missions.some(isActiveTabMission)) {
    items.push({
      id: 'start-mission',
      icon: 'crown',
      label: 'Criar missão desta aba',
      detail: 'O orquestrador da aba lidera; os painéis dela ficam juntos.',
      run: onStartTabMission,
    });
  }
  if (scope.kind !== 'mission') {
    items.push({
      id: 'rename',
      icon: 'id-badge',
      label: 'Renomear',
      detail: 'O nome fica salvo com a aba.',
      run: onRename,
    });
  }
  if (workspaceTabIsClosable(scope)) {
    items.push({
      id: 'close',
      icon: 'close',
      label: 'Fechar a aba',
      detail: 'Encerra os painéis desta aba.',
      run: onCloseTab,
    });
  } else {
    items.push({
      id: 'close-blocked',
      icon: 'info',
      label: 'Missão em andamento',
      detail: 'Encerre a missão pelo Quadro para fechar esta aba.',
      run: () => undefined,
    });
  }

  const left = Math.max(8, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8));
  return createPortal(
    <div
      ref={menuRef}
      className="pane-context-menu workspace-tab-menu"
      role="menu"
      aria-label={`Ações da aba ${scope.title}`}
      style={{ left, top }}
      tabIndex={-1}
      onContextMenu={(event) => event.preventDefault()}
    >
      <p className="pane-context-menu__head">{scope.title}</p>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="pane-context-menu__item"
          aria-disabled={item.id === 'close-blocked' || undefined}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          <PixelIcon name={item.icon} size={12} />
          <span>
            <strong>{item.label}</strong>
            <small>{item.detail}</small>
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

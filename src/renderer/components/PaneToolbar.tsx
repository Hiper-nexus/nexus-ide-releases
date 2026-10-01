import { useAccessStore } from '../state/access-store';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import type { PaneModel } from '../../shared/types';
import type { JevPaneHint } from '../../shared/jev-ipc';
import {
  JEV_UNAVAILABLE_LABEL,
  type SpawnRouteInfo,
} from '../../shared/spawn-route';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { usePaneParkedStore } from '../state/pane-parked-store';
import { usePaneFootprintStore } from '../state/pane-footprint-store';
import { useJevHintStore } from '../state/jev-hint-store';
import {
  hibernateHost,
  onPaneSessionChange,
  repaintPaneTui,
  respawnWithResume,
  scrollPaneToBottom,
  wakeHost,
} from '../terminal/terminal-host';
import { CostBadge } from './CostBadge';
import { DevServerChip } from './DevServerChip';
import { TokenSpeedChip } from './TokenSpeedMonitor';
import { PixelIcon, type PixelIconName } from './PixelIcon';
import { requestPaneClose } from '../terminal/pane-close-guard';
import { getPaneSessionId } from '../terminal/terminal-host';
import { askConfirm } from '../state/confirm-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import {
  promotePaneWithMissionChoice,
  toastPromoted,
} from '../lib/pane-mission-promote';
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
import { resolveModelChipLabel } from '../lib/pane-model-label';
import { cliPaneDisplayTitle } from '../lib/pane-title';
import { OverlayLayer } from '../overlay/overlay-layer';

interface Props {
  pane: PaneModel;
  isFocused: boolean;
}

export type Density = 'full' | 'icons' | 'compact';
const COMPACT_TOOLBAR_WIDTH = 360;
const FULL_TOOLBAR_WIDTH = 760;
/**
 * F-686: folga para VOLTAR a um modo mais largo. No Windows a barra de
 * rolagem ocupa ~17 px (no macOS ela flutua): trocar de densidade mudava a
 * altura dos cabeçalhos, a barra da grade aparecia/sumia e TODOS os panes
 * cruzavam o limite juntos — o cabeçalho alternava título × botões a cada
 * quadro (gravação do operador, 29/09 18:08). Encolher continua imediato.
 */
export const TOOLBAR_DENSITY_HYSTERESIS_PX = 32;

const DENSITY_RANK: Record<Density, number> = { compact: 0, icons: 1, full: 2 };
const LOWER_DENSITY: Record<Density, Density> = { full: 'icons', icons: 'compact', compact: 'compact' };

/**
 * F-717: largura (content-box) que cada densidade já provou precisar. Os
 * limites fixos não sabem quanto custo, tok/s, Cmds e o botão de missão
 * ocupam: num pane de ~850 px a barra ficava em 'full' com rótulos, passava
 * da largura e o Fechar saía pelo `overflow: hidden` (print de 01/10).
 */
export type ToolbarNeeds = Partial<Record<Density, number>>;

function densityForWidth(width: number, needs: ToolbarNeeds): Density {
  let density: Density =
    width < COMPACT_TOOLBAR_WIDTH ? 'compact' : width < FULL_TOOLBAR_WIDTH ? 'icons' : 'full';
  while (density !== 'compact' && width < (needs[density] ?? 0)) density = LOWER_DENSITY[density];
  return density;
}

/** Densidade para `width` a partir de `current`, com histerese na subida. */
export function nextToolbarDensity(current: Density, width: number, needs: ToolbarNeeds = {}): Density {
  const target = densityForWidth(width, needs);
  if (DENSITY_RANK[target] <= DENSITY_RANK[current]) return target;
  const reachable = densityForWidth(width - TOOLBAR_DENSITY_HYSTERESIS_PX, needs);
  return DENSITY_RANK[reachable] > DENSITY_RANK[current] ? reachable : current;
}

/** A barra transbordou em `measured`: guarda quanto ela pedia (F-717). */
export function recordToolbarOverflow(
  needs: ToolbarNeeds,
  measured: Density,
  width: number,
  overflowPx: number,
): ToolbarNeeds {
  if (overflowPx <= 1 || measured === 'compact') return needs;
  const need = Math.ceil(width + overflowPx);
  return (needs[measured] ?? 0) >= need ? needs : { ...needs, [measured]: need };
}

function isDensity(value: string | undefined): value is Density {
  return value === 'full' || value === 'icons' || value === 'compact';
}
const MENU_VIEWPORT_GUTTER = 8;
const MENU_ANCHOR_GAP = 4;

/** Ação que muda o papel do pane — nunca inline, sempre no menu "…". */
const ROLE_CHANGE_ACTION_ID = 'promote-orchestrator';

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
  // 0.76.45: estacionado pelo guardian é um veredito do main sobre um pane
  // sem sessão — sobrepõe o que a sessão local (provavelmente 'exited')
  // mostraria, e reusa o ícone/cor do hibernado manual (mesma leitura visual,
  // sem precisar de token novo).
  const isParked = usePaneParkedStore((s) => s.parked.has(paneId));
  if (isParked) {
    return (
      <span
        className="toolbar__state toolbar__state--chip toolbar__state--hibernated"
        data-tip="Pane estacionado (guardian) — sessão encerrada, buffer preservado. Use Acordar."
        aria-label="Dormindo"
        style={compact ? { minWidth: 14 } : undefined}
      >
        <PixelIcon name="status-hibernated" size={10} />
        {!compact && <span className="toolbar__state-label">Dormindo</span>}
      </span>
    );
  }
  if (!state) return null;

  const view = paneSessionView(state);

  return (
    <span
      className={`toolbar__state toolbar__state--chip toolbar__state--${view.mod}`}
      data-tip={view.tip}
      aria-label={view.tip}
      // F-568: slot de largura fixa — o dot/ícone (não texto) que denota
      // atividade nunca deve mudar de largura entre frames do spinner do CLI.
      style={compact ? { minWidth: 14 } : undefined}
    >
      <PixelIcon name={STATE_ICON[view.mod]} size={10} />
      {!compact && <span className="toolbar__state-label">{view.chip}</span>}
    </span>
  );
}

const JEV_HINT_LABEL: Record<JevPaneHint['state'], string> = {
  waiting_for_human: 'Jev: esperando você',
  finished: 'Jev: terminou',
  errored: 'Jev: erro',
  working: 'Jev: trabalhando',
  idle_prompt: 'Jev: ocioso',
};

const JEV_HINT_MAX_AGE_MS = 10 * 60_000;

/** Chip advisory do classificador Jev (surface paneState) — hint < 10 min. */
function JevHintChip({ paneId }: { paneId: string }) {
  const sessionId = usePaneLiveSessionId(paneId);
  const hint = useJevHintStore((s) =>
    sessionId ? s.bySessionId.get(sessionId) : undefined,
  );
  const [, forceRender] = useState(0);
  useEffect(() => {
    if (!hint) return undefined;
    // Re-renderiza quando o hint expira para o chip sumir sem depender de
    // outra renderização do pane.
    const ms = hint.at + JEV_HINT_MAX_AGE_MS - Date.now();
    if (ms <= 0) return undefined;
    const timer = setTimeout(() => forceRender((n) => n + 1), ms);
    return () => clearTimeout(timer);
  }, [hint, sessionId]);
  if (!hint || Date.now() - hint.at > JEV_HINT_MAX_AGE_MS) return null;
  const tip = `Leitura Jev do conteúdo do pane · confiança ${hint.confidence.toFixed(2)}`;
  return (
    <span
      className="toolbar__state toolbar__state--chip"
      data-tip={tip}
      aria-label={tip}
    >
      <span className="toolbar__state-label">{JEV_HINT_LABEL[hint.state]}</span>
    </span>
  );
}

/** Quem escolheu a CLI deste pane: o Jev, ou a heurística porque ele caiu. */
function SpawnRouteChip({ route }: { route: SpawnRouteInfo | undefined }) {
  if (!route) return null;
  if (route.jevUnavailable) {
    const tip = `CLI escolhida pela heurística — Jev ${JEV_UNAVAILABLE_LABEL[route.jevUnavailable]}`;
    return (
      <span className="toolbar__state toolbar__state--chip" data-rota-chip="fallback" data-tip={tip} aria-label={tip}>
        <span className="toolbar__state-label">sem Jev</span>
      </span>
    );
  }
  if (route.source === 'heuristic') return null;
  const tip = 'CLI escolhida pelo Jev para esta tarefa';
  return (
    <span className="toolbar__state toolbar__state--chip" data-rota-chip="jev" data-tip={tip} aria-label={tip}>
      <span className="toolbar__state-label">Jev</span>
    </span>
  );
}

/** Sessão PTY viva deste pane, reativa (getPaneSessionId sozinho não re-renderiza). */
function usePaneLiveSessionId(paneId: string): string | null {
  const [sessionId, setSessionId] = useState<string | null>(() =>
    getPaneSessionId(paneId),
  );
  useEffect(() => {
    setSessionId(getPaneSessionId(paneId));
    return onPaneSessionChange((id, next) => {
      if (id === paneId) setSessionId(next);
    });
  }, [paneId]);
  return sessionId;
}

/** Acima disto, o badge de custo (RAM) vira aviso — tom do tema, não hardcoded. */
const FOOTPRINT_WARN_BYTES = 1.5 * 1024 * 1024 * 1024;

/** "512 MB" / "80 MB" (arredondado à dezena abaixo de 100 MB) / "1.8 GB". */
export function formatFootprintLabel(rssBytes: number): string {
  const mb = rssBytes / (1024 * 1024);
  if (mb < 100) return `${Math.round(mb / 10) * 10} MB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Badge discreto de RSS por pane (0.76.45) — null = nada, nunca "0 MB" inventado. */
function FootprintBadge({ paneId }: { paneId: string }) {
  const sessionId = usePaneLiveSessionId(paneId);
  const entry = usePaneFootprintStore((s) =>
    sessionId ? s.bySessionId[sessionId] : undefined,
  );
  if (!entry || entry.rssBytes === null) return null;
  const warn = entry.rssBytes >= FOOTPRINT_WARN_BYTES;
  return (
    <span
      className="toolbar__badge toolbar__footprint"
      data-tip={`${entry.processCount} processos · RSS da árvore`}
      // F-568: tabular-nums + largura mínima — o número muda a cada 30s, o
      // slot não pode empurrar os vizinhos a cada troca de dígito.
      style={{
        fontVariantNumeric: 'tabular-nums',
        minWidth: 52,
        textAlign: 'right',
        color: warn ? 'var(--danger)' : undefined,
      }}
    >
      {formatFootprintLabel(entry.rssBytes)}
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
  const isLeader = action.id === 'mission-leader';
  return (
    <button
      type="button"
      className={[
        menu ? 'toolbar__menu-item' : 'toolbar__btn',
        'nodrag',
        action.danger ? 'toolbar__btn--close' : '',
        action.active ? 'toolbar__btn--active' : '',
        isLeader ? 'toolbar__btn--leader-active' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={action.label}
      role={menu ? 'menuitem' : undefined}
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
export function PaneToolbar({ pane, isFocused }: Props) {
  const isVacancy = isStructuralPlaceholderPane(pane);
  const split = useLayoutStore((s) => s.split);
  const maximizedPaneId = useLayoutStore((s) => s.maximizedPaneId);
  const toggleMaximizePane = useLayoutStore((s) => s.toggleMaximizePane);
  const stageFocusMode = useLayoutStore((s) => s.stageFocusMode);
  const stagePaneId = useLayoutStore((s) => s.stagePaneId);
  const setStagePane = useLayoutStore((s) => s.setStagePane);
  const toggleStageFocus = useLayoutStore((s) => s.toggleStageFocus);
  const renameTitle = useLayoutStore((s) => s.renameTitle);
  const promoteMissionPaneRole = useLayoutStore((s) => s.promoteMissionPaneRole);
  const setPaneRole = useLayoutStore((s) => s.setPaneRole);
  const destination = useProductNavigationStore((s) => s.destination);
  const activeMissions = useOrchStore((s) => s.missions);
  const paneMissions = useOrchStore((s) => s.paneMissions);
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
  const [menuPosition, setMenuPosition] = useState({ left: MENU_VIEWPORT_GUTTER, top: MENU_VIEWPORT_GUTTER });
  const [copiedId, setCopiedId] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const needsRef = useRef<ToolbarNeeds>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  const adapterLabel = pane.adapterId
    ? `${pane.adapterId}${pane.model ? ` · ${pane.model}` : ''}`
    : null;
  // Chip compacto de LLM/versão — visível só quando o badge de adapter some (< 380px).
  // Fonte canônica: pane.adapterId + pane.model + pane.effort (despachados pelo spawn).
  const modelChipLabel =
    pane.kind === 'cli-agent'
      ? resolveModelChipLabel(pane.adapterId, pane.model, pane.effort)
      : null;
  const isHibernated = paneState === 'hibernated';
  // 0.76.45: estacionado pelo guardian dorme/acorda igual ao hibernado
  // manual — mesmo botão, mesmo wakeHost, só a origem da decisão muda.
  const isParked = usePaneParkedStore((s) => s.parked.has(pane.id));
  const isSleeping = isHibernated || isParked;
  const isMaximized = maximizedPaneId === pane.id;
  const hasLiveSession = usePaneLiveSessionId(pane.id) !== null;

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // F-717: além da largura do pane, os blocos rígidos (botões e telemetria)
    // — custo e tok/s crescem sem re-renderizar esta barra.
    const rigid = [...el.querySelectorAll<HTMLElement>(':scope > .toolbar__actions, :scope > .toolbar__telemetry')];
    let width: number | null = null;
    const ro = new ResizeObserver((entries) => {
      const own = entries.find((entry) => !rigid.includes(entry.target as HTMLElement));
      if (own) width = own.contentRect.width;
      if (width === null) return;
      const measured = el.dataset.density;
      if (isDensity(measured)) {
        needsRef.current = recordToolbarOverflow(needsRef.current, measured, width, el.scrollWidth - el.clientWidth);
      }
      const w = width;
      setDensity((current) => nextToolbarDensity(current, w, needsRef.current));
    });
    ro.observe(el);
    for (const block of rigid) ro.observe(block);
    return () => ro.disconnect();
  }, [pane.kind]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: globalThis.MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !menuTriggerRef.current?.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (!useAccessStore.getState().canUseApp) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setMenuOpen(false);
        menuTriggerRef.current?.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      if (!menuRef.current?.contains(e.target as Node)) return;
      const items = [...menuRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
      if (items.length === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
      const next = e.key === 'Home' ? 0
        : e.key === 'End' ? items.length - 1
          : e.key === 'ArrowUp' ? (current - 1 + items.length) % items.length
            : (current + 1) % items.length;
      items[next]?.focus();
    };
    const onResize = () => setMenuOpen(false);
    const onScroll = (e: Event) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [menuOpen]);

  function commit() {
    const clean = draft.trim();
    if (clean && clean !== pane.title) renameTitle(pane.id, clean);
    setEditing(false);
  }

  const actions = useMemo((): ToolbarAction[] => {
    const list: ToolbarAction[] = [];

    if (pane.kind !== 'browser' && !isVacancy) {
      if (pane.role === 'orchestrator') {
        list.push({
          id: 'mission-leader',
          label: 'Orquestrador',
          detail: 'Orquestrador atual (coordena tarefas e recebe delegações)',
          icon: 'crown',
          active: true,
          primary: true,
          run: () => {},
        });
      } else {
        list.push({
          // Muda o PAPEL do pane (consequência alta): mora no menu "…", em
          // grupo próprio, e não ao lado de "Ampliar"/"À direita", onde um
          // clique de layout errado virava troca de liderança.
          id: 'promote-orchestrator',
          label: 'Tornar este pane o orquestrador',
          detail: 'Este pane passa a coordenar a missão e receber delegações',
          icon: 'crown-outline',
          run: () => {
            // F-527: vínculo explícito — pane sem missão pergunta QUAL missão
            // liderar (ou abre uma nova separada), nunca anexa à "padrão".
            void promotePaneWithMissionChoice({ paneId: pane.id }).then(
              (missionId) => {
                if (!missionId) return;
                const title = useOrchStore
                  .getState()
                  .missions.find((m) => m.id === missionId)?.title;
                toastPromoted(title);
              },
            );
          },
        });
      }
    }

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
        label: isSleeping ? 'Acordar' : 'Dormir',
        detail: isParked
          ? 'Estacionado pelo guardian (ocioso) — acorda retomando a mesma sessão'
          : isHibernated
            ? 'Reabre o processo deste pane'
            : 'Encerra o processo e mantém o buffer na tela',
        icon: isSleeping ? 'sun' : 'moon',
        active: isSleeping,
        run: () => {
          if (isSleeping) {
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
      if (hasLiveSession) {
        list.push({
          id: 'repaint',
          label: 'Redesenhar tela',
          detail: 'Pede à CLI para redesenhar a tela no tamanho do pane',
          icon: 'refresh',
          run: () => repaintPaneTui(pane.id),
        });
      }
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

    if (stageFocusMode && stagePaneId && stagePaneId !== pane.id) {
      list.push({
        id: 'promote-to-stage',
        label: 'Ir ao Palco',
        detail: 'Trazer este pane para o palco principal',
        icon: 'sparkle',
        primary: true,
        run: () => setStagePane(pane.id),
      });
    }
    list.push({
      id: 'stage-focus',
      label: stageFocusMode ? 'Grade Normal' : 'Foco Stage',
      detail: stageFocusMode
        ? 'Restaura a grade completa com todos os panes'
        : 'Destaque no pane ativo com rail de companions (Cmd+Shift+F)',
      shortcut: formatShortcut('mod', 'shift', 'F'),
      icon: stageFocusMode ? 'grid' : 'sparkle',
      active: stageFocusMode,
      primary: true,
      run: () => toggleStageFocus(pane.id),
    });
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

    return list;
  }, [
    pane,
    isVacancy,
    isHibernated,
    isParked,
    isSleeping,
    isMaximized,
    stageFocusMode,
    stagePaneId,
    paneState,
    hasLiveSession,
    promoteMissionPaneRole,
    setPaneRole,
    destination,
    paneMissions,
    activeMissions,
    respawnWithResume,
    split,
    toggleMaximizePane,
    toggleStageFocus,
    setStagePane,
  ]);

  const closeAction: ToolbarAction = {
    id: 'close',
    label: 'Fechar',
    detail: `Fecha este pane (${formatShortcut('mod', 'W')})`,
    shortcut: formatShortcut('mod', 'W'),
    icon: 'close',
    danger: true,
    primary: true,
    run: () =>
      void requestPaneClose(pane.id, undefined, {
        hasLiveSession: getPaneSessionId(pane.id) !== null,
      }),
  };

  // A narrow pane reserves room for its close pin and the menu trigger.
  // Layout and mission actions remain available through the same menu.
  const sessionVisible = actions.filter((a) =>
    density === 'compact'
      ? false
      : density === 'icons'
        ? a.id === 'restart'
        : a.id === 'scroll-end' ||
          a.id === 'hibernate' ||
          a.id === 'repaint' ||
          a.id === 'restart',
  );
  const missionVisible = density === 'compact' ? [] : actions.filter(
    (a) => a.id === 'mission-leader',
  );
  const layoutVisible = density === 'compact' ? [] : actions.filter(
    (a) =>
      a.id === 'stage-focus' ||
      a.id === 'maximize' ||
      a.id === 'split-right' ||
      a.id === 'split-down',
  );
  const overflowActions =
    density === 'compact'
      ? actions
      : density === 'icons'
        ? actions.filter(
            (a) =>
              a.id === 'scroll-end' ||
              a.id === 'hibernate' ||
              a.id === 'repaint' ||
              a.id === ROLE_CHANGE_ACTION_ID,
          )
        : actions.filter(
            (a) =>
              !sessionVisible.some((s) => s.id === a.id) &&
              !missionVisible.some((m) => m.id === a.id) &&
              !layoutVisible.some((l) => l.id === a.id),
          );
  // Troca de papel fica por último, depois de um separador: ação de outra
  // natureza que as de sessão/layout do mesmo menu.
  const overflow = overflowActions.filter((a) => a.id !== ROLE_CHANGE_ACTION_ID);
  const overflowRole = overflowActions.filter((a) => a.id === ROLE_CHANGE_ACTION_ID);
  const hasOverflow = overflowActions.length > 0;

  useLayoutEffect(() => {
    if (!menuOpen || !menuRef.current || !menuTriggerRef.current) return;
    const anchor = menuTriggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const below = anchor.bottom + MENU_ANCHOR_GAP;
    const nextLeft = Math.max(MENU_VIEWPORT_GUTTER, Math.min(anchor.right - menu.width, window.innerWidth - menu.width - MENU_VIEWPORT_GUTTER));
    const nextTop = Math.max(MENU_VIEWPORT_GUTTER,
      below + menu.height <= window.innerHeight - MENU_VIEWPORT_GUTTER
        ? below : anchor.top - menu.height - MENU_ANCHOR_GAP,
    );
    setMenuPosition((prev) => {
      if (prev.left === nextLeft && prev.top === nextTop) return prev;
      return { left: nextLeft, top: nextTop };
    });
    menuRef.current.querySelector<HTMLButtonElement>('button')?.focus();
  }, [menuOpen, density]);

  function renderMenuItem(a: ToolbarAction) {
    return (
      <ToolbarBtn
        key={a.id}
        action={{
          ...a,
          run: () => {
            setMenuOpen(false);
            menuTriggerRef.current?.focus();
            a.run();
          },
        }}
        density="full"
        menu
      />
    );
  }

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
      <div
        className="toolbar__meta"
        // F-568: isola o reflow do cabeçalho — título/estado não devem
        // empurrar o resto do pane quando o CLI reescreve o título do
        // terminal a cada frame do spinner.
        style={{ contain: 'layout' }}
      >
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
            // Estacionado reusa o visual "hibernated" (avatar apagado) — não
            // existe estado 'parked' no avatar, a leitura já é a mesma.
            state={isParked ? 'hibernated' : displayState ?? paneState ?? 'spawning'}
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
            // F-568: tabular-nums trava a largura dos dígitos do título —
            // min-width/ellipsis já vêm do CSS global (.toolbar__title).
            style={{ fontVariantNumeric: 'tabular-nums' }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraft(pane.title);
              setEditing(true);
            }}
          >
            {pane.kind === 'cli-agent'
              ? cliPaneDisplayTitle(pane.adapterId, pane.title)
              : pane.title}
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
            <PixelIcon name="crown" size={10} className="toolbar__badge-crown" />
            <span>orq</span>
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
        {/*
          Chip compacto de LLM/versão: aparece quando o badge de adapter some
          (< 380 px via container query em base.css). O título da tarefa pode
          truncar, mas este chip NÃO desaparece — prioridade visual sobre o
          nome longo. Texto: médio (família + versão) em 'icons' density,
          compacto (só família) em 'compact' density.
        */}
        {modelChipLabel && (
          <span
            className="toolbar__model-chip"
            title={modelChipLabel.full}
            aria-label={`Modelo: ${modelChipLabel.full}`}
          >
            {density === 'compact'
              ? modelChipLabel.compact
              : modelChipLabel.medium}
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
        {pane.kind === 'cli-agent' && <JevHintChip paneId={pane.id} />}
        {pane.kind === 'cli-agent' && <SpawnRouteChip route={pane.spawnRoute} />}
        {pane.kind === 'cli-agent' && <FootprintBadge paneId={pane.id} />}
        <DevServerChip pane={pane} />
        {stageFocusMode && stagePaneId && stagePaneId !== pane.id && (
          <button
            type="button"
            className="toolbar__promote-stage-btn nodrag"
            aria-label={`Trazer ${pane.title || 'pane'} para o palco principal`}
            data-tip="Trazer este pane para o palco principal"
            onClick={(e) => {
              e.stopPropagation();
              setStagePane(pane.id);
            }}
          >
            <PixelIcon name="sparkle" size={10} />
            <span>Palco</span>
          </button>
        )}
      </div>

      {pane.kind === 'cli-agent' && (
        <div className="toolbar__telemetry">
          <CostBadge paneId={pane.id} />
          <TokenSpeedChip paneId={pane.id} />
        </div>
      )}

      <div className="toolbar__actions">
        {renderGroup(missionVisible, 'Missão')}
        {renderGroup(sessionVisible, 'Sessão')}
        {pane.kind !== 'browser' && !isVacancy && density !== 'compact' && (
          <div className="toolbar__group" role="group" aria-label="Command blocks">
            <CommandBlockMenu paneId={pane.id} density={density} />
          </div>
        )}
        {renderGroup(layoutVisible, 'Layout')}
        {hasOverflow && (
          <div className="toolbar__more">
            <button
              ref={menuTriggerRef}
              type="button"
              className={`toolbar__btn nodrag${menuOpen ? ' toolbar__btn--active' : ''}`}
              aria-label="Mais ações do pane"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-tip="Mais ações (dormir, dividir, fim…)"
              onClick={(e) => {
                e.stopPropagation();
                if (!menuOpen && menuTriggerRef.current) {
                  const anchor = menuTriggerRef.current.getBoundingClientRect();
                  const below = anchor.bottom + MENU_ANCHOR_GAP;
                  const estimatedWidth = 220;
                  setMenuPosition({
                    left: Math.max(MENU_VIEWPORT_GUTTER, Math.min(anchor.right - estimatedWidth, window.innerWidth - estimatedWidth - MENU_VIEWPORT_GUTTER)),
                    top: Math.max(MENU_VIEWPORT_GUTTER, below),
                  });
                  setMenuOpen(true);
                } else {
                  setMenuOpen(false);
                }
              }}
            >
              <PixelIcon name="more" size={11} />
            </button>
            {menuOpen && (
              <OverlayLayer>
              <div ref={menuRef} className="toolbar__menu" role="menu" style={menuPosition}>
                <p className="toolbar__menu-head">Ações do pane</p>
                {overflow.map(renderMenuItem)}
                {overflow.length > 0 && overflowRole.length > 0 && (
                  <div className="toolbar__menu-sep" role="separator" />
                )}
                {overflowRole.map(renderMenuItem)}
              </div>
              </OverlayLayer>
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

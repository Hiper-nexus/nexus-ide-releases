import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useMemoryStore } from '../state/memory-store';
import { useConfigInventoryStore } from '../state/config-inventory-store';
import { useSettingsStore } from '../state/settings-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useCloseWorkspaceStore } from './CloseWorkspaceDialog';
import { useFilesStore } from '../state/files-store';
import { CostSummary } from './CostBadge';
import { QuotaChip } from './QuotaChip';
import { listPanes } from '../lib/split-tree';
import { formatShortcut } from '../lib/platform';
import { VoiceButton } from './VoiceButton';
import { VisionIndicator } from './VisionIndicator';
import { NexusMark } from './NexusMark';
import { ProviderLogo } from './ProviderLogo';
import { PixelIcon, type PixelIconName } from './PixelIcon';
import { ActionCard, EmptyState } from './ActionCard';
import { EndorphinPresence } from './EndorphinPresence';
import { UpdateModal, UpdateStatusButton, useUpdateState } from './UpdateModal';
import type { AdapterInfo } from '../../shared/types';
import { agentPickerEmptyBeat } from '../../shared/endorphin';
import { setBrowserPaneSuppression } from '../browser/browser-host';
import { AccountSwitcher } from './AccountSwitcher';
import { useAccountStore } from '../state/account-store';
import { restartPanesForPendingAccount } from '../orch/account-restart-controller';
import { confirmAndReopenMission } from '../orch/confirm-reopen-mission';
import { statusLabel } from '../lib/mission-rail-groups';
import { AgentNotifications } from './AgentNotifications';
import { FleetChip } from './FleetChip';
import { clearEphemeralDraft, peekEphemeralDraft, saveEphemeralDraft } from '../state/ephemeral-draft-store';

const AGENT_PICKER_EMPTY = agentPickerEmptyBeat();

function adapterModelLabel(adapter: AdapterInfo, model: string): string {
  const info = adapter.models.info?.[model];
  const tags = [info?.availability ?? null, info?.costTier && info.costTier !== 'unknown' ? `cost:${info.costTier}` : null].filter(Boolean);
  return tags.length > 0 ? `${model} (${tags.join(', ')})` : model;
}

type BarDensity = 'full' | 'icons' | 'compact';
type BarMenu = 'workspace' | 'missions' | 'more';
type MenuFocusPosition = 'first' | 'last';

function densityFromWidth(width: number): BarDensity {
  // Thresholds um pouco mais cedo: labels longos em PT não devem empurrar
  // botões uns sobre os outros nem sobrepor o brand.
  if (width < 1160) return 'compact';
  if (width < 1480) return 'icons';
  return 'full';
}

function useBarDensity(): {
  density: BarDensity;
  barRef: RefObject<HTMLElement | null>;
} {
  const [density, setDensity] = useState<BarDensity>(() => (typeof window === 'undefined' ? 'full' : densityFromWidth(window.innerWidth)));
  const barRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onResize = () => setDensity(densityFromWidth(window.innerWidth));
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // Guarda de overflow real: a faixa por innerWidth não sabe quantos chips
  // existem (cota, custo, conta, update…). Se o conteúdo transbordar a barra,
  // desce um degrau até caber. Sobe de volta só via resize (faixa da janela),
  // o que evita oscilação layout→medida→layout.
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    if (el.scrollWidth > el.clientWidth + 2) {
      setDensity((d) => (d === 'full' ? 'icons' : d === 'icons' ? 'compact' : d));
    }
  });
  return { density, barRef };
}

interface ToolDef {
  id: string;
  label: string;
  icon: PixelIconName;
  title: string;
  active?: boolean;
  onClick: () => void;
}

/** Slim top chrome: brand, status, primary actions, overflow tools, system zone. */
export function WorkspaceBar({
  onOpenDiff,
  onOpenIntegrations,
  onOpenMediaStudio,
}: {
  onOpenDiff?: () => void;
  onOpenIntegrations?: () => void;
  onOpenMediaStudio?: () => void;
} = {}) {
  const root = useLayoutStore((s) => s.root);
  const viewKind = useLayoutStore((s) => s.viewKind);
  const spawnAgent = useLayoutStore((s) => s.spawnAgent);
  const addShellPane = useLayoutStore((s) => s.addShellPane);
  const addBrowserPane = useLayoutStore((s) => s.addBrowserPane);
  const toggleView = useLayoutStore((s) => s.toggleView);
  const paneCount = listPanes(root).length;

  const orchPanelOpen = useOrchStore((s) => s.panelOpen);
  const toggleOrchPanel = useOrchStore((s) => s.togglePanel);
  const memoryPanelOpen = useMemoryStore((s) => s.panelOpen);
  const toggleMemoryPanel = useMemoryStore((s) => s.togglePanel);
  const configInventoryOpen = useConfigInventoryStore((s) => s.open);
  const toggleConfigInventory = useConfigInventoryStore((s) => s.toggle);
  const opsBoardOpen = useOrchStore((s) => s.boardOpen);
  const toggleOpsBoard = useOrchStore((s) => s.toggleBoard);
  const missions = useOrchStore((s) => s.missions);
  const boundWorkspacePath = useOrchStore((s) => s.boundWorkspacePath);
  const toggleSettings = useSettingsStore((s) => s.toggleDrawer);
  const closeSettingsDrawer = useSettingsStore((s) => s.closeDrawer);
  const workspace = useWorkspaceStore((s) => s.current);
  const openAgentic = useMissionWizardStore((s) => s.openForAgentic);
  const openNewWorkspace = useMissionWizardStore((s) => s.openForNewWorkspace);
  const askCloseWorkspace = useCloseWorkspaceStore((s) => s.ask);
  const filesOpen = useFilesStore((s) => s.open);
  const toggleFiles = useFilesStore((s) => s.togglePanel);
  const activeTodo = useOrchStore((s) => {
    for (const list of s.todoLists) {
      const current = list.items.find((item) => item.status === 'in_progress');
      if (current) return current.name;
    }
    return null;
  });

  const { density, barRef } = useBarDensity();
  const showLabels = density === 'full';
  const compact = density === 'compact';
  const restartAdapterId = useAccountStore((s) => s.restartAdapterId);

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [adaptersLoading, setAdaptersLoading] = useState(true);
  const [adaptersError, setAdaptersError] = useState<string | null>(null);
  const [adapterLoadAttempt, setAdapterLoadAttempt] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const updateState = useUpdateState();
  const [updateOpen, setUpdateOpen] = useState(false);
  const [selectedAdapter, setSelectedAdapter] = useState<AdapterInfo | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [missionMenuOpen, setMissionMenuOpen] = useState(false);
  const [missionBusy, setMissionBusy] = useState(false);
  const wsMenuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const missionMenuRef = useRef<HTMLDivElement>(null);
  const wsMenuContentRef = useRef<HTMLDivElement>(null);
  const moreMenuContentRef = useRef<HTMLDivElement>(null);
  const missionMenuContentRef = useRef<HTMLDivElement>(null);
  const wsTriggerRef = useRef<HTMLButtonElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const missionTriggerRef = useRef<HTMLButtonElement>(null);
  const agentTriggerRef = useRef<HTMLButtonElement>(null);
  const pickerDialogRef = useRef<HTMLDivElement>(null);
  const pickerPanelRef = useRef<HTMLDivElement>(null);
  const [menuFocusRequest, setMenuFocusRequest] = useState<{
    menu: BarMenu;
    position: MenuFocusPosition;
  } | null>(null);

  function menuContent(menu: BarMenu): HTMLDivElement | null {
    if (menu === 'workspace') return wsMenuContentRef.current;
    if (menu === 'missions') return missionMenuContentRef.current;
    return moreMenuContentRef.current;
  }

  function menuTrigger(menu: BarMenu): HTMLButtonElement | null {
    if (menu === 'workspace') return wsTriggerRef.current;
    if (menu === 'missions') return missionTriggerRef.current;
    return moreTriggerRef.current;
  }

  function isMenuOpen(menu: BarMenu): boolean {
    if (menu === 'workspace') return wsMenuOpen;
    if (menu === 'missions') return missionMenuOpen;
    return moreOpen;
  }

  function setMenuOpen(menu: BarMenu, open: boolean): void {
    if (menu === 'workspace') setWsMenuOpen(open);
    if (menu === 'missions') setMissionMenuOpen(open);
    if (menu === 'more') setMoreOpen(open);
  }

  function menuItems(menu: HTMLElement): HTMLElement[] {
    return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')).filter((item) => item.getAttribute('aria-disabled') !== 'true');
  }

  function focusMenuItem(menu: BarMenu, position: MenuFocusPosition): void {
    const content = menuContent(menu);
    if (!content) return;
    const items = menuItems(content);
    const target = position === 'last' ? items.at(-1) : items[0];
    target?.focus();
  }

  function openMenu(menu: BarMenu, position: MenuFocusPosition = 'first'): void {
    setWsMenuOpen(menu === 'workspace');
    setMissionMenuOpen(menu === 'missions');
    setMoreOpen(menu === 'more');
    setMenuFocusRequest({ menu, position });
  }

  function toggleMenu(menu: BarMenu): void {
    if (isMenuOpen(menu)) {
      setMenuOpen(menu, false);
      return;
    }
    openMenu(menu);
  }

  function closeMenuAndRestoreFocus(menu: BarMenu): void {
    setMenuOpen(menu, false);
    requestAnimationFrame(() => menuTrigger(menu)?.focus());
  }

  function handleMenuTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, menu: BarMenu): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(menu, event.key === 'ArrowUp' ? 'last' : 'first');
    } else if (event.key === 'Escape' && isMenuOpen(menu)) {
      event.preventDefault();
      setMenuOpen(menu, false);
    }
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, menu: BarMenu): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenuAndRestoreFocus(menu);
      return;
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = menuItems(event.currentTarget);
    if (items.length === 0) return;

    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowUp'
            ? currentIndex <= 0
              ? items.length - 1
              : currentIndex - 1
            : currentIndex === -1 || currentIndex === items.length - 1
              ? 0
              : currentIndex + 1;
    items[nextIndex]?.focus();
  }

  function pickerFocusableElements(): HTMLElement[] {
    const panel = pickerPanelRef.current;
    if (!panel) return [];
    return Array.from(
      panel.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
    ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
  }

  function restorePickerTriggerFocus(): void {
    requestAnimationFrame(() => agentTriggerRef.current?.focus());
  }

  function closePickerAndRestoreFocus(): void {
    softClosePicker();
    restorePickerTriggerFocus();
  }

  function handlePickerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePickerAndRestoreFocus();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = pickerFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      pickerPanelRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  const localMissions = useMemo(() => {
    if (!workspace?.path || boundWorkspacePath !== workspace.path) return [];
    return [...missions].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [boundWorkspacePath, missions, workspace?.path]);

  const quickMissions = useMemo(() => localMissions.filter((m) => m.status === 'running' || m.status === 'blocked' || m.status === 'pending').slice(0, 8), [localMissions]);

  useEffect(() => {
    let cancelled = false;
    let changed = false;
    setAdaptersLoading(true);
    setAdaptersError(null);
    void window.nexus.adapters
      .list()
      .then((list) => {
        if (!cancelled && !changed) setAdapters(list);
      })
      .catch((cause) => {
        if (!cancelled && !changed) {
          setAdapters([]);
          setAdaptersError(
            cause instanceof Error && cause.message.trim()
              ? cause.message
              : 'O catálogo local de providers não respondeu.',
          );
        }
      })
      .finally(() => {
        if (!cancelled && !changed) setAdaptersLoading(false);
    });
    const unsub = window.nexus.adapters.onChanged((list) => {
      if (cancelled) return;
      changed = true;
      setAdapters(list);
      setAdaptersError(null);
      setAdaptersLoading(false);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [adapterLoadAttempt]);

  useEffect(() => {
    setBrowserPaneSuppression('agent-picker', pickerOpen);
    return () => setBrowserPaneSuppression('agent-picker', false);
  }, [pickerOpen]);

  useEffect(() => {
    if (!menuFocusRequest || !isMenuOpen(menuFocusRequest.menu)) return;
    const request = menuFocusRequest;
    const frame = requestAnimationFrame(() => {
      focusMenuItem(request.menu, request.position);
      setMenuFocusRequest((current) => (current === request ? null : current));
    });
    return () => cancelAnimationFrame(frame);
  }, [menuFocusRequest, missionMenuOpen, moreOpen, wsMenuOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    const frame = requestAnimationFrame(() => {
      const [first] = pickerFocusableElements();
      (first ?? pickerPanelRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [pickerOpen, adaptersLoading, adaptersError]);

  useEffect(() => {
    if (!pickerOpen) return;
    const dialog = pickerDialogRef.current;
    if (!dialog) return;

    // The picker is nested in the top bar, so inert every sibling branch from
    // the dialog up to <body>. This keeps the dialog itself live while
    // preventing pointer, focus and assistive-technology access to the bar,
    // canvas and any other app surface behind it.
    const background = new Set<HTMLElement>();
    let branch: HTMLElement = dialog;
    while (branch.parentElement) {
      const parent = branch.parentElement;
      for (const candidate of Array.from(parent.children)) {
        if (candidate instanceof HTMLElement && candidate !== branch) {
          background.add(candidate);
        }
      }
      if (parent === document.body) break;
      branch = parent;
    }
    const previous = [...background].map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
    for (const element of background) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    return () => {
      for (const { element, inert, ariaHidden } of previous) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      }
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (!wsMenuOpen && !moreOpen && !missionMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wsMenuOpen && wsMenuRef.current && !wsMenuRef.current.contains(t)) {
        setWsMenuOpen(false);
      }
      if (moreOpen && moreRef.current && !moreRef.current.contains(t)) {
        setMoreOpen(false);
      }
      if (missionMenuOpen && missionMenuRef.current && !missionMenuRef.current.contains(t)) {
        setMissionMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (wsMenuOpen) closeMenuAndRestoreFocus('workspace');
        if (moreOpen) closeMenuAndRestoreFocus('more');
        if (missionMenuOpen) closeMenuAndRestoreFocus('missions');
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [wsMenuOpen, moreOpen, missionMenuOpen]);

  const installedAdapters = adapters.filter((a) => a.installed);

  function openPicker() {
    const draft = peekEphemeralDraft<{ adapterId: string; model: string }>('agent-picker');
    const fromDraft = draft ? (installedAdapters.find((a) => a.id === draft.adapterId) ?? null) : null;
    const first = fromDraft ?? installedAdapters[0] ?? null;
    setSelectedAdapter(first);
    setSelectedModel(fromDraft && draft ? draft.model || first?.models.default || '' : (first?.models.default ?? ''));
    setPickerOpen(true);
  }

  /** Soft-close: keep adapter/model selection for the next open. */
  function softClosePicker() {
    if (selectedAdapter) {
      saveEphemeralDraft('agent-picker', {
        adapterId: selectedAdapter.id,
        model: selectedModel,
      });
    }
    setPickerOpen(false);
  }

  /** Explicit cancel discards the selection draft. */
  function discardClosePicker() {
    clearEphemeralDraft('agent-picker');
    setPickerOpen(false);
  }

  function confirmSpawn() {
    if (!selectedAdapter) return;
    spawnAgent(selectedAdapter.id, selectedModel || selectedAdapter.models.default);
    clearEphemeralDraft('agent-picker');
    setPickerOpen(false);
  }

  function handleAdapterChange(id: string) {
    const a = installedAdapters.find((x) => x.id === id) ?? null;
    setSelectedAdapter(a);
    setSelectedModel(a?.models.default ?? '');
  }

  const secondaryTools: ToolDef[] = [
    {
      id: 'terminal',
      label: 'Terminal',
      icon: 'terminal',
      title: `Abrir um terminal shell novo (${paneCount} pane${paneCount === 1 ? '' : 's'} aberto${paneCount === 1 ? '' : 's'} · ${formatShortcut('mod', 'D')} divide o pane focado)`,
      onClick: addShellPane,
    },
    {
      id: 'browser',
      label: 'Navegador',
      icon: 'browser',
      title: 'Abrir um navegador embutido em um painel novo',
      onClick: () => addBrowserPane(),
    },
    {
      id: 'view',
      label: viewKind === 'canvas' ? 'Grade' : 'Canvas',
      icon: viewKind === 'canvas' ? 'grid' : 'canvas',
      title: viewKind === 'grid' ? 'Mudar para Canvas (arrastar painéis livremente)' : 'Mudar para Grade (painéis divididos)',
      active: viewKind === 'canvas',
      onClick: toggleView,
    },
    {
      id: 'files',
      label: 'Arquivos',
      icon: 'files',
      title: 'Arquivos do workspace (ver/editar)',
      active: filesOpen,
      onClick: toggleFiles,
    },
    {
      id: 'board',
      label: 'Painel',
      icon: 'board',
      title: `Painel de operações — pipeline de missões (${formatShortcut('mod', 'B')})`,
      active: opsBoardOpen,
      onClick: toggleOpsBoard,
    },
    {
      id: 'orch',
      label: 'Equipe',
      icon: 'orch',
      title: 'Missões, handoffs, tarefas e squads',
      active: orchPanelOpen,
      onClick: toggleOrchPanel,
    },
    {
      id: 'memory',
      label: 'Memória',
      icon: 'sparkle',
      title: 'Memória do workspace — fatos, decisões e preferências dos agentes',
      active: memoryPanelOpen,
      onClick: toggleMemoryPanel,
    },
    {
      id: 'configs',
      label: 'Configs',
      icon: 'config',
      title: 'O que cada CLI enxerga neste workspace (MCP, rules, skills, comandos)',
      active: configInventoryOpen,
      onClick: toggleConfigInventory,
    },
  ];

  // Dieta da bar (critique P1): só Terminal fica inline; todo o resto mora no
  // ⋯ em TODAS as densidades — e a 1 tecla via ⌘K. Cada control visível
  // precisa merecer o lugar.
  if (onOpenDiff) {
    secondaryTools.push({
      id: 'diff',
      label: 'Diff',
      icon: 'files',
      title: 'Ver diferenças e anotar para o agente',
      onClick: onOpenDiff,
    });
  }
  if (onOpenIntegrations) {
    secondaryTools.push({
      id: 'apps',
      label: 'GitHub',
      icon: 'bolt',
      title: `GitHub (PRs, issues), Linear e port forward — também no ${formatShortcut('mod', 'K')}`,
      onClick: onOpenIntegrations,
    });
  }
  if (onOpenMediaStudio) {
    secondaryTools.push({
      id: 'media',
      label: 'Criar mídia',
      icon: 'vision',
      title: 'Estúdio de Mídia — gere imagens e vídeos com IA, sem agente',
      onClick: onOpenMediaStudio,
    });
  }
  // Achado de operador: enterrado no ⋯, o GitHub lia como "não existe" mesmo
  // implementado. Sobe para inline ao lado do Terminal; o resto segue na dieta.
  const INLINE_TOOL_IDS = new Set(['terminal', 'apps']);
  const inlineTools = secondaryTools.filter((t) => INLINE_TOOL_IDS.has(t.id));
  const overflowTools = secondaryTools.filter((t) => !INLINE_TOOL_IDS.has(t.id));

  // Painéis/panes abrem ATRÁS do drawer de configurações — ativar uma
  // ferramenta com o drawer aberto parecia clique morto (bug de operador).
  // Toda ativação fecha o drawer primeiro para o resultado ficar visível.
  function activateTool(tool: ToolDef): void {
    closeSettingsDrawer();
    tool.onClick();
  }

  function renderToolBtn(tool: ToolDef, opts?: { menu?: boolean }) {
    if (opts?.menu) {
      return (
        <button
          key={tool.id}
          type="button"
          className={`workspace-bar__menu-item ${tool.active ? 'workspace-bar__menu-item--active' : ''}`}
          role="menuitem"
          title={tool.title}
          onClick={() => {
            activateTool(tool);
            setMoreOpen(false);
          }}
        >
          <PixelIcon name={tool.icon} size={12} />
          <span>{tool.label}</span>
        </button>
      );
    }
    return (
      <button
        key={tool.id}
        type="button"
        className={`workspace-bar__btn ${tool.active ? 'workspace-bar__btn--view-active' : ''} ${tool.id === 'view' ? 'workspace-bar__btn--view' : ''}`}
        onClick={() => activateTool(tool)}
        title={tool.title}
        aria-label={tool.title}
      >
        <PixelIcon name={tool.icon} />
        {showLabels && <span className="workspace-bar__btn-label">{tool.label}</span>}
      </button>
    );
  }

  return (
    <header ref={barRef} className={`workspace-bar workspace-bar--${density}`} data-density={density}>
      {/* Brand: logo + name + workspace menu (novo/fechar) — no Board duplicate */}
      <div className="workspace-bar__brand">
        <NexusMark size={15} className="workspace-bar__logo" />
        {workspace ? (
          <>
            <div className="workspace-bar__ws" ref={wsMenuRef}>
              <button
                ref={wsTriggerRef}
                type="button"
                className="workspace-bar__name-btn"
                title={workspace.path}
                aria-haspopup="menu"
                aria-expanded={wsMenuOpen}
                aria-controls="workspace-bar-workspace-menu"
                onKeyDown={(event) => handleMenuTriggerKeyDown(event, 'workspace')}
                onClick={() => toggleMenu('workspace')}
              >
                <PixelIcon name="files" size={12} />
                <span className="workspace-bar__context-copy">
                  <span className="workspace-bar__context-label">Workspace ativo</span>
                  <span className="workspace-bar__name">{workspace.name}</span>
                </span>
                <span className="workspace-bar__name-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {wsMenuOpen && (
                <div
                  ref={wsMenuContentRef}
                  id="workspace-bar-workspace-menu"
                  className="workspace-bar__menu"
                  role="menu"
                  aria-label="Ações do workspace"
                  onKeyDown={(event) => handleMenuKeyDown(event, 'workspace')}
                >
                  <div className="workspace-bar__menu-heading">
                    {workspace.name}
                    <span className="workspace-bar__menu-heading-meta workspace-bar__workspace-path" title={workspace.path}>
                      {workspace.path}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="workspace-bar__menu-item"
                    role="menuitem"
                    onClick={() => {
                      askCloseWorkspace();
                      setWsMenuOpen(false);
                    }}
                  >
                    <PixelIcon name="close" size={12} />
                    <span>Fechar workspace</span>
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <span className="workspace-bar__name">Nenhum workspace</span>
        )}
        <button type="button" className="workspace-bar__new-workspace" title="Criar ou abrir outro workspace" aria-label="Novo workspace" onClick={openNewWorkspace}>
          <PixelIcon name="plus" size={11} />
          <span className="workspace-bar__new-workspace-label">Novo workspace</span>
        </button>
      </div>

      <div className="workspace-bar__actions">
        {/* Status: frota + cost (capped width). O OperatorHud (XP) mora no
            rail — a zona de status da bar é só sinal operacional. */}
        <div className="workspace-bar__zone workspace-bar__zone--status">
          <AgentNotifications />
          <FleetChip />
          <QuotaChip />
          {!compact && <CostSummary />}
          {activeTodo && !compact && (
            <span className="workspace-bar__todo" title="Tarefa de orquestração atual">
              <PixelIcon name="mission" size={10} />
              <span className="workspace-bar__todo-text">{activeTodo}</span>
            </span>
          )}
        </div>

        {/* Primary: always visible — Nova missão + seletor local desta pasta */}
        <div className="workspace-bar__zone workspace-bar__zone--primary">
          <button
            className="workspace-bar__btn workspace-bar__btn--primary"
            onClick={() => openAgentic()}
            title={`Nova missão neste workspace (${formatShortcut('mod', 'N')})`}
            aria-label="Nova missão neste workspace"
          >
            <PixelIcon name="plus" />
            <span className="workspace-bar__btn-label">{compact ? 'Nova' : 'Nova missão'}</span>
          </button>
          <div className="workspace-bar__mission-menu" ref={missionMenuRef}>
            <button
              ref={missionTriggerRef}
              type="button"
              className={`workspace-bar__btn workspace-bar__btn--missions ${missionMenuOpen ? 'workspace-bar__btn--view-active' : ''}`}
              title={workspace ? `Missões de ${workspace.name} — abrir ou retomar` : 'Missões do workspace'}
              aria-label="Lista de missões deste workspace"
              aria-haspopup="menu"
              aria-expanded={missionMenuOpen}
              aria-controls="workspace-bar-missions-menu"
              onKeyDown={(event) => handleMenuTriggerKeyDown(event, 'missions')}
              onClick={() => toggleMenu('missions')}
            >
              <PixelIcon name="mission" />
              {!compact && (
                <span className="workspace-bar__btn-label">
                  Missões
                  {localMissions.length > 0 ? ` (${localMissions.length})` : ''}
                </span>
              )}
              {compact && localMissions.length > 0 && <span className="workspace-bar__mission-count">{localMissions.length}</span>}
            </button>
            {missionMenuOpen && (
              <div
                ref={missionMenuContentRef}
                id="workspace-bar-missions-menu"
                className="workspace-bar__menu workspace-bar__menu--missions"
                role="menu"
                aria-label="Missões deste workspace"
                onKeyDown={(event) => handleMenuKeyDown(event, 'missions')}
              >
                <div className="workspace-bar__menu-heading">
                  {workspace ? workspace.name : 'Workspace'}
                  <span className="workspace-bar__menu-heading-meta">só esta pasta</span>
                </div>
                <button
                  type="button"
                  className="workspace-bar__menu-item workspace-bar__menu-item--accent"
                  role="menuitem"
                  onClick={() => {
                    openAgentic();
                    setMissionMenuOpen(false);
                  }}
                >
                  <PixelIcon name="plus" size={12} />
                  <span>Nova missão</span>
                </button>
                {quickMissions.length === 0 ? (
                  <p className="workspace-bar__menu-empty">Nenhuma missão ativa aqui.</p>
                ) : (
                  quickMissions.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="workspace-bar__menu-item"
                      role="menuitem"
                      disabled={missionBusy}
                      title={m.title}
                      onClick={() => {
                        setMissionBusy(true);
                        void confirmAndReopenMission(m)
                          .catch(() => undefined)
                          .finally(() => {
                            setMissionBusy(false);
                            setMissionMenuOpen(false);
                          });
                      }}
                    >
                      <PixelIcon name="mission" size={12} />
                      <span className="workspace-bar__menu-mission">
                        <span className="workspace-bar__menu-mission-title">{m.title}</span>
                        <span className="workspace-bar__menu-mission-meta">{statusLabel(m.status)}</span>
                      </span>
                    </button>
                  ))
                )}
                <div className="workspace-bar__menu-sep" />
                <button
                  type="button"
                  className="workspace-bar__menu-item"
                  role="menuitem"
                  onClick={() => {
                    toggleOpsBoard();
                    setMissionMenuOpen(false);
                  }}
                >
                  <PixelIcon name="board" size={12} />
                  <span>Painel de operações</span>
                </button>
              </div>
            )}
          </div>
          <button ref={agentTriggerRef} className="workspace-bar__btn workspace-bar__btn--agent" onClick={openPicker} title="Abrir um agente de IA em um painel novo" aria-label="Abrir agente">
            <PixelIcon name="agent" />
            {showLabels && <span className="workspace-bar__btn-label">Agente</span>}
          </button>
        </div>

        <span className="workspace-bar__sep" aria-hidden="true" />

        {/* Secondary tools + overflow */}
        <div className="workspace-bar__zone workspace-bar__zone--tools">
          {inlineTools.map((tool) => renderToolBtn(tool))}
          {overflowTools.length > 0 && (
            <div className="workspace-bar__more" ref={moreRef}>
              <button
                ref={moreTriggerRef}
                type="button"
                className={`workspace-bar__btn workspace-bar__btn--more ${moreOpen ? 'workspace-bar__btn--view-active' : ''}`}
                title="Mais ferramentas"
                aria-label="Mais ferramentas"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                aria-controls="workspace-bar-more-menu"
                onKeyDown={(event) => handleMenuTriggerKeyDown(event, 'more')}
                onClick={() => toggleMenu('more')}
              >
                ⋯
              </button>
              {moreOpen && (
                <div
                  ref={moreMenuContentRef}
                  id="workspace-bar-more-menu"
                  className="workspace-bar__menu workspace-bar__menu--end"
                  role="menu"
                  aria-label="Mais ferramentas"
                  onKeyDown={(event) => handleMenuKeyDown(event, 'more')}
                >
                  {overflowTools.map((tool) => renderToolBtn(tool, { menu: true }))}
                  {compact && updateState && (
                    <>
                      <div className="workspace-bar__menu-sep" />
                      <button
                        type="button"
                        className="workspace-bar__menu-item"
                        role="menuitem"
                        onClick={() => {
                          setUpdateOpen(true);
                          setMoreOpen(false);
                        }}
                      >
                        <PixelIcon name="update" size={12} />
                        <span>Atualizações</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <span className="workspace-bar__sep" aria-hidden="true" />

        {/* System: always visible — voice, vision, update, config */}
        <div className="workspace-bar__zone workspace-bar__zone--system">
          <VoiceButton />
          <VisionIndicator />
          {!compact && (
            <div className="workspace-bar__account-zone" title="Hot-swap de contas CLI">
              <AccountSwitcher compact />
              {restartAdapterId && (
                <button
                  type="button"
                  className="workspace-bar__account-restart"
                  title={`Reiniciar panes ${restartAdapterId} após troca de conta`}
                  aria-label={`Reiniciar panes ${restartAdapterId} após troca de conta`}
                  onClick={() => restartPanesForPendingAccount()}
                >
                  <PixelIcon name="restart" size={12} />
                </button>
              )}
            </div>
          )}
          {updateState && !compact && <UpdateStatusButton state={updateState} alwaysVisible compact={density !== 'full'} onClick={() => setUpdateOpen(true)} />}
          <button
            className="workspace-bar__btn"
            onClick={() => {
              setUpdateOpen(false);
              toggleSettings();
            }}
            title={`Conta, plano, módulos e catálogo (${formatShortcut('mod', ',')})`}
            aria-label="Configurações"
          >
            <PixelIcon name="config" />
            {showLabels && <span className="workspace-bar__btn-label">Config</span>}
          </button>
        </div>
      </div>

      {updateOpen && updateState && <UpdateModal state={updateState} onClose={() => setUpdateOpen(false)} />}

      {pickerOpen && (
        <div ref={pickerDialogRef} className="agent-picker" role="dialog" aria-modal="true" aria-labelledby="agent-picker-title">
          <div className="agent-picker__overlay" onClick={closePickerAndRestoreFocus} />
          <div
            ref={pickerPanelRef}
            className="agent-picker__panel"
            tabIndex={-1}
            aria-busy={adaptersLoading}
            onKeyDown={handlePickerKeyDown}
          >
            <h3 id="agent-picker-title" className="agent-picker__title">
              Abrir agente
            </h3>

            {adaptersLoading ? (
              <EmptyState
                className="agent-picker__empty agent-picker__empty--story"
                icon="agent"
                title="Verificando providers"
                body={<p>Consultando as CLIs disponíveis neste computador…</p>}
              />
            ) : adaptersError ? (
              <EmptyState
                className="agent-picker__empty agent-picker__empty--story"
                icon="warn"
                role="alert"
                title="Não foi possível carregar os providers"
                body={<p>{adaptersError}</p>}
                action={
                  <ActionCard
                    icon="restart"
                    title="Tentar novamente"
                    subtitle="reler catálogo local"
                    variant="primary"
                    onClick={() =>
                      setAdapterLoadAttempt((attempt) => attempt + 1)
                    }
                  />
                }
              />
            ) : installedAdapters.length === 0 ? (
              <EmptyState
                className="agent-picker__empty agent-picker__empty--story"
                icon="key"
                title={AGENT_PICKER_EMPTY.title}
                body={
                  <>
                    <EndorphinPresence kicker={AGENT_PICKER_EMPTY.kicker} mood="idle" size={44} className="endorphin-presence--row agent-picker__empty-presence" />
                    <p>{AGENT_PICKER_EMPTY.line}</p>
                    {adapters.length > 0 && (
                      <p>
                        Ex.: <code>{adapters[0].installCommand}</code>
                      </p>
                    )}
                  </>
                }
                action={
                  <ActionCard
                    icon="key"
                    title="Abrir Providers"
                    subtitle="chaves · CLIs"
                    variant="primary"
                    onClick={() => {
                      softClosePicker();
                      useSettingsStore.getState().openDrawer('providers');
                    }}
                  />
                }
              />
            ) : (
              <>
                <label className="agent-picker__label">
                  Adaptador
                  <span className="agent-picker__select-row">
                    {selectedAdapter && <ProviderLogo adapterId={selectedAdapter.id} label={selectedAdapter.label} fallback={selectedAdapter.icon} size="sm" />}
                    <select className="agent-picker__select" value={selectedAdapter?.id ?? ''} onChange={(e) => handleAdapterChange(e.target.value)}>
                      {installedAdapters.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>

                {selectedAdapter && selectedAdapter.models.list.length > 0 && (
                  <label className="agent-picker__label">
                    Modelo
                    <select className="agent-picker__select" value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>
                      {selectedAdapter.models.list.map((m) => (
                        <option key={m} value={m}>
                          {adapterModelLabel(selectedAdapter, m)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {selectedAdapter?.loginHint && <p className="agent-picker__hint">{selectedAdapter.loginHint}</p>}

                <div className="agent-picker__actions">
                  <button
                    className="agent-picker__btn"
                    onClick={() => {
                      discardClosePicker();
                      restorePickerTriggerFocus();
                    }}
                  >
                    Cancelar
                  </button>
                  <button className="agent-picker__btn agent-picker__btn--primary" onClick={confirmSpawn} disabled={!selectedAdapter}>
                    Abrir
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

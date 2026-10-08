// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: contrato modal da paleta (CommandPalette.tsx:630–640, 668–670; CommandPaletteContent.tsx:42–47) — aria-modal, foco preso pelo useFocusTrap do Nexus e devolução ao invocador no lugar de finalFocus/focusAtEnd; modos arquivo/conteúdo num diálogo só (CommandPalette.tsx:474–483, 572–580, 2015–2041) com o reducer de lib/command-palette-logic; submenu com pilha de views e Backspace no vazio voltando (CommandPalette.tsx:841–842, 1517–1531, 3133–3137); seta de submenu e linha de descrição dos resultados (CommandPaletteResults.tsx) e dicas de teclado no rodapé (CommandPaletteContent.tsx:67–96) no CSS do Nexus. Ações, layout e as buscas (files:search e SearchMixer) são do Nexus.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCommandPaletteStore } from '../state/command-palette-store';
import { getActiveWorkspacePath } from '../state/active-workspace';
import { useFocusTrap } from '../lib/use-focus-trap';
import { useAttentionInboxStore } from '../state/attention-inbox-store';
import { useCheatsheetStore } from '../state/cheatsheet-store';
import { useBugReportDialogStore } from '../state/bug-report-dialog-store';
import { useContextualPanelNavStore } from '../state/contextual-panel-nav-store';
import { useFilesStore } from '../state/files-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useSessionStateStore } from '../state/session-state-store';
import { useSettingsStore } from '../state/settings-store';
import { useMissionSetupStore } from '../state/mission-setup-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { usePaneScopeStore } from '../state/pane-scope-store';
import { LOOSE_SCOPE_KEY } from '../lib/pane-spaces';
import {
  promotePaneWithMissionChoice,
  toastPromoted,
} from '../lib/pane-mission-promote';
import { useTerminalGridDialogStore } from '../state/terminal-grid-dialog-store';
import { missionChromeTitle } from '../../shared/mission-identity';
import { listPanes } from '../lib/split-tree';
import { attentionMissionIdForPane } from '../lib/mission-attention-route';
import { filterPaletteActions } from '../lib/command-palette-filter';
import {
  overlayModeForCommand,
  paletteBackStep,
  paletteInputPlaceholder,
  workspaceRelativePath,
  type SearchOverlayMode,
} from '../lib/command-palette-logic';
import {
  commandShortcutLabel,
  compileKeybindingRules,
  effectiveBindings,
  formatBinding,
  resolveShortcutCommand,
  type KeybindingOverrides,
} from '../lib/keybindings';
import { reportLicenseDenial } from '../state/access-guard';
import { formatShortcut } from '../lib/platform';
import { SETTINGS_GROUPS } from './settings/settings-nav';
import { PixelIcon, type PixelIconName } from './PixelIcon';
import { ActionCard, EmptyState } from './ActionCard';

/**
 * ⌘K — command palette: um teclado de distância de qualquer pane, missão ou
 * ferramenta. Preenche o P1 "teclado primeiro" do critique: power users não
 * caçam botões.
 */

interface PaletteAction {
  id: string;
  group: string;
  label: string;
  icon: PixelIconName;
  hint?: string;
  keywords?: string;
  /** Segunda linha: pasta do arquivo, trecho do conteúdo. */
  detail?: string;
  /** Troca de modo/submenu: a paleta continua aberta. */
  keepOpen?: boolean;
  submenu?: boolean;
  run(): void;
}

/** Uma tela empilhada dentro da paleta (submenu). */
interface PaletteView {
  title: string;
  actions: PaletteAction[];
}

const MODE_TITLES: Record<Exclude<SearchOverlayMode, 'command'>, string> = {
  files: 'Arquivos',
  content: 'Conteúdo',
};

const MODE_LABELS: Record<SearchOverlayMode, string> = {
  command: 'Command palette',
  files: 'Ir para arquivo',
  content: 'Buscar no conteúdo dos arquivos',
};

function isTerminalBearing(): boolean {
  const destination = useProductNavigationStore.getState().destination;
  return (
    destination.kind === 'terminal' ||
    (destination.kind === 'mission' && destination.surface === 'terminals')
  );
}

/**
 * Abre um resultado de arquivo/conteúdo no editor do painel de contexto.
 * Revalida o workspace antes e DEPOIS do await: o resultado é do projeto que
 * fez a busca, e a leitura atravessa o IPC — trocar de projeto no meio não
 * pode puxar o editor do projeto novo com o arquivo do anterior.
 */
export async function openWorkspaceFile(
  relPath: string,
  workspace: string | null,
): Promise<boolean> {
  if (!workspace || getActiveWorkspacePath() !== workspace) return false;
  await useFilesStore.getState().selectFile(relPath);
  if (getActiveWorkspacePath() !== workspace) return false;
  if (!isTerminalBearing()) {
    useProductNavigationStore.getState().openTerminal();
  }
  useContextualPanelNavStore.getState().openTab('editor', { focus: true });
  return true;
}

interface ContentHit {
  id: string;
  source?: string;
  path?: string;
  snippet?: string;
  meta?: { line?: unknown };
}

async function searchWorkspace(
  mode: Exclude<SearchOverlayMode, 'command'>,
  text: string,
  workspace: string,
): Promise<{ actions: PaletteAction[]; truncated: boolean; error?: string }> {
  if (mode === 'files') {
    const result = await window.nexus.files.search(text);
    const files = result.ok ? (result.files ?? []) : [];
    return {
      truncated: result.truncated === true,
      error: result.ok ? undefined : 'Não consegui listar os arquivos deste projeto.',
      actions: files.map((relPath) => {
        const slash = relPath.lastIndexOf('/');
        return {
          id: `file:${relPath}`,
          group: 'Arquivos',
          label: relPath.slice(slash + 1),
          detail: slash > 0 ? relPath.slice(0, slash) : undefined,
          icon: 'files' as const,
          run: () => void openWorkspaceFile(relPath, workspace),
        };
      }),
    };
  }
  // Busca no conteúdo = provedor `files` (ripgrep) do SearchMixer; o main
  // fixa a raiz no workspace de quem chamou.
  const result = await window.nexus.searchMixer.search({
    text,
    sources: ['files'],
    limit: 60,
  });
  const hits = (result.hits as ContentHit[]).filter(
    (hit) => hit.source === 'files' && typeof hit.path === 'string',
  );
  return {
    truncated: false,
    error: result.error ? 'A busca no conteúdo falhou.' : undefined,
    actions: hits.map((hit) => {
      const relPath = workspaceRelativePath(hit.path!, workspace);
      const line = typeof hit.meta?.line === 'number' ? hit.meta.line : null;
      return {
        id: `content:${hit.id}`,
        group: 'Conteúdo',
        label: line ? `${relPath}:${line}` : relPath,
        detail: hit.snippet?.trim() || undefined,
        icon: 'files' as const,
        run: () => void openWorkspaceFile(relPath, workspace),
      };
    }),
  };
}

interface WorkspaceSearchState {
  busy: boolean;
  error: string | null;
  truncated: boolean;
  actions: PaletteAction[];
}

const IDLE_SEARCH: WorkspaceSearchState = {
  busy: false,
  error: null,
  truncated: false,
  actions: [],
};

/** Busca com debounce; resposta atrasada ou de outro projeto é descartada. */
function useWorkspaceSearch(
  mode: SearchOverlayMode | null,
  query: string,
): WorkspaceSearchState {
  const [state, setState] = useState<WorkspaceSearchState>(IDLE_SEARCH);
  // Resultado anterior fica na tela enquanto digita — mas só no mesmo modo.
  const resultModeRef = useRef<SearchOverlayMode | null>(null);
  useEffect(() => {
    const text = query.trim();
    if ((mode !== 'files' && mode !== 'content') || !text) {
      setState(IDLE_SEARCH);
      return;
    }
    const workspace = getActiveWorkspacePath();
    if (!workspace) {
      setState({ ...IDLE_SEARCH, error: 'Abra um projeto para buscar arquivos.' });
      return;
    }
    let cancelled = false;
    const sameMode = resultModeRef.current === mode;
    setState((previous) => ({
      ...previous,
      actions: sameMode ? previous.actions : [],
      busy: true,
      error: null,
    }));
    const timer = setTimeout(() => {
      searchWorkspace(mode, text, workspace)
        .then((result) => {
          if (cancelled) return;
          // Resposta de outro projeto: nada dela pode ser aberto aqui.
          if (getActiveWorkspacePath() !== workspace) {
            setState(IDLE_SEARCH);
            return;
          }
          resultModeRef.current = mode;
          setState({
            busy: false,
            error: result.error ?? null,
            truncated: result.truncated,
            actions: result.actions,
          });
        })
        .catch(() => {
          if (cancelled) return;
          setState({ ...IDLE_SEARCH, error: 'A busca falhou. Tente de novo.' });
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, query]);
  return state;
}

/** Dica do pane N: a combinação efetiva de focus-pane-n com o dígito dele. */
function paneHint(
  index: number,
  overrides: KeybindingOverrides,
): string | undefined {
  if (index >= 9) return undefined;
  const binding = effectiveBindings('focus-pane-n', overrides)[0];
  return binding ? formatBinding(binding, 'focus-pane-n', index + 1) : undefined;
}

/** Workspace/checkout + destino: devolver o foco só faz sentido no mesmo lugar. */
function focusScope(): string {
  return `${getActiveWorkspacePath() ?? ''}\n${JSON.stringify(
    useProductNavigationStore.getState().destination,
  )}`;
}

export function CommandPalette() {
  const open = useCommandPaletteStore((state) => state.open);
  const mode = useCommandPaletteStore((state) => state.mode);
  const close = useCommandPaletteStore((state) => state.close);
  const toggleMode = useCommandPaletteStore((state) => state.toggleMode);
  const keybindingOverrides = useSettingsStore((state) => state.ui.keybindings);
  const root = useLayoutStore((state) => state.root);
  const missionSummaries = useOrchStore(
    (state) => state.missionSummaries,
  );
  const paneStates = useSessionStateStore((state) => state.paneStates);

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [viewStack, setViewStack] = useState<PaletteView[]>([]);
  const currentView = viewStack[viewStack.length - 1] ?? null;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  /** Uma ação escolheu o próximo foco; só a dispensa devolve ao invocador. */
  const actionRanRef = useRef(false);
  /** Texto levado de um modo de busca para o outro pelo atalho do vazio. */
  const carriedQueryRef = useRef<string | null>(null);

  useFocusTrap(dialogRef, open);

  const actions = useMemo<PaletteAction[]>(() => {
    if (!open) return [];
    const layout = useLayoutStore.getState();
    const out: PaletteAction[] = [];

    listPanes(root).forEach((pane, index) => {
      const state = paneStates.get(pane.id);
      out.push({
        id: `pane:${pane.id}`,
        group: 'Panes',
        // O número entra no rótulo (e nas keywords) para o operador digitar o
        // mesmo endereço que fala: "7" acha o pane 7. O `run` continua fechando
        // sobre o pane concreto, então a busca é só filtro — nunca resolução.
        label:
          pane.paneNumber !== undefined
            ? `Focar pane ${pane.paneNumber}: ${pane.title || pane.kind}`
            : `Focar: ${pane.title || pane.kind}`,
        icon: pane.kind === 'browser' ? 'browser' : 'terminal',
        hint: paneHint(index, keybindingOverrides),
        keywords: `pane foco ${pane.paneNumber ?? ''} ${pane.adapterId ?? ''} ${state ?? ''}`,
        run: () => {
          const navigation = useProductNavigationStore.getState();
          const missionId = attentionMissionIdForPane(pane);
          if (missionId) {
            navigation.openMission(missionId);
            useProductNavigationStore.getState().showMissionTerminals();
          } else {
            navigation.openTerminal();
          }
          layout.focus(pane.id);
        },
      });
    });

    for (const mission of missionSummaries) {
      out.push({
        id: `mission:${mission.id}`,
        group: 'Missões',
        label: `Abrir missão: ${missionChromeTitle(mission.title)}`,
        icon: 'mission',
        keywords: `missao ${mission.state}`,
        run: () =>
          useProductNavigationStore.getState().openMission(mission.id),
      });
    }

    const tool = (
      id: string,
      label: string,
      icon: PixelIconName,
      run: () => void,
      hint?: string,
      keywords?: string,
      extra?: Pick<PaletteAction, 'keepOpen' | 'submenu'>,
    ) =>
      out.push({
        id: `tool:${id}`,
        group: 'Ações',
        label,
        icon,
        run,
        hint,
        keywords,
        ...extra,
      });
    const shortcut = (
      command: Parameters<typeof commandShortcutLabel>[0],
    ): string | undefined =>
      commandShortcutLabel(command, keybindingOverrides) ?? undefined;

    tool(
      'mission-new',
      'Nova missão',
      'mission',
      () => useProductNavigationStore.getState().openNewMission(),
      shortcut('mission-new'),
      'missão objetivo equipe',
    );
    // Saída do operador: o + Novo e o Launcher levam ao Caminho Expresso; o
    // wizard completo continua a um comando de distância.
    tool(
      'mission-new-advanced',
      'Missão avançada · escolher a equipe',
      'mission',
      () => {
        useMissionSetupStore
          .getState()
          .beginFreshMission(undefined, { step: 'mission' });
        useProductNavigationStore.getState().openMissionSetup();
      },
      undefined,
      'missão avançado wizard equipe etapas operador',
    );
    tool(
      'attention',
      'Lista de atenção',
      'warn',
      () => {
        close();
        useAttentionInboxStore.getState().setOpen(true);
      },
      shortcut('attention-inbox'),
      'atenção enter pr fila missão login',
    );
    const missionDestination = useProductNavigationStore.getState().destination;
    if (
      missionDestination.kind === 'mission' &&
      missionDestination.surface === 'board'
    ) {
      const missionId = missionDestination.missionId;
      tool(
        'mission-terminals',
        'Terminais da missão',
        'terminal',
        () => {
          useProductNavigationStore.getState().openMission(missionId);
          useProductNavigationStore.getState().showMissionTerminals();
        },
        '',
        'pane grid missão claude',
      );
    }
    tool(
      'terminal',
      'Abrir terminal',
      'terminal',
      () => {
        useProductNavigationStore.getState().openTerminal();
        // F-228: addShellPane recusado lança LicenseError, não devolve ''.
        try {
          layout.addShellPane();
        } catch (error) {
          if (!reportLicenseDenial(error)) throw error;
          return;
        }
        // F-560: sem focar a aba dos soltos, o terminal nasce fora do escopo
        // que está na tela e o operador vê a grade anterior — "abri e não
        // apareceu". Mesma regra do atalho equivalente no Novo pedido.
        usePaneScopeStore.getState().focusScope(LOOSE_SCOPE_KEY);
      },
      '',
      'shell novo',
    );
    tool(
      'terminal-grid',
      'Iniciar grid de terminais (escolher quantidade)…',
      'terminal',
      () => {
        useTerminalGridDialogStore.getState().open({ initialCount: 2 });
      },
      '',
      'grid terminais mosaico quantidade split layout',
    );
    tool(
      'promote-orchestrator',
      'Tornar painel focado o orquestrador',
      'crown',
      () => {
        const root = useLayoutStore.getState().root;
        const focusedId = useLayoutStore.getState().focusedPaneId;
        const p = listPanes(root).find((item) => item.id === focusedId) ?? listPanes(root)[0];
        if (p) {
          // F-527: vínculo explícito de missão — sem anexar à "padrão".
          void promotePaneWithMissionChoice({ paneId: p.id }).then((missionId) => {
            if (!missionId) return;
            const title = useOrchStore
              .getState()
              .missions.find((m) => m.id === missionId)?.title;
            toastPromoted(title);
          });
        }
      },
      '',
      'orquestrador líder coordenador promover promote orchestrator',
    );
    tool(
      'browser',
      'Abrir navegador',
      'browser',
      () => {
        useProductNavigationStore.getState().openTerminal();
        try {
          layout.addBrowserPane();
        } catch (error) {
          if (!reportLicenseDenial(error)) throw error;
        }
      },
      '',
      'web browser',
    );
    tool(
      'skills',
      'Skills do projeto',
      'agent',
      () => useProductNavigationStore.getState().openSettings('skills'),
      '',
      'skill catálogo contexto',
    );
    tool(
      'marketplace',
      'Marketplace de agentes e skills',
      'star',
      () =>
        useProductNavigationStore
          .getState()
          .openSettings('marketplace'),
      '',
      'marketplace instalar agent skill catálogo',
    );
    tool(
      'memory',
      'Memória do projeto',
      'files',
      () => useProductNavigationStore.getState().openMemory(),
      '',
      'memory memória decisões contexto',
    );
    tool(
      'mcps',
      'MCPs e ferramentas',
      'browser',
      () => useProductNavigationStore.getState().openSettings('mcps'),
      '',
      'mcp servidores ferramentas contexto',
    );
    tool(
      'board',
      'Quadro de tarefas',
      'board',
      () => useProductNavigationStore.getState().openTaskBoard(),
      shortcut('task-board'),
      'quadro tarefas pipeline kanban',
    );
    tool(
      'squads',
      'Equipes e squads',
      'orch',
      () => useProductNavigationStore.getState().openSettings('squads'),
      '',
      'squad equipe agentes',
    );
    tool(
      'settings',
      'Configurações',
      'config',
      () => useProductNavigationStore.getState().openSettings(),
      shortcut('settings'),
      'settings preferências',
    );
    tool(
      'cheatsheet',
      'Ajuda e atalhos do teclado',
      'key',
      () => useCheatsheetStore.getState().toggle(),
      shortcut('cheatsheet'),
      'ajuda help teclas shortcuts atalhos comandos dúvida como',
    );
    tool(
      'file-picker',
      'Ir para arquivo…',
      'files',
      () => toggleMode('files'),
      shortcut('file-picker'),
      'arquivo abrir ir para file picker quick open',
      { keepOpen: true },
    );
    tool(
      'content-search',
      'Buscar texto nos arquivos…',
      'search',
      () => toggleMode('content'),
      shortcut('content-search'),
      'buscar procurar texto conteúdo grep find in files',
      { keepOpen: true },
    );
    tool(
      'settings-sections',
      'Ir para uma seção das configurações…',
      'config',
      () =>
        setViewStack((views) => [
          ...views,
          {
            title: 'Configurações',
            actions: SETTINGS_GROUPS.flatMap((group) =>
              group.items.map((item) => ({
                id: `settings:${item.id}`,
                group: group.label,
                label: item.title,
                icon: item.pixelIcon ?? 'config',
                keywords: `${item.subtitle} ${(item.aliases ?? []).join(' ')}`,
                run: () =>
                  useProductNavigationStore.getState().openSettings(item.id),
              })),
            ),
          },
        ]),
      undefined,
      'seção configurações preferências atalhos conta terminal',
      { keepOpen: true, submenu: true },
    );
    tool(
      'bug-report',
      'Reportar um problema…',
      'warn',
      // `runAction` já fecha a paleta; o store ainda fecha o que mais estiver aberto.
      () => useBugReportDialogStore.getState().open(),
      undefined,
      'bug erro problema reportar relatar feedback defeito falha suporte ajuda',
    );

    return out;
  }, [open, root, missionSummaries, paneStates, keybindingOverrides, toggleMode]);

  const search = useWorkspaceSearch(open ? mode : null, query);
  const filtered = useMemo(
    () =>
      mode === 'command'
        ? filterPaletteActions(currentView?.actions ?? actions, query)
        : search.actions,
    [actions, currentView, mode, query, search.actions],
  );

  // Reset ao abrir; cursor sempre dentro dos limites do filtro corrente.
  useEffect(() => {
    if (!open) return;
    // O foco ainda está com quem abriu: o input só o recebe no quadro seguinte.
    const invoker =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : null;
    const scope = focusScope();
    actionRanRef.current = false;
    setQuery('');
    setCursor(0);
    setViewStack([]);
    // O input só existe após o paint deste render.
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      // Fechar antes do quadro não pode puxar o foco para um input morto.
      cancelAnimationFrame(frame);
      if (
        actionRanRef.current ||
        !invoker?.isConnected ||
        focusScope() !== scope
      ) {
        return;
      }
      invoker.focus({ preventScroll: true });
    };
  }, [open]);

  // Trocar de modo (Mod+K/P/Shift+F ou Backspace) recomeça a busca no mesmo
  // input — o diálogo não remonta, então o foco fica onde está.
  useEffect(() => {
    setQuery(carriedQueryRef.current ?? '');
    carriedQueryRef.current = null;
    setCursor(0);
    setViewStack([]);
  }, [mode]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  const runAction = (action: PaletteAction) => {
    if (action.keepOpen) {
      action.run();
      setQuery('');
      setCursor(0);
      inputRef.current?.focus();
      return;
    }
    actionRanRef.current = true;
    close();
    action.run();
  };
  const runNavigation = (run: () => void) =>
    runAction({ id: 'nav', group: '', label: '', icon: 'mission', run });

  const back = paletteBackStep({ query, mode, viewDepth: viewStack.length });
  const goBack = (step: ReturnType<typeof paletteBackStep>) => {
    if (step === 'pop-view') {
      setViewStack((views) => views.slice(0, -1));
      setCursor(0);
    } else if (step === 'command-mode') {
      toggleMode('command');
    }
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // IME compondo: Enter/Backspace/setas pertencem à composição.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Mod+K/P/Shift+F aqui dentro trocam de modo; o mesmo atalho fecha.
    const nextMode = overlayModeForCommand(
      resolveShortcutCommand(
        e.nativeEvent,
        compileKeybindingRules(keybindingOverrides),
        // O diálogo modal tem o teclado: nenhum terminal é alvo de atalho
        // aqui, então Mod+Shift+F é a busca no conteúdo, nunca o palco.
        {
          hasWorkspace: true,
          paneFocused: false,
          terminalInUse: false,
          terminalFocus: false,
          editableFocus: true,
        },
      )?.command ?? null,
    );
    if (nextMode) {
      e.preventDefault();
      toggleMode(nextMode);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Backspace' && back) {
      e.preventDefault();
      goBack(back);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const action = filtered[cursor];
      if (action) runAction(action);
    }
  };

  let lastGroup: string | null = null;
  const crumb =
    currentView?.title ?? (mode === 'command' ? null : MODE_TITLES[mode]);
  const searchMode = mode !== 'command';
  const trimmed = query.trim();
  const fileShortcut = commandShortcutLabel('file-picker', keybindingOverrides);
  const contentShortcut = commandShortcutLabel(
    'content-search',
    keybindingOverrides,
  );

  return (
    <div
      ref={dialogRef}
      className="palette"
      role="dialog"
      aria-modal="true"
      aria-label={MODE_LABELS[mode]}
      data-palette-mode={mode}
    >
      <div
        className="palette__overlay overlay-scrim-glass overlay-scrim-enter"
        onClick={close}
      />
      <div className="palette__panel" onKeyDown={onKeyDown}>
        <div className="palette__head">
          {crumb ? (
            <button
              type="button"
              className="palette__back"
              aria-label={`Voltar de ${crumb}`}
              onClick={() =>
                goBack(viewStack.length > 0 ? 'pop-view' : 'command-mode')
              }
            >
              <PixelIcon name="arrow-left" size={10} />
              {crumb}
            </button>
          ) : (
            <PixelIcon name="search" size={14} />
          )}
          <input
            ref={inputRef}
            className="palette__input"
            type="text"
            value={query}
            placeholder={paletteInputPlaceholder(mode, viewStack.length > 0)}
            aria-label={searchMode ? MODE_LABELS[mode] : 'Buscar comando'}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
          />
          <kbd className="palette__esc">esc</kbd>
        </div>
        <ul className="palette__list" ref={listRef} role="listbox">
          {searchMode && (!trimmed || search.busy || search.error) && (
            <li className="palette__status" role="status">
              {search.error ??
                (search.busy
                  ? 'Buscando…'
                  : mode === 'files'
                    ? 'Digite parte do nome ou do caminho do arquivo.'
                    : 'Digite o texto que você procura nos arquivos.')}
            </li>
          )}
          {searchMode &&
            trimmed &&
            !search.busy &&
            !search.error &&
            filtered.length === 0 && (
              <li className="palette__empty">
                <EmptyState
                  className="palette__empty-state"
                  icon="search"
                  title={
                    mode === 'files'
                      ? 'Nenhum arquivo com esse nome'
                      : 'Nenhum arquivo contém esse texto'
                  }
                  body={
                    <p>
                      {mode === 'files'
                        ? 'O texto pode estar dentro de um arquivo.'
                        : 'Talvez seja o nome de um arquivo.'}
                    </p>
                  }
                  action={
                    <ActionCard
                      icon={mode === 'files' ? 'search' : 'files'}
                      title={
                        mode === 'files'
                          ? 'Buscar no conteúdo'
                          : 'Procurar pelo nome'
                      }
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        // O texto atravessa a troca de modo.
                        carriedQueryRef.current = query;
                        toggleMode(mode === 'files' ? 'content' : 'files');
                        inputRef.current?.focus();
                      }}
                    />
                  }
                />
              </li>
            )}
          {!searchMode && filtered.length === 0 && (
            <li className="palette__empty">
              <EmptyState
                className="palette__empty-state"
                icon="search"
                title="Nada com esse nome"
                body={<p>Tente uma ação rápida:</p>}
                action={
                  <>
                    <ActionCard
                      icon="mission"
                      title="Nova missão"
                      variant="primary"
                      size="sm"
                      onClick={() =>
                        runNavigation(() =>
                          useProductNavigationStore
                            .getState()
                            .openNewMission(),
                        )
                      }
                    />
                    <ActionCard
                      icon="key"
                      title="Contas de IA"
                      size="sm"
                      onClick={() =>
                        runNavigation(() =>
                          useProductNavigationStore
                            .getState()
                            .openSettings('providers'),
                        )
                      }
                    />
                    <ActionCard
                      icon="key"
                      title="Ajuda e atalhos"
                      size="sm"
                      onClick={() =>
                        runNavigation(() =>
                          useCheatsheetStore.getState().toggle(),
                        )
                      }
                    />
                  </>
                }
              />
            </li>
          )}
          {filtered.map((action, index) => {
            const showGroup = action.group !== lastGroup;
            lastGroup = action.group;
            return (
              <li key={action.id}>
                {showGroup && (
                  <div className="palette__group" aria-hidden="true">
                    {action.group}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === cursor}
                  data-active={index === cursor}
                  className="palette__item"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => runAction(action)}
                >
                  <PixelIcon name={action.icon} size={12} />
                  <span className="palette__item-text">
                    <span className="palette__item-label">{action.label}</span>
                    {action.detail && (
                      <span className="palette__item-detail">
                        {action.detail}
                      </span>
                    )}
                  </span>
                  {action.hint && (
                    <kbd className="palette__item-hint">{action.hint}</kbd>
                  )}
                  {action.submenu && (
                    <PixelIcon name="arrow-right" size={10} />
                  )}
                </button>
              </li>
            );
          })}
          {searchMode && search.truncated && filtered.length > 0 && (
            <li className="palette__status">
              Mostrando os primeiros resultados — refine a busca.
            </li>
          )}
        </ul>
        <div className="palette__foot" aria-hidden="true">
          <span>
            <kbd>↑↓</kbd> navegar
          </span>
          <span>
            <kbd>{formatShortcut('enter')}</kbd> abrir
          </span>
          {back && (
            <span>
              <kbd>{formatShortcut('backspace')}</kbd> voltar
            </span>
          )}
          {mode !== 'files' && fileShortcut && (
            <span>
              <kbd>{fileShortcut}</kbd> arquivos
            </span>
          )}
          {mode !== 'content' && contentShortcut && (
            <span>
              <kbd>{contentShortcut}</kbd> conteúdo
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

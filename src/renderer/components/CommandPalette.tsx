import { useEffect, useMemo, useRef, useState } from 'react';
import { useCommandPaletteStore } from '../state/command-palette-store';
import { useAttentionInboxStore } from '../state/attention-inbox-store';
import { useCheatsheetStore } from '../state/cheatsheet-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useSessionStateStore } from '../state/session-state-store';
import { useMissionSetupStore } from '../state/mission-setup-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { listPanes } from '../lib/split-tree';
import { filterPaletteActions } from '../lib/command-palette-filter';
import { formatShortcut } from '../lib/platform';
import { shortcutKeys } from '../lib/shortcuts';
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
  run(): void;
}

export function CommandPalette() {
  const open = useCommandPaletteStore((state) => state.open);
  const close = useCommandPaletteStore((state) => state.close);
  const root = useLayoutStore((state) => state.root);
  const viewKind = useLayoutStore((state) => state.viewKind);
  const missionSummaries = useOrchStore(
    (state) => state.missionSummaries,
  );
  const paneStates = useSessionStateStore((state) => state.paneStates);

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

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
        hint:
          index < 9
            ? formatShortcut('mod', String(index + 1))
            : undefined,
        keywords: `pane foco ${pane.paneNumber ?? ''} ${pane.adapterId ?? ''} ${state ?? ''}`,
        run: () => {
          const navigation = useProductNavigationStore.getState();
          if (pane.missionId) {
            navigation.openMission(pane.missionId);
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
        label: `Abrir missão: ${mission.title}`,
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
    ) =>
      out.push({
        id: `tool:${id}`,
        group: 'Ações',
        label,
        icon,
        run,
        hint,
        keywords,
      });

    tool(
      'mission-new',
      'Nova missão',
      'mission',
      () => useProductNavigationStore.getState().openNewMission(),
      shortcutKeys('mission-new'),
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
      shortcutKeys('attention-inbox'),
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
        layout.addShellPane();
      },
      '',
      'shell novo',
    );
    tool(
      'browser',
      'Abrir navegador',
      'browser',
      () => {
        useProductNavigationStore.getState().openTerminal();
        layout.addBrowserPane();
      },
      '',
      'web browser',
    );
    tool(
      'view',
      viewKind === 'canvas' ? 'Mudar para grade' : 'Mudar para canvas',
      viewKind === 'canvas' ? 'grid' : 'canvas',
      () => {
        useProductNavigationStore.getState().openTerminal();
        layout.toggleView();
      },
      '',
      'layout visão',
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
      shortcutKeys('task-board'),
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
      shortcutKeys('settings'),
      'settings preferências',
    );
    tool(
      'cheatsheet',
      'Ajuda e atalhos do teclado',
      'key',
      () => useCheatsheetStore.getState().toggle(),
      shortcutKeys('cheatsheet'),
      'ajuda help teclas shortcuts atalhos comandos dúvida como',
    );

    return out;
  }, [open, root, missionSummaries, paneStates, viewKind]);

  const filtered = useMemo(
    () => filterPaletteActions(actions, query),
    [actions, query],
  );

  // Reset ao abrir; cursor sempre dentro dos limites do filtro corrente.
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      // O input só existe após o paint deste render.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

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
    close();
    action.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
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

  return (
    <div className="palette" role="dialog" aria-label="Command palette">
      <div className="palette__overlay" onClick={close} />
      <div className="palette__panel" onKeyDown={onKeyDown}>
        <div className="palette__head">
          <PixelIcon name="search" size={14} />
          <input
            ref={inputRef}
            className="palette__input"
            type="text"
            value={query}
            placeholder="Pane, missão ou ação…"
            aria-label="Buscar comando"
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="palette__esc">esc</kbd>
        </div>
        <ul className="palette__list" ref={listRef} role="listbox">
          {filtered.length === 0 && (
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
                      onClick={() => {
                        close();
                        useProductNavigationStore
                          .getState()
                          .openNewMission();
                      }}
                    />
                    <ActionCard
                      icon="key"
                      title="Providers"
                      size="sm"
                      onClick={() => {
                        close();
                        useProductNavigationStore
                          .getState()
                          .openSettings('providers');
                      }}
                    />
                    <ActionCard
                      icon="key"
                      title="Ajuda e atalhos"
                      size="sm"
                      onClick={() => {
                        close();
                        useCheatsheetStore.getState().toggle();
                      }}
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
                  <span className="palette__item-label">{action.label}</span>
                  {action.hint && (
                    <kbd className="palette__item-hint">{action.hint}</kbd>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

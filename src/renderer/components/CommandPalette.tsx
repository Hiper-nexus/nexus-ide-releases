import { useEffect, useMemo, useRef, useState } from 'react';
import { useCommandPaletteStore } from '../state/command-palette-store';
import { useCheatsheetStore } from '../state/cheatsheet-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useSessionStateStore } from '../state/session-state-store';
import { useSettingsStore } from '../state/settings-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useFilesStore } from '../state/files-store';
import { useHomeStore } from '../state/home-store';
import { listPanes } from '../lib/split-tree';
import { filterPaletteActions } from '../lib/command-palette-filter';
import { confirmAndReopenMission } from '../orch/confirm-reopen-mission';
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
  const open = useCommandPaletteStore((s) => s.open);
  const close = useCommandPaletteStore((s) => s.close);
  const root = useLayoutStore((s) => s.root);
  const viewKind = useLayoutStore((s) => s.viewKind);
  const missions = useOrchStore((s) => s.missions);
  const paneStates = useSessionStateStore((s) => s.paneStates);

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
        label: `Focar: ${pane.title || pane.kind}`,
        icon: pane.kind === 'browser' ? 'browser' : 'terminal',
        hint: index < 9 ? `⌘${index + 1}` : undefined,
        keywords: `pane foco ${pane.adapterId ?? ''} ${state ?? ''}`,
        run: () => layout.focus(pane.id),
      });
    });

    for (const mission of missions) {
      if (mission.status === 'done' || mission.status === 'failed') continue;
      out.push({
        id: `mission:${mission.id}`,
        group: 'Missões',
        label: `Retomar missão: ${mission.title}`,
        icon: 'mission',
        keywords: `missao ${mission.status}`,
        run: () => void confirmAndReopenMission(mission),
      });
    }

    const tool = (
      id: string,
      label: string,
      icon: PixelIconName,
      run: () => void,
      hint?: string,
      keywords?: string,
    ) => out.push({ id: `tool:${id}`, group: 'Ações', label, icon, run, hint, keywords });

    tool(
      'mission-new',
      'Nova missão',
      'mission',
      () => useMissionWizardStore.getState().openForMission(),
      '⌘N',
      'wizard squad',
    );
    tool('terminal', 'Abrir terminal', 'terminal', () => layout.addShellPane(), '', 'shell novo');
    tool('browser', 'Abrir navegador', 'browser', () => layout.addBrowserPane(), '', 'web browser');
    tool(
      'view',
      viewKind === 'canvas' ? 'Mudar para grade' : 'Mudar para canvas',
      viewKind === 'canvas' ? 'grid' : 'canvas',
      () => layout.toggleView(),
      '',
      'layout visao',
    );
    tool(
      'files',
      'Arquivos do workspace',
      'files',
      () => useFilesStore.getState().togglePanel(),
      '',
      'file tree',
    );
    tool(
      'board',
      'Painel de operações',
      'board',
      () => useOrchStore.getState().toggleBoard(),
      '⌘B',
      'ops pipeline kanban',
    );
    tool(
      'orch',
      'Equipe (missões e handoffs)',
      'orch',
      () => useOrchStore.getState().togglePanel(),
      '',
      'squad orquestracao',
    );
    tool(
      'home',
      'Painel inicial',
      'sparkle',
      () => useHomeStore.getState().show(),
      '',
      'home deck inicio',
    );
    tool(
      'settings',
      'Configurações',
      'config',
      () => useSettingsStore.getState().openDrawer(),
      '⌘,',
      'settings preferencias',
    );
    tool(
      'cheatsheet',
      'Atalhos do teclado',
      'key',
      () => useCheatsheetStore.getState().toggle(),
      '⌘/',
      'ajuda help teclas shortcuts',
    );

    return out;
  }, [open, root, missions, paneStates, viewKind]);

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
                        useMissionWizardStore.getState().openForMission();
                      }}
                    />
                    <ActionCard
                      icon="key"
                      title="Providers"
                      size="sm"
                      onClick={() => {
                        close();
                        useSettingsStore.getState().openDrawer('providers');
                      }}
                    />
                    <ActionCard
                      icon="star"
                      title="Ranking LLMs"
                      size="sm"
                      onClick={() => {
                        close();
                        useSettingsStore.getState().openDrawer('ranking');
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

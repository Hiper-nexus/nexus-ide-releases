import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountInfo } from '../../shared/account-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { filterPaletteActions } from '../lib/command-palette-filter';
import { useAccountStore } from '../state/account-store';
import { useLayoutStore } from '../state/layout-store';
import { useProviderStore } from '../state/provider-store';
import { PixelIcon, type PixelIconName } from './PixelIcon';
import { ProviderLogo } from './ProviderLogo';

/**
 * "+ Pane" — abrir um pane NOVO no meio do trabalho já escolhendo O QUE ele é:
 * terminal do sistema, browser embutido, ou uma CLI numa CONTA × MODELO exatos.
 *
 * O catálogo NUNCA é escrito aqui: as CLIs vêm do hub de providers
 * (`useProviderStore`, que já funde modelos customizados) e as contas do
 * registro multi-conta (`useAccountStore`). Adapter sem modelo declarado é
 * legítimo — vira uma linha "padrão da ferramenta" que sobe sem `--model`.
 */

/** O que a linha escolhida abre. */
export type PanePickerIntent =
  | { readonly kind: 'terminal' }
  | { readonly kind: 'browser' }
  | {
      readonly kind: 'agent';
      readonly adapterId: string;
      /** Vazio = subir a CLI no padrão dela (adapter sem catálogo). */
      readonly model: string;
      readonly accountId?: string;
    };

/** Banda de topo do menu — espelha o agrupamento do concorrente. */
export type PanePickerSection = 'tipo' | 'clis';

export interface PanePickerEntry {
  readonly id: string;
  readonly section: PanePickerSection;
  /** Cabeçalho do grupo (label da CLI). Vazio na seção TIPO. */
  readonly group: string;
  /** Adapter do grupo — só para o logo do cabeçalho. */
  readonly adapterId?: string;
  /** Linha principal: conta, ou o nome do tipo. */
  readonly label: string;
  /** Complemento à direita: modelo, ou a natureza do tipo. */
  readonly detail: string;
  readonly icon: PixelIconName;
  readonly keywords: string;
  readonly intent: PanePickerIntent;
}

const SECTION_LABEL: Record<PanePickerSection, string> = {
  tipo: 'Tipo',
  clis: 'Cloud · CLIs',
};

/** Conta sem apelido pinado — a CLI usa a credencial ativa dela. */
const DEFAULT_ACCOUNT_LABEL = 'padrão';
/** Adapter sem catálogo de modelos — sobe sem flag de modelo. */
const DEFAULT_MODEL_LABEL = 'padrão da ferramenta';

/**
 * Modelo default primeiro, depois o resto do catálogo, sem repetição. Um
 * adapter pode legitimamente não declarar nenhum modelo: nesse caso a lista
 * fica com uma única entrada vazia, que vira a linha "padrão da ferramenta".
 */
function modelsOf(provider: ProviderSettingsInfo): string[] {
  const ordered = [provider.defaultModel, ...provider.models]
    .map((model) => model?.trim() ?? '')
    .filter((model) => model.length > 0);
  const unique = [...new Set(ordered)];
  return unique.length > 0 ? unique : [''];
}

/**
 * Monta o catálogo do menu a partir das duas fontes de verdade. Puro de
 * propósito: é o que os testes exercitam sem montar React.
 */
export function buildPanePickerEntries(
  providers: readonly ProviderSettingsInfo[],
  accounts: readonly AccountInfo[],
): PanePickerEntry[] {
  const entries: PanePickerEntry[] = [
    {
      id: 'type:terminal',
      section: 'tipo',
      group: '',
      label: 'Terminal',
      detail: 'shell do sistema',
      icon: 'terminal',
      keywords: 'terminal shell sistema console',
      intent: { kind: 'terminal' },
    },
    {
      id: 'type:browser',
      section: 'tipo',
      group: '',
      label: 'Browser',
      detail: 'navegador embutido',
      icon: 'browser',
      keywords: 'browser navegador web site',
      intent: { kind: 'browser' },
    },
  ];

  const installed = providers
    .filter(
      (provider) =>
        provider.kind === 'cli-pty' &&
        provider.installed &&
        // Provider desligado à mão em Configurações não volta pela porta dos
        // fundos: o operador já disse que não quer essa CLI.
        provider.enabled !== false,
    )
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));

  for (const provider of installed) {
    const mine = accounts.filter(
      (account) => account.adapterId === provider.adapterId,
    );
    for (const model of modelsOf(provider)) {
      const modelLabel = model || DEFAULT_MODEL_LABEL;
      const push = (account?: AccountInfo) =>
        entries.push({
          id: `agent:${provider.adapterId}:${account?.id ?? 'default'}:${model || 'default'}`,
          section: 'clis',
          group: provider.label,
          adapterId: provider.adapterId,
          label: account?.label ?? DEFAULT_ACCOUNT_LABEL,
          detail: modelLabel,
          icon: 'plus',
          keywords: [
            provider.label,
            provider.adapterId,
            account?.label ?? DEFAULT_ACCOUNT_LABEL,
            account?.email ?? '',
            modelLabel,
          ].join(' '),
          intent: {
            kind: 'agent',
            adapterId: provider.adapterId,
            model,
            ...(account ? { accountId: account.id } : {}),
          },
        });
      if (mine.length === 0) push();
      else for (const account of mine) push(account);
    }
  }

  return entries;
}

/** Abre o pane pela ação que JÁ existe na store — o picker não cria panes. */
export function runPanePickerIntent(intent: PanePickerIntent): void {
  const layout = useLayoutStore.getState();
  if (intent.kind === 'terminal') {
    layout.addShellPane();
    return;
  }
  if (intent.kind === 'browser') {
    layout.addBrowserPane();
    return;
  }
  if (intent.accountId) {
    layout.spawnAgent(intent.adapterId, intent.model, {
      accountId: intent.accountId,
    });
    return;
  }
  layout.spawnAgent(intent.adapterId, intent.model);
}

export function PanePicker() {
  const providers = useProviderStore((state) => state.providers);
  const accounts = useAccountStore((state) => state.accounts);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo(
    () => buildPanePickerEntries(providers, accounts),
    [providers, accounts],
  );
  const filtered = useMemo(
    () => filterPaletteActions(entries, query),
    [entries, query],
  );
  const hasCli = useMemo(
    () => entries.some((entry) => entry.section === 'clis'),
    [entries],
  );

  /** Fecha devolvendo o foco ao gatilho — teclado nunca fica órfão. */
  const closeToTrigger = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Estado limpo a cada abertura; o foco entra na busca (18 CLIs não se
  // navegam com scroll).
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      // Clique fora é saída deliberada: fecha SEM roubar o foco de volta.
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeToTrigger();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, closeToTrigger]);

  // O cursor nunca aponta para fora do filtro corrente.
  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const runEntry = (entry: PanePickerEntry) => {
    setOpen(false);
    runPanePickerIntent(entry.intent);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((current) => Math.min(current + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setCursor(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setCursor(Math.max(0, filtered.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = filtered[cursor];
      if (entry) runEntry(entry);
    }
  };

  let lastSection: PanePickerSection | null = null;
  let lastGroup: string | null = null;

  return (
    <div className="pane-picker" ref={rootRef}>
      {open && (
        <div
          className="pane-picker__panel"
          role="dialog"
          aria-label="Abrir novo pane"
          onKeyDown={onKeyDown}
        >
          <div className="pane-picker__head">
            <PixelIcon name="search" size={12} />
            <input
              ref={inputRef}
              className="pane-picker__input"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="pane-picker-list"
              aria-autocomplete="list"
              aria-activedescendant={
                filtered[cursor] ? `pane-picker-opt-${cursor}` : undefined
              }
              aria-label="Filtrar por CLI, conta ou modelo"
              data-testid="pane-picker-filter"
              placeholder="CLI, conta ou modelo…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCursor(0);
              }}
            />
            <kbd className="pane-picker__esc">esc</kbd>
          </div>

          <ul
            className="pane-picker__list"
            id="pane-picker-list"
            role="listbox"
            aria-label="Tipos de pane"
            ref={listRef}
          >
            {filtered.length === 0 && (
              <li className="pane-picker__empty" role="presentation">
                Nada com esse nome.
              </li>
            )}
            {filtered.map((entry, index) => {
              const showSection = entry.section !== lastSection;
              const showGroup = entry.group !== '' && entry.group !== lastGroup;
              lastSection = entry.section;
              lastGroup = entry.group;
              return (
                <li key={entry.id} role="presentation">
                  {showSection && (
                    <div className="pane-picker__section" aria-hidden="true">
                      {SECTION_LABEL[entry.section]}
                    </div>
                  )}
                  {showGroup && (
                    <div className="pane-picker__group" aria-hidden="true">
                      {entry.adapterId && (
                        <ProviderLogo
                          adapterId={entry.adapterId}
                          label={entry.group}
                          size="xs"
                        />
                      )}
                      <span className="pane-picker__group-name">
                        {entry.group}
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    id={`pane-picker-opt-${index}`}
                    aria-selected={index === cursor}
                    data-active={index === cursor}
                    data-testid={`pane-picker-entry-${entry.id}`}
                    className="pane-picker__item"
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => runEntry(entry)}
                  >
                    <PixelIcon name={entry.icon} size={12} />
                    <span className="pane-picker__item-label">
                      {entry.label}
                    </span>
                    <span className="pane-picker__item-detail">
                      <span aria-hidden="true">›</span>
                      {entry.detail}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {!hasCli && (
            <p className="pane-picker__hint">
              Nenhuma CLI detectada — instale uma em Configurações › Providers.
            </p>
          )}
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        className="pane-picker__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="pane-picker-trigger"
        title="Abrir um pane novo: terminal, browser ou uma CLI numa conta e modelo exatos"
        onClick={() => setOpen((current) => !current)}
      >
        <PixelIcon name="plus" size={12} />
        <span>Pane</span>
      </button>
    </div>
  );
}

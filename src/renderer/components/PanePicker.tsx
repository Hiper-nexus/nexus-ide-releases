import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountInfo } from '../../shared/account-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { filterPaletteActions } from '../lib/command-palette-filter';
import { listPanes } from '../lib/split-tree';
import { planOperatorAgentSpawn } from '../orch/stranded-mission-handoff';
import { useAccountStore } from '../state/account-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { usePanePickerStore } from '../state/pane-picker-store';
import { useProviderStore } from '../state/provider-store';
import { useSessionStateStore } from '../state/session-state-store';
import { PixelIcon, type PixelIconName } from './PixelIcon';
import { ProviderLogo } from './ProviderLogo';
import { AccountsManager } from './settings/AccountsManager';

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
          // Conta morta continua escolhível (o prepare veta com motivo), mas
          // nunca com o nome limpo — o sufixo honesto evita o 401 surpresa.
          label:
            account?.needsRelogin && account.label
              ? `${account.label} (sessão expirada)`
              : (account?.label ?? DEFAULT_ACCOUNT_LABEL),
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

/** Por que uma CLI conhecida ficou de fora da lista. */
export interface PanePickerUnavailable {
  readonly adapterId: string;
  readonly label: string;
  readonly reason: string;
}

/**
 * O filtro da lista principal é deliberado (provider desligado à mão não
 * volta pela porta dos fundos), mas filtrar EM SILÊNCIO lê como bug: "o
 * picker não mostra todas as minhas CLIs". Esta lista é a resposta visível —
 * cada exclusão nomeada com o motivo e a ação cabível (Contas / instalação).
 */
export function buildPanePickerUnavailable(
  providers: readonly ProviderSettingsInfo[],
): PanePickerUnavailable[] {
  return providers
    .filter(
      (provider) =>
        provider.kind === 'cli-pty' &&
        (!provider.installed || provider.enabled === false),
    )
    .map((provider) => ({
      adapterId: provider.adapterId,
      label: provider.label,
      reason:
        provider.enabled === false
          ? 'desligada em Configurações › Contas'
          : 'CLI não encontrada no PATH',
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

/**
 * Linha administrativa do menu: "Adicionar conta" numa CLI.
 *
 * Vive AQUI, e deliberadamente FORA de `buildPanePickerEntries`, porque aquele
 * catálogo é compartilhado com a configuração da grade de terminais — lá cada
 * linha é um terminal a escolher, e cadastrar conta não é escolher terminal.
 */
export interface PanePickerAccountAction {
  readonly id: string;
  readonly section: 'clis';
  readonly group: string;
  readonly adapterId: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: PixelIconName;
  readonly keywords: string;
  readonly manageAccounts: true;
}

export type PanePickerRow = PanePickerEntry | PanePickerAccountAction;

export function isAccountAction(
  row: PanePickerRow,
): row is PanePickerAccountAction {
  return 'manageAccounts' in row;
}

function savedAccountsLabel(count: number): string {
  if (count === 0) return 'nenhuma conta salva';
  return count === 1 ? '1 conta salva' : `${count} contas salvas`;
}

/**
 * Fecha cada grupo de CLI com a ação de cadastro daquela ferramenta. Fica no
 * fim do grupo para nunca disputar a primeira posição com o que o operador
 * veio abrir; e entra na lista filtrada como qualquer outra linha, então a
 * busca ("conta", "codex", "login") e as setas a alcançam do mesmo jeito.
 */
export function withAccountActions(
  entries: readonly PanePickerEntry[],
  accounts: readonly AccountInfo[],
): PanePickerRow[] {
  const rows: PanePickerRow[] = [];
  entries.forEach((entry, index) => {
    rows.push(entry);
    if (entry.section !== 'clis' || !entry.adapterId) return;
    if (entries[index + 1]?.adapterId === entry.adapterId) return;
    const adapterId = entry.adapterId;
    const saved = accounts.filter(
      (account) => account.adapterId === adapterId,
    ).length;
    rows.push({
      id: `accounts:${adapterId}`,
      section: 'clis',
      group: entry.group,
      adapterId,
      label: 'Adicionar conta',
      detail: savedAccountsLabel(saved),
      icon: 'users',
      keywords: [
        'adicionar conta',
        'nova conta',
        'entrar',
        'login',
        'trocar de conta',
        entry.group,
        adapterId,
      ].join(' '),
      manageAccounts: true,
    });
  });
  return rows;
}

function recentExcerpt(paneId: string): string {
  const excerpt = (
    window as Window & {
      __nexusGetScrollbackExcerpt?: (id: string, max?: number) => string;
    }
  ).__nexusGetScrollbackExcerpt;
  return excerpt?.(paneId) ?? '';
}

function accountLabelOf(accountId: string | undefined, fallback: string): string {
  if (!accountId) return fallback;
  return (
    useAccountStore.getState().accounts.find((account) => account.id === accountId)
      ?.label ?? fallback
  );
}

function paneStateRecord(): Record<string, string | undefined> {
  const record: Record<string, string | undefined> = {};
  for (const [paneId, state] of useSessionStateStore.getState().paneStates) {
    record[paneId] = state;
  }
  return record;
}

/**
 * Abre o pane pela ação que JÁ existe na store — o picker não cria panes.
 * Devolve o id do pane criado (undefined quando a store recusou), para que
 * vistas filtradas (ex.: Terminais da missão) possam mostrar o pane novo em
 * vez de criá-lo invisível.
 */
export function runPanePickerIntent(intent: PanePickerIntent): string | undefined {
  const layout = useLayoutStore.getState();
  if (intent.kind === 'terminal') {
    return layout.addShellPane();
  }
  if (intent.kind === 'browser') {
    return layout.addBrowserPane();
  }
  const orch = useOrchStore.getState();
  const panes = listPanes(layout.root);
  const recentOutputByPane: Record<string, string> = {};
  for (const pane of panes) {
    recentOutputByPane[pane.id] = recentExcerpt(pane.id);
  }
  const focused = panes.find((pane) => pane.id === layout.focusedPaneId);
  const planned = planOperatorAgentSpawn({
    accountId: intent.accountId,
    focusedPaneId: layout.focusedPaneId,
    panes,
    paneMissions: orch.paneMissions,
    paneStates: paneStateRecord(),
    recentOutputByPane,
    missions: orch.missions,
    fromAccountLabel: accountLabelOf(focused?.accountId, 'conta anterior'),
    toAccountLabel: accountLabelOf(intent.accountId, DEFAULT_ACCOUNT_LABEL),
  });
  if (planned.accountId || planned.continuityPack) {
    return layout.spawnAgent(intent.adapterId, intent.model, planned);
  }
  return layout.spawnAgent(intent.adapterId, intent.model);
}

export function PanePicker({
  onPaneCreated,
}: {
  /** Chamado com o id do pane criado — vistas filtradas o tornam visível. */
  readonly onPaneCreated?: (paneId: string) => void;
} = {}) {
  const providers = useProviderStore((state) => state.providers);
  const accounts = useAccountStore((state) => state.accounts);
  const pendingOpen = usePanePickerStore((state) => state.pendingOpen);
  const pendingAccountsAdapterId = usePanePickerStore(
    (state) => state.pendingAccountsAdapterId,
  );
  const consumePendingOpen = usePanePickerStore(
    (state) => state.consumePendingOpen,
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  /** CLI cuja vista de contas está ocupando o painel (null = lista). */
  const [accountsFor, setAccountsFor] = useState<string | null>(null);
  /** Conta cadastrada agora: a lista volta com ela sob o cursor. */
  const [freshAccountId, setFreshAccountId] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo(
    () => withAccountActions(buildPanePickerEntries(providers, accounts), accounts),
    [providers, accounts],
  );
  const filtered = useMemo(
    () => filterPaletteActions(entries, query),
    [entries, query],
  );
  const accountsForLabel = useMemo(
    () =>
      providers.find((provider) => provider.adapterId === accountsFor)?.label ??
      accountsFor ??
      '',
    [providers, accountsFor],
  );
  const hasCli = useMemo(
    () => entries.some((entry) => entry.section === 'clis'),
    [entries],
  );
  const unavailable = useMemo(
    () => buildPanePickerUnavailable(providers),
    [providers],
  );

  /** Fecha devolvendo o foco ao gatilho — teclado nunca fica órfão. */
  const closeToTrigger = useCallback(() => {
    setOpen(false);
    setAccountsFor(null);
    triggerRef.current?.focus();
  }, []);

  /** Volta da vista de contas para a lista. O foco é reposto no efeito
   *  abaixo: a busca só volta a existir no render seguinte. */
  const backToList = useCallback(() => setAccountsFor(null), []);

  // Início → Abrir um pane: o grid pode estar escondido; o pedido fica
  // até este picker montar/ficar vivo. Quando o pedido nomeia uma CLI, o
  // menu volta direto na vista de contas dela.
  useEffect(() => {
    if (!pendingOpen) return;
    setOpen(true);
    if (pendingAccountsAdapterId) setAccountsFor(pendingAccountsAdapterId);
    consumePendingOpen();
  }, [pendingOpen, pendingAccountsAdapterId, consumePendingOpen]);

  // O login sai para Terminais e pode desmontar este menu no caminho. Se
  // isso acontecer com a vista de contas aberta, o pedido fica na store e a
  // próxima montagem devolve o contexto — só no desmonte de verdade, nunca
  // quando o próprio operador voltou para a lista.
  const accountsForRef = useRef<string | null>(null);
  accountsForRef.current = accountsFor;
  useEffect(
    () => () => {
      const pending = accountsForRef.current;
      if (pending) usePanePickerStore.getState().requestOpen(pending);
    },
    [],
  );

  // Fechar o menu encerra a vista de contas: reabrir depois começa na lista,
  // e o desmonte só restaura contexto de quem NÃO fechou de propósito.
  useEffect(() => {
    if (!open) setAccountsFor(null);
  }, [open]);

  // Estado limpo a cada abertura (18 CLIs não se navegam com scroll).
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
  }, [open]);

  // O foco vive na busca sempre que a lista está na frente — ao abrir e ao
  // voltar da vista de contas. Teclado nunca fica órfão no meio do menu.
  useEffect(() => {
    if (open && !accountsFor) inputRef.current?.focus();
  }, [open, accountsFor]);

  // Conta recém-criada: a lista volta com ela sob o cursor, para a escolha
  // explícita do modelo. Nunca abre um pane sozinha.
  useEffect(() => {
    if (!freshAccountId || accountsFor) return;
    const index = filtered.findIndex(
      (row) =>
        !isAccountAction(row) &&
        row.intent.kind === 'agent' &&
        row.intent.accountId === freshAccountId,
    );
    if (index >= 0) setCursor(index);
  }, [freshAccountId, accountsFor, filtered]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      // Clique fora é saída deliberada: fecha SEM roubar o foco de volta.
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // Escape sobe UM nível: de contas para a lista, da lista para fora.
      if (accountsForRef.current) backToList();
      else closeToTrigger();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, closeToTrigger, backToList]);

  // O cursor nunca aponta para fora do filtro corrente.
  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const runRow = (row: PanePickerRow) => {
    if (isAccountAction(row)) {
      // Cadastro não abre pane: o menu troca para a vista de contas e o
      // operador volta para escolher o modelo com a conta já selecionada.
      setFreshAccountId(null);
      setAccountsFor(row.adapterId);
      return;
    }
    setOpen(false);
    const paneId = runPanePickerIntent(row.intent);
    if (paneId) onPaneCreated?.(paneId);
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
      const row = filtered[cursor];
      if (row) runRow(row);
    }
  };

  let lastSection: PanePickerSection | null = null;
  let lastGroup: string | null = null;

  return (
    <div className="pane-picker" ref={rootRef}>
      {open && (
        <div
          className="pane-picker__panel"
          data-view={accountsFor ? 'accounts' : 'list'}
          role="dialog"
          aria-label={
            accountsFor
              ? `Contas de ${accountsForLabel}`
              : 'Abrir novo pane'
          }
          // Setas/Enter só governam a LISTA. Dentro do formulário de contas
          // eles pertencem aos campos: capturá-los ali roubaria o Enter de
          // quem está digitando o nome da conta.
          onKeyDown={accountsFor ? undefined : onKeyDown}
        >
          {accountsFor ? (
            <>
              <div className="pane-picker__head pane-picker__head--back">
                <button
                  type="button"
                  className="pane-picker__back"
                  data-testid="pane-picker-accounts-back"
                  onClick={backToList}
                >
                  <PixelIcon name="chevron" size={12} />
                  Voltar às contas
                </button>
                <span className="pane-picker__head-title">
                  {accountsForLabel}
                </span>
              </div>
              <div className="pane-picker__accounts">
                <AccountsManager
                  adapterId={accountsFor}
                  adapterLabel={accountsForLabel}
                  compact
                  onAccountAdded={(accountId) => {
                    setFreshAccountId(accountId);
                    setAccountsFor(null);
                  }}
                />
              </div>
            </>
          ) : (
            <>
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
                {filtered.map((row, index) => {
                  const showSection = row.section !== lastSection;
                  const showGroup = row.group !== '' && row.group !== lastGroup;
                  lastSection = row.section;
                  lastGroup = row.group;
                  const admin = isAccountAction(row);
                  const isFresh =
                    !admin &&
                    row.intent.kind === 'agent' &&
                    row.intent.accountId !== undefined &&
                    row.intent.accountId === freshAccountId;
                  return (
                    <li key={row.id} role="presentation">
                      {showSection && (
                        <div className="pane-picker__section" aria-hidden="true">
                          {SECTION_LABEL[row.section]}
                        </div>
                      )}
                      {showGroup && (
                        <div className="pane-picker__group" aria-hidden="true">
                          {row.adapterId && (
                            <ProviderLogo
                              adapterId={row.adapterId}
                              label={row.group}
                              size="xs"
                            />
                          )}
                          <span className="pane-picker__group-name">
                            {row.group}
                          </span>
                        </div>
                      )}
                      <button
                        type="button"
                        role="option"
                        id={`pane-picker-opt-${index}`}
                        aria-selected={index === cursor}
                        aria-label={
                          admin
                            ? `Adicionar conta em ${row.group}`
                            : undefined
                        }
                        data-active={index === cursor}
                        data-admin={admin || undefined}
                        data-fresh={isFresh || undefined}
                        data-testid={`pane-picker-entry-${row.id}`}
                        className="pane-picker__item"
                        onMouseEnter={() => setCursor(index)}
                        onClick={() => runRow(row)}
                      >
                        <PixelIcon name={row.icon} size={12} />
                        <span className="pane-picker__item-label">
                          {row.label}
                        </span>
                        <span className="pane-picker__item-detail">
                          <span aria-hidden="true">›</span>
                          {row.detail}
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

              {unavailable.length > 0 && (
                <div
                  className="pane-picker__unavailable"
                  aria-label="CLIs indisponíveis"
                >
                  <div className="pane-picker__section" aria-hidden="true">
                    Indisponíveis
                  </div>
                  {unavailable.map((item) => (
                    <p
                      key={item.adapterId}
                      className="pane-picker__unavailable-row"
                    >
                      <ProviderLogo
                        adapterId={item.adapterId}
                        label={item.label}
                        size="xs"
                      />
                      <span className="pane-picker__item-label">{item.label}</span>
                      <span className="pane-picker__unavailable-reason">
                        {item.reason}
                      </span>
                    </p>
                  ))}
                </div>
              )}
            </>
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

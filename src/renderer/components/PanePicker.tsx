import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountInfo } from '../../shared/account-types';
import { rankAutoSeatCli } from '../../shared/auto-seat-auth';
import { OPERATIONAL_BAND_LABELS } from '../../shared/model-operational-bands';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { filterPaletteActions } from '../lib/command-palette-filter';
import { rankPickerModels, type PickerModelRow } from '../lib/pane-picker-models';
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

export type PanePickerAccountStatus =
  | 'implicit'
  | 'active'
  | 'ready'
  | 'expired'
  | 'cooldown'
  | 'no-credential';

/** Sub-cabeçalho de conta dentro do grupo da CLI (conta A, conta B…). */
export interface PanePickerAccountHeading {
  readonly key: string;
  readonly label: string;
  readonly email?: string;
  readonly status: PanePickerAccountStatus;
  /** Chip ao lado do nome; vazio quando não há nada a dizer. */
  readonly statusLabel: string;
}

export type PanePickerBadgeTone =
  | 'deep'
  | 'balanced'
  | 'fast'
  | 'default'
  | 'restricted';

/** Chip à direita do modelo: faixa operacional, padrão da CLI, restrito. */
export interface PanePickerBadge {
  readonly label: string;
  readonly tone: PanePickerBadgeTone;
  readonly title?: string;
}

export interface PanePickerEntry {
  readonly id: string;
  readonly section: PanePickerSection;
  /** Cabeçalho do grupo (label da CLI). Vazio na seção TIPO. */
  readonly group: string;
  /** Adapter do grupo — só para o logo do cabeçalho. */
  readonly adapterId?: string;
  /** Linha principal: o modelo (linhas de CLI), ou o nome do tipo. */
  readonly label: string;
  /**
   * Complemento: nas linhas de CLI é a conta (com "(sessão expirada)"
   * quando for o caso) — só para leitores de tela, porque a conta já
   * encabeça o bloco —; nos tipos, a natureza deles.
   */
  readonly detail: string;
  readonly icon: PixelIconName;
  readonly keywords: string;
  readonly intent: PanePickerIntent;
  /** Conta que encabeça o bloco desta linha (só linhas de CLI). */
  readonly account?: PanePickerAccountHeading;
  readonly badges?: readonly PanePickerBadge[];
  /** Posição do modelo dentro da conta, 0 = mais forte. Governa a dobra. */
  readonly rank?: number;
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
 * Adapter sem catálogo é legítimo: uma única linha vazia, que vira "padrão
 * da ferramenta" e sobe a CLI sem `--model`.
 */
const EMPTY_CATALOG_ROW: PickerModelRow = {
  id: '',
  band: null,
  restricted: false,
  isDefault: false,
};

/**
 * Conta morta continua escolhível (o prepare veta com motivo), mas nunca
 * com o nome limpo — o sufixo honesto evita o 401 surpresa.
 */
function accountDetail(account: AccountInfo | undefined): string {
  if (!account) return DEFAULT_ACCOUNT_LABEL;
  return account.needsRelogin && account.label
    ? `${account.label} (sessão expirada)`
    : account.label;
}

function accountStatus(
  account: AccountInfo,
): [PanePickerAccountStatus, string] {
  if (account.needsRelogin) return ['expired', 'sessão expirada'];
  if (!account.hasCredential) return ['no-credential', 'sem credencial'];
  if (account.onCooldown) return ['cooldown', 'em pausa (limite)'];
  if (account.active) return ['active', 'ativa'];
  return ['ready', ''];
}

function accountHeading(
  adapterId: string,
  account: AccountInfo | undefined,
): PanePickerAccountHeading {
  if (!account) {
    return {
      key: `${adapterId}:default`,
      label: DEFAULT_ACCOUNT_LABEL,
      status: 'implicit',
      statusLabel: 'credencial ativa da CLI',
    };
  }
  const [status, statusLabel] = accountStatus(account);
  return {
    key: `${adapterId}:${account.id}`,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    status,
    statusLabel,
  };
}

function accountDisplayRank(account: AccountInfo): number {
  if (account.needsRelogin) return 4;
  if (!account.hasCredential) return 3;
  if (account.onCooldown) return 2;
  if (account.active) return 0;
  return 1;
}

function compareAccountsForDisplay(a: AccountInfo, b: AccountInfo): number {
  return (
    accountDisplayRank(a) - accountDisplayRank(b) ||
    a.label.localeCompare(b.label, 'pt-BR') ||
    a.createdAt - b.createdAt
  );
}

export function resolveSpecialtyBadge(
  adapterId: string,
  modelId: string,
): PanePickerBadge | null {
  const m = (modelId || '').toLowerCase();
  const a = (adapterId || '').toLowerCase();
  if (
    m.includes('haiku') ||
    m.includes('flash') ||
    m.includes('mini') ||
    m.includes('nano')
  ) {
    return {
      label: 'rápido',
      tone: 'fast',
      title: 'Ideal para tarefas rápidas, scouting e automações',
    };
  }
  if (m.includes('opus') || m.includes('sonnet') || a.includes('claude')) {
    return {
      label: 'frontend',
      tone: 'deep',
      title: 'Especialista em React, Frontend e Arquitetura',
    };
  }
  if (
    m.includes('codex') ||
    m.includes('gpt-5') ||
    m.includes('o3') ||
    a.includes('codex')
  ) {
    return {
      label: 'lógica',
      tone: 'deep',
      title: 'Especialista em Lógica, Algoritmos e Refatoração',
    };
  }
  if (m.includes('gemini') || a.includes('gemini')) {
    return {
      label: 'contexto',
      tone: 'balanced',
      title: 'Especialista em Longo Contexto e Multimodal',
    };
  }
  if (m.includes('kimi') || m.includes('deepseek') || a.includes('kimi')) {
    return {
      label: 'raciocínio',
      tone: 'deep',
      title: 'Especialista em Raciocínio Profundo e C/Rust',
    };
  }
  return null;
}

export function resolveSpecialtyKeywords(
  adapterId: string,
  modelId: string,
): string {
  const badge = resolveSpecialtyBadge(adapterId, modelId);
  if (!badge) return '';
  switch (badge.label) {
    case 'frontend':
      return 'frontend react ui css tailwind design arquiteto';
    case 'lógica':
      return 'logica refactor algoritmo backend bug fix';
    case 'contexto':
      return 'contexto multimodal documentos analise longo';
    case 'raciocínio':
      return 'raciocinio math algoritmos profundos c rust';
    case 'rápido':
      return 'rapido recon scout automacao leve';
    default:
      return badge.label;
  }
}

function badgesOf(row: PickerModelRow): PanePickerBadge[] {
  const badges: PanePickerBadge[] = [];
  if (row.band) {
    badges.push({ label: OPERATIONAL_BAND_LABELS[row.band], tone: row.band });
  }
  if (row.isDefault) {
    badges.push({
      label: 'padrão',
      tone: 'default',
      title: 'Modelo padrão desta CLI',
    });
  }
  if (row.restricted) {
    badges.push({
      label: 'restrito',
      tone: 'restricted',
      title:
        row.warning ??
        'Acesso restrito: só funciona se a sua conta tiver este modelo.',
    });
  }
  return badges;
}

function agentEntry(
  provider: ProviderSettingsInfo,
  account: AccountInfo | undefined,
  heading: PanePickerAccountHeading,
  row: PickerModelRow,
  rank: number,
): PanePickerEntry {
  const modelLabel = row.id || DEFAULT_MODEL_LABEL;
  const badges = badgesOf(row);
  const specialtyWords = resolveSpecialtyKeywords(provider.adapterId, row.id);
  return {
    id: `agent:${provider.adapterId}:${account?.id ?? 'default'}:${row.id || 'default'}`,
    section: 'clis',
    group: provider.label,
    adapterId: provider.adapterId,
    label: modelLabel,
    detail: accountDetail(account),
    icon: 'plus',
    keywords: [
      provider.label,
      provider.adapterId,
      account?.label ?? DEFAULT_ACCOUNT_LABEL,
      account?.email ?? '',
      modelLabel,
      specialtyWords,
      ...badges.map((badge) => badge.label),
    ].filter(Boolean).join(' '),
    intent: {
      kind: 'agent',
      adapterId: provider.adapterId,
      model: row.id,
      ...(account ? { accountId: account.id } : {}),
    },
    account: heading,
    badges,
    rank,
  };
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
    .sort(
      (a, b) =>
        rankAutoSeatCli(a.adapterId) - rankAutoSeatCli(b.adapterId) ||
        a.label.localeCompare(b.label, 'pt-BR'),
    );

  for (const provider of installed) {
    const mine = accounts.filter(
      (account) => account.adapterId === provider.adapterId,
    ).sort(compareAccountsForDisplay);
    const ranked = rankPickerModels(provider);
    const models = ranked.length > 0 ? ranked : [EMPTY_CATALOG_ROW];
    // Conta por fora, modelo por dentro: cada conta abre o próprio bloco com
    // os modelos do mais forte ao mais leve — em vez de intercalar
    // conta×modelo e obrigar a ler a lista inteira para achar "B no opus".
    const owners: readonly (AccountInfo | undefined)[] =
      mine.length === 0 ? [undefined] : mine;
    for (const owner of owners) {
      const heading = accountHeading(provider.adapterId, owner);
      models.forEach((row, rank) =>
        entries.push(agentEntry(provider, owner, heading, row, rank)),
      );
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

/**
 * Linha "mais N modelos": cada conta mostra os mais fortes e guarda o resto
 * atrás desta dobra. Abrir a dobra não fecha o menu.
 */
export interface PanePickerFoldAction {
  readonly id: string;
  readonly section: 'clis';
  readonly group: string;
  readonly adapterId: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: PixelIconName;
  readonly keywords: string;
  /** Chave da conta cujo bloco esta linha expande. */
  readonly expandFold: string;
}

export type PanePickerRow =
  | PanePickerEntry
  | PanePickerAccountAction
  | PanePickerFoldAction;

export function isAccountAction(
  row: PanePickerRow,
): row is PanePickerAccountAction {
  return 'manageAccounts' in row;
}

export function isFoldAction(row: PanePickerRow): row is PanePickerFoldAction {
  return 'expandFold' in row;
}

export function isPickerEntry(row: PanePickerRow): row is PanePickerEntry {
  return 'intent' in row;
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

/** Modelos visíveis por conta antes de "mais N modelos". */
export const PANE_PICKER_MODELS_ABOVE_FOLD = 4;

/**
 * Dobra da lista em repouso: por conta, os 4 modelos mais fortes ficam à
 * vista e o resto entra atrás de uma linha "mais N modelos". Só dobra quando
 * esconderia pelo menos 2 — dobrar um único modelo é pior que mostrá-lo. A
 * busca nunca passa por aqui: quem digita vê tudo.
 */
export function foldPanePickerRows(
  rows: readonly PanePickerRow[],
  expanded: ReadonlySet<string>,
): PanePickerRow[] {
  const perAccount = new Map<string, number>();
  for (const row of rows) {
    if (!isPickerEntry(row) || !row.account) continue;
    perAccount.set(row.account.key, (perAccount.get(row.account.key) ?? 0) + 1);
  }
  const out: PanePickerRow[] = [];
  for (const row of rows) {
    if (!isPickerEntry(row) || !row.account || row.rank === undefined) {
      out.push(row);
      continue;
    }
    const key = row.account.key;
    const total = perAccount.get(key) ?? 0;
    const folds =
      total > PANE_PICKER_MODELS_ABOVE_FOLD + 1 && !expanded.has(key);
    if (!folds || row.rank < PANE_PICKER_MODELS_ABOVE_FOLD) {
      out.push(row);
    } else if (row.rank === PANE_PICKER_MODELS_ABOVE_FOLD) {
      out.push({
        id: `more:${key}`,
        section: 'clis',
        group: row.group,
        adapterId: row.adapterId ?? '',
        label: `mais ${total - PANE_PICKER_MODELS_ABOVE_FOLD} modelos`,
        detail: '',
        icon: 'chevron-down',
        keywords: '',
        expandFold: key,
      });
    }
  }
  return out;
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
  /** Contas cujo bloco de modelos foi aberto além da dobra. */
  const [expandedFolds, setExpandedFolds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo(
    () => withAccountActions(buildPanePickerEntries(providers, accounts), accounts),
    [providers, accounts],
  );
  // A busca vê tudo; só a lista em repouso dobra os modelos além dos mais
  // fortes de cada conta.
  const filtered = useMemo(
    () =>
      query.trim()
        ? filterPaletteActions(entries, query)
        : foldPanePickerRows(entries, expandedFolds),
    [entries, query, expandedFolds],
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
    setExpandedFolds(new Set());
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
        isPickerEntry(row) &&
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
    if (isFoldAction(row)) {
      // Abrir a dobra não fecha o menu: o cursor fica onde está e o primeiro
      // modelo escondido assume a linha.
      setExpandedFolds((current) => new Set(current).add(row.expandFold));
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
  let lastAccountKey: string | null = null;

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
                  if (showGroup) lastAccountKey = null;
                  lastSection = row.section;
                  lastGroup = row.group;
                  const entry = isPickerEntry(row) ? row : null;
                  const heading = entry?.account;
                  const showAccount =
                    heading !== undefined && heading.key !== lastAccountKey;
                  if (heading) lastAccountKey = heading.key;
                  const admin = isAccountAction(row);
                  const fold = isFoldAction(row);
                  const isFresh =
                    entry !== null &&
                    entry.intent.kind === 'agent' &&
                    entry.intent.accountId !== undefined &&
                    entry.intent.accountId === freshAccountId;
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
                      {showAccount && heading && (
                        <div
                          className="pane-picker__account"
                          aria-hidden="true"
                          data-status={heading.status}
                        >
                          <span className="pane-picker__account-name">
                            {heading.label}
                          </span>
                          {heading.email && (
                            <span className="pane-picker__account-email">
                              {heading.email}
                            </span>
                          )}
                          {heading.statusLabel && (
                            <span className="pane-picker__account-status">
                              {heading.statusLabel}
                            </span>
                          )}
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
                        data-fold={fold || undefined}
                        data-model={heading ? true : undefined}
                        data-fresh={isFresh || undefined}
                        data-testid={`pane-picker-entry-${row.id}`}
                        className="pane-picker__item"
                        title={heading ? row.label : undefined}
                        onMouseEnter={() => setCursor(index)}
                        onClick={() => runRow(row)}
                      >
                        <PixelIcon name={row.icon} size={12} />
                        <span className="pane-picker__item-label">
                          {row.label}
                        </span>
                        {entry?.badges && entry.badges.length > 0 && (
                          <span className="pane-picker__item-badges">
                            {entry.badges.map((badge) => (
                              <span
                                key={badge.tone}
                                className="pane-picker__badge"
                                data-tone={badge.tone}
                                title={badge.title}
                              >
                                {badge.label}
                              </span>
                            ))}
                          </span>
                        )}
                        {heading ? (
                          <span className="pane-picker__sr-only">
                            {` — ${row.detail}`}
                          </span>
                        ) : row.detail ? (
                          <span className="pane-picker__item-detail">
                            <span aria-hidden="true">›</span>
                            {row.detail}
                          </span>
                        ) : null}
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

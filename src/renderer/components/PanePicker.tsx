import { allowPaneCreation } from '../state/access-guard';
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
import type { PaneRouteEffort } from '../../shared/pane-route';
import {
  PaneRouteConfirm,
  type PaneRouteConfirmState,
} from './PaneRouteConfirm';
import { useSessionStateStore } from '../state/session-state-store';
import { useToastStore } from '../state/toast-store';
import { getPaneSessionId } from '../terminal/terminal-host';
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
      /**
       * Esforço escolhido no passo de confirmação. Ausente = a CLI decide
       * (sem `--effort` no argv), que é como todo pane aberto na mão nascia
       * antes deste passo existir.
       */
      readonly effort?: PaneRouteEffort;
      /** Primeiro pedido do operador, entregue quando a CLI estiver pronta. */
      readonly brief?: string;
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
  clis: 'CLIs',
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

/** Linhas fixas da seção Tipo — as mesmas no índice e no catálogo completo. */
function typeEntries(): PanePickerEntry[] {
  return [
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
}

/**
 * Monta o catálogo do menu a partir das duas fontes de verdade. Puro de
 * propósito: é o que os testes exercitam sem montar React.
 */
export function buildPanePickerEntries(
  providers: readonly ProviderSettingsInfo[],
  accounts: readonly AccountInfo[],
): PanePickerEntry[] {
  const entries: PanePickerEntry[] = typeEntries();

  for (const provider of clisSorted(providers)) {
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

function clisSorted(providers: readonly ProviderSettingsInfo[]) {
  return providers
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
}

/**
 * Nível 1 do menu: os tipos fixos + UMA linha por CLI instalada. A matriz
 * conta × modelo mora no nível 2 (drill-in) — sem isso, N CLIs × M modelos ×
 * K contas viravam uma parede única de scroll onde uma ferramenta instalada
 * "sumia" dezenas de linhas abaixo (o caso real: Grok sob 2 contas de
 * Claude). A busca continua global e ignora o índice: quem digita "grok" ou
 * "opus" cai direto na linha de spawn.
 */
export function buildPanePickerIndex(
  providers: readonly ProviderSettingsInfo[],
  accounts: readonly AccountInfo[],
): PanePickerRow[] {
  const rows: PanePickerRow[] = typeEntries();
  for (const provider of clisSorted(providers)) {
    const ranked = rankPickerModels(provider);
    // O índice não carrega o selo "restrito" da matriz: anunciar aqui um modelo
    // api-only que o auto-routing recusa faria o operador pedir no resumo o que
    // o roteamento nega. Prefere o mais forte entre os que sentam de verdade.
    const top = (ranked.find((entry) => !entry.restricted) ?? ranked[0])?.id;
    const mine = accounts.filter(
      (account) => account.adapterId === provider.adapterId,
    ).length;
    const detail = [
      top ? `${top}${ranked.length > 1 ? ` +${ranked.length - 1}` : ''}` : DEFAULT_MODEL_LABEL,
      mine > 0 ? `${mine} conta${mine === 1 ? '' : 's'}` : '',
      provider.authState === 'missing' ? 'login pendente' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    rows.push({
      id: `cli:${provider.adapterId}`,
      section: 'clis',
      group: '',
      adapterId: provider.adapterId,
      label: provider.label,
      detail,
      icon: 'arrow-right',
      keywords: `${provider.label} ${provider.adapterId} cli`,
      drillCli: provider.adapterId,
    });
  }
  return rows;
}

/**
 * Caminho visível até as contas/CLIs de IA. Configurações foi reorganizada por
 * tarefa (0.76.83): "Contas" e "Providers" não existem mais como abas soltas.
 */
export const AI_ACCOUNTS_SETTINGS_PATH =
  'Configurações › Conta e acesso a IAs › Contas de IA';

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
          ? `desligada em ${AI_ACCOUNTS_SETTINGS_PATH}`
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
 * Linha de índice do nível 1: UMA por CLI instalada — nome, modelos e contas
 * em resumo — que abre a matriz conta × modelo daquela ferramenta no nível 2.
 * Não é pane nem cadastro: é navegação ("drill"), então nunca aparece na
 * busca global (ela já enxerga as linhas de modelo direto).
 */
export interface PanePickerCliIndexAction {
  readonly id: string;
  readonly section: 'clis';
  /** Vazio: linhas de índice não imprimem cabeçalho de grupo. */
  readonly group: '';
  readonly adapterId: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: PixelIconName;
  readonly keywords: string;
  /** CLI cuja matriz conta × modelo esta linha abre. */
  readonly drillCli: string;
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
  | PanePickerCliIndexAction
  | PanePickerAccountAction
  | PanePickerFoldAction;

export function isAccountAction(
  row: PanePickerRow,
): row is PanePickerAccountAction {
  return 'manageAccounts' in row;
}

export function isCliIndexAction(
  row: PanePickerRow,
): row is PanePickerCliIndexAction {
  return 'drillCli' in row;
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
  if (!allowPaneCreation()) return undefined;
  const layout = useLayoutStore.getState();
  if (intent.kind === 'terminal') {
    return layout.addShellPane();
  }
  if (intent.kind === 'browser') {
    return layout.addBrowserPane();
  }
  const orch = useOrchStore.getState();
  const panes = listPanes(layout.root);
  // Serialize only recovery candidates, once per click. Ordinary panes never
  // need a transcript; a healthy focused mission also skips its siblings.
  const excerpts = new Map<string, string>();
  const recentOutputByPane = (paneId: string): string => {
    if (!excerpts.has(paneId)) excerpts.set(paneId, recentExcerpt(paneId));
    return excerpts.get(paneId)!;
  };
  const focused = panes.find((pane) => pane.id === layout.focusedPaneId);
  const planned = planOperatorAgentSpawn({
    accountId: intent.accountId,
    focusedPaneId: layout.focusedPaneId,
    // A sessão física viaja junto: sem ela o sucessor da coordenação só podia
    // ser escolhido pelo papel pintado no layout — que é do próprio pane.
    panes: panes.map((pane) => ({
      ...pane,
      sessionId: getPaneSessionId(pane.id),
    })),
    paneMissions: orch.paneMissions,
    paneStates: paneStateRecord(),
    recentOutputByPane,
    missions: orch.missions,
    fromAccountLabel: accountLabelOf(focused?.accountId, 'conta anterior'),
    toAccountLabel: accountLabelOf(intent.accountId, DEFAULT_ACCOUNT_LABEL),
  });
  // O esforço e o brief são do OPERADOR (passo de confirmação), não do plano
  // de continuidade — por isso entram aqui e não em `planOperatorAgentSpawn`,
  // que decide conta e pacote de continuidade. Ausentes, o spawn é idêntico
  // ao de antes deste passo existir.
  const chosen = {
    ...(intent.effort ? { effort: intent.effort } : {}),
    ...(intent.brief ? { brief: intent.brief } : {}),
  };
  if (planned.accountId || planned.continuityPack || intent.effort || intent.brief) {
    return layout.spawnAgent(intent.adapterId, intent.model, { ...planned, ...chosen });
  }
  return layout.spawnAgent(intent.adapterId, intent.model);
}

export interface PanePickerTrigger {
  /** Texto visível; sem ele o gatilho é só o ícone. */
  readonly label?: string;
  readonly ariaLabel: string;
  readonly title: string;
}

/**
 * F-231 — a aba hospeda uma missão viva: o "+ Pane" pergunta o destino antes
 * da lista de CLIs ("Nesta missão" padrão, "Nesta aba (solto)", "Nova aba").
 * O id resolve o vínculo — o renderer nunca envia autoridade ao Main.
 */
export interface PanePickerMissionDestination {
  readonly missionId: string;
  readonly title: string;
}

/** Destino escolhido no passo extra do picker de uma aba de missão. */
type PanePickerDestination = 'mission' | 'loose' | 'newTab';

const OPERATOR_PANE_SPAWN_ERROR: Readonly<Record<string, string>> = {
  roster_rejected: 'Esse provider não faz parte da equipe selada da missão',
  mission_not_running: 'A missão não está em execução',
  mission_unavailable: 'Missão indisponível neste workspace',
  adapter_not_installed: 'CLI não instalada',
  adapter_not_spawnable: 'Esse provider não abre pane (só API)',
  mission_authority_stale:
    'A autoridade da missão mudou — feche e reabra o picker',
  hardened: 'A política endurecida não permite pane dentro da missão',
};

export function PanePicker({
  onPaneCreated,
  placement = 'grid',
  trigger,
  acceptsPendingOpen = true,
  missionDestination,
  onPaneCreatedLoose,
  onPaneCreatedInNewTab,
}: {
  /** Chamado com o id do pane criado — vistas filtradas o tornam visível. */
  readonly onPaneCreated?: (paneId: string) => void;
  /**
   * F-231: missão viva da aba. Presente, o picker abre um passo de destino
   * antes da lista ("Nesta missão" é o padrão sob o cursor).
   */
  readonly missionDestination?: PanePickerMissionDestination;
  /**
   * F-231 — "Nesta aba (solto)": o chamador carimba a casa persistida do
   * pane (aba de missão não é um espaço — sem o carimbo ele ia parar em
   * "Terminais" no restart).
   */
  readonly onPaneCreatedLoose?: (paneId: string) => void;
  /** F-231 — "Nova aba": o chamador cria o espaço novo e migra o pane. */
  readonly onPaneCreatedInNewTab?: (paneId: string) => void;
  /**
   * `grid`: flutua no rodapé da grelha e abre para cima (o "+ Pane").
   * `tabbar`: mora na barra de abas e abre para baixo (o "+" de aba nova).
   */
  readonly placement?: 'grid' | 'tabbar';
  readonly trigger?: PanePickerTrigger;
  /**
   * Pedidos globais de "abrir o picker" (Início → Abrir um pane) servem UMA
   * instância. Com duas grelhas na tela (abas lado a lado) ou o "+" da barra,
   * só a principal atende — senão os dois menus abririam juntos.
   */
  readonly acceptsPendingOpen?: boolean;
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
  /**
   * O que o operador quer feito. É SEPARADO da busca: a busca filtra CLI,
   * conta e modelo ("grok", "opus"); isto é o pedido ("arruma o login"), e é
   * ele que o Jev lê para propor esforço e skill. Vazio = o "+ Pane" abre
   * na hora, exatamente como sempre abriu.
   */
  const [request, setRequest] = useState('');
  const [confirming, setConfirming] = useState<
    { readonly intent: PanePickerIntent; readonly label: string } | null
  >(null);
  const [routeState, setRouteState] = useState<PaneRouteConfirmState>({ kind: 'none' });
  const [chosenEffort, setChosenEffort] = useState<PaneRouteEffort | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  /** F-231: destino escolhido no passo extra de uma aba com missão viva. */
  const [destination, setDestination] = useState<PanePickerDestination | null>(
    null,
  );
  const destinationOptions = useMemo(
    () =>
      missionDestination
        ? ([
            {
              id: 'mission' as const,
              label: `Nesta missão: ${missionDestination.title}`,
              detail: 'participante visível ao Maestro — só você fecha',
              icon: 'orch' as const,
            },
            {
              id: 'loose' as const,
              label: 'Nesta aba (solto)',
              detail: 'seu pane, fora da missão — o Maestro não o vê',
              icon: 'terminal' as const,
            },
            {
              id: 'newTab' as const,
              label: 'Nova aba',
              detail: 'abre numa aba própria, fora desta missão',
              icon: 'grid' as const,
            },
          ] satisfies ReadonlyArray<{
            id: PanePickerDestination;
            label: string;
            detail: string;
            icon: PixelIconName;
          }>)
        : null,
    [missionDestination],
  );
  /** O passo de destino está aberto quando ainda não houve escolha. */
  const destinationPending =
    open && destinationOptions !== null && destination === null;
  /** CLI cujo índice foi aberto: a matriz conta × modelo dela ocupa o painel. */
  const [drillCli, setDrillCli] = useState<string | null>(null);
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
  const indexRows = useMemo(
    () => buildPanePickerIndex(providers, accounts),
    [providers, accounts],
  );
  /** Linhas da CLI aberta em drill — modelos por conta + ação de cadastro. */
  const drillRows = useMemo(
    () =>
      drillCli
        ? entries.filter(
            (row) =>
              (row as { adapterId?: string }).adapterId === drillCli,
          )
        : [],
    [entries, drillCli],
  );
  // A busca vê tudo e ignora o nível; em repouso, o índice lista UMA linha por
  // CLI e o drill dobra os modelos além dos mais fortes de cada conta.
  const filtered = useMemo(
    () =>
      query.trim()
        ? filterPaletteActions(entries, query)
        : drillCli
          ? foldPanePickerRows(drillRows, expandedFolds)
          : indexRows,
    [entries, indexRows, drillRows, query, drillCli, expandedFolds],
  );
  const accountsForLabel = useMemo(
    () =>
      providers.find((provider) => provider.adapterId === accountsFor)?.label ??
      accountsFor ??
      '',
    [providers, accountsFor],
  );
  const drillLabel = useMemo(
    () =>
      providers.find((provider) => provider.adapterId === drillCli)?.label ??
      drillCli ??
      '',
    [providers, drillCli],
  );
  const hasCli = useMemo(
    () => indexRows.some((row) => row.section === 'clis'),
    [indexRows],
  );
  const unavailable = useMemo(
    () => buildPanePickerUnavailable(providers),
    [providers],
  );

  /** Fecha devolvendo o foco ao gatilho — teclado nunca fica órfão. */
  const closeToTrigger = useCallback(() => {
    setOpen(false);
    setAccountsFor(null);
    setDrillCli(null);
    setDestination(null);
    triggerRef.current?.focus();
  }, []);

  /** Sobe UM nível: contas → matriz da CLI → índice. O foco é reposto no
   *  efeito abaixo: a busca só volta a existir no render seguinte. */
  const stepUp = useCallback(() => {
    if (accountsFor) setAccountsFor(null);
    else setDrillCli(null);
  }, [accountsFor]);

  // Início → Abrir um pane: o grid pode estar escondido; o pedido fica
  // até este picker montar/ficar vivo. Quando o pedido nomeia uma CLI, o
  // menu volta direto na vista de contas dela.
  useEffect(() => {
    if (!pendingOpen || !acceptsPendingOpen) return;
    if (!allowPaneCreation()) { consumePendingOpen(); return; }
    setOpen(true);
    if (pendingAccountsAdapterId) {
      // Voltar das contas devolve a matriz daquela CLI, não o índice geral.
      setDrillCli(pendingAccountsAdapterId);
      setAccountsFor(pendingAccountsAdapterId);
    }
    consumePendingOpen();
  }, [pendingOpen, pendingAccountsAdapterId, consumePendingOpen, acceptsPendingOpen]);

  // O login sai para Terminais e pode desmontar este menu no caminho. Se
  // isso acontecer com a vista de contas aberta, o pedido fica na store e a
  // próxima montagem devolve o contexto — só no desmonte de verdade, nunca
  // quando o próprio operador voltou para a lista.
  const accountsForRef = useRef<string | null>(null);
  accountsForRef.current = accountsFor;
  const drillCliRef = useRef<string | null>(null);
  drillCliRef.current = drillCli;
  useEffect(
    () => () => {
      const pending = accountsForRef.current;
      if (pending) usePanePickerStore.getState().requestOpen(pending);
    },
    [],
  );

  // Fechar o menu encerra drill e contas: reabrir depois começa no índice,
  // e o desmonte só restaura contexto de quem NÃO fechou de propósito.
  useEffect(() => {
    if (!open) {
      setAccountsFor(null);
      setDrillCli(null);
    }
  }, [open]);

  // Estado limpo a cada abertura: uma linha por CLI se navega com os olhos.
  // Aba de missão começa no passo de destino — "Nesta missão" já é o padrão
  // sob o cursor, mas a escolha é explícita (solto/participante não é igual).
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    setDrillCli(null);
    setDestination(null);
    setExpandedFolds(new Set());
  }, [open]);

  // O foco vive na busca sempre que a lista está na frente — índice e drill
  // compartilham a mesma linha de busca (a busca vê tudo, de qualquer nível).
  //
  // `drillCli` entra nas deps porque o keydown mora no painel: ao entrar/sair
  // do drill com o MOUSE o botão clicado é desmontado no mesmo commit e o foco
  // cai no <body> — a lista continuava pintada como armada e as setas/Enter
  // ficavam mortos até alguém clicar de novo na busca.
  useEffect(() => {
    if (open && !accountsFor) inputRef.current?.focus();
  }, [open, accountsFor, drillCli]);

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
      // Escape sobe UM nível: de contas para a matriz da CLI, dela para o
      // índice, do índice para fora.
      if (accountsForRef.current) stepUp();
      else if (drillCliRef.current) setDrillCli(null);
      else closeToTrigger();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, closeToTrigger, stepUp]);

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
    if (isCliIndexAction(row)) {
      // Drill-in: a matriz conta × modelo daquela CLI ocupa o painel.
      setDrillCli(row.drillCli);
      setCursor(0);
      return;
    }
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
    const intent = row.intent;
    // Passo de confirmação: só quando o operador DIGITOU um pedido. Sem
    // pedido não há o que classificar, e o "+ Pane" abre na hora, como
    // sempre abriu — o caminho rápido não ganha fricção.
    if (intent.kind === 'agent' && request.trim()) {
      beginConfirm(intent, row);
      return;
    }
    commitIntent(intent);
  };

  const beginConfirm = (
    intent: Extract<PanePickerIntent, { kind: 'agent' }>,
    row: PanePickerEntry,
  ) => {
    setConfirming({ intent, label: row.group || row.adapterId || 'CLI' });
    setRouteState({ kind: 'loading' });
    setChosenEffort(undefined);
    // Fail-open em TODO desfecho: sem chave, superfície desligada ou erro, o
    // passo some e o operador abre do mesmo jeito. O Jev nunca pode impedir
    // alguém de abrir um pane.
    void window.nexus.jev
      .paneRoute({ request: request.trim(), adapterId: intent.adapterId })
      .then((result) => {
        if (!result.ok) {
          setRouteState({ kind: 'none' });
          return;
        }
        setRouteState({ kind: 'ready', proposal: result.proposal });
        setChosenEffort(result.proposal.effort);
      })
      .catch(() => setRouteState({ kind: 'none' }));
  };

  const commitIntent = (intent: PanePickerIntent) => {
    setOpen(false);
    setConfirming(null);
    setRequest('');
    // F-231: dentro de uma aba de missão o destino foi escolhido no passo
    // anterior. Shell/browser nunca são participantes — "Nesta missão" cai
    // para "solto" neles. Fora de missão `destination` é null e nada muda.
    const picked: PanePickerDestination | null =
      destinationOptions && intent.kind === 'agent'
        ? destination
        : destination === 'newTab'
          ? 'newTab'
          : destination !== null
            ? 'loose'
            : null;
    if (picked === 'mission' && missionDestination) {
      // Mesmo portão do caminho normal: sem acesso não nasce pane nenhum.
      if (!allowPaneCreation()) return;
      void window.nexus.orch
        .spawnOperatorPane({
          missionId: missionDestination.missionId,
          adapterId: intent.kind === 'agent' ? intent.adapterId : '',
          ...(intent.kind === 'agent' && intent.model
            ? { model: intent.model }
            : {}),
          ...(intent.kind === 'agent' && intent.accountId
            ? { accountId: intent.accountId }
            : {}),
        })
        .then((result) => {
          if (result.ok) {
            // Main presents the sealed pane in its mission. This id
            // may not be mounted yet; the loose-pane callback would pin it early.
            return;
          }
          useToastStore.getState().push(
            'error',
            'O pane não entrou na missão',
            {
              detail:
                OPERATOR_PANE_SPAWN_ERROR[result.error] ?? result.error,
              dedupeKey: `f231:${missionDestination.missionId}`,
            },
          );
        })
        // F-1294: handler do Main que lança (ex. worktree da aba sumida) volta
        // como invoke cru rejeitado — mesmo toast do {ok:false}, nunca
        // unhandled rejection.
        .catch((err: unknown) => {
          useToastStore.getState().push(
            'error',
            'O pane não entrou na missão',
            {
              detail:
                err instanceof Error ? err.message : 'falha ao abrir o pane',
              dedupeKey: `f231:${missionDestination.missionId}`,
            },
          );
        });
      return;
    }
    const paneId = runPanePickerIntent(intent);
    if (!paneId) return;
    if (picked === 'newTab') {
      (onPaneCreatedInNewTab ?? onPaneCreated)?.(paneId);
    } else if (picked === 'loose') {
      (onPaneCreatedLoose ?? onPaneCreated)?.(paneId);
    } else {
      onPaneCreated?.(paneId);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // F-231: no passo de destino as setas/Enter escolhem ONDE abrir; o cursor
    // da lista de CLIs só existe depois dessa escolha.
    if (destinationPending && destinationOptions) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((current) =>
          Math.min(current + 1, destinationOptions.length - 1),
        );
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((current) => Math.max(current - 1, 0));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const option = destinationOptions[cursor] ?? destinationOptions[0]!;
        setDestination(option.id);
        setCursor(0);
      }
      return;
    }
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
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      // ←/→ são de edição quando há texto no campo; com a busca vazia eles
      // viram navegação de nível (→ entra na CLI, ← volta ao índice).
      const target = event.target as HTMLInputElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable) &&
        target.value !== ''
      ) {
        return;
      }
      event.preventDefault();
      if (event.key === 'ArrowRight') {
        // → em linha de índice abre a matriz da CLI; nas demais, não faz nada.
        const row = filtered[cursor];
        if (row && isCliIndexAction(row)) runRow(row);
      } else if (drillCli) {
        // ← sobe um nível quando o drill está aberto.
        setDrillCli(null);
        setCursor(0);
      }
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
    <div
      className={`pane-picker${placement === 'tabbar' ? ' pane-picker--tabbar' : ''}`}
      ref={rootRef}
    >
      {open && (
        <div
          className="pane-picker__panel"
          data-view={accountsFor ? 'accounts' : drillCli ? 'cli' : 'list'}
          role="dialog"
          aria-label={
            accountsFor
              ? `Contas de ${accountsForLabel}`
              : drillCli
                ? `Modelos de ${drillLabel}`
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
                  onClick={stepUp}
                >
                  <PixelIcon name="chevron" size={12} />
                  Voltar
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
          ) : destinationPending && destinationOptions ? (
            <>
              <div className="pane-picker__head">
                <PixelIcon name="search" size={12} />
                <span className="pane-picker__head-title">Onde abrir o pane</span>
                <kbd className="pane-picker__esc">esc</kbd>
              </div>
              <ul
                className="pane-picker__list"
                id="pane-picker-list"
                role="listbox"
                aria-label="Destino do pane"
                ref={listRef}
              >
                {destinationOptions.map((option, index) => (
                  <li key={option.id} role="presentation">
                    {index === 0 && (
                      <div className="pane-picker__section" aria-hidden="true">
                        Destino
                      </div>
                    )}
                    <button
                      type="button"
                      role="option"
                      id={`pane-picker-opt-${index}`}
                      aria-selected={index === cursor}
                      data-active={index === cursor}
                      data-testid={`pane-picker-destination-${option.id}`}
                      className="pane-picker__item"
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => {
                        setDestination(option.id);
                        setCursor(0);
                      }}
                    >
                      <PixelIcon name={option.icon} size={12} />
                      <span className="pane-picker__item-label">
                        {option.label}
                      </span>
                      <span className="pane-picker__item-detail">
                        {option.detail}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <div
                // Durante o passo de confirmação o cabeçalho de busca sai de
                // cena: o filtro não serve mais ali, e o "Voltar" do drill-in
                // duelaria com o "Voltar" do passo — dois botões iguais, dois
                // destinos diferentes.
                hidden={confirming !== null}
                className={`pane-picker__head${drillCli ? ' pane-picker__head--back' : ''}`}
              >
                {drillCli ? (
                  <button
                    type="button"
                    className="pane-picker__back"
                    data-testid="pane-picker-cli-back"
                    onClick={() => {
                      setDrillCli(null);
                      setCursor(0);
                    }}
                  >
                    <PixelIcon name="chevron" size={12} />
                    Voltar
                  </button>
                ) : (
                  <PixelIcon name="search" size={12} />
                )}
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
                  placeholder={
                    drillCli
                      ? `${drillLabel} — busca continua vendo tudo`
                      : 'CLI, conta ou modelo…'
                  }
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setCursor(0);
                  }}
                />
                {drillCli ? (
                  <ProviderLogo
                    adapterId={drillCli}
                    label={drillLabel}
                    size="xs"
                  />
                ) : (
                  <kbd className="pane-picker__esc">esc</kbd>
                )}
              </div>

              {confirming ? (
                <PaneRouteConfirm
                  state={routeState}
                  adapterLabel={confirming.label}
                  effort={chosenEffort}
                  onEffortChange={setChosenEffort}
                  onConfirm={() => {
                    const intent = confirming.intent;
                    setConfirming(null);
                    commitIntent(
                      intent.kind === 'agent'
                        ? {
                            ...intent,
                            ...(chosenEffort ? { effort: chosenEffort } : {}),
                            brief: request.trim(),
                          }
                        : intent,
                    );
                  }}
                  onCancel={() => setConfirming(null)}
                />
              ) : (
                <label className="pane-picker__request">
                  <span className="pane-picker__request-label">O que você quer feito</span>
                  <input
                    className="pane-picker__request-input"
                    type="text"
                    data-testid="pane-picker-request"
                    placeholder="opcional — ex.: arruma o login quebrado"
                    value={request}
                    onChange={(event) => setRequest(event.target.value)}
                  />
                </label>
              )}

              <ul
                hidden={confirming !== null}
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
                  // No drill o cabeçalho já nomeia a CLI — sem repetir seção
                  // nem grupo. Conta continua: é ela que separa os blocos.
                  const inDrill = drillCli !== null && !query.trim();
                  const showSection = !inDrill && row.section !== lastSection;
                  const showGroup =
                    !inDrill && row.group !== '' && row.group !== lastGroup;
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
                  const cliRow = isCliIndexAction(row);
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
                            : cliRow
                              ? `Abrir modelos de ${row.label}`
                              : undefined
                        }
                        data-active={index === cursor}
                        data-admin={admin || undefined}
                        data-cli={cliRow || undefined}
                        data-fold={fold || undefined}
                        data-model={heading ? true : undefined}
                        data-fresh={isFresh || undefined}
                        data-testid={`pane-picker-entry-${row.id}`}
                        className="pane-picker__item"
                        title={heading ? row.label : undefined}
                        onMouseEnter={() => setCursor(index)}
                        onClick={() => runRow(row)}
                      >
                        {cliRow ? (
                          <ProviderLogo
                            adapterId={row.adapterId}
                            label={row.label}
                            size="xs"
                          />
                        ) : (
                          <PixelIcon name={row.icon} size={12} />
                        )}
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
                            {!cliRow && <span aria-hidden="true">›</span>}
                            {row.detail}
                          </span>
                        ) : null}
                        {cliRow && (
                          <PixelIcon
                            name="arrow-right"
                            size={12}
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>

              {!hasCli && !drillCli && (
                <p className="pane-picker__hint">
                  Nenhuma CLI detectada — instale uma em {AI_ACCOUNTS_SETTINGS_PATH}.
                </p>
              )}

              {unavailable.length > 0 && !drillCli && !query.trim() && (
                <div
                  className="pane-picker__unavailable"
                  role="group"
                  aria-labelledby="pane-picker-unavailable-title"
                  // Região de rolagem focável: teclado alcança o que a altura
                  // capada corta (tabIndex + setas rolam; sem isso o conteúdo
                  // além da dobra fica inatingível).
                  tabIndex={0}
                >
                  <div
                    id="pane-picker-unavailable-title"
                    className="pane-picker__section"
                  >
                    {`Indisponíveis · ${unavailable.length}`}
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
        aria-label={trigger?.ariaLabel}
        data-testid={
          placement === 'tabbar' ? 'tab-picker-trigger' : 'pane-picker-trigger'
        }
        title={
          trigger?.title ??
          'Abrir um pane novo: terminal, browser ou uma CLI numa conta e modelo exatos'
        }
        onClick={() => { if (allowPaneCreation()) setOpen((current) => !current); }}
      >
        <PixelIcon name="plus" size={12} />
        {trigger ? (
          trigger.label ? <span>{trigger.label}</span> : null
        ) : (
          <span>Pane</span>
        )}
      </button>
    </div>
  );
}

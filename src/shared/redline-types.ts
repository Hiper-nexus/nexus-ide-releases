/**
 * Formato do arquivo que o Nexus publica para o app companheiro de menu bar
 * (Nexus Redline) — `~/.nexus/redline-last-good.json`.
 *
 * Contrato de privacidade: NUNCA carrega token, key ou email inteiro —
 * email vai sempre mascarado (`gu****@g**.com`). O arquivo é o único canal
 * Nexus → companheiro; o companheiro é read-only sobre ele.
 *
 * Distinto de QuotaFleetSnapshot (IPC interno renderer): este formato é
 * estável entre versões (formatVersion) e auto-suficiente para um processo
 * fora do Electron decidir exibição e recomendação.
 */

import {
  compareEntriesByConsumption,
  peakUsedRatio,
  type QuotaWindowKind,
} from './quota-types';

export const REDLINE_SNAPSHOT_FORMAT_VERSION = 1;
export const REDLINE_SNAPSHOT_FILENAME = 'redline-last-good.json';
/** Arquivo-sinal escrito pelo companheiro pedindo refresh ao Nexus. */
export const REDLINE_REFRESH_FILENAME = 'redline-refresh.request';

/** IPC renderer → main para a superfície do companheiro em Uso e cotas. */
export const REDLINE_IPC = {
  status: 'redline:status',
  install: 'redline:install',
  open: 'redline:open',
} as const;

/** Janela de uso achatada para consumo externo. */
export interface RedlineWindow {
  kind: QuotaWindowKind;
  label: string;
  /** Fração usada 0..1. null = desconhecida (UI NÃO deve mostrar 0%). */
  usedRatio: number | null;
  /** Epoch ms do reset, quando conhecido. */
  resetsAt?: number;
}

/** Janela decisiva: a que estoura primeiro já com o crédito de reset. */
export interface RedlineDecisiveWindow {
  label: string;
  /** Fração usada efetiva (0..1) após o crédito de proximidade de reset. */
  effectiveUsedRatio: number;
  resetsAt?: number;
}

export interface RedlineEntry {
  /** Estável: `adapterId` ou `adapterId:accountId` (igual ProviderQuotaEntry.id). */
  id: string;
  adapterId: string;
  accountId?: string;
  label: string;
  emailMasked?: string;
  /** Conta ativa do adapter. */
  active: boolean;
  installed: boolean;
  onCooldown: boolean;
  cooldownUntil?: number;
  windows: RedlineWindow[];
  /** Epoch ms da última observação (provider-api ou heurística). */
  updatedAt: number;
  /**
   * false = fora da disputa (sem credencial, relogin pendente, cooldown ativo
   * ou nenhuma janela conhecida). Motivo em `excludedReason`.
   */
  eligible: boolean;
  excludedReason?:
    | 'no-credential'
    | 'needs-relogin'
    | 'cooldown'
    | 'unknown-usage';
  /** Folga efetiva 0..1 (1 = vazia). Presente só quando eligible. */
  headroom?: number;
  decisiveWindow?: RedlineDecisiveWindow;
}

/** Linha do ranking por adapter (já ordenada, melhor primeiro). */
export interface RedlineRankingRow {
  entryId: string;
  adapterId: string;
  label: string;
  emailMasked?: string;
  headroom: number;
  decisiveWindow?: RedlineDecisiveWindow;
  /** Minutos restantes para a janela decisiva resetar, arredondados. */
  minutesToReset?: number;
}

export interface RedlineSnapshotFile {
  formatVersion: typeof REDLINE_SNAPSHOT_FORMAT_VERSION;
  generatedBy: 'nexus';
  updatedAt: number;
  worstUsedRatio: number | null;
  entries: RedlineEntry[];
  /** adapterId → ranking (scorer determinístico; Jev refina on-demand via MCP). */
  ranking: Record<string, RedlineRankingRow[]>;
  /**
   * Contas que cabem na faixa da barra (só usedRatio conhecido, teto 6,
   * as de maior consumo primeiro). O painel lista `entries` inteiro.
   */
  statusBarEntryIds: string[];
}

/** Quantas contas com leitura cabem na faixa sem o macOS esconder o extra. */
export const REDLINE_STATUS_BAR_MAX = 6;

/** Ids das contas com leitura, as mais gastas primeiro (teto 6). */
export function selectRedlineStatusBarEntryIds(
  entries: readonly RedlineEntry[],
): string[] {
  return [...entries]
    .filter((entry) => peakUsedRatio(entry.windows) != null)
    .sort(compareEntriesByConsumption)
    .slice(0, REDLINE_STATUS_BAR_MAX)
    .map((entry) => entry.id);
}

/**
 * Máscara estilo Redline: `gustavo@x.com` → `gu****@x**.com`.
 * Local mantém 2 primeiros chars; domínio mantém 1º char + TLD.
 */
export function maskEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  const domainHead = dot > 0 ? domain.slice(0, dot) : domain;
  return `${local.slice(0, 2)}****@${domainHead.slice(0, 1)}**${tld}`;
}

/** Estado do companheiro para a seção Uso e cotas (renderer). */
export interface RedlineInstallStatus {
  platform: string;
  /** .app embutido no pacote/checkout. */
  bundled: boolean;
  bundledPath?: string;
  /** Cópia em /Applications (onde o login item funciona). */
  installedPath?: string;
  running: boolean;
}

// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: pools ProviderQuotaEntry
// (adapter + fornecedor da cota) em vez de LimitAccount/driver; razões 0..1 em vez de
// percentuais; leitura desconhecida (usedRatio null, identity-mismatch) vira coluna
// vazia e nunca entra na soma; janela só soma com mesma kind + rótulo; sem pace
// (o contrato do Nexus não traz duração da janela) e sem créditos de reset.

/**
 * Folga conjunta por ferramenta: as contas da mesma CLI que leem a cota do
 * mesmo fornecedor, somadas janela a janela. Responde "dá para continuar?"
 * antes de "em qual conta?". Puro — só apresenta; nunca decide conta.
 */

import {
  collapseSharedQuotaEntries,
  type ProviderQuotaEntry,
  type QuotaWindow,
  type QuotaWindowKind,
} from '../../shared/quota-types';
import { windowDisplay } from './quota-display';

export interface QuotaPoolMember {
  readonly entry: ProviderQuotaEntry;
  readonly window: QuotaWindow;
  /** Fração usada 0..1, já validada (nunca null aqui). */
  readonly usedRatio: number;
}

/**
 * Uma conta numa linha do conjunto. `member` null = a conta não informa esta
 * janela (ou a leitura é desconhecida): a coluna fica vazia, nunca vira 0%.
 */
export interface QuotaPoolColumn {
  readonly entry: ProviderQuotaEntry;
  readonly member: QuotaPoolMember | null;
}

export interface QuotaPoolReset {
  readonly member: QuotaPoolMember;
  readonly at: number;
  /** Fração do conjunto que a renovação devolve: uso da conta ÷ contas com leitura. */
  readonly restoresRatio: number;
}

/**
 * Uma janela (kind + rótulo) em todas as contas que a informam: a fração que
 * resta no conjunto e as renovações na ordem em que chegam, cada uma com a
 * parcela do conjunto que devolve.
 */
export interface QuotaPoolWindow {
  readonly key: string;
  readonly kind: QuotaWindowKind;
  readonly label: string;
  /** Contas com leitura conhecida desta janela — só elas entram na soma. */
  readonly members: readonly QuotaPoolMember[];
  /** Posições fixas por conta, iguais em todas as linhas do conjunto. */
  readonly columns: readonly QuotaPoolColumn[];
  readonly usedRatio: number;
  readonly remainingRatio: number;
  readonly resets: readonly QuotaPoolReset[];
}

export interface QuotaPool {
  readonly key: string;
  readonly adapterId: string;
  /** Fornecedor da cota quando difere do dono da linha (ex.: Claude lendo GLM). */
  readonly usageProviderId?: string;
  readonly entries: readonly ProviderQuotaEntry[];
  readonly windows: readonly QuotaPoolWindow[];
}

const WINDOW_KIND_ORDER: Record<QuotaWindowKind, number> = {
  session: 0,
  hours: 1,
  weekly: 2,
  monthly: 3,
  credits: 4,
  local: 5,
};

/** Contagem local de tokens não é limite de conta: nunca entra no conjunto. */
function poolable(window: QuotaWindow): boolean {
  return window.kind !== 'local' && window.source !== 'local-tokens';
}

/** Mesma janela e mesma unidade: kind + rótulo normalizado. */
function windowKey(window: QuotaWindow): string {
  return `${window.kind}:${window.label.trim().toLocaleLowerCase('pt-BR')}`;
}

/** Fração usada só quando a leitura é válida; desconhecido segue null. */
function knownUsedRatio(entry: ProviderQuotaEntry, window: QuotaWindow): number | null {
  // A credencial provou ser de outra conta: a cota não é desta linha.
  if (entry.readHint === 'identity-mismatch') return null;
  const display = windowDisplay(window);
  return display.tone === 'unknown' ? null : display.barRatio;
}

function resetMillis(window: QuotaWindow | undefined): number | null {
  const at = window?.resetsAt;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

function poolKey(entry: ProviderQuotaEntry): string {
  return `${entry.adapterId}>${entry.usageProviderId ?? entry.adapterId}`;
}

/**
 * Contas agrupadas por adapter + fornecedor da cota, cada janela somada por
 * kind + rótulo. A kind faz parte da chave porque "5 Horas" e "Mensal" não
 * se misturam numa média só; o rótulo separa créditos de planos distintos.
 *
 * Colunas seguem a renovação da primeira janela por kind (sessão antes de
 * horas, semanal, mensal), a mais próxima primeiro; sem reset vai para o fim,
 * com rótulo e id desempatando. Cada janela ordena as próprias renovações.
 *
 * Só monta conjunto com ao menos `minAccounts` contas e uma leitura conhecida.
 */
export function collectQuotaPools(
  entries: readonly ProviderQuotaEntry[],
  now: number,
  options: { minAccounts?: number } = {},
): QuotaPool[] {
  const minAccounts = options.minAccounts ?? 2;
  const byPool = new Map<string, ProviderQuotaEntry[]>();
  const seen = new Set<string>();
  // F-720: a mesma credencial é uma cota só — conta uma vez.
  for (const entry of collapseSharedQuotaEntries(entries)) {
    if (seen.has(entry.id) || !entry.windows.some(poolable)) continue;
    seen.add(entry.id);
    const key = poolKey(entry);
    const list = byPool.get(key);
    if (list) list.push(entry);
    else byPool.set(key, [entry]);
  }
  const pools: QuotaPool[] = [];
  for (const [key, members] of byPool) {
    if (members.length < minAccounts) continue;
    const orderWindow = members
      .flatMap((entry) => entry.windows.filter(poolable))
      .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
    const orderKey = orderWindow ? windowKey(orderWindow) : '';
    const orderReset = (entry: ProviderQuotaEntry) =>
      resetMillis(entry.windows.find((window) => poolable(window) && windowKey(window) === orderKey)) ??
      Number.POSITIVE_INFINITY;
    const sorted = [...members].sort(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        left.label.localeCompare(right.label, 'pt') ||
        left.id.localeCompare(right.id),
    );
    const windows = poolWindows(sorted, now);
    if (windows.length === 0) continue;
    const first = sorted[0]!;
    pools.push({
      key,
      adapterId: first.adapterId,
      ...(first.usageProviderId ? { usageProviderId: first.usageProviderId } : {}),
      entries: sorted,
      windows,
    });
  }
  return pools;
}

function poolWindows(entries: readonly ProviderQuotaEntry[], now: number): QuotaPoolWindow[] {
  const byKey = new Map<string, { window: QuotaWindow; members: QuotaPoolMember[] }>();
  for (const entry of entries) {
    const keysOfEntry = new Set<string>();
    for (const window of entry.windows) {
      if (!poolable(window)) continue;
      const key = windowKey(window);
      // Duas janelas iguais na mesma conta: vale a primeira, como no cartão.
      if (keysOfEntry.has(key)) continue;
      keysOfEntry.add(key);
      const row = byKey.get(key) ?? { window, members: [] };
      byKey.set(key, row);
      const usedRatio = knownUsedRatio(entry, window);
      if (usedRatio !== null) row.members.push({ entry, window, usedRatio });
    }
  }
  const pools: QuotaPoolWindow[] = [];
  for (const [key, { window: first, members }] of byKey) {
    // Ninguém com leitura: a linha nada diz sobre o conjunto (o cartão já diz "Não informado").
    if (members.length === 0) continue;
    const memberByEntry = new Map(members.map((member) => [member.entry.id, member]));
    const usedRatio = members.reduce((sum, member) => sum + member.usedRatio, 0) / members.length;
    const resets = members
      .flatMap((member) => {
        const at = resetMillis(member.window);
        // Renovação já passada é leitura velha, não parcela que vai voltar.
        return at === null || at <= now
          ? []
          : [{ member, at, restoresRatio: member.usedRatio / members.length }];
      })
      .sort((left, right) => left.at - right.at);
    pools.push({
      key,
      kind: first.kind,
      label: first.label,
      members,
      columns: entries.map((entry) => ({ entry, member: memberByEntry.get(entry.id) ?? null })),
      usedRatio,
      remainingRatio: 1 - usedRatio,
      resets,
    });
  }
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

/** A renovação mais próxima que devolve algo; conta intocada renova sem efeito. */
export function nextPoolRefill(window: QuotaPoolWindow): QuotaPoolReset | null {
  return window.resets.find((reset) => reset.restoresRatio > 0) ?? null;
}

/**
 * Nome da ferramenta e da conta a partir do rótulo da linha
 * (`Ferramenta · Conta`, `Ferramenta · CLI nativo` ou só `Ferramenta`).
 * A conta continua identificada pelo id da linha; o nome é só texto.
 */
export function poolToolLabel(pool: QuotaPool): string {
  const first = pool.entries[0];
  return first ? (first.label.split(' · ')[0] ?? first.label).trim() || pool.adapterId : pool.adapterId;
}

export function poolAccountLabel(entry: ProviderQuotaEntry): string {
  if (!entry.accountId) return 'Conexão atual';
  const separator = entry.label.indexOf(' · ');
  const name = separator >= 0 ? entry.label.slice(separator + 3) : entry.label;
  return name.trim() || entry.label;
}

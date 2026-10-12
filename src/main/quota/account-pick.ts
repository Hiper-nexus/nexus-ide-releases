/**
 * Escolha de conta: scorer determinístico sobre o último snapshot.
 * Jev NÃO escolhe conta — comparar cota medida é aritmética (AGENTS.md).
 * Resposta só com ids opacos e números; label/email nunca cruzam esta
 * fronteira (mesma regra do nexus_quota_status).
 */

import { listAccountInfos } from '../persistence/account-store';
import type { QuotaFleetSnapshot } from '../../shared/quota-types';
import type { RedlineEntry, RedlineRankingRow } from '../../shared/redline-types';
import { scoreFleet } from './smart-pick';

export interface AccountPickRow {
  entryId: string;
  adapterId: string;
  accountId?: string;
  /** `account` = vault account; `cli` = login nativo da CLI. */
  kind: 'account' | 'cli';
  /** Folga efetiva 0..100. */
  headroomPct: number;
  decisiveWindow?: {
    label: string;
    usedPct: number;
    resetsAt?: number;
  };
  minutesToReset?: number;
}

export interface AccountPickExcluded {
  entryId: string;
  adapterId: string;
  accountId?: string;
  /** `account` = vault account; `cli` = login nativo da CLI. */
  kind: 'account' | 'cli';
  excludedReason: NonNullable<RedlineEntry['excludedReason']>;
}

export interface AccountPickAnswer {
  available: boolean;
  reason?: string;
  adapterId?: string;
  pick?: AccountPickRow;
  alternatives: AccountPickRow[];
  /**
   * F-1292: fora da disputa, COM o motivo (só ids opacos — nunca rótulo ou
   * e-mail). Sem isso a conta em `unknown-usage`/cooldown sumia e o
   * orquestrador não via o plano B.
   */
  excluded: AccountPickExcluded[];
  decidedBy: 'scorer' | 'unavailable';
  /** Idade da leitura: now − snapshot.updatedAt. */
  readingAgeMs?: number;
}

export interface ComputeAccountPickOptions {
  /** Omitido → melhor conta da frota inteira. */
  adapterId?: string;
  sessionId?: string;
  missionId?: string;
  signal?: AbortSignal;
}

function entryKind(adapterId: string, entryId: string): 'account' | 'cli' {
  const prefix = `${adapterId}:`;
  return entryId.startsWith(prefix) && entryId.length > prefix.length
    ? 'account'
    : 'cli';
}

function toExcluded(
  entry: RedlineEntry & { excludedReason: NonNullable<RedlineEntry['excludedReason']> },
): AccountPickExcluded {
  const kind = entryKind(entry.adapterId, entry.id);
  return {
    entryId: entry.id,
    adapterId: entry.adapterId,
    ...(kind === 'account'
      ? { accountId: entry.id.slice(entry.adapterId.length + 1) }
      : {}),
    kind,
    excludedReason: entry.excludedReason,
  };
}

function toRow(row: RedlineRankingRow): AccountPickRow {
  const kind = entryKind(row.adapterId, row.entryId);
  const isAccount = kind === 'account';
  return {
    entryId: row.entryId,
    adapterId: row.adapterId,
    ...(isAccount ? { accountId: row.entryId.slice(row.adapterId.length + 1) } : {}),
    kind,
    headroomPct: Math.round(row.headroom * 100),
    ...(row.decisiveWindow
      ? {
          decisiveWindow: {
            label: row.decisiveWindow.label,
            usedPct: Math.round(row.decisiveWindow.effectiveUsedRatio * 100),
            ...(row.decisiveWindow.resetsAt !== undefined
              ? { resetsAt: row.decisiveWindow.resetsAt }
              : {}),
          },
        }
      : {}),
    ...(row.minutesToReset !== undefined
      ? { minutesToReset: row.minutesToReset }
      : {}),
  };
}

export async function computeAccountPick(
  opts: ComputeAccountPickOptions = {},
): Promise<AccountPickAnswer> {
  const now = Date.now();
  let snapshot: QuotaFleetSnapshot | null;
  try {
    const { requireQuotaService } = await import('./quota-service');
    snapshot = requireQuotaService().lastSnapshot();
  } catch (error) {
    return {
      available: false,
      reason: `quota service unavailable: ${(error as Error).message}`,
      alternatives: [],
      excluded: [],
      decidedBy: 'unavailable',
    };
  }
  if (!snapshot) {
    return {
      available: false,
      reason:
        'no quota snapshot yet — it populates once the fleet gauge is read (Settings → Uso e cotas) or the failover path runs',
      alternatives: [],
      excluded: [],
      decidedBy: 'unavailable',
    };
  }

  const accounts = listAccountInfos();
  const { ranking, entries } = scoreFleet(snapshot.entries, accounts, now);

  const requested = opts.adapterId?.trim();
  // F-1292: fora da disputa com o motivo — no escopo pedido (ou na frota).
  const excluded = entries
    .filter(
      (
        entry,
      ): entry is
        RedlineEntry & { excludedReason: NonNullable<RedlineEntry['excludedReason']> } =>
        !entry.eligible &&
        entry.excludedReason !== undefined &&
        (!requested || entry.adapterId === requested),
    )
    .slice(0, 8)
    .map(toExcluded);
  let rows: RedlineRankingRow[];
  let resolvedAdapter: string | undefined;
  if (requested) {
    rows = ranking[requested] ?? [];
    resolvedAdapter = requested;
  } else {
    rows = Object.values(ranking)
      .flat()
      .sort((a, b) => b.headroom - a.headroom);
    resolvedAdapter = rows[0]?.adapterId;
  }
  if (rows.length === 0) {
    return {
      available: true,
      ...(resolvedAdapter ? { adapterId: resolvedAdapter } : {}),
      reason: requested
        ? `no eligible account for ${requested} (all exhausted, on cooldown, or without known usage)`
        : 'no eligible account in the fleet right now',
      alternatives: [],
      excluded,
      decidedBy: 'scorer',
      readingAgeMs: Math.max(0, now - snapshot.updatedAt),
    };
  }

  const winner = rows[0];
  const rest = rows.filter((r) => r.entryId !== winner.entryId);
  return {
    available: true,
    ...(resolvedAdapter ? { adapterId: resolvedAdapter } : {}),
    pick: toRow(winner),
    alternatives: rest.slice(0, 8).map((r) => toRow(r)),
    excluded,
    decidedBy: 'scorer',
    readingAgeMs: Math.max(0, now - snapshot.updatedAt),
  };
}

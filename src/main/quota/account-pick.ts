/**
 * Escolha de conta: scorer determinístico sobre o último snapshot.
 * Jev NÃO escolhe conta — comparar cota medida é aritmética (AGENTS.md).
 * Resposta só com ids opacos e números; label/email nunca cruzam esta
 * fronteira (mesma regra do nexus_quota_status).
 */

import { listAccountInfos } from '../persistence/account-store';
import type { QuotaFleetSnapshot } from '../../shared/quota-types';
import type { RedlineRankingRow } from '../../shared/redline-types';
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

export interface AccountPickAnswer {
  available: boolean;
  reason?: string;
  adapterId?: string;
  pick?: AccountPickRow;
  alternatives: AccountPickRow[];
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

function toRow(row: RedlineRankingRow): AccountPickRow {
  const prefix = `${row.adapterId}:`;
  const isAccount =
    row.entryId.startsWith(prefix) && row.entryId.length > prefix.length;
  return {
    entryId: row.entryId,
    adapterId: row.adapterId,
    ...(isAccount ? { accountId: row.entryId.slice(prefix.length) } : {}),
    kind: isAccount ? 'account' : 'cli',
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
      decidedBy: 'unavailable',
    };
  }
  if (!snapshot) {
    return {
      available: false,
      reason:
        'no quota snapshot yet — it populates once the fleet gauge is read (Settings → Uso e cotas) or the failover path runs',
      alternatives: [],
      decidedBy: 'unavailable',
    };
  }

  const accounts = listAccountInfos();
  const { ranking } = scoreFleet(snapshot.entries, accounts, now);

  const requested = opts.adapterId?.trim();
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
    decidedBy: 'scorer',
    readingAgeMs: Math.max(0, now - snapshot.updatedAt),
  };
}

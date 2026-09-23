/**
 * Motor de escolha de conta — "qual conta tem folga agora?".
 * Scorer determinístico (puro, testável). Jev não entra nesta decisão.
 *
 * Regra da casa: janela desconhecida NUNCA vira folga (nunca inventa
 * usedRatio). Conta sem credencial / com relogin pendente / em cooldown está
 * fora da disputa. Crédito de reset: janela que reseta em ≤60min conta como
 * parcialmente liberada, proporcional ao tempo restante — "quase resetando"
 * compete de volta.
 */

import { maskAccountLabel } from '../../shared/account-choice';
import type { AccountInfo } from '../../shared/account-types';
import type { ProviderQuotaEntry, QuotaWindow } from '../../shared/quota-types';
import {
  maskEmail,
  type RedlineDecisiveWindow,
  type RedlineEntry,
  type RedlineRankingRow,
} from '../../shared/redline-types';
import {
  RESET_PROXIMITY_WINDOW_MS,
  effectiveUsedRatio,
} from '../../shared/quota-headroom';

export { RESET_PROXIMITY_WINDOW_MS, effectiveUsedRatio };

/** Mascara só o e-mail embutido no rótulo da frota; o resto fica legível. */
export function maskFleetLabel(label: string): string {
  const match = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(label);
  if (!match) return label;
  return label.replace(match[0], maskAccountLabel(match[0]));
}

export interface ScoredFleet {
  /** Entries decoradas (todas, inclusive inelegíveis — o menu mostra estado). */
  entries: RedlineEntry[];
  /** adapterId → elegíveis ordenadas (melhor primeiro). */
  ranking: Record<string, RedlineRankingRow[]>;
}

function exclusionReason(
  entry: ProviderQuotaEntry,
  account: AccountInfo | undefined,
): RedlineEntry['excludedReason'] {
  if (account && !account.hasCredential) return 'no-credential';
  if (account?.needsRelogin) return 'needs-relogin';
  // Linha nativa (sem accountId) não tem AccountInfo — o readHint é o
  // único portador do motivo (sessão expirada, CLI ausente, etc.).
  if (entry.readHint === 'auth-expired' || entry.readHint === 'identity-mismatch') return 'needs-relogin';
  if (entry.readHint === 'no-credential') return 'no-credential';
  if (entry.onCooldown) return 'cooldown';
  const known = entry.windows.some(
    (w) => w.usedRatio !== null && w.usedRatio !== undefined,
  );
  if (!known) return 'unknown-usage';
  return undefined;
}

function decisiveOf(
  windows: ReadonlyArray<QuotaWindow>,
  now: number,
): { window: RedlineDecisiveWindow; headroom: number } | null {
  let worst: RedlineDecisiveWindow | null = null;
  for (const w of windows) {
    const eff = effectiveUsedRatio(w, now);
    if (eff === null) continue;
    if (!worst || eff > worst.effectiveUsedRatio) {
      worst = {
        label: w.label,
        effectiveUsedRatio: eff,
        ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}),
      };
    }
  }
  return worst
    ? { window: worst, headroom: Math.max(0, 1 - worst.effectiveUsedRatio) }
    : null;
}

/**
 * Pontua a frota inteira: decora cada entry (elegibilidade, folga, janela
 * decisiva) e monta o ranking por adapter. Puro — sem I/O, sem Jev.
 */
export function scoreFleet(
  entries: ReadonlyArray<ProviderQuotaEntry>,
  accounts: ReadonlyArray<AccountInfo>,
  now: number,
): ScoredFleet {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const decorated: RedlineEntry[] = entries.map((entry) => {
    const account = entry.accountId
      ? accountById.get(entry.accountId)
      : undefined;
    const reason = exclusionReason(entry, account);
    const decisive = reason ? null : decisiveOf(entry.windows, now);
    const eligible = decisive !== null;
    return {
      id: entry.id,
      adapterId: entry.adapterId,
      ...(entry.accountId ? { accountId: entry.accountId } : {}),
      label: maskFleetLabel(entry.label),
      ...(maskEmail(account?.email) ? { emailMasked: maskEmail(account?.email) } : {}),
      active: entry.active === true,
      installed: entry.installed,
      onCooldown: entry.onCooldown,
      ...(entry.cooldownUntil !== undefined
        ? { cooldownUntil: entry.cooldownUntil }
        : {}),
      windows: entry.windows.map((w) => ({
        kind: w.kind,
        label: w.label,
        usedRatio: entry.readHint === 'identity-mismatch' ? null : w.usedRatio,
        ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}),
      })),
      updatedAt: entry.updatedAt,
      eligible,
      ...(reason ? { excludedReason: reason } : {}),
      ...(decisive
        ? {
            headroom: decisive.headroom,
            decisiveWindow: decisive.window,
          }
        : {}),
    };
  });

  const eligibleByAdapter: Record<string, RedlineEntry[]> = {};
  for (const entry of decorated) {
    if (!entry.eligible || entry.headroom === undefined) continue;
    (eligibleByAdapter[entry.adapterId] ??= []).push(entry);
  }
  const ranking: Record<string, RedlineRankingRow[]> = {};
  for (const [adapterId, ranked] of Object.entries(eligibleByAdapter)) {
    ranked.sort(
      (a, b) =>
        b.headroom! - a.headroom! ||
        Number(b.active) - Number(a.active) ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id, 'pt'),
    );
    ranking[adapterId] = ranked.map((entry) => {
      const row: RedlineRankingRow = {
        entryId: entry.id,
        adapterId: entry.adapterId,
        label: maskFleetLabel(entry.label),
        ...(entry.emailMasked ? { emailMasked: entry.emailMasked } : {}),
        headroom: entry.headroom!,
        ...(entry.decisiveWindow
          ? { decisiveWindow: entry.decisiveWindow }
          : {}),
        ...(entry.decisiveWindow?.resetsAt !== undefined
          ? {
              minutesToReset: Math.max(
                0,
                Math.round((entry.decisiveWindow.resetsAt - now) / 60_000),
              ),
            }
          : {}),
      };
      return row;
    });
  }
  return { entries: decorated, ranking };
}

export interface PickResult {
  pick: RedlineRankingRow;
  /** Plano B: resto do ranking (sem o pick). */
  alternatives: RedlineRankingRow[];
}

/**
 * Escolha para um adapter a partir do ranking já calculado.
 * Desempate do scorer já aplicado em scoreFleet: folga efetiva desc,
 * depois ordem estável por id (determinístico).
 */
export function pickForAdapter(
  ranking: Record<string, RedlineRankingRow[]>,
  adapterId: string,
): PickResult | null {
  const rows = ranking[adapterId];
  if (!rows || rows.length === 0) return null;
  const [pick, ...alternatives] = rows;
  return { pick, alternatives };
}

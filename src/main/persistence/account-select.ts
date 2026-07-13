import type { Account } from '../../shared/account-types';

/**
 * Pure failover selection: from the accounts of one adapter, choose the next
 * usable one — skip the exhausted account and anything still on cooldown.
 * Prefer active when eligible; else freer cota (optional scores); else earliest.
 * No I/O — unit tested in isolation.
 */
export function chooseAccount(
  accounts: Account[],
  activeId: string | null,
  excludeId: string | null,
  now: number,
  quotaScoreByAccountId?: ReadonlyMap<string, number>,
): Account | null {
  const candidates = accounts
    .filter(
      (a) => a.id !== excludeId && (!a.cooldownUntil || a.cooldownUntil <= now),
    )
    .sort((a, b) => {
      if (quotaScoreByAccountId) {
        const sa = quotaScoreByAccountId.get(a.id) ?? 0.55;
        const sb = quotaScoreByAccountId.get(b.id) ?? 0.55;
        if (sb !== sa) return sb - sa;
      }
      return a.createdAt - b.createdAt;
    });
  if (candidates.length === 0) return null;
  // Active still preferred when eligible (operator intent), even if slightly higher usage.
  return (
    candidates.find((a) => a.id === activeId && a.id !== excludeId) ??
    candidates[0]
  );
}

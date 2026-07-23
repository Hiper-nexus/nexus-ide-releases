import type { Account } from '../../shared/account-types';

/**
 * Pure failover selection: from the accounts of one adapter, choose the next
 * usable one — skip the exhausted account and anything still on cooldown.
 * Preserve explicit active-account intent while quota is unknown. When the
 * active account and a sibling both have measured availability, the freer
 * account wins; failover without an active account prefers measured quota.
 * No I/O — unit tested in isolation.
 */
export function chooseAccount(
  accounts: Account[],
  activeId: string | null,
  excludeId: string | null,
  now: number,
  quotaScoreByAccountId?: ReadonlyMap<string, number>,
): Account | null {
  const candidates = accounts.filter(
    (a) => a.id !== excludeId && (!a.cooldownUntil || a.cooldownUntil <= now),
  );
  if (candidates.length === 0) return null;
  const active = candidates.find((a) => a.id === activeId) ?? null;
  const measured = candidates
    .map((account) => ({
      account,
      score: quotaScoreByAccountId?.get(account.id),
    }))
    .filter(
      (entry): entry is { account: Account; score: number } =>
        typeof entry.score === 'number' && Number.isFinite(entry.score),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.account.createdAt - right.account.createdAt,
    );

  if (active) {
    const activeScore = quotaScoreByAccountId?.get(active.id);
    if (typeof activeScore === 'number' && Number.isFinite(activeScore)) {
      const freer = measured[0];
      if (freer && freer.score > activeScore) return freer.account;
    }
    return active;
  }
  return (
    measured[0]?.account ??
    [...candidates].sort((a, b) => a.createdAt - b.createdAt)[0]
  );
}

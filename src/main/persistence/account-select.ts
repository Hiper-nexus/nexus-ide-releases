import type { Account } from '../../shared/account-types';

/**
 * Pure failover selection: from the accounts of one adapter, choose the next
 * usable one — skip the excluded account and anything still on cooldown.
 *
 * The active account stays until its measured availability is zero (the
 * worst window is full) or it is no longer a candidate. A sibling with more
 * remaining quota does not take a new pane early. Unknown quota keeps the
 * active account. With no active account, the freest measured candidate wins.
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
    // 0 = janela cheia (quotaAvailabilityScore de usedRatio 1). Folga menor
    // que a irmã não é término: o hit real tira a conta da lista por cooldown.
    if (
      typeof activeScore === 'number' &&
      Number.isFinite(activeScore) &&
      activeScore <= 0
    ) {
      const replacement = measured.find(
        (entry) => entry.account.id !== active.id && entry.score > 0,
      );
      if (replacement) return replacement.account;
    }
    return active;
  }
  return (
    measured[0]?.account ??
    [...candidates].sort((a, b) => a.createdAt - b.createdAt)[0]
  );
}

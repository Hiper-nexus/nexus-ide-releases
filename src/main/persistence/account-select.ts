import type { Account } from '../../shared/account-types';

/**
 * Pure failover selection: from the accounts of one adapter, choose the next
 * usable one — skip the exhausted account and anything still on cooldown,
 * preferring the currently-active account when it's still eligible, else the
 * earliest created. No I/O — unit tested in isolation.
 */
export function chooseAccount(
  accounts: Account[],
  activeId: string | null,
  excludeId: string | null,
  now: number,
): Account | null {
  const candidates = accounts
    .filter(
      (a) => a.id !== excludeId && (!a.cooldownUntil || a.cooldownUntil <= now),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  if (candidates.length === 0) return null;
  return (
    candidates.find((a) => a.id === activeId && a.id !== excludeId) ??
    candidates[0]
  );
}

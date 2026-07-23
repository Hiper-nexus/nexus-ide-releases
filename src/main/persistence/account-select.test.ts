import { describe, expect, it } from 'vitest';
import { chooseAccount } from './account-select';
import type { Account } from '../../shared/account-types';

function acct(id: string, createdAt: number, cooldownUntil?: number): Account {
  return {
    id,
    adapterId: 'claude',
    label: id,
    mode: 'api-key',
    upstream: 'anthropic',
    cooldownUntil,
    createdAt,
  };
}

const NOW = 1_000_000;

describe('chooseAccount (failover selection)', () => {
  it('skips the exhausted account and picks the next available', () => {
    const accounts = [acct('a', 1), acct('b', 2), acct('c', 3)];
    const chosen = chooseAccount(accounts, 'a', 'a', NOW);
    expect(chosen?.id).toBe('b');
  });

  it('skips accounts still on cooldown', () => {
    const accounts = [acct('a', 1), acct('b', 2, NOW + 60_000), acct('c', 3)];
    const chosen = chooseAccount(accounts, 'a', 'a', NOW);
    expect(chosen?.id).toBe('c'); // b is cooling down
  });

  it('treats an elapsed cooldown as available again', () => {
    const accounts = [acct('a', 1, NOW - 10), acct('b', 2, NOW + 60_000)];
    const chosen = chooseAccount(accounts, null, null, NOW);
    expect(chosen?.id).toBe('a');
  });

  it('prefers the active account when it is still eligible', () => {
    const accounts = [acct('a', 1), acct('b', 2)];
    const chosen = chooseAccount(accounts, 'b', null, NOW);
    expect(chosen?.id).toBe('b');
  });

  it('returns null when every account is exhausted/cooling', () => {
    const accounts = [acct('a', 1, NOW + 1), acct('b', 2, NOW + 1)];
    expect(chooseAccount(accounts, 'a', 'a', NOW)).toBeNull();
  });

  it('returns null for an empty roster', () => {
    expect(chooseAccount([], null, null, NOW)).toBeNull();
  });

  it('when no active, prefers freer quota score', () => {
    const accounts = [acct('a', 1), acct('b', 2)];
    const scores = new Map([
      ['a', 0.2],
      ['b', 0.9],
    ]);
    const chosen = chooseAccount(accounts, null, null, NOW, scores);
    expect(chosen?.id).toBe('b');
  });

  it('preempts an active account only when measured quota proves another is freer', () => {
    const accounts = [acct('a', 1), acct('b', 2)];
    const scores = new Map([
      ['a', 0.15],
      ['b', 0.9],
    ]);
    const chosen = chooseAccount(accounts, 'a', null, NOW, scores);
    expect(chosen?.id).toBe('b');
  });

  it('keeps operator intent when the active account has no measured quota', () => {
    const accounts = [acct('a', 1), acct('b', 2)];
    const scores = new Map([['b', 0.9]]);
    const chosen = chooseAccount(accounts, 'a', null, NOW, scores);
    expect(chosen?.id).toBe('a');
  });
});

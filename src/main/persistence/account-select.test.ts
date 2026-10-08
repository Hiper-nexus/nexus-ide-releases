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

  it('keeps the active account while it still has measured quota, even if a sibling is freer', () => {
    const accounts = [acct('a', 1), acct('b', 2)];
    const scores = new Map([
      ['a', 0.02],
      ['b', 0.9],
    ]);
    const chosen = chooseAccount(accounts, 'a', null, NOW, scores);
    expect(chosen?.id).toBe('a');
  });

  it('moves to a sibling only after the active account measures zero availability', () => {
    const accounts = [acct('a', 1), acct('b', 2)];
    const scores = new Map([
      ['a', 0],
      ['b', 0.4],
    ]);
    expect(chooseAccount(accounts, 'a', null, NOW, scores)?.id).toBe('b');
  });

  it('does not hop from a full account onto another full account', () => {
    const accounts = [acct('a', 1), acct('b', 2)];
    const scores = new Map([
      ['a', 0],
      ['b', 0],
    ]);
    expect(chooseAccount(accounts, 'a', null, NOW, scores)?.id).toBe('a');
  });

  it('keeps operator intent when the active account has no measured quota', () => {
    const accounts = [acct('a', 1), acct('b', 2)];
    const scores = new Map([['b', 0.9]]);
    const chosen = chooseAccount(accounts, 'a', null, NOW, scores);
    expect(chosen?.id).toBe('a');
  });
});

describe('chooseAccount com janelas medidas (F-969)', () => {
  const windows = (
    hours: number | null,
    weekly: number | null,
  ) => ({
    windows: [
      { kind: 'hours' as const, label: '5 Horas', usedRatio: hours },
      { kind: 'weekly' as const, label: 'Semanal', usedRatio: weekly },
    ],
  });

  it('caso exato de 07/10: ativa só com a Semanal (19%) cede à irmã com a de 5 Horas medida (0%)', () => {
    const accounts = [acct('co-claude', 1), acct('re-claude', 2)];
    const quota = new Map([
      ['co-claude', windows(null, 0.19)],
      ['re-claude', windows(0, null)],
    ]);
    expect(chooseAccount(accounts, 'co-claude', null, NOW, undefined, quota)?.id).toBe('re-claude');
  });

  it('a ativa sem leitura nenhuma continua (cota fora do ar não é evidência)', () => {
    const accounts = [acct('a', 1), acct('b', 2)];
    const quota = new Map([['b', windows(0, 0.1)]]);
    expect(chooseAccount(accounts, 'a', null, NOW, undefined, quota)?.id).toBe('a');
  });

  it('ativa medida nas mesmas janelas fica, mesmo com irmã mais livre', () => {
    const accounts = [acct('a', 1), acct('b', 2)];
    const quota = new Map([
      ['a', windows(0.3, 0.2)],
      ['b', windows(0, 0.1)],
    ]);
    expect(chooseAccount(accounts, 'a', null, NOW, undefined, quota)?.id).toBe('a');
  });

  it('ativa esgotada na janela de 5 Horas cede; nunca pula de cheia para cheia', () => {
    const accounts = [acct('a', 1), acct('b', 2)];
    expect(
      chooseAccount(accounts, 'a', null, NOW, undefined, new Map([
        ['a', windows(1, 0.2)],
        ['b', windows(0.4, null)],
      ]))?.id,
    ).toBe('b');
    expect(
      chooseAccount(accounts, 'a', null, NOW, undefined, new Map([
        ['a', windows(1, 0.2)],
        ['b', windows(1, null)],
      ]))?.id,
    ).toBe('a');
  });

  it('sem ativa (failover excluiu a esgotada), a irmã com folga provada vence a sem leitura', () => {
    const accounts = [acct('exhausted', 1), acct('unread', 2), acct('proven', 3)];
    const quota = new Map([
      ['exhausted', windows(1, 0.5)],
      ['proven', windows(0.2, null)],
    ]);
    expect(chooseAccount(accounts, 'exhausted', 'exhausted', NOW, undefined, quota)?.id).toBe('proven');
  });
});

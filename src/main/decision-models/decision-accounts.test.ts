import { describe, expect, it } from 'vitest';
import { decisionSettingsSchema, type DecisionSettings } from '../../shared/decision-models';
import {
  EMPTY_DECISION_ACCOUNT_BOOK,
  accountSwitchProjection,
  parseDecisionAccountBook,
  resolveAccountSettings,
  withAccountSettings,
} from './decision-accounts';

const luna: DecisionSettings = decisionSettingsSchema.parse({ mode: 'luna', visionEnabled: true });
const jev: DecisionSettings = decisionSettingsSchema.parse({});

describe('decision preferences per account', () => {
  it('does not let one account inherit another account choice', () => {
    const book = withAccountSettings(withAccountSettings(EMPTY_DECISION_ACCOUNT_BOOK, 'user-a', luna), 'user-b', jev);
    expect(resolveAccountSettings(book, 'user-a', jev).mode).toBe('luna');
    expect(resolveAccountSettings(book, 'user-b', luna)).toMatchObject({ mode: 'jev', visionEnabled: false });
    expect(resolveAccountSettings(book, 'user-c', luna)).toMatchObject({ mode: 'jev', visionEnabled: false });
    expect(JSON.stringify(resolveAccountSettings(book, 'user-b', luna))).not.toContain('luna');
  });

  it('claims an empty book from the legacy projection and then isolates the next account', () => {
    expect(resolveAccountSettings(EMPTY_DECISION_ACCOUNT_BOOK, 'user-a', luna).mode).toBe('luna');
    const claimed = withAccountSettings(EMPTY_DECISION_ACCOUNT_BOOK, 'user-a', luna);
    expect(resolveAccountSettings(claimed, 'user-b', luna).mode).toBe('jev');
  });

  it('switches the signed-in account without copying the previous choice', () => {
    const claimed = accountSwitchProjection(EMPTY_DECISION_ACCOUNT_BOOK, 'user-a', luna);
    expect(claimed.settings.mode).toBe('luna');
    const next = accountSwitchProjection(claimed.book, 'user-b', luna);
    expect(next.settings).toMatchObject({ mode: 'jev', visionEnabled: false });
    expect(next.book.byAccount['user-a'].mode).toBe('luna');
    expect(next.book.byAccount['user-b']).toBeUndefined();
    const loggedOut = accountSwitchProjection(next.book, null, luna);
    expect(loggedOut.settings).toMatchObject({ mode: 'jev', visionEnabled: false });
    expect(loggedOut.book.byAccount['user-a'].mode).toBe('luna');
    expect(JSON.stringify(loggedOut.settings)).not.toContain('luna');
  });

  it('drops a foreign account id and a broken settings blob instead of adopting them', () => {
    const book = parseDecisionAccountBook({
      formatVersion: 1,
      byAccount: {
        '../other': luna,
        'user-a': { mode: 'luna', visionEnabled: true, clefModel: 'clef', cloudflareAccountId: '' },
        'user-b': { mode: 'nope' },
      },
    });
    expect(Object.keys(book.byAccount)).toEqual(['user-a']);
    expect(book.byAccount['user-a'].mode).toBe('luna');
  });
});

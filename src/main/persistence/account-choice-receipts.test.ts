import { describe, expect, it } from 'vitest';
import type { AccountChoiceReceipt } from '../../shared/account-choice';
import {
  forgetAccountChoiceReceipt,
  getAccountChoiceReceipt,
  recordAccountChoiceReceipt,
} from './account-choice-receipts';

const receipt: AccountChoiceReceipt = {
  adapterId: 'codex',
  source: 'headroom-rule',
  account: { label: 'g•••@l•••.com.br', mode: 'subscription' },
  headroom: { usedPct: 12, window: 'Sessão', resetsAt: 123, score: 0.88 },
  alternatives: [],
  decidedAt: 1,
};

describe('account-choice-receipts', () => {
  it('records, reads and forgets by sessionId', () => {
    recordAccountChoiceReceipt('sess-1', receipt);
    expect(getAccountChoiceReceipt('sess-1')).toBe(receipt);
    expect(getAccountChoiceReceipt('sess-2')).toBeUndefined();
    forgetAccountChoiceReceipt('sess-1');
    expect(getAccountChoiceReceipt('sess-1')).toBeUndefined();
    // forget é idempotente
    forgetAccountChoiceReceipt('sess-1');
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_STATUSES, PAGE_LIMIT, accountsQuery, parseAccountsPage } from './admin-accounts.js';

const account = (overrides = {}) => ({
  id: 'acc-1', email: 'ana@example.test', name: 'Ana', role: 'user', access: 'trial',
  trialEndsAt: null, subscriptionStatus: 'none', lastSeenAt: null, ...overrides,
});

test('a consulta combina situação, parte do e-mail e cursor, com teto de 50', () => {
  assert.equal(PAGE_LIMIT, 50);
  assert.deepEqual(ACCOUNT_STATUSES, ['all', 'trial', 'active', 'suspended', 'expired']);
  assert.equal(accountsQuery({}), 'status=all&limit=50');
  assert.equal(accountsQuery({ status: 'trial', email: '  Ana@Example.test  ' }), 'status=trial&limit=50&email=Ana%40Example.test');
  assert.equal(accountsQuery({ status: 'inventada', email: '   ', cursor: '../etc' }), 'status=all&limit=50');
  assert.equal(accountsQuery({ email: 'a'.repeat(250), cursor: 'abc_DEF-123' }), `status=all&limit=50&email=${'a'.repeat(200)}&cursor=abc_DEF-123`);
});

test('a página só vale com lastSeenAt nulo ou data, e um item torto invalida a lista', () => {
  const seen = '2026-10-01T15:04:00.000Z';
  assert.deepEqual(parseAccountsPage({ accounts: [account(), account({ id: 'acc-2', lastSeenAt: seen })], nextCursor: 'abc_DEF-123' }), {
    accounts: [account(), account({ id: 'acc-2', lastSeenAt: seen })], nextCursor: 'abc_DEF-123',
  });
  assert.equal(parseAccountsPage({ accounts: [account()], nextCursor: null }).nextCursor, null);
  assert.equal(parseAccountsPage({ accounts: [account()], nextCursor: 'não' }).nextCursor, null);
  for (const page of [
    null,
    {},
    { accounts: [account({ id: '' })] },
    { accounts: [account({ lastSeenAt: undefined })] },
    { accounts: [account({ lastSeenAt: 'ontem' })] },
    { accounts: [account({ email: 1 })] },
  ]) assert.equal(parseAccountsPage(page), null);
});

import { describe, expect, it } from 'vitest';
import {
  AccountReloginRequiredError,
  accountReloginFrom,
  parseAccountReloginRequest,
} from './account-relogin';

describe('pedido de re-login do pane (F-1642)', () => {
  it('aceita o rótulo inteiro que a conta permite (128) e recusa o que foge do contrato', () => {
    const ok = { adapterId: 'claude', accountId: 'acct-b', accountLabel: 'c'.repeat(128) };
    expect(parseAccountReloginRequest(ok)).toEqual(ok);
    expect(parseAccountReloginRequest({ ...ok, accountId: '../x' })).toBeUndefined();
    expect(parseAccountReloginRequest({ ...ok, email: 'b@example.com' })).toBeUndefined();
    expect(parseAccountReloginRequest({ ...ok, accountLabel: '' })).toBeUndefined();
  });

  it('só o erro tipado do Main carrega a conta', () => {
    const relogin = { adapterId: 'claude', accountId: 'acct-b', accountLabel: 'conta b' };
    expect(accountReloginFrom(new AccountReloginRequiredError('x', relogin))).toEqual(relogin);
    expect(accountReloginFrom(new Error('x'))).toBeUndefined();
    expect(accountReloginFrom('x')).toBeUndefined();
  });
});
